/**
 * @file routes/trips/available.js
 * @description Returns pending trips that are geographically reachable by the
 *              requesting driver.  Mounted at GET /api/trips/available.
 *
 * Auth: JWT required; driver role enforced inline.
 *
 * Distance-band model:
 *   The frontend divides the search area into three concentric rings so the
 *   driver can quickly see how far each available trip is from their home:
 *
 *     Band 1 (closest):  0 km  … base_radius_km
 *     Band 2 (medium):   base_radius_km … base_radius_km × 2
 *     Band 3 (farthest): base_radius_km × 2 … base_radius_km × 3
 *
 *   The frontend requests one band at a time by passing radius_min and
 *   radius_max as query params.  Both are clamped server-side so a client
 *   cannot request a radius larger than base_radius × 3.
 *
 * Preferred-trip separation:
 *   If the driver was personally selected by the client (preferred driver),
 *   that trip is returned in the separate `preferred_trips` array rather
 *   than mixed into the general band list.  This allows the UI to show a
 *   highlighted "you were chosen" card at the top of the page.
 *   Preferred trips with an outstanding response window (broadcast_at IS NULL
 *   and preferred_driver_declined = false) are deliberately hidden from the
 *   band list so other drivers cannot jump the queue.
 *
 * Privacy:
 *   Client names are masked ("Marie D.") before leaving the server via
 *   maskName() — drivers see only the first name and last-name initial.
 *
 * Response shape:
 *   {
 *     preferred_trips: [...],  // trips where this driver was personally chosen
 *     trips:           [...],  // trips within the requested distance band
 *     radius_min_km,           // actual lower bound applied (after clamping)
 *     radius_max_km,           // actual upper bound applied (after clamping)
 *     base_radius_km,          // base radius from configuration
 *   }
 */

