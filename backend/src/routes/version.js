/**
 * @file routes/version.js
 * @description Public endpoint returning the running application version.
 *              No authentication required — useful for mobile/web to display
 *              version info and for ops tooling to verify deployed versions.
 *
 * GET /api/version
 *   Response: { app: "5.0.0" }
 *
 *   app    — version string from package.json (SemVer: MAJOR.MINOR.PATCH)
 *            MAJOR bumped on breaking API or DB schema changes
 *            MINOR bumped on new features (backward-compatible)
 *            PATCH bumped on bug fixes and small corrections
 */

const express  = require('express');
const { version } = require('../../package.json');

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ app: version });
});

module.exports = router;
