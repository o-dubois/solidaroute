/**
 * @file tests/payments.test.js
 * @description Integration tests for the /api/payments routes.
 *
 * Covers:
 *   GET  /api/payments               — payment history (role-scoped)
 *   GET  /api/payments/:id           — single payment detail
 *   POST /api/payments/setup-intent  — create Stripe SetupIntent for a trip
 *   POST /api/payments/confirm       — record saved card, advance to 'authorized'
 *   POST /api/payments/manual        — operator records a manual payment
 *   POST /api/payments/charge/:id    — admin charges the saved card
 *   POST /api/payments/refund/:id    — admin refunds a paid payment
 *
 * The `../src/services/payments` module is mocked so no real Stripe calls
 * are made.  The mock provider implements createSetupIntent, charge, and refund.
 *
 * Email service is also mocked to silence SMTP noise.
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                                                   = require('../src/db/pool');
const { resetDb, createClient, createDriver,
        createOperator, getSuperadminToken, createTrip }         = require('./setup/testDb');

jest.mock('../src/services/email');

// ── Mock payment provider ──────────────────────────────────────────────────
// getProvider() is called by every route that initiates or modifies a payment.
// The mock returns an in-memory provider so tests never call Stripe.
jest.mock('../src/services/payments', () => ({
  getProvider: jest.fn().mockResolvedValue({
    createSetupIntent: jest.fn().mockResolvedValue({
      clientSecret:   'seti_test_client_secret',
      setupIntentId:  'seti_test_123',
      customerId:     'cus_test_123',
    }),
    charge: jest.fn().mockResolvedValue({
      intentId: 'pi_test_123',
      status:   'succeeded',
    }),
    refund: jest.fn().mockResolvedValue({ id: 'ref_test_123' }),
  }),
}));

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Insert a payment row directly in the DB and return it. */
async function seedPayment(trip_id, status = 'pending', extras = {}) {
  const { rows } = await pool.query(`
    INSERT INTO payments
      (trip_id, provider, payment_method, amount, driver_share, platform_fee,
       currency, status,
       stripe_setup_intent_id, stripe_payment_method_id, stripe_payment_intent_id)
    VALUES ($1, 'stripe', 'stripe', 25.50, 19.13, 6.37, 'CAD', $2, $3, $4, $5)
    RETURNING *
  `, [
    trip_id,
    status,
    extras.setup_intent_id  || null,
    extras.payment_method_id || null,
    extras.payment_intent_id || null,
  ]);
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/payments', () => {
  test('200 — client sees empty payment list when no payments exist', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.payments)).toBe(true);
    expect(res.body.payments).toHaveLength(0);
  });

  test('200 — client sees only their own payments', async () => {
    const { user: client, token }  = await createClient({ email: 'client@test.com' });
    const { user: other }          = await createClient({ email: 'other@test.com' });
    const { user: driver }         = await createDriver({ email: 'driver@test.com' });

    const tripMine  = await createTrip({ client_id: client.id, driver_id: driver.id });
    const tripOther = await createTrip({ client_id: other.id,  driver_id: driver.id });

    await seedPayment(tripMine.id);
    await seedPayment(tripOther.id);

    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
  });

  test('200 — operator sees all payments', async () => {
    const { user: client }  = await createClient({ email: 'client@test.com' });
    const { user: driver }  = await createDriver({ email: 'driver@test.com' });
    const { token }         = await createOperator({ email: 'operator@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id });
    await seedPayment(trip.id);

    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.payments.length).toBeGreaterThanOrEqual(1);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/payments');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/:id
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/payments/:id', () => {
  test('200 — client retrieves their own payment', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const { user: driver }        = await createDriver({ email: 'driver@test.com' });
    const trip    = await createTrip({ client_id: client.id, driver_id: driver.id });
    const payment = await seedPayment(trip.id);

    const res = await request(app)
      .get(`/api/payments/${payment.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('payment');
    expect(res.body.payment.id).toBe(payment.id);
  });

  test('403 — a different client cannot view someone else\'s payment', async () => {
    const { user: client }         = await createClient({ email: 'client@test.com' });
    const { token: otherToken }    = await createClient({ email: 'other@test.com' });
    const { user: driver }         = await createDriver({ email: 'driver@test.com' });
    const trip    = await createTrip({ client_id: client.id, driver_id: driver.id });
    const payment = await seedPayment(trip.id);

    const res = await request(app)
      .get(`/api/payments/${payment.id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  test('404 — non-existent payment returns 404', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const fakeId    = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .get(`/api/payments/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .get('/api/payments/00000000-0000-0000-0000-000000000099');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/setup-intent
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/payments/setup-intent', () => {
  test('200 — client creates a setup intent for their pending trip', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: client.id, status: 'pending' });

    const res = await request(app)
      .post('/api/payments/setup-intent')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('client_secret');
    expect(res.body).toHaveProperty('payment_id');
  });

  test('422 — trip must be in pending status', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const { user: driver }        = await createDriver({ email: 'driver@test.com' });
    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    const res = await request(app)
      .post('/api/payments/setup-intent')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_TRIP_STATUS');
  });

  test('403 — a different client cannot set up payment for someone else\'s trip', async () => {
    const { user: client }  = await createClient({ email: 'client@test.com' });
    const { token: other }  = await createClient({ email: 'other@test.com' });
    const trip = await createTrip({ client_id: client.id, status: 'pending' });

    const res = await request(app)
      .post('/api/payments/setup-intent')
      .set('Authorization', `Bearer ${other}`)
      .send({ trip_id: trip.id });

    expect(res.status).toBe(403);
  });

  test('404 — non-existent trip returns 404', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const fakeId    = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .post('/api/payments/setup-intent')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: fakeId });

    expect(res.status).toBe(404);
  });

  test('400 — missing trip_id returns 400', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/payments/setup-intent')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_TRIP_ID');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/confirm
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/payments/confirm', () => {
  test('200 — client confirms a pending payment to advance it to authorized', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const trip    = await createTrip({ client_id: client.id, status: 'pending' });
    const payment = await seedPayment(trip.id, 'pending', {
      setup_intent_id: 'seti_original',
    });

    const res = await request(app)
      .post('/api/payments/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({
        payment_id:         payment.id,
        setup_intent_id:    'seti_confirmed',
        payment_method_id:  'pm_test_123',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify DB state
    const { rows } = await pool.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
    expect(rows[0].status).toBe('authorized');
  });

  test('409 — confirming an already-authorized payment returns 409', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const trip    = await createTrip({ client_id: client.id, status: 'pending' });
    const payment = await seedPayment(trip.id, 'authorized', {
      setup_intent_id:   'seti_done',
      payment_method_id: 'pm_done',
    });

    const res = await request(app)
      .post('/api/payments/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({
        payment_id:         payment.id,
        setup_intent_id:    'seti_done',
        payment_method_id:  'pm_done',
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_CONFIRMED');
  });

  test('400 — missing required fields returns 400', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/payments/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ payment_id: '00000000-0000-0000-0000-000000000001' }); // missing two fields

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .post('/api/payments/confirm')
      .send({ payment_id: 'x', setup_intent_id: 'y', payment_method_id: 'z' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/manual
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/payments/manual', () => {
  test('201 — operator records a manual payment for an existing trip', async () => {
    const { user: client }  = await createClient({ email: 'client@test.com' });
    const trip  = await createTrip({ client_id: client.id });
    const { token } = await createOperator({ email: 'operator@test.com' });

    const res = await request(app)
      .post('/api/payments/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({
        trip_id:            trip.id,
        payment_reference:  'CHQ-1234',
        operator_note:      'Cheque received',
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('payment');
    expect(res.body.payment.status).toBe('paid');
    expect(res.body.payment.payment_method).toBe('manual');
  });

  test('403 — client cannot record a manual payment', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: client.id });

    const res = await request(app)
      .post('/api/payments/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id });

    expect(res.status).toBe(403);
  });

  test('400 — missing trip_id returns 400', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });

    const res = await request(app)
      .post('/api/payments/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_TRIP_ID');
  });

  test('404 — non-existent trip returns 404', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const fakeId    = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .post('/api/payments/manual')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: fakeId });

    expect(res.status).toBe(404);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .post('/api/payments/manual')
      .send({ trip_id: '00000000-0000-0000-0000-000000000001' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/charge/:trip_id
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/payments/charge/:trip_id', () => {
  test('200 — superadmin charges an authorized payment', async () => {
    const { user: client }  = await createClient({ email: 'client@test.com' });
    const { user: driver }  = await createDriver({ email: 'driver@test.com' });
    const trip    = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'completed' });
    await seedPayment(trip.id, 'authorized', {
      setup_intent_id:   'seti_done',
      payment_method_id: 'pm_test_123',
    });
    const token = await getSuperadminToken();

    const res = await request(app)
      .post(`/api/payments/charge/${trip.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('payment');
    expect(res.body.payment.status).toBe('paid');
  });

  test('403 — client cannot trigger a charge', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: client.id });

    const res = await request(app)
      .post(`/api/payments/charge/${trip.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .post('/api/payments/charge/00000000-0000-0000-0000-000000000001');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/refund/:trip_id
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/payments/refund/:trip_id', () => {
  test('200 — superadmin refunds a paid payment', async () => {
    const { user: client } = await createClient({ email: 'client@test.com' });
    const trip    = await createTrip({ client_id: client.id });
    await seedPayment(trip.id, 'paid', {
      payment_intent_id: 'pi_test_paid',
    });
    const token = await getSuperadminToken();

    const res = await request(app)
      .post(`/api/payments/refund/${trip.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('payment');
    expect(res.body.payment.status).toBe('refunded');
  });

  test('404 — no paid payment for the trip returns 404', async () => {
    const { user: client } = await createClient({ email: 'client@test.com' });
    const trip  = await createTrip({ client_id: client.id });
    const token = await getSuperadminToken();

    const res = await request(app)
      .post(`/api/payments/refund/${trip.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PAYMENT_NOT_FOUND');
  });

  test('403 — client cannot trigger a refund', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: client.id });

    const res = await request(app)
      .post(`/api/payments/refund/${trip.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .post('/api/payments/refund/00000000-0000-0000-0000-000000000001');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/complete — deferred payment behaviour
//
// These tests verify that the card_charge_delay_days configuration key controls
// whether the saved card is charged immediately at trip completion (delay = 0)
// or deferred to the safeguard job (delay > 0).
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/trips/:id/complete — deferred payment', () => {
  /** Create an assigned trip with a past departure so the driver can complete it. */
  async function setupAssignedTrip() {
    const { user: client }        = await createClient({ email: 'client@test.com' });
    const { user: driver, token } = await createDriver({ email: 'driver@test.com' });
    const pastDeparture = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const trip = await createTrip({
      client_id:    client.id,
      driver_id:    driver.id,
      status:       'assigned',
      departure_at: pastDeparture,
    });
    return { trip, token };
  }

  test('200 — card charged immediately when card_charge_delay_days = 0', async () => {
    const { trip, token } = await setupAssignedTrip();

    // Seed an authorized payment (card saved, not yet charged)
    await seedPayment(trip.id, 'authorized', {
      setup_intent_id:   'seti_done',
      payment_method_id: 'pm_test_123',
    });

    // Configure immediate charging
    await pool.query(
      `INSERT INTO configuration (key, value)
       VALUES ('card_charge_delay_days', '0')
       ON CONFLICT (key) DO UPDATE SET value = '0'`
    );

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/complete`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);

    // Payment should have been charged right away
    const { rows } = await pool.query(
      `SELECT status FROM payments WHERE trip_id = $1 AND payment_method = 'stripe'`,
      [trip.id]
    );
    expect(rows[0].status).toBe('paid');
  });

  test('200 — payment stays authorized when card_charge_delay_days > 0', async () => {
    const { trip, token } = await setupAssignedTrip();

    // Seed an authorized payment (card saved, not yet charged)
    await seedPayment(trip.id, 'authorized', {
      setup_intent_id:   'seti_done',
      payment_method_id: 'pm_test_123',
    });

    // Configure deferred charging (7-day window)
    await pool.query(
      `INSERT INTO configuration (key, value)
       VALUES ('card_charge_delay_days', '7')
       ON CONFLICT (key) DO UPDATE SET value = '7'`
    );

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/complete`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);

    // Payment must remain authorized — safeguard will charge it after the delay
    const { rows } = await pool.query(
      `SELECT status FROM payments WHERE trip_id = $1 AND payment_method = 'stripe'`,
      [trip.id]
    );
    expect(rows[0].status).toBe('authorized');
  });
});
