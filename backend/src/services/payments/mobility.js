/**
 * @file services/payments/mobility.js
 * @module services/payments/mobility
 * @description Future provider: internal mobility ticket system.
 *
 * Implement createSetupIntent(), charge(), refund() when ready.
 *
 * Mobility tickets are pre-purchased credits managed by the operator outside
 * the platform (e.g. issued by a regional transit authority).  When this
 * provider is active, trips should be settled by deducting from the client's
 * ticket balance rather than charging a credit card.
 *
 * To implement:
 *   1. Add a `mobility_ticket_balance` column (or a separate table) for clients.
 *   2. Implement createSetupIntent() to validate the client has sufficient balance.
 *   3. Implement charge() to deduct the amount and record the transaction.
 *   4. Implement refund() to credit the amount back.
 *   5. Insert 'mobility' into the configuration table's payment_provider key.
 */

// ─────────────────────────────────────────────────────────────────────────────
// All three methods throw until this provider is implemented.
// ─────────────────────────────────────────────────────────────────────────────

async function createSetupIntent() {
  throw new Error('Mobility payment provider not yet implemented');
}

async function charge() {
  throw new Error('Mobility payment provider not yet implemented');
}

async function refund() {
  throw new Error('Mobility payment provider not yet implemented');
}

async function retrieveSetupIntent() { return null; }

module.exports = { createSetupIntent, retrieveSetupIntent, charge, refund };
