/**
 * @file StripePaymentForm.jsx
 * @description Stripe card entry form using SetupIntent to save a payment method
 * for off-session charging after trip completion.
 *
 * Architecture:
 *   This file exports two components:
 *   1. `StripePaymentForm` (default) — the outer wrapper that initialises the
 *      Stripe.js instance via `loadStripe` and wraps the inner form in Stripe's
 *      `<Elements>` provider. The Stripe publishable key is passed as a prop so
 *      it comes from the application's config rather than being hardcoded here.
 *   2. `CardForm` (internal) — the actual form that calls `useStripe` /
 *      `useElements` and submits the SetupIntent. It must be a child of
 *      `<Elements>` to have access to the Stripe context.
 *
 * Payment flow:
 *   1. Caller obtains a `clientSecret` from the backend (POST /payments/setup-intent).
 *   2. User enters their card details via `<CardElement>`.
 *   3. On submit, `stripe.confirmCardSetup(clientSecret, ...)` exchanges the card
 *      data for a SetupIntent + PaymentMethod ID.
 *   4. `onSuccess({ setupIntentId, paymentMethodId })` is called so the parent can
 *      hit the backend to record the card on the trip.
 *   5. Errors from Stripe (invalid card, network issues, etc.) are surfaced inline
 *      and forwarded to `onError(message)`.
 *
 * @requires @stripe/stripe-js
 * @requires @stripe/react-stripe-js
 * — These packages must be installed: npm install @stripe/stripe-js @stripe/react-stripe-js
 *
 * Props for the default export (`StripePaymentForm`):
 * @param {string}   clientSecret       — SetupIntent client_secret from the backend
 * @param {function} onSuccess          — called with { setupIntentId, paymentMethodId }
 * @param {function} onError            — called with an error message string
 * @param {string}   [submitLabel]      — button label; defaults to t('payment.save_card')
 * @param {boolean}  [isOperator=false] — if true, shows a note about entering the client's card
 * @param {string}   stripePublishableKey — Stripe publishable key (pk_test_... or pk_live_...)
 */
import { useState, useMemo } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { useTranslation } from 'react-i18next';

// ── Card element visual style ─────────────────────────────────
// Build dark-mode-aware options at call time (Stripe's iframe ignores CSS/Tailwind).
function makeCardElementOptions(isDark) {
  return {
    hidePostalCode: true,
    disableLink:    true,
    style: {
      base: {
        color:           isDark ? '#f9fafb' : '#1f2937',
        fontFamily:      'inherit',
        fontSize:        '14px',
        fontSmoothing:   'antialiased',
        '::placeholder': { color: isDark ? '#6b7280' : '#9ca3af' },
        iconColor:       isDark ? '#9ca3af' : '#6b7280',
      },
      invalid: {
        color:     '#ef4444',
        iconColor: '#ef4444',
      },
      complete: {
        iconColor: '#14b8a6',
      },
    },
  };
}

// ── Inner form component (requires Stripe Elements context) ───

/**
 * CardForm — inner form that consumes the Stripe Elements context.
 *
 * This component MUST be rendered inside an `<Elements>` provider.
 * It owns the form submission logic: calling `confirmCardSetup` and routing
 * success/error back to the parent via props.
 *
 * @param {string}   clientSecret  — SetupIntent client_secret
 * @param {function} onSuccess     — called with { setupIntentId, paymentMethodId }
 * @param {function} onError       — called with a string error message
 * @param {string}   submitLabel   — text for the submit button
 * @param {boolean}  isOperator    — shows phone-intake helper text when true
 */
