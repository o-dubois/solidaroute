/**
 * @file routes/messages.js
 * @description In-app messaging between a trip's driver and client.
 *
 * All routes require authentication. Only the trip's client_id and driver_id
 * may read or send messages — no operator/admin access by design.
 *
 * Reply window:
 *   Active trips (pending / assigned): always open.
 *   Closed trips (completed / cancelled): open for `message_reply_window_days`
 *   days after trips.updated_at. Configurable in the admin configuration panel.
 *
 * Route summary:
 *   GET  /unread-count      — total unread count for the nav badge
 *   GET  /                  — list all conversations (grouped by trip, newest first)
 *   GET  /trip/:trip_id     — full thread for one trip + marks messages as read
 *   POST /trip/:trip_id     — send a message (500-char limit)
 *
 * Mounted at: /api/messages  (see index.js)
 */

const express = require('express');
const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { sendTripMessage } = require('../services/email');
const { logger }       = require('../utils/logger');
const { maskLastName } = require('../utils/namePrivacy');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────

/**
 * Fetches a trip and checks whether the given user is a participant
 * (client_id or driver_id). Joins user rows for both parties so that
 * email notifications can be sent without a second query.
 *
 * @param {number} tripId
 * @param {number} userId
 * @returns {{ trip: object|null, isParticipant: boolean }}
 */
async function getTripAndParticipant(tripId, userId) {
  const { rows } = await pool.query(
    `SELECT
       t.id, t.trip_number, t.status, t.updated_at,
       t.pickup_address, t.dropoff_address,
       t.client_id, t.driver_id,
       uc.first_name  AS client_first,  uc.last_name  AS client_last,
       uc.email       AS client_email,
       COALESCE(cp.preferred_language, 'fr') AS client_lang,
       ud.first_name  AS driver_first,  ud.last_name  AS driver_last,
       ud.email       AS driver_email,
       COALESCE(dp.preferred_language, 'fr') AS driver_lang
     FROM trips t
     JOIN  users uc ON uc.id = t.client_id
     LEFT JOIN client_profiles cp ON cp.user_id = t.client_id
     LEFT JOIN users ud ON ud.id = t.driver_id
     LEFT JOIN driver_profiles dp ON dp.user_id = t.driver_id
     WHERE t.id = $1`,
    [tripId]
  );
  if (!rows.length) return { trip: null, isParticipant: false };
  const trip = rows[0];
  const isParticipant = trip.client_id === userId || trip.driver_id === userId;
  return { trip, isParticipant };
}

/**
 * Returns true if the reply window is currently open for the given trip.
 * Active trips are always open; closed trips are open for `message_reply_window_days`.
 *
 * @param {object} trip - Trip row from DB (requires status, updated_at)
 * @returns {Promise<{ open: boolean, windowDays: number }>}
 */
async function replyWindowStatus(trip) {
  if (['pending', 'assigned'].includes(trip.status)) {
    return { open: true, windowDays: null };
  }
  const { rows } = await pool.query(
    `SELECT value FROM configuration WHERE key = 'message_reply_window_days'`
  );
  const windowDays = parseInt(rows[0]?.value ?? '30', 10);
  const closedAt   = new Date(trip.updated_at);
  closedAt.setDate(closedAt.getDate() + windowDays);
  return { open: new Date() <= closedAt, windowDays };
}

// ── GET /api/messages/unread-count ────────────────────────────

/**
 * Returns the total number of unread messages for the current user across
 * all trips. Used by the nav badge and polled every 30 s by the Layout.
 * Auth: any authenticated user (non-participants simply get 0).
 */
