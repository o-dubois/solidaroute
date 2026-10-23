/**
 * @file services/payments/manual.js
 * @module services/payments/manual
 * @description Manual payment provider for SolidaRoute.
 *
 * Used when an operator collects payment outside the platform — for example,
 * by phone with a credit card terminal, by cash, or by cheque.  There is no
 * card-saving or charge API to call; the operator simply records the fact that
 * payment was received (see POST /payments/manual in routes/payments.js).
 *
 * This module implements the same three-method interface as stripe.js so the
 * provider router (services/payments/index.js) can call any provider
 * identically regardless of which one is active.
 *
 * createSetupIntent — no-op; returns null (no card to save)
 * charge            — no-op; returns { intentId: null, status: 'manual' }
 * refund            — no-op; manual refunds are handled outside the platform
 */

// ─────────────────────────────────────────────────────────────────────────────
// createSetupIntent
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Manual payments do not involve saving a card.  The operator records the
 * payment directly via POST /payments/manual without any frontend card-entry
 * step.
 *
 * Returns null so the caller knows there is no client-side step to perform.
 *
 * @returns {Promise<null>}
 */
async function createSetupIntent(/* userId, existingCustomerId */) {
  // No card capture flow for manual payments.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// charge
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Manual payments are already collected by the operator before this is called.
 * Return a synthetic status so the payments route can record a consistent
 * status value in the DB without branching on provider type.
 *
 * @returns {Promise<{ intentId: null, status: 'manual' }>}
 */
async function charge(/* paymentMethodId, customerId, amountDollars, currency */) {
  return { intentId: null, status: 'manual' };
}

// ─────────────────────────────────────────────────────────────────────────────
// refund
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Manual refunds are handled by the operator directly (returning cash, issuing
 * a credit on the terminal, etc.).  This is a no-op so the payments route can
 * call refund() uniformly without checking the provider type first.
 *
 * @returns {Promise<{ refundId: null, status: 'manual' }>}
 */
async function refund(/* paymentIntentId */) {
  return { refundId: null, status: 'manual' };
}

async function retrieveSetupIntent() { return null; }

module.exports = { createSetupIntent, retrieveSetupIntent, charge, refund };
