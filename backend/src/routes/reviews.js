/**
 * @file routes/reviews.js
 * @description Review submission, retrieval, and moderation for completed trips.
 *              Mounted at /api/reviews in src/index.js.
 *
 * Review lifecycle:
 *   submitted (status='pending') → moderated by operator/superadmin → 'approved' | 'rejected'
 *
 *   Only approved reviews are returned in public-facing queries (GET /trip/:id,
 *   GET /user/:id, GET /mine received).  Pending and rejected reviews are only
 *   visible to the submitter (GET /mine given) and to admins (GET /pending).
 *
 * Who can review whom:
 *   Client reviews the driver of their completed trip.
 *   Driver reviews the client of their completed trip.
 *   Operator who booked the trip (created_by_admin) may also review the client.
 *   One review per reviewer per trip — enforced by a UNIQUE constraint (code 23505).
 *
 * Rating scale: 1–5 stars (integers).
 * Comment: optional free text, max 100 characters.
 *
 * Column naming note:
 *   The DB column is 'reviewed_user_id' (the person being reviewed).
 *   All SELECT responses alias it as 'reviewee_id' for clarity.
 *
 * Privacy:
 *   Last names are masked via maskLastName() before leaving the server.
 *   Drivers see "Marie T." instead of "Marie Tremblay" for client names.
 *
 * Routes:
 *   POST   /                — Submit a review for a completed trip
 *   GET    /mine            — Reviews given by and received by the caller
 *   GET    /trip/:trip_id   — Approved reviews for a specific trip
 *   GET    /user/:id        — Approved reviews received by a specific user
 *   GET    /pending-count   — Count of reviews awaiting moderation (admin)
 *   GET    /pending         — Full list of reviews awaiting moderation (admin)
 *   PATCH  /:id/approve     — Approve a pending review (admin)
 *   PATCH  /:id/reject      — Reject a pending review (admin)
 */

const express  = require('express');
const router   = express.Router();
const { pool } = require('../db/pool');
const { authenticate, authorize } = require('../middleware/auth');
const { maskLastName }            = require('../utils/namePrivacy');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reviews
// Submit a new review for a completed trip.
//
// Validation order:
//   1. trip_id and rating are present
//   2. Rating is between 1 and 5
//   3. Comment length ≤ 100 characters
//   4. Trip exists
//   5. Trip is completed (not pending/assigned/cancelled)
//   6. Caller is a participant (client, driver, or booking operator)
//   7. INSERT — UNIQUE constraint prevents duplicate reviews (returns 23505)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { trip_id, rating, comment } = req.body;
    const reviewerId = req.user.id;

    if (!trip_id || !rating) {
      return res.status(422).json({ error: 'trip_id and rating are required.' });
    }

    const ratingNum = parseInt(rating, 10);
    if (ratingNum < 1 || ratingNum > 5) {
      return res.status(422).json({ error: 'Rating must be between 1 and 5.' });
    }

    if (comment && comment.length > 100) {
      return res.status(422).json({
        error: 'Comment must be 100 characters or less.',
        code:  'COMMENT_TOO_LONG',
      });
    }

    // Load only the columns needed for access-control decisions.
    const { rows } = await pool.query(
      `SELECT t.id, t.status, t.client_id, t.driver_id, t.created_by_admin
       FROM trips t WHERE t.id = $1`,
      [trip_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Trip not found.' });
    const trip = rows[0];

    if (trip.status !== 'completed') {
      return res.status(422).json({
        error: 'Reviews can only be submitted for completed trips.',
        code:  'TRIP_NOT_COMPLETED',
      });
    }

    // Determine who the reviewer is rating.  The logic is:
    //   - client reviews the driver
    //   - driver reviews the client
    //   - operator who booked the trip (created_by_admin) reviews the client
    // Anyone else who somehow has a valid JWT but is not a trip participant gets 403.
    let revieweeId = null;
    if (reviewerId === trip.client_id) {
      if (trip.driver_id) { revieweeId = trip.driver_id; }
      else { return res.status(422).json({ error: 'No driver assigned to review.' }); }
    } else if (reviewerId === trip.driver_id) {
      revieweeId = trip.client_id;
    } else if (trip.created_by_admin && reviewerId === trip.created_by_admin) {
      revieweeId = trip.client_id;
    } else {
      return res.status(403).json({ error: 'You are not a participant of this trip.' });
    }

    const { rows: inserted } = await pool.query(
      `INSERT INTO reviews (trip_id, reviewer_id, reviewed_user_id, rating, comment, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, trip_id, reviewer_id,
                 reviewed_user_id AS reviewee_id,
                 rating, comment, status, created_at`,
      [trip_id, reviewerId, revieweeId, ratingNum, comment?.trim() || null]
    );

    res.status(201).json({ review: inserted[0] });
  } catch (err) {
    // PG unique-constraint violation: reviewer already submitted a review for this trip.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'You have already reviewed this trip.',
        code:  'ALREADY_REVIEWED',
      });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/mine
