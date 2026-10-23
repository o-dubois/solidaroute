/**
 * Test database helpers — shared across all test suites.
 *
 * Uses the same pool.js instance as the app so there is only one connection
 * pool per test worker. The pool is left open until Jest force-exits (--forceExit).
 *
 * Available helpers:
 *   resetDb()           — truncate transactional tables + re-seed superadmin
 *   createUser(opts)    — insert a user directly in the DB, return { user, token }
 *   createClient(opts)  — createUser + client_profile row
 *   createDriver(opts)  — createUser + driver_profile row (approved, available)
 *   getSuperadminToken()— JWT for the protected admin@solidaroute.ca account
 */
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { pool } = require('../../src/db/pool');

// Superadmin seed — must match globalSetup.js
const SUPERADMIN_HASH = '$2b$12$ldNjKVTQF.rDIoScsmG4EuLKceeNvUCJoCWgCtkwGejV8Cu.9xMtW';

// Montreal city centre — used as default home_point for test drivers
const MONTREAL_POINT = 'ST_SetSRID(ST_MakePoint(-73.5674, 45.5017), 4326)::geography';

/**
 * Wipes all transactional tables and re-seeds the superadmin.
 * Call in beforeEach() to guarantee a clean slate for every test.
 */
async function resetDb() {
  await pool.query(`
    TRUNCATE TABLE
      trip_messages,
      trip_driver_actions,
      reviews,
      notifications,
      driver_documents,
      driver_earnings,
      payments,
      mobility_tickets,
      ticket_notebooks,
      trips,
      audit_logs,
      config_change_requests,
      verification_tokens,
      driver_profiles,
      client_profiles,
      users
    RESTART IDENTITY CASCADE
  `);

  await pool.query(`
    INSERT INTO users (
      first_name, last_name, email, password_hash,
      role, status, email_verified, is_protected
    ) VALUES (
      'Super', 'Admin', 'admin@solidaroute.ca', $1,
      'superadmin', 'active', TRUE, TRUE
    ) ON CONFLICT (email) DO NOTHING
  `, [SUPERADMIN_HASH]);
}

/**
 * Insert a user directly in the database.
 * Bypasses registration flow — useful when testing routes that require an
 * already-existing, verified user rather than testing registration itself.
 *
 * Bcrypt cost is 4 (minimum) to keep tests fast.
 *
 * @returns {{ user: object, token: string }}
 */
async function createUser({
  first_name     = 'Test',
  last_name      = 'User',
  email          = 'user@test.com',
  password       = 'Password1!',
  phone          = null,   // null avoids unique collisions when multiple users share a test
  role           = 'client',
  status         = 'active',
  email_verified = true,
} = {}) {
  const hash = await bcrypt.hash(password, 4);

  const { rows } = await pool.query(`
    INSERT INTO users
      (first_name, last_name, email, password_hash, phone, role, status, email_verified)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, email, role, status
  `, [first_name, last_name, email, hash, phone, role, status, email_verified]);

  const user  = rows[0];
  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  return { user, token };
}

/**
 * Create a verified, active client with a minimal client_profile row.
 */
async function createClient(overrides = {}) {
  const { user, token } = await createUser({ ...overrides, role: 'client' });

  await pool.query(`
    INSERT INTO client_profiles (user_id, preferred_language)
    VALUES ($1, 'fr')
    ON CONFLICT (user_id) DO NOTHING
  `, [user.id]);

  return { user, token };
}

/**
 * Create a verified, approved driver with a minimal driver_profile row.
 * The driver is available and located at Montreal city centre.
 */
async function createDriver(overrides = {}) {
  const { user, token } = await createUser({ ...overrides, role: 'driver' });

  await pool.query(`
    INSERT INTO driver_profiles (
      user_id,
      vehicle_make, vehicle_model, vehicle_year, license_plate,
      seat_count, service_radius_km,
      home_point,
      approval_status, is_available,
      preferred_language
    ) VALUES (
      $1,
      'Toyota', 'Corolla', 2020, 'TEST-001',
      4, 25,
      ${MONTREAL_POINT},
      'approved', TRUE,
      'fr'
    ) ON CONFLICT (user_id) DO NOTHING
  `, [user.id]);

  return { user, token };
}

/**
 * Generate a JWT for the protected superadmin account.
 * Reads the real UUID from the DB so the token matches the stored user.
 */
