/**
 * @file scripts/charge-completed-trips.js
 * @description One-time recovery script to charge all completed trips that have
 * a saved Stripe card (status='authorized') but were never charged because the
 * safeguard ran before Stripe integration was in place.
 *
 * Safe to run multiple times — only processes 'authorized' payments, so already
 * charged (status='paid') or failed (status='failed') rows are skipped.
 *
 * Usage:
 *   cd /opt/solidaroute/backend
 *   node scripts/charge-completed-trips.js
 *
 * Add --dry-run to preview without charging:
 *   node scripts/charge-completed-trips.js --dry-run
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const { chargeTrip } = require('../src/routes/payments');
const { Pool }       = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'solidaroute',
  user:     process.env.DB_USER     || 'solidaroute',
  password: process.env.DB_PASSWORD || '',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  console.log(`\n=== SolidaRoute — Charge recovery script ===`);
  if (DRY_RUN) console.log('DRY RUN — no actual charges will be made\n');

  // Find all completed trips that have an authorized payment (card saved, not yet charged)
  const { rows } = await pool.query(`
    SELECT t.id AS trip_id, t.trip_number,
           t.pickup_address, t.dropoff_address, t.departure_at,
           p.id AS payment_id, p.amount, p.currency
    FROM trips t
    JOIN payments p ON p.trip_id = t.id
    WHERE t.status = 'completed'
      AND p.status = 'authorized'
    ORDER BY t.departure_at ASC
  `);

  if (!rows.length) {
    console.log('No completed trips with pending Stripe charges found. Nothing to do.');
    await pool.end();
    return;
  }

  console.log(`Found ${rows.length} trip(s) to charge:\n`);
  for (const row of rows) {
    console.log(`  T-${row.trip_number} | ${row.departure_at?.toISOString().slice(0,10)} | ${row.amount} ${row.currency} | ${row.pickup_address}`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('Dry run complete — re-run without --dry-run to charge.');
    await pool.end();
    return;
  }

  let succeeded = 0;
  let failed    = 0;

  for (const row of rows) {
    process.stdout.write(`Charging T-${row.trip_number} (${row.amount} ${row.currency})... `);
    try {
      const { error } = await chargeTrip(row.trip_id);
      if (error) {
        console.log(`SKIPPED — ${error.message}`);
        failed++;
      } else {
        console.log(`OK ✓`);
        succeeded++;
      }
    } catch (err) {
      console.log(`ERROR — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Done: ${succeeded} charged, ${failed} skipped/failed ===\n`);
  await pool.end();
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  pool.end();
  process.exit(1);
});
