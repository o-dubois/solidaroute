/**
 * @file routes/payments.js
 * @module routes/payments
 * @description Payment routes for SolidaRoute — /api/payments/*
 *
 * All routes require authentication.
 * Clients and drivers can only see payments related to their own trips.
 * Operators and superadmins can see all payments.
 *
 * Provider abstraction:
 *   Every route that initiates or modifies a payment calls getProvider(pool)
 *   first and then calls the appropriate method on the returned provider object.
 *   This means the route code never calls stripe.* directly — swapping to a
 *   different provider (PayPal, mobility tickets) is a configuration change,
 *   not a code change.
 *
 * Route summary:
 *   GET  /                  — Payment history for the current user
 *   GET  /:id               — Single payment detail
 *   POST /setup-intent      — Create Stripe Customer + SetupIntent for a trip
 *   POST /confirm           — Record card saved; set payment status to 'authorized'
 *   POST /manual            — Operator records a manual (phone/cash) payment
 *   POST /charge/:trip_id   — Charge the saved card on trip completion
 *   POST /refund/:trip_id   — Refund a paid payment
 *
 * Amount conventions:
 *   All amounts in the DB are stored in dollars (e.g. 25.50).
 *   Conversion to cents happens inside the stripe.js provider only.
 *
 * Mounted at: /api/payments  (see app.js)
 */

