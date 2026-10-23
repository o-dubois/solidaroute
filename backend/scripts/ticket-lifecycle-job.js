/**
 * ticket-lifecycle-job.js
 *
 * Background job that advances the mobility ticket lifecycle in two steps:
 *
 *   Job 1 — reserved → used
 *     Finds mobility tickets that are still 'reserved' for trips that were
 *     completed more than `ticket_use_delay_days` days ago, and marks them
 *     as 'used'. This delay gives administrators time to cancel a completed
 *     trip in error before the ticket is permanently consumed.
 *
 *   Job 2 — used → paid_out
 *     Finds mobility tickets that have been 'used' for more than
 *     `ticket_payout_delay_days` days, and marks them as 'paid_out'.
 *     This represents the end of the payout pipeline — actual payment to
 *     drivers happens outside the application (e.g. bank transfer, cheque).
 *
 * Scheduling:
 *   Run this script daily via cron or PM2 scheduled restart, e.g.:
 *     0 2 * * * /usr/bin/node /opt/solidaroute/backend/scripts/ticket-lifecycle-job.js
 *
 * Configuration (from the `configuration` DB table, editable in the admin panel):
 *   ticket_use_delay_days    — default 7
 *   ticket_payout_delay_days — default 30
 */

// Load environment variables from .env (path relative to this script's location)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { pool }   = require('../src/db/pool');
const { logger } = require('../src/utils/logger');

async function run() {
  logger.info('ticket-lifecycle-job: starting');

  try {
    // ── Read config ──────────────────────────────────────────────────────────
    const { rows: cfgRows } = await pool.query(
      `SELECT key, value FROM configuration
       WHERE key IN ('ticket_use_delay_days', 'ticket_payout_delay_days')`
    );
    const cfg = Object.fromEntries(cfgRows.map(r => [r.key, parseInt(r.value, 10)]));
    const useDelay    = Number.isFinite(cfg.ticket_use_delay_days)    ? cfg.ticket_use_delay_days    : 7;
    const payoutDelay = Number.isFinite(cfg.ticket_payout_delay_days) ? cfg.ticket_payout_delay_days : 30;

    logger.info('ticket-lifecycle-job: config loaded', { useDelay, payoutDelay });

    // ── Job 1: reserved → used ───────────────────────────────────────────────
    // Only tickets tied to trips that completed strictly more than N days ago.
    const { rows: usedRows } = await pool.query(
      `UPDATE mobility_tickets
       SET status = 'used', used_at = NOW()
       WHERE status = 'reserved'
         AND trip_id IN (
           SELECT id FROM trips
           WHERE status = 'completed'
             AND completed_at <= NOW() - ($1 || ' days')::INTERVAL
         )
       RETURNING id, ticket_number`,
      [useDelay]
    );

    logger.info(`ticket-lifecycle-job: ${usedRows.length} ticket(s) marked as used`, {
      tickets: usedRows.map(r => r.ticket_number),
    });

    // ── Job 2: used → paid_out ───────────────────────────────────────────────
    const { rows: paidRows } = await pool.query(
      `UPDATE mobility_tickets
       SET status = 'paid_out', paid_out_at = NOW()
       WHERE status = 'used'
         AND used_at <= NOW() - ($1 || ' days')::INTERVAL
       RETURNING id, ticket_number`,
      [payoutDelay]
    );

    logger.info(`ticket-lifecycle-job: ${paidRows.length} ticket(s) marked as paid_out`, {
      tickets: paidRows.map(r => r.ticket_number),
    });

    logger.info('ticket-lifecycle-job: completed successfully');
  } catch (err) {
    logger.error('ticket-lifecycle-job: fatal error', { message: err.message, stack: err.stack });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
