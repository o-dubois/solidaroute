/**
 * @file routes/trips/action.js
 * @description Handles one-time tokenised accept/decline links embedded in
 *              preferred-driver notification emails.
 *              Mounted at GET /api/trips/action.
 *
 * Auth: NONE — the token in the URL IS the credential.
 *   This endpoint is intentionally unauthenticated.  The driver clicks a link
 *   from their email client; they may not have a browser session open.  The
 *   one-time token (a 64-character hex string from crypto.randomBytes) provides
 *   sufficient entropy that brute-force guessing is not feasible.
 *
 * Token model:
 *   Tokens are stored in verification_tokens with:
 *     type     = 'trip_action'
 *     action   = 'accept' | 'decline'
 *     user_id  = the preferred driver's user ID
 *     trip_id  = the trip they were invited to drive
 *     expires_at = NOW() + preferred_driver_response_hours (config)
 *     used_at  = NULL until consumed
 *
 *   Two tokens are issued per invitation (one accept, one decline).
 *   Using either one immediately invalidates the companion token so the driver
 *   cannot change their mind after the fact.
 *
 * Flow (happy path):
 *   1. Look up the token row.  If missing, expired, or already used → redirect expired.
 *   2. Consume the token FIRST (set used_at = NOW()) before taking any trip action.
 *      This prevents replay: even if the subsequent UPDATE fails, the token is gone.
 *   3a. Accept: UPDATE trips SET status='assigned' WHERE status='pending'.
 *       The conditional WHERE is the final race-condition guard — if another driver
 *       already claimed the trip between the token lookup and this UPDATE, the row
 *       count will be 0 but we still redirect to 'too_late' gracefully.
 *       Also invalidates the companion decline token and emails the client.
 *   3b. Decline: SET preferred_driver_declined=true, broadcast_at=NOW() on the
 *       trip so it becomes visible to all nearby drivers.
 *       Also invalidates the companion accept token and emails the client.
 *   4. Redirect to the frontend with a query param indicating the outcome:
 *        /driver?action=accepted    — driver successfully claimed the trip
 *        /driver?action=declined    — driver declined, trip now open to all
 *        /driver?action=expired     — token was not found, already used, or past expiry
 *        /driver?action=too_late    — token was valid but trip was no longer pending
 *        /driver?action=invalid     — no token param in the request
 *        /driver?action=error       — unexpected server error
 *
 * Email notifications (non-fatal):
 *   Both branches attempt to email the client about the driver's decision.
 *   If the email fails the redirect still succeeds — the trip state has already
 *   been updated, so we log the error and carry on.
 */

