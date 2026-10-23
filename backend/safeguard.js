/**
 * SolidaRoute — Safeguard Job v11
 *
 * Runs every hour via PM2 cron. Handles:
 *
 * 1. PREFERRED DRIVER TIMEOUT
 *    Trips pending + preferred_driver_id set + preferred_driver_notified_at older
 *    than preferred_driver_response_hours → broadcast to all nearby drivers.
 *
 * 2. BROADCAST REPEAT
 *    Trips pending + broadcast_at set + 24 h since last_broadcast_at
 *    + more than broadcast_cutoff_hours remain before departure
 *    → send another round of broadcast emails to all nearby drivers.
 *    Repeats every 24 h until the cutoff window is reached.
 *
 * 3. BROADCAST TIMEOUT → CANCEL
 *    Trips pending + broadcast_at set + departure_at within broadcast_cutoff_hours
 *    → cancel trip + email client that no driver was found.
 *
 * 4. COMPLETION SAFEGUARD
 *    Trips assigned + departure older than safeguard_delay_hours → auto-complete.
 *
 * 5. ORPHAN TRIP DETECTION
 *    Trips assigned but far past departure → auto-complete + notify admin.
 *
 * 6. MESSAGE CLEANUP
 *    Delete trip messages older than message_retention_days.
 *
 * 7. TOKEN CLEANUP
 *    Delete expired/used verification tokens older than 24 h.
 *
 * 8. DEFERRED TICKET USE
 *    Marks reserved mobility tickets as 'used' after ticket_use_delay_days.
 *
 * 9. DEFERRED CARD CHARGE
 *    Charges saved cards once card_charge_delay_days have elapsed.
 *
 * 10. DEPARTURE REMINDER
 *    Sends a reminder email to both the client and the assigned driver when
 *    departure_at is within reminder_hours_before hours. Fires once per trip
 *    (guarded by trips.reminder_sent_at). Set reminder_hours_before = 0 to disable.
 *
 * PM2 start:
 *   pm2 start safeguard.js --name solidaroute-safeguard --cron "0 * * * *" --no-autorestart
 */

require('dotenv').config({ path: __dirname + '/src/../.env' });
const { Pool } = require('pg');
const {
  sendDriverBroadcast,
  sendTripCancelledNoDriver,
  sendTripReminderClient,
  sendTripReminderDriver,
  sendEmail,
} = require('./src/services/email');
const { resolveEmailLang } = require('./src/utils/lang');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'solidaroute',
  user:     process.env.DB_USER     || 'solidaroute',
  password: process.env.DB_PASSWORD || '',
});

// ── Read configuration values ─────────────────────────────────
async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM configuration
     WHERE key IN (
       'safeguard_delay_hours',
       'preferred_driver_response_hours',
       'broadcast_cutoff_hours',
       'driver_suggestion_radius_km',
       'frontend_language',
       'app_name',
       'contact_email',
       'message_retention_days',
       'ticket_use_delay_days',
       'card_charge_delay_days',
       'reminder_hours_before'
     )`
  );
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });
  // Floor safety-critical integer configs so a misconfigured 0 value cannot
  // trigger immediate auto-completion or flood emails on every hourly run.
  return {
    safeguardDelayHours:    Math.max(1,  parseInt(cfg.safeguard_delay_hours             || '24', 10)),
    preferredResponseHours: Math.max(1,  parseInt(cfg.preferred_driver_response_hours   || '6',  10)),
    broadcastCutoffHours:   Math.max(1,  parseInt(cfg.broadcast_cutoff_hours            || '36', 10)),
    baseRadiusKm:           Math.max(1,  parseFloat(cfg.driver_suggestion_radius_km     || '10')),
    lang:                   cfg.frontend_language || 'both',
    appName:                cfg.app_name    || 'SolidaRoute',
    contactEmail:           cfg.contact_email || 'contact@solidaroute.ca',
    messageRetentionDays:   Math.max(1,  parseInt(cfg.message_retention_days || '90', 10)),
    ticketUseDelayDays:     Math.max(1,  parseInt(cfg.ticket_use_delay_days   ?? '7', 10)),
    cardChargeDelayDays:    Math.max(1,  parseInt(cfg.card_charge_delay_days  ?? '7', 10)),
    reminderHoursBefore:    Math.max(0,  parseInt(cfg.reminder_hours_before   ?? '2', 10)),
  };
}

// ── Shared: find nearby available drivers for a trip ──────────
async function findNearbyDrivers(tripId, radiusKm, excludeDriverId = null) {
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
            COALESCE(dp.preferred_language, 'fr') AS preferred_language
     FROM users u
     JOIN driver_profiles dp ON dp.user_id = u.id
     WHERE dp.approval_status = 'approved'
       AND dp.is_available = TRUE
       AND u.status = 'active'
       AND ($2::int IS NULL OR u.id != $2)
       AND ST_DWithin(
         dp.home_point,
         (SELECT pickup_point FROM trips WHERE id = $1),
         $3 * 1000
       )`,
    [tripId, excludeDriverId, radiusKm]
  );
  return rows;
}

