/**
 * @file routes/admin/trips.js
 * @description Admin trip management routes.
 *              Mounted at /api/admin/trips
 *
 * Auth: operator or superadmin (enforced by parent router).
 *
 * Routes:
 *   GET   /              — paginated trip list with optional status filter
 *   PATCH /:id/assign    — manually assign a driver to a pending trip
 *   PATCH /:id/cancel-completed — cancel a completed mobility-ticket trip,
 *                                 releasing reserved tickets back to available
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { pool }   = require('../../db/pool');
const { logger } = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/trips
//
// Paginated list of all trips with denormalized client, driver, and
// booking-operator names. Includes latest payment info per trip.
//
// Query params:
//   status — filter by trip status (optional)
//   limit  — page size (default 50)
//   offset — pagination offset (default 0)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const values = [];
    // Only add a WHERE clause when a status filter is requested.
    let where = '';
    if (status) { where = 'WHERE t.status = $1'; values.push(status); }

    const { rows } = await pool.query(
      `SELECT t.*,
         c.first_name || ' ' || c.last_name  AS client_name,
         d.first_name || ' ' || d.last_name  AS driver_name,
         ab.first_name || ' ' || ab.last_name AS booked_by_name,
         -- Payment info joined laterally so admins can see payment status
         -- in the trip list without a separate API call.
         p.id               AS payment_id,
         p.status           AS payment_status,
         p.payment_method   AS payment_method,
         p.amount           AS payment_amount,
         p.currency         AS payment_currency,
         p.paid_at          AS payment_paid_at,
         p.payment_reference AS payment_reference
       FROM trips t
       LEFT JOIN users c  ON c.id  = t.client_id
       LEFT JOIN users d  ON d.id  = t.driver_id
       -- ab is the operator who created the trip on behalf of the client.
       LEFT JOIN users ab ON ab.id = t.created_by_admin
       -- Most recent payment row per trip (LATERAL handles edge cases cleanly)
       LEFT JOIN LATERAL (
         SELECT * FROM payments WHERE trip_id = t.id ORDER BY created_at DESC LIMIT 1
       ) p ON true
       ${where}
       ORDER BY t.departure_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    res.json({ trips: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/trips/:id/assign
//
// Manually assigns a driver to a pending trip (admin override path).
// Only trips with status = 'pending' can be assigned — the WHERE clause
// guard prevents silent overwriting of an already-assigned driver.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/assign',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  body('driver_id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      // AND status = 'pending' in the WHERE clause is the double-assignment guard:
      // if the trip was already assigned (or cancelled), 0 rows are updated and
      // a 409 is returned, preventing silent overwrites.
      const { rows } = await pool.query(
        `UPDATE trips SET driver_id = $1, status = 'assigned',
         assigned_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND status = 'pending'
         RETURNING *`,
        [req.body.driver_id, req.params.id]
      );
      if (!rows.length) return res.status(409).json({ error: 'Trip not found or already assigned.' });
      res.json({ message: 'Driver assigned.', trip: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/trips/:id/cancel-completed
//
// Cancels a completed trip that was paid with mobility tickets, releasing
// the reserved tickets back to 'available' so the client can reuse them.
//
// Restrictions:
//   - Trip must currently have status = 'completed'
//   - Payment method must be 'mobility' (Stripe/manual trips are not handled here)
//
// Side effects (all best-effort after the trip status update):
//   - mobility_tickets with status 'reserved' or 'used' tied to this trip
//     are reset to 'available' (trip_id, reserved_at, used_at cleared)
//   - driver_earnings row for this trip is deleted (if it exists)
//   - Audit log entry written
//
// This endpoint is intentionally restricted to mobility-ticket trips because
// cancelling a Stripe-charged trip requires a refund flow, not handled here.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/cancel-completed',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const { id } = req.params;

      // Fetch trip + its payment method in one query
      const { rows } = await pool.query(
        `SELECT t.id, t.status, t.trip_number, t.driver_id,
                p.payment_method
         FROM trips t
         LEFT JOIN LATERAL (
           SELECT payment_method FROM payments WHERE trip_id = t.id
           ORDER BY created_at DESC LIMIT 1
         ) p ON true
         WHERE t.id = $1`,
        [id]
      );

      if (!rows.length) return res.status(404).json({ error: 'Trip not found.' });
      const trip = rows[0];

      if (trip.status !== 'completed') {
        return res.status(422).json({
          error: `Only completed trips can be cancelled via this action (current status: "${trip.status}").`,
          code: 'INVALID_STATUS',
        });
      }

      if (trip.payment_method !== 'mobility') {
        return res.status(422).json({
          error: 'This action only applies to trips paid with mobility tickets.',
          code: 'NOT_MOBILITY_PAYMENT',
        });
      }

      // Mark the trip as cancelled
      await pool.query(
        `UPDATE trips SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [id]
      );

      // Release mobility tickets — covers both 'reserved' (not yet processed by job)
      // and 'used' (already processed but still within challenge window)
      const { rows: released } = await pool.query(
        `UPDATE mobility_tickets
         SET status = 'available', trip_id = NULL,
             reserved_at = NULL, used_at = NULL, paid_out_at = NULL
         WHERE trip_id = $1 AND status IN ('reserved', 'used')
         RETURNING id`,
        [id]
      );

      // Remove driver earnings if present (may not exist for mobility trips)
      await pool.query(
        `DELETE FROM driver_earnings WHERE trip_id = $1`,
        [id]
      );

      // Audit log (best-effort)
      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'trip.cancel_completed', 'trip', $2,
                   ('{"status":"cancelled","tickets_released":' || $3 || '}')::jsonb)`,
          [req.user.id, id, released.length]
        );
      } catch (e) { logger.warn('Audit log failed for cancel-completed', { message: e.message }); }

      res.json({
        message:          'Completed trip cancelled. Mobility tickets released.',
        tickets_released: released.length,
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
