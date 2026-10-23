/**
 * @file routes/trips/booking.js
 * @description Core trip lifecycle operations: create, read, and all status transitions.
 *              Mounted at the root of /api/trips (catch-all in trips.js).
 *
 * Auth: JWT required on every route.
 *
 * Routes:
 *   POST   /              — Create a new trip request
 *   GET    /:id           — Full trip detail (client, driver, or admin)
 *   PATCH  /:id/accept    — Driver claims a pending trip
 *   PATCH  /:id/cancel    — Cancel a trip (client, driver, or admin)
 *   PATCH  /:id/complete  — Mark an assigned trip as completed
 *   PATCH  /:id/decline   — Driver refuses a trip (preferred or broadcast)
 *
 * Trip status machine:
 *   pending → assigned   (via /accept or email token in action.js)
 *   pending → cancelled  (via /cancel)
 *   assigned → completed (via /complete)
 *   assigned → cancelled (via /cancel)
 *
 * Preferred-driver flow (POST / + PATCH /:id/decline):
 *   When a client selects a specific driver, that driver receives an email with
 *   one-time accept/decline links (action.js).  The trip stays hidden from other
 *   drivers until the preferred driver responds OR the response window expires
 *   (broadcast_at IS NULL is the "still waiting" signal).
 *   If the preferred driver declines (or the window expires), broadcast_at is set
 *   to NOW() and the trip appears in the general pool for all nearby drivers.
 *
 * Concurrency on /accept:
 *   Uses SELECT FOR UPDATE SKIP LOCKED inside a transaction so that if two drivers
 *   hit /accept at the same millisecond, exactly one wins and the other receives
 *   a 409 "Trip is no longer available" without waiting.
 *
 * Payment on /complete:
 *   Completing a trip creates a payments row and a driver_earnings row (idempotent
 *   via ON CONFLICT DO NOTHING).  A Stripe charge is then attempted asynchronously
 *   in a try/catch — the trip is marked completed regardless of whether the charge
 *   succeeds, so the driver is never blocked by a payment failure.
 *
 * Schedule conflict on /accept:
 *   Allen's interval algebra (A overlaps B iff A.start < B.end AND A.end > B.start)
 *   detects double-booking before the transaction commits.  A soft warning is returned
 *   on the first call; the driver can override it by sending force_conflict=true.
 */
const express            = require('express');
const { body, validationResult } = require('express-validator');
const { pool }           = require('../../db/pool');
const { authenticate }   = require('../../middleware/auth');
const { calculateTripCost } = require('../../services/pricing');
const { logger }         = require('../../utils/logger');
const { maskName }       = require('../../utils/namePrivacy');
const { resolveEmailLang } = require('../../utils/lang');
const crypto             = require('crypto');
const {
  sendPreferredDriverNotification,
  sendTripAcceptedToClient,
  sendTripDeclinedByPreferredToClient,
  sendTripCancelledManual,
} = require('../../services/email');

