/**
 * @file pricing.js
 * @description Trip cost calculation service for SolidaRoute.
 *
 * Calculates the total cost of a trip and splits it between the driver and the platform.
 *
 * Pricing formula:
 *   total = base_fare + (distance_km × price_per_km) + (extra_passengers × extra_passenger_fee)
 *
 *   Where extra_passengers = max(passengerCount - 1, 0)
 *   (i.e. no extra fee for the first passenger — the fee only applies to additional riders)
 *
 * Revenue split:
 *   driver_share = total × (driver_share_percent / 100)
 *   platform_fee = total × (1 - driver_share_percent / 100)
 *
 * Design decisions:
 *   - All rate parameters are read from the `configuration` table at call time,
 *     so an admin can adjust pricing without redeploying the application.
 *   - The constants below are fallback defaults used when a key is absent from the DB,
 *     ensuring the function always returns a sensible result even during first-run setup.
 *   - All monetary values are rounded to 2 decimal places (cents) using integer math
 *     (multiply by 100, round, divide by 100) to avoid floating-point drift.
 *   - The caller is responsible for fetching config from the DB and passing it in;
 *     this function is intentionally pure (no DB calls) so it is easy to unit-test.
 *
 * @module pricing
 *
 * @example
 * // 10 km trip, 2 passengers, with default rates:
 * calculateTripCost(10, 2, { base_fare: '2.50', price_per_km: '0.85',
 *   extra_passenger_fee: '0.50', driver_share_percent: '75', payment_currency: 'CAD' })
 * // => { total: 11.50, driver_share: 8.63, platform_fee: 2.88, currency: 'CAD' }
 * //
 * // Breakdown: 2.50 + (10 × 0.85) + (1 × 0.50) = 11.50
 * //   driver: 11.50 × 0.75 = 8.625 → 8.63
 * //   platform: 11.50 × 0.25 = 2.875 → 2.88
 */

// ── Fallback defaults ─────────────────────────────────────────
// These values are used only when the corresponding key is missing from the
// configuration table (e.g., during first-run or DB read errors).

/** Fixed charge applied to every trip regardless of distance (in CAD) */
const BASE_FARE_DEFAULT            = 2.50;

/** Per-kilometre rate added to the base fare (in CAD/km) */
const PER_KM_RATE_DEFAULT          = 0.85;

/** Surcharge per additional passenger beyond the first (in CAD/person) */
const EXTRA_PASSENGER_DEFAULT      = 0.50;

/** Percentage of the total that goes to the driver (vs. the platform) */
const DRIVER_SHARE_PCT_DEFAULT     = 75;

/** ISO 4217 currency code for all monetary values */
const CURRENCY_DEFAULT             = 'CAD';

/**
 * Calculates the cost of a trip and returns the driver/platform split.
 *
 * @param {number} distanceKm          - Trip distance in kilometres (from routing service)
 * @param {number} [passengerCount=1]  - Total number of passengers (minimum 1)
 * @param {object} [config={}]         - Pricing config from the configuration table.
 *   All values from the DB are stored as strings, so parseFloat() is applied to each.
 *   @param {string|number} [config.base_fare]            - Fixed charge per trip
 *   @param {string|number} [config.price_per_km]         - Cost per kilometre
 *   @param {string|number} [config.extra_passenger_fee]  - Surcharge per extra passenger
 *   @param {string|number} [config.driver_share_percent] - Driver's cut in %
 *   @param {string}        [config.payment_currency]     - Currency code (e.g. 'CAD')
 *
 * @returns {{
 *   total: number,
 *   driver_share: number,
 *   platform_fee: number,
 *   currency: string
 * }}
 */
function calculateTripCost(distanceKm, passengerCount = 1, config = {}) {
  // Parse all rates from DB strings to floats, falling back to module-level defaults
  const baseFare       = parseFloat(config.base_fare            ?? BASE_FARE_DEFAULT);
  const perKmRate      = parseFloat(config.price_per_km         ?? PER_KM_RATE_DEFAULT);
  const extraPassenger = parseFloat(config.extra_passenger_fee  ?? EXTRA_PASSENGER_DEFAULT);
  // Convert driver share percent (e.g. "75") to a decimal multiplier (0.75)
  const driverPct      = parseFloat(config.driver_share_percent ?? DRIVER_SHARE_PCT_DEFAULT) / 100;
  const currency       = config.payment_currency                ?? CURRENCY_DEFAULT;

  // Calculate the raw total: base + distance component + extra passengers
  // Math.max(passengerCount - 1, 0) ensures we never apply a negative fee
  // if passengerCount is somehow 0 or omitted.
  const total   = baseFare
    + distanceKm * perKmRate
    + Math.max(passengerCount - 1, 0) * extraPassenger;

  // Round to 2 decimal places before splitting, so the individual amounts
  // are derived from a consistent total rather than each being independently rounded.
  const rounded = Math.round(total * 100) / 100;

  return {
    total:        rounded,
    // Round each share independently — small rounding differences (±0.01) between
    // driver_share and platform_fee are acceptable and expected.
    driver_share: Math.round(rounded * driverPct * 100) / 100,
    platform_fee: Math.round(rounded * (1 - driverPct) * 100) / 100,
    currency,
  };
}

module.exports = {
  calculateTripCost,
  // Export defaults so callers (e.g., admin UI) can display what values are active
  BASE_FARE_DEFAULT,
  PER_KM_RATE_DEFAULT,
  EXTRA_PASSENGER_DEFAULT,
  DRIVER_SHARE_PCT_DEFAULT,
  CURRENCY_DEFAULT,
};
