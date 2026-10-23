/**
 * @file routes/tickets/notebooks.js
 * @description Notebook management routes — mounted at /api/tickets/notebooks
 *
 * Routes:
 *   GET  /          — list all notebooks with ticket counts (ticket_master+)
 *   POST /          — create one or more notebooks (ticket_master+)
 *   GET  /:id       — notebook detail + all 10 tickets (ticket_master+)
 *   POST /import    — bulk-create notebooks from CSV rows (ticket_master+)
 */

const express  = require('express');
const { pool } = require('../../db/pool');
const { authenticate, authorize } = require('../../middleware/auth');
const { logger } = require('../../utils/logger');
const {
  generateNotebookKey,
  generateNotebookStart,
  getMobilityConfig,
} = require('./helpers');

const router = express.Router();

// UUID validation regex — used to guard /:id before hitting the DB
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/notebooks
//
// Purpose: List all ticket notebooks with per-notebook ticket counts.
// Auth:    ticket_master, superadmin
// Returns: { notebooks: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/',
  authenticate,
  authorize('ticket_master', 'superadmin'),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           n.id, n.notebook_number, n.owner_type,
           n.org_name,
           n.notebook_key,
           n.ticket_start,
           n.facial_value, n.currency,
           n.notes, n.created_at,
           n.paid, n.paid_at, n.paid_by,
           u_owner.first_name  AS owner_first_name,
           u_owner.last_name   AS owner_last_name,
           u_creator.first_name AS creator_first_name,
           u_creator.last_name  AS creator_last_name,
           COUNT(mt.id)                                          AS total_tickets,
           COUNT(mt.id) FILTER (WHERE mt.status = 'available')  AS available_tickets,
           COUNT(mt.id) FILTER (WHERE mt.status = 'reserved')   AS reserved_tickets,
           COUNT(mt.id) FILTER (WHERE mt.status = 'used')       AS used_tickets,
           COUNT(mt.id) FILTER (WHERE mt.status = 'voided')     AS voided_tickets
         FROM ticket_notebooks n
         LEFT JOIN users u_owner   ON u_owner.id   = n.owner_client_id
         LEFT JOIN users u_creator ON u_creator.id = n.created_by
         LEFT JOIN mobility_tickets mt ON mt.notebook_id = n.id
         GROUP BY n.id, u_owner.first_name, u_owner.last_name,
                  u_creator.first_name, u_creator.last_name
         ORDER BY n.notebook_number DESC`
      );
      res.json({ notebooks: rows });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/notebooks
//
// Purpose: Create one or more notebooks of 10 tickets each.
//   Facial value is always read from global configuration — no per-notebook override.
// Auth:    ticket_master, superadmin
// Body:
//   owner_type         — 'client' | 'organization'
//   owner_client_id    — required when owner_type = 'client'
//   org_name?          — informational org name (owner_type = 'organization')
//   quantity?          — number of notebooks to create (1–10, default 1)
//   notes?             — optional free-text note (applied to all created notebooks)
// Returns: { notebooks, total_tickets }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('ticket_master', 'superadmin'),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { owner_type, owner_client_id, org_name, notes } = req.body;
      const quantity = Math.min(Math.max(parseInt(req.body.quantity || 1, 10), 1), 10);

      // ── Validate payment info fields ────────────────────────────────────────
      // Organisation notebooks require explicit payment confirmation (paid checkbox,
      // payment date, and name of payer) because the notebook is issued to an external
      // entity and payment must be recorded manually.
      //
      // Client notebooks are assumed paid upfront at creation time — the client is
      // already known in the system, so paid=true and paid_at=today are set automatically.
      let paid, paid_at, paid_by;

      if (owner_type === 'organization') {
        paid   = req.body.paid === true || req.body.paid === 'true';
        paid_at = req.body.paid_at ? req.body.paid_at.trim() : null;
        paid_by = req.body.paid_by ? req.body.paid_by.trim() : null;

        if (!paid) {
          return res.status(400).json({
            error: 'Payment must be confirmed (paid must be true).',
            code:  'PAYMENT_NOT_CONFIRMED',
          });
        }
        if (!paid_at) {
          return res.status(400).json({
            error: 'paid_at (payment date) is required.',
            code:  'MISSING_PAID_AT',
          });
        }
        if (!paid_by) {
          return res.status(400).json({
            error: 'paid_by is required.',
            code:  'MISSING_PAID_BY',
          });
        }
      } else {
        // Client notebook — payment assumed at creation time
        paid    = true;
        paid_at = new Date().toISOString().slice(0, 10); // today
        paid_by = null;
      }

      // ── Validate owner fields ───────────────────────────────────────────────
      if (!['client', 'organization'].includes(owner_type)) {
        return res.status(400).json({
          error: 'owner_type must be "client" or "organization".',
          code:  'INVALID_OWNER_TYPE',
        });
      }
      if (owner_type === 'client' && !owner_client_id) {
        return res.status(400).json({
          error: 'owner_client_id is required for client notebooks.',
          code:  'MISSING_OWNER_CLIENT_ID',
        });
      }
      if (owner_type === 'client') {
        const { rows: userRows } = await pool.query(
          `SELECT id, role FROM users WHERE id = $1 AND status = 'active'`,
          [owner_client_id]
        );
        if (!userRows.length) {
          return res.status(404).json({ error: 'Client user not found.', code: 'CLIENT_NOT_FOUND' });
        }
        if (userRows[0].role !== 'client') {
          return res.status(422).json({
            error: 'Notebooks can only be assigned to users with the client role.',
            code:  'NOT_A_CLIENT',
          });
        }
      }

      // ── Always use global facial value (snapshot at creation time) ───────────
      const cfg = await getMobilityConfig(pool);
      const facial_value = cfg.facialValue;
      const currency     = cfg.currency;

      await client.query('BEGIN');

      const notebooks = [];

      for (let n = 0; n < quantity; n++) {
        // ── Generate unique ticket start and notebook key for each notebook ────
        // Note: notebook_key is generated for ALL notebooks (client + organization)
        // to keep the schema consistent. For client notebooks the key is stored
        // in the DB but never required at reservation time.
        const ticketStart = await generateNotebookStart(client);
        const notebookKey = await generateNotebookKey(client);

        const { rows: nbRows } = await client.query(
          `INSERT INTO ticket_notebooks
             (owner_type, owner_client_id, org_name, notebook_key, ticket_start,
              facial_value, currency, created_by, notes,
              paid, paid_at, paid_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            owner_type,
            owner_type === 'client' ? owner_client_id : null,
            owner_type === 'organization' ? (org_name?.trim() || null) : null,
            notebookKey,
            ticketStart,
            facial_value,
            currency,
            req.user.id,
            notes?.trim() || null,
            true,
            paid_at,
            paid_by,
          ]
        );
        const notebook = nbRows[0];

        // Parameterized bulk insert via unnest — avoids string interpolation in SQL.
        const ticketNumbers = Array.from({ length: 10 }, (_, i) => ticketStart + i);
        await client.query(
          `INSERT INTO mobility_tickets (notebook_id, ticket_number)
           SELECT $1, unnest($2::bigint[])`,
          [notebook.id, ticketNumbers]
        );

        notebooks.push(notebook);

        logger.info('ticket_notebooks: notebook created', {
          notebookId: notebook.id, notebookNumber: notebook.notebook_number,
          ticketStart, ownerType: owner_type, createdBy: req.user.id,
        });
      }

      await client.query('COMMIT');

      res.status(201).json({
        notebooks,
        total_tickets: notebooks.length * 10,
        // Convenience: keep single-notebook callers working
        notebook: notebooks[0],
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tickets/notebooks/:id
//
// Purpose: Return a single notebook with all 10 of its tickets.
// Auth:    ticket_master, superadmin
// Returns: { notebook, tickets }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id',
  authenticate,
  authorize('ticket_master', 'superadmin'),
  async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return res.status(404).json({ error: 'Notebook not found.' });
      }
      const { rows: nbRows } = await pool.query(
        `SELECT n.id, n.notebook_number, n.owner_type, n.org_name, n.notebook_key,
           n.ticket_start, n.facial_value, n.currency, n.notes, n.created_at,
           n.paid, n.paid_at, n.paid_by,
           n.owner_client_id,
           u_owner.first_name   AS owner_first_name,
           u_owner.last_name    AS owner_last_name,
           u_owner.email        AS owner_email,
           u_creator.first_name AS creator_first_name,
           u_creator.last_name  AS creator_last_name
         FROM ticket_notebooks n
         LEFT JOIN users u_owner   ON u_owner.id   = n.owner_client_id
         LEFT JOIN users u_creator ON u_creator.id = n.created_by
         WHERE n.id = $1`,
        [req.params.id]
      );

      if (!nbRows.length) {
        return res.status(404).json({ error: 'Notebook not found.' });
      }

      const { rows: tickets } = await pool.query(
        `SELECT mt.*,
           t.trip_number, t.departure_at, t.pickup_address, t.dropoff_address,
           u_driver.first_name AS driver_first_name,
           u_driver.last_name  AS driver_last_name
         FROM mobility_tickets mt
         LEFT JOIN trips t     ON t.id  = mt.trip_id
         LEFT JOIN users u_driver ON u_driver.id = mt.used_by_driver_id
         WHERE mt.notebook_id = $1
         ORDER BY mt.ticket_number ASC`,
        [req.params.id]
      );

      res.json({ notebook: nbRows[0], tickets });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tickets/notebooks/import
//
// Purpose: Bulk-create notebooks from a parsed CSV upload.
//   Each row may create one or more notebooks (quantity 1–10).
//   Rows are processed independently — a failure on one row does not roll back
//   successfully created rows.
//
// Auth:    ticket_master, superadmin
// Body:    { rows: [ { owner_type, owner_email?, org_name?, quantity, paid_at?, paid_by?, notes? } ] }
// Returns: { created, total_tickets, notebooks, errors: [{ row, message }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/import',
  authenticate,
  authorize('ticket_master', 'superadmin'),
  async (req, res, next) => {
    try {
      const { rows } = req.body;

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows must be a non-empty array.', code: 'MISSING_ROWS' });
      }
      if (rows.length > 200) {
        return res.status(400).json({ error: 'Maximum 200 rows per import.', code: 'TOO_MANY_ROWS' });
      }

      const cfg = await getMobilityConfig(pool);
      const created   = [];
      const errors    = [];

      for (let i = 0; i < rows.length; i++) {
        const row      = rows[i];
        const rowNum   = i + 1;
        const ownerType = (row.owner_type || '').trim().toLowerCase();
        const qty       = Math.min(Math.max(parseInt(row.quantity || 1, 10), 1), 10);

        // ── Per-row validation ────────────────────────────────────────────────
        if (!['client', 'organization'].includes(ownerType)) {
          errors.push({ row: rowNum, message: `Invalid owner_type "${row.owner_type}".` });
          continue;
        }

        let ownerClientId = null;

        if (ownerType === 'client') {
          const email = (row.owner_email || '').trim().toLowerCase();
          if (!email) {
            errors.push({ row: rowNum, message: 'owner_email is required for client rows.' });
            continue;
          }
          const { rows: userRows } = await pool.query(
            `SELECT id FROM users WHERE lower(email) = $1 AND role = 'client' AND status = 'active'`,
            [email]
          );
          if (!userRows.length) {
            errors.push({ row: rowNum, message: `Client not found or inactive: ${email}` });
            continue;
          }
          ownerClientId = userRows[0].id;
        } else {
          // Organization — validate payment fields
          const paidAt = (row.paid_at || '').trim();
          const paidBy = (row.paid_by || '').trim();
          if (!paidAt) {
            errors.push({ row: rowNum, message: 'paid_at is required for organization rows.' });
            continue;
          }
          if (!paidBy) {
            errors.push({ row: rowNum, message: 'paid_by is required for organization rows.' });
            continue;
          }
        }

        // ── Create notebooks for this row ─────────────────────────────────────
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const paidAt = ownerType === 'client'
            ? new Date().toISOString().slice(0, 10)
            : (row.paid_at || '').trim();
          const paidBy = ownerType === 'client' ? null : (row.paid_by || '').trim();
          const orgName = ownerType === 'organization'
            ? ((row.org_name || '').trim() || null)
            : null;
          const notes = (row.notes || '').trim() || null;

          for (let n = 0; n < qty; n++) {
            const ticketStart = await generateNotebookStart(client);
            const notebookKey = await generateNotebookKey(client);

            const { rows: nbRows } = await client.query(
              `INSERT INTO ticket_notebooks
                 (owner_type, owner_client_id, org_name, notebook_key, ticket_start,
                  facial_value, currency, created_by, notes, paid, paid_at, paid_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11)
               RETURNING id, notebook_number`,
              [
                ownerType,
                ownerClientId,
                orgName,
                notebookKey,
                ticketStart,
                cfg.facialValue,
                cfg.currency,
                req.user.id,
                notes,
                paidAt,
                paidBy,
              ]
            );
            const nb = nbRows[0];

            // Parameterized bulk insert via unnest — avoids string interpolation in SQL.
            const ticketNums = Array.from({ length: 10 }, (_, k) => ticketStart + k);
            await client.query(
              `INSERT INTO mobility_tickets (notebook_id, ticket_number)
               SELECT $1, unnest($2::bigint[])`,
              [nb.id, ticketNums]
            );

            created.push(nb);
          }

          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          errors.push({ row: rowNum, message: err.message || 'Unexpected error.' });
        } finally {
          client.release();
        }
      }

      res.status(201).json({
        created:       created.length,
        total_tickets: created.length * 10,
        notebooks:     created,
        errors,
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
