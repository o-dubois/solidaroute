/**
 * @file routes/trips/recent-addresses.js
 * @description Returns the requesting user's most recently used unique pickup
 *              and dropoff addresses (with coordinates) for use as quick-pick
 *              suggestions in the booking form.
 *              Mounted at GET /api/trips/recent-addresses.
 *
 * Auth: JWT required (client role only; drivers have no booking form).
 *
 * Returns up to 8 unique addresses, ordered by most recently used.
 * Duplicates are collapsed: if the same address string appears multiple times
 * only the most recent row is kept.
 */
const express          = require('express');
const { pool }         = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Union pickup and dropoff columns, deduplicate on address text, keep the
    // most recent occurrence, and limit to 8 results.
    // Coordinates are stored as PostGIS geography in pickup_point / dropoff_point.
    // ST_Y extracts latitude, ST_X extracts longitude from the geometry cast.
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (address)
        address,
        lat,
        lon,
        used_at
      FROM (
        SELECT
          pickup_address                        AS address,
          ST_Y(pickup_point::geometry)          AS lat,
          ST_X(pickup_point::geometry)          AS lon,
          departure_at                          AS used_at
        FROM trips
        WHERE client_id = $1
          AND pickup_address IS NOT NULL
          AND pickup_point   IS NOT NULL

        UNION ALL

        SELECT
          dropoff_address                       AS address,
          ST_Y(dropoff_point::geometry)         AS lat,
          ST_X(dropoff_point::geometry)         AS lon,
          departure_at                          AS used_at
        FROM trips
        WHERE client_id = $1
          AND dropoff_address IS NOT NULL
          AND dropoff_point   IS NOT NULL
      ) combined
      ORDER BY address, used_at DESC
      LIMIT 8
    `, [userId]);

    // Re-sort by most recently used (DISTINCT ON kept the freshest row per
    // address, but final order needs to reflect recency across all addresses).
    rows.sort((a, b) => new Date(b.used_at) - new Date(a.used_at));

    res.json({ results: rows.map(r => ({ label: r.address, lat: parseFloat(r.lat), lon: parseFloat(r.lon) })) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