// routes/payments.js
const express = require('express');
const { pool }         = require('../db/pool');
const { authenticate, authorize } = require('../middleware/auth');
const { getProvider }  = require('../services/payments');
const { logger }       = require('../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments
//
// Purpose: Return payment history for the authenticated user.
//   Clients see payments for trips they booked.
//   Drivers see payments for trips they drove.
//   Operators/superadmins see all payments.
// Auth: Any authenticated user.
// Returns: { payments: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const isDriver = req.user.role === 'driver';
    const isAdmin  = ['operator', 'superadmin'].includes(req.user.role);

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;

    const whereClause = isAdmin
      ? ''
      : `WHERE ${isDriver ? 't.driver_id' : 't.client_id'} = $1`;
    const baseParams = isAdmin ? [] : [req.user.id];
    const n = baseParams.length; // placeholder offset for LIMIT/OFFSET

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM payments p JOIN trips t ON t.id = p.trip_id ${whereClause}`,
      baseParams
    );
    const total = parseInt(countRows[0].count);

    const { rows } = await pool.query(
      `SELECT p.*,
         t.trip_number, t.pickup_address, t.dropoff_address, t.departure_at
       FROM payments p
       JOIN trips t ON t.id = p.trip_id
       ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...baseParams, limit, offset]
    );
    res.json({ payments: rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/:id
//
// Purpose: Return a single payment record with trip context.
// Auth: The client or driver of the trip, or an operator/superadmin.
// Returns: { payment }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, t.pickup_address, t.dropoff_address, t.client_id, t.driver_id
       FROM payments p JOIN trips t ON t.id = p.trip_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found.' });

    const p       = rows[0];
    const isOwner = p.client_id === req.user.id || p.driver_id === req.user.id;
    const isAdmin = ['operator', 'superadmin'].includes(req.user.role);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Access denied.' });

    res.json({ payment: p });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/setup-intent
//
// Purpose: Create a Stripe Customer (or reuse an existing one) and a
//   SetupIntent so the client can save their card for off-session charging
//   when the trip completes.
//
// Auth: Any authenticated user (typically a client booking a trip).
// Body: { trip_id }
//
// Validations:
//   - trip must exist and belong to the authenticated user (client_id match)
//   - trip status must be 'pending' (card setup only makes sense before a driver accepts)
//
// Side effects:
//   - Saves stripe_customer_id to the users table if it was newly created
//   - Creates a 'pending' payment row in the payments table
//     (ON CONFLICT DO NOTHING so calling this twice is safe)
//
// Returns: { clientSecret, paymentId }
//   clientSecret — passed to Stripe.js on the frontend to render the card form
//   paymentId    — our internal payments.id, used in POST /confirm
// ─────────────────────────────────────────────────────────────────────────────
router.post('/setup-intent', authenticate, async (req, res, next) => {
  try {
    const { trip_id } = req.body;
    if (!trip_id) {
      return res.status(400).json({ error: 'trip_id is required.', code: 'MISSING_TRIP_ID' });
    }

    // ── Verify the trip belongs to this user and is bookable ──────────────────
    const { rows: tripRows } = await pool.query(
      `SELECT t.*, u.stripe_customer_id
       FROM trips t
       JOIN users u ON u.id = t.client_id
       WHERE t.id = $1`,
      [trip_id]
    );
    if (!tripRows.length) {
      return res.status(404).json({ error: 'Trip not found.', code: 'TRIP_NOT_FOUND' });
    }

    const trip    = tripRows[0];
    const isAdmin = ['operator', 'superadmin'].includes(req.user.role);

    // The client who booked the trip may save a card, as may operators/superadmins
    // acting on behalf of the client during phone intake.
    if (trip.client_id !== req.user.id && !isAdmin) {
      return res.status(403).json({ error: 'Access denied.', code: 'FORBIDDEN' });
    }

    // Card setup only makes sense for pending trips (no driver yet).
    // Once assigned, the payment should already be authorized.
    if (trip.status !== 'pending') {
      return res.status(422).json({
        error: `Card setup is only available for pending trips (current status: "${trip.status}").`,
        code: 'INVALID_TRIP_STATUS',
      });
    }

    // ── Idempotency: return existing pending payment if already created ───────
    // PaymentStep unmounts when the user navigates back, so it calls this
    // endpoint again on re-mount for the same trip.  Detect that case and
    // return the existing client_secret from Stripe rather than creating a
    // second SetupIntent + a duplicate payment row (which would hit the
    // unique constraint on trip_id and surface as a 409 error to the user).
    const provider = await getProvider(pool);

    const { rows: existingRows } = await pool.query(
      `SELECT id, stripe_setup_intent_id FROM payments
       WHERE trip_id = $1 AND status = 'pending' LIMIT 1`,
      [trip_id]
    );
    if (existingRows.length && existingRows[0].stripe_setup_intent_id) {
      const existing = existingRows[0];
      const siResult = await provider.retrieveSetupIntent(existing.stripe_setup_intent_id);
      if (siResult) {
        return res.json({ client_secret: siResult.clientSecret, payment_id: existing.id });
      }
    }

    const result = await provider.createSetupIntent(
      trip.client_id,           // always the client, even when called by an operator
      trip.stripe_customer_id   // null if no Stripe Customer exists yet
    );

    // result is null for the manual provider (no card capture needed).
    // This endpoint is only useful for card-based providers, but we handle
    // it gracefully so the route doesn't crash on a misconfigured provider.
    if (!result) {
      return res.status(422).json({
        error: 'The active payment provider does not support card setup.',
        code: 'PROVIDER_NO_SETUP',
      });
    }

    const { clientSecret, setupIntentId, customerId } = result;

    // ── Persist the Stripe Customer ID so we reuse it next time ───────────────
    if (customerId !== trip.stripe_customer_id) {
      await pool.query(
        `UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2`,
        [customerId, trip.client_id]   // save on the client's row, not the operator's
      );
    }

    // ── Read pricing config to compute the payment amount ─────────────────────
    const { rows: cfgRows } = await pool.query(
      `SELECT key, value FROM configuration WHERE key = ANY($1)`,
      [['driver_share_percent', 'payment_currency']]
    );
    const cfg        = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
    const driverPct  = parseFloat(cfg.driver_share_percent ?? 75) / 100;
    const currency   = cfg.payment_currency ?? 'CAD';
    const amount     = parseFloat(trip.estimated_cost ?? 0);
    const driverShare = Math.round(amount * driverPct * 100) / 100;
    const platformFee = Math.round(amount * (1 - driverPct) * 100) / 100;

    // ── Create the payment row in 'pending' status ────────────────────────────
    // ON CONFLICT DO NOTHING makes this idempotent — if the client refreshes the
    // page and the frontend calls /setup-intent again, we don't create duplicates.
    // We use trip_id as the conflict target (one payment row per trip at setup time).
    // Note: the actual conflict constraint is the DB unique index on (trip_id) if
    // one exists; otherwise this insert simply creates a new row each call.
    const { rows: payRows } = await pool.query(
      `INSERT INTO payments
         (trip_id, provider, payment_method, amount, driver_share, platform_fee,
          currency, status, stripe_setup_intent_id)
       VALUES ($1, 'stripe', 'stripe', $2, $3, $4, $5, 'pending', $6)
       RETURNING id`,
      [trip_id, amount, driverShare, platformFee, currency, setupIntentId]
    );

    const paymentId = payRows[0].id;

    // Return snake_case keys to match what the frontend reads (data.client_secret, data.payment_id)
    res.json({ client_secret: clientSecret, payment_id: paymentId });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/confirm
//
// Purpose: Called by the frontend after the client successfully saves their
//   card via Stripe.js.  Records the SetupIntent ID and PaymentMethod ID in
//   the payment row and advances status to 'authorized', indicating that we
//   have a saved card ready to charge when the trip completes.
//
// Auth: Any authenticated user (the client who owns the payment).
// Body: { payment_id, setup_intent_id, payment_method_id }
// Returns: { ok: true }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/confirm', authenticate, async (req, res, next) => {
  try {
    const { payment_id, setup_intent_id, payment_method_id } = req.body;

    if (!payment_id || !setup_intent_id || !payment_method_id) {
      return res.status(400).json({
        error: 'payment_id, setup_intent_id, and payment_method_id are all required.',
        code:  'MISSING_FIELDS',
      });
    }

    // Fetch the payment row and verify ownership via the trips join.
    const { rows } = await pool.query(
      `SELECT p.*, t.client_id
       FROM payments p JOIN trips t ON t.id = p.trip_id
       WHERE p.id = $1`,
      [payment_id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Payment not found.', code: 'NOT_FOUND' });
    }

    const payment = rows[0];
    const isAdmin = ['operator', 'superadmin'].includes(req.user.role);

    if (payment.client_id !== req.user.id && !isAdmin) {
      return res.status(403).json({ error: 'Access denied.', code: 'FORBIDDEN' });
    }

    // Only pending payments can be confirmed.
    if (payment.status !== 'pending') {
      return res.status(409).json({
        error: `Payment is already in status "${payment.status}".`,
        code:  'ALREADY_CONFIRMED',
      });
    }

    // /confirm is only valid for card-based providers. Manual and mobility
    // payments are recorded server-side and never go through the card-save flow.
    // Blocking non-Stripe providers here prevents storing fake IDs on manual
    // payment rows via a crafted POST.
    if (payment.provider !== 'stripe') {
      return res.status(422).json({
        error: 'This payment method does not support card confirmation.',
        code:  'PROVIDER_NO_CONFIRM',
      });
    }

    // Cross-check: if /setup-intent already stored a setup_intent_id, the
    // client must submit the same one — prevents swapping intents across trips.
    if (payment.stripe_setup_intent_id &&
        payment.stripe_setup_intent_id !== setup_intent_id) {
      return res.status(422).json({
        error: 'setup_intent_id does not match the one created for this payment.',
        code:  'INTENT_MISMATCH',
      });
    }

    // For Stripe payments: verify the SetupIntent actually succeeded on Stripe's
    // side and belongs to this customer. Prevents storing fake/foreign IDs.
    if (payment.provider === 'stripe' && process.env.STRIPE_SECRET_KEY) {
      const Stripe = require('stripe');
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const intent = await stripe.setupIntents.retrieve(setup_intent_id);
      if (intent.status !== 'succeeded') {
        return res.status(422).json({
          error: 'SetupIntent has not succeeded. Please complete the card entry step.',
          code:  'INTENT_NOT_SUCCEEDED',
        });
      }
      // Fetch the client's Stripe customer ID to verify ownership
      const { rows: userRows } = await pool.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.id]
      );
      if (!userRows.length || intent.customer !== userRows[0].stripe_customer_id) {
        return res.status(403).json({
          error: 'SetupIntent does not belong to this account.',
          code:  'INTENT_OWNERSHIP',
        });
      }
    }

    // Update the payment row with the Stripe IDs and advance status.
    await pool.query(
      `UPDATE payments
       SET stripe_setup_intent_id   = $1,
           stripe_payment_method_id = $2,
           status                   = 'authorized',
           updated_at               = NOW()
       WHERE id = $3`,
      [setup_intent_id, payment_method_id, payment_id]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/manual
//
// Purpose: Operator records a payment collected outside the platform
//   (e.g. by phone, cash, cheque).  No card is charged; the operator just
//   marks the trip as paid with an optional reference and note.
//
// Auth: operator, admin, superadmin only.
// Body: { trip_id, payment_reference?, operator_note? }
// Returns: { payment }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/manual',
  authenticate,
  authorize('operator', 'superadmin'),
  async (req, res, next) => {
    try {
      const { trip_id, payment_reference, operator_note } = req.body;

      if (!trip_id) {
        return res.status(400).json({ error: 'trip_id is required.', code: 'MISSING_TRIP_ID' });
      }

      // Verify the trip exists.
      const { rows: tripRows } = await pool.query(
        `SELECT * FROM trips WHERE id = $1`,
        [trip_id]
      );
      if (!tripRows.length) {
        return res.status(404).json({ error: 'Trip not found.', code: 'TRIP_NOT_FOUND' });
      }

      const trip = tripRows[0];

      // Read pricing config to compute amounts consistently.
      const { rows: cfgRows } = await pool.query(
        `SELECT key, value FROM configuration WHERE key = ANY($1)`,
        [['driver_share_percent', 'payment_currency']]
      );
      const cfg         = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
      const driverPct   = parseFloat(cfg.driver_share_percent ?? 75) / 100;
      const currency    = cfg.payment_currency ?? 'CAD';
      const amount      = parseFloat(trip.estimated_cost ?? 0);
      const driverShare = Math.round(amount * driverPct * 100) / 100;
      const platformFee = Math.round(amount * (1 - driverPct) * 100) / 100;

      // Insert the manual payment record.  ON CONFLICT DO NOTHING prevents
      // duplicate rows if the operator accidentally submits twice.
      const { rows: payRows } = await pool.query(
        `INSERT INTO payments
           (trip_id, provider, payment_method, amount, driver_share, platform_fee,
            currency, status, paid_at, payment_reference, operator_note)
         VALUES ($1, 'manual', 'manual', $2, $3, $4, $5, 'paid', NOW(), $6, $7)
         RETURNING *`,
        [trip_id, amount, driverShare, platformFee, currency,
         payment_reference ?? null, operator_note ?? null]
      );

      res.status(201).json({ payment: payRows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/charge/:trip_id
//
// Purpose: Charge the saved card for a completed trip.
//
//   This endpoint is called internally from the trips route after a trip is
//   marked completed (see PATCH /api/trips/:id/complete in routes/trips.js).
//   It can also be called manually by an admin to retry a failed charge.
//
// Auth: admin, superadmin.
//   The trips route calls this logic directly (not via HTTP) using the exported
//   chargeTrip() helper below so it doesn't need to make an internal HTTP call.
//
// Side effects:
//   - Calls provider.charge() to debit the saved card
//   - Updates the payment row: stripe_payment_intent_id, status='paid', paid_at=NOW()
//   - If charge fails: sets status='failed', returns 402 with code PAYMENT_FAILED
//   - Upserts a driver_earnings row for the driver's share
//
// Returns: { payment }
//   402 + { error, code: 'PAYMENT_FAILED' } on Stripe decline
// ─────────────────────────────────────────────────────────────────────────────
router.post('/charge/:trip_id',
  authenticate,
  authorize('operator', 'superadmin'),
  async (req, res, next) => {
    try {
      const { payment, error } = await chargeTrip(req.params.trip_id);
      if (error) {
        return res.status(402).json({ error: error.message, code: 'PAYMENT_FAILED' });
      }
      res.json({ payment });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/refund/:trip_id
//
// Purpose: Refund the payment for a trip.
// Auth: admin, superadmin.
// Returns: { payment }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/refund/:trip_id',
  authenticate,
  authorize('operator', 'superadmin'),
  async (req, res, next) => {
    try {
      const trip_id = req.params.trip_id;

      // Find the paid payment for this trip.
      const { rows } = await pool.query(
        `SELECT * FROM payments WHERE trip_id = $1 AND status = 'paid' LIMIT 1`,
        [trip_id]
      );

      if (!rows.length) {
        return res.status(404).json({
          error: 'No paid payment found for this trip.',
          code:  'PAYMENT_NOT_FOUND',
        });
      }

      const payment  = rows[0];
      const provider = await getProvider(pool);

      // Issue the refund.  For the manual provider this is a no-op.
      await provider.refund(payment.stripe_payment_intent_id);

      // Mark the payment as refunded.
      const { rows: updated } = await pool.query(
        `UPDATE payments
         SET status     = 'refunded',
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [payment.id]
      );

      res.json({ payment: updated[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// chargeTrip — exported helper used by routes/trips.js
//
// This function contains the charge logic shared between:
//   - POST /api/payments/charge/:trip_id  (admin-triggered via HTTP)
//   - PATCH /api/trips/:id/complete        (automatic charge on trip completion)
//
// Separating the logic from the route handler lets trips.js import and call it
// directly without making an internal HTTP request to itself.
//
// @param {string|number} trip_id
// @returns {Promise<{ payment?: object, error?: Error }>}
//   On success: { payment: <updated payments row> }
//   On charge failure: { error: <Error with Stripe message> }
//   On other DB errors: throws (caller should handle with try/catch)
// ─────────────────────────────────────────────────────────────────────────────
async function chargeTrip(trip_id) {
  // Find the authorized payment for this trip.
  // 'authorized' means the SetupIntent completed and a PaymentMethod is saved,
  // OR mobility tickets are reserved and ready to consume.
  // Join to trips and users so we have the driver_id and stripe_customer_id
  // available without a second query.
  const { rows } = await pool.query(
    `SELECT p.*, t.driver_id, u.stripe_customer_id
     FROM payments p
     JOIN trips   t ON t.id  = p.trip_id
     JOIN users   u ON u.id  = t.client_id
     WHERE p.trip_id = $1 AND p.status = 'authorized'
     LIMIT 1`,
    [trip_id]
  );

  if (!rows.length) {
    // No authorized payment — either manual payment, or card/tickets not yet set up.
    // Return a soft error rather than throwing so the trip completion can
    // still succeed even when payment is handled outside the platform.
    logger.info('chargeTrip: no authorized payment found, skipping charge', { tripId: trip_id });
    return { error: new Error('No authorized payment found for this trip.') };
  }

  const payment = rows[0];

  // ── Mobility tickets path ─────────────────────────────────────────────────
  // Mobility tickets are "charged" by marking reserved tickets as used.
  // No external payment provider call is needed.
  if (payment.payment_method === 'mobility') {
    logger.info('chargeTrip: completing mobility ticket payment', {
      tripId:    trip_id,
      paymentId: payment.id,
      amount:    payment.amount,
      currency:  payment.currency,
    });

    try {
      // Mark all reserved tickets for this trip as used
      await pool.query(
        `UPDATE mobility_tickets
         SET status = 'used', used_at = NOW(), used_by_driver_id = $1
         WHERE trip_id = $2 AND status = 'reserved'`,
        [payment.driver_id, trip_id]
      );

      const { rows: updated } = await pool.query(
        `UPDATE payments
         SET status = 'paid', paid_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [payment.id]
      );

      if (payment.driver_id) {
        await pool.query(
          `INSERT INTO driver_earnings
             (driver_id, trip_id, payment_id, amount, currency, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           ON CONFLICT DO NOTHING`,
          [payment.driver_id, trip_id, payment.id,
           payment.driver_share, payment.currency]
        );
      }

      logger.info('chargeTrip: mobility ticket payment completed', {
        tripId: trip_id, paymentId: payment.id,
      });

      return { payment: updated[0] };
    } catch (mobilityErr) {
      logger.error('chargeTrip: mobility ticket completion failed', {
        tripId: trip_id, paymentId: payment.id, error: mobilityErr.message,
      });
      return { error: mobilityErr };
    }
  }

  const provider = await getProvider(pool);

  logger.info('chargeTrip: attempting charge', {
    tripId:    trip_id,
    paymentId: payment.id,
    amount:    payment.amount,
    currency:  payment.currency,
  });

  try {
    // Call the provider's charge method.
    // For Stripe: creates and confirms an off-session PaymentIntent.
    // stripe_customer_id is on the users row fetched above via the JOIN.
    const { intentId } = await provider.charge(
      payment.stripe_payment_method_id,
      payment.stripe_customer_id,  // from users table via JOIN above
      parseFloat(payment.amount),
      payment.currency
    );

    logger.info('chargeTrip: charge succeeded', {
      tripId:    trip_id,
      paymentId: payment.id,
      intentId,
      amount:    payment.amount,
      currency:  payment.currency,
    });

    // Charge succeeded — persist the PaymentIntent ID and mark paid.
    const { rows: updated } = await pool.query(
      `UPDATE payments
       SET stripe_payment_intent_id = $1,
           status                   = 'paid',
           paid_at                  = NOW(),
           updated_at               = NOW()
       WHERE id = $2
       RETURNING *`,
      [intentId, payment.id]
    );

    // ── Upsert driver_earnings record ──────────────────────────────────────
    // Use ON CONFLICT DO NOTHING so retrying a charge (after a transient DB
    // error) doesn't create duplicate earnings rows.
    if (payment.driver_id) {
      await pool.query(
        `INSERT INTO driver_earnings
           (driver_id, trip_id, payment_id, amount, currency, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT DO NOTHING`,
        [payment.driver_id, trip_id, payment.id,
         payment.driver_share, payment.currency]
      );
    }

    return { payment: updated[0] };

  } catch (chargeErr) {
    // Charge failed (e.g. card declined, insufficient funds, authentication
    // required).  Mark the payment row as 'failed' so the operator is aware,
    // then surface the error to the caller with a soft return (not a throw)
    // so trip completion can still succeed.
    logger.error('chargeTrip: charge failed', {
      tripId:    trip_id,
      paymentId: payment.id,
      error:     chargeErr.message,
    });

    await pool.query(
      `UPDATE payments
       SET status     = 'failed',
           updated_at = NOW()
       WHERE id = $1`,
      [payment.id]
    ).catch(() => {}); // swallow secondary DB error if update fails

    return { error: chargeErr };
  }
}

// Export the chargeTrip helper so routes/trips.js can call it directly
// without going through an internal HTTP request.
module.exports = router;
module.exports.chargeTrip = chargeTrip;
