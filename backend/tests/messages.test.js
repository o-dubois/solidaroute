/**
 * @file tests/messages.test.js
 * @description Integration tests for in-trip messaging routes.
 *
 * Covers:
 *   GET  /api/messages/unread-count  — nav badge count
 *   GET  /api/messages               — conversation list (trips with messages)
 *   GET  /api/messages/trip/:id      — full thread + marks messages read
 *   POST /api/messages/trip/:id      — send a message
 *
 * Only the trip's client_id and driver_id may read/send messages.
 * Email is mocked (POST sends a notification to the other participant).
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                                        = require('../src/db/pool');
const { resetDb, createClient, createDriver, createTrip } = require('./setup/testDb');

// sendTripMessage is called with .catch() chained directly (fire-and-forget).
// The default jest.mock auto-mock returns undefined for every function, so
// .catch() on undefined throws.  Provide a proper Promise-returning mock instead.
jest.mock('../src/services/email', () => ({
  sendTripMessage: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Insert a message directly and return its id. */
async function seedMessage(trip_id, sender_id, body = 'Hello!', read_at = null) {
  const { rows } = await pool.query(`
    INSERT INTO trip_messages (trip_id, sender_id, body, read_at)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [trip_id, sender_id, body, read_at]);
  return rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/unread-count
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/messages/unread-count', () => {
  test('200 — returns 0 when the user has no messages', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/messages/unread-count')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  test('200 — returns correct unread count for messages from the other party', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });
    // Seed two messages from the driver — these are unread for the client
    await seedMessage(trip.id, driver.id, 'Hey, on my way');
    await seedMessage(trip.id, driver.id, 'Almost there');
    // Seed one message from the client itself — should not count as unread for the client
    await seedMessage(trip.id, client.id, 'Great, thanks');

    const res = await request(app)
      .get('/api/messages/unread-count')
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/messages/unread-count');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/messages', () => {
  test('200 — returns empty list when user has no conversations', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/messages')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('conversations');
    expect(Array.isArray(res.body.conversations)).toBe(true);
    expect(res.body.conversations).toHaveLength(0);
  });

  test('200 — returns trip with messages; trip without messages is excluded', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });

    const trip1 = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });
    const trip2 = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    // Only trip1 gets a message
    await seedMessage(trip1.id, driver.id, 'Hello from driver');

    const res = await request(app)
      .get('/api/messages')
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].trip_id).toBe(trip1.id);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/trip/:trip_id
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/messages/trip/:trip_id', () => {
  test('200 — client reads the thread and messages from driver are marked read', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });
    await seedMessage(trip.id, driver.id, 'Driver says hi');
    await seedMessage(trip.id, client.id, 'Client reply');

    const res = await request(app)
      .get(`/api/messages/trip/${trip.id}`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('trip');
    expect(res.body).toHaveProperty('messages');
    expect(res.body).toHaveProperty('window_open');
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.window_open).toBe(true);

    // After GET, the driver's message should have been marked read
    const unread = await request(app)
      .get('/api/messages/unread-count')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(unread.body.count).toBe(0);
  });

  test('403 — a different client cannot read another trip\'s thread', async () => {
    const { user: client }         = await createClient({ email: 'client@test.com' });
    const { token: otherToken }    = await createClient({ email: 'other@test.com' });
    const { user: driver }         = await createDriver({ email: 'driver@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    const res = await request(app)
      .get(`/api/messages/trip/${trip.id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  test('404 — non-existent trip returns 404', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const fakeId    = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .get(`/api/messages/trip/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .get('/api/messages/trip/00000000-0000-0000-0000-000000000099');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/messages/trip/:trip_id
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/messages/trip/:trip_id', () => {
  test('201 — client sends a message on an assigned trip', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    const res = await request(app)
      .post(`/api/messages/trip/${trip.id}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ body: 'Are you close?' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('message');
    expect(res.body.message.body).toBe('Are you close?');
    expect(res.body.message.sender_id).toBe(client.id);
  });

  test('201 — driver sends a message on an assigned trip', async () => {
    const { user: client }                     = await createClient({ email: 'client@test.com' });
    const { user: driver, token: driverToken } = await createDriver({ email: 'driver@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    const res = await request(app)
      .post(`/api/messages/trip/${trip.id}`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ body: 'On my way!' });

    expect(res.status).toBe(201);
    expect(res.body.message.sender_id).toBe(driver.id);
  });

  test('422 — empty body is rejected', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    const res = await request(app)
      .post(`/api/messages/trip/${trip.id}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ body: '' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EMPTY_BODY');
  });

  test('422 — body over 500 chars is rejected', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    const res = await request(app)
      .post(`/api/messages/trip/${trip.id}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ body: 'x'.repeat(501) });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TOO_LONG');
  });

  test('403 — non-participant cannot send a message', async () => {
    const { user: client }      = await createClient({ email: 'client@test.com' });
    const { user: driver }      = await createDriver({ email: 'driver@test.com' });
    const { token: outsider }   = await createClient({ email: 'outsider@test.com' });

    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'assigned' });

    const res = await request(app)
      .post(`/api/messages/trip/${trip.id}`)
      .set('Authorization', `Bearer ${outsider}`)
      .send({ body: 'Intruding!' });

    expect(res.status).toBe(403);
  });

  test('404 — non-existent trip returns 404', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const fakeId    = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .post(`/api/messages/trip/${fakeId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'Hello?' });

    expect(res.status).toBe(404);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .post('/api/messages/trip/00000000-0000-0000-0000-000000000099')
      .send({ body: 'Hello?' });
    expect(res.status).toBe(401);
  });
});
