/**
 * @file routes/admin/operators.js
 * @description Operator and superadmin account management.
 *              Mounted at /api/admin/operators
 *
 * Auth: operator or superadmin (enforced by parent router).
 *       POST / and DELETE /:id require superadmin (additional authorize call).
 *
 * Routes:
 *   POST   / — create a new operator/superadmin account (superadmin only)
 *   PATCH  /:id — update an operator/superadmin profile
 *   DELETE /:id — hard-delete an operator account (superadmin only)
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, param, validationResult } = require('express-validator');
const { pool }                    = require('../../db/pool');
const { authorize, canActOn }     = require('../../middleware/auth');
const { invalidateCache }         = require('../../services/password');
const { normalizePhone }          = require('../../utils/phone');
const { logger }                  = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/operators
//
// Creates a new operator or superadmin account (superadmin only).
// New accounts are created with status = 'active' and email_verified = true.
// bcrypt cost factor 12 (vs 10 elsewhere) for high-value admin accounts.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/',
  authorize('superadmin'),
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('role').isIn(['operator', 'superadmin', 'ticket_master']),
  body('phone').trim().notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const { first_name, last_name, email, password, role, phone } = req.body;

      // Prevent duplicate accounts — check before hashing the password (cheap check first).
      const { rows: existing } = await pool.query(
        'SELECT id FROM users WHERE email = $1', [email]
      );
      if (existing.length) return res.status(409).json({ error: 'Email already in use.' });

      // Cost factor 12 for admin-level accounts (higher than the default 10 used elsewhere)
      // because these accounts are higher-value targets worth the extra hashing time.
      const hash = await bcrypt.hash(password, 12);
      const { rows } = await pool.query(
        `INSERT INTO users
           (email, password_hash, first_name, last_name, phone, role, status, email_verified)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', true)
         RETURNING id, email, first_name, last_name, phone, role, status, created_at, is_protected`,
        [email, hash, first_name, last_name, normalizePhone(phone), role]
      );

      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'user.created', 'user', $2, $3::jsonb)`,
          [req.user.id, rows[0].id, JSON.stringify({ role, email })]
        );
      } catch (e) { logger.warn('Audit log failed', { message: e.message }); }

      res.status(201).json({ user: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/operators/:id
//
// Updates profile fields (name, email, phone) and optionally resets the
// password for an existing operator or superadmin account.
// Sparse update — only provided fields are written.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id',
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  body('first_name').optional().trim().notEmpty(),
  body('last_name').optional().trim().notEmpty(),
  body('email').optional().isEmail().normalizeEmail(),
  body('phone').trim().notEmpty(),
  body('password').optional().isLength({ min: 8 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const { rows: target } = await pool.query(
        'SELECT id, role, is_protected FROM users WHERE id = $1', [req.params.id]
      );
      if (!target.length) return res.status(404).json({ error: 'User not found.' });
      // Protected accounts are off-limits to all callers, including superadmins.
      if (target[0].is_protected) {
        return res.status(403).json({ error: 'This account is protected and cannot be modified.' });
      }
      // Redirect self-edits to the profile endpoint to enforce current-password checks.
      if (req.params.id === req.user.id) {
        return res.status(403).json({ error: 'Use the profile endpoint to modify your own account.' });
      }
      // Role hierarchy check: cannot modify a peer or higher-ranked account.
      if (!canActOn(req.user, target[0].role)) {
        return res.status(403).json({ error: 'Insufficient privileges.' });
      }

      const { first_name, last_name, email, phone, password } = req.body;

      // If changing email, confirm the new address is not already taken by
      // a different account (excluding the target account itself).
      if (email) {
        const { rows: taken } = await pool.query(
          'SELECT id FROM users WHERE email = $1 AND id != $2', [email, req.params.id]
        );
        if (taken.length) return res.status(409).json({ error: 'Email already in use.' });
      }

      // Build the SET clause dynamically so only supplied fields are written.
      const sets = [];
      const vals = [];
      let n = 1;
      if (first_name !== undefined) { sets.push(`first_name = $${n++}`); vals.push(first_name); }
      if (last_name  !== undefined) { sets.push(`last_name = $${n++}`);  vals.push(last_name); }
      if (email      !== undefined) { sets.push(`email = $${n++}`);      vals.push(email); }
      if (phone      !== undefined) { sets.push(`phone = $${n++}`);      vals.push(normalizePhone(phone)); }
      if (password) {
        const hash = await bcrypt.hash(password, 12);
        sets.push(`password_hash = $${n++}`);
        vals.push(hash);
        // Clear the cached password rules so the next validation re-reads from DB.
        invalidateCache(req.params.id);
      }
      if (!sets.length) return res.status(422).json({ error: 'Nothing to update.' });
      // Always update updated_at when any field changes.
      sets.push(`updated_at = NOW()`);
      vals.push(req.params.id); // Final bind param: used in the WHERE clause.

      const { rows } = await pool.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${n}
         RETURNING id, email, first_name, last_name, phone, role, status, is_protected`,
        vals
      );
      res.json({ user: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/operators/:id
//
// Permanently hard-deletes an operator or superadmin account (superadmin only).
// Guards: cannot delete self, cannot delete protected accounts, canActOn check.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id',
  authorize('superadmin'),
  param('id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      // Self-deletion guard: a superadmin should never be able to remove themselves.
      if (req.params.id === req.user.id) {
        return res.status(403).json({ error: 'You cannot delete your own account.' });
      }

      const { rows: target } = await pool.query(
        'SELECT id, role, is_protected FROM users WHERE id = $1', [req.params.id]
      );
      if (!target.length) return res.status(404).json({ error: 'User not found.' });
      if (target[0].is_protected) {
        return res.status(403).json({ error: 'This account is protected and cannot be deleted.' });
      }
      if (!canActOn(req.user, target[0].role)) {
        return res.status(403).json({ error: 'Insufficient privileges.' });
      }

      // Hard delete — permanently removes the account and all related data via CASCADE.
      await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);

      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'user.deleted', 'user', $2, '{"status":"permanently_deleted"}'::jsonb)`,
          [req.user.id, req.params.id]
        );
      } catch (e) { logger.warn('Audit log failed', { message: e.message }); }

      res.json({ message: 'User permanently deleted.' });
    } catch (err) { next(err); }
  }
);

module.exports = router;
