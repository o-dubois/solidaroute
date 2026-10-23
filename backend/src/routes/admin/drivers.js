/**
 * @file routes/admin/drivers.js
 * @description Driver management and document routes for admins.
 *              Mounted at /api/admin/drivers
 *
 * Auth: operator or superadmin (enforced by parent router).
 *
 * Routes:
 *   GET   /                          — all drivers with vehicle details and trip counts
 *   GET   /:id                       — full detail for one driver
 *   PATCH /:id/approve               — approve / reject / suspend a driver application
 *   PATCH /:id/approve-override      — approve bypassing documents (requires minimum fields)
 *   GET   /:id/documents             — list document metadata for a driver
 *   GET   /:id/documents/:type/:slot — stream a decrypted driver document inline
 *
 * Registration order: /:id/documents and /:id/approve must be registered
 * before /:id so Express does not misinterpret path suffixes as the :id param.
 * (Not technically required since /:id only matches a single segment, but kept
 * explicit for clarity.)
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { body, param, validationResult } = require('express-validator');
const { pool }                    = require('../../db/pool');
const { logger }                  = require('../../utils/logger');
const { sendDriverApproved }      = require('../../services/email');
const { decryptBuffer }           = require('../../utils/filecrypto');
const { checkDriverCompleteness } = require('../../utils/driverCompleteness');

const router = express.Router();

// Uploaded driver documents are stored on disk outside of the web root.
// UPLOADS_DIR defaults to a secure OS-level path so files are never
// directly accessible via a static file server.
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/opt/solidaroute/uploads';

// The three document types a driver must (optionally, per configuration) submit.
// This array is used as an allow-list when serving document files to prevent
// arbitrary doc_type strings from reaching the file system.
const DOC_TYPES = ['license', 'insurance', 'registration'];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/drivers
//
// All registered drivers with vehicle details, availability status,
// and aggregate trip counts (upcoming and completed).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.first_name, u.last_name, u.email, u.phone,
        u.status, u.created_at,
        dp.approval_status, dp.approval_overridden,
        dp.vehicle_make, dp.vehicle_model, dp.vehicle_year, dp.vehicle_color,
        dp.license_plate, dp.seat_count,
        dp.is_available, dp.average_rating, dp.review_count,
        dp.home_address, dp.service_radius_km,
        -- Conditional COUNT: only trips that are assigned AND not yet departed.
        COUNT(CASE WHEN t.status = 'assigned' AND t.departure_at > NOW() THEN 1 END)::int AS upcoming_trips,
        COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed_trips
      FROM users u
      LEFT JOIN driver_profiles dp ON dp.user_id = u.id
      -- LEFT JOIN trips so drivers with zero trips are still included in the list.
      LEFT JOIN trips t ON t.driver_id = u.id
      WHERE u.role = 'driver'
      GROUP BY
        u.id, u.first_name, u.last_name, u.email, u.phone, u.status, u.created_at,
        dp.approval_status, dp.approval_overridden, dp.vehicle_make, dp.vehicle_model,
        dp.vehicle_year, dp.vehicle_color, dp.license_plate, dp.seat_count, dp.is_available,
        dp.average_rating, dp.review_count, dp.home_address, dp.service_radius_km
      ORDER BY u.last_name, u.first_name
    `);
    res.json({ drivers: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/drivers/:id/approve
//
// Approves, rejects, or suspends a driver's application.
// Status transitions: approved | rejected | suspended
// Side effects: stamps approved_at, sends approval email, writes audit log.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/approve',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  body('status').isIn(['approved', 'rejected', 'suspended']),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      // Upsert driver profile if missing — ensures there is always a row to UPDATE below.
      // Placeholder values (empty strings, year 2020, null island point at 0,0) are
      // overwritten when the driver completes their own profile setup.
      await pool.query(
        `INSERT INTO driver_profiles
           (user_id, vehicle_make, vehicle_model, vehicle_year, license_plate, home_point)
         VALUES ($1, '', '', 2020, '', ST_SetSRID(ST_MakePoint(0,0),4326)::geography)
         ON CONFLICT (user_id) DO NOTHING`,
        [req.params.id]
      );

      // approved_at is set to NOW() only on approval; NULL clears it on reject/suspend.
      // This value is injected directly into the query string (not as a bind parameter)
      // because PostgreSQL does not accept NOW() or NULL as a $N bind value here.
      const approvedAt = req.body.status === 'approved' ? 'NOW()' : 'NULL';
      const { rows } = await pool.query(
        // When a regular (non-override) approval is granted, clear the override flag
        // so any previously recorded override is no longer shown to admins.
        // For reject/suspend the override flag is left as-is (historical record).
        `UPDATE driver_profiles
         SET approval_status = $1, approved_by = $2,
             approved_at = ${approvedAt},
             ${req.body.status === 'approved'
               ? 'approval_overridden = FALSE, approval_overridden_by = NULL, approval_overridden_at = NULL,'
               : ''}
             updated_at = NOW()
         WHERE user_id = $3
         RETURNING approval_status`,
        [req.body.status, req.user.id, req.params.id]
      );

      if (!rows.length) return res.status(404).json({ error: 'Driver profile not found.' });

      // When a driver is approved, activate their user account so they can log in
      // and start receiving trip assignments.
      if (req.body.status === 'approved') {
        await pool.query(
          `UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1`,
          [req.params.id]
        );
      }

      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'driver.approval_changed', 'driver_profile', $2, jsonb_build_object('status', $3))`,
          [req.user.id, req.params.id, req.body.status]
        );
      } catch (e) { logger.warn('Audit log failed', { message: e.message }); }

      // Send a confirmation email to the driver on approval only.
      // Email failures are caught and logged rather than re-thrown, so a transient
      // mail-server problem does not cause the approval itself to appear to fail.
      if (req.body.status === 'approved') {
        try {
          const { rows: driverRows } = await pool.query(
            `SELECT u.first_name, u.email,
                    COALESCE(
                      (SELECT value FROM configuration WHERE key = 'frontend_language'),
                      'fr'
                    ) AS lang,
                    COALESCE(
                      (SELECT value FROM configuration WHERE key = 'app_name'),
                      'SolidaRoute'
                    ) AS app_name
             FROM users u WHERE u.id = $1`,
            [req.params.id]
          );
          if (driverRows.length) {
            const d = driverRows[0];
            await sendDriverApproved({
              driver:  { first_name: d.first_name, email: d.email },
              appName: d.app_name,
              lang:    d.lang,
            });
          }
        } catch (emailErr) {
          logger.warn('Failed to send driver approval email', { message: emailErr.message });
        }
      }

      res.json({ message: `Driver ${req.body.status}.`, approval_status: rows[0].approval_status });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/drivers/:id/approve-override
//
// Approves a driver while bypassing the document requirement. This is an
// exceptional action that must be explicitly confirmed by the admin.
//
// Minimum requirements that must still be met (documents are the ONLY thing
// that is waived — personal and vehicle data is still required):
//   first_name, last_name, phone      — from users table
//   vehicle_make, vehicle_model,       — from driver_profiles
//   vehicle_year, vehicle_color,
//   license_plate, home_address
//
// If any of those are missing the endpoint returns 422 with a 'missing' array
// so the frontend can inform the admin exactly what is still lacking.
//
// The override is recorded on driver_profiles:
//   approval_overridden     = TRUE
//   approval_overridden_by  = admin user id
//   approval_overridden_at  = NOW()
//
// An audit log entry ('driver.approval_override') is written regardless of
// whether the email notification succeeds.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/approve-override',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      // Fetch the minimum required fields from both tables in one query.
      const { rows: dr } = await pool.query(`
        SELECT u.first_name, u.last_name, u.phone,
               dp.vehicle_make, dp.vehicle_model, dp.vehicle_year,
               dp.vehicle_color, dp.license_plate, dp.home_address
        FROM users u
        LEFT JOIN driver_profiles dp ON dp.user_id = u.id
        WHERE u.id = $1 AND u.role = 'driver'
      `, [req.params.id]);

      if (!dr.length) return res.status(404).json({ error: 'Driver not found.' });
      const d = dr[0];

      // Validate minimum requirements — documents are waived but these are not.
      const missing = [];
      if (!d.first_name?.trim())    missing.push('first_name');
      if (!d.last_name?.trim())     missing.push('last_name');
      if (!d.phone?.trim())         missing.push('phone');
      if (!d.vehicle_make?.trim())  missing.push('vehicle_make');
      if (!d.vehicle_model?.trim()) missing.push('vehicle_model');
      if (!d.vehicle_year)          missing.push('vehicle_year');
      if (!d.vehicle_color?.trim()) missing.push('vehicle_color');
      if (!d.license_plate?.trim()) missing.push('license_plate');
      if (!d.home_address?.trim())  missing.push('home_address');

      if (missing.length > 0) {
        return res.status(422).json({
          error: 'Cannot override: minimum required fields are still missing.',
          missing,
        });
      }

      // Approve with override flags recorded.
      const { rows } = await pool.query(
        `UPDATE driver_profiles
         SET approval_status         = 'approved',
             approved_by             = $1,
             approved_at             = NOW(),
             approval_overridden     = TRUE,
             approval_overridden_by  = $1,
             approval_overridden_at  = NOW(),
             updated_at              = NOW()
         WHERE user_id = $2
         RETURNING approval_status`,
        [req.user.id, req.params.id]
      );

      if (!rows.length) return res.status(404).json({ error: 'Driver profile not found.' });

      // Activate the user account so they can log in and receive trips.
      await pool.query(
        `UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1`,
        [req.params.id]
      );

      // Audit log — always written, even if the email below fails.
      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'driver.approval_override', 'driver_profile', $2,
                   '{"status":"approved","overridden":true}'::jsonb)`,
          [req.user.id, req.params.id]
        );
      } catch (e) { logger.warn('Audit log failed', { message: e.message }); }

      // Send the same approval notification email as the standard flow.
      try {
        const { rows: emailRows } = await pool.query(
          `SELECT u.first_name, u.email,
                  COALESCE((SELECT value FROM configuration WHERE key = 'frontend_language'), 'fr') AS lang,
                  COALESCE((SELECT value FROM configuration WHERE key = 'app_name'), 'SolidaRoute') AS app_name
           FROM users u WHERE u.id = $1`,
          [req.params.id]
        );
        if (emailRows.length) {
          const em = emailRows[0];
          await sendDriverApproved({
            driver:  { first_name: em.first_name, email: em.email },
            appName: em.app_name,
            lang:    em.lang,
          });
        }
      } catch (emailErr) {
        logger.warn('Failed to send override approval email', { message: emailErr.message });
      }

      res.json({
        message:              'Driver approved with override.',
        approval_status:      'approved',
        approval_overridden:  true,
      });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/drivers/:id/documents
//
// Returns metadata (filename, MIME type, size, upload date) for all documents
// submitted by a driver. Does NOT return file contents.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/documents', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT doc_type, slot, filename, mime_type, file_size, uploaded_at
       FROM driver_documents WHERE driver_id = $1 ORDER BY doc_type, slot`,
      [req.params.id]
    );
    res.json({ documents: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/drivers/:id/documents/:type/:slot
//
// Streams the decrypted content of a single driver document inline.
// :type is validated against the DOC_TYPES allow-list to prevent path traversal.
// Decryption happens in memory — plaintext is never written to disk.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/documents/:type/:slot', async (req, res, next) => {
  try {
    const { id, type, slot } = req.params;
    if (!DOC_TYPES.includes(type)) {
      return res.status(422).json({ error: 'Invalid document type.' });
    }
    const slotNum = parseInt(slot, 10);
    if (![1, 2].includes(slotNum)) {
      return res.status(422).json({ error: 'Invalid slot. Must be 1 or 2.' });
    }
    const { rows } = await pool.query(
      `SELECT filename, mime_type
       FROM driver_documents WHERE driver_id = $1 AND doc_type = $2 AND slot = $3`,
      [id, type, slotNum]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found.' });

    // Construct the full file path from the uploads directory, driver ID sub-folder,
    // and the stored filename. The driver ID sub-folder isolates each driver's files.
    const filePath = path.join(UPLOADS_DIR, 'drivers', id, rows[0].filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server.' });
    }
    // Read the encrypted file from disk, decrypt it entirely in memory,
    // and write the plaintext directly to the response.
    const raw       = fs.readFileSync(filePath);
    const plaintext = decryptBuffer(raw);
    res.setHeader('Content-Type', rows[0].mime_type);
    // "inline" tells the browser to render the file in-tab rather than save it.
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].filename)}`);
    res.setHeader('Content-Length', plaintext.length);
    res.end(plaintext);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/drivers/:id
//
// Full detail for a single driver, including all vehicle and profile data
// plus a breakdown of trip counts by status.
// Registered LAST to avoid shadowing /:id/approve and /:id/documents.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const { rows } = await pool.query(`
        SELECT
          u.id, u.first_name, u.last_name, u.email, u.phone,
          u.status, u.created_at, u.last_login_at,
          dp.approval_status, dp.approved_at,
          dp.approval_overridden, dp.approval_overridden_at,
          dp.vehicle_make, dp.vehicle_model, dp.vehicle_year, dp.vehicle_color,
          dp.license_plate, dp.seat_count,
          dp.is_available, dp.average_rating, dp.review_count,
          dp.home_address, dp.service_radius_km,
          -- Upcoming: assigned trips that haven't departed yet.
          COUNT(CASE WHEN t.status = 'assigned' AND t.departure_at > NOW() THEN 1 END)::int AS upcoming_trips,
          COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed_trips,
          COUNT(CASE WHEN t.status = 'cancelled' THEN 1 END)::int AS cancelled_trips
        FROM users u
        LEFT JOIN driver_profiles dp ON dp.user_id = u.id
        LEFT JOIN trips t ON t.driver_id = u.id
        WHERE u.id = $1 AND u.role = 'driver'
        GROUP BY
          u.id, u.first_name, u.last_name, u.email, u.phone, u.status,
          u.created_at, u.last_login_at,
          dp.approval_status, dp.approved_at, dp.approval_overridden, dp.approval_overridden_at,
          dp.vehicle_make, dp.vehicle_model, dp.vehicle_year, dp.vehicle_color,
          dp.license_plate, dp.seat_count, dp.is_available, dp.average_rating, dp.review_count,
          dp.home_address, dp.service_radius_km
      `, [req.params.id]);

      if (!rows.length) return res.status(404).json({ error: 'Driver not found.' });

      // Run the same completeness check the driver sees so the admin knows
      // whether all required fields AND documents are present.
      // is_complete drives the enabled/disabled state of the standard Approve button.
      const { complete, missing } = await checkDriverCompleteness(req.params.id);

      res.json({ driver: { ...rows[0], is_complete: complete, missing_fields: missing } });
    } catch (err) { next(err); }
  }
);

module.exports = router;