const express          = require('express');
const { pool }         = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { maskName }     = require('../../utils/namePrivacy');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trips/available
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    // Only approved drivers may call this endpoint.
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Drivers only.' });
    }

    // Fetch the driver's spatial home point and current availability status.
    // We need home_point to calculate the distance to each trip's pickup location.
    const { rows: profile } = await pool.query(
      `SELECT home_point, service_radius_km, is_available, approval_status
       FROM driver_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    if (!profile.length) {
      return res.status(404).json({ error: 'Driver profile not found.' });
    }

    // Read the admin-configured base radius.  The maximum searchable radius is
    // always exactly 3 × base so that band 3 never extends beyond admin intent.
    const { rows: cfg } = await pool.query(
      `SELECT value FROM configuration WHERE key = 'driver_suggestion_radius_km'`
    );
    const baseRadius = parseFloat(cfg[0]?.value || '10');
    const maxRadius  = baseRadius * 3;

    // Accept optional radius_min / radius_max query params so the frontend can
    // request a specific band.  Clamp both values to keep them within safe bounds:
    //   • radius_min must be ≥ 0
    //   • radius_max must be > 0 and ≤ maxRadius
    //   • radius_min must be < radius_max (reset to 0 if not, to avoid empty results)
    let radiusMin = req.query.radius_min ? parseFloat(req.query.radius_min) : 0;
    let radiusMax = req.query.radius_max ? parseFloat(req.query.radius_max) : baseRadius;
    if (isNaN(radiusMin) || radiusMin < 0)  radiusMin = 0;
    if (isNaN(radiusMax) || radiusMax <= 0) radiusMax = baseRadius;
    if (radiusMax > maxRadius)              radiusMax = maxRadius;
    if (radiusMin >= radiusMax)             radiusMin = 0;

    // ── Query 1: Preferred trips ──────────────────────────────────────────────
    // A preferred trip is one where the client explicitly chose this driver.
    // Conditions that make a trip "preferred and still waiting":
    //   - The driver is the designated preferred_driver_id
    //   - The driver has not yet declined (preferred_driver_declined = false)
    //   - The broadcast window has not started yet (broadcast_at IS NULL)
    //   - The trip has not departed yet (departure_at > NOW())
    //
    // We also join trip_driver_actions to surface whether the driver already
    // clicked Accept or Decline on this trip (useful to suppress repeat alerts).
    const { rows: preferredRowsRaw } = await pool.query(
      `SELECT t.*,
         u.first_name AS client_first_name, u.last_name AS client_last_name,
         u.phone AS client_phone,
         ROUND((ST_Distance(dp.home_point, t.pickup_point) / 1000)::numeric, 2) AS distance_from_home_km,
         tda.action       AS driver_action,
         tda.is_preferred AS driver_action_is_preferred,
         tda.actioned_at  AS driver_actioned_at
       FROM trips t
       JOIN users u ON u.id = t.client_id
       JOIN driver_profiles dp ON dp.user_id = $1
       LEFT JOIN trip_driver_actions tda
         ON tda.trip_id = t.id AND tda.driver_id = $1
       WHERE t.status = 'pending'
         AND t.departure_at > NOW()
         AND t.preferred_driver_id = $1
         AND t.preferred_driver_declined = false
         AND t.broadcast_at IS NULL
       ORDER BY t.departure_at ASC
       LIMIT 10`,
      [req.user.id]
    );

    // Build an exclusion list of preferred-trip IDs so they don't also appear
    // in the band results below (no duplicate cards on the frontend).
    const preferredIds = preferredRowsRaw.map(r => r.id);
    const excludeClause = preferredIds.length > 0
      ? `AND t.id NOT IN (${preferredIds.map((_, i) => `$${i + 4}`).join(',')})`
      : '';
    const bandParams = [req.user.id, radiusMin, radiusMax, ...preferredIds];

    // ── Query 2: Band trips within the requested distance ring ───────────────
    // Uses PostGIS ST_DWithin (sphere-based distance in metres) for the outer
    // boundary, and a NOT ST_DWithin for the inner boundary — creating a ring.
    //
    // ST_DWithin(home, pickup, radius_km * 1000) returns true when the distance
    // is ≤ radius_km.  Combining both conditions gives the annular band:
    //   ≤ radius_max  AND  NOT ≤ radius_min  →  between radius_min and radius_max
    //
    // Trips that still have an un-answered preferred-driver window are excluded
    // from the band so other drivers cannot jump the queue.
    //
    // Sort order: already-declined trips are pushed to the bottom (declined ASC NULLS FIRST
    // means null/no-action comes first), then closest trip first, then earliest departure.
    const { rows: bandRowsRaw } = await pool.query(
      `SELECT t.*,
         u.first_name AS client_first_name, u.last_name AS client_last_name,
         u.phone AS client_phone,
         ROUND((ST_Distance(dp.home_point, t.pickup_point) / 1000)::numeric, 2) AS distance_from_home_km,
         tda.action       AS driver_action,
         tda.is_preferred AS driver_action_is_preferred,
         tda.actioned_at  AS driver_actioned_at
       FROM trips t
       JOIN users u ON u.id = t.client_id
       JOIN driver_profiles dp ON dp.user_id = $1
       LEFT JOIN trip_driver_actions tda
         ON tda.trip_id = t.id AND tda.driver_id = $1
       WHERE t.status = 'pending'
         AND t.departure_at > NOW()
         -- Inner boundary: exclude trips closer than radius_min ($2 = 0 skips this check)
         AND ST_DWithin(dp.home_point, t.pickup_point, $3 * 1000)
         AND ($2 = 0 OR NOT ST_DWithin(dp.home_point, t.pickup_point, $2 * 1000))
         -- Hide trips that are still in a preferred-driver response window
         AND NOT (
           t.preferred_driver_id IS NOT NULL
           AND t.preferred_driver_declined = false
           AND t.broadcast_at IS NULL
         )
         ${excludeClause}
       ORDER BY
         (tda.action = 'declined') ASC NULLS FIRST,
         distance_from_home_km ASC,
         t.departure_at ASC
       LIMIT 50`,
      bandParams
    );

    // Apply privacy masking: replace "Marie Tremblay" with "Marie T." for drivers.
    // The separate first/last fields are stripped from the response since the
    // frontend uses only the masked combined name.
    const applyClientMask = r => ({
      ...r,
      client_name:       maskName(r.client_first_name, r.client_last_name, req.user.role),
      client_first_name: undefined,
      client_last_name:  undefined,
    });

    res.json({
      preferred_trips: preferredRowsRaw.map(applyClientMask),
      trips:           bandRowsRaw.map(applyClientMask),
      radius_min_km:   radiusMin,
      radius_max_km:   radiusMax,
      base_radius_km:  baseRadius,
    });
  } catch (err) { next(err); }
});

module.exports = router;
