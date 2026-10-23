/**
 * @file routes/tickets/management.js
 * @description Ticket lifecycle management routes — mounted at /api/tickets/
 *
 * Routes:
 *   GET   /clients                — search client users (ticket_master+)
 *   GET   /trips                  — trips paid via mobility tickets (ticket_master+)
 *   GET   /reports/used           — used-ticket report with date range (ticket_master only)
 *   POST  /release/:trip_id       — release reserved tickets back to available (ticket_master+)
 *   PATCH /:ticket_number/void    — permanently void an available ticket (ticket_master+)
 *
 * Registration order: literal paths (/clients, /trips, /reports/used, /release/:trip_id)
 * must come before the catch-all param route (/:ticket_number/void) so they are not
 * swallowed by the param matcher.
 */

const express  = require('express');
const { pool } = require('../../db/pool');
const { authenticate, authorize } = require('../../middleware/auth');
const { logger } = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/clients
//
// Purpose: Search for client users by name or email — used by the Notebooks
//   create form so that ticket_master can look up a client without needing
//   access to the /api/admin/users endpoint.
// Auth:    ticket_master, superadmin
// Query:   ?q=search term, ?limit=8 (optional)
// Returns: { users: [{ id, first_name, last_name, email }] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/clients',
  authenticate,
  authorize('ticket_master', 'superadmin'),
  async (req, res, next) => {
    try {
      const q     = (req.query.q || '').trim();
      const limit = Math.min(parseInt(req.query.limit || 8, 10), 50);

      if (q.length < 2) {
        return res.json({ users: [] });
      }

      const { rows } = await pool.query(
        `SELECT id, first_name, last_name, email, phone
         FROM users
         WHERE role = 'client'
           AND (
             first_name ILIKE $1 OR last_name ILIKE $1
             OR email ILIKE $1 OR phone ILIKE $1
             OR (first_name || ' ' || last_name) ILIKE $1
           )
         ORDER BY first_name, last_name
         LIMIT $2`,
        [`%${q}%`, limit]
      );

      res.json({ users: rows });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/trips
//
// Purpose: Return trips paid via mobility tickets, with associated ticket details.
//   Allows ticket_master to follow up on ticket usage.
//   Only returns trips where payment_method = 'mobility'.
//
// Auth:    ticket_master, superadmin
// Query:   ?status=pending|assigned|completed|cancelled (optional)
// Returns: { trips: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/trips',
  authenticate,
  authorize('ticket_master', 'superadmin'),
  async (req, res, next) => {
    try {
      const { status } = req.query;
      const values = [];
      let where = `WHERE p.payment_method = 'mobility'`;

      if (status) {
        values.push(status);
        where += ` AND t.status = $${values.length}`;
      }

      const { rows } = await pool.query(
        `SELECT
           t.id, t.trip_number, t.status, t.departure_at, t.return_at,
           t.pickup_address, t.dropoff_address, t.estimated_cost, t.distance_km,
           t.created_at,
           u_client.first_name  AS client_first_name,
           u_client.last_name   AS client_last_name,
           u_driver.first_name  AS driver_first_name,
           u_driver.last_name   AS driver_last_name,
           p.id                 AS payment_id,
           p.status             AS payment_status,
           p.amount             AS payment_amount,
           p.currency           AS payment_currency,
           p.paid_at,
           -- Aggregate ticket numbers for this trip
           ARRAY_AGG(mt.ticket_number ORDER BY mt.ticket_number) AS ticket_numbers
         FROM trips t
         JOIN payments p       ON p.trip_id    = t.id
         JOIN users u_client   ON u_client.id  = t.client_id
         LEFT JOIN users u_driver ON u_driver.id = t.driver_id
         LEFT JOIN mobility_tickets mt ON mt.trip_id = t.id
         ${where}
         GROUP BY t.id, u_client.first_name, u_client.last_name,
                  u_driver.first_name, u_driver.last_name,
                  p.id, p.status, p.amount, p.currency, p.paid_at
         ORDER BY t.created_at DESC`,
        values
      );

      res.json({ trips: rows });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/reports/used
//
// Purpose: Return used mobility tickets for a given date range, intended for
//   the ticket master to produce a payment report for drivers.
//   Only tickets with status = 'used' (pending payout) are included.
//
// Auth:    ticket_master only
// Query:   ?from=YYYY-MM-DD  (inclusive, required)
//          ?to=YYYY-MM-DD    (inclusive, required)
// Returns: { tickets: [{ ticket_number, used_at, trip_number, customer_name, driver_name }] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reports/used',
  authenticate,
  authorize('ticket_master'),
  async (req, res, next) => {
    try {
      const { from, to } = req.query;
      if (!from || !to) {
        return res.status(400).json({ error: 'Both from and to date parameters are required.' });
      }

      // Parse as dates; add one day to `to` so the range is inclusive of that day
      const fromDate = new Date(from);
      const toDate   = new Date(to);
      toDate.setDate(toDate.getDate() + 1); // make `to` inclusive

      if (isNaN(fromDate) || isNaN(toDate)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      }

      const { rows } = await pool.query(
        `SELECT
           mt.ticket_number,
           mt.used_at,
           t.trip_number,
           u_client.first_name || ' ' || u_client.last_name AS customer_name,
           u_driver.first_name || ' ' || u_driver.last_name AS driver_name
         FROM mobility_tickets mt
         JOIN trips t          ON t.id         = mt.trip_id
         JOIN users u_client   ON u_client.id  = t.client_id
         LEFT JOIN users u_driver ON u_driver.id = t.driver_id
         WHERE mt.status = 'used'
           AND mt.used_at >= $1
           AND mt.used_at <  $2
         ORDER BY mt.used_at DESC`,
        [fromDate.toISOString(), toDate.toISOString()]
      );

      res.json({ tickets: rows });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/release/:trip_id
//
// Purpose: Release reserved mobility tickets back to 'available'.
//   Called internally by the trips cancel route, and can be triggered manually
//   by ticket_master/superadmin when needed.
//
// Auth:    ticket_master, superadmin, operator
// Returns: { released_count }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/release/:trip_id',
  authenticate,
  authorize('ticket_master', 'operator', 'superadmin'),
  async (req, res, next) => {
    try {
      // Verify the trip exists and is a mobility-payment trip before touching tickets.
      // Prevents an operator from accidentally (or maliciously) releasing tickets
      // on a non-mobility trip or a trip that does not exist.
      const { rows: tripRows } = await pool.query(
        `SELECT t.id FROM trips t
         JOIN payments p ON p.trip_id = t.id
         WHERE t.id = $1 AND p.payment_method = 'mobility'
         LIMIT 1`,
        [req.params.trip_id]
      );
      if (!tripRows.length) {
        return res.status(404).json({
          error: 'Trip not found or does not use mobility ticket payment.',
          code:  'TRIP_NOT_FOUND',
        });
      }

      const { rows } = await pool.query(
        `UPDATE mobility_tickets
         SET status = 'available', trip_id = NULL, reserved_at = NULL
         WHERE trip_id = $1 AND status = 'reserved'
         RETURNING id`,
        [req.params.trip_id]
      );
      res.json({ released_count: rows.length });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/tickets/:ticket_number/void
//
// Purpose: Void a single ticket, making it permanently unusable.
//   Can only void tickets that are in 'available' status
//   (reserved/used tickets are tied to trips and must not be voided).
//
// Auth:    ticket_master, superadmin
// Returns: { ticket }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:ticket_number/void',
  authenticate,
  authorize('ticket_master', 'superadmin'),
  async (req, res, next) => {
    try {
      const num = parseInt(req.params.ticket_number, 10);
      if (isNaN(num)) {
        return res.status(400).json({ error: 'Invalid ticket number.', code: 'INVALID_TICKET_NUMBER' });
      }

      const { rows } = await pool.query(
        `SELECT * FROM mobility_tickets WHERE ticket_number = $1`,
        [num]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Ticket not found.', code: 'NOT_FOUND' });
      }

      const ticket = rows[0];
      if (ticket.status !== 'available') {
        return res.status(409).json({
          error: `Only available tickets can be voided (current status: "${ticket.status}").`,
          code:  'CANNOT_VOID',
        });
      }

      const { rows: updated } = await pool.query(
        `UPDATE mobility_tickets SET status = 'voided' WHERE id = $1 RETURNING *`,
        [ticket.id]
      );

      logger.info('mobility_tickets: ticket voided', {
        ticketNumber: num,
        voidedBy:     req.user.id,
      });

      res.json({ ticket: updated[0] });
    } catch (err) { next(err); }
  }
);

module.exports = router;
