/**
 * @file routes/drivers.js
 * @description Driver-facing API routes for the SolidaRoute platform.
 *
 * Base path: /api/drivers
 *
 * All routes in this file require a valid JWT (via `authenticate`). Role checks
 * are performed inline (req.user.role !== 'driver') rather than through a
 * shared middleware so that each handler can return a domain-appropriate error
 * message. The `authenticate` middleware attaches `req.user` (id, role, etc.)
 * from the `sr_token` JWT stored in localStorage on the client.
 *
 * Route summary:
 *   PATCH /availability  — Driver toggles their on-duty / off-duty flag.
 *   GET   /earnings      — Full earnings history + summary totals for the
 *                          authenticated driver.
 *   GET   /nearby        — PostGIS proximity search: returns up to 5 approved,
 *                          available drivers within 3× the configured radius.
 *                          Used by the NewTrip booking form to suggest drivers.
 *   GET   /search        — Name autocomplete search for drivers (no distance
 *                          filter; a client may know their driver personally).
 *
 * Availability model:
 *   `is_available = true` opts the driver into the pool for all geospatial
 *   queries (/nearby) and the driver's own available-trips list. Setting it to
 *   false takes effect immediately on the next query — there is no cache.
 */
// routes/drivers.js
const express = require('express');
const { pool }           = require('../db/pool');
const { authenticate }   = require('../middleware/auth');
const { maskLastName }   = require('../utils/namePrivacy');

const router = express.Router();

// ── PATCH /api/drivers/availability ──────────────────────────────────────────
/**
 * PATCH /api/drivers/availability
 *
 * Toggles the authenticated driver's on-duty / off-duty status.
 *
 * Auth: authenticated driver only (role = 'driver').
 *
 * Request body: { is_available: boolean }
 *
 * Business rules:
 *   - Only the driver themselves can change their own availability; operators
 *     and admins use a separate admin route if needed.
 *   - `is_available` MUST be a boolean (not a string "true"/"false") to prevent
 *     ambiguous coercions — a 422 is returned for any other type.
 *   - Setting is_available = false immediately excludes the driver from all
 *     PostGIS proximity queries (GET /nearby, available-trip lists), so there
 *     is no delay between the toggle and the effect.
 *   - updated_at is stamped so the admin dashboard can show "last seen active".
 */
router.patch('/availability', authenticate, async (req, res, next) => {
  try {
    // Role guard: this endpoint is driver-only, not shared with operators.
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only.' });

    const { is_available } = req.body;
    // Strict type check: the DB column is BOOLEAN, so we require an actual JS
    // boolean rather than accepting truthy/falsy values that could cause silent bugs.
    if (typeof is_available !== 'boolean') {
      return res.status(422).json({ error: 'is_available must be a boolean.' });
    }

    await pool.query(
      'UPDATE driver_profiles SET is_available = $1, updated_at = NOW() WHERE user_id = $2',
      [is_available, req.user.id]
    );

    res.json({ message: `You are now ${is_available ? 'available' : 'unavailable'}.`, is_available });
  } catch (err) { next(err); }
});

// ── GET /api/drivers/earnings ─────────────────────────────────────────────────
/**
 * GET /api/drivers/earnings
 *
 * Returns the authenticated driver's complete earnings history, one row per
 * completed trip, plus a running total summary.
 *
 * Auth: authenticated driver only (role = 'driver').
 *
 * Response shape:
 *   {
 *     earnings: [ { trip_id, trip_number, pickup_address, dropoff_address,
 *                   departure_at, completed_at, distance_km, passenger_count,
 *                   estimated_cost, client_name,
 *                   earning_id, amount, earning_status }, ... ],
 *     summary:  { total: number, currency: 'CAD' }
 *   }
 *
 * Business rules:
 *   - Only trips with status = 'completed' are included; in-progress or
 *     cancelled trips do not appear in the earnings list.
 *   - The JOIN to driver_earnings is a LEFT JOIN so that completed trips
 *     created before the driver_earnings feature was introduced still appear
 *     in the list (earning_id and amount will be NULL for those rows).
 *   - The summary total falls back to estimated_cost when no driver_earnings
 *     row exists, giving a best-effort figure even for legacy trips.
 *   - Amounts are accumulated in JS (not SQL SUM) so the fallback logic can be
 *     applied uniformly before the final rounding step.
 */
