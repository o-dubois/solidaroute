/**
 * @file tests/admin.test.js
 * @description Integration tests for admin-facing routes.
 *
 * Covers:
 *   GET   /api/admin/users            — paginated user list with optional filters
 *   PATCH /api/admin/users/:id/status — activate / suspend a user
 *   GET   /api/admin/drivers          — list all drivers
 *   PATCH /api/admin/drivers/:id/approve — approve / reject a driver
 *   GET   /api/admin/configuration    — read config (superadmin only)
 *   PUT   /api/admin/configuration/:key — upsert config value (superadmin only)
 *
 * Auth hierarchy enforced by the parent /api/admin router:
 *   authenticate + authorize('operator', 'superadmin') on all sub-routes.
 *   Some sub-routes add a second authorize('superadmin').
 *
 * Email is mocked (driver approval sends an email).
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                                              = require('../src/db/pool');
const { resetDb, createUser, createClient, createDriver,
        createOperator, getSuperadminToken }                = require('./setup/testDb');

jest.mock('../src/services/email');

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/users', () => {
  test('200 — operator retrieves the full user list', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('users');
    expect(Array.isArray(res.body.users)).toBe(true);
    // The list must include at least the operator and client we just created
    expect(res.body.users.length).toBeGreaterThanOrEqual(2);
  });

  test('200 — operator filters users by role=client', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/admin/users?role=client')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.users.every(u => u.role === 'client')).toBe(true);
  });

  test('200 — operator searches users by email', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    await createClient({ email: 'findme@test.com' });

    const res = await request(app)
      .get('/api/admin/users?search=findme')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThanOrEqual(1);
    expect(res.body.users.some(u => u.email === 'findme@test.com')).toBe(true);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  test('403 — client cannot access admin user list', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/status
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/users/:id/status', () => {
  test('200 — operator suspends a client account', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const { user: client } = await createClient({ email: 'target@test.com' });

    const res = await request(app)
      .patch(`/api/admin/users/${client.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'suspended' });

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('suspended');
  });

  test('200 — operator reactivates a suspended client', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const { user: client } = await createClient({ email: 'target@test.com' });

    // First suspend
    await request(app)
      .patch(`/api/admin/users/${client.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'suspended' });

    // Then reactivate
    const res = await request(app)
      .patch(`/api/admin/users/${client.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'active' });

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('active');
  });

  test('403 — cannot modify the protected superadmin account', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE email = 'admin@solidaroute.ca'"
    );
    const superadminId = rows[0].id;

    const res = await request(app)
      .patch(`/api/admin/users/${superadminId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'suspended' });

    expect(res.status).toBe(403);
  });

  test('403 — operator cannot modify their own status', async () => {
    const { user, token } = await createOperator({ email: 'operator@test.com' });

    const res = await request(app)
      .patch(`/api/admin/users/${user.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'suspended' });

    expect(res.status).toBe(403);
  });

  test('404 — non-existent user returns 404', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const fakeId = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .patch(`/api/admin/users/${fakeId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'suspended' });

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/drivers
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/drivers', () => {
  test('200 — operator retrieves the driver list', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .get('/api/admin/drivers')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('drivers');
    expect(Array.isArray(res.body.drivers)).toBe(true);
    expect(res.body.drivers.length).toBeGreaterThanOrEqual(1);
    expect(res.body.drivers[0]).toHaveProperty('approval_status');
  });

  test('403 — client cannot access admin driver list', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/admin/drivers')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/drivers/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/drivers/:id/approve', () => {
  test('200 — operator approves a driver', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const { user: driver } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .patch(`/api/admin/drivers/${driver.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.approval_status).toBe('approved');
  });

  test('200 — operator rejects a driver', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const { user: driver } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .patch(`/api/admin/drivers/${driver.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'rejected' });

    expect(res.status).toBe(200);
    expect(res.body.approval_status).toBe('rejected');
  });

  test('200 — operator suspends a driver', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const { user: driver } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .patch(`/api/admin/drivers/${driver.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'suspended' });

    expect(res.status).toBe(200);
    expect(res.body.approval_status).toBe('suspended');
  });

  test('422 — invalid status value is rejected', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });
    const { user: driver } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .patch(`/api/admin/drivers/${driver.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'deleted' }); // not in the allowed list

    expect(res.status).toBe(422);
  });

  test('403 — client cannot approve drivers', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const { user: driver } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .patch(`/api/admin/drivers/${driver.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/configuration  (superadmin only)
// PUT /api/admin/configuration/:key
// ─────────────────────────────────────────────────────────────────────────────
describe('Configuration routes (superadmin only)', () => {
  test('200 — superadmin reads all configuration entries', async () => {
    const token = await getSuperadminToken();

    // resetDb() cascade-truncates configuration (updated_by → users FK), so we
    // must write at least one entry before testing the read endpoint.
    await request(app)
      .put('/api/admin/configuration/test_read_key')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'test_read_value' });

    const res = await request(app)
      .get('/api/admin/configuration')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('configuration');
    expect(Array.isArray(res.body.configuration)).toBe(true);
    expect(res.body.configuration.length).toBeGreaterThan(0);
    expect(res.body.configuration.some(c => c.key === 'test_read_key')).toBe(true);
  });

  test('403 — operator cannot read configuration', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });

    const res = await request(app)
      .get('/api/admin/configuration')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('200 — superadmin updates a configuration value', async () => {
    const token = await getSuperadminToken();

    const res = await request(app)
      .put('/api/admin/configuration/test_key')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'test_value' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('setting');
    expect(res.body.setting.key).toBe('test_key');
    expect(res.body.setting.value).toBe('test_value');
  });

  test('403 — operator cannot update configuration', async () => {
    const { token } = await createOperator({ email: 'operator@test.com' });

    const res = await request(app)
      .put('/api/admin/configuration/some_key')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'some_value' });

    expect(res.status).toBe(403);
  });

  test('422 — empty value is rejected', async () => {
    const token = await getSuperadminToken();

    const res = await request(app)
      .put('/api/admin/configuration/test_key')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: '' });

    expect(res.status).toBe(422);
  });
});
