/**
 * @file routes/trips/my-trips.js
 * @description Returns a paginated list of trips belonging to the requesting user.
 *              Mounted at GET /api/trips/my-trips.
 *
 * Auth: JWT required (any role).
 *
 * Role behaviour:
 *   Drivers  — see trips where they are the assigned driver (driver_id = user)
 *   Clients  — see trips they booked (client_id = user)
 *   Admins   — should use the admin/trips endpoint instead; this route does not
 *              grant access to other users' trips.
 *
 * Query params:
 *   status  — optional filter.  'upcoming' is a frontend alias for the DB
 *             status 'assigned' (clearer wording for the UI).
 *             All other values are passed directly to the WHERE clause.
 *   limit   — maximum rows per page (default 20).
 *   offset  — pagination offset (default 0).
 *
 * Sort order (chosen to match natural reading on each tab):
 *   No status filter  → future trips first (soonest departure at top), then
 *                       past trips (most recent at top).  Uses a compound ORDER
 *                       BY that partitions rows by whether departure_at is in
 *                       the future, then sorts each partition independently.
 *   completed/cancelled → most recent departure at top (DESC).
 *   pending/upcoming    → soonest departure at top (ASC).
 *
 * Privacy:
 *   Name fields (client, driver, booked-by) are masked via maskName() before
 *   leaving the server so drivers never see a client's full last name.
 */

const express          = require('express');
const { pool }         = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { maskName }     = require('../../utils/namePrivacy');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trips/my-trips
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const isDriver = req.user.role === 'driver';

    // Build the base query with full denormalization: client name, driver name,
    // vehicle details, operator who booked the trip, and the most recent payment
    // record (via LATERAL join so trips without payments are still included).
    let query = `
      SELECT t.*,
        u.first_name  AS client_first_name,
        u.last_name   AS client_last_name,
        u.phone       AS client_phone,
        d.first_name  AS driver_first_name,
        d.last_name   AS driver_last_name,
        d.phone       AS driver_phone,
        dp.vehicle_make                       AS driver_vehicle_make,
        dp.vehicle_model                      AS driver_vehicle_model,
        dp.vehicle_year                       AS driver_vehicle_year,
        dp.vehicle_color                      AS driver_vehicle_color,
        dp.license_plate                      AS driver_license_plate,
        ab.first_name AS booked_by_first_name,
        ab.last_name  AS booked_by_last_name,
        p.id              AS payment_id,
        p.status          AS payment_status,
        p.payment_method  AS payment_method,
        p.amount          AS payment_amount,
        p.currency        AS payment_currency,
        p.paid_at         AS payment_paid_at,
        p.payment_reference AS payment_reference
      FROM trips t
      LEFT JOIN users u  ON u.id  = t.client_id
      LEFT JOIN users d  ON d.id  = t.driver_id
      LEFT JOIN driver_profiles dp ON dp.user_id = t.driver_id
      LEFT JOIN users ab ON ab.id = t.created_by_admin
      -- LATERAL ensures exactly one payment row per trip (the most recent one).
      -- Using LEFT JOIN so trips with no payment record still appear in the list.
      LEFT JOIN LATERAL (
        SELECT * FROM payments WHERE trip_id = t.id ORDER BY created_at DESC LIMIT 1
      ) p ON true
      WHERE ${isDriver ? 't.driver_id' : 't.client_id'} = $1
    `;
    const values = [req.user.id];
    let i = 2;  // Next bind parameter index

    if (status) {
      // 'upcoming' is a UX-friendly alias displayed in the frontend tab bar.
      // It maps to the DB status 'assigned' (a driver has accepted the trip and
      // it has not yet been completed or cancelled).
      if (status === 'upcoming') {
        query += ` AND t.status = 'assigned'`;
      } else {
        query += ` AND t.status = $${i++}`;
        values.push(status);
      }
    }

    // ── Sorting strategy ────────────────────────────────────────────────────
    // Without a status filter (the "All trips" tab), we want two visual groups:
    //   1. Future trips (departure_at >= now), sorted ASC → closest upcoming first
    //   2. Past trips (departure_at < now),   sorted DESC → most recent past first
    //
    // This is achieved with a compound ORDER BY:
    //   - The boolean (departure_at >= NOW()) is sorted DESC (true = 1 > false = 0),
    //     so future trips float to the top of the list.
    //   - Within each group, a CASE expression selects the appropriate sort column;
    //     the other CASE evaluates to NULL and is pushed to the end by NULLS LAST.
    if (!status) {
      query += `
        ORDER BY
          (t.departure_at >= NOW()) DESC,
          CASE WHEN t.departure_at >= NOW() THEN t.departure_at END ASC,
          CASE WHEN t.departure_at <  NOW() THEN t.departure_at END DESC NULLS LAST`;
    } else if (status === 'completed' || status === 'cancelled') {
      // Historical tabs: most recently departed trip at the top.
      query += ` ORDER BY t.departure_at DESC`;
    } else {
      // Pending / upcoming tabs: soonest departure at the top.
      query += ` ORDER BY t.departure_at ASC`;
    }
    query += ` LIMIT $${i++} OFFSET $${i++}`;
    values.push(parseInt(limit), parseInt(offset));

    const { rows } = await pool.query(query, values);
    const role = req.user.role;

    // Merge the separate first_name / last_name fields into a single masked
    // display name and strip the raw fields from the response.
    const trips = rows.map(r => ({
      ...r,
      client_name:        maskName(r.client_first_name, r.client_last_name,       role),
      driver_name:        maskName(r.driver_first_name, r.driver_last_name,       role),
      booked_by_name:     maskName(r.booked_by_first_name, r.booked_by_last_name, role),
      // Strip the raw name fields — only the masked combined name is sent
      client_first_name:    undefined, client_last_name:    undefined,
      driver_first_name:    undefined, driver_last_name:    undefined,
      booked_by_first_name: undefined, booked_by_last_name: undefined,
    }));

    res.json({ trips });
  } catch (err) { next(err); }
});

module.exports = router;
