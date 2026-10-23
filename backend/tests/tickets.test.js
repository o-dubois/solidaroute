/**
 * @file tests/tickets.test.js
 * @description Integration tests for the mobility ticket system.
 *
 * Covers:
 *   POST /api/tickets/notebooks           — create a notebook of 10 tickets
 *   GET  /api/tickets/notebooks           — list all notebooks (ticket_master+)
 *   GET  /api/tickets/notebooks/:id       — single notebook detail + tickets
 *   GET  /api/tickets/my-tickets          — client's available tickets
 *   GET  /api/tickets/for-trip/:trip_id   — required count + available tickets
 *   POST /api/tickets/reserve             — reserve tickets for a pending trip
 *   PATCH /api/tickets/:number/void       — void an available ticket
 *
 * Email is mocked. All DB state is reset before each test.
 *
 * Note on required ticket count:
 *   The reserve endpoint computes Math.ceil(estimated_cost / facial_value).
 *   Tests use estimated_cost=2.50 to remain well under any reasonable facial_value,
 *   and supply 2 ticket numbers (≥ any required count for that cost).
 */

const request = require('supertest');
const app     = require('../src/app');
const { pool }                                                     = require('../src/db/pool');
const { resetDb, createClient, createDriver, createTrip,
        createTicketMaster, createNotebook, getSuperadminToken }   = require('./setup/testDb');