// ── 1. Preferred driver timeout → first broadcast ─────────────
async function handlePreferredDriverTimeout(cfg) {
  const { rows: trips } = await pool.query(
    `SELECT t.*,
       u.first_name AS client_first, u.last_name AS client_last, u.email AS client_email,
       u.phone AS client_phone
     FROM trips t
     JOIN users u ON u.id = t.client_id
     WHERE t.status = 'pending'
       AND t.preferred_driver_id IS NOT NULL
       AND t.preferred_driver_notified_at IS NOT NULL
       AND t.broadcast_at IS NULL
       AND t.preferred_driver_notified_at + ($1 || ' hours')::INTERVAL < NOW()`,
    [cfg.preferredResponseHours]
  );

  if (!trips.length) return;
  console.log(`[SAFEGUARD] ${trips.length} trip(s) past preferred driver window → broadcasting`);

  for (const trip of trips) {
    try {
      await pool.query(
        `UPDATE trips
         SET broadcast_at = NOW(), last_broadcast_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [trip.id]
      );

      const nearbyDrivers = await findNearbyDrivers(trip.id, cfg.baseRadiusKm, trip.preferred_driver_id);

      let emailsSent = 0;
      for (const driver of nearbyDrivers) {
        try {
          await sendDriverBroadcast({
            driver, trip,
            appName:       cfg.appName,
            lang:          resolveEmailLang(cfg.lang, driver.preferred_language || 'fr'),
            responseHours: 24,
            isReminder:    false,
          });
          emailsSent++;
        } catch (e) {
          console.error(`[SAFEGUARD] Email failed for driver ${driver.id}: ${e.message}`);
        }
      }

      await pool.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
         VALUES (NULL, 'trip.broadcast', 'trip', $1, $2)`,
        [trip.id, JSON.stringify({ emails_sent: emailsSent, radius_km: cfg.baseRadiusKm, round: 1 })]
      );

      console.log(`[SAFEGUARD] ✓ Trip ${trip.id} broadcast (round 1) to ${emailsSent} driver(s)`);
    } catch (err) {
      console.error(`[SAFEGUARD] ✗ Broadcast failed for trip ${trip.id}: ${err.message}`);
    }
  }
}

// ── 2. Broadcast repeat — every 24 h until cutoff ─────────────
async function handleBroadcastRepeat(cfg) {
  const { rows: trips } = await pool.query(
    `SELECT t.*
     FROM trips t
     WHERE t.status = 'pending'
       AND t.broadcast_at IS NOT NULL
       AND t.last_broadcast_at + INTERVAL '24 hours' < NOW()
       AND t.departure_at - NOW() > ($1 || ' hours')::INTERVAL`,
    [cfg.broadcastCutoffHours]
  );

  if (!trips.length) return;
  console.log(`[SAFEGUARD] ${trips.length} trip(s) due for repeat broadcast`);

  for (const trip of trips) {
    try {
      await pool.query(
        `UPDATE trips SET last_broadcast_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [trip.id]
      );

      const nearbyDrivers = await findNearbyDrivers(trip.id, cfg.baseRadiusKm);

      let emailsSent = 0;
      for (const driver of nearbyDrivers) {
        try {
          await sendDriverBroadcast({
            driver, trip,
            appName:       cfg.appName,
            lang:          resolveEmailLang(cfg.lang, driver.preferred_language || 'fr'),
            responseHours: 24,
            isReminder:    true,
          });
          emailsSent++;
        } catch (e) {
          console.error(`[SAFEGUARD] Repeat email failed for driver ${driver.id}: ${e.message}`);
        }
      }

      await pool.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
         VALUES (NULL, 'trip.broadcast_repeat', 'trip', $1, $2)`,
        [trip.id, JSON.stringify({ emails_sent: emailsSent, radius_km: cfg.baseRadiusKm })]
      );

      console.log(`[SAFEGUARD] ✓ Trip ${trip.id} repeat broadcast to ${emailsSent} driver(s)`);
    } catch (err) {
      console.error(`[SAFEGUARD] ✗ Repeat broadcast failed for trip ${trip.id}: ${err.message}`);
    }
  }
}

