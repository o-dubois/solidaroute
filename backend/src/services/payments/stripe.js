/**
 * @file services/payments/stripe.js
 * @module services/payments/stripe
 * @description Stripe payment provider for SolidaRoute.
 *
 * Implements the standard payment provider interface used by the provider
 * router (services/payments/index.js):
 *
 *   createSetupIntent(userId, existingCustomerId)
 *   charge(paymentMethodId, customerId, amountDollars, currency)
 *   refund(paymentIntentId)
 *
 * All amounts stored in the DB are in dollars (e.g. 25.50).
 * Stripe requires amounts in the smallest currency unit (cents), so every
 * dollar amount is multiplied by 100 before being sent to the Stripe API.
 *
 * The Stripe secret key is read from process.env.STRIPE_SECRET_KEY.
 * It must never be hard-coded here or stored in the database.
 *
 * Flow overview:
 *   1. Client books a trip → POST /payments/setup-intent
 *      → createSetupIntent() creates (or reuses) a Stripe Customer
 *      → returns a SetupIntent clientSecret to the frontend
 *   2. Client enters card details on the frontend using Stripe.js
 *      → Stripe saves the PaymentMethod on the Customer (off-session capable)
 *   3. Client confirms → POST /payments/confirm
 *      → payment row updated with setup_intent_id + payment_method_id
 *   4. Trip completes → POST /payments/charge/:trip_id
 *      → charge() creates an off-session PaymentIntent and confirms it
 *      → payment row updated with payment_intent_id + status='paid'
 *
 * Prerequisites:
 *   npm install stripe
 */

// Lazy-initialise the Stripe client so the module can be imported without
// crashing when STRIPE_SECRET_KEY is not yet set (e.g. during unit tests that
// mock the provider, or before the .env file is loaded).
let _stripe = null;

/**
 * Return (and cache) a Stripe client instance.
 * Throws a clear error if STRIPE_SECRET_KEY is missing so developers see a
 * useful message instead of a cryptic "Cannot read property of undefined".
 *
 * @returns {import('stripe').Stripe}
 */
function getStripe() {
  if (_stripe) return _stripe;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it to your .env file and restart the server.'
    );
  }

  // Require stripe here (not at module top) so the module loads even when
  // the stripe npm package has not been installed yet, giving a friendlier
  // error at the point of first use rather than on server startup.
  const Stripe = require('stripe');
  _stripe = Stripe(secretKey, {
    apiVersion: '2024-04-10', // Pin to a specific API version for stability
  });

  return _stripe;
}

// ─────────────────────────────────────────────────────────────────────────────
// createSetupIntent
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Create (or reuse) a Stripe Customer and create a SetupIntent so the client
 * can save their card details via Stripe.js without being charged immediately.
 *
 * The SetupIntent uses usage: 'off_session' which tells Stripe to attach the
 * payment method to the customer with off-session permissions — meaning we
 * can charge the card later (when the trip completes) without the cardholder
 * being present.
 *
 * @param {string|number} userId            — internal user ID (for Stripe metadata)
 * @param {string|null}   existingCustomerId — stripe_customer_id from the users row,
 *                                            or null if the user has no Stripe record yet
 * @returns {Promise<{ clientSecret: string, setupIntentId: string, customerId: string }>}
 */
async function createSetupIntent(userId, existingCustomerId) {
  const stripe = getStripe();

  // Reuse the existing Stripe Customer if we already have one; otherwise create
  // a new one.  We intentionally do not pass an email here because the caller
  // (the payments route) can attach user details separately if needed.
  let customerId = existingCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { solidaroute_user_id: String(userId) },
    });
    customerId = customer.id;
  }

  // Create the SetupIntent with off_session usage so the saved PaymentMethod
  // can be used for future off-session charges (trip completion).
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: 'off_session',
    // automatic_payment_methods lets Stripe handle the payment method type
    // negotiation (card, etc.) automatically based on the customer's region.
    // Restrict to card only — disables Stripe Link and other wallets
    // so the form shows only the standard card input field.
    payment_method_types: ['card'],
    metadata: { solidaroute_user_id: String(userId) },
  });

  return {
    clientSecret:  setupIntent.client_secret,
    setupIntentId: setupIntent.id,
    customerId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// retrieveSetupIntent
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Retrieve an existing SetupIntent from Stripe by its ID.
 * Used to recover the client_secret when the frontend re-requests the payment
 * step for a trip that already has a pending payment row.
 *
 * @param {string} setupIntentId — si_XXXX stored in payments.stripe_setup_intent_id
 * @returns {Promise<{ clientSecret: string }>}
 */
async function retrieveSetupIntent(setupIntentId) {
  const stripe = getStripe();
  const si = await stripe.setupIntents.retrieve(setupIntentId);
  return { clientSecret: si.client_secret };
}

// ─────────────────────────────────────────────────────────────────────────────
// charge
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Charge a previously saved PaymentMethod off-session (i.e. without the
 * cardholder present) by creating and immediately confirming a PaymentIntent.
 *
 * Called when a trip is marked completed and the platform collects the fare.
 *
 * @param {string} paymentMethodId  — pm_XXXX from the confirmed SetupIntent
 * @param {string} customerId       — cus_XXXX Stripe Customer ID
 * @param {number} amountDollars    — amount in dollars (e.g. 25.50); converted
 *                                    to cents internally before calling Stripe
 * @param {string} currency         — ISO 4217 currency code (e.g. 'CAD', 'USD')
 * @returns {Promise<{ intentId: string, status: string }>}
 */
async function charge(paymentMethodId, customerId, amountDollars, currency) {
  const stripe = getStripe();

  // Stripe requires amounts in the smallest currency unit (cents).
  // Math.round avoids floating-point rounding issues (e.g. 25.10 * 100 = 2509.9999...)
  const amountCents = Math.round(amountDollars * 100);

  const intent = await stripe.paymentIntents.create({
    amount:               amountCents,
    currency:             currency.toLowerCase(),
    customer:             customerId,
    payment_method:       paymentMethodId,
    // Restrict to card only — required for error_on_requires_action to work
    // (incompatible with Dashboard-managed automatic_payment_methods)
    payment_method_types: ['card'],
    // confirm: true immediately confirms the intent rather than requiring a
    // separate stripe.paymentIntents.confirm() call
    confirm:              true,
    // off_session: true tells Stripe not to use 3DS (the card was already set up
    // for off-session use during the SetupIntent flow)
    off_session:          true,
    // error_on_requires_action: true causes Stripe to throw an error immediately
    // if the charge requires customer action (e.g. 3DS challenge) rather than
    // returning a requires_action status that would silently hang
    error_on_requires_action: true,
    metadata: {
      solidaroute_customer_id: customerId,
    },
  });

  return {
    intentId: intent.id,
    status:   intent.status,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// refund
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Issue a full refund for a previously charged PaymentIntent.
 *
 * By default Stripe refunds the full amount.  If partial refunds are ever
 * needed, pass an `amount` (in cents) to stripe.refunds.create().
 *
 * @param {string} paymentIntentId — pi_XXXX from the original charge
 * @returns {Promise<{ refundId: string, status: string }>}
 */
async function refund(paymentIntentId) {
  const stripe = getStripe();

  const result = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    // No `amount` param = full refund
  });

  return {
    refundId: result.id,
    status:   result.status,
  };
}

module.exports = { createSetupIntent, retrieveSetupIntent, charge, refund };