// Returns two arrays for the authenticated user:
//   given    — reviews the user has written (all statuses, including pending/rejected)
//   received — approved reviews written about the user
//
// "Given" includes non-approved reviews so users can see the current moderation
// state of their own submission.  "Received" shows only approved so users are
// not notified of a pending review that might be rejected.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/mine', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Reviews this user has submitted — all statuses so they can track approval.
    const { rows: given } = await pool.query(
      `SELECT r.id, r.trip_id, r.rating, r.comment, r.status, r.created_at,
              t.trip_number,
              u.first_name AS reviewee_first, u.last_name AS reviewee_last,
              u.role AS reviewee_role
       FROM reviews r
       JOIN trips t ON t.id = r.trip_id
       JOIN users u ON u.id = r.reviewed_user_id
       WHERE r.reviewer_id = $1
       ORDER BY r.created_at DESC`,
      [userId]
    );

    // Reviews written about this user — only show approved to avoid exposing
    // a rejected review to the person it is about.
    const { rows: received } = await pool.query(
      `SELECT r.id, r.trip_id, r.rating, r.comment, r.created_at,
              t.trip_number,
              u.first_name AS reviewer_first, u.last_name AS reviewer_last,
              u.role AS reviewer_role
       FROM reviews r
       JOIN trips t ON t.id = r.trip_id
       JOIN users u ON u.id = r.reviewer_id
       WHERE r.reviewed_user_id = $1
         AND r.status = 'approved'
       ORDER BY r.created_at DESC`,
      [userId]
    );

    const role = req.user.role;

    // Mask last names before sending — drivers and clients see only initials.
    const maskedGiven    = given.map(r    => ({ ...r, reviewee_last: maskLastName(r.reviewee_last, role) }));
    const maskedReceived = received.map(r => ({ ...r, reviewer_last: maskLastName(r.reviewer_last, role) }));

    res.json({ given: maskedGiven, received: maskedReceived });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/trip/:trip_id