// ── 3. Broadcast timeout → cancel ────────────────────────────
// Fires when departure_at is within broadcast_cutoff_hours and no driver
// has accepted yet. Cancels the trip and emails the client.
async function handleBroadcastTimeout(cfg) {
  const { rows: trips } = await pool.query(
    `SELECT t.*,
       u.first_name AS client_first, u.last_name AS client_last,
       u.email AS client_email
     FROM trips t
     JOIN users u ON u.id = t.client_id
     WHERE t.status = 'pending'
       AND t.broadcast_at IS NOT NULL
       AND t.departure_at - NOW() <= ($1 || ' hours')::INTERVAL`,
    [cfg.broadcastCutoffHours]
  );

  if (!trips.length) return;
  console.log(`[SAFEGUARD] ${trips.length} trip(s) within cutoff window → cancelling`);

  for (const trip of trips) {
    try {
      await pool.query(
        `UPDATE trips
         SET status = 'cancelled',
             cancellation_reason = 'No volunteer driver available within the response window.',
             cancelled_by = NULL,
             updated_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [trip.id]
      );

      await sendTripCancelledNoDriver({
        client: {
          first_name: trip.client_first,
          last_name:  trip.client_last,
          email:      trip.client_email,
        },
        trip,
        appName:      cfg.appName,
        lang:         cfg.lang,
        contactEmail: cfg.contactEmail,
      });

      await pool.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
         VALUES (NULL, 'trip.cancelled_no_driver', 'trip', $1, '{"reason":"no_driver_found"}')`,
        [trip.id]
      );

      console.log(`[SAFEGUARD] ✓ Trip ${trip.id} cancelled — no driver found`);
    } catch (err) {
      console.error(`[SAFEGUARD] ✗ Cancel failed for trip ${trip.id}: ${err.message}`);
    }
  }
}