jest.mock('../src/services/email');

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/notebooks
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/tickets/notebooks', () => {
  test('201 — ticket_master creates a client notebook with 10 tickets', async () => {
    const { token } = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/tickets/notebooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ owner_type: 'client', owner_client_id: client.id });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('notebook');
    expect(res.body.total_tickets).toBe(10);
    expect(res.body.notebook).toHaveProperty('notebook_key');
    expect(res.body.notebook).toHaveProperty('ticket_start');
  });

  test('201 — ticket_master creates multiple notebooks (quantity=2)', async () => {
    const { token } = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/tickets/notebooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ owner_type: 'client', owner_client_id: client.id, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.notebooks).toHaveLength(2);
    expect(res.body.total_tickets).toBe(20);
  });

  test('403 — client cannot create notebooks', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .post('/api/tickets/notebooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ owner_type: 'client', owner_client_id: 'some-id' });

    expect(res.status).toBe(403);
  });

  test('400 — missing owner_client_id for a client notebook', async () => {
    const { token } = await createTicketMaster({ email: 'tm@test.com' });

    const res = await request(app)
      .post('/api/tickets/notebooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ owner_type: 'client' }); // owner_client_id intentionally omitted

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_OWNER_CLIENT_ID');
  });

  test('400 — invalid owner_type is rejected', async () => {
    const { token } = await createTicketMaster({ email: 'tm@test.com' });

    const res = await request(app)
      .post('/api/tickets/notebooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ owner_type: 'company' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_OWNER_TYPE');
  });

  test('404 — non-existent client user returns 404', async () => {
    const { token } = await createTicketMaster({ email: 'tm@test.com' });
    const fakeId = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .post('/api/tickets/notebooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ owner_type: 'client', owner_client_id: fakeId });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/notebooks
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/tickets/notebooks', () => {
  test('200 — ticket_master lists all notebooks', async () => {
    const { user: tm, token } = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client } = await createClient({ email: 'client@test.com' });
    await createNotebook({ owner_client_id: client.id, created_by: tm.id });

    const res = await request(app)
      .get('/api/tickets/notebooks')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('notebooks');
    expect(res.body.notebooks.length).toBeGreaterThanOrEqual(1);
    expect(res.body.notebooks[0]).toHaveProperty('total_tickets');
  });

  test('403 — client cannot list notebooks', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/tickets/notebooks')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/tickets/notebooks');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/notebooks/:id
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/tickets/notebooks/:id', () => {
  test('200 — returns notebook detail with all 10 tickets', async () => {
    const { user: tm, token } = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client } = await createClient({ email: 'client@test.com' });
    const nb = await createNotebook({ owner_client_id: client.id, created_by: tm.id });

    const res = await request(app)
      .get(`/api/tickets/notebooks/${nb.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('notebook');
    expect(res.body).toHaveProperty('tickets');
    expect(res.body.tickets).toHaveLength(10);
    expect(res.body.tickets[0].status).toBe('available');
  });

  test('404 — non-existent notebook returns 404', async () => {
    const { token } = await createTicketMaster({ email: 'tm@test.com' });
    const fakeId = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .get(`/api/tickets/notebooks/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/my-tickets
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/tickets/my-tickets', () => {
  test('200 — client sees their own available tickets', async () => {
    const { user: tm } = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    await createNotebook({ owner_client_id: client.id, created_by: tm.id });

    const res = await request(app)
      .get('/api/tickets/my-tickets')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tickets');
    expect(res.body.tickets.length).toBe(10);
    expect(res.body.tickets[0].status).toBe('available');
    expect(res.body).toHaveProperty('facial_value');
    expect(res.body).toHaveProperty('currency');
  });

  test('200 — client with no tickets gets empty array', async () => {
    const { token } = await createClient({ email: 'client@test.com' });

    const res = await request(app)
      .get('/api/tickets/my-tickets')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(0);
  });

  test('403 — driver cannot access my-tickets', async () => {
    const { token } = await createDriver({ email: 'driver@test.com' });

    const res = await request(app)
      .get('/api/tickets/my-tickets')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/for-trip/:trip_id
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/tickets/for-trip/:trip_id', () => {
  test('200 — returns required ticket count and available tickets for a pending trip', async () => {
    const { user: tm } = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    await createNotebook({ owner_client_id: client.id, created_by: tm.id });
    const trip = await createTrip({ client_id: client.id });

    const res = await request(app)
      .get(`/api/tickets/for-trip/${trip.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('required_count');
    expect(typeof res.body.required_count).toBe('number');
    expect(res.body.required_count).toBeGreaterThanOrEqual(1);
    expect(res.body).toHaveProperty('available_tickets');
    expect(Array.isArray(res.body.available_tickets)).toBe(true);
  });

  test('404 — non-existent trip returns 404', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const fakeId = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .get(`/api/tickets/for-trip/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/reserve
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/tickets/reserve', () => {
  test('201 — client successfully reserves tickets for a pending trip', async () => {
    const { user: tm }            = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const nb = await createNotebook({ owner_client_id: client.id, created_by: tm.id });

    // Use a low estimated_cost so 2 tickets are always sufficient regardless of
    // the configured facial_value (Math.ceil(2.50 / any_facial_value) <= 2)
    const trip = await createTrip({ client_id: client.id, estimated_cost: 2.50 });

    // ticket_start is a bigint → pg returns it as a string; parseInt before arithmetic
    const start = parseInt(nb.ticket_start, 10);
    const ticketNums = [start, start + 1];

    const res = await request(app)
      .post('/api/tickets/reserve')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id, ticket_numbers: ticketNums });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('payment_id');
    expect(res.body.ticket_numbers).toEqual(ticketNums);
    expect(typeof res.body.total_charged).toBe('number');
  });

  test('422 — insufficient ticket count returns INSUFFICIENT_TICKETS', async () => {
    const { user: tm }            = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const nb = await createNotebook({ owner_client_id: client.id, created_by: tm.id });

    // High estimated_cost — one ticket will never be enough
    const trip = await createTrip({ client_id: client.id, estimated_cost: 100.00 });

    const res = await request(app)
      .post('/api/tickets/reserve')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id, ticket_numbers: [nb.ticket_start] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_TICKETS');
    expect(typeof res.body.required_count).toBe('number');
  });

  test('404 — non-existent trip returns TRIP_NOT_FOUND', async () => {
    const { token } = await createClient({ email: 'client@test.com' });
    const fakeId = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .post('/api/tickets/reserve')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: fakeId, ticket_numbers: [3000000] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TRIP_NOT_FOUND');
  });

  test('400 — missing trip_id returns MISSING_TRIP_ID', async () => {
    const { user: tm }            = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const nb = await createNotebook({ owner_client_id: client.id, created_by: tm.id });

    const res = await request(app)
      .post('/api/tickets/reserve')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticket_numbers: [nb.ticket_start] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_TRIP_ID');
  });

  test('400 — empty ticket_numbers array returns MISSING_TICKETS', async () => {
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const trip = await createTrip({ client_id: client.id });

    const res = await request(app)
      .post('/api/tickets/reserve')
      .set('Authorization', `Bearer ${token}`)
      .send({ trip_id: trip.id, ticket_numbers: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_TICKETS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/tickets/:ticket_number/void
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/tickets/:ticket_number/void', () => {
  test('200 — ticket_master voids an available ticket', async () => {
    const { user: tm, token } = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client }    = await createClient({ email: 'client@test.com' });
    const nb = await createNotebook({ owner_client_id: client.id, created_by: tm.id });
    // ticket_start is bigint → pg returns it as a string; parse before arithmetic
    const ticketNum = parseInt(nb.ticket_start, 10);

    const res = await request(app)
      .patch(`/api/tickets/${ticketNum}/void`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe('voided');
    // ticket_number is bigint → pg/JSON returns it as a string; compare numerically
    expect(parseInt(res.body.ticket.ticket_number, 10)).toBe(ticketNum);
  });

  test('409 — cannot void an already-voided ticket', async () => {
    const { user: tm, token } = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client }    = await createClient({ email: 'client@test.com' });
    const nb = await createNotebook({ owner_client_id: client.id, created_by: tm.id });
    const ticketNum = parseInt(nb.ticket_start, 10);

    // Void once
    await request(app)
      .patch(`/api/tickets/${ticketNum}/void`)
      .set('Authorization', `Bearer ${token}`);

    // Void again
    const res = await request(app)
      .patch(`/api/tickets/${ticketNum}/void`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANNOT_VOID');
  });

  test('409 — cannot void a reserved ticket', async () => {
    const { user: tm, token }             = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client, token: clientToken } = await createClient({ email: 'client@test.com' });
    const nb = await createNotebook({ owner_client_id: client.id, created_by: tm.id });
    const start = parseInt(nb.ticket_start, 10);

    const trip = await createTrip({ client_id: client.id, estimated_cost: 2.50 });
    await request(app)
      .post('/api/tickets/reserve')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ trip_id: trip.id, ticket_numbers: [start, start + 1] });

    // Attempt to void the now-reserved ticket
    const res = await request(app)
      .patch(`/api/tickets/${start}/void`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANNOT_VOID');
  });

  test('404 — non-existent ticket number returns 404', async () => {
    const { token } = await createTicketMaster({ email: 'tm@test.com' });

    const res = await request(app)
      .patch('/api/tickets/9999999/void')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test('403 — client cannot void tickets', async () => {
    const { user: tm }         = await createTicketMaster({ email: 'tm@test.com' });
    const { user: client, token } = await createClient({ email: 'client@test.com' });
    const nb = await createNotebook({ owner_client_id: client.id, created_by: tm.id });
    const ticketNum = parseInt(nb.ticket_start, 10);

    const res = await request(app)
      .patch(`/api/tickets/${ticketNum}/void`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
