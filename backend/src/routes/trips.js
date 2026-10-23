/**
 * @file routes/trips.js
 * @description Trip API — thin index router that delegates every request to a
 *              dedicated sub-module.  Mounted at /api/trips in src/index.js.
 *
 * Sub-module responsibilities:
 *   stats          — trip counts and driver earnings for the current user
 *   estimate       — geocode + price preview (no DB write)
 *   my-trips       — paginated trip history for clients and drivers
 *   available      — pending trips visible to a driver within their radius
 *   address-search — autocomplete for pickup/dropoff fields
 *   action         — one-time tokenised accept/decline links from emails
 *   booking        — create trip, fetch detail, and all status-change operations
 *                    (accept, cancel, complete, decline)
 *
 * Registration order is intentional and must not be changed:
 *   • /stats, /estimate, /my-trips, /available, /address-search and /action
 *     are all registered BEFORE the catch-all '/' handled by booking.js.
 *     If booking.js were mounted first, its GET /:id route would intercept
 *     requests like GET /stats, treating "stats" as a trip UUID.
 *   • /action is also placed before '/' because it must not require a JWT
 *     (the token in the query string IS the credential), and booking.js
 *     applies authenticate middleware globally via its sub-routes.
 */
const router = require('express').Router();

router.use('/stats',             require('./trips/stats'));
router.use('/estimate',          require('./trips/estimate'));
router.use('/my-trips',          require('./trips/my-trips'));
router.use('/available',         require('./trips/available'));
router.use('/address-search',    require('./trips/address-search'));
router.use('/recent-addresses',  require('./trips/recent-addresses'));

// /action handles one-time email tokens — no JWT required; token = credential.
// Must be registered before booking.js to avoid being caught by GET /:id.
router.use('/action',         require('./trips/action'));

// booking.js handles:
//   POST   /          — create a trip
//   GET    /:id       — trip detail
//   PATCH  /:id/accept, /cancel, /complete, /decline — status transitions
router.use('/',               require('./trips/booking'));

module.exports = router;