async function getSuperadminToken() {
  const { rows } = await pool.query(
    "SELECT id FROM users WHERE email = 'admin@solidaroute.ca'"
  );
  if (!rows.length) throw new Error('Superadmin not found — did you call resetDb()?');

  return jwt.sign(
    { id: rows[0].id, role: 'superadmin' },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );
}

/**
 * Insert a trip directly in the database.
 * Coordinates default to a short Longueuil → Montreal route so OSRM tests
 * produce meaningful distances.
 *
 * Pass status='assigned' + driver_id to set up a trip that is ready to complete.
 */
async function createTrip({
  client_id,
  driver_id            = null,
  status               = 'pending',
  departure_at         = null,   // defaults to 72 h from now (clears min_trip_lead_hours)
  passenger_count      = 1,
  pickup_address       = '3120 Boulevard Taschereau, Greenfield Park, QC',
  pickup_lat           = 45.4654,
  pickup_lon           = -73.4684,
  dropoff_address      = '1000 Rue Saint-Denis, Montréal, QC',
  dropoff_lat          = 45.5188,
  dropoff_lon          = -73.5636,
  preferred_driver_id  = null,
  distance_km          = 12.5,
  estimated_cost       = 13.13,
} = {}) {
  const depart = departure_at
    ? new Date(departure_at)
    : new Date(Date.now() + 72 * 3600 * 1000);

  const { rows } = await pool.query(`
    INSERT INTO trips (
      client_id, driver_id,
      pickup_address,  pickup_point,
      dropoff_address, dropoff_point,
      departure_at, passenger_count,
      status, preferred_driver_id,
      distance_km, estimated_cost
    ) VALUES (
      $1,  $2,
      $3,  ST_SetSRID(ST_MakePoint($5, $4),  4326)::geography,
      $6,  ST_SetSRID(ST_MakePoint($8, $7),  4326)::geography,
      $9,  $10,
      $11, $12,
      $13, $14
    ) RETURNING id, trip_number, status, departure_at
  `, [
    client_id, driver_id,
    pickup_address,  pickup_lat,  pickup_lon,
    dropoff_address, dropoff_lat, dropoff_lon,
    depart.toISOString(), passenger_count,
    status, preferred_driver_id,
    distance_km, estimated_cost,
  ]);

  return rows[0];
}

/** Create an active operator user. */
async function createOperator(overrides = {}) {
  return createUser({ ...overrides, role: 'operator', status: 'active' });
}

/** Create an active ticket_master user. */
async function createTicketMaster(overrides = {}) {
  return createUser({ ...overrides, role: 'ticket_master', status: 'active' });
}

/**
 * Insert a ticket notebook directly in the DB with 10 available mobility tickets.
 * Requires an existing client user or org name as owner.
 */
async function createNotebook({
  owner_client_id = null,
  owner_type      = 'client',
  org_name        = null,
  created_by,        // required: user id of the creator (ticket_master)
  facial_value    = 10.00,
  currency        = 'CAD',
} = {}) {
  // Unique 6-char key using timestamp tail
  const notebook_key  = Math.random().toString(36).slice(2, 8).toUpperCase();
  // ticket_start must be >= 3,000,000 per business rule
  const ticket_start  = 3000000 + Math.floor(Math.random() * 1000000);

  const { rows: nb } = await pool.query(`
    INSERT INTO ticket_notebooks
      (owner_type, owner_client_id, org_name, notebook_key, ticket_start,
       facial_value, currency, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, notebook_number, notebook_key, ticket_start
  `, [owner_type, owner_client_id, org_name, notebook_key, ticket_start,
      facial_value, currency, created_by]);

  const notebook = nb[0];

  // ticket_start is returned as a string by pg (bigint column) — parse to int
  // before arithmetic to avoid string concatenation ("3000000" + 1 = "30000001").
  const ticketStart = parseInt(notebook.ticket_start, 10);

  // Insert 10 tickets for this notebook
  const ticketValues = Array.from({ length: 10 }, (_, i) =>
    `('${notebook.id}', ${ticketStart + i}, 'available')`
  ).join(', ');

  await pool.query(`
    INSERT INTO mobility_tickets (notebook_id, ticket_number, status)
    VALUES ${ticketValues}
  `);

  return notebook;
}

module.exports = {
  resetDb,
  createUser, createClient, createDriver, createOperator, createTicketMaster,
  createTrip, createNotebook,
  getSuperadminToken,
};
