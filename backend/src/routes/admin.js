// routes/admin.js — thin index, delegates to sub-routers in routes/admin/
//
// Mounted at /api/admin in src/index.js
//
// Auth design:
//   - GET /configuration/public is declared BEFORE the auth guard and is
//     intentionally unauthenticated (frontend needs config before login).
//   - router.use(authenticate, authorize(...)) applies to ALL routes below it.
//   - Individual sub-routers add a second authorize('superadmin') where needed.
//
// Registration order matters:
//   /configuration/public must be declared before the auth guard.
//   All other sub-routers are mounted after the guard.
const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const { pool } = require('../db/pool');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — no authentication required.
// MUST remain above router.use(authenticate, ...) or it will be blocked.
// ─────────────────────────────────────────────────────────────────────────────

// This array is the single source of truth for which config keys are safe to
// expose without authentication. Add keys here only after confirming they
// contain no security-sensitive information.
const PUBLIC_CONFIG_KEYS = [
  'max_return_delay_minutes',
  'min_trip_lead_hours',
  'max_trip_advance_days',
  'driver_suggestion_radius_km',
  'driver_selection_required',
  'frontend_language',
  'app_timezone',
  'app_name',
  'session_timeout_minutes',
  'require_driver_license_doc',
  'require_driver_insurance_doc',
  'require_driver_vehicle_registration_doc',
  'max_document_size_mb',
  'default_phone_country',
  'base_fare',
  'price_per_km',
  'extra_passenger_fee',
  'driver_share_percent',
  'payment_currency',
  'stripe_publishable_key',
  'payment_provider',
  'frontend_url',
];

router.get('/configuration/public', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM configuration WHERE key = ANY($1)`,
      [PUBLIC_CONFIG_KEYS]
    );
    // Expose FRONTEND_URL env var as frontend_url if not explicitly set in DB
    if (!rows.find(r => r.key === 'frontend_url') && process.env.FRONTEND_URL) {
      rows.push({ key: 'frontend_url', value: process.env.FRONTEND_URL });
    }
    res.json({ configuration: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GUARD — applies to ALL routes declared/mounted below this line.
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate, authorize('operator', 'superadmin'));

router.use('/dashboard',     require('./admin/dashboard'));
router.use('/users',         require('./admin/users'));
router.use('/drivers',       require('./admin/drivers'));
router.use('/operators',     require('./admin/operators'));
router.use('/trips',         require('./admin/trips'));
router.use('/configuration', require('./admin/configuration'));

module.exports = router;
