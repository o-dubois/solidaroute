/**
 * @file auth.js
 * @description Authentication and authorization middleware for SolidaRoute.
 *
 * Exports three middleware/utility pieces:
 *
 *   authenticate  — Verifies the JWT Bearer token from the Authorization header.
 *                   On success: fetches the user from the DB and attaches the record
 *                   to req.user so downstream handlers know who is making the request.
 *                   On failure: returns 401 Unauthorized.
 *
 *   authorize     — Role-based access control (RBAC) factory.
 *                   Returns a middleware that checks req.user.role against a list of
 *                   allowed roles. Must be chained AFTER authenticate().
 *                   Usage: router.get('/admin', authenticate, authorize('superadmin'), handler)
 *
 *   canActOn      — Hierarchy-based permission check for user management actions.
 *                   Ensures that a lower-privilege user cannot modify a higher-privilege one.
 *                   (e.g., an operator cannot reset a superadmin's password)
 *                   Used inline inside route handlers rather than as Express middleware.
 *
 * Role hierarchy (lowest → highest privilege):
 *   client (0) < driver (1) < operator (2) = ticket_master (2) < superadmin (3)
 *
 * Why re-query the DB on every authenticated request?
 *   JWT tokens are stateless and cannot be invalidated once issued. By looking up the
 *   user's current `status` on each request, we ensure that a suspended or deleted account
 *   is blocked immediately — even if the attacker still holds a valid token.
 *   The DB lookup is a single primary-key read (very fast) and hits the connection pool.
 */

const jwt  = require('jsonwebtoken');
const { pool } = require('../db/pool');

/**
 * Numeric privilege level for each role.
 * Higher number = broader access. Used by canActOn() for hierarchy comparisons.
 *
 * @type {{ client: 0, driver: 1, operator: 2, superadmin: 3 }}
 */
const ROLE_LEVEL = { client: 0, driver: 1, operator: 2, ticket_master: 2, superadmin: 3 };

/**
 * JWT authentication middleware.
 *
 * Reads and verifies the Bearer token from the Authorization header,
 * then validates the user is still active in the database before
 * attaching the user record to `req.user`.
 *
 * Expected header format:
 *   Authorization: Bearer <jwt_token>
 *
 * On success: calls next() with req.user = { id, email, role, status }
 * On failure: returns 401 (missing/invalid token) or 403 (account suspended)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  // Reject requests that don't carry a Bearer token at all
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  // Strip the "Bearer " prefix (7 characters) to get the raw token string
  const token = header.slice(7);
  try {
    // jwt.verify throws JsonWebTokenError on tampering, TokenExpiredError on expiry.
    // Algorithm is pinned to HS256 to prevent algorithm-confusion attacks where an
    // attacker crafts a token claiming a different algorithm (e.g. 'none' or RS256).
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // Re-check user status on every request — a suspended user
    // should be blocked immediately even with a valid token.
    // Only select the columns needed by downstream handlers to keep the payload lean.
    const { rows } = await pool.query(
      'SELECT id, email, role, status FROM users WHERE id = $1',
      [payload.id]
    );
    if (!rows.length) {
      // User was deleted from DB after the token was issued
      return res.status(401).json({ error: 'User not found.' });
    }
    if (rows[0].status !== 'active') {
      // Account suspended, pending verification, or otherwise inactive
      return res.status(403).json({ error: 'Account is not active.' });
    }

    // Attach user to request — available in all subsequent middleware and handlers
    req.user = rows[0];
    next();
  } catch {
    // Covers: invalid signature, expired token, malformed token string
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

/**
 * Role-based authorization middleware factory.
 *
 * Returns an Express middleware that checks whether `req.user.role` is included
 * in the list of permitted roles. Must always be used AFTER authenticate() in the
 * middleware chain, because it depends on req.user being populated.
 *
 * Accepts a variable number of role arguments so a single route can permit
 * multiple roles without calling authorize() multiple times.
 *
 * @param {...string} roles - One or more permitted role names
 * @returns {import('express').RequestHandler} Express middleware
 *
 * @example
 * // Restrict to superadmins only
 * router.get('/config', authenticate, authorize('superadmin'), handler);
 *
 * // Allow both operators and superadmins
 * router.use(authenticate, authorize('operator', 'superadmin'));
 */
function authorize(...roles) {
  return (req, res, next) => {
    // Guard against misconfigured chains where authenticate wasn't called first
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

/**
 * Checks whether an actor has sufficient privilege to act on a target user's role.
 *
 * The rule is: an actor can only manage users at the same privilege level or below.
 * This prevents privilege escalation (e.g., an operator promoting themselves to
 * superadmin, or editing another operator's account without consent).
 *
 * Used inline inside route handlers (not as middleware), because it requires
 * knowing the target user's role which is only available after a DB lookup.
 *
 * @param {object} actor      - The acting user (typically req.user); must have a `.role` property
 * @param {string} targetRole - The role of the user being modified or viewed
 * @returns {boolean}         - true if the actor may proceed; false if they should be denied
 *
 * @example
 * // An operator (level 2) attempting to edit a superadmin (level 3):
 * if (!canActOn(req.user, targetUser.role)) {
 *   return res.status(403).json({ error: 'Insufficient permissions.' });
 * }
 */
function canActOn(actor, targetRole) {
  // ROLE_LEVEL[actor.role] >= ROLE_LEVEL[targetRole] means actor outranks or equals target
  return ROLE_LEVEL[actor.role] >= ROLE_LEVEL[targetRole];
}

module.exports = { authenticate, authorize, canActOn, ROLE_LEVEL };
