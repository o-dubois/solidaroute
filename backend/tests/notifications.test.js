/**
 * @file tests/notifications.test.js
 * @description Integration tests for notification routes.
 *
 * Covers:
 *   GET   /api/notifications         — list notifications + unread_count
 *   PATCH /api/notifications/read-all — mark all as read
 *   PATCH /api/notifications/:id/read — mark one as read
 *
 * Notifications have no creation endpoint — they are written by backend
 * services.  Tests seed rows directly via SQL.
 *
 * columns: id (uuid), user_id, channel ('in_app'|'push'|...), type, title,
 *          message, payload (jsonb), is_read (bool), sent_at (timestamptz)
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                    = require('../src/db/pool');
const { resetDb, createClient }   = require('./setup/testDb');

jest.mock('../src/services/email');

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Insert a notification row directly and return its id. */
async function seedNotification(userId, { is_read = false } = {}) {
  const { rows } = await pool.query(`
    INSERT INTO notifications (user_id, channel, type, title, message, is_read)
    VALUES ($1, 'in_app', 'test_event', 'Test title', 'Test message body', $2)
    RETURNING id
  `, [userId, is_read]);
  return rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/notifications', () => {
  test('200 — returns empty list when user has no notifications', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('notifications');
    expect(Array.isArray(res.body.notifications)).toBe(true);
    expect(res.body.notifications).toHaveLength(0);
    expect(res.body.unread_count).toBe(0);
  });

  test('200 — returns seeded notifications with correct unread_count', async () => {
    const { user, token } = await createClient({ email: 'client@test.com' });

    await seedNotification(user.id, { is_read: false });
    await seedNotification(user.id, { is_read: false });
    await seedNotification(user.id, { is_read: true });

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(3);
    expect(res.body.unread_count).toBe(2);
  });

  test('200 — only returns notifications belonging to the authenticated user', async () => {
    const { user: u1, token } = await createClient({ email: 'user1@test.com' });
    const { user: u2 }        = await createClient({ email: 'user2@test.com' });

    await seedNotification(u1.id);
    await seedNotification(u2.id);

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].user_id).toBe(u1.id);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/notifications/read-all
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/notifications/read-all', () => {
  test('200 — marks all unread notifications as read', async () => {
    const { user, token } = await createClient({ email: 'client@test.com' });

    await seedNotification(user.id, { is_read: false });
    await seedNotification(user.id, { is_read: false });

    const res = await request(app)
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();

    // Verify the DB state — all notifications should now be read
    const list = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);

    expect(list.body.unread_count).toBe(0);
  });

  test('200 — succeeds even when there are no unread notifications', async () => {
    const { user, token } = await createClient({ email: 'client@test.com' });
    await seedNotification(user.id, { is_read: true });

    const res = await request(app)
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).patch('/api/notifications/read-all');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/notifications/:id/read
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/notifications/:id/read', () => {
  test('200 — marks a single notification as read', async () => {
    const { user, token } = await createClient({ email: 'client@test.com' });

    const id = await seedNotification(user.id, { is_read: false });

    const res = await request(app)
      .patch(`/api/notifications/${id}/read`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();

    // Verify unread_count drops to 0
    const list = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);

    expect(list.body.unread_count).toBe(0);
  });

  test('200 — user cannot mark another user\'s notification as read (silently ignored)', async () => {
    const { user: owner }          = await createClient({ email: 'owner@test.com' });
    const { token: attackerToken } = await createClient({ email: 'attacker@test.com' });

    const id = await seedNotification(owner.id, { is_read: false });

    // The route does UPDATE WHERE id=$1 AND user_id=$2, so this is a no-op
    const res = await request(app)
      .patch(`/api/notifications/${id}/read`)
      .set('Authorization', `Bearer ${attackerToken}`);

    // The route returns 200 regardless (no ownership 404 by design)
    expect(res.status).toBe(200);

    // Owner's notification must still be unread
    const { rows } = await pool.query(
      'SELECT is_read FROM notifications WHERE id = $1', [id]
    );
    expect(rows[0].is_read).toBe(false);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .patch('/api/notifications/00000000-0000-0000-0000-000000000001/read');
    expect(res.status).toBe(401);
  });
});
