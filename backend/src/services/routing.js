/**
 * @file routing.js
 * @description Routing and geocoding service for SolidaRoute.
 *
 * Provides two core capabilities:
 *   1. geocodeAddress(address)  — converts a street address into GPS coordinates (lat/lon)
 *   2. calculateRoute(origin, destination) — computes road distance and estimated duration
 *
 * Both functions use a cascade/fallback strategy so the app stays functional even when
 * a paid or self-hosted service is unavailable.
 *
 * Geocoding cascade (geocodeAddress):
 *   1. Addok — when ADDOK_URL is set AND region is FR; queries Base Adresse Nationale
 *   2. OpenRouteService (ORS) — when ORS_API_KEY is set; high quality results
 *   3. Nominatim (OpenStreetMap) — free, no key required, tried with 3 address variants
 *   4. null — returned if all services fail; caller handles the absence of coordinates
 *
 * Routing cascade (calculateRoute):
 *   1. OSRM (self-hosted) — exact road network routing, preferred for accuracy
 *   2. Haversine × 1.35 — straight-line distance with a correction factor for road detours;
 *      used as a fallback when OSRM is not deployed or unreachable
 *
 * Why native fetch instead of axios/node-fetch?
 *   Node.js 20 includes a stable built-in fetch API. Using it eliminates an external
 *   dependency and simplifies the code. The AbortController pattern replaces the
 *   deprecated { timeout } option from node-fetch v2.
 *
 * Environment variables:
 *   OSRM_URL    — self-hosted OSRM base URL (e.g. http://localhost:5001)
 *                 If not set, routing falls back to Haversine immediately.
 *   ADDOK_URL   — self-hosted Addok base URL (e.g. http://localhost:7878)
 *                 Used only when geocoding_region = FR. Queries the Base
 *                 Adresse Nationale (BAN). Takes priority over ORS and Nominatim.
 *   ORS_API_KEY — OpenRouteService API key (free tier: 2 000 req/day)
 *                 If not set, geocoding starts at Nominatim (or Addok for FR).
 */

const { logger }          = require('../utils/logger');
const { getRegionParams } = require('../config/regions');

/**
 * Thin fetch wrapper that adds an AbortController-based timeout.
 *
 * Node's native fetch does not support a timeout option directly.
 * AbortController is the standard Web API approach: we set a timer that calls
 * controller.abort() after the deadline, which causes the fetch to reject with
 * an AbortError. The timer is always cleared in the finally block to avoid
 * leaking a timer handle if the request completes before the deadline.
 *
 * @param {string} url               - The URL to fetch
 * @param {object} [options={}]      - Standard fetch RequestInit options
 * @param {number} [timeoutMs=6000]  - Maximum wait time in milliseconds
 * @returns {Promise<Response>}
 * @throws {DOMException} AbortError if the request exceeds timeoutMs
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    // Always clear the timer, even if the request threw an error,
    // to prevent the Node.js process from staying alive unnecessarily.
    clearTimeout(timer);
  }
}

/**
 * Computes the straight-line (great-circle) distance between two GPS points
 * using the Haversine formula, then multiplies by 1.35 as a road correction factor.
 *
 * The 1.35 factor is an empirical approximation: real road distances are typically
 * 25–45% longer than the crow-flies distance due to turns, detours, and road layout.
 * This is used ONLY as a fallback when OSRM is unavailable — OSRM gives exact road
 * distances and is always preferred when accessible.
 *
 * Duration in the fallback result assumes an average speed of 40 km/h, which is
 * conservative for mixed urban/suburban driving in Quebec.
 *
 * @param {number} lat1 - Latitude of point A (degrees)
 * @param {number} lon1 - Longitude of point A (degrees)
 * @param {number} lat2 - Latitude of point B (degrees)
 * @param {number} lon2 - Longitude of point B (degrees)
 * @returns {number}    - Estimated road distance in kilometres (Haversine × 1.35)
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R    = 6371; // Earth's mean radius in kilometres
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  // Multiply by 1.35 road correction factor before returning
  return R * c * 1.35;
}

/**
 * Calculates driving distance and estimated duration between two GPS coordinates.
 *
 * Tries OSRM first (accurate road-network routing), then falls back to Haversine
 * (approximate straight-line + correction factor) if OSRM is unconfigured or fails.
 *
 * The `source` field in the return value indicates which method was used, allowing
 * callers (e.g., pricing) to log or flag estimates made without real routing data.
 *
 * OSRM URL format: GET /route/v1/driving/{lon},{lat};{lon},{lat}?overview=false
 * Note: OSRM expects coordinates in lon,lat order (opposite of the function parameters).
 *
 * @param {[number, number]} originCoords      - [latitude, longitude] of the pickup point
 * @param {[number, number]} destinationCoords - [latitude, longitude] of the drop-off point
 * @param {string} [regionCode]               - geocoding_region config value (e.g. 'QC', 'FR').
 *                                              OSRM is skipped for non-Canadian regions.
 * @returns {Promise<{
 *   distance_km: number,
 *   duration_minutes: number,
 *   source: 'osrm' | 'haversine'
 * }>}
 */
