/**
 * @file routes/trips/stats.js
 * @description Returns trip counts and financial summary for the authenticated user.
 *              Mounted at GET /api/trips/stats.
 *
 * Auth: JWT required (any role).
 *
 * Response shape:
 *   Always included:
 *     stats.pending    — trips awaiting driver assignment
 *     stats.upcoming   — trips with a driver assigned (status='assigned' in DB,
 *                        labelled 'upcoming' in the UI for clarity)
 *     stats.completed  — trips that were completed
 *     stats.cancelled  — trips that were cancelled
 *     stats.all_trips  — total across all statuses
 *
 *   Additional fields for drivers only:
 *     stats.earnings.pending_earnings  — earnings accrued but not yet paid out
 *     stats.earnings.total_earnings    — all-time paid-out earnings
 *     stats.profile.is_available       — driver's current availability toggle
 *     stats.profile.approval_status    — whether the admin approved the profile
 *     stats.profile.average_rating     — driver's average review score
 *     stats.profile.review_count       — how many approved reviews they have
 *     stats.available_trips            — pending trips within this driver's service radius
 *                                        that are currently open to them (respects preferred-
 *                                        driver window: trips locked to another preferred driver
 *                                        are excluded from the count)
 *
 * Why three separate queries for drivers?
 *   Each query hits a different table (trips, driver_earnings, driver_profiles) with no
 *   natural join key that would let them be combined without duplication.  Three fast
 *   index-seek queries are cleaner and more maintainable than a multi-join with GROUP BY.
 *
 * The available_trips count intentionally mirrors the WHERE clause in available.js so the
 * badge shown on the driver's dashboard matches what they would see on the search page.
 */

const express          = require('express');
const { pool }         = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trips/stats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const isDriver = req.user.role === 'driver';

    // Switch the filter column based on role: drivers filter by driver_id,
    // all other roles (client, operator, superadmin) filter by client_id.
    const field = isDriver ? 'driver_id' : 'client_id';

    // ── Query 1: Trip counts ─────────────────────────────────────────────────
    // Aggregate all status counts in a single pass using conditional aggregation.
    // COUNT(*) FILTER is standard SQL:2003 and performs better than SUM+CASE.
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')                        AS pending,
        COUNT(*) FILTER (WHERE status = 'assigned')                       AS upcoming,
        COUNT(*) FILTER (WHERE status = 'completed')                      AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')                      AS cancelled,
        COUNT(*)                                                           AS all_trips
      FROM trips
      WHERE ${field} = $1
    `, [req.user.id]);

    const stats = rows[0];

    if (isDriver) {
      // ── Query 2: Driver earnings summary ──────────────────────────────────
      // driver_earnings rows are created when a trip is completed and transition
      // from 'pending' to 'paid_out' when the operator pays the driver.
      // COALESCE handles the case where the driver has no earnings rows yet.
      const { rows: earnings } = await pool.query(`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status = 'pending'),  0) AS pending_earnings,
          COALESCE(SUM(amount) FILTER (WHERE status = 'paid_out'), 0) AS total_earnings
        FROM driver_earnings WHERE driver_id = $1
      `, [req.user.id]);

      // ── Query 3: Driver profile snapshot ──────────────────────────────────
      // Surfaces the availability toggle, approval state, and rating for the
      // dashboard header card without requiring a separate profile API call.
      const { rows: profile } = await pool.query(`
        SELECT is_available, approval_status, average_rating, review_count,
               approval_overridden
        FROM driver_profiles WHERE user_id = $1
      `, [req.user.id]);

      // ── Query 4: Open-trip count (available to this driver right now) ─────
      // Uses PostGIS ST_DWithin to count trips within the driver's service radius.
      // Excludes trips still in a preferred-driver response window (another driver
      // was chosen and has not yet replied — those trips are hidden from the pool).
      // Matches the WHERE clause in available.js so badge == list count.
      const { rows: available } = await pool.query(`
        SELECT COUNT(*) AS available_trips
        FROM trips t
        JOIN driver_profiles dp ON dp.user_id = $1
        WHERE t.status = 'pending'
          AND ST_DWithin(dp.home_point, t.pickup_point, dp.service_radius_km * 1000)
          AND t.departure_at > NOW()
          AND NOT (
            t.preferred_driver_id IS NOT NULL
            AND t.preferred_driver_declined = false
            AND t.broadcast_at IS NULL
          )
      `, [req.user.id]);

      // Attach the driver-specific blocks to the stats object.
      // profile[0] can be null if the driver row does not exist yet.
      stats.earnings        = earnings[0];
      stats.profile         = profile[0] || null;
      stats.available_trips = parseInt(available[0].available_trips);
    }

    res.json({ stats });
  } catch (err) { next(err); }
});

module.exports = router;
