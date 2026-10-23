/**
 * @file utils/driverCompleteness.js
 * @description Shared helper that determines whether a driver's profile is
 *              complete enough to enter the admin approval queue.
 *
 * A driver is considered "complete" when:
 *   1. Personal info (first name, last name, phone) is filled in.
 *   2. All vehicle fields (make, model, year ≥ 1990, color, plate) are filled.
 *   3. Home address is filled (the geocoded home_point follows automatically).
 *   4. Any document types toggled as "required" by the admin have at least
 *      one uploaded file (slot 1).
 *
 * This function is called from two places:
 *   - PUT /api/profile/driver — after the driver saves their vehicle/address info
 *   - POST /api/documents/:type/:slot — after the driver uploads a document
 *
 * In both cases, if the result is `complete: true` AND the driver's current
 * approval_status is 'incomplete', the caller should promote the status to
 * 'pending' so the admin sees the application in the review queue.
 *
 * @param {string} userId  The driver's user ID (UUID).
 * @returns {{ complete: boolean, missing: string[] }}
 */

const { pool } = require('../db/pool');

async function checkDriverCompleteness(userId) {
  // ── Fetch base user fields ──────────────────────────────────────────────────
  const { rows: userRows } = await pool.query(
    `SELECT first_name, last_name, phone FROM users WHERE id = $1`,
    [userId]
  );
  const u = userRows[0] || {};

  // ── Fetch driver profile fields ─────────────────────────────────────────────
  const { rows: dpRows } = await pool.query(
    `SELECT vehicle_make, vehicle_model, vehicle_year,
            vehicle_color, license_plate, home_address
     FROM driver_profiles WHERE user_id = $1`,
    [userId]
  );
  const dp = dpRows[0] || {};

  // ── Fetch which document types are required by the admin ────────────────────
  const { rows: cfgRows } = await pool.query(
    `SELECT key, value FROM configuration
     WHERE key IN (
       'require_driver_license_doc',
       'require_driver_insurance_doc',
       'require_driver_vehicle_registration_doc'
     )`
  );
  const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));

  const missing = [];

  // ── Personal info checks ────────────────────────────────────────────────────
  if (!u.first_name?.trim()) missing.push('first_name');
  if (!u.last_name?.trim())  missing.push('last_name');
  if (!u.phone?.trim())      missing.push('phone');

  // ── Vehicle info checks ─────────────────────────────────────────────────────
  if (!dp.vehicle_make?.trim())              missing.push('vehicle_make');
  if (!dp.vehicle_model?.trim())             missing.push('vehicle_model');
  if (!dp.vehicle_year || dp.vehicle_year < 1990) missing.push('vehicle_year');
  if (!dp.vehicle_color?.trim())             missing.push('vehicle_color');
  if (!dp.license_plate?.trim())             missing.push('license_plate');

  // ── Home address check ──────────────────────────────────────────────────────
  if (!dp.home_address?.trim()) missing.push('home_address');

  // ── Required document checks ────────────────────────────────────────────────
  const docTypeConfigKey = {
    license:      'require_driver_license_doc',
    insurance:    'require_driver_insurance_doc',
    registration: 'require_driver_vehicle_registration_doc',
  };
  const requiredDocTypes = ['license', 'insurance', 'registration'].filter(type =>
    cfg[docTypeConfigKey[type]] === 'true'
  );

  if (requiredDocTypes.length > 0) {
    // Check which doc types have at least one file uploaded (any slot).
    const { rows: docRows } = await pool.query(
      `SELECT DISTINCT doc_type FROM driver_documents WHERE driver_id = $1`,
      [userId]
    );
    const uploadedTypes = new Set(docRows.map(d => d.doc_type));
    for (const type of requiredDocTypes) {
      if (!uploadedTypes.has(type)) missing.push(`doc_${type}`);
    }
  }

  return { complete: missing.length === 0, missing };
}

module.exports = { checkDriverCompleteness };
