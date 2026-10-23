/**
 * @file ManualPaymentForm.jsx
 * @description Simple form for recording manual (non-card) payments by operators.
 *
 * Used by PhoneIntake when the operator selects "Manual payment" instead of
 * processing a card through Stripe. Typical use cases include cheque, cash,
 * or invoice arrangements handled outside the app.
 *
 * The form collects:
 *   - `payment_reference` (required) — a short identifier such as "Cheque #1234",
 *     "Cash collected", or "Invoice INV-0056". Stored by the backend for auditing.
 *   - `operator_note` (optional) — free-text context for the internal record.
 *
 * Validation:
 *   Only the reference field is required. The submit button is disabled while
 *   the parent `loading` prop is true so the operator cannot double-submit.
 *
 * Props:
 * @param {function} onSubmit — called with { payment_reference, operator_note }
 *                              when the form is submitted and validated.
 * @param {boolean}  [loading=false] — disables the submit button when true;
 *                                     the parent shows a spinner on its side.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * ManualPaymentForm — operator form for recording a manual payment.
 *
 * Maintains its own local state for the two fields so the parent only receives
 * validated data on submit (no need for the parent to mirror field state).
 *
 * @param {function} onSubmit  — called with { payment_reference, operator_note }
 * @param {boolean}  [loading] — true while the parent's API call is in-flight
 */
export default function ManualPaymentForm({ onSubmit, loading = false }) {
  const { t } = useTranslation();

  // ── Local field state ──────────────────────────────────────
  const [reference, setReference] = useState('');    // required
  const [note,      setNote]      = useState('');    // optional
  const [refError,  setRefError]  = useState('');    // inline validation error

  /**
   * handleSubmit — validates and forwards the form data to the parent.
   *
   * Trims whitespace before validation so "   " is treated as empty.
   * The parent is responsible for making the API call and handling errors;
   * this form only handles its own field-level validation.
   */
  function handleSubmit(e) {
    e.preventDefault();
    const trimmedRef = reference.trim();

    // Reference is the only required field
    if (!trimmedRef) {
      setRefError(t('common.field_required'));
      return;
    }

    setRefError('');
    onSubmit({
      payment_reference: trimmedRef,
      operator_note:     note.trim() || null,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Payment reference — required */}
      <div>
        <label className="label">
          {t('payment.reference_label')}
          <span className="text-red-400 ml-0.5">*</span>
        </label>
        <input
          type="text"
          className={`input w-full ${refError ? 'border-red-300' : ''}`}
          placeholder={t('payment.reference_placeholder')}
          value={reference}
          onChange={e => { setReference(e.target.value); setRefError(''); }}
          maxLength={200}
          autoComplete="off"
        />
        {refError && (
          <p className="text-red-500 text-xs mt-1">⚠️ {refError}</p>
        )}
      </div>

      {/* Operator note — optional */}
      <div>
        <label className="label">
          {t('payment.note_label')}
          <span className="text-gray-400 font-normal ml-1">
            ({t('common.optional')})
          </span>
        </label>
        <textarea
          className="input w-full resize-none"
          rows={3}
          placeholder={t('payment.note_placeholder')}
          value={note}
          onChange={e => setNote(e.target.value)}
          maxLength={500}
        />
        {/* Character counter — helps operators stay within the server-side limit */}
        <p className="text-xs text-gray-400 mt-1 text-right">{note.length}/500</p>
      </div>

      {/* Submit — disabled while parent is saving */}
      <button
        type="submit"
        disabled={loading}
        className="btn-primary w-full"
      >
        {loading ? (
          <span className="flex items-center gap-2 justify-center">
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            {t('payment.processing')}
          </span>
        ) : (
          t('payment.confirm_manual')
        )}
      </button>
    </form>
  );
}
