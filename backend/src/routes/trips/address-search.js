/**
 * @file routes/trips/address-search.js
 * @description Address autocomplete proxy for the trip booking wizard.
 *              Mounted at GET /api/trips/address-search.
 *
 * Auth: JWT required — prevents unauthenticated bots from hammering the
 *       Nominatim API (which has a strict rate-limit usage policy).
 *
 * Geocoding cascade (tries in order, returns on first non-empty result):
 *   1. Addok — when ADDOK_URL is set AND region is FR; queries France's
 *              official Base Adresse Nationale (BAN). Returns immediately
 *              if results are found; falls through to Nominatim on 0 results.
 *   2. Nominatim with viewbox — when the configured region provides a bounding
 *              box (e.g. province of Quebec), biases results to that area first.
 *   3. Nominatim with countrycodes only — broader country-level fallback when
 *              the viewbox search returns nothing.
 *
 * Query params:
 *   q — address search string (minimum 3 characters; shorter strings return [])
 *
 * Response:
 *   { results: [{ label, lat, lon, place_id }, ...] }
 *   results is always an array (never null) — empty when no match is found or
 *   the query is too short.
 */
const express         = require('express');
const { pool }        = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { getRegionParams } = require('../../config/regions');
const { logger }      = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trips/address-search
//
// Proxies address autocomplete queries to Addok (France) or Nominatim
// (all other regions). Auth required to comply with Nominatim's usage policy
// and to prevent unauthenticated bots hammering the rate limit.
//
// Query: q — search string (returns [] for strings shorter than 3 characters)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 3) return res.json({ results: [] });

    const cfgRows = await pool.query(
      `SELECT value FROM configuration WHERE key = 'geocoding_region' LIMIT 1`
    );
    const regionCode = cfgRows.rows[0]?.value || 'CA';
    const rp = getRegionParams(regionCode);

    // Helper: fetch Nominatim with a given URLSearchParams, returns parsed array or []
    async function nominatimFetch(params) {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?${params.toString()}`,
          {
            signal:  controller.signal,
            headers: { 'User-Agent': 'SolidaRoute/12 (contact@solidaroute.ca)' },
          }
        );
        return response.ok ? await response.json() : [];
      } catch {
        return [];
      } finally {
        clearTimeout(timeout);
      }
    }

    // ── Addok path (France only) ──────────────────────────────────────────
    if (process.env.ADDOK_URL && regionCode.toUpperCase() === 'FR') {
      const addokBase = process.env.ADDOK_URL.replace(/\/$/, '');
      const addokUrl  = `${addokBase}/search/?q=${encodeURIComponent(q)}&limit=6`;
      logger.info(`[address-search] Calling Addok: ${addokUrl}`);
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(addokUrl, { signal: controller.signal });
        if (response.ok) {
          const json = await response.json();
          logger.info(`[address-search] Addok raw response: features=${json.features?.length ?? 'missing'}`);
          const results = (json.features || []).map(f => ({
            label:    f.properties.label,
            lat:      f.geometry.coordinates[1],
            lon:      f.geometry.coordinates[0],
            place_id: f.properties.id,
          }));
          if (results.length) {
            logger.info(`[address-search] Addok returned ${results.length} results for "${q}"`);
            return res.json({ results });
          }
          logger.warn(`[address-search] Addok returned 0 results for "${q}", falling back to Nominatim`);
        } else {
          logger.warn(`[address-search] Addok HTTP ${response.status} for "${q}", falling back to Nominatim`);
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          logger.warn('[address-search] Addok timed out, falling back to Nominatim');
        } else {
          logger.warn('[address-search] Addok error, falling back to Nominatim', { message: err.message });
        }
      } finally {
        clearTimeout(timeout);
      }
    } else {
      logger.info(`[address-search] Addok skipped — ADDOK_URL=${process.env.ADDOK_URL || 'NOT SET'}, region=${regionCode}`);
    }

    // ── Nominatim path (all other regions, or Addok fallback) ────────────
    const base = { q, format: 'jsonv2', addressdetails: '1', limit: '6' };

    let data = [];
    if (rp.viewbox) {
      data = await nominatimFetch(new URLSearchParams({
        ...base, countrycodes: rp.countrycodes, viewbox: rp.viewbox, bounded: '0',
      }));
    }
    if (!data.length) {
      data = await nominatimFetch(new URLSearchParams({
        ...base, countrycodes: rp.countrycodes,
      }));
    }

    const results = data.map(item => ({
      label:    item.display_name,
      lat:      parseFloat(item.lat),
      lon:      parseFloat(item.lon),
      place_id: item.place_id,
    }));

    res.json({ results });
  } catch (err) {
    if (err.name === 'AbortError') return res.json({ results: [] });
    next(err);
  }
});

module.exports = router;
