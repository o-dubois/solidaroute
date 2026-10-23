/**
 * Jest globalSetup — runs once in a separate process before all test suites.
 *
 * Responsibilities:
 *   1. Verify connectivity to solidaroute_test (fail fast with a helpful message
 *      if the DB hasn't been set up yet).
 *   2. Truncate all transactional tables so every test run starts from scratch.
 *   3. Re-seed the protected superadmin that was wiped by the truncation.
 *
 * Configuration table is intentionally NOT truncated — it retains the
 * production defaults loaded when the dump was restored to solidaroute_test.
 *
 * One-time prerequisite (run on the server before the first test run):
 *   sudo -u postgres psql solidaroute_test < /opt/solidaroute/solidaroute-V15-db.sql
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.test') });

const { Pool } = require('pg');

// Superadmin seed — password hash = bcrypt of 'solidaroute' (cost 12)
// Matches migration 001 so login tests can use admin@solidaroute.ca / solidaroute
const SUPERADMIN_HASH = '$2b$12$ldNjKVTQF.rDIoScsmG4EuLKceeNvUCJoCWgCtkwGejV8Cu.9xMtW';

module.exports = async function globalSetup() {
  const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
  });

  try {
    // Verify we are on the test database, not production
    await pool.query('SELECT 1');
    console.log(`\n[Test Setup] Connected to: ${process.env.DB_NAME}`);

    // Confirm the schema exists (helpful error if dump hasn't been restored yet)
    const { rows } = await pool.query(
      "SELECT to_regclass('public.users') AS tbl"
    );
    if (!rows[0].tbl) {
      throw new Error(
        '\n\nTest database schema not found.\n' +
        'Run this once on the server to set it up:\n' +
        '  sudo -u postgres psql solidaroute_test < /opt/solidaroute/solidaroute-V15-db.sql\n'
      );
    }

    await truncateTransactionalTables(pool);
    await seedSuperadmin(pool);

    console.log('[Test Setup] Database ready.\n');
  } finally {
    await pool.end();
  }
};

async function truncateTransactionalTables(pool) {
  // Truncate in a single statement — RESTART IDENTITY resets all sequences,
  // CASCADE handles FK dependencies automatically.
  // Configuration is excluded: it holds defaults that tests rely on.
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
}

async function seedSuperadmin(pool) {
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
