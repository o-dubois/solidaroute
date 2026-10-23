/**
 * @file services/payments/paypal.js
 * @module services/payments/paypal
 * @description Future provider: PayPal payment integration.
 *
 * Implement createSetupIntent(), charge(), refund() when ready.
 *
 * PayPal supports both guest checkout and saved billing agreements (equivalent
 * to Stripe's SetupIntent + off-session charge).  When this provider is active,
 * the SetupIntent step should create a PayPal Billing Agreement and return the
 * approval URL so the client can authorise future charges.
 *
 * To implement:
 *   1. Install the PayPal SDK: npm install @paypal/checkout-server-sdk
 *   2. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.
 *   3. Implement createSetupIntent() to create a Billing Agreement token.
 *   4. Implement charge() to execute a reference transaction against the agreement.
 *   5. Implement refund() to issue a full or partial refund.
 *   6. Set configuration.payment_provider = 'paypal' in the database.
 */

// ─────────────────────────────────────────────────────────────────────────────
// All three methods throw until this provider is implemented.
// ─────────────────────────────────────────────────────────────────────────────

async function createSetupIntent() {
  throw new Error('PayPal payment provider not yet implemented');
}

async function charge() {
  throw new Error('PayPal payment provider not yet implemented');
}

async function refund() {
  throw new Error('PayPal payment provider not yet implemented');
}

async function retrieveSetupIntent() { return null; }

module.exports = { createSetupIntent, retrieveSetupIntent, charge, refund };