// ── 4. Completion safeguard ───────────────────────────────────
async function handleAutoComplete(cfg) {
  // Lookback cap: prevents a reduction in safeguard_delay_hours from
  // retroactively sweeping all historical assigned trips on the next run.
  //
  // Rule: only consider trips that departed within the last `cap` hours.
  //   cap = max(delay + 1, 24)
  //
  // The "+1" guarantees at least a 1-hour processing window even when the
  // delay is at its configured value. The floor of 24 h ensures the cap
  // never falls below a full day, matching the platform's same-day trip model.
  //
  // Example: delay=24 h → cap=25 h (window: 24–25 h ago)
  //          delay= 2 h → cap=24 h (window:  2–24 h ago)
  //          delay=30 h → cap=31 h (window: 30–31 h ago)
  const completionCapHours = Math.max(cfg.safeguardDelayHours + 1, 24);

  const { rows: expiredTrips } = await pool.query(
    `SELECT t.id, t.driver_id, t.client_id, t.departure_at,
            t.estimated_cost, t.distance_km, t.passenger_count
     FROM trips t
     WHERE t.status = 'assigned'
       AND t.departure_at + ($1 || ' hours')::INTERVAL < NOW()
       AND t.departure_at > NOW() - ($2 || ' hours')::INTERVAL`,
    [cfg.safeguardDelayHours, completionCapHours]
  );

  if (!expiredTrips.length) return;
  console.log(`[SAFEGUARD] ${expiredTrips.length} assigned trip(s) to auto-complete`);

  let completed = 0;
  for (const trip of expiredTrips) {
    try {
      await pool.query(
        `UPDATE trips
         SET status = 'completed', completed_at = NOW(),
             completion_source = 'safeguard', updated_at = NOW()
         WHERE id = $1 AND status = 'assigned'`,
        [trip.id]
      );

      await pool.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
         VALUES (NULL, 'trip.completed', 'trip', $1, '{"status":"completed","source":"safeguard"}')`,
        [trip.id]
      );

      console.log(`[SAFEGUARD] ✓ Trip ${trip.id} auto-completed`);
      completed++;
    } catch (err) {
      console.error(`[SAFEGUARD] ✗ Auto-complete failed for ${trip.id}: ${err.message}`);
    }
  }
  if (completed) console.log(`[SAFEGUARD] Auto-completed ${completed} trip(s)`);
}

// ── 5. Orphan trip detection ─────────────────────────────────
async function handleOrphanTrips(cfg) {
  const orphanThresholdHours = cfg.safeguardDelayHours * 2;

  // Same lookback cap logic as step 4, scaled to the orphan threshold.
  // Floor is 48 h (2 × the 24 h day minimum) for the same reason.
  const orphanCapHours = Math.max(orphanThresholdHours + 1, 48);

  const { rows: orphans } = await pool.query(
    `SELECT t.*,
       c.first_name AS client_first, c.last_name AS client_last,
       c.email AS client_email,
       d.first_name AS driver_first, d.last_name AS driver_last
     FROM trips t
     JOIN users c ON c.id = t.client_id
     LEFT JOIN users d ON d.id = t.driver_id
     WHERE t.status = 'assigned'
       AND t.departure_at + ($1 || ' hours')::INTERVAL < NOW()
       AND t.departure_at > NOW() - ($2 || ' hours')::INTERVAL`,
    [orphanThresholdHours, orphanCapHours]
  );

  if (!orphans.length) return;
  console.log(`[SAFEGUARD] ⚠ ${orphans.length} orphan trip(s) found`);

  for (const trip of orphans) {
    try {
      await pool.query(
        `UPDATE trips SET status = 'completed', completed_at = NOW(),
         completion_source = 'safeguard', updated_at = NOW()
         WHERE id = $1 AND status = 'assigned'`,
        [trip.id]
      );

      const adminSubject = cfg.lang === 'fr'
        ? `⚠️ ${cfg.appName} — Trajet orphelin détecté (T-${trip.trip_number})`
        : `⚠️ ${cfg.appName} — Orphan trip detected (T-${trip.trip_number})`;
      const adminBody = cfg.lang === 'fr'
        ? `Un trajet assigné est resté bloqué bien après l'heure de départ et a été complété automatiquement.\n\nTrajet : T-${trip.trip_number}\nDépart : ${trip.pickup_address}\nArrivée : ${trip.dropoff_address}\nHeure de départ : ${trip.departure_at}\nConducteur : ${trip.driver_first} ${trip.driver_last}`
        : `An assigned trip remained stuck well past its departure time and was auto-completed.\n\nTrip: T-${trip.trip_number}\nFrom: ${trip.pickup_address}\nTo: ${trip.dropoff_address}\nDeparture: ${trip.departure_at}\nDriver: ${trip.driver_first} ${trip.driver_last}`;

      await sendEmail({
        to:      cfg.contactEmail,
        subject: adminSubject,
        text:    adminBody,
        html:    `<pre style="font-family:sans-serif;">${adminBody}</pre>`,
      });

      await pool.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
         VALUES (NULL, 'trip.orphan_completed', 'trip', $1, '{"source":"safeguard_orphan"}')`,
        [trip.id]
      );

      console.log(`[SAFEGUARD] ✓ Orphan trip ${trip.id} auto-completed and admin notified`);
    } catch (err) {
      console.error(`[SAFEGUARD] ✗ Orphan handling failed for ${trip.id}: ${err.message}`);
    }
  }
}

// ── 6. Message cleanup ───────────────────────────────────────
async function handleMessageCleanup(cfg) {
  if (!cfg.messageRetentionDays) return;
  const { rowCount } = await pool.query(
    `DELETE FROM trip_messages
     WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [cfg.messageRetentionDays]
  );
  if (rowCount > 0) {
    console.log(`[SAFEGUARD] ✓ Deleted ${rowCount} expired message(s)`);
  }
}

// ── 7. Token cleanup ─────────────────────────────────────────
async function handleTokenCleanup() {
  const { rowCount } = await pool.query(
    `DELETE FROM verification_tokens
     WHERE (expires_at < NOW() OR used_at IS NOT NULL)
       AND created_at < NOW() - INTERVAL '24 hours'`
  );
  if (rowCount > 0) {
    console.log(`[SAFEGUARD] ✓ Cleaned up ${rowCount} expired/used token(s)`);
  }
}

// ── 8. Deferred mobility ticket use ──────────────────────────
// Marks reserved mobility tickets as 'used' once ticket_use_delay_days
// have elapsed since trip completion. This gives admins a window to cancel
// a mistakenly completed trip before the tickets are consumed.
async function handleDeferredTicketUse(cfg) {
  // Lookback cap: only process completions within delay + 1 day.
  // Prevents a config reduction from immediately sweeping a large backlog
  // of old completed trips whose tickets were legitimately still pending.
  const ticketCapDays = cfg.ticketUseDelayDays + 1;

  const { rows: payments } = await pool.query(
    `SELECT p.trip_id
     FROM payments p
     JOIN trips t ON t.id = p.trip_id
     WHERE p.status           = 'authorized'
       AND p.payment_method   = 'mobility'
       AND t.status           = 'completed'
       AND t.completed_at + ($1 || ' days')::INTERVAL <= NOW()
       AND t.completed_at     > NOW() - ($2 || ' days')::INTERVAL`,
    [cfg.ticketUseDelayDays, ticketCapDays]
  );

  if (!payments.length) return;
  console.log(`[SAFEGUARD] ${payments.length} mobility ticket payment(s) ready to process`);

  const { chargeTrip } = require('./src/routes/payments');
  for (const { trip_id } of payments) {
    try {
      const { payment, error } = await chargeTrip(trip_id);
      if (payment) {
        console.log(`[SAFEGUARD] ✓ Mobility tickets processed for trip ${trip_id}`);
      } else {
        console.warn(`[SAFEGUARD] ✗ Mobility tickets failed for trip ${trip_id}: ${error?.message}`);
      }
    } catch (err) {
      console.error(`[SAFEGUARD] ✗ Mobility ticket error for trip ${trip_id}: ${err.message}`);
    }
  }
}

// ── 9. Deferred card charge ───────────────────────────────────
// Charges saved cards once card_charge_delay_days have elapsed since trip
// completion. This gives clients a dispute window before they are charged.
async function handleDeferredCardCharge(cfg) {
  // Lookback cap: only process completions within delay + 1 day.
  // Prevents a config reduction from immediately charging cards for a large
  // backlog of old completed trips that were still inside the dispute window.
  const chargeCapDays = cfg.cardChargeDelayDays + 1;

  const { rows: payments } = await pool.query(
    `SELECT p.trip_id
     FROM payments p
     JOIN trips t ON t.id = p.trip_id
     WHERE p.status         = 'authorized'
       AND p.payment_method != 'mobility'
       AND t.status         = 'completed'
       AND t.completed_at + ($1 || ' days')::INTERVAL <= NOW()
       AND t.completed_at   > NOW() - ($2 || ' days')::INTERVAL`,
    [cfg.cardChargeDelayDays, chargeCapDays]
  );

  if (!payments.length) return;
  console.log(`[SAFEGUARD] ${payments.length} card payment(s) ready to charge`);

  const { chargeTrip } = require('./src/routes/payments');
  for (const { trip_id } of payments) {
    try {
      const { payment, error } = await chargeTrip(trip_id);
      if (payment) {
        console.log(`[SAFEGUARD] ✓ Card charged for trip ${trip_id}`);
      } else {
        console.warn(`[SAFEGUARD] ✗ Card charge failed for trip ${trip_id}: ${error?.message}`);
      }
    } catch (err) {
      console.error(`[SAFEGUARD] ✗ Card charge error for trip ${trip_id}: ${err.message}`);
    }
  }
}

// ── 10. Departure reminders ───────────────────────────────────
// Sends reminder emails to client and driver when departure is within
// reminder_hours_before hours. trips.reminder_sent_at prevents duplicates.
// Set reminder_hours_before = 0 in configuration to disable.
async function handleDepartureReminders(cfg) {
  if (!cfg.reminderHoursBefore) return;

  const { rows: trips } = await pool.query(
    `SELECT t.id, t.trip_number,
            t.pickup_address, t.dropoff_address, t.departure_at,
            t.passenger_count, t.return_departure_at,
            c.first_name AS client_first, c.last_name AS client_last,
            c.email AS client_email, c.phone AS client_phone,
            COALESCE(cp.preferred_language, 'fr') AS client_lang,
            d.first_name AS driver_first, d.last_name AS driver_last,
            d.email AS driver_email, d.phone AS driver_phone,
            COALESCE(dp.preferred_language, 'fr') AS driver_lang
     FROM trips t
     JOIN users c ON c.id = t.client_id
     LEFT JOIN client_profiles cp ON cp.user_id = c.id
     LEFT JOIN users d ON d.id = t.driver_id
     LEFT JOIN driver_profiles dp ON dp.user_id = d.id
     WHERE t.status = 'assigned'
       AND t.reminder_sent_at IS NULL
       AND t.departure_at > NOW()
       AND t.departure_at - NOW() <= ($1 || ' hours')::INTERVAL`,
    [cfg.reminderHoursBefore]
  );

  if (!trips.length) return;
  console.log(`[SAFEGUARD] ${trips.length} trip(s) due for departure reminder`);

  for (const row of trips) {
    const trip   = {
      id: row.id, trip_number: row.trip_number,
      pickup_address: row.pickup_address, dropoff_address: row.dropoff_address,
      departure_at: row.departure_at, passenger_count: row.passenger_count,
      return_departure_at: row.return_departure_at,
    };
    const client = { first_name: row.client_first, last_name: row.client_last, email: row.client_email, phone: row.client_phone };
    const driver = row.driver_email
      ? { first_name: row.driver_first, last_name: row.driver_last, email: row.driver_email, phone: row.driver_phone }
      : null;

    try {
      // Language precedence: admin-locked config ('fr'/'en') overrides user preference; fallback to 'fr'
      const clientLang = cfg.lang === 'fr' ? 'fr' : cfg.lang === 'en' ? 'en' : (row.client_lang || 'fr');
      await sendTripReminderClient({ client, driver, trip, appName: cfg.appName, lang: clientLang, contactEmail: cfg.contactEmail });
      console.log(`[SAFEGUARD] ✓ Reminder sent to client for trip ${row.id}`);
    } catch (err) {
      console.error(`[SAFEGUARD] ✗ Client reminder failed for trip ${row.id}: ${err.message}`);
    }

    if (driver) {
      try {
        // Same language precedence as client: config lock → user preference → 'fr'
        const driverLang = cfg.lang === 'fr' ? 'fr' : cfg.lang === 'en' ? 'en' : (row.driver_lang || 'fr');
        await sendTripReminderDriver({ driver, client, trip, appName: cfg.appName, lang: driverLang, contactEmail: cfg.contactEmail });
        console.log(`[SAFEGUARD] ✓ Reminder sent to driver for trip ${row.id}`);
      } catch (err) {
        console.error(`[SAFEGUARD] ✗ Driver reminder failed for trip ${row.id}: ${err.message}`);
      }
    }

    // Mark reminder as sent regardless of individual email errors — avoids retry storms
    // on subsequent hourly runs even if one of the two sends failed.
    await pool.query(
      `UPDATE trips SET reminder_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
  }
}

// ── Main ──────────────────────────────────────────────────────
async function runSafeguard() {
  console.log(`[${new Date().toISOString()}] [SAFEGUARD] Starting...`);
  try {
    const cfg = await getConfig();
    console.log(`[SAFEGUARD] Config: preferredResponseHours=${cfg.preferredResponseHours}h, broadcastCutoffHours=${cfg.broadcastCutoffHours}h, safeguardDelay=${cfg.safeguardDelayHours}h, reminderHoursBefore=${cfg.reminderHoursBefore}h, lang=${cfg.lang}`);

    await handlePreferredDriverTimeout(cfg);
    await handleBroadcastRepeat(cfg);
    await handleBroadcastTimeout(cfg);
    await handleAutoComplete(cfg);
    await handleOrphanTrips(cfg);
    await handleMessageCleanup(cfg);
    await handleTokenCleanup();
    await handleDeferredTicketUse(cfg);
    await handleDeferredCardCharge(cfg);
    await handleDepartureReminders(cfg);

    console.log(`[SAFEGUARD] Done.`);
  } catch (err) {
    console.error(`[SAFEGUARD] Fatal: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runSafeguard();