async function calculateRoute(originCoords, destinationCoords, regionCode = 'CA') {
  const [oLat, oLon] = originCoords;
  const [dLat, dLon] = destinationCoords;

  // ── Option 1: OSRM (self-hosted road-network routing) ────────
  // OSRM is skipped when the region is not CA/QC because the self-hosted OSRM
  // instance only contains Canadian (Quebec) road data. Querying it with
  // coordinates outside that dataset causes OSRM to snap both points to the
  // nearest Canadian road node, often returning 0 km for non-Canadian trips.
  const osrmRegions = new Set(['CA', 'QC']);
  if (process.env.OSRM_URL && osrmRegions.has((regionCode || 'CA').toUpperCase())) {
    try {
      // OSRM expects lon,lat (not lat,lon) — common GIS convention for [x,y]
      const url = `${process.env.OSRM_URL}/route/v1/driving/${oLon},${oLat};${dLon},${dLat}?overview=false`;
      const res = await fetchWithTimeout(url, {}, 5000);
      if (res.ok) {
        const data = await res.json();
        if (data.code === 'Ok' && data.routes?.[0]) {
          return {
            // Convert metres → km and seconds → minutes, rounded to 2dp / nearest minute
            distance_km:      Math.round((data.routes[0].distance / 1000) * 100) / 100,
            duration_minutes: Math.round(data.routes[0].duration / 60),
            source: 'osrm',
          };
        }
      }
    } catch (err) {
      // OSRM down or timeout — log a warning and fall through to Haversine
      logger.warn('OSRM unavailable, falling back to Haversine', { message: err.message });
    }
  }

  // ── Option 2: Haversine fallback ──────────────────────────────
  // Used when OSRM_URL is not set (e.g., development/CI) or when OSRM is unreachable.
  const distanceKm = haversineDistance(oLat, oLon, dLat, dLon);
  return {
    distance_km:      Math.round(distanceKm * 100) / 100,
    // Estimate duration at 40 km/h average (conservative urban/suburban estimate)
    duration_minutes: Math.round((distanceKm / 40) * 60),
    source: 'haversine',
  };
}

/**
 * Converts a civic street address string into GPS coordinates (lat/lon).
 *
 * Cascade strategy (tries each option in order, returns on first success):
 *   1. OpenRouteService (ORS) — commercial geocoder, high accuracy, requires API key
 *   2. Nominatim with region countrycodes (exact input)
 *   3. Nominatim with region countrycodes (accent-stripped input)
 *   4. Nominatim without country restriction (global fallback)
 *   5. Returns null if everything fails
 *
 * Why accent-stripped variant?
 *   OSM data is inconsistent with diacritics. Stripping accents (e.g., "Lévis" → "Levis")
 *   covers cases where OSM entries or the user's input differ in accent encoding.
 *
 * The User-Agent header is required by Nominatim's usage policy — anonymous requests
 * may be rate-limited or blocked. See: https://operations.osmfoundation.org/policies/nominatim/
 *
 * @param {string} address      - Full or partial civic address to geocode
 * @param {string} [regionCode] - Region code from configuration (e.g. 'QC', 'FR', 'CA').
 *                                Defaults to 'CA'. Determines which country/area to restrict to.
 * @returns {Promise<{lat: number, lon: number, source: 'ors' | 'nominatim'} | null>}
 *          Returns null if no service could resolve the address.
 */
