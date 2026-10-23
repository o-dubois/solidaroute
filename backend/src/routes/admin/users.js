/**
 * @file routes/admin/users.js
 * @description User management routes for admins.
 *              Mounted at /api/admin/users
 *
 * Auth: operator or superadmin (enforced by parent router).
 *       DELETE /:id requires superadmin (additional authorize call).
 *
 * Routes:
 *   GET    /             — paginated, filterable user list
 *   GET    /:id          — full profile for one user
 *   PATCH  /:id/status   — activate, suspend, or reset a user's status
 *   PATCH  /:id/password — admin-forced password reset
 *   DELETE /:id          — delete or anonymize a client/driver (superadmin)
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, param, validationResult } = require('express-validator');
const { pool }                    = require('../../db/pool');
const { authorize, canActOn }     = require('../../middleware/auth');
const { validatePassword } = require('../../services/password');
const { logger }                  = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users
//
// Paginated list of all users with optional filtering.
// Query params: role, status, search, limit (default 50), offset (default 0)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { role, status, search, limit = 50, offset = 0 } = req.query;
    // Build the WHERE clause dynamically so unused filters don't appear in the query.
    const conditions = [];
    const values = [];
    let i = 1; // PostgreSQL uses $1, $2, ... placeholders; i tracks the next index.

    if (role)   { conditions.push(`u.role = $${i++}`);   values.push(role); }
    if (status) { conditions.push(`u.status = $${i++}`); values.push(status); }
    if (search) {
      // A single placeholder is reused across three columns to keep the
      // parameter list compact; ILIKE is case-insensitive on all three.
      conditions.push(`(u.email ILIKE $${i} OR u.first_name ILIKE $${i} OR u.last_name ILIKE $${i})`);
      values.push(`%${search}%`); i++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone,
              u.role, u.status, u.email_verified, u.created_at, u.last_login_at,
              u.is_protected, u.member_number,
              dp.approval_status AS driver_approval_status,
              dp.average_rating, dp.review_count
       FROM users u
       LEFT JOIN driver_profiles dp ON dp.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );

    res.json({ users: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users/:id
//
// Full profile for a single user, including role-specific profile columns
// and lifetime trip/payment counts.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.*,
           cp.vulnerability_type, cp.address, cp.emergency_contact_name,
           cp.emergency_contact_phone, cp.mobility_notes, cp.preferred_language,
           dp.vehicle_make, dp.vehicle_model, dp.vehicle_year, dp.license_plate,
           dp.seat_count, dp.home_address, dp.service_radius_km,
           dp.is_available, dp.approval_status,
           dp.average_rating, dp.review_count,
           -- Count trips regardless of whether the user was the client or the driver,
           -- so the summary figure is meaningful for both roles.
           (SELECT COUNT(*) FROM trips WHERE client_id = u.id OR driver_id = u.id) AS trip_count,
           (SELECT COUNT(*) FROM payments p JOIN trips t ON t.id = p.trip_id
            WHERE (t.client_id = u.id OR t.driver_id = u.id) AND p.status = 'paid') AS payment_count
         FROM users u
         LEFT JOIN client_profiles cp ON cp.user_id = u.id
         LEFT JOIN driver_profiles dp ON dp.user_id = u.id
         WHERE u.id = $1`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });
      res.json({ user: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/status
//
// Activates, suspends, or returns a user to 'pending' status.
// Guards: protected accounts, role hierarchy (canActOn), self-modification.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/status',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  body('status').isIn(['active', 'suspended', 'pending']),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      // Fetch the target user first so we can check role and protection flags
      // before making any changes.
      const { rows: target } = await pool.query(
        'SELECT id, role, status, is_protected FROM users WHERE id = $1', [req.params.id]
      );
      if (!target.length) return res.status(404).json({ error: 'User not found.' });

      // is_protected marks bootstrap/system accounts that must never be altered via the UI.
      if (target[0].is_protected) {
        return res.status(403).json({ error: 'This account is protected and cannot be modified.' });
      }
      // Prevent privilege escalation: an operator cannot act on another operator or higher.
      if (!canActOn(req.user, target[0].role)) {
        return res.status(403).json({ error: 'You cannot modify a user with a higher role.' });
      }
      // Self-modification guard: an admin could accidentally lock themselves out.
      if (target[0].id === req.user.id) {
        return res.status(403).json({ error: 'You cannot change your own status.' });
      }

      // When re-activating an account, also clear any auto-lockout state so the
      // user is not immediately re-locked on their next login attempt.
      const resetLock = req.body.status === 'active'
        ? ', failed_login_attempts = 0, account_locked_at = NULL'
        : '';
      const { rows } = await pool.query(
        `UPDATE users SET status = $1${resetLock}, updated_at = NOW()
         WHERE id = $2 RETURNING id, email, status`,
        [req.body.status, req.params.id]
      );

      // Audit log failure is non-fatal: swallow the error so the status change
      // itself is not rolled back due to an audit infrastructure problem.
      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'user.status_changed', 'user', $2, jsonb_build_object('status', $3))`,
          [req.user.id, req.params.id, req.body.status]
        );
      } catch (e) { logger.warn('Audit log failed', { message: e.message }); }

      res.json({ message: 'Status updated.', user: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/password
//
// Admin-forced password reset without knowing the existing password.
// Validates the new password against the platform's password policy.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/password',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  body('new_password').notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      // Validate against the platform password policy (minimum length, complexity rules,
      // etc.) before doing any DB work — fail fast if the password is too weak.
      const validation = await validatePassword(req.body.new_password);
      if (!validation.valid) {
        return res.status(422).json({
          error: 'Password does not meet security requirements.',
          password_errors: validation.errors,
        });
      }

      const { rows: target } = await pool.query(
        'SELECT id, role, email FROM users WHERE id = $1', [req.params.id]
      );
      if (!target.length) return res.status(404).json({ error: 'User not found.' });
      // Role hierarchy check: cannot reset the password of a higher-ranked account.
      if (!canActOn(req.user, target[0].role)) {
        return res.status(403).json({ error: 'You cannot change the password of a higher-level user.' });
      }

      // Cost factor 10 (vs 12 for operator accounts) is used here because this
      // is a temporary admin-forced reset; the user will likely set their own
      // password immediately, so the slightly lower cost is acceptable.
      const hash = await bcrypt.hash(req.body.new_password, 10);
      await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [hash, req.params.id]
      );

      // Record who changed the password and what role they held at the time.
      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'user.password_changed', 'user', $2,
                   ('{"by_role":"' || $3 || '"}')::jsonb)`,
          [req.user.id, req.params.id, req.user.role]
        );
      } catch (e) { logger.warn('Audit log failed', { message: e.message }); }

      res.json({ message: `Password for ${target[0].email} updated successfully.` });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:id
//
// Deletes or anonymizes a client or driver account (superadmin only).
// Delegates the deletion decision to can_delete_user() PostgreSQL function.
//
//   can_delete = true, anonymize_only = false → hard delete
//   anonymize_only = true                     → PII scrubbed, history kept
//   can_delete = false                        → 403 with reason
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id',
  authorize('superadmin'),
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  async (req, res, next) => {
    try {
      // Self-deletion guard: a superadmin should never be able to remove themselves.
      if (req.params.id === req.user.id) {
        return res.status(403).json({ error: 'You cannot delete your own account.' });
      }

      // Existence check: can_delete_user() returns "can delete" for any UUID that
      // has no DB constraints — including non-existent ones. Verify the user exists
      // first so we return 404 rather than silently completing a ghost delete.
      const { rows: exists } = await pool.query(
        'SELECT id FROM users WHERE id = $1', [req.params.id]
      );
      if (!exists.length) return res.status(404).json({ error: 'User not found.' });

      // Ask the DB function whether the user can be deleted and if not, why.
      const { rows } = await pool.query(
        'SELECT can_delete_user($1, TRUE) AS result', [req.params.id]
      );
      const check = rows[0].result;

      // anonymize_only takes precedence over can_delete: even when the user
      // could technically be deleted, linked records requiring data retention
      // (e.g. completed trips for billing history) mean we anonymize instead.
      if (check.anonymize_only) {
        await pool.query('SELECT anonymize_user($1)', [req.params.id]);
        return res.json({ type: 'anonymized', message: 'User has been anonymized.' });
      }
      // The DB function blocked deletion (e.g. open payment, active trip in progress).
      if (!check.can_delete) {
        return res.status(403).json({ error: check.reason });
      }

      // All checks passed — perform the hard delete.
      await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
      res.json({ type: 'deleted', message: 'User permanently deleted.' });
    } catch (err) { next(err); }
  }
);

module.exports = router;
