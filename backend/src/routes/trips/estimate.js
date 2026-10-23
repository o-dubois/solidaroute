/**
 * @file routes/trips/estimate.js
 * @description Geocodes pickup/dropoff addresses, calculates the route, and returns a
 *              price preview.  Mounted at POST /api/trips/estimate.
 *
 * Auth: JWT required (any role).
 *
 * This endpoint writes NOTHING to the database — it is a pure read-and-calculate
 * operation used by the booking wizard's "Get Estimate" step.
 *
 * Why coordinates must be echoed back:
 *   The response includes the geocoded lat/lon for both addresses.  The frontend
 *   must include those coordinates when it later calls POST /api/trips to create
 *   the trip.  This avoids a redundant geocoding round-trip on trip creation and,
 *   more importantly, guarantees that the geometry stored in the DB (and shown on
 *   the map) matches exactly what was presented in the price preview.
 *
 * Round-trip handling:
 *   If has_return=true the distance and duration are doubled.  The driver covers
 *   both legs (outbound + return), so the fare shown and the driver's earnings
 *   should reflect the full distance travelled.
 *
 * Geocoding region:
 *   The admin can configure a region code (e.g. 'CA') in the configuration table
 *   to bias geocoding results toward the correct country.  Without a region bias,
 *   a city name like "Brossard" might resolve to the wrong country.
 *
 * Request body:
 *   pickup_address   {string}  Full civic address for pickup
 *   dropoff_address  {string}  Full civic address for drop-off
 *   passenger_count  {number}  Number of passengers (default 1)
 *   has_return       {boolean} Whether the trip has a return leg (default false)
 *
 * Response:
 *   pickup.address / lat / lon  — geocoded pickup
 *   dropoff.address / lat / lon — geocoded drop-off
 *   distance_km                 — total distance (× 2 for round trips), rounded to 2 dp
 *   duration_minutes            — total duration (× 2 for round trips), rounded to nearest minute
 *   estimated_cost              — fare in the configured currency
 *   currency                    — e.g. "CAD"
 *   routing_source              — which routing engine was used (for debugging)
 */

const express                            = require('express');
const { pool }                           = require('../../db/pool');
const { authenticate }                   = require('../../middleware/auth');
const { geocodeAddress, calculateRoute } = require('../../services/routing');
const { calculateTripCost }              = require('../../services/pricing');

// The subset of configuration keys required to compute a fare.
// Fetched from the DB so pricing can be adjusted without a code deploy.
const PRICING_KEYS = [
  'base_fare', 'price_per_km', 'extra_passenger_fee',
  'driver_share_percent', 'payment_currency',
];

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trips/estimate
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { pickup_address, dropoff_address, passenger_count = 1, has_return = false } = req.body;

    if (!pickup_address || !dropoff_address) {
      return res.status(422).json({ error: 'Pickup and dropoff addresses are required.' });
    }

    // Pull the region code from config so geocoding is biased toward the right country.
    const regionRow = await pool.query(
      `SELECT value FROM configuration WHERE key = 'geocoding_region' LIMIT 1`
    );
    const regionCode = regionRow.rows[0]?.value || 'CA';

    // Geocode both addresses in parallel — no dependency between them.
    const [origin, destination] = await Promise.all([
      geocodeAddress(pickup_address, regionCode),
      geocodeAddress(dropoff_address, regionCode),
    ]);

    if (!origin || !destination) {
      return res.status(422).json({
        error: 'One or both addresses could not be geocoded. Please use a full civic address (e.g. 3120 Taschereau Blvd, Greenfield Park, QC).',
      });
    }

    // Calculate the driving route between the two geocoded points.
    const route = await calculateRoute(
      [origin.lat, origin.lon],
      [destination.lat, destination.lon],
      regionCode
    );

    // For round trips the driver covers both legs, so both distance and duration
    // are multiplied by 2.  The client sends has_return=true when the trip form
    // has a return time configured.
    const multiplier    = has_return ? 2 : 1;
    const distance_km   = Math.round(route.distance_km      * multiplier * 100) / 100;
    const duration_mins = Math.round(route.duration_minutes * multiplier);

    // Fetch all pricing parameters in a single query and turn them into a flat map.
    const { rows: cfgRows } = await pool.query(
      `SELECT key, value FROM configuration WHERE key = ANY($1)`, [PRICING_KEYS]
    );
    const pricingCfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));

    // calculateTripCost returns { total, driver_share, platform_fee, currency }.
    // Only total and currency are exposed to the frontend at this stage.
    const cost = calculateTripCost(distance_km, parseInt(passenger_count), pricingCfg);

    res.json({
      pickup:    { address: pickup_address,  lat: origin.lat,      lon: origin.lon },
      dropoff:   { address: dropoff_address, lat: destination.lat, lon: destination.lon },
      distance_km,
      duration_minutes: duration_mins,
      estimated_cost:   cost.total,
      currency:         cost.currency,
      // routing_source tells the team which engine produced this route
      // (useful for debugging incorrect distances or outages).
      routing_source:   route.source,
    });
  } catch (err) { next(err); }
});

module.exports = router;
