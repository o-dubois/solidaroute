/**
 * @file routes/notifications.js
 * @description In-app notification management for all authenticated users.
 *              Mounted at /api/notifications in src/index.js.
 *
 * Auth: JWT required on every route.  Users can only see and update their OWN
 * notifications — user_id is always taken from req.user.id (the JWT claim),
 * never from a query parameter, so one user cannot read or mark another's alerts.
 *
 * Notifications are written by backend services (email.js, booking.js, etc.)
 * and read by the frontend on page load or via polling.  This module handles
 * only the READ and MARK-AS-READ operations; creation is handled by the service
 * that generates the event.
 *
 * Routes:
 *   GET   /          — Most recent 50 notifications + unread count
 *   PATCH /:id/read  — Mark a single notification as read
 *   PATCH /read-all  — Mark all unread notifications as read at once
 *
 * Note on route registration order:
 *   PATCH /read-all must be registered BEFORE PATCH /:id/read.  If /:id/read
 *   came first, Express would interpret "read-all" as an id parameter and never
 *   reach the read-all handler.
 */

const express          = require('express');
const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications
//
// Returns the 50 most recent notifications for the caller, sorted newest-first.
// Also computes the unread count in JS (avoids a second DB query for COUNT).
//
// The 50-row cap keeps the payload small for mobile clients.  Older notifications
// are still stored in the DB for audit purposes but are not surfaced here.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1
       ORDER BY sent_at DESC LIMIT 50`,
      [req.user.id]
    );

    // Count unread in JS rather than with a separate COUNT query — we already
    // have all 50 rows in memory, so filtering is essentially free.
    const unread = rows.filter(n => !n.is_read).length;

    res.json({ notifications: rows, unread_count: unread });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/notifications/read-all
//
// Marks every unread notification for the caller as read in a single UPDATE.
// The is_read = FALSE condition prevents unnecessary writes for already-read rows.
//
// IMPORTANT: This route must be registered before /:id/read so Express does not
// mistake the literal string "read-all" for an :id parameter.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/read-all', authenticate, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
      [req.user.id]
    );
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/notifications/:id/read
//
// Marks a single notification as read.  The AND user_id = $2 clause ensures a
// user can only mark their own notifications — a user cannot mark another user's
// notification as read even if they know the UUID.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/read', authenticate, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Marked as read.' });
  } catch (err) { next(err); }
});

module.exports = router;