async function geocodeAddress(address, regionCode = 'CA') {
  const rp = getRegionParams(regionCode);

  // ── Option 1: Addok (self-hosted French geocoder) ───────────
  // Used only when ADDOK_URL is set and the region is FR.
  // Addok queries the Base Adresse Nationale (BAN) — France's official
  // address database — and returns GeoJSON results identical in format to ORS.
  if (process.env.ADDOK_URL && regionCode.toUpperCase() === 'FR') {
    try {
      const url = `${process.env.ADDOK_URL}/search/`
        + `?q=${encodeURIComponent(address)}&limit=1`;
      const res = await fetchWithTimeout(url, {}, 5000);
      if (res.ok) {
        const data = await res.json();
        if (data.features?.[0]) {
          const [lon, lat] = data.features[0].geometry.coordinates;
          logger.info(`Geocoded via Addok: "${address}"`);
          return { lat, lon, source: 'addok' };
        }
      }
    } catch (err) {
      logger.warn('Addok geocoding failed, falling back', { message: err.message });
    }
  }

  // ── Option 2: OpenRouteService ──────────────────────────────
  if (process.env.ORS_API_KEY) {
    try {
      // boundary.country uses the ISO 3166-1 alpha-2 code from the region config
      const url = 'https://api.openrouteservice.org/geocode/search'
        + `?api_key=${process.env.ORS_API_KEY}`
        + `&text=${encodeURIComponent(address)}`
        + `&boundary.country=${rp.countrycodes.toUpperCase()}&size=1`;
      const res = await fetchWithTimeout(url, {}, 5000);
      if (res.ok) {
        const data = await res.json();
        if (data.features?.[0]) {
          // GeoJSON coordinates are [longitude, latitude] — destructure accordingly
          const [lon, lat] = data.features[0].geometry.coordinates;
          logger.info(`Geocoded via ORS: "${address}"`);
          return { lat, lon, source: 'ors' };
        }
      }
    } catch (err) {
      logger.warn('ORS geocoding failed', { message: err.message });
    }
  }

  // ── Option 2: Nominatim with address variants ────────────────
  // Pre-compute the accent-stripped version once (used in the second variant)
  const stripped = address
    .normalize('NFD')                  // Decompose accented chars (é → e + combining accent)
    .replace(/[\u0300-\u036f]/g, ''); // Remove all combining diacritical marks

  // Variants: exact → stripped → no country restriction (global fallback)
  const variants = [
    { q: address,  countrycodes: rp.countrycodes },  // Variant 1: exact, country-scoped
    { q: stripped, countrycodes: rp.countrycodes },  // Variant 2: de-accented, country-scoped
    { q: address,  countrycodes: null },              // Variant 3: exact, global fallback
  ];

  for (const { q, countrycodes } of variants) {
    try {
      const url = 'https://nominatim.openstreetmap.org/search'
        + `?q=${encodeURIComponent(q)}&format=json&limit=1`
        + (countrycodes ? `&countrycodes=${countrycodes}` : '');

      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'SolidaRoute/5.0 (contact@solidaroute.ca)' },
      }, 8000); // Nominatim can be slow — give it 8s (vs 5s for ORS)

      if (res.ok) {
        const data = await res.json();
        if (data?.[0]) {
          logger.info(`Geocoded via Nominatim: "${q}" (countrycodes=${countrycodes || 'none'})`);
          return {
            lat: parseFloat(data[0].lat),
            lon: parseFloat(data[0].lon),
            source: 'nominatim',
          };
        }
      }
    } catch (err) {
      // AbortError = request timed out; other errors = network/parse failure.
      // Either way, try the next variant rather than giving up immediately.
      logger.warn('Nominatim variant failed', {
        variant: q,
        reason: err.name === 'AbortError' ? 'timeout' : err.message,
      });
    }
  }

  // All options exhausted — caller should handle null (e.g., show address-not-found error)
  logger.warn('All geocoding services failed', { address });
  return null;
}

module.exports = { calculateRoute, geocodeAddress, haversineDistance };