router.get('/unread-count', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count
       FROM trip_messages tm
       JOIN trips t ON t.id = tm.trip_id
       WHERE (t.client_id = $1 OR t.driver_id = $1)
         AND tm.sender_id <> $1
         AND tm.read_at IS NULL`,
      [req.user.id]
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) { next(err); }
});

// ── GET /api/messages ─────────────────────────────────────────

/**
 * Lists all conversations the current user participates in.
 * Only trips that have at least one message are returned.
 * Ordered by latest message timestamp (newest first).
 *
 * Each row includes:
 *   trip_id, trip_number, status, pickup_address, dropoff_address,
 *   client_id, driver_id, client_first, client_last, driver_first, driver_last,
 *   last_body, last_sender_id, last_created_at, unread_count
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         t.id           AS trip_id,
         t.trip_number,
         t.status,
         t.pickup_address,
         t.dropoff_address,
         t.client_id,
         t.driver_id,
         uc.first_name  AS client_first,
         uc.last_name   AS client_last,
         ud.first_name  AS driver_first,
         ud.last_name   AS driver_last,
         lm.body        AS last_body,
         lm.sender_id   AS last_sender_id,
         lm.created_at  AS last_created_at,
         COALESCE(unread.cnt, 0) AS unread_count
       FROM trips t
       JOIN  users uc ON uc.id = t.client_id
       LEFT JOIN users ud ON ud.id = t.driver_id
       -- INNER JOIN to the latest message — excludes trips with no messages
       JOIN LATERAL (
         SELECT body, sender_id, created_at
         FROM trip_messages
         WHERE trip_id = t.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON TRUE
       -- Unread count: messages from the other party not yet read
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt
         FROM trip_messages
         WHERE trip_id = t.id
           AND sender_id <> $1
           AND read_at IS NULL
       ) unread ON TRUE
       WHERE (t.client_id = $1 OR t.driver_id = $1)
       ORDER BY lm.created_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: rows });
  } catch (err) { next(err); }
});

// ── GET /api/messages/trip/:trip_id ──────────────────────────

/**
 * Returns the full message thread for a trip (newest first) and marks all
 * incoming messages as read. Also returns trip metadata and whether the
 * reply window is currently open.
 *
 * Auth: trip's client_id or driver_id only.
 * Returns: { trip, messages, window_open, window_days }
 */
router.get('/trip/:trip_id', authenticate, async (req, res, next) => {
  try {
    const tripId = req.params.trip_id;
    if (!tripId) return res.status(400).json({ error: 'Invalid trip id.' });

    const { trip, isParticipant } = await getTripAndParticipant(tripId, req.user.id);
    if (!trip)          return res.status(404).json({ error: 'Trip not found.' });
    if (!isParticipant) return res.status(403).json({ error: 'Access denied.' });

    // Mark all messages from the other party as read in one query
    await pool.query(
      `UPDATE trip_messages
       SET read_at = NOW()
       WHERE trip_id = $1 AND sender_id <> $2 AND read_at IS NULL`,
      [tripId, req.user.id]
    );

    // Fetch messages newest → oldest
    const { rows: messages } = await pool.query(
      `SELECT
         tm.id, tm.sender_id, tm.body, tm.created_at, tm.read_at,
         u.first_name, u.last_name
       FROM trip_messages tm
       JOIN users u ON u.id = tm.sender_id
       WHERE tm.trip_id = $1
       ORDER BY tm.created_at DESC`,
      [tripId]
    );

    const { open, windowDays } = await replyWindowStatus(trip);

    const role = req.user.role;
    const maskedMessages = messages.map(m => ({
      ...m,
      last_name: maskLastName(m.last_name, role),
    }));
    res.json({
      trip: {
        id:               trip.id,
        trip_number:      trip.trip_number,
        status:           trip.status,
        pickup_address:   trip.pickup_address,
        dropoff_address:  trip.dropoff_address,
        client_id:        trip.client_id,
        driver_id:        trip.driver_id,
        client_first:     trip.client_first,
        client_last:      maskLastName(trip.client_last, role),
        driver_first:     trip.driver_first,
        driver_last:      maskLastName(trip.driver_last, role),
      },
      messages: maskedMessages,
      window_open: open,
      window_days: windowDays,
    });
  } catch (err) { next(err); }
});

// ── POST /api/messages/trip/:trip_id ─────────────────────────

/**
 * Sends a new message in a trip thread.
 *
 * Validates:
 *   - body is non-empty and ≤ 500 characters
 *   - caller is a trip participant (client or driver)
 *   - reply window is open (active trip or within configured days after close)
 *
 * Side effects:
 *   - Inserts a row into trip_messages
 *   - Sends an email notification to the other participant (fire-and-forget)
 *
 * Auth: trip's client_id or driver_id only.
 * Returns: { message }
 */
router.post('/trip/:trip_id', authenticate, async (req, res, next) => {
  try {
    const tripId = req.params.trip_id;
    if (!tripId) return res.status(400).json({ error: 'Invalid trip id.' });

    const body = (req.body.body || '').trim();

    if (!body) {
      return res.status(422).json({ error: 'Message cannot be empty.', code: 'EMPTY_BODY' });
    }
    if (body.length > 500) {
      return res.status(422).json({ error: 'Message must not exceed 500 characters.', code: 'TOO_LONG' });
    }

    const { trip, isParticipant } = await getTripAndParticipant(tripId, req.user.id);
    if (!trip)          return res.status(404).json({ error: 'Trip not found.' });
    if (!isParticipant) return res.status(403).json({ error: 'Access denied.' });

    const { open } = await replyWindowStatus(trip);
    if (!open) {
      return res.status(422).json({
        error: 'The reply window for this trip has expired.',
        code:  'WINDOW_CLOSED',
      });
    }

    // Insert message
    const { rows } = await pool.query(
      `INSERT INTO trip_messages (trip_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, trip_id, sender_id, body, created_at`,
      [tripId, req.user.id, body]
    );
    const message = rows[0];

    // ── Email notification (fire-and-forget) ─────────────────
    const isClient      = req.user.id === trip.client_id;
    const recipientEmail = isClient ? trip.driver_email  : trip.client_email;
    const recipientFirst = isClient ? trip.driver_first  : trip.client_first;
    const recipientLang  = isClient ? (trip.driver_lang  || 'fr') : (trip.client_lang || 'fr');
    const senderName     = isClient
      ? `${trip.client_first} ${trip.client_last}`
      : `${trip.driver_first} ${trip.driver_last}`;

    if (recipientEmail) {
      const { rows: cfgRows } = await pool.query(
        `SELECT key, value FROM configuration WHERE key = ANY($1)`,
        [['app_name', 'frontend_language']]
      );
      const cfg      = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
      const appName  = cfg.app_name || 'SolidaRoute';
      const langCfg  = cfg.frontend_language;
      const emailLang = langCfg === 'fr' ? 'fr'
                      : langCfg === 'en' ? 'en'
                      : recipientLang;

      sendTripMessage({
        recipientEmail,
        recipientFirst: recipientFirst || '',
        senderName,
        tripNumber: trip.trip_number,
        pickup:     trip.pickup_address,
        dropoff:    trip.dropoff_address,
        body,
        appName,
        lang: emailLang,
      }).catch(err =>
        logger.error('Failed to send trip message email', {
          tripId,
          error: err.message,
        })
      );
    }

    res.status(201).json({ message });
  } catch (err) { next(err); }
});

module.exports = router;
