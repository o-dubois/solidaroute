/**
 * @file password.js
 * @description Password validation service for SolidaRoute.
 *
 * Reads password complexity rules from the `configuration` table and validates
 * user-submitted passwords against them. Rules are cached in memory for 60 seconds
 * to avoid a database round-trip on every login or registration attempt.
 *
 * Configuration keys read from the `configuration` table:
 *   password_min_length        — minimum character count (default: 8)
 *   password_require_uppercase — require at least one A-Z character (default: true)
 *   password_require_lowercase — require at least one a-z character (default: true)
 *   password_require_number    — require at least one digit 0-9 (default: true)
 *   password_require_special   — require at least one special character (default: false)
 *
 * Cache invalidation:
 *   The cache TTL is 60 seconds. Additionally, invalidateCache() is called by the
 *   admin configuration panel (routes/admin.js) whenever a password_* key is updated,
 *   so new rules take effect immediately for admins without waiting for the TTL.
 *
 * Failure behaviour:
 *   If the database is unreachable when rules are fetched, safe fallback defaults
 *   are used so authentication continues to function during DB blips.
 */

const { pool } = require('../db/pool');
const { logger } = require('../utils/logger');

/** Cached rules object — null until the first successful DB fetch */
let rulesCache = null;

/**
 * Unix timestamp (ms) after which the current cache entry is considered stale.
 * Starts at 0 so the first call always triggers a fresh DB read.
 */
let cacheExpiresAt = 0;

/**
 * Fetches password complexity rules from the `configuration` table.
 * Returns the in-memory cached value if it is still within the 60-second TTL.
 *
 * DB values are stored as strings (the configuration table is a key-value store),
 * so parseInt / strict equality checks against the string 'true' are used to
 * convert them to the expected types.
 *
 * @returns {Promise<{
 *   minLength: number,
 *   requireUppercase: boolean,
 *   requireLowercase: boolean,
 *   requireNumber: boolean,
 *   requireSpecial: boolean
 * }>}
 */
async function getRules() {
  const now = Date.now();
  // Return cached rules if they haven't expired yet
  if (rulesCache && now < cacheExpiresAt) return rulesCache;

  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM configuration
       WHERE key IN (
         'password_min_length',
         'password_require_uppercase',
         'password_require_lowercase',
         'password_require_number',
         'password_require_special'
       )`
    );

    // Convert the rows array into a { key: value } lookup map for easy access
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

    rulesCache = {
      minLength:        parseInt(map.password_min_length        ?? '8',     10),
      // DB stores booleans as the strings 'true' / 'false'
      requireUppercase: (map.password_require_uppercase ?? 'true')  === 'true',
      requireLowercase: (map.password_require_lowercase ?? 'true')  === 'true',
      requireNumber:    (map.password_require_number    ?? 'true')  === 'true',
      requireSpecial:   (map.password_require_special   ?? 'false') === 'true',
    };
    cacheExpiresAt = now + 60_000; // Cache for 60 seconds (60 000 ms)
    return rulesCache;
  } catch (err) {
    // DB unreachable — return safe defaults rather than blocking all authentication.
    // This means password validation continues to work even during a brief DB outage.
    logger.warn('Could not read password rules from config — using defaults', {
      message: err.message,
    });
    return {
      minLength: 8, requireUppercase: true,
      requireLowercase: true, requireNumber: true, requireSpecial: false,
    };
  }
}

/**
 * Invalidates the in-memory rules cache immediately.
 *
 * Called by the admin configuration route (routes/admin.js) whenever any
 * password_* key is updated through the admin panel, so the new rules take
 * effect on the very next login/registration attempt without waiting for TTL expiry.
 */
function invalidateCache() {
  rulesCache    = null;
  cacheExpiresAt = 0;
}

/**
 * Validates a plain-text password against the current complexity rules.
 *
 * All rule checks are run unconditionally so the caller receives the complete
 * list of failures at once — this allows the frontend to show all unmet
 * requirements simultaneously rather than one at a time.
 *
 * @param {string} password - The plain-text password to validate (not yet hashed)
 * @returns {Promise<{
 *   valid: true,
 *   rules: object
 * } | {
 *   valid: false,
 *   errors: string[],
 *   rules: object
 * }>}
 *   - `rules` is always included so the caller can render the requirements list
 *     even when validation passes (useful for the live strength indicator).
 *
 * @example
 * const result = await validatePassword('Hello1');
 * if (!result.valid) {
 *   console.log(result.errors); // ['At least 8 characters']
 * }
 */
async function validatePassword(password) {
  const rules = await getRules();
  const errors = [];

  // Check minimum length — also catches null/undefined password
  if (!password || password.length < rules.minLength) {
    errors.push(`At least ${rules.minLength} character${rules.minLength > 1 ? 's' : ''}`);
  }
  // Check for at least one uppercase letter (A-Z)
  if (rules.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('At least one uppercase letter (A–Z)');
  }
  // Check for at least one lowercase letter (a-z)
  if (rules.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('At least one lowercase letter (a–z)');
  }
  // Check for at least one digit
  if (rules.requireNumber && !/[0-9]/.test(password)) {
    errors.push('At least one digit (0–9)');
  }
  // Check for at least one special character (optional rule, off by default)
  if (rules.requireSpecial && !/[!@#$%^&*\-_=+[\]{};:'",.<>/?\\|`~()]/.test(password)) {
    errors.push('At least one special character (!@#$%^&*…)');
  }

  if (errors.length === 0) return { valid: true, rules };
  return { valid: false, errors, rules };
}

/**
 * Returns the current password complexity rules without performing validation.
 * Exposed to the frontend via GET /api/auth/password-rules so the React
 * PasswordStrength component can render real-time feedback as the user types.
 *
 * @returns {Promise<object>} The rules object (same shape as getRules() output)
 */
async function getPasswordRules() {
  return getRules();
}

module.exports = { validatePassword, getPasswordRules, invalidateCache };
