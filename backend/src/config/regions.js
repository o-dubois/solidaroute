/**
 * @file regions.js
 * @description Nominatim geocoding region presets for SolidaRoute.
 *
 * Maps region codes (stored in the `configuration` table under `geocoding_region`)
 * to the Nominatim query parameters needed to restrict address autocomplete and
 * geocoding results to the correct geographic area.
 *
 * Why region presets?
 *   Nominatim is a global geocoder — without constraints it returns the best worldwide
 *   match for any address string. For a transportation platform, results must stay
 *   within the organization's service area. These presets apply two layers of restriction:
 *     1. `countrycodes` — hard-filters results to a specific country (ISO 3166-1 alpha-2)
 *     2. `viewbox` + `bounded` — optionally restricts to a geographic bounding box
 *
 * Bounding box format: "west,north,east,south" (Nominatim's expected parameter order)
 *   This is NOT the more common "minLon,minLat,maxLon,maxLat" — note that north comes
 *   before south (i.e., the higher latitude value comes first).
 *
 * bounded = 1 means Nominatim will ONLY return results inside the viewbox.
 * bounded = 0 means the viewbox is a preference hint but results can extend beyond it.
 *
 * Region configurations:
 *
 *   QC — Province of Quebec, Canada
 *     Uses a bounding box and bounded=1 to strictly limit suggestions to Quebec.
 *     This is the primary service area; the tight viewbox prevents addresses in
 *     Ontario or US border states from appearing in autocomplete results.
 *     Viewbox: west -79.8, north 62.6, east -57.1, south 45.0
 *     (covers all of Quebec including the far north)
 *
 *   CA — All of Canada
 *     No viewbox — accepts any Canadian address. Used for organizations that serve
 *     multiple provinces without a specific regional focus.
 *
 *   FR — Metropolitan France
 *     Bounded viewbox covering mainland France (excludes overseas territories).
 *     Useful for French-speaking organizations outside Canada.
 *     Viewbox: west -5.1, north 51.1, east 9.6, south 41.3
 *
 *   BE — Belgium
 *     Country-code restriction only; no viewbox (Belgium is small enough that
 *     a viewbox adds little benefit over countrycodes alone).
 *
 *   CH — Switzerland
 *     Country-code restriction only; same reasoning as Belgium.
 *
 * Adding a new region:
 *   Add an entry to the REGIONS object with the appropriate countrycodes,
 *   viewbox (or null), and bounded (1 or 0). Then set geocoding_region in the
 *   configuration table to the new key.
 */

/**
 * Map of region code → Nominatim query parameter preset.
 *
 * @type {Object.<string, { countrycodes: string, viewbox: string|null, bounded: 0|1 }>}
 */
const REGIONS = {
  /** Quebec, Canada — primary SolidaRoute service area; strictly bounded to the province */
  QC: {
    countrycodes: 'ca',
    viewbox:      '-79.8,62.6,-57.1,45.0', // west, north, east, south
    bounded:      1, // Hard restriction: no results outside this box
  },

  /** All of Canada — no geographic restriction beyond country */
  CA: {
    countrycodes: 'ca',
    viewbox:      null, // No bounding box
    bounded:      0,
  },

  /** Metropolitan France */
  FR: {
    countrycodes: 'fr',
    viewbox:      '-5.1,51.1,9.6,41.3', // Covers mainland France
    bounded:      1,
  },

  /** Belgium */
  BE: {
    countrycodes: 'be',
    viewbox:      null,
    bounded:      0,
  },

  /** Switzerland */
  CH: {
    countrycodes: 'ch',
    viewbox:      null,
    bounded:      0,
  },
};

/**
 * Returns the Nominatim parameter preset for the given region code.
 *
 * Falls back to the 'CA' preset if the code is null, undefined, empty, or
 * not recognized — ensuring geocoding always works even if the configuration
 * table has a missing or invalid `geocoding_region` value.
 *
 * @param {string|null|undefined} regionCode - The `geocoding_region` config value (e.g. 'QC', 'FR')
 * @returns {{ countrycodes: string, viewbox: string|null, bounded: 0|1 }}
 */
function getRegionParams(regionCode) {
  // toUpperCase() normalizes 'qc' / 'QC' / 'Qc' to a consistent lookup key
  return REGIONS[(regionCode || 'CA').toUpperCase()] || REGIONS.CA;
}

module.exports = { REGIONS, getRegionParams };
