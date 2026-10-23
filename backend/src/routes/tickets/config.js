/**
 * @file routes/tickets/config.js
 * @description Mobility ticket facial-value change-request workflow.
 *              Mounted at /api/tickets/config
 *
 * Routes:
 *   GET  /             — current config + pending request + history (ticket_master+)
 *   POST /propose      — submit a new change request (ticket_master+)
 *   POST /:id/approve  — approve a pending request (ticket_master+, not own request)
 *   POST /:id/reject   — reject a pending request  (ticket_master+, not own request)
 */

const express  = require('express');
const { pool } = require('../../db/pool');
const { authenticate, authorize } = require('../../middleware/auth');
const { logger } = require('../../utils/logger');
const { getMobilityConfig } = require('./helpers');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/config
//
// Purpose: Return the current mobility ticket configuration (facial value +
//   currency) and any pending change request, plus recent request history.
// Auth:    ticket_master, superadmin, operator
// Returns: { facial_value, currency, pending, history }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/',
  authenticate,
  authorize('ticket_master', 'operator', 'superadmin'),
  async (req, res, next) => {
    try {
      const cfg = await getMobilityConfig(pool);

      const { rows: pending } = await pool.query(
        `SELECT r.*,
           u_req.first_name  AS requester_first_name,
           u_req.last_name   AS requester_last_name,
           u_rev.first_name  AS reviewer_first_name,
           u_rev.last_name   AS reviewer_last_name
         FROM config_change_requests r
         JOIN users u_req ON u_req.id = r.requested_by
         LEFT JOIN users u_rev ON u_rev.id = r.reviewed_by
         WHERE r.config_key = 'mobility_ticket_facial_value'
           AND r.status = 'pending'
         LIMIT 1`
      );

      const { rows: history } = await pool.query(
        `SELECT r.*,
           u_req.first_name  AS requester_first_name,
           u_req.last_name   AS requester_last_name,
           u_rev.first_name  AS reviewer_first_name,
           u_rev.last_name   AS reviewer_last_name
         FROM config_change_requests r
         JOIN users u_req ON u_req.id = r.requested_by
         LEFT JOIN users u_rev ON u_rev.id = r.reviewed_by
         WHERE r.config_key = 'mobility_ticket_facial_value'
           AND r.status != 'pending'
         ORDER BY r.reviewed_at DESC
         LIMIT 10`
      );

      res.json({
        facial_value: cfg.facialValue,
        currency:     cfg.currency,
        pending:      pending[0] || null,
        history,
      });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/config/propose
//
// Purpose: Submit a proposal to change the global mobility ticket facial value.
//   Only one pending proposal allowed at a time.
// Auth:    ticket_master, superadmin, operator
// Body:    { proposed_value, reason? }
// Returns: { request }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/propose',
  authenticate,
  authorize('ticket_master', 'operator', 'superadmin'),
  async (req, res, next) => {
    try {
      const { proposed_value, reason } = req.body;
      const val = parseFloat(proposed_value);

      // isFinite also blocks Infinity/-Infinity which pass isNaN but are not valid prices.
      if (isNaN(val) || !isFinite(val) || val <= 0) {
        return res.status(400).json({
          error: 'proposed_value must be a positive finite number.',
          code:  'INVALID_VALUE',
        });
      }

      // Check for existing pending request
      const { rows: existing } = await pool.query(
        `SELECT id FROM config_change_requests
         WHERE config_key = 'mobility_ticket_facial_value' AND status = 'pending'`
      );
      if (existing.length) {
        return res.status(409).json({
          error: 'A change request for this setting is already pending approval.',
          code:  'ALREADY_PENDING',
        });
      }

      const cfg = await getMobilityConfig(pool);

      const { rows } = await pool.query(
        `INSERT INTO config_change_requests
           (config_key, current_value, proposed_value, requested_by, reason)
         VALUES ('mobility_ticket_facial_value', $1, $2, $3, $4)
         RETURNING *`,
        [String(cfg.facialValue), String(val), req.user.id, reason?.trim() || null]
      );

      logger.info('config_change_requests: proposal submitted', {
        requestId: rows[0].id, proposedValue: val, by: req.user.id,
      });

      res.status(201).json({ request: rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/config/:id/approve
//
// Purpose: Approve a pending facial value change request.
//   The approver must be different from the requester.
//   On approval the configuration table is updated immediately.
// Auth:    ticket_master (not the requester), operator, superadmin
// Body:    { review_note? }
// Returns: { request }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/approve',
  authenticate,
  authorize('ticket_master', 'operator', 'superadmin'),
  async (req, res, next) => {
    const db = await pool.connect();
    try {
      const { rows } = await db.query(
        `SELECT * FROM config_change_requests WHERE id = $1 AND status = 'pending'`,
        [req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Pending request not found.', code: 'NOT_FOUND' });
      }
      const request = rows[0];

      if (request.requested_by === req.user.id) {
        return res.status(403).json({
          error: 'You cannot approve your own change request.',
          code:  'SELF_APPROVAL',
        });
      }

      await db.query('BEGIN');

      // Apply the change to the configuration table
      await db.query(
        `UPDATE configuration SET value = $1, updated_at = NOW()
         WHERE key = $2`,
        [request.proposed_value, request.config_key]
      );

      const { rows: updated } = await db.query(
        `UPDATE config_change_requests
         SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
         WHERE id = $3
         RETURNING *`,
        [req.user.id, req.body.review_note?.trim() || null, request.id]
      );

      await db.query('COMMIT');

      logger.info('config_change_requests: approved', {
        requestId: request.id, newValue: request.proposed_value, by: req.user.id,
      });

      res.json({ request: updated[0] });
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      db.release();
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/config/:id/reject
//
// Purpose: Reject a pending facial value change request.
//   Same eligibility rules as approve — cannot reject your own request.
// Auth:    ticket_master (not the requester), operator, superadmin
// Body:    { review_note? }
// Returns: { request }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/reject',
  authenticate,
  authorize('ticket_master', 'operator', 'superadmin'),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM config_change_requests WHERE id = $1 AND status = 'pending'`,
        [req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Pending request not found.', code: 'NOT_FOUND' });
      }
      const request = rows[0];

      if (request.requested_by === req.user.id) {
        return res.status(403).json({
          error: 'You cannot reject your own change request.',
          code:  'SELF_REJECTION',
        });
      }

      const { rows: updated } = await pool.query(
        `UPDATE config_change_requests
         SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
         WHERE id = $3
         RETURNING *`,
        [req.user.id, req.body.review_note?.trim() || null, request.id]
      );

      logger.info('config_change_requests: rejected', {
        requestId: request.id, by: req.user.id,
      });

      res.json({ request: updated[0] });
    } catch (err) { next(err); }
  }
);

module.exports = router;
