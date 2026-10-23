/**
 * @file tests/drivers.test.js
 * @description Integration tests for driver-facing routes.
 *
 * Covers:
 *   PATCH /api/drivers/availability  — toggle on-duty / off-duty
 *   GET   /api/drivers/earnings      — earnings history + summary
 *   GET   /api/drivers/nearby        — PostGIS proximity search
 *   GET   /api/drivers/search        — name autocomplete
 *   POST  /api/documents/:type/:slot — upload a driver document
 *   GET   /api/documents             — list uploaded document metadata
 *   DELETE /api/documents/:type      — remove all slots for a document type
 *
 * Email is mocked. Document uploads go to UPLOADS_DIR=/tmp/solidaroute-test-uploads
 * (set in .env.test) to avoid touching production file storage.
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                       = require('../src/db/pool');
const { resetDb, createClient, createDriver } = require('./setup/testDb');

jest.mock('../src/services/email');

// Minimal valid PDF buffer — starts with %PDF magic bytes (0x25 0x50 0x44 0x46).
// The file content after the header is not validated, only the leading bytes.
const PDF_BUFFER = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/drivers/availability
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/drivers/availability', () => {
  test('200 — driver sets availability to false', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .patch('/api/drivers/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_available: false });

    expect(res.status).toBe(200);
    expect(res.body.is_available).toBe(false);
  });

  test('200 — driver sets availability to true', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .patch('/api/drivers/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_available: true });

    expect(res.status).toBe(200);
    expect(res.body.is_available).toBe(true);
  });

  test('403 — client cannot toggle driver availability', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .patch('/api/drivers/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_available: false });

    expect(res.status).toBe(403);
  });

  test('422 — string "true" is rejected (must be boolean)', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .patch('/api/drivers/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_available: 'true' });

    expect(res.status).toBe(422);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .patch('/api/drivers/availability')
      .send({ is_available: false });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/drivers/earnings
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/drivers/earnings', () => {
  test('200 — driver sees an empty earnings list when no trips are completed', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .get('/api/drivers/earnings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('earnings');
    expect(Array.isArray(res.body.earnings)).toBe(true);
    expect(res.body.earnings).toHaveLength(0);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary.total).toBe(0);
    expect(res.body.summary.currency).toBe('CAD');
  });

  test('403 — client cannot access driver earnings endpoint', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/drivers/earnings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/drivers/earnings');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/drivers/nearby
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/drivers/nearby', () => {
  test('200 — returns the approved available driver near Montreal city centre', async () => {
    // createDriver seeds the driver at Montreal city centre (-73.5674, 45.5017)
    await createDriver({ email: 'driver@test.com' });
    const { token } = await createClient({ email: 'client@test.com' });

    // Query from the same point — distance is effectively 0, well within any configured radius
    const res = await request(app)
      .get('/api/drivers/nearby?lat=45.5017&lon=-73.5674')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('drivers');
    expect(Array.isArray(res.body.drivers)).toBe(true);
    expect(res.body.drivers.length).toBeGreaterThanOrEqual(1);
    expect(res.body).toHaveProperty('radius_km');
  });

  test('200 — returns empty array when no drivers are near the query point', async () => {
    // Driver is in Montreal; query from Vancouver — far enough to produce no results
    await createDriver({ email: 'driver@test.com' });
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/drivers/nearby?lat=49.2827&lon=-123.1207')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.drivers).toHaveLength(0);
  });

  test('422 — missing lat and lon query parameters', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/drivers/nearby')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(422);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app)
      .get('/api/drivers/nearby?lat=45.5017&lon=-73.5674');

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/drivers/search
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/drivers/search', () => {
  test('200 — finds an approved driver by first name', async () => {
    await createDriver({
      email:      'michel@test.com',
      first_name: 'Michel',
      last_name:  'Bouchard',
    });
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/drivers/search?q=Michel')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.drivers)).toBe(true);
    expect(res.body.drivers.length).toBeGreaterThanOrEqual(1);
    const found = res.body.drivers.find(d => d.first_name === 'Michel');
    expect(found).toBeDefined();
  });

  test('200 — returns empty array for a query shorter than 2 characters', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/drivers/search?q=M')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.drivers).toHaveLength(0);
  });

  test('200 — returns empty array when no driver name matches', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/drivers/search?q=ZZZNoMatch')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.drivers).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/documents/:type/:slot — upload
// GET  /api/documents             — list
// DELETE /api/documents/:type     — delete
// ─────────────────────────────────────────────────────────────────────────────
describe('Driver document routes', () => {
  test('200 — driver uploads a valid PDF as license slot 1', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .post('/api/documents/license/1')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'license.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('type', 'license');
    expect(res.body.mime_type).toBe('application/pdf');
  });

  test('200 — GET /api/documents lists the uploaded document', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    await request(app)
      .post('/api/documents/license/1')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'license.pdf', contentType: 'application/pdf' });

    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.documents)).toBe(true);
    expect(res.body.documents.length).toBeGreaterThanOrEqual(1);
    expect(res.body.documents[0].doc_type).toBe('license');
    expect(res.body.documents[0].mime_type).toBe('application/pdf');
  });

  test('200 — DELETE /api/documents/:type removes all slots for that type', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    // Upload slot 1
    await request(app)
      .post('/api/documents/license/1')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'license.pdf', contentType: 'application/pdf' });

    const del = await request(app)
      .delete('/api/documents/license')
      .set('Authorization', `Bearer ${token}`);

    expect(del.status).toBe(200);

    // Confirm no documents remain after deletion
    const list = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${token}`);

    expect(list.body.documents).toHaveLength(0);
  });

  test('403 — client cannot upload driver documents', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/documents/license/1')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'license.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(403);
  });

  test('403 — client cannot list documents', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('422 — upload without a file is rejected', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .post('/api/documents/license/1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(422);
  });

  test('422 — invalid document type is rejected', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .post('/api/documents/passport/1')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'passport.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(422);
  });

  test('422 — file without valid magic bytes is rejected', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });
    // Bytes do not match PDF, JPEG, or PNG signatures
    const INVALID_BUFFER = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

    const res = await request(app)
      .post('/api/documents/license/1')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', INVALID_BUFFER, {
        filename:    'bad.bin',
        contentType: 'application/octet-stream',
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_FILE_TYPE');
  });

  test('422 — invalid slot (must be 1 or 2)', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .post('/api/documents/license/3')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'license.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(422);
  });
});
