/**
 * @file PaymentStep.jsx
 * @description Provider-agnostic payment step used by both the NewTrip wizard
 * (step 6) and the PhoneIntake confirmation flow.
 *
 * Responsibilities:
 *   1. For Stripe provider — calls POST /api/payments/setup-intent to obtain a
 *      `clientSecret`, then renders `<StripePaymentForm>` to collect card details.
 *      After the card is saved, calls POST /api/payments/confirm to associate
 *      the SetupIntent + PaymentMethod with the trip.
 *   2. For manual provider — renders `<ManualPaymentForm>` directly.
 *      After submission, calls POST /api/payments/manual with the reference + note.
 *   3. When `isOperator` is true AND the provider is 'stripe', a payment-method
 *      selector (radio buttons) is shown so the operator can choose between
 *      Stripe (card by phone) or Manual.
 *      When `isOperator` is false (client self-service), the provider prop drives
 *      the UI with no choice.
 *
 * API calls made from this component:
 *   POST /payments/setup-intent  { trip_id }           → { client_secret }
 *   POST /payments/confirm       { payment_id,          → { payment }
 *                                  setup_intent_id,
 *                                  payment_method_id }
 *   POST /payments/manual        { trip_id,             → { payment }
 *                                  payment_reference,
 *                                  operator_note }
 *
 * Props:
 * @param {string}   tripId               — trip ID to associate the payment with
 * @param {string}   provider             — 'stripe' | 'manual' (from config)
 * @param {string}   publishableKey       — Stripe pk_test_ / pk_live_ key
 * @param {boolean}  [isOperator=false]   — shows method selector when true
 * @param {function} onComplete           — called with { paymentId } on success
 * @param {function} onBack               — called when the "← Back" button is clicked
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { paymentService } from '../../services/api';
import StripePaymentForm from './StripePaymentForm';
import ManualPaymentForm from './ManualPaymentForm';
import MobilityTicketForm from './MobilityTicketForm';

/**
 * PaymentStep
 *
 * Orchestrates the payment flow for both the client wizard and operator intake.
 * The component is intentionally decoupled from the Stripe vs. manual distinction
 * so that switching payment providers only requires changing the `provider` config.
 *
 * State:
 *   activeMethod — 'stripe' | 'manual'; initialised from the `provider` prop;
 *                  only changeable by operators via the method selector.
 *   clientSecret — fetched from the backend when Stripe is the active method.
 *   fetchingIntent — true while the setup-intent call is in flight.
 *   confirming — true while the confirm/manual API call is in flight.
 *   intentError — error message to display if the setup-intent call fails.
 */
