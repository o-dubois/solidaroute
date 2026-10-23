/**
 * @file scripts/payment-job.js
 * @description Scheduled payment job for SolidaRoute.
 *
 * Runs every 15 minutes via PM2 cron. Handles all payment charging independently
 * of the safeguard, which manages only trip lifecycle (completion, cancellation).
 *
 * Responsibilities:
 *   1. Charge completed trips with an 'authorized' payment (card saved at booking)
 *   2. Retry completed trips with a 'failed' payment (up to payment_max_retries)
 *   3. Create a manual payment record for completed trips with no payment row
 *      (fallback for operator-booked trips)
 *   4. When max retries is reached: email the driver + all admins/operators
 *
 * Email policy (per user preference):
 *   - Send email ONLY when max retries is reached (not on every failure)
 *   - Successful retries are silent
 *
 * PM2 start:
 *   pm2 start scripts/payment-job.js \
 *     --name solidaroute-payments \
 *     --cron "* /15 * * * *" \
 *     --no-autorestart
 *
 * Safe to run manually at any time:
 *   node scripts/payment-job.js
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const { Pool }        = require('pg');
const { chargeTrip }  = require('../src/routes/payments');
const {
  sendPaymentFailedDriver,
  sendPaymentFailedAdmins,
} = require('../src/services/email');
const { logger }      = require('../src/utils/logger');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'solidaroute',
  user:     process.env.DB_USER     || 'solidaroute',
  password: process.env.DB_PASSWORD || '',
});

// ── Read configuration ────────────────────────────────────────────────────────
async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM configuration
     WHERE key IN ('payment_max_retries','driver_share_percent','payment_currency',
                   'app_name','contact_email','frontend_language')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    maxRetries:    parseInt(cfg.payment_max_retries  ?? '3',  10),
    driverPct:     parseFloat(cfg.driver_share_percent ?? '75') / 100,
    currency:      cfg.payment_currency   ?? 'CAD',
    appName:       cfg.app_name           ?? 'SolidaRoute',
    contactEmail:  cfg.contact_email      ?? 'contact@solidaroute.ca',
    lang:          cfg.frontend_language  ?? 'both',
  };
}

// ── Fetch all admin/operator email addresses ──────────────────────────────────
async function getAdmins() {
  const { rows } = await pool.query(
    `SELECT email FROM users
     WHERE role IN ('operator','superadmin') AND status = 'active'`
  );
  return rows; // [{ email }]
}

// ── Handle a charge failure: increment retry_count, email if max reached ─────
async function handleChargeFailure({ payment, trip, client, driver, cfg, admins, errorMsg }) {
  const newRetryCount = (payment.retry_count || 0) + 1;

  await pool.query(
    `UPDATE payments SET retry_count = $1, updated_at = NOW() WHERE id = $2`,
    [newRetryCount, payment.id]
  );

  logger.warn('Payment job: charge failed', {
    tripId:      trip.id,
    tripNumber:  trip.trip_number,
    paymentId:   payment.id,
    retryCount:  newRetryCount,
    maxRetries:  cfg.maxRetries,
    error:       errorMsg,
  });

  // Send notifications only when max retries is reached (not on every failure)
  if (newRetryCount >= cfg.maxRetries) {
    const emailLang = cfg.lang === 'fr' ? 'fr' : 'en';

    // Notify the driver
    if (driver?.email) {
      try {
        await sendPaymentFailedDriver({
          driver,
          trip,
          amount:       payment.amount,
          currency:     payment.currency,
          appName:      cfg.appName,
          lang:         emailLang,
          contactEmail: cfg.contactEmail,
        });
        logger.info('Payment job: failure email sent to driver', { driverEmail: driver.email });
      } catch (emailErr) {
        logger.error('Payment job: failed to email driver', { error: emailErr.message });
      }
    }

    // Notify all admins/operators
    if (admins.length) {
      try {
        await sendPaymentFailedAdmins({
          admins,
          trip,
          client,
          driver,
          amount:      payment.amount,
          currency:    payment.currency,
          appName:     cfg.appName,
          lang:        emailLang,
          retryCount:  newRetryCount,
          maxRetries:  cfg.maxRetries,
          errorMsg,
        });
        logger.info('Payment job: failure email sent to admins', { count: admins.length });
      } catch (emailErr) {
        logger.error('Payment job: failed to email admins', { error: emailErr.message });
      }
    }

    logger.warn('Payment job: max retries reached — no further attempts', {
      tripId:    trip.id,
      paymentId: payment.id,
    });
  }
}

// ── Round 1: Charge authorized payments ──────────────────────────────────────
async function chargeAuthorized(cfg, admins) {
  const { rows } = await pool.query(
    `SELECT p.*,
            t.trip_number, t.pickup_address, t.dropoff_address, t.departure_at,
            t.driver_id,
            c.first_name AS client_first, c.last_name AS client_last,
            c.email AS client_email,
            d.first_name AS driver_first, d.last_name AS driver_last,
            d.email AS driver_email
     FROM payments p
     JOIN trips t ON t.id = p.trip_id
     JOIN users c ON c.id = t.client_id
     LEFT JOIN users d ON d.id = t.driver_id
     WHERE t.status = 'completed' AND p.status = 'authorized'
     ORDER BY t.departure_at ASC`
  );

  if (!rows.length) return;
  logger.info(`Payment job: ${rows.length} authorized payment(s) to charge`);

  for (const row of rows) {
    const trip   = { id: row.trip_id, trip_number: row.trip_number,
                     pickup_address: row.pickup_address, dropoff_address: row.dropoff_address,
                     departure_at: row.departure_at, driver_id: row.driver_id };
    const client = { first_name: row.client_first, last_name: row.client_last, email: row.client_email };
    const driver = row.driver_id
      ? { first_name: row.driver_first, last_name: row.driver_last, email: row.driver_email }
      : null;

    logger.info('Payment job: charging authorized payment', {
      tripId: row.trip_id, tripNumber: row.trip_number, amount: row.amount, currency: row.currency,
    });

    const { payment: charged, error: chargeErr } = await chargeTrip(row.trip_id);

    if (chargeErr) {
      await handleChargeFailure({
        payment:  row,
        trip,
        client,
        driver,
        cfg,
        admins,
        errorMsg: chargeErr.message,
      });
    } else {
      logger.info('Payment job: charge succeeded', {
        tripId: row.trip_id, tripNumber: row.trip_number,
        paymentId: charged.id, amount: charged.amount,
      });
    }
  }
}

// ── Round 2: Retry failed payments ───────────────────────────────────────────
async function retryFailed(cfg, admins) {
  const { rows } = await pool.query(
    `SELECT p.*,
            t.trip_number, t.pickup_address, t.dropoff_address, t.departure_at,
            t.driver_id,
            c.first_name AS client_first, c.last_name AS client_last,
            c.email AS client_email,
            d.first_name AS driver_first, d.last_name AS driver_last,
            d.email AS driver_email
     FROM payments p
     JOIN trips t ON t.id = p.trip_id
     JOIN users c ON c.id = t.client_id
     LEFT JOIN users d ON d.id = t.driver_id
     WHERE t.status = 'completed'
       AND p.status = 'failed'
       AND p.retry_count < $1
     ORDER BY t.departure_at ASC`,
    [cfg.maxRetries]
  );

  if (!rows.length) return;
  logger.info(`Payment job: ${rows.length} failed payment(s) eligible for retry`);

  for (const row of rows) {
    const trip   = { id: row.trip_id, trip_number: row.trip_number,
                     pickup_address: row.pickup_address, dropoff_address: row.dropoff_address,
                     departure_at: row.departure_at, driver_id: row.driver_id };
    const client = { first_name: row.client_first, last_name: row.client_last, email: row.client_email };
    const driver = row.driver_id
      ? { first_name: row.driver_first, last_name: row.driver_last, email: row.driver_email }
      : null;

    // Reset status to 'authorized' temporarily so chargeTrip() can find the payment
    await pool.query(
      `UPDATE payments SET status = 'authorized', updated_at = NOW() WHERE id = $1`,
      [row.id]
    );

    logger.info('Payment job: retrying failed payment', {
      tripId: row.trip_id, tripNumber: row.trip_number,
      retryCount: row.retry_count, maxRetries: cfg.maxRetries,
    });

    const { payment: charged, error: chargeErr } = await chargeTrip(row.trip_id);

    if (chargeErr) {
      // chargeTrip() already set status back to 'failed'; update retry_count
      await handleChargeFailure({
        payment:  { ...row, retry_count: row.retry_count }, // use current count; handleChargeFailure increments it
        trip,
        client,
        driver,
        cfg,
        admins,
        errorMsg: chargeErr.message,
      });
    } else {
      logger.info('Payment job: retry succeeded', {
        tripId: row.trip_id, tripNumber: row.trip_number,
        paymentId: charged.id, amount: charged.amount,
      });
    }
  }
}

// ── Round 3: Manual fallback for trips with no payment row ───────────────────
// Covers operator-booked trips where no Stripe payment was ever set up.
async function createManualFallbacks(cfg) {
  const { rows } = await pool.query(
    `SELECT t.id, t.trip_number, t.driver_id, t.estimated_cost
     FROM trips t
     WHERE t.status = 'completed'
       AND NOT EXISTS (
         SELECT 1 FROM payments p WHERE p.trip_id = t.id
       )`
  );

  if (!rows.length) return;
  logger.info(`Payment job: ${rows.length} completed trip(s) with no payment record — creating manual fallback`);

  for (const trip of rows) {
    try {
      const totalAmt    = parseFloat(trip.estimated_cost || 0);
      const driverAmt   = Math.round(totalAmt * cfg.driverPct * 100) / 100;
      const platAmt     = Math.round(totalAmt * (1 - cfg.driverPct) * 100) / 100;

      const { rows: payRows } = await pool.query(
        `INSERT INTO payments
           (trip_id, provider, payment_method, amount, driver_share, platform_fee, currency, status, paid_at)
         VALUES ($1, 'manual', 'manual', $2, $3, $4, $5, 'paid', NOW())
         RETURNING id`,
        [trip.id, totalAmt, driverAmt, platAmt, cfg.currency]
      );

      if (payRows.length && trip.driver_id) {
        await pool.query(
          `INSERT INTO driver_earnings (driver_id, trip_id, payment_id, amount, currency, status)
           VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT DO NOTHING`,
          [trip.driver_id, trip.id, payRows[0].id, driverAmt, cfg.currency]
        );
      }

      logger.info('Payment job: manual fallback created', {
        tripId: trip.id, tripNumber: trip.trip_number, amount: totalAmt,
      });
    } catch (err) {
      logger.error('Payment job: failed to create manual fallback', {
        tripId: trip.id, error: err.message,
      });
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  logger.info('Payment job: starting');

  try {
    const cfg    = await getConfig();
    const admins = await getAdmins();

    logger.info('Payment job: config loaded', {
      maxRetries: cfg.maxRetries, currency: cfg.currency, adminCount: admins.length,
    });

    await chargeAuthorized(cfg, admins);
    await retryFailed(cfg, admins);
    await createManualFallbacks(cfg);

    logger.info('Payment job: done');
  } catch (err) {
    logger.error('Payment job: fatal error', { error: err.message });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
