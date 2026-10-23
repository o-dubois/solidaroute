/**
 * @file namePrivacy.js
 * @description Name masking utilities for driver/client privacy.
 *
 * When a driver views a client's name (or vice versa), the last name is
 * replaced with its first initial followed by a period (e.g. "Marie D.").
 * Operators, superadmins, and ticket_masters always see the full name.
 */

const PRIVATE_ROLES = new Set(['client', 'driver']);

/**
 * Returns a display name masked to "FirstName L." when the viewer is a
 * client or driver. All other roles receive the full "FirstName LastName".
 *
 * @param {string|null} firstName  - Person's first name
 * @param {string|null} lastName   - Person's last name
 * @param {string}      viewerRole - Role of the user making the request
 * @returns {string}
 */
function maskName(firstName, lastName, viewerRole) {
  const first = (firstName || '').trim();
  const last  = (lastName  || '').trim();
  if (!first && !last) return '';
  if (PRIVATE_ROLES.has(viewerRole) && last) {
    return `${first} ${last[0].toUpperCase()}.`.trim();
  }
  return `${first} ${last}`.trim();
}

/**
 * Returns the last name masked to its initial when the viewer is a client or
 * driver. Use this when the response keeps first_name and last_name as
 * separate fields rather than a single concatenated string.
 *
 * @param {string|null} lastName   - Person's last name
 * @param {string}      viewerRole - Role of the user making the request
 * @returns {string|null}
 */
function maskLastName(lastName, viewerRole) {
  if (!lastName) return lastName;
  if (PRIVATE_ROLES.has(viewerRole)) return `${lastName[0].toUpperCase()}.`;
  return lastName;
}

module.exports = { maskName, maskLastName };
