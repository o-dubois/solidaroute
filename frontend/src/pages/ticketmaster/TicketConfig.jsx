/**
 * @file pages/ticketmaster/TicketConfig.jsx
 * @description Mobility ticket face-value configuration with two-person approval.
 *              Route: /ticket-master/config  (roles: ticket_master, operator, superadmin)
 *
 * Shows the current global face value of mobility tickets and lets any eligible user
 * propose a new value.  Because ticket face value affects accounting and payment
 * calculations, a four-eyes (two-person) approval workflow is enforced:
 *
 *   1. User A submits a proposed value → stored as 'pending_ticket_value' in config.
 *   2. The page shows the pending value and a banner asking someone else to approve.
 *   3. User B (same set of roles, but NOT the same person) clicks Approve.
 *   4. The value is committed as 'ticket_face_value' and the pending entry is cleared.
 *      Alternatively, any eligible user (including User A) can click Cancel to discard
 *      the pending change.
 *
 * The proposer cannot approve their own change — the Approve button is hidden if
 * req.user.id matches the pending_ticket_value_proposed_by value from the server.
 *
 * APPROVER_ROLES defines which roles may propose, approve, or cancel.
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

const APPROVER_ROLES = ['ticket_master', 'operator', 'superadmin'];

export default function TicketConfig() {
  const { t }    = useTranslation();
  const { user } = useAuth();

  const [loading,    setLoading]    = useState(true);
  const [config,     setConfig]     = useState(null); // { facial_value, currency, pending, history }

  // Propose form
  const [showPropose,    setShowPropose]    = useState(false);
  const [proposedValue,  setProposedValue]  = useState('');
  const [reason,         setReason]         = useState('');
  const [submitting,     setSubmitting]     = useState(false);

  // Review
  const [reviewNote,  setReviewNote]  = useState('');
  const [reviewing,   setReviewing]   = useState(null); // 'approve' | 'reject'

  const load = () => {
    setLoading(true);
    api.get('/tickets/config')
      .then(({ data }) => setConfig(data))
      .catch(() => toast.error(t('common.error')))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  async function handlePropose(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/tickets/config/propose', {
        proposed_value: parseFloat(proposedValue),
        reason: reason.trim() || undefined,
      });
      toast.success(t('tickets.config_proposed'));
      setShowPropose(false);
      setProposedValue('');
      setReason('');
      load();
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'ALREADY_PENDING') {
        toast.error(t('tickets.config_already_pending'));
      } else {
        toast.error(err.response?.data?.error || t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReview(id, action) {
    setReviewing(action);
    try {
      await api.post(`/tickets/config/${id}/${action}`, {
        review_note: reviewNote.trim() || undefined,
      });
      toast.success(action === 'approve'
        ? t('tickets.config_approved')
        : t('tickets.config_rejected')
      );
      setReviewNote('');
      load();
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'SELF_APPROVAL' || code === 'SELF_REJECTION') {
        toast.error(t('tickets.config_self_review'));
      } else {
        toast.error(err.response?.data?.error || t('common.error'));
      }
    } finally {
      setReviewing(null);
    }
  }

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 text-sm py-12 justify-center">
      <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
      {t('common.loading')}
    </div>
  );

  const pending   = config?.pending || null;
  const canReview = pending && APPROVER_ROLES.includes(user?.role)
                    && pending.requested_by !== user?.id;
  const isMine    = pending && pending.requested_by === user?.id;

  return (
    <div className="space-y-6 max-w-xl">
      <h1>{t('tickets.config_title')}</h1>

      {/* ── Current value ─────────────────────────────────────── */}
      <div className="card space-y-1">
        <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">
          {t('tickets.config_current_label')}
        </p>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-teal-700 dark:text-teal-300">
            {parseFloat(config?.facial_value).toFixed(2)}
          </span>
          <span className="text-gray-500 dark:text-gray-400 text-sm">{config?.currency}</span>
          <span className="text-gray-400 text-xs">/ {t('tickets.ticket')}</span>
        </div>
        <p className="text-xs text-gray-400">{t('tickets.config_value_note')}</p>
      </div>

      {/* ── Pending request ───────────────────────────────────── */}
      {pending && (
        <div className={`card border-2 space-y-3 ${
          isMine ? 'border-yellow-200 bg-yellow-50' : 'border-blue-200 bg-blue-50 dark:bg-blue-900/30'
        }`}>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              ⏳ {t('tickets.config_pending_title')}
            </p>
            <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-medium">
              {t('tickets.config_status_pending')}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-gray-400">{t('tickets.config_from')}</p>
              <p className="font-semibold">{parseFloat(pending.current_value).toFixed(2)} {config?.currency}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">{t('tickets.config_to')}</p>
              <p className="font-bold text-teal-700 dark:text-teal-300 text-lg">{parseFloat(pending.proposed_value).toFixed(2)} {config?.currency}</p>
            </div>
          </div>

          {pending.reason && (
            <p className="text-sm text-gray-600 dark:text-gray-300 italic bg-white/60 rounded-lg px-3 py-2">
              "{pending.reason}"
            </p>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('tickets.config_requested_by')} <span className="font-medium">
              {pending.requester_first_name} {pending.requester_last_name}
            </span>
          </p>

          {isMine && (
            <div className="bg-yellow-100 rounded-lg px-3 py-2 text-xs text-yellow-700">
              {t('tickets.config_awaiting_approval')}
            </div>
          )}

          {canReview && (
            <div className="space-y-2 pt-1">
              <input
                type="text"
                value={reviewNote}
                onChange={e => setReviewNote(e.target.value)}
                placeholder={t('tickets.config_review_note_placeholder')}
                className="input text-sm"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => handleReview(pending.id, 'reject')}
                  disabled={!!reviewing}
                  className="btn-secondary flex-1 text-sm"
                >
                  {reviewing === 'reject' ? t('common.loading') : `✗ ${t('tickets.config_reject')}`}
                </button>
                <button
                  onClick={() => handleReview(pending.id, 'approve')}
                  disabled={!!reviewing}
                  className="btn-primary flex-1 text-sm"
                >
                  {reviewing === 'approve' ? t('common.loading') : `✓ ${t('tickets.config_approve')}`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Propose new value ──────────────────────────────────── */}
      {!pending && (
        <>
          {!showPropose ? (
            <button
              onClick={() => setShowPropose(true)}
              className="btn-primary text-sm"
            >
              ✏️ {t('tickets.config_propose_btn')}
            </button>
          ) : (
            <div className="card space-y-4 border-teal-200">
              <h2 className="text-sm font-semibold">{t('tickets.config_propose_title')}</h2>
              <form onSubmit={handlePropose} className="space-y-3">
                <div className="flex gap-3 items-end">
                  <div className="flex-1">
                    <label className="label">{t('tickets.config_new_value')}</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={proposedValue}
                      onChange={e => setProposedValue(e.target.value)}
                      required
                      className="input"
                      placeholder={config?.facial_value}
                    />
                  </div>
                  <div className="pb-1 text-gray-400 text-sm">{config?.currency}</div>
                </div>
                <div>
                  <label className="label">
                    {t('tickets.config_reason')}
                    <span className="text-gray-400 font-normal ml-1">({t('common.optional')})</span>
                  </label>
                  <textarea
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    rows={2}
                    className="input"
                    placeholder={t('tickets.config_reason_placeholder')}
                  />
                </div>
                <p className="text-xs text-gray-400">{t('tickets.config_propose_hint')}</p>
                <div className="flex gap-3">
                  <button type="button" onClick={() => setShowPropose(false)} className="btn-secondary flex-1">
                    {t('common.cancel')}
                  </button>
                  <button type="submit" disabled={submitting} className="btn-primary flex-1">
                    {submitting ? t('common.loading') : t('tickets.config_submit')}
                  </button>
                </div>
              </form>
            </div>
          )}
        </>
      )}

      {/* ── History ───────────────────────────────────────────── */}
      {config?.history?.length > 0 && (
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('tickets.config_history')}</h2>
          <div className="space-y-2">
            {config.history.map(r => (
              <div key={r.id} className={`rounded-xl border px-3 py-2 text-xs flex items-center justify-between gap-3 ${
                r.status === 'approved'
                  ? 'bg-green-50 dark:bg-green-900/30 border-green-100 dark:border-green-800 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/30 border-red-100 dark:border-red-800 text-red-600'
              }`}>
                <div>
                  <span className="font-mono font-bold">
                    {parseFloat(r.current_value).toFixed(2)} → {parseFloat(r.proposed_value).toFixed(2)} {config.currency}
                  </span>
                  {r.review_note && <span className="ml-2 italic opacity-75">"{r.review_note}"</span>}
                </div>
                <div className="text-right shrink-0">
                  <p className="font-medium capitalize">{r.status === 'approved' ? '✓' : '✗'} {t(`tickets.config_status_${r.status}`)}</p>
                  <p className="opacity-60">{new Date(r.reviewed_at).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
