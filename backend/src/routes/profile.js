/**
 * @file profile.js
 * @module routes/profile
 * @description Personal profile management routes for SolidaRoute — /api/profile/*
 *
 * All routes in this file require a valid JWT (`sr_token`). Users may only
 * read and modify their own profile — there is no cross-user access here.
 * Admin-level profile management (e.g. force-editing another user's data)
 * lives in the admin routes module.
 *
 * ---------------------------------------------------------------------------
 * ROUTES:
 *   GET    /                — Full profile with role-specific sub-profile
 *   PUT    /                — Update first_name, last_name, phone
 *                             (email address is intentionally immutable)
 *   PUT    /client          — Upsert client-specific profile data
 *   PUT    /driver          — Upsert driver-specific profile data (vehicle, area)
 *   PUT    /password        — Change own password (current password required)
 *   GET    /check-deletion  — Preview whether the account can be hard-deleted
 *   DELETE /                — Delete or anonymize own account
 *
 * ---------------------------------------------------------------------------
 * ACCOUNT DELETION RULES (Law 25 / GDPR compliance):
 *   Quebec's Law 25 and GDPR both require that financial records be retained
 *   for a minimum period even after a user requests erasure.
 *
 *   - No payment history  → hard delete: the row is removed from the database.
 *   - Has payment history → anonymization only: PII is replaced with placeholder
 *     values, but the row and its financial associations are preserved.
 *
 *   The `can_delete_user()` and `anonymize_user()` PostgreSQL functions
 *   encapsulate this logic on the DB side; this route simply invokes them.
 *   A typed confirmation phrase ("DELETE MY ACCOUNT") is required to prevent
 *   accidental deletion from stray API calls.
 *
 * ---------------------------------------------------------------------------
 * @requires express
 * @requires bcryptjs
 * @requires express-validator
 * @requires ../db/pool
 * @requires ../middleware/auth
 * @requires ../services/password
 * @requires ../utils/logger
 * @requires ../utils/phone
 */

