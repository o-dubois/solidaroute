/**
 * @file tests/profile.test.js
 * @description Integration tests for the /api/profile routes.
 *
 * Covers:
 *   GET    /api/profile              — full profile with sub-profile
 *   GET    /api/profile/completeness — driver completeness check (403 for others)
 *   PUT    /api/profile              — update first_name / last_name / phone
 *   PUT    /api/profile/client       — upsert client profile (403 for drivers)
 *   PUT    /api/profile/driver       — upsert driver profile (403 for clients)
 *   PUT    /api/profile/password     — change password (requires current_password)
 *   GET    /api/profile/check-deletion — preview deletion eligibility
 *   DELETE /api/profile              — delete or anonymize account
 *
 * geocodeAddress (used by PUT /driver) is mocked to avoid Nominatim calls.
 * email service is mocked to silence SMTP noise.
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                              = require('../src/db/pool');
const { resetDb, createClient, createDriver } = require('./setup/testDb');

jest.mock('../src/services/email');

// Mock the geocodeAddress call so PUT /driver doesn't need a live Nominatim instance
jest.mock('../src/services/routing', () => ({
  ...jest.requireActual('../src/services/routing'),
  geocodeAddress: jest.fn().mockResolvedValue({ lat: 45.5017, lon: -73.5674 }),
}));

beforeEach(async () => {
  await resetDb();
  // Reset the geocode mock between tests
  const { geocodeAddress } = require('../src/services/routing');
  geocodeAddress.mockResolvedValue({ lat: 45.5017, lon: -73.5674 });
});

afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/profile', () => {
  test('200 — client gets their profile with client_profile attached', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('profile');
    expect(res.body.profile.email).toBe('client@test.com');
    expect(res.body.profile.role).toBe('client');
    expect(res.body.profile).toHaveProperty('client_profile');
    // password_hash must never be returned
    expect(res.body.profile).not.toHaveProperty('password_hash');
  });

  test('200 — driver gets their profile with driver_profile attached', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.profile.role).toBe('driver');
    expect(res.body.profile).toHaveProperty('driver_profile');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/profile');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/completeness
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/profile/completeness', () => {
  test('200 — driver gets completeness report with missing fields listed', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .get('/api/profile/completeness')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('complete');
    expect(res.body).toHaveProperty('missing');
    expect(res.body).toHaveProperty('approval_status');
    expect(Array.isArray(res.body.missing)).toBe(true);
  });

  test('403 — client cannot access driver completeness endpoint', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/profile/completeness')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/profile/completeness');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/profile', () => {
  test('200 — client updates their first name', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ first_name: 'Nouveau' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.first_name).toBe('Nouveau');
  });

  test('200 — updates multiple fields at once', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ first_name: 'Marie', last_name: 'Tremblay', phone: '5141234567' });

    expect(res.status).toBe(200);
    expect(res.body.user.first_name).toBe('Marie');
    expect(res.body.user.last_name).toBe('Tremblay');
  });

  test('422 — sending no fields returns an error', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(422);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .put('/api/profile')
      .send({ first_name: 'Hack' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/client
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/profile/client', () => {
  test('200 — client upserts their client profile', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .put('/api/profile/client')
      .set('Authorization', `Bearer ${token}`)
      .send({ preferred_language: 'en', mobility_notes: 'Wheelchair user' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
  });

  test('422 — invalid vulnerability_type is rejected', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .put('/api/profile/client')
      .set('Authorization', `Bearer ${token}`)
      .send({ vulnerability_type: 'invalid_value' });

    expect(res.status).toBe(422);
  });

  test('403 — driver cannot update client profile', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .put('/api/profile/client')
      .set('Authorization', `Bearer ${token}`)
      .send({ preferred_language: 'fr' });

    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .put('/api/profile/client')
      .send({ preferred_language: 'fr' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/driver
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/profile/driver', () => {
  test('200 — driver updates vehicle info', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .put('/api/profile/driver')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicle_make: 'Honda', vehicle_model: 'Civic', vehicle_year: 2022 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
  });

  test('200 — driver updates home_address and geocoding succeeds', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .put('/api/profile/driver')
      .set('Authorization', `Bearer ${token}`)
      .send({ home_address: '3120 Boul. Taschereau, Greenfield Park, QC' });

    expect(res.status).toBe(200);
    // geocode_warning should NOT be set when geocoding succeeds
    expect(res.body.geocode_warning).toBeUndefined();
  });

  test('200 — geocode_warning returned when geocoding fails', async () => {
    const { geocodeAddress } = require('../src/services/routing');
    geocodeAddress.mockResolvedValueOnce(null); // simulate geocoding failure

    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .put('/api/profile/driver')
      .set('Authorization', `Bearer ${token}`)
      .send({ home_address: 'Nowhere Land, ZZ 99999' });

    expect(res.status).toBe(200);
    expect(res.body.geocode_warning).toBe(true);
  });

  test('422 — vehicle_year must be at least 1990', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .put('/api/profile/driver')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicle_year: 1985 });

    expect(res.status).toBe(422);
  });

  test('403 — client cannot update driver profile', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .put('/api/profile/driver')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicle_make: 'Toyota' });

    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .put('/api/profile/driver')
      .send({ vehicle_make: 'Ford' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/password
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/profile/password', () => {
  test('200 — user changes password with correct current_password', async () => {
    const { token } = await createClient({
      email:    'client@test.com',
      password: 'Password1!',
    });

    const res = await request(app)
      .put('/api/profile/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'Password1!', new_password: 'NewPassword2@' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
  });

  test('401 — incorrect current_password is rejected', async () => {
    const { token } = await createClient({ email: 'client@test.com', password: 'Password1!' });

    const res = await request(app)
      .put('/api/profile/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'WrongPassword!', new_password: 'NewPassword2@' });

    expect(res.status).toBe(401);
  });

  test('422 — weak new_password is rejected', async () => {
    const { token } = await createClient({ email: 'client@test.com', password: 'Password1!' });

    const res = await request(app)
      .put('/api/profile/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'Password1!', new_password: '123' });

    expect(res.status).toBe(422);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .put('/api/profile/password')
      .send({ current_password: 'Password1!', new_password: 'NewPassword2@' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/check-deletion
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/profile/check-deletion', () => {
  test('200 — returns deletion eligibility for a fresh client account', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/profile/check-deletion')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('can_delete');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/profile/check-deletion');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/profile
// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE /api/profile', () => {
  test('200 — client deletes their account with the correct confirmation phrase', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .delete('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmation: 'DELETE MY ACCOUNT' });

    expect(res.status).toBe(200);
    // Either 'deleted' (no payment history) or 'anonymized' (has payment history)
    expect(['deleted', 'anonymized']).toContain(res.body.type);
  });

  test('422 — wrong confirmation phrase is rejected', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .delete('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmation: 'delete account' });

    expect(res.status).toBe(422);
  });

  test('422 — missing confirmation phrase is rejected', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .delete('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(422);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .delete('/api/profile')
      .send({ confirmation: 'DELETE MY ACCOUNT' });
    expect(res.status).toBe(401);
  });
});
