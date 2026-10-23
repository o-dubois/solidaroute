/**
 * @file MobilityTicketForm.jsx
 * @description Payment form for the mobility ticket method.
 *
 * Flow:
 *   1. On mount: calls GET /api/tickets/for-trip/:tripId to get the required
 *      ticket count and the client's available tickets as auto-fill suggestions.
 *   2. Renders N input boxes (one per required ticket).
 *   3. The client can click suggestion chips to auto-fill the inputs.
 *   4. If any tickets come from organisation notebooks, the client adds the
 *      corresponding notebook key(s) — up to 10 keys for tickets from different
 *      organisations.
 *   5. On submit: calls POST /api/tickets/reserve with ticket numbers and
 *      notebook_keys array.
 *
 * Props:
 *   tripId       — the trip to pay for
 *   onComplete   — called with { paymentId } on successful reservation
 *   onBack       — called when the user clicks Back
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ticketService } from '../../services/api';

const MAX_NOTEBOOK_KEYS = 10;

export default function MobilityTicketForm({ tripId, onComplete, onBack }) {
  const { t } = useTranslation();

  // Trip context loaded from /api/tickets/for-trip/:tripId
  const [loading,          setLoading]          = useState(true);
  const [loadError,        setLoadError]         = useState('');
  const [requiredCount,    setRequiredCount]     = useState(1);
  const [facialValue,      setFacialValue]       = useState(1.25);
  const [currency,         setCurrency]          = useState('CAD');
  const [estimatedCost,    setEstimatedCost]     = useState(0);
  const [availableTickets, setAvailableTickets]  = useState([]);

  // Ticket number inputs — one per required ticket
  const [ticketInputs, setTicketInputs] = useState([]);

  // Organisation notebook keys — dynamic list, up to MAX_NOTEBOOK_KEYS
  // Each entry is a string (the key value). Start with one empty entry
  // so the UI shows a prompt, but the user can dismiss it if not needed.
  const [notebookKeys,  setNotebookKeys]  = useState([]);
  const [showOrgKeys,   setShowOrgKeys]   = useState(false);

  const [submitting,   setSubmitting]    = useState(false);
  const [submitError,  setSubmitError]   = useState('');

  // ── Load trip context on mount ──────────────────────────────────────────────
  useEffect(() => {
    if (!tripId) return;
    setLoading(true);
    setLoadError('');
    ticketService.forTrip(tripId)
      .then(({ data }) => {
        setRequiredCount(data.required_count);
        setFacialValue(data.facial_value);
        setCurrency(data.currency);
        setEstimatedCost(data.estimated_cost ?? 0);
        setAvailableTickets(data.available_tickets ?? []);
        // Pre-fill inputs with available tickets (up to required count)
        const prefill = (data.available_tickets ?? [])
          .slice(0, data.required_count)
          .map(t => String(t.ticket_number));
        const inputs = Array.from(
          { length: data.required_count },
          (_, i) => prefill[i] ?? ''
        );
        setTicketInputs(inputs);
      })
      .catch(err => {
        setLoadError(err.response?.data?.error || t('common.error'));
      })
      .finally(() => setLoading(false));
  }, [tripId, t]);

  // ── Sync input array length if requiredCount changes ───────────────────────
  useEffect(() => {
    setTicketInputs(prev => {
      if (prev.length === requiredCount) return prev;
      return Array.from({ length: requiredCount }, (_, i) => prev[i] ?? '');
    });
  }, [requiredCount]);

  function handleInputChange(index, value) {
    setTicketInputs(prev => {
      const next = [...prev];
      next[index] = value.replace(/\D/g, ''); // digits only
      return next;
    });
  }

  /**
   * Suggestion chip click: fill the first empty slot, or clear the slot that
   * already contains this ticket number (toggle deselect).
   */
  function handleSuggestion(ticketNumber) {
    const numStr = String(ticketNumber);
    const existingIdx = ticketInputs.indexOf(numStr);
    if (existingIdx !== -1) {
      // Already selected — deselect by clearing that slot
      handleInputChange(existingIdx, '');
      return;
    }
    const firstEmpty = ticketInputs.findIndex(v => !v);
    if (firstEmpty === -1) return;
    handleInputChange(firstEmpty, numStr);
  }

  /**
   * Badge (#N) click: if the slot is already filled, clear it (toggle off).
   * If empty, fill it with the next unused available suggestion.
   */
  function handleBadgeClick(index) {
    if (ticketInputs[index]) {
      // Already filled — clear it
      handleInputChange(index, '');
      return;
    }
    const used = new Set(ticketInputs.filter((_, i) => i !== index));
    const next = availableTickets.find(tk => !used.has(String(tk.ticket_number)));
    if (!next) return;
    handleInputChange(index, String(next.ticket_number));
  }

  // ── Notebook key list management ────────────────────────────────────────────
  function handleToggleOrgKeys(checked) {
    setShowOrgKeys(checked);
    if (checked && notebookKeys.length === 0) {
      setNotebookKeys(['']);
    }
    if (!checked) {
      setNotebookKeys([]);
    }
  }

  function handleKeyChange(index, value) {
    setNotebookKeys(prev => {
      const next = [...prev];
      next[index] = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return next;
    });
  }

  function addNotebookKey() {
    if (notebookKeys.length >= MAX_NOTEBOOK_KEYS) return;
    setNotebookKeys(prev => [...prev, '']);
  }

  function removeNotebookKey(index) {
    setNotebookKeys(prev => {
      const next = prev.filter((_, i) => i !== index);
      // Always keep at least one field while the section is open
      return next.length === 0 ? [''] : next;
    });
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError('');

    const nums = ticketInputs.map(v => v.trim()).filter(Boolean);
    if (nums.length < requiredCount) {
      setSubmitError(t('tickets.error_fill_all_inputs', { count: requiredCount }));
      return;
    }

    // Collect non-empty, valid notebook keys
    const keys = notebookKeys
      .map(k => k.trim().toUpperCase())
      .filter(k => k.length === 6);

    if (showOrgKeys && keys.length === 0) {
      setSubmitError(t('tickets.error_key_required'));
      return;
    }

    setSubmitting(true);
    try {
      const { data } = await ticketService.reserve({
        trip_id:        tripId,
        ticket_numbers: nums.map(Number),
        notebook_keys:  keys.length > 0 ? keys : undefined,
      });
      onComplete({ paymentId: data.payment_id });
    } catch (err) {
      const error = err.response?.data?.error || t('common.error');
      const code  = err.response?.data?.code;
      if (code === 'INSUFFICIENT_TICKETS') {
        setSubmitError(t('tickets.error_insufficient', {
          required: err.response.data.required_count,
        }));
      } else if (code === 'TICKETS_NOT_OWNED') {
        setSubmitError(t('tickets.error_not_owned'));
      } else if (code === 'INVALID_NOTEBOOK_KEY') {
        setSubmitError(t('tickets.error_invalid_key'));
      } else if (code === 'TICKETS_UNAVAILABLE') {
        setSubmitError(t('tickets.error_unavailable'));
      } else {
        setSubmitError(error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 text-sm py-6 justify-center">
      <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
      {t('common.loading')}
    </div>
  );

  if (loadError) return (
    <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 rounded-lg p-4 text-sm text-red-700 dark:text-red-300">
      ⚠️ {loadError}
    </div>
  );

  const totalCharged = Math.round(requiredCount * facialValue * 100) / 100;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/* Cost summary */}
      <div className="bg-teal-50 dark:bg-teal-900/30 border border-teal-100 dark:border-teal-800 rounded-xl p-4 space-y-1.5">
        <p className="text-sm font-semibold text-teal-800 dark:text-teal-200">
          🎫 {t('tickets.payment_summary')}
        </p>
        <div className="text-xs text-teal-700 dark:text-teal-300 space-y-0.5">
          <p>{t('tickets.trip_cost')}: <span className="font-medium">{estimatedCost.toFixed(2)} {currency}</span></p>
          <p>{t('tickets.facial_value')}: <span className="font-medium">{facialValue.toFixed(2)} {currency}</span></p>
          <p className="font-semibold text-teal-900">
            {t('tickets.tickets_required')}: {requiredCount}
            {' '}({t('tickets.total_value')}: {totalCharged.toFixed(2)} {currency})
          </p>
        </div>
      </div>

      {/* Ticket number inputs */}
      <div className="space-y-2">
        <label className="label">{t('tickets.enter_ticket_numbers')}</label>
        <div className="grid grid-cols-2 gap-2">
          {ticketInputs.map((val, i) => {
            const used = new Set(ticketInputs.filter((_, j) => j !== i));
            const isFilled = !!ticketInputs[i];
            const hasNextSuggestion = !showOrgKeys &&
              availableTickets.some(tk => !used.has(String(tk.ticket_number)));
            const badgeClickable = isFilled || hasNextSuggestion;
            return (
              <div key={i} className="relative">
                {badgeClickable ? (
                  <button
                    type="button"
                    onClick={() => handleBadgeClick(i)}
                    title={isFilled ? 'Tap to clear this slot' : 'Tap to auto-fill from your available tickets'}
                    className={`absolute left-2 top-1/2 -translate-y-1/2 text-xs font-bold border rounded px-1 py-0.5 leading-none transition-colors cursor-pointer z-10 ${
                      isFilled
                        ? 'text-red-500 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 border-red-200'
                        : 'text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/30 hover:bg-teal-100 border-teal-200'
                    }`}
                  >
                    #{i + 1}
                  </button>
                ) : (
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-teal-500 text-xs font-bold pointer-events-none">
                    #{i + 1}
                  </span>
                )}
                <input
                  type="text"
                  inputMode="numeric"
                  value={val}
                  onChange={e => handleInputChange(i, e.target.value)}
                  placeholder="3 000 000"
                  maxLength={8}
                  required
                  className="input pl-9 font-mono text-sm"
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Auto-fill suggestions from client's own ticket wallet */}
      {availableTickets.length > 0 && !showOrgKeys && (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('tickets.your_tickets')}</p>
          <div className="flex flex-wrap gap-1.5">
            {availableTickets.map(tk => {
              const used = ticketInputs.includes(String(tk.ticket_number));
              return (
                <button
                  key={tk.ticket_number}
                  type="button"
                  onClick={() => handleSuggestion(tk.ticket_number)}
                  disabled={used}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors ${
                    used
                      ? 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 cursor-default'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-teal-50 hover:text-teal-700 cursor-pointer'
                  }`}
                >
                  {used ? '✓ ' : ''}{tk.ticket_number}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Organisation notebook keys toggle */}
      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={showOrgKeys}
          onChange={e => handleToggleOrgKeys(e.target.checked)}
          className="w-4 h-4 text-teal-600 dark:text-teal-400 rounded"
        />
        <span className="text-sm text-gray-600 dark:text-gray-300">{t('tickets.use_org_tickets')}</span>
      </label>

      {/* Multi-notebook key fields */}
      {showOrgKeys && (
        <div className="space-y-3 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-xs font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wide">
            {t('tickets.notebook_keys_label', { defaultValue: 'Notebook keys' })}
          </p>
          <p className="text-xs text-gray-400">{t('tickets.notebook_key_hint')}</p>

          <div className="space-y-2">
            {notebookKeys.map((key, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 w-4 flex-shrink-0">{i + 1}.</span>
                <input
                  type="text"
                  value={key}
                  onChange={e => handleKeyChange(i, e.target.value)}
                  placeholder={t('tickets.notebook_key_placeholder')}
                  maxLength={6}
                  className="input font-mono tracking-widest uppercase flex-1"
                />
                {notebookKeys.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeNotebookKey(i)}
                    className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none px-1"
                    title={t('common.remove', { defaultValue: 'Remove' })}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          {notebookKeys.length < MAX_NOTEBOOK_KEYS && (
            <button
              type="button"
              onClick={addNotebookKey}
              className="text-xs text-teal-600 dark:text-teal-400 hover:text-teal-800 font-medium transition-colors"
            >
              + {t('tickets.add_notebook_key', { defaultValue: 'Add another notebook key' })}
            </button>
          )}
        </div>
      )}

      {/* Error */}
      {submitError && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          ⚠️ {submitError}
        </div>
      )}

      {/* Info note */}
      <p className="text-xs text-gray-400 leading-relaxed">
        🎫 {t('tickets.reservation_info')}
      </p>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="btn-secondary flex-1"
        >
          {t('trips.back')}
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="btn-primary flex-1"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              {t('common.loading')}
            </span>
          ) : (
            t('tickets.confirm_reservation')
          )}
        </button>
      </div>
    </form>
  );
}