const PRICING_KEYS = [
  'base_fare', 'price_per_km', 'extra_passenger_fee',
  'driver_share_percent', 'payment_currency',
];

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trips
//
// Create a new trip request. Full validation flow:
//   1. express-validator field checks
//   2. departure_at parseable as a date
//   3. Coordinate presence (must come from prior /estimate call)
//   4. return_at range: after departure, within max_return_delay_minutes,
//      and at least duration_minutes after departure
//   5. max_trip_advance_days check (BEFORE INSERT)
//   6. Overlap check (skipped when confirm_overlap=true)
//   7. Preferred driver existence check
//   8. INSERT the trip row
//   9. min_trip_lead_hours check (AFTER INSERT — intentional, see comment)
//  10. Notify preferred driver via email (non-fatal)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  [
    body('pickup_address').trim().notEmpty().withMessage('Pickup address is required.'),
    body('dropoff_address').trim().notEmpty().withMessage('Dropoff address is required.'),
    body('departure_at').notEmpty().withMessage('Departure time is required.'),
    body('passenger_count').optional().isInt({ min: 1, max: 15 }),
    body('pickup_lat').optional(),
    body('pickup_lon').optional(),
    body('dropoff_lat').optional(),
    body('dropoff_lon').optional(),
    body('preferred_driver_id').optional({ nullable: true, checkFalsy: true }),
    body('client_notes').optional({ nullable: true }).trim().isLength({ max: 500 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logger.warn('Trip creation validation failed', { errors: errors.array() });
        return res.status(422).json({
          error: errors.array().map(e => e.msg).join(' '),
          code: 'VALIDATION_ERROR',
          errors: errors.array(),
        });
      }

      const {
        pickup_address, dropoff_address, departure_at, return_at,
        passenger_count = 1, pickup_lat, pickup_lon, dropoff_lat, dropoff_lon,
        distance_km, duration_minutes,
        preferred_driver_id, client_notes,
        confirm_overlap,
      } = req.body;
      // estimated_cost is intentionally NOT accepted from the client body.
      // Fares are always computed server-side at billing time to prevent
      // a client from submitting an artificially low cost.

      // ── Step 2: Validate departure_at ─────────────────────────────────────
      const departDate = new Date(departure_at);
      if (isNaN(departDate.getTime())) {
        return res.status(422).json({ error: 'Invalid departure date/time.', code: 'INVALID_DEPARTURE' });
      }

      // ── Step 3: Validate coordinates (must come from prior /estimate call) ─
      const pLat = parseFloat(pickup_lat);
      const pLon = parseFloat(pickup_lon);
      const dLat = parseFloat(dropoff_lat);
      const dLon = parseFloat(dropoff_lon);
      if (isNaN(pLat) || isNaN(pLon) || isNaN(dLat) || isNaN(dLon)) {
        return res.status(422).json({
          error: 'Coordinates are required. Please complete the estimate step first.',
          code: 'MISSING_COORDINATES',
        });
      }

      // ── Step 4: Validate return_at range ──────────────────────────────────
      if (return_at) {
        const returnDate = new Date(return_at);
        if (!isNaN(returnDate.getTime())) {
          const { rows: cfg } = await pool.query(
            `SELECT value FROM configuration WHERE key = 'max_return_delay_minutes'`
          );
          const maxMinutes  = parseInt(cfg[0]?.value || '150', 10);
          const diffMinutes = (returnDate - departDate) / 60000;
          if (diffMinutes < 0) {
            return res.status(422).json({ error: 'Return time must be after departure time.', code: 'RETURN_BEFORE_DEPARTURE' });
          }
          if (diffMinutes > maxMinutes) {
            return res.status(422).json({
              error: `Return time must be within ${maxMinutes} minutes of departure.`,
              code: 'RETURN_TOO_LATE',
              max_minutes: maxMinutes,
            });
          }
          if (duration_minutes && diffMinutes < parseInt(duration_minutes, 10)) {
            return res.status(422).json({
              error: `Return time is too soon. The one-way trip takes ${duration_minutes} minutes, but the gap is only ${Math.round(diffMinutes)} minutes.`,
              code: 'RETURN_GAP_TOO_SHORT',
              duration_minutes: parseInt(duration_minutes, 10),
              gap_minutes: Math.round(diffMinutes),
            });
          }
        }
      }

      // ── Step 5: Max advance booking check (BEFORE INSERT) ─────────────────
      const { rows: advCfg } = await pool.query(
        `SELECT value FROM configuration WHERE key = 'max_trip_advance_days'`
      );
      const maxAdvanceDays = parseInt(advCfg[0]?.value || '180', 10);
      if (maxAdvanceDays > 0) {
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + maxAdvanceDays);
        if (departDate > maxDate) {
          return res.status(422).json({
            error: `Trips cannot be booked more than ${maxAdvanceDays} days in advance.`,
            code:  'TOO_FAR_IN_ADVANCE',
            max_advance_days: maxAdvanceDays,
          });
        }
      }

      // ── Step 6: Overlap check ─────────────────────────────────────────────
      // confirm_overlap=true bypasses the conflict check at the client's explicit
      // request (they confirmed the warning in the UI). Log it so abuse is visible.
      if (confirm_overlap) {
        logger.warn('Trip booked with overlap bypass', {
          clientId: req.body.client_id || req.user.id,
          actorId:  req.user.id,
          departure_at,
        });
      }
      if (!confirm_overlap) {
        const clientId = req.body.client_id && ['operator','superadmin'].includes(req.user.role)
          ? req.body.client_id
          : req.user.id;
        const { rows: overlaps } = await pool.query(
          `SELECT trip_number, departure_at, return_at, status
           FROM trips
           WHERE client_id = $1
             AND status IN ('pending', 'assigned', 'in_progress')
             AND (
               $2 < COALESCE(return_at, departure_at + INTERVAL '4 hours') + INTERVAL '1 hour'
               AND COALESCE($3::timestamptz, $2 + INTERVAL '4 hours') > departure_at - INTERVAL '1 hour'
             )`,
          [clientId, departDate, return_at || null]
        );
        if (overlaps.length > 0) {
          const trip = overlaps[0];
          return res.status(409).json({
            code:    'OVERLAPPING_TRIP',
            error:   `This client already has an active trip (T-${trip.trip_number}) that overlaps with the requested time.`,
            trip_number: trip.trip_number,
            departure_at: trip.departure_at,
          });
        }
      }

      // ── Step 7: Validate preferred driver ─────────────────────────────────
      if (preferred_driver_id && preferred_driver_id.trim()) {
        const { rows: driverCheck } = await pool.query(
          `SELECT u.id FROM users u
           JOIN driver_profiles dp ON dp.user_id = u.id
           WHERE u.id = $1 AND dp.approval_status = 'approved' AND u.status = 'active'`,
          [preferred_driver_id]
        );
        if (!driverCheck.length) {
          return res.status(422).json({ error: 'Selected driver is not available.', code: 'DRIVER_UNAVAILABLE' });
        }
      }

      const clientId = req.body.client_id && ['operator','superadmin'].includes(req.user.role)
        ? req.body.client_id
        : req.user.id;
      const adminId = req.body.client_id && ['operator','superadmin'].includes(req.user.role)
        ? req.user.id
        : null;

      // ── Step 8: INSERT trip row ───────────────────────────────────────────
      // ST_MakePoint expects (longitude, latitude) — note argument order $5,$4 (lon,lat)
      const { rows } = await pool.query(
        `INSERT INTO trips
           (client_id, created_by_admin,
            pickup_address,  pickup_point,
            dropoff_address, dropoff_point,
            departure_at, return_at,
            passenger_count, distance_km, duration_minutes, estimated_cost,
            preferred_driver_id, client_notes)
         VALUES ($1, $2,
                 $3,  ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
                 $6,  ST_SetSRID(ST_MakePoint($8, $7), 4326)::geography,
                 $9,  $10, $11, $12, $13, $14,
                 $15, $16)
         RETURNING id, status, trip_number, departure_at, pickup_address, dropoff_address`,
        [
          clientId, adminId,
          pickup_address, pLat, pLon,
          dropoff_address, dLat, dLon,
          departure_at, return_at || null,
          parseInt(passenger_count),
          distance_km      ? parseFloat(distance_km)      : null,
          duration_minutes ? parseInt(duration_minutes)   : null,
          null, // estimated_cost: never stored from client input; computed at billing time
          (preferred_driver_id && preferred_driver_id.trim()) ? preferred_driver_id : null,
          client_notes || null,
        ]
      );

      logger.info('Trip created', { tripId: rows[0].id, clientId });

      // ── Step 9: Min lead time check (intentionally AFTER INSERT) ─────────
      // Checking before INSERT creates a TOCTOU race condition where the lead-time
      // window can close between the app-level check and the DB write. By inserting
      // first and deleting on violation, we hold the row and never leave a gap.
      const { rows: leadCfg } = await pool.query(
        `SELECT value FROM configuration WHERE key = 'min_trip_lead_hours'`
      );
      const minLeadHours = parseInt(leadCfg[0]?.value || '48', 10);
      const hoursUntilDeparture = (departDate - new Date()) / 3600000;
      if (minLeadHours > 0 && hoursUntilDeparture < minLeadHours) {
        await pool.query(`DELETE FROM trips WHERE id = $1`, [rows[0].id]);
        return res.status(422).json({
          error: `Trips must be requested at least ${minLeadHours} hours before departure.`,
          code: 'INSUFFICIENT_LEAD_TIME',
          min_lead_hours: minLeadHours,
        });
      }

      // ── Step 10: Notify preferred driver via email (non-fatal) ───────────
      if (preferred_driver_id && preferred_driver_id.trim()) {
        try {
          const [{ rows: driverRows }, { rows: cfgRows }] = await Promise.all([
            pool.query(
              `SELECT u.first_name, u.last_name, u.email, u.phone,
                      COALESCE(dp.preferred_language, 'fr') AS preferred_language
               FROM users u
               LEFT JOIN driver_profiles dp ON dp.user_id = u.id
               WHERE u.id = $1`,
              [preferred_driver_id]
            ),
            pool.query(
              `SELECT key, value FROM configuration
               WHERE key IN ('frontend_language', 'app_name', 'preferred_driver_response_hours')`
            ),
          ]);

          if (driverRows.length) {
            const cfgMap = {};
            cfgRows.forEach(r => { cfgMap[r.key] = r.value; });
            const lang = resolveEmailLang(
              cfgMap.frontend_language || 'both',
              driverRows[0].preferred_language
            );
            const appName       = cfgMap.app_name || 'SolidaRoute';
            const responseHours = parseInt(cfgMap.preferred_driver_response_hours || '6', 10);

            const acceptToken  = crypto.randomBytes(32).toString('hex');
            const declineToken = crypto.randomBytes(32).toString('hex');
            const expiresAt    = new Date(Date.now() + responseHours * 3600 * 1000);

            await pool.query(
              `INSERT INTO verification_tokens (user_id, token, type, expires_at, trip_id, action)
               VALUES ($1,$2,'trip_action',$3,$4,'accept'),
                      ($1,$5,'trip_action',$3,$4,'decline')`,
              [preferred_driver_id, acceptToken, expiresAt, rows[0].id, declineToken]
            );

            const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
            await sendPreferredDriverNotification({
              driver:       driverRows[0],
              client:       { first_name: req.user.first_name },
              trip:         { ...rows[0], trip_number: rows[0].trip_number },
              appName, lang, responseHours,
              acceptLink:   `${backendUrl}/api/trips/action?token=${acceptToken}`,
              declineLink:  `${backendUrl}/api/trips/action?token=${declineToken}`,
            });

            await pool.query(
              `UPDATE trips SET preferred_driver_notified_at = NOW() WHERE id = $1`,
              [rows[0].id]
            );
          }
        } catch (emailErr) {
          logger.error('Failed to send preferred driver email', { error: emailErr.message });
        }
      }

      res.status(201).json({ message: 'Trip created successfully.', trip: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trips/:id
//
// Returns full trip detail for the client, assigned driver, or admin.
// Returns 404 for non-existent trips, 403 for unauthorized access.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*,
         c.first_name AS client_first_name, c.last_name AS client_last_name, c.phone AS client_phone,
         d.first_name AS driver_first_name, d.last_name AS driver_last_name, d.phone AS driver_phone,
         ab.first_name AS booked_by_first_name, ab.last_name AS booked_by_last_name
       FROM trips t
       LEFT JOIN users c  ON c.id  = t.client_id
       LEFT JOIN users d  ON d.id  = t.driver_id
       LEFT JOIN users ab ON ab.id = t.created_by_admin
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Trip not found.' });

    const trip = rows[0];
    const isOwner = trip.client_id === req.user.id || trip.driver_id === req.user.id;
    const isAdmin = ['operator','superadmin'].includes(req.user.role);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Access denied.' });

    const role = req.user.role;
    const maskedTrip = {
      ...trip,
      client_name:          maskName(trip.client_first_name, trip.client_last_name,       role),
      driver_name:          maskName(trip.driver_first_name, trip.driver_last_name,       role),
      booked_by_name:       maskName(trip.booked_by_first_name, trip.booked_by_last_name, role),
      client_first_name:    undefined, client_last_name:    undefined,
      driver_first_name:    undefined, driver_last_name:    undefined,
      booked_by_first_name: undefined, booked_by_last_name: undefined,
    };
    res.json({ trip: maskedTrip });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/accept
//
// Driver claims a pending trip. Uses SELECT FOR UPDATE SKIP LOCKED for
// concurrency safety — only one driver can win the race.
// Schedule conflict check prevents double-booking the same driver.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/accept', authenticate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only.' });

    const { rows: check } = await client.query(
      'SELECT approval_status FROM driver_profiles WHERE user_id = $1', [req.user.id]
    );
    if (!check.length || check[0].approval_status !== 'approved') {
      return res.status(403).json({ error: 'Your driver profile must be approved before accepting trips.' });
    }

    // Read overlap buffer BEFORE opening the transaction (read-only config query)
    const { rows: bufferCfg } = await pool.query(
      `SELECT value FROM configuration WHERE key = 'trip_overlap_buffer_minutes'`
    );
    const overlapBuffer = parseInt(bufferCfg[0]?.value || '120', 10);

    await client.query('BEGIN');

    const { rows: locked } = await client.query(
      `SELECT id, status, client_id, preferred_driver_id,
              departure_at, return_at, duration_minutes, trip_number
       FROM trips
       WHERE id = $1 AND status = 'pending'
       FOR UPDATE SKIP LOCKED`,
      [req.params.id]
    );
    if (!locked.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Trip is no longer available.' });
    }

    const tripToAccept = locked[0];

    // Compute the end time of the trip being accepted in JS to avoid SQL type ambiguity.
    // Priority: return_at → departure_at + duration_minutes → departure_at + overlapBuffer
    const tripStart = new Date(tripToAccept.departure_at);
    let tripEnd;
    if (tripToAccept.return_at) {
      tripEnd = new Date(tripToAccept.return_at);
    } else if (tripToAccept.duration_minutes) {
      tripEnd = new Date(tripStart.getTime() + tripToAccept.duration_minutes * 60000);
    } else {
      tripEnd = new Date(tripStart.getTime() + overlapBuffer * 60000);
    }

    // Schedule conflict check — Allen's interval algebra: A overlaps B iff
    // A.start < B.end AND A.end > B.start
    // $4 = pre-computed end time of the trip being accepted (timestamptz)
    // $5 = overlapBuffer: fallback for existing trips that lack both return_at and duration_minutes
    const { rows: conflicts } = await client.query(
      `SELECT t.trip_number, t.departure_at, t.return_at, t.duration_minutes
       FROM trips t
       WHERE t.driver_id = $1
         AND t.status = 'assigned'
         AND t.id != $2
         AND t.departure_at < $4::timestamptz
         AND (
               CASE
                 WHEN t.return_at IS NOT NULL THEN t.return_at
                 ELSE t.departure_at + make_interval(mins => COALESCE(t.duration_minutes, $5::int))
               END
             ) > $3::timestamptz`,
      [
        req.user.id,
        req.params.id,
        tripToAccept.departure_at,
        tripEnd.toISOString(),
        overlapBuffer,
      ]
    );

    // Soft warning — first call returns a warning; driver confirms with force_conflict=true.
    // If force_conflict is set the check is bypassed: the driver knowingly accepts the overlap.
    if (conflicts.length > 0 && !req.body.force_conflict) {
      await client.query('ROLLBACK');
      const conflictNumbers = conflicts.map(c => `T-${c.trip_number}`).join(', ');
      return res.status(409).json({
        code:             'schedule_conflict_warning',
        error:            'schedule_conflict_warning',
        conflict_numbers: conflictNumbers,
      });
    }

    const { rows } = await client.query(
      `UPDATE trips
       SET driver_id = $1, status = 'assigned', assigned_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.id, req.params.id]
    );

    await client.query('COMMIT');

    // Record accept action (best-effort, outside transaction)
    try {
      const isPreferred = locked[0].preferred_driver_id === req.user.id;
      await pool.query(
        `INSERT INTO trip_driver_actions (trip_id, driver_id, action, is_preferred, actioned_at)
         VALUES ($1, $2, 'accepted', $3, NOW())
         ON CONFLICT (trip_id, driver_id) DO UPDATE
           SET action = 'accepted', is_preferred = EXCLUDED.is_preferred, actioned_at = NOW()`,
        [req.params.id, req.user.id, isPreferred]
      );
    } catch (tdaErr) {
      logger.error('Failed to record accept action', { error: tdaErr.message });
    }

    // Send confirmation email to client (best-effort)
    try {
      const [{ rows: clientRows }, { rows: driverRows }, { rows: cfgRows }] = await Promise.all([
        pool.query(
          `SELECT u.first_name, u.last_name, u.email,
                  COALESCE(cp.preferred_language, 'fr') AS preferred_language
           FROM users u
           LEFT JOIN client_profiles cp ON cp.user_id = u.id
           WHERE u.id = $1`,
          [rows[0].client_id]
        ),
        pool.query(`SELECT first_name, last_name, phone FROM users WHERE id = $1`, [req.user.id]),
        pool.query(`SELECT key, value FROM configuration WHERE key IN ('frontend_language', 'app_name')`),
      ]);
      if (clientRows.length) {
        const cfgMap = {};
        cfgRows.forEach(r => { cfgMap[r.key] = r.value; });
        await sendTripAcceptedToClient({
          client:  clientRows[0],
          driver:  driverRows[0],
          trip:    rows[0],
          appName: cfgMap.app_name || 'SolidaRoute',
          lang:    resolveEmailLang(
            cfgMap.frontend_language || 'both',
            clientRows[0].preferred_language || 'fr'
          ),
        });
      }
    } catch (emailErr) {
      logger.error('Failed to send accept email to client', { error: emailErr.message });
    }

    res.json({ message: 'Trip accepted successfully.', trip: rows[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore rollback error */ }
    next(err);
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/cancel
//
// Cancel a trip. Allowed for: booking client, assigned driver, or admin.
// Releases any reserved mobility tickets on cancellation.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/cancel', authenticate,
  [ body('reason').trim().notEmpty().withMessage('A cancellation reason is required.') ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(422).json({ error: errors.array()[0].msg, code: 'MISSING_REASON' });
      }

      const { rows: tripRows } = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
      if (!tripRows.length) return res.status(404).json({ error: 'Trip not found.' });

      const trip = tripRows[0];
      const canCancel = trip.client_id === req.user.id
        || trip.driver_id === req.user.id
        || ['operator','superadmin'].includes(req.user.role);

      if (!canCancel) return res.status(403).json({ error: 'Access denied.' });

      if (['completed','cancelled'].includes(trip.status)) {
        return res.status(409).json({ error: `Cannot cancel a ${trip.status} trip.` });
      }

      const { rows } = await pool.query(
        `UPDATE trips SET status = 'cancelled', cancelled_by = $1,
         cancellation_reason = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [req.user.id, req.body.reason, req.params.id]
      );

      // Release any reserved mobility tickets (best-effort)
      await pool.query(
        `UPDATE mobility_tickets
         SET status = 'available', trip_id = NULL, reserved_at = NULL
         WHERE trip_id = $1 AND status = 'reserved'`,
        [req.params.id]
      ).catch(releaseErr => {
        logger.warn('Failed to release mobility tickets on trip cancel', {
          tripId: req.params.id,
          error:  releaseErr.message,
        });
      });

      // Notify the other party if the trip had a driver assigned.
      // pending trips (no driver yet) need no notification.
      if (trip.driver_id) {
        try {
          const cancelledByRole = req.user.role;
          // Notify driver when client or admin cancels; notify client when driver cancels.
          const notifyDriverId  = req.user.id !== trip.driver_id;
          const recipientId     = notifyDriverId ? trip.driver_id : trip.client_id;

          const [{ rows: recipientRows }, { rows: cfgRows }] = await Promise.all([
            pool.query(
              `SELECT u.first_name, u.email,
                      COALESCE(cp.preferred_language, dp.preferred_language, 'fr') AS preferred_language
               FROM users u
               LEFT JOIN client_profiles cp ON cp.user_id = u.id
               LEFT JOIN driver_profiles dp ON dp.user_id = u.id
               WHERE u.id = $1`,
              [recipientId]
            ),
            pool.query(
              `SELECT key, value FROM configuration WHERE key = ANY($1)`,
              [['app_name', 'frontend_language']]
            ),
          ]);

          if (recipientRows.length) {
            const cfgMap  = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
            const appName = cfgMap.app_name || 'SolidaRoute';
            const lang    = resolveEmailLang(cfgMap.frontend_language, recipientRows[0].preferred_language);

            await sendTripCancelledManual({
              recipient:       recipientRows[0],
              trip,
              cancelledByRole,
              reason:          req.body.reason,
              appName,
              lang,
            });
          }
        } catch (emailErr) {
          logger.error('Failed to send cancellation email', {
            tripId: req.params.id,
            error:  emailErr.message,
          });
        }
      }

      res.json({ message: 'Trip cancelled.', trip: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/complete
//
// Mark an assigned trip as completed. Creates payment and earnings records.
// Triggers Stripe charge asynchronously (non-fatal if it fails).
// Drivers: only after departure_at has passed. Operators: any time.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/complete', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(`SELECT * FROM trips WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Trip not found.' });
    const trip = rows[0];

    const isDriver   = req.user.role === 'driver' && trip.driver_id === req.user.id;
    const isOperator = ['operator', 'superadmin'].includes(req.user.role);
    if (!isDriver && !isOperator) {
      return res.status(403).json({ error: 'Only the assigned driver or an operator can complete this trip.' });
    }

    if (trip.status !== 'assigned') {
      return res.status(422).json({
        error: `Trip cannot be completed — current status is "${trip.status}".`,
        code: 'INVALID_STATUS',
      });
    }

    if (isDriver && new Date(trip.departure_at) > new Date()) {
      return res.status(422).json({
        error: 'Trip cannot be completed before the departure time.',
        code: 'TOO_EARLY',
      });
    }

    const source = isOperator && !isDriver ? 'operator' : 'driver';

    const { rows: updated } = await pool.query(
      `UPDATE trips
       SET status            = 'completed',
           completed_at      = NOW(),
           completion_source = $2,
           updated_at        = NOW()
       WHERE id = $1
       RETURNING id, status, completed_at, completion_source`,
      [id, source]
    );

    // Create payment and earnings records (best-effort — trip is already completed)
    try {
      const { rows: cfgRows } = await pool.query(
        `SELECT key, value FROM configuration WHERE key = ANY($1)`, [PRICING_KEYS]
      );
      const pricingCfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
      const driverPct  = parseFloat(pricingCfg.driver_share_percent ?? 75) / 100;
      const currency   = pricingCfg.payment_currency ?? 'CAD';

      // Always compute fare server-side from distance and pricing config.
      // trip.estimated_cost is never used for billing — it was set to NULL at
      // booking time to prevent client-supplied fare manipulation.
      const cost = calculateTripCost(
        parseFloat(trip.distance_km || 0),
        parseInt(trip.passenger_count || 1),
        pricingCfg
      );

      // ON CONFLICT DO NOTHING makes this idempotent (safe if complete is called twice)
      const { rows: payRows } = await pool.query(
        `INSERT INTO payments
           (trip_id, provider, amount, driver_share, platform_fee, currency, status)
         VALUES ($1, 'manual', $2, $3, $4, $5, 'pending')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [id, cost.total, cost.driver_share, cost.platform_fee, currency]
      );

      if (payRows.length && trip.driver_id) {
        await pool.query(
          `INSERT INTO driver_earnings
             (driver_id, trip_id, payment_id, amount, currency, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           ON CONFLICT DO NOTHING`,
          [trip.driver_id, id, payRows[0].id, cost.driver_share, currency]
        );
      }
    } catch (earningsErr) {
      logger.error('Failed to create earnings record', { tripId: id, error: earningsErr.message });
    }

    // Trigger charge — immediately if delay=0, otherwise defer to safeguard.
    // chargeTrip is required inline (not at top-level) to avoid a circular dependency
    // with routes/payments.js which also requires routes/trips internals.
    try {
      // Load delay config for both payment methods
      const { rows: delayCfgRows } = await pool.query(
        `SELECT key, value FROM configuration
         WHERE key IN ('ticket_use_delay_days', 'card_charge_delay_days')`
      );
      const delayCfg    = Object.fromEntries(delayCfgRows.map(r => [r.key, parseInt(r.value, 10)]));
      const ticketDelay = isNaN(delayCfg.ticket_use_delay_days)  ? 7 : delayCfg.ticket_use_delay_days;
      const cardDelay   = isNaN(delayCfg.card_charge_delay_days) ? 7 : delayCfg.card_charge_delay_days;

      // Find the authorized payment to know which delay applies
      const { rows: authPay } = await pool.query(
        `SELECT payment_method FROM payments WHERE trip_id = $1 AND status = 'authorized' LIMIT 1`,
        [id]
      );

      if (authPay.length) {
        const method = authPay[0].payment_method;
        const delay  = method === 'mobility' ? ticketDelay : cardDelay;

        if (delay === 0) {
          // Charge immediately
          const { chargeTrip } = require('../payments');
          const { payment: charged, error: chargeError } = await chargeTrip(id);
          if (charged) {
            logger.info('Payment charged after trip completion', {
              tripId: id, paymentId: charged.id, amount: charged.amount, currency: charged.currency,
            });
          } else if (chargeError) {
            logger.warn('Payment not charged after trip completion', { tripId: id, reason: chargeError.message });
          }
        } else {
          logger.info('Payment deferred to safeguard', { tripId: id, method, delayDays: delay });
        }
      }
    } catch (chargeErr) {
      logger.error('Payment charge failed after trip completion', { tripId: id, error: chargeErr.message });
    }

    // Audit log (best-effort)
    try {
      await pool.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
         VALUES ($1, 'trip.completed', 'trip', $2, $3)`,
        [req.user.id, id, `{"status":"completed","source":"${source}"}`]
      );
    } catch { /* best-effort audit log — ignore failure */ }

    res.json({ message: 'Trip marked as completed.', trip: updated[0] });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/trips/:id/decline
//
// Driver refuses a pending trip.
// Case A (preferred driver): sets broadcast_at, emails client, records action.
// Case B (broadcast driver): records action only, no trip row changes.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/decline', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Drivers only.' });
    }

    const { rows: checkRows } = await pool.query(
      'SELECT approval_status FROM driver_profiles WHERE user_id = $1', [req.user.id]
    );
    if (!checkRows.length || checkRows[0].approval_status !== 'approved') {
      return res.status(403).json({ error: 'Your driver profile must be approved.' });
    }

    const { rows } = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Trip not found.' });
    const trip = rows[0];

    if (trip.status !== 'pending') {
      return res.status(409).json({ error: 'Trip is no longer pending.' });
    }

    const isPreferredDriver = trip.preferred_driver_id === req.user.id
                           && !trip.preferred_driver_declined
                           && trip.broadcast_at == null;

    if (isPreferredDriver) {
      // ── Case A: preferred driver declines ─────────────────────────────
      await pool.query(
        `UPDATE trips
         SET preferred_driver_declined = true,
             broadcast_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [trip.id]
      );

      // Notify client (non-fatal)
      try {
        const [{ rows: clientRows }, { rows: cfgRows }] = await Promise.all([
          pool.query(
            `SELECT u.first_name, u.last_name, u.email,
                    COALESCE(cp.preferred_language, 'fr') AS preferred_language
             FROM users u
             LEFT JOIN client_profiles cp ON cp.user_id = u.id
             WHERE u.id = $1`,
            [trip.client_id]
          ),
          pool.query("SELECT key, value FROM configuration WHERE key IN ('frontend_language','app_name')"),
        ]);
        if (clientRows.length) {
          const cfgMap = {};
          cfgRows.forEach(r => { cfgMap[r.key] = r.value; });
          await sendTripDeclinedByPreferredToClient({
            client:  clientRows[0],
            trip,
            appName: cfgMap.app_name || 'SolidaRoute',
            lang:    resolveEmailLang(
              cfgMap.frontend_language || 'both',
              clientRows[0].preferred_language || 'fr'
            ),
          });
        }
      } catch (emailErr) {
        logger.error('Failed to send preferred-decline email to client', { error: emailErr.message });
      }

      try {
        await pool.query(
          `INSERT INTO trip_driver_actions (trip_id, driver_id, action, is_preferred, actioned_at)
           VALUES ($1, $2, 'declined', true, NOW())
           ON CONFLICT (trip_id, driver_id) DO UPDATE
             SET action = 'declined', is_preferred = true, actioned_at = NOW()`,
          [trip.id, req.user.id]
        );
      } catch (tdaErr) {
        logger.error('Failed to record preferred decline action', { error: tdaErr.message });
      }

      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'trip.declined', 'trip', $2, ('{"source":"preferred_driver","driver_id":"' || $1 || '"}')::jsonb)`,
          [req.user.id, trip.id]
        );
      } catch { /* best-effort audit log — ignore failure */ }

      logger.info('Trip declined by preferred driver', { tripId: trip.id, driverId: req.user.id });
      return res.json({ message: 'Trip declined. Other drivers in the area will be notified.', type: 'preferred' });

    } else {
      // ── Case B: broadcast driver declines ─────────────────────────────
      await pool.query(
        `INSERT INTO trip_driver_actions (trip_id, driver_id, action, is_preferred, actioned_at)
         VALUES ($1, $2, 'declined', false, NOW())
         ON CONFLICT (trip_id, driver_id) DO UPDATE
           SET action = 'declined', is_preferred = false, actioned_at = NOW()`,
        [trip.id, req.user.id]
      );

      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'trip.declined', 'trip', $2, ('{"source":"broadcast","driver_id":"' || $1 || '"}')::jsonb)`,
          [req.user.id, trip.id]
        );
      } catch { /* best-effort audit log — ignore failure */ }

      logger.info('Trip declined by broadcast driver', { tripId: trip.id, driverId: req.user.id });
      return res.json({ message: 'Trip declined and recorded.', type: 'broadcast' });
    }
  } catch (err) { next(err); }
});

module.exports = router;
