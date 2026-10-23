/**
 * @file routes/admin/dashboard.js
 * @description Platform-wide statistics snapshot.
 *              Mounted at /api/admin/dashboard
 *
 * Auth: operator or superadmin (enforced by parent router).
 *
 * Routes:
 *   GET / — single-row statistics snapshot for the admin dashboard overview card.
 */

const express  = require('express');
const { pool } = require('../../db/pool');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/dashboard
//
// Returns a single-row snapshot of platform-wide statistics.
//
// Trip bucket definitions (mutually exclusive; their sum = all_trips):
//   pending         — no driver assigned yet.
//   upcoming        — driver assigned, departure is in the future.
//   active          — departure has passed AND the return window has not yet
//                     closed. When return_at is NULL, a 4-hour window from
//                     departure_at is used as a proxy.
//   completed       — status was explicitly set to 'completed'.
//   past_assigned   — departure AND return window have both passed but status
//                     was never updated; these trips need admin follow-up.
//   cancelled       — status = 'cancelled'.
//
// Revenue figures come from the payments table (status = 'paid'), not from
// estimated_cost on the trip itself, to reflect actual settled amounts.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        -- ── User counts by role (excludes soft-deleted accounts) ──────────
        (SELECT COUNT(*) FROM users WHERE role = 'client'   AND status != 'deleted') AS total_clients,
        (SELECT COUNT(*) FROM users WHERE role = 'driver'   AND status != 'deleted') AS total_drivers,
        (SELECT COUNT(*) FROM users WHERE role = 'operator' AND status != 'deleted') AS total_operators,
        -- Drivers awaiting admin review of their application.
        (SELECT COUNT(*) FROM users u JOIN driver_profiles dp ON dp.user_id = u.id
         WHERE u.role = 'driver' AND dp.approval_status = 'pending')                 AS pending_drivers,

        -- ── Trip buckets (mutually exclusive, sum = all_trips) ──────────

        -- 1. Waiting for a driver to be assigned.
        (SELECT COUNT(*) FROM trips
           WHERE status = 'pending')                                                  AS pending_trips,

        -- 2. Assigned to a driver but departure is still in the future.
        (SELECT COUNT(*) FROM trips
           WHERE status = 'assigned'
           AND departure_at > NOW())                                                  AS upcoming_trips,

        -- 3. Currently on the road:
        --    departure has passed AND the return window has not yet closed.
        --    When return_at is NULL (one-way trips), a 4-hour proxy window
        --    from departure_at is used to avoid counting stale trips as active.
        (SELECT COUNT(*) FROM trips
           WHERE status IN ('assigned', 'in_progress')
           AND departure_at <= NOW()
           AND (
             (return_at IS NOT NULL AND return_at > NOW())
             OR
             (return_at IS NULL AND departure_at >= NOW() - INTERVAL '4 hours')
           ))                                                                         AS active_trips,

        -- 4. Completed — status was explicitly set to 'completed' by admin or driver.
        (SELECT COUNT(*) FROM trips
           WHERE status = 'completed')                                                AS completed_trips,

        -- 5. Past-assigned: departure AND return window have both elapsed but
        --    status was never updated to 'completed' or 'cancelled'.
        --    These are stale trips that need admin follow-up.
        (SELECT COUNT(*) FROM trips
           WHERE status IN ('assigned', 'in_progress')
           AND departure_at <= NOW()
           AND (
             (return_at IS NOT NULL AND return_at <= NOW())
             OR
             (return_at IS NULL AND departure_at < NOW() - INTERVAL '4 hours')
           ))                                                                         AS past_assigned_trips,

        -- 6. Cancelled trips.
        (SELECT COUNT(*) FROM trips
           WHERE status = 'cancelled')                                                AS cancelled_trips,

        -- Grand total — should equal the sum of all buckets above.
        (SELECT COUNT(*) FROM trips)                                                  AS all_trips,

        -- ── Rolling 30-day performance ────────────────────────────────────
        (SELECT COUNT(*) FROM trips
           WHERE status = 'completed'
           AND completed_at >= NOW() - INTERVAL '30 days')                           AS completed_last_30d,

        -- Revenue is based on settled payments, not estimates, for accuracy.
        (SELECT COALESCE(SUM(amount), 0) FROM payments
           WHERE status = 'paid'
           AND paid_at >= NOW() - INTERVAL '30 days')                                AS revenue_last_30d
    `);
    res.json({ stats: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