// routes/profile.js — Personal profile management for all authenticated roles
const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool }                   = require('../db/pool');
const { authenticate }           = require('../middleware/auth');
const { validatePassword }       = require('../services/password');
const { normalizePhone }         = require('../utils/phone');
const { geocodeAddress }         = require('../services/routing');
const { checkDriverCompleteness } = require('../utils/driverCompleteness');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the authenticated user's full profile, including their role-specific
 * sub-profile (client_profiles or driver_profiles) if it exists.
 *
 * Auth:    Required
 * Method:  GET
 *
 * The sub-profile is fetched in a separate query (not a JOIN) so the response
 * shape is consistent: base user fields are always present, and the
 * role-specific object is either populated or null.
 *
 * Returns (200): { profile: { ...userFields, client_profile|driver_profile: {...}|null } }
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    // Omit password_hash and email_verified — internal fields that must not
    // be returned to the client even in a full profile response.
    const { rows } = await pool.query(
      `SELECT id, email, first_name, last_name, phone, role, status,
              member_number, created_at, updated_at, last_login_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Profile not found.' });

    const profile = rows[0];

    // Attach the role-specific sub-profile so the client gets everything it
    // needs in one round-trip. A null value signals "profile not yet filled out",
    // which the frontend uses to determine whether to show the profile-setup wizard.
    if (profile.role === 'client') {
      const { rows: cp } = await pool.query(
        'SELECT * FROM client_profiles WHERE user_id = $1', [req.user.id]
      );
      profile.client_profile = cp[0] || null;
    }
    if (profile.role === 'driver') {
      const { rows: dp } = await pool.query(
        'SELECT * FROM driver_profiles WHERE user_id = $1', [req.user.id]
      );
      profile.driver_profile = dp[0] || null;
    }
    // Operators, admins, and superadmins have no sub-profile table;
    // their response contains only the base user fields.

    res.json({ profile });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/completeness
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the driver's profile completeness status: which required fields are
 * still missing before the application can be submitted for admin review.
 *
 * Auth:    Required (driver only)
 * Method:  GET
 *
 * Returns (200): { complete: bool, missing: string[], approval_status: string }
 *
 * The frontend uses this to:
 *   a) Decide whether to show the ProfileCompletenessModal on the dashboard.
 *   b) Drive the red asterisk indicators on each mandatory field.
 *
 * 'missing' is an array of field identifiers such as:
 *   'first_name', 'last_name', 'phone', 'vehicle_make', 'vehicle_model',
 *   'vehicle_year', 'vehicle_color', 'license_plate', 'home_address',
 *   'doc_license', 'doc_insurance', 'doc_registration'
 */
router.get('/completeness', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Drivers only.' });
    }

    const { complete, missing } = await checkDriverCompleteness(req.user.id);

    // Include current approval_status so the frontend can show the correct banner.
    const { rows } = await pool.query(
      `SELECT approval_status FROM driver_profiles WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({
      complete,
      missing,
      approval_status: rows[0]?.approval_status || 'incomplete',
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Updates the user's core personal information: first name, last name, phone.
 *
 * Auth:    Required
 * Method:  PUT
 * Body:    { first_name?, last_name?, phone? }  (all optional, at least one required)
 *
 * Business rules:
 *   - Email address is intentionally NOT editable through this endpoint.
 *     Changing email would require a new verification cycle; a dedicated
 *     email-change flow (with re-verification) would be the correct approach.
 *   - Only the fields present in the request body are updated; omitted fields
 *     are left as-is. This is implemented via a dynamic parameterised query
 *     rather than setting all columns, to avoid accidental null-overwrites.
 *   - Phone numbers are normalised (stripped of formatting) before storage.
 *
 * Returns (200): { message, user: { ...updatedFields } }
 */
router.put('/',
  authenticate,
  [
    // All three fields are optional — the caller may update just one or all three.
    // trim() prevents invisible leading/trailing whitespace from being stored.
    body('first_name').optional().trim().notEmpty(),
    body('last_name').optional().trim().notEmpty(),
    body('phone').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const { first_name, last_name, phone } = req.body;

      // Build the SET clause dynamically — only include columns that were
      // explicitly provided in the request body. This prevents overwriting a
      // field with undefined/null when the caller only intended to update one
      // other field (e.g. updating only the phone should not clear first_name).
      const fields = [];
      const values = [];
      let i = 1;  // PostgreSQL parameterised query counter ($1, $2, …)

      if (first_name !== undefined) { fields.push(`first_name = $${i++}`); values.push(first_name); }
      if (last_name  !== undefined) { fields.push(`last_name = $${i++}`);  values.push(last_name); }
      // normalizePhone() strips spaces, dashes, parentheses so storage is consistent
      if (phone      !== undefined) { fields.push(`phone = $${i++}`);      values.push(normalizePhone(phone)); }

      // Reject requests that carry no recognisable fields to avoid empty DB updates
      if (!fields.length) return res.status(422).json({ error: 'No fields to update.' });

      // Append the user ID as the final parameter used in the WHERE clause.
      // It must come last because $i is incremented as fields are added above.
      values.push(req.user.id);
      const { rows } = await pool.query(
        `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $${i} RETURNING id, email, first_name, last_name, phone, role, status`,
        values
      );

      res.json({ message: 'Profile updated successfully.', user: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/client
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Creates or updates the client-specific profile record for the authenticated user.
 *
 * Auth:    Required (client role only)
 * Method:  PUT
 * Body:    { vulnerability_type?, address?, emergency_contact_name?,
 *            emergency_contact_phone?, mobility_notes?, preferred_language? }
 *
 * Business rules:
 *   - Only users with role='client' may call this endpoint; other roles receive 403.
 *   - The client_profiles row is upserted (INSERT … ON CONFLICT … DO UPDATE)
 *     so the caller does not need to know whether a record exists yet.
 *   - COALESCE is used in the UPDATE branch so that omitted fields keep their
 *     existing DB value rather than being silently cleared to NULL.
 *   - preferred_language defaults to 'fr' (French) to match the platform's
 *     primary audience in Quebec.
 *
 * Returns (200): { message }
 */
router.put('/client',
  authenticate,
  [
    // vulnerability_type drives UI hints and trip accessibility flags downstream;
    // the empty string is permitted so callers can explicitly clear the field.
    body('vulnerability_type').optional().isIn(['elderly','hearing_impaired','mild_disability','no_drivers_license','other','']),
    body('address').optional().trim(),
    body('emergency_contact_name').optional().trim(),
    body('emergency_contact_phone').optional().trim(),
    body('mobility_notes').optional().trim(),
    // French and English are the two supported platform languages (Quebec context)
    body('preferred_language').optional().isIn(['fr','en']),
  ],
  async (req, res, next) => {
    try {
      // Enforce role — drivers or admins calling this endpoint should receive a clear
      // error rather than silently writing to the wrong profile table.
      if (req.user.role !== 'client') {
        return res.status(403).json({ error: 'This endpoint is for clients only.' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const {
        vulnerability_type, address, emergency_contact_name,
        emergency_contact_phone, mobility_notes, preferred_language,
      } = req.body;

      // Upsert the client profile record.
      //
      // INSERT handles the first-time setup case (no row yet for this user).
      // ON CONFLICT (user_id) triggers when a row already exists and runs the UPDATE.
      //
      // COALESCE(EXCLUDED.col, client_profiles.col) means:
      //   "use the value from this request (EXCLUDED) if it was provided,
      //    otherwise keep the value currently in the database row."
      // This enables true partial updates — the caller can send only the fields
      // they want to change, and everything else is left untouched.
      await pool.query(
        `INSERT INTO client_profiles
           (user_id, vulnerability_type, address, emergency_contact_name,
            emergency_contact_phone, mobility_notes, preferred_language)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
           vulnerability_type      = COALESCE(EXCLUDED.vulnerability_type, client_profiles.vulnerability_type),
           address                 = COALESCE(EXCLUDED.address, client_profiles.address),
           emergency_contact_name  = COALESCE(EXCLUDED.emergency_contact_name, client_profiles.emergency_contact_name),
           emergency_contact_phone = COALESCE(EXCLUDED.emergency_contact_phone, client_profiles.emergency_contact_phone),
           mobility_notes          = COALESCE(EXCLUDED.mobility_notes, client_profiles.mobility_notes),
           preferred_language      = COALESCE(EXCLUDED.preferred_language, client_profiles.preferred_language),
           updated_at              = NOW()`,
        [
          req.user.id,
          // Convert empty strings to NULL so COALESCE behaves predictably;
          // an empty string would overwrite a previously set value, which is undesirable.
          vulnerability_type || null, address || null,
          emergency_contact_name || null, emergency_contact_phone || null,
          mobility_notes || null,
          // Default to French ('fr') on first insert if not supplied —
          // Quebec is the primary deployment region.
          preferred_language || 'fr',
        ]
      );

      res.json({ message: 'Client profile updated successfully.' });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/driver
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Creates or updates the driver-specific profile record (vehicle info,
 * home address) for the authenticated driver.
 *
 * Auth:    Required (driver role only)
 * Method:  PUT
 * Body:    { vehicle_make?, vehicle_model?, vehicle_year?, license_plate?,
 *            vehicle_color?, seat_count?, home_address? }
 *
 * Business rules:
 *   - Only users with role='driver' may call this endpoint.
 *   - service_radius_km is NOT editable by drivers. It is set from the admin
 *     configuration key 'driver_suggestion_radius_km' when the driver_profiles
 *     row is first created (at email verification time) and is only changeable
 *     by an admin through the Configuration panel.
 *   - If home_address is provided, it is geocoded via Nominatim/routing service.
 *     If geocoding fails the request is rejected with a 422 so the driver
 *     knows to enter a more specific address.  On success, home_point is also
 *     updated so the PostGIS distance queries stay in sync.
 *   - If no driver_profiles row exists yet, a minimal record is created with
 *     sensible defaults (geometry placeholder at (0,0)) — approval_status is
 *     set to 'incomplete' per the migration 022 default.
 *   - After every save, completeness is checked.  If all required fields and
 *     documents are present AND approval_status is 'incomplete', the status is
 *     automatically promoted to 'pending' so the admin sees the application.
 *   - vehicle_year minimum is 2000 — vehicles older than that are unlikely to
 *     meet insurance requirements for volunteer transport.
 *
 * Returns (200): { message, promoted_to_pending? }
 */
router.put('/driver',
  authenticate,
  [
    body('vehicle_make').optional().trim(),
    body('vehicle_model').optional().trim(),
    // year min 1990: covers a broad range of vehicles suitable for volunteer transport.
    body('vehicle_year').optional().isInt({ min: 1990 }),
    body('license_plate').optional().trim(),
    body('vehicle_color').optional().trim(),
    // seat_count min 1 (the driver alone), max 15 (generous minibus upper bound).
    body('seat_count').optional().isInt({ min: 1, max: 15 }),
    body('home_address').optional().trim(),
    // service_radius_km is intentionally NOT listed here — it is admin-only.
  ],
  async (req, res, next) => {
    try {
      // Enforce role — a client accidentally calling this endpoint should not
      // create a spurious driver_profiles row.
      if (req.user.role !== 'driver') {
        return res.status(403).json({ error: 'This endpoint is for drivers only.' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const {
        vehicle_make, vehicle_model, vehicle_year, license_plate,
        vehicle_color, seat_count, home_address,
      } = req.body;

      // ── Geocode home_address if provided ────────────────────────────────────
      // home_address is the driver's reference point for distance-band matching.
      // We geocode it on save so home_point stays in sync with the human-readable
      // address.  If geocoding fails we do NOT abort the whole request — all other
      // valid fields are still saved and the caller receives a geocode_warning flag
      // so the frontend can show a targeted warning instead of blocking the save.
      let geocodedPoint  = null;
      let geocodeWarning = false;
      if (home_address?.trim()) {
        const regionRow = await pool.query(
          `SELECT value FROM configuration WHERE key = 'geocoding_region' LIMIT 1`
        );
        const regionCode = regionRow.rows[0]?.value || 'CA';
        const result = await geocodeAddress(home_address.trim(), regionCode);
        if (!result) {
          // Geocoding failed — skip home_address / home_point in the UPDATE so we
          // don't overwrite a previously valid address with an unverifiable one.
          geocodeWarning = true;
        } else {
          // Store the geocoded coordinates for home_point update below.
          geocodedPoint = { lat: result.lat, lon: result.lon };
        }
      }

      // Check whether a driver_profiles row already exists for this driver.
      const { rows: existing } = await pool.query(
        'SELECT id FROM driver_profiles WHERE user_id = $1', [req.user.id]
      );

      if (!existing.length) {
        // ── First-time profile creation ──────────────────────────────────────
        // service_radius_km is seeded from config — drivers cannot set it.
        // home_point starts at (0,0) if no address provided yet, or the geocoded
        // point if the driver included their address in this first save.
        const cfgRow = await pool.query(
          `SELECT value FROM configuration WHERE key = 'driver_suggestion_radius_km' LIMIT 1`
        );
        const radius = parseFloat(cfgRow.rows[0]?.value || '10');

        // If geocoding failed, don't store the unverifiable address text.
        const addressToInsert = geocodeWarning ? null : (home_address || null);

        // Use parameterized binding for coordinates — never interpolate floats
        // directly into SQL, even when they come from a trusted geocoding source.
        if (geocodedPoint) {
          await pool.query(
            `INSERT INTO driver_profiles
               (user_id, vehicle_make, vehicle_model, vehicle_year, license_plate,
                seat_count, home_address, home_point, service_radius_km)
             VALUES ($1, $2, $3, $4, $5, $6, $7,
                     ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography, $10)`,
            [
              req.user.id,
              vehicle_make  || '',
              vehicle_model || '',
              vehicle_year  || new Date().getFullYear(),
              license_plate || '',
              seat_count    || 4,
              addressToInsert,
              geocodedPoint.lon, geocodedPoint.lat,
              radius,
            ]
          );
        } else {
          await pool.query(
            `INSERT INTO driver_profiles
               (user_id, vehicle_make, vehicle_model, vehicle_year, license_plate,
                seat_count, home_address, home_point, service_radius_km)
             VALUES ($1, $2, $3, $4, $5, $6, $7,
                     ST_SetSRID(ST_MakePoint(0,0), 4326)::geography, $8)`,
            [
              req.user.id,
              vehicle_make  || '',
              vehicle_model || '',
              vehicle_year  || new Date().getFullYear(),
              license_plate || '',
              seat_count    || 4,
              addressToInsert,
              radius,
            ]
          );
        }
      } else {
        // ── Partial update of an existing profile ────────────────────────────
        // Build a dynamic SET clause for all driver-editable columns.
        // service_radius_km is deliberately excluded from this map.
        const fields = [];
        const values = [];
        let i = 1;

        const updatable = {
          vehicle_make, vehicle_model, vehicle_year, license_plate,
          vehicle_color, seat_count,
          // Omit home_address if geocoding failed — preserve the existing valid address.
          ...(geocodeWarning ? {} : { home_address }),
        };
        for (const [key, val] of Object.entries(updatable)) {
          if (val !== undefined) { fields.push(`${key} = $${i++}`); values.push(val); }
        }

        // Also update home_point if the address was geocoded in this request.
        if (geocodedPoint) {
          fields.push(
            `home_point = ST_SetSRID(ST_MakePoint($${i++}, $${i++}), 4326)::geography`
          );
          values.push(geocodedPoint.lon, geocodedPoint.lat);
        }

        if (fields.length) {
          // Append the user ID for the WHERE clause — must be last.
          values.push(req.user.id);
          await pool.query(
            `UPDATE driver_profiles SET ${fields.join(', ')}, updated_at = NOW()
             WHERE user_id = $${i}`,
            values
          );
        }
      }

      // ── Auto-promote to 'pending' when profile is complete ─────────────────
      // After each save we run the completeness check.  If all required fields
      // and documents are present AND the driver is still 'incomplete', we
      // transition them to 'pending' so the admin sees the application.
      // This is a no-op for drivers who are already 'pending' or 'approved'.
      let promotedToPending = false;
      const completeness = await checkDriverCompleteness(req.user.id);
      if (completeness.complete) {
        const { rowCount } = await pool.query(
          `UPDATE driver_profiles SET approval_status = 'pending', updated_at = NOW()
           WHERE user_id = $1 AND approval_status = 'incomplete'`,
          [req.user.id]
        );
        promotedToPending = rowCount > 0;
      }

      res.json({
        message: 'Driver profile updated successfully.',
        ...(geocodeWarning    && { geocode_warning: true }),
        ...(promotedToPending && { promoted_to_pending: true }),
      });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/password
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Allows an authenticated user to change their own password.
 *
 * Auth:    Required
 * Method:  PUT
 * Body:    { current_password, new_password }
 *
 * Business rules:
 *   - The user must supply their current password to authorize the change.
 *     This prevents an attacker who merely has a stolen JWT from locking the
 *     legitimate user out of their account by setting a new password.
 *   - The new password must pass the same complexity rules as registration
 *     (sourced from the `configuration` table).
 *   - The complexity check is run before the current-password verification to
 *     give early feedback on a bad new password without revealing whether the
 *     current password was correct.
 *   - The $2a$ → $2b$ hash normalization is applied here too, in case the
 *     existing hash was created by pgcrypto.
 *
 * Returns (200): { message }
 */
router.put('/password',
  authenticate,
  [
    body('current_password').notEmpty(),
    body('new_password').notEmpty().withMessage('New password is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const { current_password, new_password } = req.body;

      // Validate the new password against the platform's complexity policy BEFORE
      // fetching the current hash from the DB. Failing fast on a bad new password
      // saves a DB round-trip and gives the user actionable feedback immediately.
      const validation = await validatePassword(new_password);
      if (!validation.valid) {
        return res.status(422).json({
          error: 'Password does not meet security requirements.',
          password_errors: validation.errors,
        });
      }

      // Fetch only the hash — no other columns needed for this operation.
      const { rows } = await pool.query(
        'SELECT password_hash FROM users WHERE id = $1', [req.user.id]
      );

      // Normalize the stored hash prefix for bcryptjs compatibility.
      // This mirrors the same logic in auth.js login — see normalizeHash() there
      // for a full explanation of the $2a$ vs $2b$ prefix difference.
      const hash = rows[0].password_hash.startsWith('$2a$')
        ? '$2b$' + rows[0].password_hash.slice(4)
        : rows[0].password_hash;

      // Verify the current password — this is the gate that prevents an attacker
      // with only a stolen JWT token from changing the password and locking out
      // the legitimate account owner.
      const valid = await bcrypt.compare(current_password, hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

      // Hash the new password with cost factor 10 (same as registration) and persist.
      const newHash = await bcrypt.hash(new_password, 10);
      await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, req.user.id]
      );

      res.json({ message: 'Password updated successfully.' });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/check-deletion
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Preview endpoint: tells the client whether their account can be hard-deleted
 * or must be anonymized, without actually performing any deletion.
 *
 * Auth:    Required
 * Method:  GET
 *
 * Delegates entirely to the `can_delete_user(user_id, FALSE)` PostgreSQL function
 * which inspects payment history and any other retention obligations defined
 * in the DB. The second argument (FALSE) is a dry-run flag — it evaluates the
 * rules but makes no changes.
 *
 * Returns (200): { can_delete: bool, anonymize_only: bool, reason?: string }
 */
router.get('/check-deletion', authenticate, async (req, res, next) => {
  try {
    // The DB function encapsulates all Law 25 / GDPR retention logic in one place.
    // Keeping this logic in the database ensures it is applied consistently
    // from any context that might trigger deletion — this API, scheduled cleanup
    // jobs, admin panel tools — without requiring each caller to re-implement it.
    const { rows } = await pool.query(
      'SELECT can_delete_user($1, FALSE) AS result', [req.user.id]
    );
    // The function returns a JSON object directly, so we forward it as-is.
    res.json(rows[0].result);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/profile
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Permanently deletes or anonymizes the authenticated user's own account.
 *
 * Auth:    Required
 * Method:  DELETE
 * Body:    { confirmation: "DELETE MY ACCOUNT" }
 *
 * Business rules:
 *   - The user must send the exact phrase "DELETE MY ACCOUNT" in the request body.
 *     This is a deliberate friction mechanism to prevent accidental self-deletion
 *     from a stray API call or a UI bug (e.g. a double-submit on a form).
 *   - `can_delete_user()` is consulted again at deletion time (not just at preview)
 *     to guard against race conditions between the preview and the actual delete.
 *   - If the user has no financial records: hard delete — row removed permanently.
 *   - If the user has financial records: anonymization — PII replaced with
 *     placeholder values via the `anonymize_user()` DB function; the row is
 *     retained for accounting/legal compliance.
 *   - If the DB function returns can_delete=false and anonymize_only=false,
 *     the deletion is refused and the reason is returned to the caller.
 *
 * Returns (200): { type: 'deleted'|'anonymized', message }
 */
router.delete('/', authenticate,
  [ body('confirmation').equals('DELETE MY ACCOUNT') ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        // Deliberately vague error — tells the user what to type without going
        // into detail about the validation mechanism.
        return res.status(422).json({ error: 'Please type exactly: DELETE MY ACCOUNT' });
      }

      // Re-check deletion eligibility at the moment of deletion, not only at
      // /check-deletion time. This guards against TOCTOU (time-of-check /
      // time-of-use) races — for example, a payment being created between the
      // preview call and this call, which would change the eligibility result.
      const { rows } = await pool.query(
        'SELECT can_delete_user($1, FALSE) AS result', [req.user.id]
      );
      const check = rows[0].result;

      // The user has financial history — hard deletion would violate retention
      // obligations. Anonymize instead: PII is replaced with placeholders so the
      // row remains for accounting purposes but can no longer be linked to the
      // real person (Law 25 / GDPR "right to erasure" satisfied by anonymization).
      if (check.anonymize_only) {
        await pool.query('SELECT anonymize_user($1)', [req.user.id]);
        return res.json({ type: 'anonymized', message: 'Your account has been anonymized.' });
      }

      // DB function determined deletion is not permitted for a reason other than
      // financial history (e.g. active/upcoming trips that cannot be cancelled).
      // Return the reason string from the DB function so the user understands
      // what they need to resolve before requesting deletion.
      if (!check.can_delete) {
        return res.status(403).json({ error: check.reason });
      }

      // No financial history, no active obligations — safe to hard delete.
      // Nullify actor_id in audit logs first: the audit_logs FK (actor_id → users.id)
      // would otherwise block the DELETE.  The audit records are preserved for
      // compliance; only the link to the deleted account is cleared.
      await pool.query(
        'UPDATE audit_logs SET actor_id = NULL WHERE actor_id = $1',
        [req.user.id]
      );
      // All other related rows are removed via ON DELETE CASCADE FKs in the schema.
      await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
      res.json({ type: 'deleted', message: 'Your account has been permanently deleted.' });
    } catch (err) { next(err); }
  }
);

module.exports = router;
