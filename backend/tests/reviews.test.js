/**
 * @file tests/reviews.test.js
 * @description Integration tests for review submission and moderation routes.
 *
 * Covers:
 *   POST   /api/reviews               — submit a review (completed trips only)
 *   GET    /api/reviews/mine          — reviews given by + received by the caller
 *   GET    /api/reviews/trip/:trip_id — approved reviews for a trip
 *   GET    /api/reviews/user/:id      — approved reviews for a user
 *   GET    /api/reviews/pending-count — admin: count of pending reviews
 *   GET    /api/reviews/pending       — admin: list of pending reviews
 *   PATCH  /api/reviews/:id/approve   — operator approves a review
 *   PATCH  /api/reviews/:id/reject    — operator rejects a review
 *
 * Review lifecycle: pending → approved | rejected
 * Only approved reviews are public; pending/rejected are only visible to the
 * submitter (GET /mine) and admins (GET /pending).
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                                                    = require('../src/db/pool');
const { resetDb, createClient, createDriver, createOperator,
        createTrip }                                              = require('./setup/testDb');

jest.mock('../src/services/email');

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a completed trip with the given client and driver. */
async function createCompletedTrip(clientId, driverId) {
  return createTrip({ client_id: clientId, driver_id: driverId, status: 'completed' });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reviews
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/reviews', () => {
  test('201 — client submits a review for a completed trip', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });
    const trip = await createCompletedTrip(client.id, driver.id);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 5, comment: 'Great driver!' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('review');
    expect(res.body.review.rating).toBe(5);
    expect(res.body.review.status).toBe('pending');
    expect(res.body.review.reviewee_id).toBe(driver.id);
  });

  test('201 — driver submits a review for a completed trip', async () => {
    const { user: client }                     = await createClient({ email: 'client@test.com' });
    const { user: driver, token: driverToken } = await createDriver({ email: 'driver@test.com' });
    const trip = await createCompletedTrip(client.id, driver.id);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ trip_id: trip.id, rating: 4 });

    expect(res.status).toBe(201);
    expect(res.body.review.reviewee_id).toBe(client.id);
  });

  test('422 — rating must be between 1 and 5', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const { user: driver }        = await createDriver({ email: 'driver@test.com' });
    const trip = await createCompletedTrip(client.id, driver.id);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id, rating: 6 });

    expect(res.status).toBe(422);
  });

  test('422 — comment longer than 100 chars is rejected', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const { user: driver }        = await createDriver({ email: 'driver@test.com' });
    const trip = await createCompletedTrip(client.id, driver.id);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id, rating: 3, comment: 'x'.repeat(101) });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMMENT_TOO_LONG');
  });

  test('422 — trip must be completed (not pending)', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const { user: driver }        = await createDriver({ email: 'driver@test.com' });
    const trip = await createTrip({ client_id: client.id, driver_id: driver.id, status: 'pending' });

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id, rating: 5 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TRIP_NOT_COMPLETED');
  });

  test('403 — non-participant cannot review the trip', async () => {
    const { user: client }         = await createClient({ email: 'client@test.com' });
    const { user: driver }         = await createDriver({ email: 'driver@test.com' });
    const { token: outsiderToken } = await createClient({ email: 'outsider@test.com' });
    const trip = await createCompletedTrip(client.id, driver.id);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ trip_id: trip.id, rating: 1 });

    expect(res.status).toBe(403);
  });

  test('404 — non-existent trip returns 404', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const fakeId    = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: fakeId, rating: 5 });

    expect(res.status).toBe(404);
  });

  test('409 — duplicate review is rejected', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const { user: driver }        = await createDriver({ email: 'driver@test.com' });
    const trip = await createCompletedTrip(client.id, driver.id);

    await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id, rating: 5 });

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id, rating: 4 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_REVIEWED');
  });

  test('422 — trip_id and rating are required', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${token}`)
      .send({ rating: 5 }); // missing trip_id

    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/mine
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/reviews/mine', () => {
  test('200 — returns given and received arrays (empty when no reviews)', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/reviews/mine')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.given)).toBe(true);
    expect(Array.isArray(res.body.received)).toBe(true);
    expect(res.body.given).toHaveLength(0);
    expect(res.body.received).toHaveLength(0);
  });

  test('200 — given includes all statuses; received includes only approved', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver, token: driverToken } = await createDriver({ email: 'driver@test.com' });
    const { token: operatorToken }             = await createOperator({ email: 'operator@test.com' });

    const trip = await createCompletedTrip(client.id, driver.id);

    // Client submits a review (pending)
    await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 5 });

    // Driver submits a review of the client (pending), then operator approves it
    const drRes = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ trip_id: trip.id, rating: 4, comment: 'Good passenger' });

    const reviewId = drRes.body.review.id;
    await request(app)
      .patch(`/api/reviews/${reviewId}/approve`)
      .set('Authorization', `Bearer ${operatorToken}`);

    // Client's "given" list should have 1 entry (pending status)
    const mine = await request(app)
      .get('/api/reviews/mine')
      .set('Authorization', `Bearer ${clientToken}`);

    expect(mine.status).toBe(200);
    expect(mine.body.given).toHaveLength(1);
    expect(mine.body.given[0].status).toBe('pending');
    // The approved driver review should appear in received
    expect(mine.body.received).toHaveLength(1);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/reviews/mine');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/trip/:trip_id
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/reviews/trip/:trip_id', () => {
  test('200 — returns empty approved array and null my_review before any review', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const { user: driver }        = await createDriver({ email: 'driver@test.com' });
    const trip = await createCompletedTrip(client.id, driver.id);

    const res = await request(app)
      .get(`/api/reviews/trip/${trip.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reviews)).toBe(true);
    expect(res.body.reviews).toHaveLength(0);
    expect(res.body.my_review).toBeNull();
  });

  test('200 — my_review is returned before approval; approved reviews appear after approval', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });
    const { token: operatorToken }             = await createOperator({ email: 'operator@test.com' });

    const trip = await createCompletedTrip(client.id, driver.id);

    // Submit a review
    const submitted = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 5 });

    const reviewId = submitted.body.review.id;

    // Before approval — my_review is visible but reviews[] is empty
    const before = await request(app)
      .get(`/api/reviews/trip/${trip.id}`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(before.body.reviews).toHaveLength(0);
    expect(before.body.my_review).not.toBeNull();
    expect(before.body.my_review.status).toBe('pending');

    // Approve the review
    await request(app)
      .patch(`/api/reviews/${reviewId}/approve`)
      .set('Authorization', `Bearer ${operatorToken}`);

    // After approval — appears in reviews[]
    const after = await request(app)
      .get(`/api/reviews/trip/${trip.id}`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(after.body.reviews).toHaveLength(1);
    expect(after.body.my_review.status).toBe('approved');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .get('/api/reviews/trip/00000000-0000-0000-0000-000000000099');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/user/:id
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/reviews/user/:id', () => {
  test('200 — returns empty array when user has no approved reviews', async () => {
    const { user: driver } = await createDriver({ email: 'driver@test.com' });
    const { token }        = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get(`/api/reviews/user/${driver.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reviews)).toBe(true);
    expect(res.body.reviews).toHaveLength(0);
  });

  test('200 — returns approved reviews for the specified user', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });
    const { token: operatorToken }             = await createOperator({ email: 'operator@test.com' });

    const trip = await createCompletedTrip(client.id, driver.id);
    const sub  = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 4 });

    await request(app)
      .patch(`/api/reviews/${sub.body.review.id}/approve`)
      .set('Authorization', `Bearer ${operatorToken}`);

    const { token: viewer } = await createClient({ email: 'viewer@test.com' });
    const res = await request(app)
      .get(`/api/reviews/user/${driver.id}`)
      .set('Authorization', `Bearer ${viewer}`);

    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].rating).toBe(4);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .get('/api/reviews/user/00000000-0000-0000-0000-000000000099');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/pending-count  &  GET /api/reviews/pending
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/reviews/pending-count and /pending', () => {
  test('200 — operator sees pending-count of 0 when no reviews exist', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });

    const res = await request(app)
      .get('/api/reviews/pending-count')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  test('200 — operator sees pending reviews after a client submits one', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });
    const { token: operatorToken }             = await createOperator({ email: 'operator@test.com' });

    const trip = await createCompletedTrip(client.id, driver.id);
    await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 5 });

    const countRes = await request(app)
      .get('/api/reviews/pending-count')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(countRes.status).toBe(200);
    expect(countRes.body.count).toBe(1);

    const listRes = await request(app)
      .get('/api/reviews/pending')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.reviews)).toBe(true);
    expect(listRes.body.reviews).toHaveLength(1);
  });

  test('403 — client cannot access pending review routes', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const count = await request(app)
      .get('/api/reviews/pending-count')
      .set('Authorization', `Bearer ${token}`);
    expect(count.status).toBe(403);

    const list = await request(app)
      .get('/api/reviews/pending')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/reviews/:id/approve  &  PATCH /api/reviews/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/reviews/:id/approve and /reject', () => {
  test('200 — operator approves a pending review', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });
    const { token: operatorToken }             = await createOperator({ email: 'operator@test.com' });

    const trip = await createCompletedTrip(client.id, driver.id);
    const sub  = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 5 });

    const res = await request(app)
      .patch(`/api/reviews/${sub.body.review.id}/approve`)
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  test('200 — operator rejects a pending review', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });
    const { token: operatorToken }             = await createOperator({ email: 'operator@test.com' });

    const trip = await createCompletedTrip(client.id, driver.id);
    const sub  = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 1, comment: 'Bad' });

    const res = await request(app)
      .patch(`/api/reviews/${sub.body.review.id}/reject`)
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('409 — cannot approve a review that is already moderated', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });
    const { token: operatorToken }             = await createOperator({ email: 'operator@test.com' });

    const trip = await createCompletedTrip(client.id, driver.id);
    const sub  = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 5 });

    const reviewId = sub.body.review.id;

    await request(app)
      .patch(`/api/reviews/${reviewId}/approve`)
      .set('Authorization', `Bearer ${operatorToken}`);

    const res = await request(app)
      .patch(`/api/reviews/${reviewId}/approve`)
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(409);
  });

  test('404 — non-existent review returns 404', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const fakeId    = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .patch(`/api/reviews/${fakeId}/approve`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test('403 — client cannot approve reviews', async () => {
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const { user: driver }                     = await createDriver({ email: 'driver@test.com' });

    const trip = await createCompletedTrip(client.id, driver.id);
    const sub  = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, rating: 5 });

    const res = await request(app)
      .patch(`/api/reviews/${sub.body.review.id}/approve`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(403);
  });
});