export default function PaymentStep({
  tripId,
  provider,
  publishableKey,
  isOperator = false,
  onComplete,
  onBack,
}) {
  const { t } = useTranslation();

  // The method currently being used — starts from the configured provider.
  // Operators may switch between 'stripe' and 'manual' via the radio selector.
  const [activeMethod,    setActiveMethod]    = useState(provider || 'manual');

  // SetupIntent client_secret fetched from our backend (Stripe flow only)
  const [clientSecret,    setClientSecret]    = useState(null);

  // paymentId returned alongside the clientSecret from setup-intent; used in the confirm call
  const [paymentId,       setPaymentId]       = useState(null);

  // Loading state while fetching the SetupIntent
  const [fetchingIntent,  setFetchingIntent]  = useState(false);

  // Loading state while confirming (Stripe or manual) with the backend
  const [confirming,      setConfirming]      = useState(false);

  // Error message to show when setup-intent fetch fails
  const [intentError,     setIntentError]     = useState('');

  // stripeStarted: true only after the user explicitly clicks "Pay by card".
  // Prevents auto-fetching the SetupIntent on mount (which would create a
  // phantom 'pending' payment row that blocks mobility ticket reservation).
  const [stripeStarted,   setStripeStarted]   = useState(false);

  // Reset stripeStarted when the user switches away from Stripe
  useEffect(() => {
    if (activeMethod !== 'stripe') {
      setStripeStarted(false);
      setClientSecret(null);
      setPaymentId(null);
      setIntentError('');
    }
  }, [activeMethod]);

  // ── Fetch SetupIntent — only when user explicitly commits to Stripe ──────
  // Triggered by stripeStarted becoming true, not by activeMethod alone.
  // This avoids creating a DB payment row just because Stripe was the default.
  useEffect(() => {
    if (!stripeStarted) return;
    if (activeMethod !== 'stripe') return;
    if (!tripId) return;

    setClientSecret(null);
    setPaymentId(null);
    setIntentError('');
    setFetchingIntent(true);

    paymentService.setupIntent(tripId)
      .then(({ data }) => {
        setClientSecret(data.client_secret);
        setPaymentId(data.payment_id || null);
      })
      .catch(err => {
        const msg = err.response?.data?.error || t('common.error');
        setIntentError(msg);
      })
      .finally(() => setFetchingIntent(false));
  }, [stripeStarted, activeMethod, tripId, t]);

  // ── Stripe card saved handler ────────────────────────────────────────────
  /**
   * Called by StripePaymentForm after stripe.confirmCardSetup succeeds.
   * Sends the IDs to our backend to record the saved payment method.
   *
   * @param {string} setupIntentId   — Stripe SetupIntent ID (seti_...)
   * @param {string} paymentMethodId — Stripe PaymentMethod ID (pm_...)
   */
  async function handleStripeSuccess({ setupIntentId, paymentMethodId }) {
    setConfirming(true);
    try {
      const { data } = await paymentService.confirm(
        paymentId,      // payment_id — obtained from the setup-intent response
        setupIntentId,
        paymentMethodId
      );
      onComplete({ paymentId: data.payment?.id || null });
    } catch (_err) {
      // Error toast already fired by the global response interceptor in api.js
    } finally {
      setConfirming(false);
    }
  }

  // ── Stripe error handler ─────────────────────────────────────────────────
  /**
   * Called by StripePaymentForm when card confirmation fails.
   * The inline error is already displayed inside StripePaymentForm; we log
   * here for debugging but do not show a second toast (global interceptor handles it).
   *
   * @param {string} message — error message string
   */
  function handleStripeError(message) {
    // StripePaymentForm already shows the error inline.
    // The parent may use this to track error state if needed.
    console.warn('[PaymentStep] Stripe error:', message);
  }

  // ── Manual payment submit handler ────────────────────────────────────────
  /**
   * Called by ManualPaymentForm with the validated reference + note.
   * Posts to the backend, then calls onComplete.
   *
   * @param {string} payment_reference — required reference string
   * @param {string|null} operator_note — optional note
   */
  async function handleManualSubmit({ payment_reference, operator_note }) {
    setConfirming(true);
    try {
      const { data } = await paymentService.manual(
        tripId,
        payment_reference,
        operator_note
      );
      onComplete({ paymentId: data.payment?.id || null });
    } catch (_err) {
      // Global interceptor fires a toast; stay on this step so the operator can retry
    } finally {
      setConfirming(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  // When the operator pre-selected Mobility in the intake wizard, skip the
  // method selector entirely and go straight to the MobilityTicketForm.
  if (provider === 'mobility') {
    return (
      <div className="space-y-4">
        <div className="card space-y-5">
          <h2 className="text-base font-semibold">{t('payment.step_title')}</h2>
          <MobilityTicketForm
            tripId={tripId}
            onComplete={onComplete}
            onBack={onBack}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-5">
        {/* Step heading */}
        <h2 className="text-base font-semibold">{t('payment.step_title')}</h2>

        {/* ── Payment method selector ──────────────────────────────────────
            Shown when provider is stripe or manual.
            - Stripe option:   shown when provider === 'stripe'
            - Manual option:   shown to operators when provider === 'manual'
            - Mobility option: always shown (lets client switch if needed)    */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wide">
            {t('payment.choose_method')}
          </p>

          {/* Card (Stripe) — only when Stripe is the configured provider */}
          {provider === 'stripe' && (
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name="paymentMethod"
                value="stripe"
                checked={activeMethod === 'stripe'}
                onChange={() => setActiveMethod('stripe')}
                className="w-4 h-4 text-teal-600 dark:text-teal-400"
              />
              <span className="text-sm text-gray-800 dark:text-gray-100">💳 {t('payment.method_stripe')}</span>
            </label>
          )}

          {/* Manual — operators only, when manual is the configured provider */}
          {isOperator && provider === 'manual' && (
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name="paymentMethod"
                value="manual"
                checked={activeMethod === 'manual'}
                onChange={() => setActiveMethod('manual')}
                className="w-4 h-4 text-teal-600 dark:text-teal-400"
              />
              <span className="text-sm text-gray-800 dark:text-gray-100">📄 {t('payment.method_manual')}</span>
            </label>
          )}

          {/* Mobility tickets — available as fallback for stripe/manual flows */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="paymentMethod"
              value="mobility"
              checked={activeMethod === 'mobility'}
              onChange={() => setActiveMethod('mobility')}
              className="w-4 h-4 text-teal-600 dark:text-teal-400"
            />
            <span className="text-sm text-gray-800 dark:text-gray-100">🎫 {t('payment.method_mobility')}</span>
          </label>
        </div>

        {/* ── Stripe form ──────────────────────────────────────────────────
            Only starts (fetches SetupIntent) when the user explicitly clicks
            "Pay by card". Until then, shows a prompt button to avoid creating
            a phantom payment row that would block mobility ticket reservation. */}
        {activeMethod === 'stripe' && (
          <>
            {!stripeStarted ? (
              <button
                type="button"
                onClick={() => setStripeStarted(true)}
                className="btn-primary w-full"
              >
                💳 {t('payment.start_card')}
              </button>
            ) : fetchingIntent ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm py-4 justify-center">
                <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
                {t('common.loading')}
              </div>
            ) : intentError ? (
              <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 rounded-lg p-4 text-sm text-red-700 dark:text-red-300">
                ⚠️ {intentError}
              </div>
            ) : clientSecret ? (
              <StripePaymentForm
                stripePublishableKey={publishableKey}
                clientSecret={clientSecret}
                onSuccess={handleStripeSuccess}
                onError={handleStripeError}
                isOperator={isOperator}
              />
            ) : null}
          </>
        )}

        {/* ── Manual form ─────────────────��────────────────────────────────
            Shown when provider is 'manual' or operator switched to manual. */}
        {activeMethod === 'manual' && (
          <ManualPaymentForm
            onSubmit={handleManualSubmit}
            loading={confirming}
          />
        )}

        {/* ── Mobility tickets form ─────────────────────���───────────────────
            Shown when the configured payment provider is 'mobility'.
            The form handles its own submission and calls onComplete directly,
            so we wrap with a guard and hide the Back button below. */}
        {activeMethod === 'mobility' && (
          <MobilityTicketForm
            tripId={tripId}
            onComplete={onComplete}
            onBack={onBack}
          />
        )}

        {/* Confirming overlay — shown while the backend call is in-flight
            after the Stripe card save completes (confirming the intent). */}
        {confirming && activeMethod === 'stripe' && (
          <div className="flex items-center gap-2 text-teal-600 dark:text-teal-400 text-sm justify-center py-2">
            <span className="w-4 h-4 border-2 border-teal-200 border-t-teal-600 rounded-full animate-spin" />
            {t('payment.processing')}
          </div>
        )}
      </div>

      {/* Back button — not rendered for mobility (that form has its own Back button) */}
      {activeMethod !== 'mobility' && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onBack}
            className="btn-secondary flex-1"
            disabled={confirming || fetchingIntent}
          >
            {t('trips.back')}
          </button>
        </div>
      )}
    </div>
  );
}
