// routes/tickets.js — thin index, delegates to sub-routers in routes/tickets/
//
// Mounted at /api/tickets in src/index.js
//
// Registration order matters:
//   1. /notebooks — before catch-all '/' to avoid /:ticket_number matching "notebooks"
//   2. /config    — before catch-all '/' for the same reason
//   3. client     — my-tickets, for-trip/:trip_id, reserve
//   4. management — clients, trips, release/:trip_id, /:ticket_number/void
//      (literal paths in management.js must be registered before /:ticket_number/void
//       within that sub-router — already guaranteed by registration order inside it)
const router = require('express').Router();

router.use('/notebooks', require('./tickets/notebooks'));
router.use('/config',    require('./tickets/config'));
router.use('/',          require('./tickets/client'));
router.use('/',          require('./tickets/management'));

module.exports = router;