function CardForm({ clientSecret, onSuccess, onError, submitLabel, isOperator }) {
  const { t }        = useTranslation();
  const stripe       = useStripe();
  const elements     = useElements();
  const [loading,        setLoading]        = useState(false);
  const [cardError,      setCardError]      = useState('');
  const [cardholderName, setCardholderName] = useState('');
  const [postalCode,     setPostalCode]     = useState('');

  const isDark = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
    []
  );
  const cardElementOptions = useMemo(() => makeCardElementOptions(isDark), [isDark]);

  /**
   * handleSubmit — validates and submits the card data to Stripe.
   *
   * Steps:
   *   1. Guard against double-submission and missing Stripe context.
   *   2. Extract the CardElement reference from the Elements context.
   *   3. Call `stripe.confirmCardSetup` with the server-issued clientSecret.
   *      Stripe handles PCI-compliant tokenisation in their iframe.
   *   4. On success, extract the IDs and forward to onSuccess.
   *   5. On Stripe error, display inline and forward to onError.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    // Stripe.js may not have loaded yet in edge cases
    if (!stripe || !elements) return;

    setLoading(true);
    setCardError('');

    const cardElement = elements.getElement(CardElement);
    if (!cardElement) {
      setLoading(false);
      return;
    }

    try {
      const { setupIntent, error } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: {
          card: cardElement,
          billing_details: {
            name:    cardholderName.trim() || undefined,
            address: { postal_code: postalCode.trim() || undefined },
          },
        },
      });

      if (error) {
        // Stripe surfaces user-facing localised error messages in error.message
        const msg = error.message || t('common.error');
        setCardError(msg);
        onError(msg);
      } else if (setupIntent) {
        // SetupIntent succeeded — return both IDs to the parent so it can
        // POST them to our backend to associate the card with the trip.
        onSuccess({
          setupIntentId:   setupIntent.id,
          paymentMethodId: setupIntent.payment_method,
        });
      }
    } catch (err) {
      const msg = err.message || t('common.error');
      setCardError(msg);
      onError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Operator helper note — visible only in phone-intake context */}
      {isOperator && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 rounded-lg px-4 py-3">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            📞 {t('payment.operator_card_note')}
          </p>
        </div>
      )}

      {/* Client info notice — explains delayed charging to the cardholder */}
      <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 rounded-lg px-4 py-3">
        <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          🔒 {t('payment.card_saved_info')}
        </p>
      </div>

      {/* Card input wrapper
          The CardElement is housed in a styled div because it renders inside
          an iframe and cannot be given Tailwind classes directly.
          The border/padding here visually match the app's `.input` class. */}
      {/* Cardholder name */}
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
          {t('payment.cardholder_name', { defaultValue: 'Nom du titulaire' })}
        </label>
        <input
          type="text"
          value={cardholderName}
          onChange={e => setCardholderName(e.target.value)}
          placeholder={t('payment.cardholder_name_placeholder', { defaultValue: 'Ex : Marie Dupont' })}
          className="input w-full"
          autoComplete="cc-name"
        />
      </div>

      {/* Card number / expiry / CVC */}
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
          {t('payment.card_number', { defaultValue: 'Numéro de carte' })}
        </label>
        <div className={`border rounded-xl px-4 py-3 bg-white dark:bg-gray-800 transition-colors ${
          cardError ? 'border-red-300' : 'border-gray-300 dark:border-gray-600 focus-within:border-teal-400'
        }`}>
          <CardElement options={cardElementOptions} onChange={() => setCardError('')} />
        </div>
        {cardError && (
          <p className="text-red-500 text-xs mt-1.5">⚠️ {cardError}</p>
        )}
      </div>

      {/* Postal / ZIP code — free-form to support A1A 1A1, 75001, etc. */}
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
          {t('payment.postal_code', { defaultValue: 'Code postal / ZIP' })}
        </label>
        <input
          type="text"
          value={postalCode}
          onChange={e => setPostalCode(e.target.value.toUpperCase())}
          placeholder="A1A 1A1"
          maxLength={10}
          className="input w-full"
          autoComplete="postal-code"
          required
        />
      </div>

      {/* Stripe branding note — encouraged by Stripe's guidelines */}
      <p className="text-xs text-gray-400 text-center">
        🔒 {t('payment.payment_secured')}
      </p>

      {/* Submit button — disabled while Stripe.js is loading or processing */}
      <button
        type="submit"
        disabled={!stripe || loading || !postalCode.trim()}
        className="btn-primary w-full"
      >
        {loading ? (
          <span className="flex items-center gap-2 justify-center">
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            {t('payment.processing')}
          </span>
        ) : (
          submitLabel || t('payment.save_card')
        )}
      </button>
    </form>
  );
}

// ── Default export: outer wrapper ──────────────────────────────

/**
 * StripePaymentForm — outer wrapper component.
 *
 * Lazily loads the Stripe.js SDK using `loadStripe` (memoised so the Stripe
 * instance is not recreated on every render) and wraps `CardForm` inside the
 * required `<Elements>` provider that gives child components access to
 * `useStripe` and `useElements`.
 *
 * The publishable key is passed as a prop (not hardcoded) so the component
 * works across test/live environments without code changes.
 *
 * @param {string}   stripePublishableKey  — pk_test_... or pk_live_...
 * @param {string}   clientSecret         — SetupIntent client_secret from backend
 * @param {function} onSuccess            — { setupIntentId, paymentMethodId }
 * @param {function} onError              — error message string
 * @param {string}   [submitLabel]        — submit button label
 * @param {boolean}  [isOperator=false]   — operator context flag
 */
export default function StripePaymentForm({
  stripePublishableKey,
  clientSecret,
  onSuccess,
  onError,
  submitLabel,
  isOperator = false,
}) {
  // Memoise the Stripe promise so it is only created once per key value.
  // Re-creating the promise on every render would reset the card input.
  const stripePromise = useMemo(
    () => loadStripe(stripePublishableKey),
    [stripePublishableKey]
  );

  if (!clientSecret) {
    // Guard: Elements cannot be initialised without a client_secret
    return null;
  }

  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <CardForm
        clientSecret={clientSecret}
        onSuccess={onSuccess}
        onError={onError}
        submitLabel={submitLabel}
        isOperator={isOperator}
      />
    </Elements>
  );
}
