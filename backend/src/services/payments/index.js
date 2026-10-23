/**
 * @file services/payments/index.js
 * @module services/payments
 * @description Payment provider router for SolidaRoute.
 *
 * This module is the single entry point for all payment operations.
 * Route handlers and trip completion logic always call getProvider(pool) and
 * then call methods on the returned provider object — they never import a
 * specific provider (stripe.js, manual.js, etc.) directly.  This abstraction
 * means:
 *
 *   - Switching payment providers requires only a DB config change
 *     (UPDATE configuration SET value='paypal' WHERE key='payment_provider')
 *     and a server restart; no code changes needed.
 *   - Adding a new provider (e.g. Interac, mobility tickets) only requires
 *     creating a new file in this directory and adding a case below.
 *   - Unit tests can inject a mock pool that returns any provider name.
 *
 * Supported providers:
 *   'stripe'   — Stripe SetupIntent + off-session charge (production default)
 *   'manual'   — Operator records phone/cash payments; no API calls made
 *   'mobility' — Future: internal mobility ticket system (stub, throws)
 *   'paypal'   — Future: PayPal billing agreements (stub, throws)
 *
 * Usage:
 *   const { getProvider } = require('../services/payments');
 *   const provider = await getProvider(pool);
 *   const { clientSecret } = await provider.createSetupIntent(userId, customerId);
 *
 * @param {import('pg').Pool} pool — PostgreSQL connection pool
 * @returns {Promise<object>} provider object with createSetupIntent, charge, refund
 */

const stripeProvider   = require('./stripe');
const manualProvider   = require('./manual');
const mobilityProvider = require('./mobility');
const paypalProvider   = require('./paypal');

// Map of provider name (as stored in the configuration table) to module.
// All values must implement: createSetupIntent(), charge(), refund()
const PROVIDERS = {
  stripe:   stripeProvider,
  manual:   manualProvider,
  mobility: mobilityProvider,
  paypal:   paypalProvider,
};

/**
 * Read the active payment provider from the configuration table and return
 * the corresponding provider module.
 *
 * Falls back to 'stripe' if the configuration key is missing so the platform
 * works out of the box without a migration having been run.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ createSetupIntent: Function, charge: Function, refund: Function }>}
 * @throws {Error} if the configured provider name is not recognised
 */
async function getProvider(pool) {
  // Single round-trip to fetch the active provider name from the DB.
  const { rows } = await pool.query(
    `SELECT value FROM configuration WHERE key = 'payment_provider' LIMIT 1`
  );

  const providerName = rows.length ? rows[0].value : 'stripe';

  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(
      `Unknown payment provider "${providerName}". ` +
      `Valid values: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }

  return provider;
}

module.exports = { getProvider };