// Returns approved reviews for a specific trip, plus the caller's own review
// regardless of its status (so the UI can show a "pending approval" badge).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/trip/:trip_id', authenticate, async (req, res, next) => {
  try {
    const tripId = req.params.trip_id;
    const userId = req.user.id;

    // All approved reviews for the trip (visible to all participants).
    const { rows: approved } = await pool.query(
      `SELECT r.id, r.rating, r.comment, r.created_at,
              u.first_name AS reviewer_first, u.last_name AS reviewer_last,
              u.role AS reviewer_role
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_id
       WHERE r.trip_id = $1 AND r.status = 'approved'
       ORDER BY r.created_at DESC`,
      [tripId]
    );

    // The caller's own review (any status) so they know if they already submitted.
    const { rows: mine } = await pool.query(
      `SELECT id, rating, comment, status, created_at
       FROM reviews
       WHERE trip_id = $1 AND reviewer_id = $2
       LIMIT 1`,
      [tripId, userId]
    );

    const role = req.user.role;
    const maskedReviews = approved.map(r => ({ ...r, reviewer_last: maskLastName(r.reviewer_last, role) }));
    res.json({ reviews: maskedReviews, my_review: mine[0] || null });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/user/:id
// Returns all approved reviews received by a specific user.
// Used by the trip booking wizard so clients can read a driver's reputation
// before choosing them as a preferred driver.
// Auth: any authenticated user (no role restriction).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.rating, r.comment, r.created_at,
              u.first_name AS reviewer_first, u.last_name AS reviewer_last
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_id
       WHERE r.reviewed_user_id = $1
         AND r.status = 'approved'
       ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    const role    = req.user.role;
    const reviews = rows.map(r => ({ ...r, reviewer_last: maskLastName(r.reviewer_last, role) }));
    res.json({ reviews });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/pending-count
// Returns the count of reviews currently awaiting moderation.
// Used to populate the notification badge in the admin sidebar.
//
// Visibility by role:
//   operator    — sees only reviews written by clients and drivers
//   superadmin  — sees all pending reviews, including those involving operators
//
// The $1 boolean shortcut allows a single query to cover both roles:
//   $1 = true  → no role filter (superadmin sees everything)
//   $1 = false → reviewer role must be 'client' or 'driver'
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending-count', authenticate, authorize('operator', 'superadmin'), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === 'superadmin';
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count
       FROM reviews r
       JOIN users reviewer ON reviewer.id = r.reviewer_id
       WHERE r.status = 'pending'
         AND ($1 OR reviewer.role IN ('client', 'driver'))`,
      [isSuperadmin]
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/pending
// Returns the full list of reviews awaiting moderation, with reviewer and
// reviewee identity so the admin can evaluate context.  Same role/visibility
// rules as pending-count.  Results are oldest-first (ASC) so the queue is
// worked in submission order.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending', authenticate, authorize('operator', 'superadmin'), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === 'superadmin';
    const { rows } = await pool.query(
      `SELECT r.id, r.trip_id, r.rating, r.comment, r.status, r.created_at,
              t.trip_number,
              rv.first_name AS reviewer_first, rv.last_name AS reviewer_last,
              rv.role       AS reviewer_role,
              re.first_name AS reviewee_first, re.last_name AS reviewee_last,
              re.role       AS reviewee_role
       FROM reviews r
       JOIN trips t  ON t.id  = r.trip_id
       JOIN users rv ON rv.id = r.reviewer_id
       JOIN users re ON re.id = r.reviewed_user_id
       WHERE r.status = 'pending'
         AND ($1 OR rv.role IN ('client', 'driver'))
       ORDER BY r.created_at ASC`,
      [isSuperadmin]
    );
    res.json({ reviews: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/reviews/:id/approve
// PATCH /api/reviews/:id/reject
// Delegate to the shared moderateReview helper so the access-control and
// rating-recalculation logic is not duplicated between the two endpoints.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/approve', authenticate, authorize('operator', 'superadmin'), async (req, res, next) => {
  try { await moderateReview(req, res, next, 'approved'); }
  catch (err) { next(err); }
});

router.patch('/:id/reject', authenticate, authorize('operator', 'superadmin'), async (req, res, next) => {
  try { await moderateReview(req, res, next, 'rejected'); }
  catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// moderateReview(req, res, next, newStatus)
//
// Shared handler for approve and reject.  Enforces:
//   - Review must exist.
//   - Review must still be pending (409 if already moderated).
//   - Operators cannot moderate reviews that involve another operator — only
//     superadmins can do that (prevents operators from silencing complaints
//     about themselves or their colleagues).
//
// When approving, triggers recalcRating() to update the reviewee's average
// rating on their driver_profiles row.  Rejection does not affect ratings.
// ─────────────────────────────────────────────────────────────────────────────
async function moderateReview(req, res, next, newStatus) {
  const { id } = req.params;
  const isSuperadmin = req.user.role === 'superadmin';

  // Load the review with reviewer and reviewee roles so we can enforce the
  // operator-only moderation restriction.
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.reviewed_user_id AS reviewee_id,
            rv.role AS reviewer_role, re.role AS reviewee_role
     FROM reviews r
     JOIN users rv ON rv.id = r.reviewer_id
     JOIN users re ON re.id = r.reviewed_user_id
     WHERE r.id = $1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Review not found.' });
  const review = rows[0];

  if (review.status !== 'pending') {
    return res.status(409).json({ error: 'Review has already been moderated.' });
  }

  // An operator cannot moderate a review where either party is an operator role.
  // This prevents self-serving moderation of complaints filed against colleagues.
  if (!isSuperadmin && (review.reviewer_role === 'operator' || review.reviewee_role === 'operator')) {
    return res.status(403).json({ error: 'Only superadmin can moderate operator reviews.' });
  }

  // Record the moderation decision and who made it.
  await pool.query(
    `UPDATE reviews SET status = $1, moderated_by = $2, moderated_at = NOW() WHERE id = $3`,
    [newStatus, req.user.id, id]
  );

  // Approval changes the reviewee's visible rating — recalculate immediately.
  // Rejection is effectively a no-op from a rating perspective.
  if (newStatus === 'approved') {
    await recalcRating(review.reviewee_id);
  }

  res.json({ success: true, status: newStatus });
}

// ─────────────────────────────────────────────────────────────────────────────
// recalcRating(userId)
//
// Recomputes and persists the average_rating and review_count on driver_profiles
// by counting only approved reviews for that user.
//
// This is called after each approval rather than using a DB trigger so that:
//   a) the logic lives in application code (easier to test and trace in logs)
//   b) the update is always in sync — no eventual-consistency lag from async triggers
//
// If the user is not a driver (no driver_profiles row), the UPDATE simply
// matches 0 rows and is a no-op — safe to call for any user ID.
// ─────────────────────────────────────────────────────────────────────────────
async function recalcRating(userId) {
  await pool.query(
    `UPDATE driver_profiles
     SET average_rating = (
           SELECT COALESCE(AVG(r.rating), 0)
           FROM reviews r
           WHERE r.reviewed_user_id = $1 AND r.status = 'approved'
         ),
         review_count = (
           SELECT COUNT(*)
           FROM reviews r
           WHERE r.reviewed_user_id = $1 AND r.status = 'approved'
         ),
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

module.exports = router;
