'use strict';
/**
 * Creates the initial superadmin account on a fresh installation.
 *
 * Usage (run from /opt/solidaroute/backend):
 *   node scripts/create-superadmin.js <email> <password>
 *
 * Example:
 *   node scripts/create-superadmin.js admin@example.com MyPassword123!
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: node scripts/create-superadmin.js <email> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'solidaroute',
  user:     process.env.DB_USER     || 'solidaroute',
  password: process.env.DB_PASSWORD,
});

async function run() {
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `INSERT INTO users
       (email, password_hash, first_name, last_name, phone,
        role, status, email_verified, is_protected)
     VALUES ($1, $2, 'Admin', 'SolidaRoute', '+10000000000',
             'superadmin', 'active', true, true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash
     RETURNING email`,
    [email, hash]
  );
  console.log('Superadmin ready:', rows[0].email);
  await pool.end();
}

run().catch(err => { console.error(err.message); process.exit(1); });