const express    = require('express');
const { pool }   = require('../../db/pool');
const { logger } = require('../../utils/logger');
const { resolveEmailLang } = require('../../utils/lang');
const {
  sendTripAcceptedToClient,
  sendTripDeclinedByPreferredToClient,
} = require('../../services/email');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trips/action?token=X
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  try {
    const { token } = req.query;

    // No token param at all — almost certainly a scraper or malformed link.
    if (!token) return res.redirect(`${frontendUrl}/driver-action?action=invalid`);

    // Load the token together with relevant trip columns so we can validate
    // both in a single query without a second round-trip.
    const { rows: tokenRows } = await pool.query(
      `SELECT vt.*, t.status AS trip_status, t.preferred_driver_id,
              t.preferred_driver_declined, t.broadcast_at,
              t.trip_number AS trip_number
       FROM verification_tokens vt
       JOIN trips t ON t.id = vt.trip_id
       WHERE vt.token = $1
         AND vt.type = 'trip_action'
         AND vt.used_at IS NULL
         AND vt.expires_at > NOW()`,
      [token]
    );

    // Token not found, already consumed, or past its expiry window.
    if (!tokenRows.length) {
      return res.redirect(`${frontendUrl}/driver-action?action=expired`);
    }

    const vt       = tokenRows[0];
    const trip     = { id: vt.trip_id, status: vt.trip_status };
    const tripParam = vt.trip_number ? `&trip=${encodeURIComponent(vt.trip_number)}` : '';

    // ── Consume the token BEFORE acting ──────────────────────────────────────
    // Setting used_at here prevents a replay attack even if the trip UPDATE below
    // fails or throws.  The token is a single-use credential: once consumed,
    // any repeat click of the email link will hit the 'expired' redirect above.
    await pool.query(
      `UPDATE verification_tokens SET used_at = NOW() WHERE id = $1`,
      [vt.id]
    );

    // ── Branch: Accept ────────────────────────────────────────────────────────
    if (vt.action === 'accept') {

      // Another driver may have claimed the trip during the preferred-driver
      // response window (e.g. broadcast_at was moved up by an admin).
      if (trip.status !== 'pending') {
        return res.redirect(`${frontendUrl}/driver-action?action=too_late${tripParam}`);
      }

      // The AND status='pending' guard is the final concurrency check.
      // If two drivers somehow both have a valid accept token and both hit this
      // endpoint at the same instant, only the first UPDATE will match rows.
      await pool.query(
        `UPDATE trips
         SET driver_id = $1, status = 'assigned',
             assigned_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND status = 'pending'`,
        [vt.user_id, vt.trip_id]
      );

      // Invalidate the companion 'decline' token for this trip.  The driver can
      // no longer change their mind via email; they must contact the operator.
      await pool.query(
        `UPDATE verification_tokens SET used_at = NOW()
         WHERE trip_id = $1 AND action = 'decline' AND used_at IS NULL`,
        [vt.trip_id]
      );

      // Email the client confirming their driver is now assigned.
      // Failure here is non-fatal — trip is already assigned, just log and continue.
      try {
        const [{ rows: clientRows }, { rows: driverRows }, { rows: cfgRows }] = await Promise.all([
          pool.query(
            `SELECT u.first_name, u.last_name, u.email,
                    COALESCE(cp.preferred_language, 'fr') AS preferred_language
             FROM trips t
             JOIN users u ON u.id = t.client_id
             LEFT JOIN client_profiles cp ON cp.user_id = u.id
             WHERE t.id = $1`,
            [vt.trip_id]
          ),
          pool.query(
            `SELECT first_name, last_name, phone FROM users WHERE id = $1`,
            [vt.user_id]
          ),
          pool.query(
            `SELECT key, value FROM configuration WHERE key IN ('frontend_language','app_name')`
          ),
        ]);

        if (clientRows.length) {
          const cfgMap = {};
          cfgRows.forEach(r => { cfgMap[r.key] = r.value; });

          // Fetch the full trip row for the email template (needs departure_at etc.)
          const { rows: tripRows } = await pool.query(
            `SELECT * FROM trips WHERE id = $1`, [vt.trip_id]
          );

          await sendTripAcceptedToClient({
            client:  clientRows[0],
            driver:  driverRows[0],
            trip:    tripRows[0],
            appName: cfgMap.app_name || 'SolidaRoute',
            lang:    resolveEmailLang(
              cfgMap.frontend_language || 'both',
              clientRows[0].preferred_language || 'fr'
            ),
          });
        }
      } catch (emailErr) {
        logger.error('Email to client after token accept failed', { error: emailErr.message });
      }

      logger.info('Trip accepted via email token', { tripId: vt.trip_id, driverId: vt.user_id });
      return res.redirect(`${frontendUrl}/driver-action?action=accepted${tripParam}`);

    // ── Branch: Decline ───────────────────────────────────────────────────────
    } else if (vt.action === 'decline') {

      if (trip.status !== 'pending') {
        return res.redirect(`${frontendUrl}/driver-action?action=too_late${tripParam}`);
      }

      // Open the trip to all nearby drivers by setting preferred_driver_declined=true
      // and broadcast_at=NOW().  The available.js query uses broadcast_at IS NULL
      // as the signal that a trip is still in its exclusive preferred-driver window;
      // setting it to a timestamp releases the trip to the general pool.
      await pool.query(
        `UPDATE trips
         SET preferred_driver_declined = true,
             broadcast_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [vt.trip_id]
      );

      // Invalidate the companion 'accept' token — the window has closed.
      await pool.query(
        `UPDATE verification_tokens SET used_at = NOW()
         WHERE trip_id = $1 AND action = 'accept' AND used_at IS NULL`,
        [vt.trip_id]
      );

      // Notify the client that their preferred driver declined so they are not
      // left wondering why the trip is still pending.  Non-fatal on failure.
      try {
        const { rows: tripRows } = await pool.query(
          `SELECT * FROM trips WHERE id = $1`, [vt.trip_id]
        );
        const [{ rows: clientRows }, { rows: cfgRows }] = await Promise.all([
          pool.query(
            `SELECT u.first_name, u.last_name, u.email,
                    COALESCE(cp.preferred_language, 'fr') AS preferred_language
             FROM users u
             LEFT JOIN client_profiles cp ON cp.user_id = u.id
             WHERE u.id = $1`,
            [tripRows[0].client_id]
          ),
          pool.query(
            `SELECT key, value FROM configuration WHERE key IN ('frontend_language','app_name')`
          ),
        ]);

        if (clientRows.length && tripRows.length) {
          const cfgMap = {};
          cfgRows.forEach(r => { cfgMap[r.key] = r.value; });
          await sendTripDeclinedByPreferredToClient({
            client:  clientRows[0],
            trip:    tripRows[0],
            appName: cfgMap.app_name || 'SolidaRoute',
            lang:    resolveEmailLang(
              cfgMap.frontend_language || 'both',
              clientRows[0].preferred_language || 'fr'
            ),
          });
        }
      } catch (emailErr) {
        logger.error('Email to client after token decline failed', { error: emailErr.message });
      }

      logger.info('Trip declined via email token', { tripId: vt.trip_id, driverId: vt.user_id });
      return res.redirect(`${frontendUrl}/driver-action?action=declined${tripParam}`);
    }

    // Unrecognised action value — should never happen with our token schema,
    // but redirect gracefully instead of leaving the driver on a blank page.
    res.redirect(`${frontendUrl}/driver-action?action=invalid`);

  } catch (err) {
    logger.error('Trip action token error', { error: err.message });
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/driver-action?action=error`);
  }
});

module.exports = router;
