/**
 * @file tests/auth.test.js
 * @description Integration tests for /api/auth/*
 *
 * Covers:
 *   POST /register         — create a new account
 *   GET  /verify-email     — activate account via token
 *   POST /login            — authenticate and receive JWT
 *   GET  /me               — return authenticated user's profile
 *   POST /forgot-password  — request a reset email
 *   POST /reset-password   — set a new password via token
 *   Account lockout        — lock after max failed login attempts
 *
 * Email is mocked: no actual SMTP calls are made.
 * All DB state is reset before each test via resetDb().
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                                           = require('../src/db/pool');
const { resetDb, createUser, createClient, createDriver } = require('./setup/testDb');

// Prevent any real email from being sent during tests
jest.mock('../src/services/email');

// ── Shared test fixture ───────────────────────────────────────
const VALID_CLIENT = {
  first_name: 'Jean',
  last_name:  'Tremblay',
  email:      'jean@test.com',
  password:   'Password1!',
  phone:      '+15141234567',
  role:       'client',
};

beforeEach(async () => {
  await resetDb();
});

// Close the shared pool once all tests in this file have finished.
// --forceExit ensures Jest exits even if this is missed.
afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────
describe('POST /api/auth/register', () => {
  test('201 — registers a new client account', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_CLIENT);

    expect(res.status).toBe(201);
    // Response should acknowledge registration (message or token depending on implementation)
    expect(res.body).toBeDefined();
  });

  test('409 — duplicate email', async () => {
    await request(app).post('/api/auth/register').send(VALID_CLIENT);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_CLIENT, phone: '+15149999999' }); // different phone, same email

    // The auth route pre-checks for duplicate email via SELECT, so there is no
    // DB constraint error and no `code` field — just a 409 with an error message.
    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error');
  });

  test('409 PHONE_IN_USE — duplicate phone', async () => {
    await request(app).post('/api/auth/register').send(VALID_CLIENT);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_CLIENT, email: 'other@test.com' }); // different email, same phone

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHONE_IN_USE');
  });

  test('422 — rejects a password that does not meet complexity rules', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_CLIENT, password: 'weak' });

    // express-validator returns 422 Unprocessable Entity for validation failures
    expect(res.status).toBe(422);
  });

  test('422 — rejects a missing required field', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'partial@test.com', password: 'Password1!' });

    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/auth/verify-email
// ─────────────────────────────────────────────────────────────
describe('GET /api/auth/verify-email', () => {
  test('200 — activates a pending client account', async () => {
    // Register via HTTP so a verification token is created
    await request(app).post('/api/auth/register').send(VALID_CLIENT);

    // Retrieve the token directly from the DB
    const { rows } = await pool.query(`
      SELECT vt.token
      FROM verification_tokens vt
      JOIN users u ON u.id = vt.user_id
      WHERE u.email = $1 AND vt.type = 'email_verification'
      LIMIT 1
    `, [VALID_CLIENT.email]);

    expect(rows.length).toBe(1);

    const res = await request(app)
      .get(`/api/auth/verify-email?token=${rows[0].token}`);

    expect(res.status).toBe(200);

    // Confirm the account is now active in the DB
    const { rows: userRows } = await pool.query(
      'SELECT status, email_verified FROM users WHERE email = $1',
      [VALID_CLIENT.email]
    );
    expect(userRows[0].email_verified).toBe(true);
    expect(userRows[0].status).toBe('active');
  });

  test('400 — rejects an invalid token', async () => {
    const res = await request(app)
      .get('/api/auth/verify-email?token=totally-invalid-token');

    expect([400, 404]).toContain(res.status);
  });

  test('400 — rejects a token that has already been used', async () => {
    await request(app).post('/api/auth/register').send(VALID_CLIENT);

    const { rows } = await pool.query(`
      SELECT token FROM verification_tokens
      WHERE type = 'email_verification' LIMIT 1
    `);
    const token = rows[0].token;

    // First use — should succeed
    await request(app).get(`/api/auth/verify-email?token=${token}`);

    // Second use — should be rejected
    const res = await request(app)
      .get(`/api/auth/verify-email?token=${token}`);

    expect([400, 410]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  test('200 — returns a JWT for a verified active client', async () => {
    await createClient({ email: 'client@test.com', password: 'Password1!' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'client@test.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user).toHaveProperty('id');
    expect(res.body.user.email).toBe('client@test.com');
  });

  test('200 — returns a JWT for a verified active driver', async () => {
    await createDriver({ email: 'driver@test.com', password: 'Password1!' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'driver@test.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  test('401 — rejects an incorrect password', async () => {
    await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'client@test.com', password: 'WrongPassword1!' });

    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('token');
  });

  test('401 — rejects a non-existent email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'Password1!' });

    expect(res.status).toBe(401);
  });

  test('401/403 — rejects an unverified account (registered via HTTP, not verified)', async () => {
    // Register without going through email verification — account remains pending
    await request(app).post('/api/auth/register').send(VALID_CLIENT);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID_CLIENT.email, password: VALID_CLIENT.password });

    expect([401, 403]).toContain(res.status);
    expect(res.body).not.toHaveProperty('token');
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────
describe('GET /api/auth/me', () => {
  test('200 — returns the authenticated user profile', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('client@test.com');
    expect(res.body.user).not.toHaveProperty('password_hash'); // never expose hashes
  });

  test('401 — rejects a request with no token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('401 — rejects a request with a tampered token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer this.is.not.a.real.jwt');

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// ─────────────────────────────────────────────────────────────
describe('POST /api/auth/forgot-password', () => {
  test('200 — acknowledges the request for an existing email', async () => {
    await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'client@test.com' });

    // Must always return 200 (don't leak whether the email exists)
    expect(res.status).toBe(200);
  });

  test('200 — acknowledges even for a non-existent email (no enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'ghost@test.com' });

    expect(res.status).toBe(200);
  });

  test('creates a password_reset token in the DB', async () => {
    await createClient({ email: 'client@test.com' });

    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'client@test.com' });

    const { rows } = await pool.query(`
      SELECT vt.token
      FROM verification_tokens vt
      JOIN users u ON u.id = vt.user_id
      WHERE u.email = 'client@test.com' AND vt.type = 'password_reset'
    `);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// ─────────────────────────────────────────────────────────────
describe('POST /api/auth/reset-password', () => {
  test('200 — resets the password with a valid token', async () => {
    await createClient({ email: 'client@test.com', password: 'OldPass1!' });

    // Request a reset
    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'client@test.com' });

    // Get the reset token from the DB
    const { rows } = await pool.query(`
      SELECT vt.token
      FROM verification_tokens vt
      JOIN users u ON u.id = vt.user_id
      WHERE u.email = 'client@test.com' AND vt.type = 'password_reset'
      LIMIT 1
    `);
    expect(rows.length).toBe(1);

    // Reset the password
    const resetRes = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: rows[0].token, password: 'NewPass1!' });

    expect(resetRes.status).toBe(200);

    // Confirm the new password works for login
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'client@test.com', password: 'NewPass1!' });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body).toHaveProperty('token');
  });

  test('400 — rejects an invalid reset token', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'made-up-token', password: 'NewPass1!' });

    expect([400, 404]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────
// Account lockout
// ─────────────────────────────────────────────────────────────
describe('Account lockout', () => {
  test('locks the account after max_login_attempts consecutive failures', async () => {
    // Read the configured threshold from the test DB
    const { rows: cfgRows } = await pool.query(
      "SELECT value FROM configuration WHERE key = 'max_login_attempts'"
    );
    const maxAttempts = parseInt(cfgRows[0]?.value ?? '5', 10);

    await createClient({ email: 'victim@test.com', password: 'CorrectPass1!' });

    // Exhaust the allowed attempts
    for (let i = 0; i < maxAttempts; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'victim@test.com', password: 'WrongPassword1!' });
    }

    // The account should now be locked — even correct credentials must fail
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'victim@test.com', password: 'CorrectPass1!' });

    expect([401, 403, 423]).toContain(res.status);
    expect(res.body).not.toHaveProperty('token');
  });
});
