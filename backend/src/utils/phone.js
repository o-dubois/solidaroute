'use strict';
/**
 * @file phone.js
 * @description Phone number normalization utility for SolidaRoute.
 *
 * Provides a single function, normalizePhone(), that converts any supported
 * phone number format into a consistent internal representation before storage.
 *
 * Consistent storage is important for two reasons:
 *   1. Uniqueness checks — the `users` table has a UNIQUE constraint on the phone
 *      column. Without normalization, "+15145551234" and "514-555-1234" would be
 *      treated as different numbers and the duplicate would slip through.
 *   2. Display and SMS delivery — downstream code can rely on a known format
 *      without needing to re-parse or sanitize the value from the DB.
 *
 * Supported input formats and their normalized outputs:
 *   E.164  "+15145551234"  → "+15145551234"   (strips formatting, keeps +)
 *   E.164  "+1 (514) 555-1234" → "+15145551234"
 *   Plain  "514-555-1234"  → "5145551234"     (strips non-digits)
 *   Plain  "(514) 555.1234" → "5145551234"
 *   Empty / null / undefined → null
 *
 * Format choice:
 *   The frontend uses react-phone-number-input which always submits E.164 format
 *   (e.g., "+15145551234"). E.164 numbers are stored with the leading +.
 *   Legacy records already in the DB may have plain digit strings without +;
 *   the plain branch handles these gracefully.
 */

/**
 * Normalizes a phone number for consistent storage.
 *
 * The function distinguishes E.164 from plain numbers by the presence of a
 * leading '+'. Any formatting characters (spaces, dashes, parentheses, dots)
 * are stripped from the digit portion in both cases.
 *
 * Returns null for empty, null, or non-digit input so callers can treat the
 * return value as "phone number present" vs "no phone number" without further checks.
 *
 * @param {string|null|undefined} phone - Raw phone string from the request body or DB
 * @returns {string|null}
 *   - E.164 string starting with '+' if the input started with '+'
 *   - Digit-only string if the input did not start with '+'
 *   - null if the input was falsy or contained no digits
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const str = String(phone).trim();

  if (str.startsWith('+')) {
    // E.164 path: preserve the '+' prefix, strip all non-digit characters
    // from the rest of the string (spaces, dashes, parentheses, etc.)
    const digits = str.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : null; // Return null if '+' had no digits after it
  }

  // Plain number path: strip everything that isn't a digit
  const digits = str.replace(/\D/g, '');
  return digits || null; // Return null if nothing was left after stripping
}

module.exports = { normalizePhone };
