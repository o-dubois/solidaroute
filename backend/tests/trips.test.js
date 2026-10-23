/**
 * @file tests/trips.test.js
 * @description Integration tests for /api/trips/*
 *
 * Covers:
 *   POST  /api/trips/estimate       — geocode + OSRM route + fare preview
 *   POST  /api/trips                — create a trip (booking)
 *   GET   /api/trips/:id            — trip detail
 *   PATCH /api/trips/:id/accept     — driver claims a pending trip
 *   PATCH /api/trips/:id/decline    — driver declines
 *   PATCH /api/trips/:id/complete   — driver/operator marks trip done
 *   PATCH /api/trips/:id/cancel     — client/admin cancels
 *   GET   /api/trips/action         — token-based email accept/decline
 *   GET   /api/trips/available      — pending trips visible to a driver
 *
 * OSRM is called live (not mocked) — the server must have OSRM running on
 * localhost:5001 for estimate and address-search tests.
 *
 * Email is mocked — no real SMTP traffic.
 *
 * Trips used in accept/complete/cancel tests are inserted directly via
 * createTrip() to avoid coupling those tests to the booking endpoint.
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                                                       = require('../src/db/pool');
const { resetDb, createClient, createDriver, createTrip, getSuperadminToken } = require('./setup/testDb');

jest.mock('../src/services/email');

// Departure 72 h from now — safely past the default min_trip_lead_hours (48 h)
const FUTURE_DEPARTURE = () => new Date(Date.now() + 72 * 3600 * 1000).toISOString();

// Real Longueuil → Montreal addresses; OSRM and Nominatim should resolve these
const PICKUP_ADDRESS  = '3120 Boulevard Taschereau, Greenfield Park, Longueuil, QC, Canada';
const DROPOFF_ADDRESS = '1000 Rue Saint-Denis, Montréal, QC, Canada';

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────
// POST /api/trips/estimate  (OSRM live)
// ─────────────────────────────────────────────────────────────
describe('POST /api/trips/estimate', () => {
  test('200 — returns distance, duration, cost and geocoded coordinates', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/trips/estimate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pickup_address:  PICKUP_ADDRESS,
        dropoff_address: DROPOFF_ADDRESS,
        passenger_count: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('distance_km');
    expect(res.body).toHaveProperty('duration_minutes');
    expect(res.body).toHaveProperty('estimated_cost');
    expect(res.body).toHaveProperty('currency');
    expect(res.body.pickup).toHaveProperty('lat');
    expect(res.body.pickup).toHaveProperty('lon');
    expect(res.body.dropoff).toHaveProperty('lat');
    expect(res.body.dropoff).toHaveProperty('lon');
    expect(res.body.distance_km).toBeGreaterThan(0);
    expect(res.body.estimated_cost).toBeGreaterThan(0);
  });

  test('200 — doubles distance and cost for a round trip', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const [oneWay, roundTrip] = await Promise.all([
      request(app)
        .post('/api/trips/estimate')
        .set('Authorization', `Bearer ${token}`)
        .send({ pickup_address: PICKUP_ADDRESS, dropoff_address: DROPOFF_ADDRESS }),
      request(app)
        .post('/api/trips/estimate')
        .set('Authorization', `Bearer ${token}`)
        .send({ pickup_address: PICKUP_ADDRESS, dropoff_address: DROPOFF_ADDRESS, has_return: true }),
    ]);

    expect(roundTrip.status).toBe(200);
    // Round-trip distance should be approximately double the one-way distance
    expect(roundTrip.body.distance_km).toBeCloseTo(oneWay.body.distance_km * 2, 0);
  });

  test('422 — rejects missing addresses', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/trips/estimate')
      .set('Authorization', `Bearer ${token}`)
      .send({ pickup_address: PICKUP_ADDRESS }); // missing dropoff

    expect(res.status).toBe(422);
  });

  test('401 — rejects unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/trips/estimate')
      .send({ pickup_address: PICKUP_ADDRESS, dropoff_address: DROPOFF_ADDRESS });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/trips  (booking)
// ─────────────────────────────────────────────────────────────
describe('POST /api/trips', () => {
  // Helper: call /estimate first and return coords ready for /trips body
  async function getEstimate(token) {
    const res = await request(app)
      .post('/api/trips/estimate')
      .set('Authorization', `Bearer ${token}`)
      .send({ pickup_address: PICKUP_ADDRESS, dropoff_address: DROPOFF_ADDRESS });
    expect(res.status).toBe(200);
    return res.body;
  }

  test('201 — client creates a trip using estimate coordinates', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const est = await getEstimate(token);

    const res = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pickup_address:  PICKUP_ADDRESS,
        dropoff_address: DROPOFF_ADDRESS,
        departure_at:    FUTURE_DEPARTURE(),
        passenger_count: 1,
        pickup_lat:      est.pickup.lat,
        pickup_lon:      est.pickup.lon,
        dropoff_lat:     est.dropoff.lat,
        dropoff_lon:     est.dropoff.lon,
        distance_km:     est.distance_km,
        duration_minutes: est.duration_minutes,
        estimated_cost:  est.estimated_cost,
      });

    expect(res.status).toBe(201);
    expect(res.body.trip).toHaveProperty('id');
    expect(res.body.trip).toHaveProperty('trip_number');
    expect(res.body.trip.status).toBe('pending');
  });

  test('422 — rejects missing coordinates', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pickup_address:  PICKUP_ADDRESS,
        dropoff_address: DROPOFF_ADDRESS,
        departure_at:    FUTURE_DEPARTURE(),
        // pickup_lat / pickup_lon / dropoff_lat / dropoff_lon intentionally omitted
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MISSING_COORDINATES');
  });

  test('422 — rejects a departure time that violates min_trip_lead_hours', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    // departure_at only 1 hour from now — below 48 h minimum
    const tooSoon = new Date(Date.now() + 1 * 3600 * 1000).toISOString();

    const res = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pickup_address:  PICKUP_ADDRESS,
        dropoff_address: DROPOFF_ADDRESS,
        departure_at:    tooSoon,
        pickup_lat:  45.4654, pickup_lon: -73.4684,
        dropoff_lat: 45.5188, dropoff_lon: -73.5636,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_LEAD_TIME');
  });

  test('401 — rejects unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/trips')
      .send({ pickup_address: PICKUP_ADDRESS, dropoff_address: DROPOFF_ADDRESS });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/trips/:id
// ─────────────────────────────────────────────────────────────
describe('GET /api/trips/:id', () => {
  test('200 — client can view their own trip', async () => {
    const { user, token } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: user.id });

    const res = await request(app)
      .get(`/api/trips/${trip.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.trip.id).toBe(trip.id);
    expect(res.body.trip.status).toBe('pending');
  });

  test('200 — assigned driver can view the trip', async () => {
    const { user: client } = await createClient({ email: 'client@test.com' });
    const { user: driver, token: driverToken } = await createDriver({ email: 'driver@test.com' });
    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trip.id).toBe(trip.id);
  });

  test('403 — client cannot view another client trip', async () => {
    const { user: owner } = await createClient({ email: 'owner@test.com' });
    const { token: otherToken } = await createClient({ email: 'other@test.com', phone: '+15149990001' });
    const trip = await createTrip({ client_id: owner.id });

    const res = await request(app)
      .get(`/api/trips/${trip.id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  test('404 — non-existent trip', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const res = await request(app)
      .get(`/api/trips/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/accept
// ─────────────────────────────────────────────────────────────
describe('PATCH /api/trips/:id/accept', () => {
  test('200 — approved driver accepts a pending trip', async () => {
    const { user: client } = await createClient({ email: 'client@test.com' });
    const { user: driver, token: driverToken } = await createDriver({ email: 'driver@test.com' });
    const trip = await createTrip({ client_id: client.id });

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/accept`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);

    // Verify DB state
    const { rows } = await pool.query('SELECT status, driver_id FROM trips WHERE id = $1', [trip.id]);
    expect(rows[0].status).toBe('assigned');
    expect(rows[0].driver_id).toBe(driver.id);
  });

  test('403 — client cannot accept a trip', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: client.id });

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/accept`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(403);
  });

  test('409 — second driver cannot accept an already-assigned trip', async () => {
    const { user: client }  = await createClient({ email: 'client@test.com' });
    const { user: d1, token: t1 } = await createDriver({ email: 'driver1@test.com' });
    const { token: t2 }     = await createDriver({ email: 'driver2@test.com', phone: '+15149990002' });
    const trip = await createTrip({ client_id: client.id });

    // First driver wins
    await request(app).patch(`/api/trips/${trip.id}/accept`).set('Authorization', `Bearer ${t1}`);

    // Second driver is too late
    const res = await request(app)
      .patch(`/api/trips/${trip.id}/accept`)
      .set('Authorization', `Bearer ${t2}`);

    expect(res.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/decline
// ─────────────────────────────────────────────────────────────
describe('PATCH /api/trips/:id/decline', () => {
  test('200 — driver declines; trip remains pending and broadcast_at is set', async () => {
    const { user: client } = await createClient({ email: 'client@test.com' });
    const { user: driver, token: driverToken } = await createDriver({ email: 'driver@test.com' });

    // Create trip with driver as preferred so decline makes sense
    const trip = await createTrip({ client_id: client.id, preferred_driver_id: driver.id });

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/decline`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT status, preferred_driver_declined FROM trips WHERE id = $1', [trip.id]
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].preferred_driver_declined).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/complete
// ─────────────────────────────────────────────────────────────
describe('PATCH /api/trips/:id/complete', () => {
  test('200 — assigned driver marks trip as completed', async () => {
    const { user: client } = await createClient({ email: 'client@test.com' });
    const { user: driver, token: driverToken } = await createDriver({ email: 'driver@test.com' });
    // departure_at must be in the past — drivers cannot complete before departure time
    const pastDeparture = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const trip = await createTrip({
      client_id:    client.id,
      driver_id:    driver.id,
      status:       'assigned',
      departure_at: pastDeparture,
    });

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/complete`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT status, completed_at FROM trips WHERE id = $1', [trip.id]
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();
  });

  test('409 — cannot complete a pending (unassigned) trip', async () => {
    const { user: client } = await createClient({ email: 'client@test.com' });
    const { token: driverToken } = await createDriver({ email: 'driver@test.com' });
    const trip = await createTrip({ client_id: client.id, status: 'pending' });

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/complete`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect([403, 409]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/cancel
// ─────────────────────────────────────────────────────────────
describe('PATCH /api/trips/:id/cancel', () => {
  test('200 — client cancels their own pending trip', async () => {
    const { user, token } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: user.id });

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Changed my mind' });

    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT status FROM trips WHERE id = $1', [trip.id]);
    expect(rows[0].status).toBe('cancelled');
  });

  test('409 — cannot cancel an already-completed trip', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver } = await createDriver({ email: 'driver@test.com' });
    const trip = await createTrip({
      client_id: client.id,
      driver_id: driver.id,
      status: 'completed',
    });

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/cancel`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ reason: 'Test cancel' });

    expect(res.status).toBe(409);
  });

  test('422 — cancellation reason is required', async () => {
    const { user, token } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: user.id });

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MISSING_REASON');
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/trips/action  (email token — no JWT)
// ─────────────────────────────────────────────────────────────
describe('GET /api/trips/action', () => {
  // Helper: create a trip with preferred driver and return the tokens from DB
  async function bookWithPreferredDriver() {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver } = await createDriver({ email: 'driver@test.com' });
    const est = await request(app)
      .post('/api/trips/estimate')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ pickup_address: PICKUP_ADDRESS, dropoff_address: DROPOFF_ADDRESS });

    await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        pickup_address:   PICKUP_ADDRESS,
        dropoff_address:  DROPOFF_ADDRESS,
        departure_at:     FUTURE_DEPARTURE(),
        pickup_lat:       est.body.pickup.lat,
        pickup_lon:       est.body.pickup.lon,
        dropoff_lat:      est.body.dropoff.lat,
        dropoff_lon:      est.body.dropoff.lon,
        preferred_driver_id: driver.id,
      });

    const { rows } = await pool.query(`
      SELECT vt.token, vt.action, vt.trip_id
      FROM verification_tokens vt
      WHERE vt.user_id = $1 AND vt.type = 'trip_action'
    `, [driver.id]);

    return { tokens: rows, driver };
  }

  test('302 → accepted — valid accept token assigns the trip', async () => {
    const { tokens } = await bookWithPreferredDriver();
    const acceptToken = tokens.find(t => t.action === 'accept');
    expect(acceptToken).toBeDefined();

    const res = await request(app)
      .get(`/api/trips/action?token=${acceptToken.token}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('action=accepted');

    // Verify DB state
    const { rows } = await pool.query('SELECT status FROM trips WHERE id = $1', [acceptToken.trip_id]);
    expect(rows[0].status).toBe('assigned');
  });

  test('302 → declined — valid decline token opens trip to all drivers', async () => {
    const { tokens } = await bookWithPreferredDriver();
    const declineToken = tokens.find(t => t.action === 'decline');
    expect(declineToken).toBeDefined();

    const res = await request(app)
      .get(`/api/trips/action?token=${declineToken.token}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('action=declined');

    // Trip stays pending but preferred_driver_declined = true
    const { rows } = await pool.query(
      'SELECT status, preferred_driver_declined FROM trips WHERE id = $1',
      [declineToken.trip_id]
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].preferred_driver_declined).toBe(true);
  });

  test('302 → expired — invalid token redirects gracefully', async () => {
    const res = await request(app)
      .get('/api/trips/action?token=totally-made-up-token-that-does-not-exist');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('action=expired');
  });

  test('302 → invalid — no token param redirects gracefully', async () => {
    const res = await request(app).get('/api/trips/action');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('action=invalid');
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/trips/available
// ─────────────────────────────────────────────────────────────
describe('GET /api/trips/available', () => {
  test('200 — approved driver sees pending trips within their radius', async () => {
    const { user: client } = await createClient({ email: 'client@test.com' });
    const { token: driverToken } = await createDriver({ email: 'driver@test.com' });

    // Trip pickup at Greenfield Park — same area as driver home_point (Montreal)
    await createTrip({ client_id: client.id });

    const res = await request(app)
      .get('/api/trips/available')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.trips)).toBe(true);
  });

  test('403 — client cannot access available trips', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/trips/available')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/trips/available');
    expect(res.status).toBe(401);
  });
});