router.get('/earnings', authenticate, async (req, res, next) => {
  try {
    // Role guard: earnings belong to drivers only.
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only.' });

    // LEFT JOIN driver_earnings so trips without an earnings record (e.g. created
    // before the feature was added) still appear in the history with NULL amounts.
    const { rows } = await pool.query(
      `SELECT
         t.id             AS trip_id,
         t.trip_number,
         t.pickup_address,
         t.dropoff_address,
         t.departure_at,
         t.completed_at,
         t.distance_km,
         t.passenger_count,
         t.estimated_cost,
         u.first_name || ' ' || u.last_name AS client_name,
         de.id            AS earning_id,
         de.amount,
         de.status        AS earning_status
       FROM trips t
       LEFT JOIN driver_earnings de ON de.trip_id = t.id AND de.driver_id = $1
       LEFT JOIN users u ON u.id = t.client_id
       WHERE t.driver_id = $1
         AND t.status = 'completed'
       ORDER BY t.completed_at DESC NULLS LAST`,
      [req.user.id]
    );

    // Build the summary total in JS rather than SQL so we can apply the
    // amount ?? estimated_cost fallback before summing.  Round to 2 decimal
    // places using integer arithmetic to avoid floating-point precision drift.
    const total = rows.reduce((sum, r) => {
      // If a formal earning record exists use its amount; otherwise fall back
      // to the trip's estimated_cost as a best-effort value for legacy rows.
      const amt = r.amount ?? r.estimated_cost ?? 0;
      return sum + parseFloat(amt);
    }, 0);

    res.json({
      earnings: rows,
      summary: {
        total:    Math.round(total * 100) / 100,
        currency: 'CAD',
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/drivers/nearby ───────────────────────────────────────────────────
/**
 * GET /api/drivers/nearby
 *
 * Returns up to 5 approved, available drivers whose home location is within
 * 3× the configured `driver_suggestion_radius_km` of the given pickup point.
 * Used by the NewTrip booking form to show suggested drivers before a client
 * manually searches by name.
 *
 * Auth: any authenticated user (clients use this during trip creation).
 *
 * Query params:
 *   lat — pickup latitude  (required, decimal degrees WGS-84).
 *   lon — pickup longitude (required, decimal degrees WGS-84).
 *
 * Why 3× the base radius?
 *   The base radius (driver_suggestion_radius_km) is the radius used for
 *   automatic driver matching. The nearby suggestion list uses a wider net
 *   (3×) so the UI can show candidates even when few drivers are active,
 *   without flooding the list when density is high (LIMIT 5 caps results).
 *
 * Results are ordered by PostGIS KNN index (<-> operator) so the five closest
 * drivers are always returned, not just five arbitrary drivers within the circle.
 *
 * ST_MakePoint($2, $1) — note argument order: longitude first, latitude second.
 * WGS-84 SRID 4326 cast to geography so ST_DWithin works in metres, not degrees.
 * The radius is multiplied by 1000 to convert km → metres for ST_DWithin.
 */
router.get('/nearby', authenticate, async (req, res, next) => {
  try {
    const { lat, lon } = req.query;
    // Both coordinates are required; without them the PostGIS query cannot run.
    if (!lat || !lon) {
      return res.status(422).json({ error: 'lat and lon are required.' });
    }

    // Read the base radius from the configuration table at request time so
    // admins can tune the value without restarting the server.
    const { rows: cfg } = await pool.query(
      `SELECT value FROM configuration WHERE key = 'driver_suggestion_radius_km'`
    );
    const baseRadius = parseFloat(cfg[0]?.value || '10');
    // The suggestion list uses 3× the matching radius to cast a wider net
    // for display purposes while the booking flow uses the base radius for
    // automatic assignment logic.
    const radius = baseRadius * 3;

    const { rows } = await pool.query(`
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        dp.vehicle_make,
        dp.vehicle_model,
        dp.vehicle_year,
        dp.seat_count,
        dp.average_rating,
        dp.review_count,
        -- Convert the PostGIS distance from metres to kilometres, rounded to 1 dp.
        ROUND(
          (ST_Distance(
            dp.home_point,
            ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
          ) / 1000)::numeric, 1
        ) AS distance_km
      FROM driver_profiles dp
      JOIN users u ON u.id = dp.user_id
      WHERE dp.approval_status = 'approved'
        AND dp.is_available = TRUE
        AND u.status = 'active'
        -- ST_DWithin with geography type: $3 * 1000 converts km → metres.
        AND ST_DWithin(
          dp.home_point,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $3 * 1000
        )
      -- <-> is the PostGIS KNN distance operator; it uses a spatial index
      -- for efficient nearest-neighbour ordering without a full table scan.
      ORDER BY dp.home_point <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      LIMIT 5
    `, [parseFloat(lat), parseFloat(lon), radius]);

    const role = req.user.role;
    const drivers = rows.map(r => ({ ...r, last_name: maskLastName(r.last_name, role) }));
    res.json({ drivers, radius_km: radius });
  } catch (err) { next(err); }
});

// ── GET /api/drivers/search ───────────────────────────────────────────────────
/**
 * GET /api/drivers/search
 *
 * Case-insensitive autocomplete search for drivers by name.
 * Returns up to 8 approved, available drivers whose first name, last name,
 * or full name contains the search string.
 *
 * Auth: any authenticated user (clients use this when they know their driver).
 *
 * Query params:
 *   q   — search string (minimum 2 characters to avoid oversized result sets).
 *   lat — pickup latitude  (optional, WGS-84 decimal degrees).
 *   lon — pickup longitude (optional, WGS-84 decimal degrees).
 *
 * Why no distance filter?
 *   A client may have a personal relationship with a specific driver who lives
 *   far away and is willing to travel. Removing the spatial filter lets the
 *   client find that driver by name regardless of proximity. The distance_km
 *   column is still returned for informational display when coords are provided.
 *
 * Two query branches:
 *   - hasCoords = true  → include a computed distance_km and order by proximity
 *                         (so the closest name-match floats to the top).
 *   - hasCoords = false → no distance column; order alphabetically by last name.
 *
 * ILIKE performs a case-insensitive substring match ($1 is wrapped in '%...%').
 * The full-name concatenation check (`first || ' ' || last ILIKE $1`) allows
 * queries like "jo sm" to match "John Smith".
 */
router.get('/search', authenticate, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    // Require at least 2 characters to prevent near-empty queries that would
    // return almost the entire driver table, which is expensive and useless.
    if (q.length < 2) return res.json({ drivers: [] });

    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    // Only treat coordinates as valid when both are present and parseable.
    const hasCoords = !isNaN(lat) && !isNaN(lon);

    let rows;
    if (hasCoords) {
      // Coords available: compute distance for display and sort nearest-first.
      // Note argument order for ST_MakePoint: longitude ($2) then latitude ($3).
      ({ rows } = await pool.query(`
        SELECT
          u.id,
          u.first_name,
          u.last_name,
          dp.vehicle_make,
          dp.vehicle_model,
          dp.vehicle_year,
          dp.average_rating,
          dp.review_count,
          dp.is_available,
          ROUND(
            (ST_Distance(
              dp.home_point,
              ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
            ) / 1000)::numeric, 1
          ) AS distance_km
        FROM users u
        JOIN driver_profiles dp ON dp.user_id = u.id
        WHERE dp.approval_status = 'approved'
          AND dp.is_available = TRUE
          AND u.status = 'active'
          AND (
            u.first_name ILIKE $1
            OR u.last_name  ILIKE $1
            -- Full-name match allows "John S" to find "John Smith".
            OR (u.first_name || ' ' || u.last_name) ILIKE $1
          )
        -- KNN ordering: closest driver with a matching name comes first.
        ORDER BY dp.home_point <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
        LIMIT 8
      `, [`%${q}%`, lon, lat]));
    } else {
      // No coords: skip the distance computation entirely and fall back to
      // alphabetical ordering so results are still deterministic.
      ({ rows } = await pool.query(`
        SELECT
          u.id,
          u.first_name,
          u.last_name,
          dp.vehicle_make,
          dp.vehicle_model,
          dp.vehicle_year,
          dp.average_rating,
          dp.review_count,
          dp.is_available,
          -- Return a typed NULL so the response shape is consistent regardless
          -- of whether coords were provided; the frontend can check for NULL.
          NULL::numeric AS distance_km
        FROM users u
        JOIN driver_profiles dp ON dp.user_id = u.id
        WHERE dp.approval_status = 'approved'
          AND dp.is_available = TRUE
          AND u.status = 'active'
          AND (
            u.first_name ILIKE $1
            OR u.last_name  ILIKE $1
            OR (u.first_name || ' ' || u.last_name) ILIKE $1
          )
        ORDER BY u.last_name, u.first_name
        LIMIT 8
      `, [`%${q}%`]));
    }

    const role = req.user.role;
    const drivers = rows.map(r => ({ ...r, last_name: maskLastName(r.last_name, role) }));
    res.json({ drivers });
  } catch (err) { next(err); }
});

// ── GET /api/drivers/:id/availability-check ──────────────────────────────────
/**
 * GET /api/drivers/:id/availability-check
 *
 * Checks whether a specific driver has any assigned trip that overlaps with a
 * proposed time window. Used by the NewTrip wizard (step 4) to block a client
 * from selecting a preferred driver who is already committed to another trip.
 *
 * Auth: any authenticated user (clients call this during driver selection).
 *
 * Query params:
 *   departure_at     — ISO-8601 string, start of the proposed trip (required).
 *   return_at        — ISO-8601 string, end of a round trip (optional).
 *   duration_minutes — estimated one-way duration (optional, used when no return_at).
 *
 * End-time resolution for the proposed trip (in priority order):
 *   1. return_at          — explicit end for round trips.
 *   2. departure_at + duration_minutes — estimated end for one-way trips.
 *   3. departure_at + trip_overlap_buffer_minutes — last-resort configurable fallback.
 *
 * The same three-tier resolution is applied to the driver's EXISTING trips:
 *   1. existing.return_at
 *   2. existing.departure_at + existing.duration_minutes
 *   3. existing.departure_at + trip_overlap_buffer_minutes
 *
 * Two trips A and B overlap when: A.start < B.end  AND  A.end > B.start
 * (Allen's interval algebra — standard overlap predicate).
 *
 * Response:
 *   { available: boolean, conflicts: [{ trip_number, departure_at }] }
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/:id/availability-check', authenticate, async (req, res, next) => {
  try {
    // Validate `:id` is a well-formed UUID so arbitrary strings don't reach the DB.
    if (!UUID_RE.test(req.params.id)) {
      return res.status(404).json({ error: 'Driver not found.' });
    }

    const { departure_at, return_at, duration_minutes } = req.query;
    if (!departure_at) {
      return res.status(422).json({ error: 'departure_at is required.' });
    }

    // Read the configurable overlap buffer from DB
    const { rows: cfg } = await pool.query(
      `SELECT value FROM configuration WHERE key = 'trip_overlap_buffer_minutes'`
    );
    const bufferMinutes = parseInt(cfg[0]?.value || '120', 10);

    // Compute the proposed trip's end time in JS so the SQL stays simple.
    let proposedEnd;
    if (return_at) {
      proposedEnd = return_at;
    } else if (duration_minutes && !isNaN(parseInt(duration_minutes))) {
      const d = new Date(departure_at);
      d.setMinutes(d.getMinutes() + parseInt(duration_minutes));
      proposedEnd = d.toISOString();
    } else {
      const d = new Date(departure_at);
      d.setMinutes(d.getMinutes() + bufferMinutes);
      proposedEnd = d.toISOString();
    }

    // Overlap query: existing.start < proposed.end AND existing.end > proposed.start
    // existing.end falls back through return_at → duration_minutes → buffer.
    const { rows: conflicts } = await pool.query(
      `SELECT trip_number, departure_at
       FROM trips
       WHERE driver_id   = $1
         AND status      = 'assigned'
         AND departure_at < $3::timestamptz
         AND (
           CASE
             WHEN return_at IS NOT NULL
               THEN return_at
             ELSE departure_at + (COALESCE(duration_minutes, $4) || ' minutes')::INTERVAL
           END
         ) > $2::timestamptz
       ORDER BY departure_at ASC`,
      [req.params.id, departure_at, proposedEnd, bufferMinutes]
    );

    res.json({
      available: conflicts.length === 0,
      conflicts: conflicts.map(c => ({
        trip_number:  c.trip_number,
        departure_at: c.departure_at,
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
