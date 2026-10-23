/**
 * @file routes/tickets/client.js
 * @description Client-facing ticket routes — mounted at /api/tickets/
 *
 * Routes:
 *   GET  /my-tickets          — client's own available tickets
 *   GET  /for-trip/:trip_id   — required count + available tickets for a trip
 *   POST /reserve             — reserve tickets for a trip payment
 */

const express  = require('express');
const { pool } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { logger } = require('../../utils/logger');
const { getMobilityConfig } = require('./helpers');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/my-tickets
//
// Purpose: Return all available tickets owned by the authenticated client.
// Auth:    client (own tickets only)
// Returns: { tickets, facial_value, currency }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my-tickets', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'Clients only.' });
    }

    const cfg = await getMobilityConfig(pool);

    const { rows } = await pool.query(
      `SELECT mt.ticket_number, mt.status, mt.reserved_at,
              n.notebook_number, n.facial_value, n.currency, n.org_name
       FROM mobility_tickets mt
       JOIN ticket_notebooks n ON n.id = mt.notebook_id
       WHERE n.owner_type = 'client'
         AND n.owner_client_id = $1
         AND mt.status = 'available'
       ORDER BY mt.ticket_number ASC`,
      [req.user.id]
    );

    res.json({
      tickets:      rows,
      facial_value: cfg.facialValue,
      currency:     cfg.currency,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/for-trip/:trip_id
//
// Purpose: Return the required ticket count for a trip's estimated cost,
//   plus the authenticated client's available tickets (as suggestions).
// Auth:    Any authenticated user (must be the trip's client)
// Returns: { required_count, facial_value, currency, available_tickets }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/for-trip/:trip_id', authenticate, async (req, res, next) => {
  try {
    const { rows: tripRows } = await pool.query(
      `SELECT id, client_id, estimated_cost FROM trips WHERE id = $1`,
      [req.params.trip_id]
    );

    if (!tripRows.length) {
      return res.status(404).json({ error: 'Trip not found.' });
    }

    const trip = tripRows[0];

    if (trip.client_id !== req.user.id && !['operator', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const cfg = await getMobilityConfig(pool);
    const cost = parseFloat(trip.estimated_cost ?? 0);
    const requiredCount = cost <= 0 ? 1 : Math.ceil(cost / cfg.facialValue);

    // Return the client's own available tickets as auto-fill suggestions
    const { rows: available } = await pool.query(
      `SELECT mt.ticket_number, n.owner_type, n.org_name, n.notebook_number
       FROM mobility_tickets mt
       JOIN ticket_notebooks n ON n.id = mt.notebook_id
       WHERE n.owner_type = 'client'
         AND n.owner_client_id = $1
         AND mt.status = 'available'
       ORDER BY mt.ticket_number ASC`,
      [trip.client_id]
    );

    res.json({
      required_count:    requiredCount,
      facial_value:      cfg.facialValue,
      currency:          cfg.currency,
      estimated_cost:    cost,
      available_tickets: available,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/reserve
//
// Purpose: Reserve a set of mobility tickets for a specific trip.
//   Validates ownership, availability, and count sufficiency.
//   Creates a 'mobility' payment record with status='authorized'.
//
// Auth:    Any authenticated user (client reserving their own tickets)
// Body:
//   trip_id         — UUID of the trip to pay for
//   ticket_numbers  — array of ticket numbers (integers)
//   org_id?         — required when using organization tickets
//
// Returns: { payment_id, ticket_numbers, required_count, total_charged }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reserve', authenticate, async (req, res, next) => {
  const db = await pool.connect();
  try {
    const { trip_id, ticket_numbers, notebook_key, notebook_keys } = req.body;

    // Collect all provided notebook keys (support single key for backward compat + new array form)
    const providedKeys = [
      ...(Array.isArray(notebook_keys) ? notebook_keys : []),
      ...(notebook_key ? [notebook_key] : []),
    ].map(k => String(k).trim().toUpperCase()).filter(Boolean);
    const uniqueKeys = [...new Set(providedKeys)];

    if (!trip_id) {
      return res.status(400).json({ error: 'trip_id is required.', code: 'MISSING_TRIP_ID' });
    }
    if (!Array.isArray(ticket_numbers) || ticket_numbers.length === 0) {
      return res.status(400).json({ error: 'ticket_numbers must be a non-empty array.', code: 'MISSING_TICKETS' });
    }
    // Normalise to integers
    const nums = ticket_numbers.map(n => parseInt(n, 10));
    if (nums.some(isNaN)) {
      return res.status(400).json({ error: 'All ticket numbers must be integers.', code: 'INVALID_TICKET_NUMBERS' });
    }
    // Deduplicate
    const uniqueNums = [...new Set(nums)];
    if (uniqueNums.length !== nums.length) {
      return res.status(400).json({ error: 'Duplicate ticket numbers are not allowed.', code: 'DUPLICATE_TICKETS' });
    }

    // ── Verify trip ownership ───────────────────────────────────────────────
    const { rows: tripRows } = await db.query(
      `SELECT t.*, u.stripe_customer_id
       FROM trips t JOIN users u ON u.id = t.client_id
       WHERE t.id = $1`,
      [trip_id]
    );
    if (!tripRows.length) {
      return res.status(404).json({ error: 'Trip not found.', code: 'TRIP_NOT_FOUND' });
    }
    const trip = tripRows[0];

    const isAdmin = ['operator', 'superadmin'].includes(req.user.role);
    if (trip.client_id !== req.user.id && !isAdmin) {
      return res.status(403).json({ error: 'Access denied.', code: 'FORBIDDEN' });
    }
    if (trip.status !== 'pending') {
      return res.status(422).json({
        error: `Ticket reservation is only available for pending trips (current: "${trip.status}").`,
        code:  'INVALID_TRIP_STATUS',
      });
    }

    // ── Check no existing payment for this trip ─────────────────────────────
    // A 'pending' Stripe payment means the setup-intent was fetched but the
    // card was never saved. The user switched to mobility instead — delete the
    // orphaned row so the reservation can proceed.
    const { rows: existingPay } = await db.query(
      `SELECT id, status, payment_method FROM payments WHERE trip_id = $1 LIMIT 1`,
      [trip_id]
    );
    if (existingPay.length) {
      const existing = existingPay[0];
      if (existing.status === 'pending' && existing.payment_method === 'stripe') {
        await db.query(`DELETE FROM payments WHERE id = $1`, [existing.id]);
      } else {
        return res.status(409).json({
          error: 'A payment record already exists for this trip.',
          code:  'PAYMENT_EXISTS',
        });
      }
    }

    // ── Load mobility config ────────────────────────────────────────────────
    const cfg = await getMobilityConfig(db);
    const cost = parseFloat(trip.estimated_cost ?? 0);
    const requiredCount = cost <= 0 ? 1 : Math.ceil(cost / cfg.facialValue);

    if (uniqueNums.length < requiredCount) {
      return res.status(422).json({
        error: `This trip requires ${requiredCount} ticket(s) (trip cost: ${cost} ${cfg.currency}, facial value: ${cfg.facialValue} each). You provided ${uniqueNums.length}.`,
        code:  'INSUFFICIENT_TICKETS',
        required_count: requiredCount,
      });
    }

    // ── Load and validate each ticket ───────────────────────────────────────
    const { rows: ticketRows } = await db.query(
      `SELECT mt.*, n.owner_type, n.owner_client_id, n.org_name, n.notebook_key
       FROM mobility_tickets mt
       JOIN ticket_notebooks n ON n.id = mt.notebook_id
       WHERE mt.ticket_number = ANY($1::int[])`,
      [uniqueNums]
    );

    // All requested numbers must exist
    if (ticketRows.length !== uniqueNums.length) {
      const found = new Set(ticketRows.map(r => r.ticket_number));
      const missing = uniqueNums.filter(n => !found.has(n));
      return res.status(404).json({
        error:   'One or more ticket numbers not found.',
        code:    'TICKETS_NOT_FOUND',
        missing,
      });
    }

    // All tickets must be available (not reserved, used, or voided)
    const unavailable = ticketRows.filter(r => r.status !== 'available');
    if (unavailable.length) {
      return res.status(409).json({
        error:    'One or more tickets are not available.',
        code:     'TICKETS_UNAVAILABLE',
        tickets:  unavailable.map(r => ({ number: r.ticket_number, status: r.status })),
      });
    }

    // ── Ownership validation ─────────────────────────────────────────────────
    // Client-owned tickets must belong to the requesting client.
    // Organisation tickets must each have their notebook_key in the provided keys list.
    // Mixing client-owned and org-owned tickets in the same reservation is allowed.

    const clientTickets = ticketRows.filter(r => r.owner_type === 'client');
    const orgTickets    = ticketRows.filter(r => r.owner_type === 'organization');

    // Client-owned: verify ownership
    const wrongOwner = clientTickets.filter(r => r.owner_client_id !== trip.client_id);
    if (wrongOwner.length) {
      return res.status(403).json({
        error: 'One or more tickets do not belong to this client.',
        code:  'TICKETS_NOT_OWNED',
      });
    }

    // Org-owned: each ticket's notebook_key must appear in the provided keys
    if (orgTickets.length > 0) {
      if (uniqueKeys.length === 0) {
        return res.status(422).json({
          error: 'notebook_keys is required to use organisation tickets.',
          code:  'MISSING_NOTEBOOK_KEY',
        });
      }
      const wrongKey = orgTickets.filter(r => !uniqueKeys.includes(r.notebook_key));
      if (wrongKey.length) {
        const badNums = wrongKey.map(r => r.ticket_number);
        return res.status(403).json({
          error: 'One or more organisation tickets do not match any of the provided notebook keys.',
          code:  'INVALID_NOTEBOOK_KEY',
          tickets: badNums,
        });
      }
    }

    // ── Transaction: reserve tickets + create payment record ────────────────
    await db.query('BEGIN');

    // Lock the ticket rows to prevent concurrent double-reservation
    await db.query(
      `SELECT id FROM mobility_tickets
       WHERE ticket_number = ANY($1::int[])
       FOR UPDATE`,
      [uniqueNums]
    );

    // Re-check availability inside the transaction (race condition guard)
    const { rows: recheckRows } = await db.query(
      `SELECT ticket_number, status FROM mobility_tickets
       WHERE ticket_number = ANY($1::int[])`,
      [uniqueNums]
    );
    const stillUnavailable = recheckRows.filter(r => r.status !== 'available');
    if (stillUnavailable.length) {
      await db.query('ROLLBACK');
      return res.status(409).json({
        error:   'One or more tickets were just taken by another booking.',
        code:    'TICKETS_UNAVAILABLE',
        tickets: stillUnavailable.map(r => ({ number: r.ticket_number, status: r.status })),
      });
    }

    // Reserve all tickets
    await db.query(
      `UPDATE mobility_tickets
       SET status = 'reserved', trip_id = $1, reserved_at = NOW()
       WHERE ticket_number = ANY($2::int[])`,
      [trip_id, uniqueNums]
    );

    // Compute payment amounts
    const { rows: cfgRows } = await db.query(
      `SELECT key, value FROM configuration WHERE key = ANY($1)`,
      [['driver_share_percent']]
    );
    const driverPct    = parseFloat(cfgRows.find(r => r.key === 'driver_share_percent')?.value ?? 75) / 100;
    const totalAmount  = Math.round(uniqueNums.length * cfg.facialValue * 100) / 100;
    const driverShare  = Math.round(totalAmount * driverPct * 100) / 100;
    const platformFee  = Math.round(totalAmount * (1 - driverPct) * 100) / 100;

    // Create the mobility payment record — 'authorized' means tickets are reserved
    const { rows: payRows } = await db.query(
      `INSERT INTO payments
         (trip_id, provider, payment_method, amount, driver_share, platform_fee,
          currency, status)
       VALUES ($1, 'mobility', 'mobility', $2, $3, $4, $5, 'authorized')
       RETURNING id`,
      [trip_id, totalAmount, driverShare, platformFee, cfg.currency]
    );

    await db.query('COMMIT');

    logger.info('mobility_tickets: tickets reserved', {
      tripId:        trip_id,
      ticketNumbers: uniqueNums,
      paymentId:     payRows[0].id,
      totalAmount,
      currency:      cfg.currency,
    });

    res.status(201).json({
      payment_id:     payRows[0].id,
      ticket_numbers: uniqueNums,
      required_count: requiredCount,
      tickets_used:   uniqueNums.length,
      total_charged:  totalAmount,
      currency:       cfg.currency,
    });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    db.release();
  }
});

module.exports = router;
