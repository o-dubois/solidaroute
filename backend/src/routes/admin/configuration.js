/**
 * @file routes/admin/configuration.js
 * @description Configuration management routes (superadmin only).
 *              Mounted at /api/admin/configuration
 *
 * Auth: superadmin ONLY for both routes (additional authorize call on top of
 *       the operator/superadmin guard applied by the parent router).
 *
 * Routes:
 *   GET / — read all configuration entries
 *   PUT /:key — upsert a configuration value
 *
 * Note: GET /api/admin/configuration/public (unauthenticated) is handled
 *       directly in admin.js before the auth guard, not here.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool }            = require('../../db/pool');
const { authorize }       = require('../../middleware/auth');
const { invalidateCache } = require('../../services/password');
const { logger }          = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/configuration
//
// Returns ALL configuration key/value pairs including sensitive ones such
// as password policy keys and driver-matching parameters.
// Auth: superadmin ONLY (sensitive settings must not be visible to operators).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/',
  authorize('superadmin'),
  async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT key, value, description, updated_at FROM configuration ORDER BY key'
      );
      res.json({ configuration: rows });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/configuration/:key
//
// Creates or updates a single configuration entry (upsert semantics).
// Auth: superadmin ONLY.
//
// Special side effect: if the updated key starts with 'password_', the
// in-memory password-rules cache is invalidated so the new policy takes
// effect immediately without a server restart.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:key',
  authorize('superadmin'),
  body('value').notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

      const { rows } = await pool.query(
        `INSERT INTO configuration (key, value, updated_at, updated_by)
         VALUES ($3, $1, NOW(), $2)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [req.body.value, req.user.id, req.params.key]
      );

      // Invalidate the password rules cache whenever a password-related key changes,
      // so the updated policy is enforced immediately without a server restart.
      if (req.params.key.startsWith('password_')) {
        invalidateCache();
      }

      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
           VALUES ($1, 'config.updated', 'configuration', NULL,
                   jsonb_build_object('key', $2, 'new_value', $3))`,
          [req.user.id, req.params.key, req.body.value]
        );
      } catch (e) { logger.warn('Audit log failed', { message: e.message }); }

      res.json({ setting: rows[0] });
    } catch (err) { next(err); }
  }
);

module.exports = router;
