/**
 * All Trips — /admin/trips
 *
 * Admin view of every trip on the platform.
 * Same tab/card/row pattern as the driver My Trips page.
 * Filter is driven by ?status= URL param so dashboard tiles
 * can link directly to a pre-filtered view.
 *
 * Tabs: Pending | Upcoming | Completed | Cancelled | All
 * Search: filters by client name or driver name in real time.
 * Cancel: operators can cancel any pending or assigned trip.
 *
 * Accessible to: operator, superadmin
 */
import { formatAmount, currencySymbol } from '../../utils/format';
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { adminService, tripService } from '../../services/api';
import { LoadingPage, StatusBadge, Pagination } from '../../components/common';

/**
 * CancelCompletedModal
 *
 * Confirmation dialog shown before cancelling a completed mobility-ticket trip.
 * Warns the admin clearly that this will release the tickets and no payment
 * will be made to the driver for this trip.
 */
function CancelCompletedModal({ trip, onConfirm, onClose }) {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);

  function handleConfirm() {
    setCancelling(true);
    onConfirm().finally(() => setCancelling(false));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-base font-semibold text-red-700 dark:text-red-300">
            ⚠️ {t('admin.cancel_completed_title')}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono">
            T-{trip.trip_number}
          </p>
        </div>
        {/* Body */}
        <div className="px-6 py-4 space-y-3">
          <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
            {t('admin.cancel_completed_body')}
          </p>
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700 dark:text-red-300 space-y-1">
            <p>• {t('admin.cancel_completed_warn1')}</p>
            <p>• {t('admin.cancel_completed_warn2')}</p>
            <p>• {t('admin.cancel_completed_warn3')}</p>
          </div>
        </div>
        {/* Actions */}
        <div className="px-6 pb-6 flex gap-3">
          <button
            onClick={handleConfirm}
            disabled={cancelling}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold bg-red-600 text-white
                       hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {cancelling ? '…' : t('admin.cancel_completed_confirm')}
          </button>
          <button
            onClick={onClose}
            disabled={cancelling}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium border border-gray-300 dark:border-gray-600
                       text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
          >
            {t('common.go_back')}
          </button>
        </div>
      </div>
    </div>
  );
}

const PAGE_SIZE = 20;

/**
 * FILTERS — defines the tab strip shown above the trip list.
 * Each entry maps to a `status` query param value (null = show all trips).
 * The tab with key === activeStatus gets the active (teal) styling.
 */
const FILTERS = [
  { key: 'pending',   labelKey: 'trips.filter_pending'   },
  { key: 'assigned',  labelKey: 'trips.filter_upcoming'  },
  { key: 'completed', labelKey: 'trips.filter_completed' },
  { key: 'cancelled', labelKey: 'trips.filter_cancelled' },
  { key: null,        labelKey: 'trips.filter_all'       },
];

/**
 * formatDate — converts an ISO timestamp into a locale-formatted string
 * that includes weekday, date, and time. Returns '—' for falsy input.
 * Uses the browser's locale (undefined) for automatic regionalisation.
 *
 * @param {string} iso - ISO 8601 timestamp
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * formatDuration — converts a raw number of minutes into a human-readable
 * string such as "45 min" or "1h 30min". Returns null for falsy input
 * (so callers can use `{formatDuration(x) && <Row .../>}` conditionally).
 *
 * @param {number} min - duration in minutes
 * @returns {string|null}
 */
function formatDuration(min) {
  if (!min) return null;
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}min` : ''}`;
}

/**
 * calcRoundTripDuration — computes a breakdown of total volunteer service time
 * for round-trip journeys: outbound leg + waiting time at destination + return leg.
 *
 * This is important for volunteer drivers so they understand the full time
 * commitment when accepting a round-trip request.
 *
 * Returns null if the trip is one-way or if duration data is missing.
 *
 * @param {object} trip - trip record with return_at and duration_minutes fields
 * @returns {{ outbound, waiting, returnDur, total }|null}
 */
function calcRoundTripDuration(trip) {
  if (!trip.return_at || !trip.duration_minutes) return null;
  const outbound  = parseInt(trip.duration_minutes);
  const returnDur = outbound;
  const gapMin  = Math.round((new Date(trip.return_at) - new Date(trip.departure_at)) / 60000);
  const waiting = Math.max(0, gapMin - outbound);
  const total   = gapMin + returnDur;
  return { outbound, waiting, returnDur, total };
}

/**
 * CompletionBadge
 *
 * Small pill badge indicating who marked a trip as completed.
 * Three sources are possible:
 *   driver    — the volunteer driver confirmed completion themselves
 *   safeguard — the system auto-completed after the configured safeguard delay
 *               (used when drivers forget to mark trips done)
 *   operator  — an admin/operator manually marked the trip complete
 *
 * Returns null if no completion source is recorded (e.g. trip not yet complete).
 *
 * Props:
 *   source {string} — one of 'driver', 'safeguard', 'operator'
 */
function CompletionBadge({ source }) {
  const { t } = useTranslation();
  if (!source) return null;
  const styles = {
    driver:    'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300',
    safeguard: 'bg-orange-100 text-orange-700',
    operator:  'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
  };
  const labels = {
    driver:    t('trips.completion_driver'),
    safeguard: t('trips.completion_safeguard'),
    operator:  t('trips.completion_operator'),
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[source] || 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
      {labels[source] || source}
    </span>
  );
}

/**
 * Row
 *
 * Generic two-line detail row used inside TripDetail.
 * Renders an icon, a small teal label, and a bold value line.
 * Kept as a tiny component to avoid repetitive JSX in the detail panel.
 */
function Row({ icon, label, value }) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex-shrink-0 text-sm">{icon}</span>
      <div>
        <p className="text-xs text-teal-600 dark:text-teal-400">{label}</p>
        <p className="text-sm text-gray-800 dark:text-gray-100 font-medium leading-snug">{value}</p>
      </div>
    </div>
  );
}

// ── Cancel button — only for cancellable trips ─────────────────

/**
 * CancelButton
 *
 * Renders a red cancel button for trips that are still cancellable.
 * Only 'pending' and 'assigned' trips can be cancelled — completed and
 * cancelled trips return null (button is not rendered at all).
 *
 * Clicking the button opens a small confirmation modal that requires the
 * operator to enter a cancellation reason before confirming.  The reason
 * is mandatory on the backend (PATCH /api/trips/:id/cancel).
 *
 * stopPropagation() on the button click prevents the event from bubbling
 * to the card's onClick handler, which would open the detail panel.
 *
 * Props:
 *   trip        {object}   — the trip record
 *   onCancelled {function} — called with the trip ID after successful cancellation
 */
function CancelButton({ trip, onCancelled }) {
  const { t } = useTranslation();
  const [showModal, setShowModal]   = useState(false);
  const [reason, setReason]         = useState('');
  const [cancelling, setCancelling] = useState(false);

  // Only pending/assigned trips can be cancelled; hide the button for all others
  if (!['pending', 'assigned'].includes(trip.status)) return null;

  function openModal(e) {
    e.stopPropagation();
    setReason('');
    setShowModal(true);
  }

  function closeModal(e) {
    if (e) e.stopPropagation();
    setShowModal(false);
  }

  function handleConfirm(e) {
    e.stopPropagation();
    if (!reason.trim()) return;
    setCancelling(true);
    tripService.cancel(trip.id, { reason: reason.trim() })
      .then(() => {
        toast.success(t('trips.cancelled_success'));
        setShowModal(false);
        onCancelled(trip.id);
      })
      .catch((err) => {
        const msg = err.response?.data?.error || t('common.error');
        toast.error(msg);
      })
      .finally(() => setCancelling(false));
  }

  return (
    <>
      <button
        onClick={openModal}
        className="px-2 py-1 rounded text-xs border transition-colors
                   bg-red-50 dark:bg-red-900/30 text-red-600 border-red-200 hover:bg-red-100"
      >
        {t('trips.cancel_trip')}
      </button>

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={closeModal}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 w-full max-w-sm mx-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50 mb-1">
              {t('trips.cancel_trip')} — T-{trip.trip_number}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t('trips.cancel_reason_prompt', 'Please provide a reason for this cancellation.')}
            </p>
            <textarea
              autoFocus
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={t('trips.cancel_reason_placeholder', 'e.g. Client request, scheduling conflict…')}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2 text-sm resize-none
                         focus:outline-none focus:ring-2 focus:ring-red-400 mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={closeModal}
                disabled={cancelling}
                className="px-4 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-600
                           text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleConfirm}
                disabled={cancelling || !reason.trim()}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 text-white
                           hover:bg-red-700 disabled:opacity-50"
              >
                {cancelling ? '…' : t('trips.confirm_cancel', 'Confirm cancellation')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * TripCard
 *
 * Card-style trip summary used for 'pending' and 'assigned' tabs where
 * there are fewer results and richer visual detail is warranted.
 * Clicking the card body toggles the inline TripDetail panel.
 * The cancel button is rendered in a separate footer area below the card body
 * so it doesn't interfere with the card's onClick handler.
 *
 * Shows: client name, pickup/dropoff addresses, status badge, trip number,
 * one-way/round-trip indicator, departure (and return) time, passenger count,
 * distance, assigned driver name, and estimated cost.
 */
function TripCard({ trip, onClick, onCancelled }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="card hover:shadow-md transition-shadow">
      <button onClick={() => onClick(trip)} className="w-full text-left">
        {/* Rider name — prominent at the top */}
        {trip.client_name && (
          <p className="text-xs font-semibold text-teal-700 dark:text-teal-300 mb-2">
            🧑 {trip.client_name}
          </p>
        )}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2 mb-1.5">
              <span className="text-green-500 mt-0.5 flex-shrink-0 text-sm">●</span>
              <p className="text-sm text-gray-700 dark:text-gray-200 truncate">{trip.pickup_address}</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-red-500 mt-0.5 flex-shrink-0 text-sm">●</span>
              <p className="text-sm text-gray-700 dark:text-gray-200 truncate">{trip.dropoff_address}</p>
            </div>
          </div>
          <StatusBadge status={trip.status} />
        </div>
        <div className="mt-2 mb-1 flex items-center gap-2 flex-wrap">
          {/* Monospaced trip number badge for quick reference during phone support */}
          <span className="text-xs font-mono font-bold text-white bg-gray-500 px-1.5 py-0.5 rounded">
            T-{trip.trip_number}
          </span>
          {/* Round-trip indicator — purple for round-trip, blue for one-way */}
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
            trip.return_at
              ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200'
              : 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200'
          }`}>
            {trip.return_at ? `🔄 ${t('trips.round_trip')}` : `➡️ ${t('trips.one_way')}`}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span>📅 {formatDate(trip.departure_at)}</span>
          {trip.return_at && <span>↩️ {formatDate(trip.return_at)}</span>}
          <span>👥 {trip.passenger_count} {t('trips.passengers')}</span>
          {trip.distance_km && <span>🛣️ {trip.distance_km} km</span>}
          {trip.driver_name && <span>🚗 {trip.driver_name}</span>}
          {trip.estimated_cost && (
            <span>💰 {formatAmount(trip.estimated_cost, i18n.language)} {currencySymbol(trip.payment_currency ?? 'CAD')}</span>
          )}
        </div>
      </button>
      {/* Cancel button lives outside the clickable card body to prevent event conflicts */}
      {['pending', 'assigned'].includes(trip.status) && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 flex justify-end">
          <CancelButton trip={trip} onCancelled={onCancelled} />
        </div>
      )}
    </div>
  );
}

/**
 * TripRow
 *
 * Compact single-row trip summary used for the 'completed', 'cancelled',
 * and 'all' views where there can be many entries and density matters more
 * than detail. Clicking the row opens the inline TripDetail panel.
 *
 * Shows: pickup/dropoff (truncated), trip type badge, client/driver names,
 * departure date, and status badge.
 */
function TripRow({ trip, onClick }) {
  const { t } = useTranslation();
  return (
    <button onClick={() => onClick(trip)}
      className="w-full text-left flex items-center gap-3 px-3 py-2.5
                 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-green-500 text-xs flex-shrink-0">●</span>
          <p className="text-xs text-gray-700 dark:text-gray-200 truncate">{trip.pickup_address}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-red-500 text-xs flex-shrink-0">●</span>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{trip.dropoff_address}</p>
        </div>
        <div className="mt-1 flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full border ${
            trip.return_at
              ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200'
              : 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200'
          }`}>
            {trip.return_at ? `🔄 ${t('trips.round_trip')}` : `➡️ ${t('trips.one_way')}`}
          </span>
          {trip.client_name && <span className="text-xs text-gray-400">🧑 {trip.client_name}</span>}
          {trip.driver_name && <span className="text-xs text-gray-400">🚗 {trip.driver_name}</span>}
        </div>
      </div>
      <div className="flex-shrink-0 text-right">
        <p className="text-xs text-gray-400">{new Date(trip.departure_at).toLocaleDateString(undefined, {
          day: 'numeric', month: 'short', year: 'numeric'
        })}</p>
        <StatusBadge status={trip.status} />
      </div>
      {/* Chevron hint — indicates the row is clickable */}
      <span className="text-gray-300 text-sm flex-shrink-0">›</span>
    </button>
  );
}

/**
 * TripDetail
 *
 * Expanded detail panel rendered inline below a clicked card/row.
 * Shows all trip fields including duration breakdown for round trips,
 * who booked the trip, client notes, and the completion source badge.
 *
 * The round-trip duration breakdown (outbound + waiting + return = total)
 * is especially useful for volunteers planning their schedule.
 *
 * Props:
 *   trip        {object}   — the full trip record
 *   onClose     {function} — collapses the detail panel
 *   onCancelled {function} — propagated to CancelButton; updates list state
 */
function TripDetail({ trip, onClose, onCancelled, onCancelCompleted }) {
  const { t, i18n } = useTranslation();
  const [showCancelModal, setShowCancelModal] = useState(false);
  return (
    <div className="card border-teal-200 border bg-teal-50 dark:bg-teal-900/30 mt-1 mx-3 mb-2">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-teal-800 dark:text-teal-200">
            {t('trips.trip_detail')}
          </h3>
          <span className="text-xs font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
            T-{trip.trip_number}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl px-1">✕</button>
      </div>
      <div className="space-y-2 text-sm">
        <Row icon="🟢" label={t('trips.confirm_pickup')}    value={trip.pickup_address} />
        <Row icon="🔴" label={t('trips.confirm_dropoff')}   value={trip.dropoff_address} />
        <Row icon="📅" label={t('trips.confirm_departure')} value={formatDate(trip.departure_at)} />
        {trip.return_at && <Row icon="🔄" label={t('trips.confirm_return')} value={formatDate(trip.return_at)} />}
        <Row icon="👥" label={t('trips.confirm_passengers')}
          value={`${trip.passenger_count} ${t('trips.passengers')}`} />
        {trip.distance_km && <Row icon="🛣️" label={t('trips.distance')} value={`${trip.distance_km} km`} />}
        {trip.duration_minutes && (
          <Row icon="⏱️" label={t('trips.duration_outbound')} value={formatDuration(trip.duration_minutes)} />
        )}
        {/* Round-trip duration breakdown — only shown when both return_at and duration are set */}
        {trip.return_at && trip.duration_minutes && (() => {
          const rt = calcRoundTripDuration(trip);
          if (!rt) return null;
          return (
            <>
              <Row icon="⏱️" label={t('trips.duration_return')} value={formatDuration(rt.returnDur)} />
              {/* Summary box for total service time — helps volunteers understand commitment */}
              <div className="mt-1 bg-purple-50 dark:bg-purple-900/30 border border-purple-100 dark:border-purple-800 rounded-lg px-3 py-2">
                <p className="text-xs text-purple-500 font-medium mb-0.5">
                  🕐 {t('trips.duration_total_service')}
                </p>
                <p className="text-sm font-bold text-purple-800 dark:text-purple-200">{formatDuration(rt.total)}</p>
                <p className="text-xs text-purple-400 mt-0.5">
                  {t('trips.duration_breakdown', {
                    outbound: formatDuration(rt.outbound),
                    waiting:  formatDuration(rt.waiting),
                    ret:      formatDuration(rt.returnDur),
                  })}
                </p>
              </div>
            </>
          );
        })()}
        {trip.estimated_cost && trip.status !== 'cancelled' && (
          <Row icon="💰"
            label={
              trip.status === 'completed'
                ? t('trips.amount_charged')
                : trip.status === 'pending'
                  ? t('trips.estimated_cost')
                  : t('trips.amount_to_charge')
            }
            value={`${formatAmount(trip.estimated_cost, i18n.language)} ${currencySymbol(trip.payment_currency ?? 'CAD')}`} />
        )}
        {trip.client_name && <Row icon="🧑" label={t('trips.client_label')} value={trip.client_name} />}
        {/* Driver shows as "Pending" if the trip hasn't been accepted yet */}
        <Row icon="🚗" label={t('trips.driver_label')}
          value={trip.driver_name ?? <span className="text-gray-400 italic">{t('status.pending')}</span>} />
        {/* booked_by_name is set when an operator or admin created the trip on behalf of a client */}
        {trip.booked_by_name && (
          <Row icon="📋" label={t('trips.booked_by')} value={trip.booked_by_name} />
        )}
        {trip.client_notes && (
          <Row icon="💬" label={t('trips.notes_label')} value={trip.client_notes} />
        )}
        {/* Cancellation reason — highlighted in red when present */}
        {trip.cancellation_reason && (
          <div className="rounded-lg px-3 py-2 bg-red-50 dark:bg-red-900/30 border border-red-200">
            <p className="text-xs font-medium text-red-700 dark:text-red-300 mb-0.5">
              🚫 {t('trips.cancellation_reason', 'Cancellation reason')}
            </p>
            <p className="text-sm text-red-900">{trip.cancellation_reason}</p>
          </div>
        )}
        {/* Who completed the trip — driver, safeguard auto-completion, or operator override */}
        {trip.completion_source && (
          <div className="flex items-start gap-2">
            <span className="flex-shrink-0 text-sm">🏁</span>
            <div>
              <p className="text-xs text-teal-600 dark:text-teal-400">{t('trips.completion_source')}</p>
              <CompletionBadge source={trip.completion_source} />
            </div>
          </div>
        )}
        {/* Payment info block — shows payment status, amount, and reference for admins */}
        {trip.payment_status && (
          <div className={`rounded-lg px-3 py-2 border ${
            trip.payment_status === 'paid'       ? 'bg-green-50 dark:bg-green-900/30 border-green-100 dark:border-green-800' :
            trip.payment_status === 'authorized' ? 'bg-blue-50 dark:bg-blue-900/30  border-blue-100 dark:border-blue-800'  :
            trip.payment_status === 'failed'     ? 'bg-red-50 dark:bg-red-900/30   border-red-100 dark:border-red-800'   :
                                                   'bg-gray-50 dark:bg-gray-700/50  border-gray-100 dark:border-gray-700'
          }`}>
            <p className="text-xs font-medium mb-1">
              {trip.payment_method === 'mobility' ? '🎫' : trip.payment_method === 'manual' ? '💵' : '💳'}
              {' '}{trip.payment_method === 'mobility'
                ? t('payment.method_mobility')
                : trip.payment_method === 'manual'
                  ? t('payment.method_manual')
                  : t('payment.step_title')}
            </p>
            <p className="text-sm font-semibold">
              {trip.payment_status === 'paid'
               ? `✅ ${t('trips.amount_charged')} — ${formatAmount(trip.payment_amount, i18n.language)} ${currencySymbol(trip.payment_currency ?? 'CAD')}`
               : trip.payment_status === 'authorized'
               ? trip.payment_method === 'mobility'
                 ? `🎫 ${t('payment.mobility_reserved')} — ${formatAmount(trip.payment_amount, i18n.language)} ${currencySymbol(trip.payment_currency ?? 'CAD')}`
                 : `🔒 ${t('payment.card_on_file')} — ${formatAmount(trip.payment_amount, i18n.language)} ${currencySymbol(trip.payment_currency ?? 'CAD')}`
               : trip.payment_status === 'failed'
               ? `⚠️ ${t('payment.charge_failed', { defaultValue: 'Payment failed' })}`
               : trip.payment_status === 'pending'
               ? `⏳ ${t('status.pending')}`
               : trip.payment_status}
            </p>
            {trip.payment_method === 'manual' && trip.payment_reference && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {t('payment.reference_label')}: {trip.payment_reference}
              </p>
            )}
            {trip.payment_method === 'manual' && !trip.payment_reference && (
              <p className="text-xs text-gray-400 mt-0.5 italic">
                {t('payment.method_manual')}
              </p>
            )}
          </div>
        )}
        <div className="pt-2 border-t border-teal-100 dark:border-teal-800 flex items-center justify-between gap-2 flex-wrap">
          <StatusBadge status={trip.status} />
          <div className="flex gap-2">
            <CancelButton trip={trip} onCancelled={onCancelled} />
            {/* Cancel-completed button — only for mobility-ticket trips that are completed */}
            {trip.status === 'completed' && trip.payment_method === 'mobility' && (
              <button
                onClick={() => setShowCancelModal(true)}
                className="px-2 py-1 rounded text-xs border transition-colors
                           bg-red-50 dark:bg-red-900/30 text-red-600 border-red-200 hover:bg-red-100"
              >
                {t('admin.cancel_completed_btn')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Cancel-completed confirmation modal */}
      {showCancelModal && (
        <CancelCompletedModal
          trip={trip}
          onClose={() => setShowCancelModal(false)}
          onConfirm={() =>
            adminService.cancelCompleted(trip.id)
              .then(() => {
                toast.success(t('admin.cancel_completed_success'));
                setShowCancelModal(false);
                onCancelCompleted(trip.id);
              })
              .catch(() => { setShowCancelModal(false); })
          }
        />
      )}
    </div>
  );
}

/**
 * AllTrips
 *
 * Root component for the /admin/trips route.
 *
 * State:
 *   trips    — array of trip records fetched from adminService.trips()
 *   loading  — true while the initial (or tab-change) fetch is in flight
 *   selected — the currently expanded trip object (or null); toggling the
 *              same trip again collapses the detail panel
 *   search   — free-text search query filtering the displayed list
 *
 * URL param:
 *   ?status= — drives the active filter tab. Absent = show all trips.
 *              Dashboard widgets link here with a pre-set status so admins
 *              land directly on the relevant filtered view.
 *
 * Layout strategy:
 *   - 'pending' and 'assigned' tabs use the full TripCard layout (more visual
 *     real estate per trip, important when acting on these trips is likely).
 *   - 'completed', 'cancelled', and 'all' tabs use the compact TripRow layout
 *     (many more trips, density is more useful than detail at first glance).
 *   The `useCompact` flag encodes this decision.
 *
 * Data flow on cancel:
 *   handleCancelled() updates both the trips array and the selected trip
 *   in place so the status badge updates immediately without a full refetch.
 */
export default function AllTrips() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [trips,    setTrips]   = useState([]);
  const [loading,  setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [search,   setSearch]  = useState('');
  const [page,     setPage]    = useState(1);

  // Derive the active status from the URL param; null means "all trips"
  const activeStatus = searchParams.get('status') || null;
  // Use compact row layout for tabs that tend to have large result sets
  const useCompact   = activeStatus === 'completed' || activeStatus === 'cancelled' || activeStatus === null;

  /**
   * load — (re)fetches trips for the current status filter.
   * Wrapped in useCallback so it can be listed as the effect dependency
   * without causing an infinite loop.
   * Resets `selected` and `search` on each load to avoid stale UI state
   * when switching tabs.
   */
  const load = useCallback(() => {
    setLoading(true);
    setSelected(null);
    setSearch('');
    setPage(1);
    adminService.trips(activeStatus ? { status: activeStatus } : {})
      .then(({ data }) => setTrips(data.trips || []))
      .catch(() => setTrips([]))
      .finally(() => setLoading(false));
  }, [activeStatus]);

  // Re-fetch whenever the active status tab changes
  useEffect(() => { load(); }, [load]);

  /**
   * setFilter — updates the ?status= URL param, which triggers the load
   * effect above. Passing null removes the param entirely (show all trips).
   *
   * @param {string|null} status - the filter key to activate
   */
  function setFilter(status) {
    if (status) setSearchParams({ status });
    else setSearchParams({});
  }

  /**
   * handleClick — toggles the inline detail panel for a trip.
   * Clicking the same trip a second time collapses the panel.
   *
   * @param {object} trip - the trip that was clicked
   */
  function handleClick(trip) {
    setSelected(prev => prev?.id === trip.id ? null : trip);
  }

  /**
   * handleCancelled — optimistically updates the cancelled trip's status
   * in both the trips list and the expanded `selected` state, so the UI
   * updates immediately without waiting for a full refetch.
   *
   * @param {number} tripId - the ID of the trip that was just cancelled
   */
  function handleCancelled(tripId) {
    setTrips(prev => prev.map(t =>
      t.id === tripId ? { ...t, status: 'cancelled' } : t
    ));
    setSelected(prev => prev?.id === tripId ? { ...prev, status: 'cancelled' } : prev);
  }

  // Same optimistic update as handleCancelled — used for the cancel-completed action
  function handleCancelCompleted(tripId) {
    setTrips(prev => prev.map(t =>
      t.id === tripId ? { ...t, status: 'cancelled' } : t
    ));
    setSelected(prev => prev?.id === tripId ? { ...prev, status: 'cancelled' } : prev);
  }

  // Client-side text search — filters by client name or driver name.
  // Runs on the already-fetched `trips` array so no extra API calls are made.
  const filtered = trips.filter(trip => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    const client = (trip.client_name || '').toLowerCase();
    const driver = (trip.driver_name || '').toLowerCase();
    return client.includes(q) || driver.includes(q);
  });

  // Reset to page 1 whenever the search query changes
  useEffect(() => { setPage(1); setSelected(null); }, [search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1>{t('admin.trips_title')}</h1>
        {/* Live count reflects the currently filtered result set */}
        <span className="text-sm text-gray-400">{filtered.length} {t('trips.trips_count')}</span>
      </div>

      {/* Filter tabs — each maps to a ?status= URL param value */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {FILTERS.map(f => {
          const isActive = activeStatus === f.key;
          return (
            <button key={f.key ?? 'all'} onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                isActive ? 'bg-teal-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200'
              }`}>
              {t(f.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Search bar — client-side filter on client or driver name */}
      <div className="mb-6">
        <input
          type="text"
          className="input w-full max-w-sm"
          placeholder={t('admin.trips_search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoComplete="off"
        />
      </div>

      {loading ? (
        <LoadingPage />
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">🗺️</div>
          <p className="text-sm">{t('trips.no_trips_filter')}</p>
        </div>
      ) : useCompact ? (
        <>
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            {paginated.map(trip => (
              <div key={trip.id}>
                <TripRow trip={trip} onClick={handleClick} />
                {selected?.id === trip.id && (
                  <TripDetail trip={selected} onClose={() => setSelected(null)}
                    onCancelled={handleCancelled} onCancelCompleted={handleCancelCompleted} />
                )}
              </div>
            ))}
          </div>
          <Pagination page={page} pages={totalPages} onChange={p => { setPage(p); setSelected(null); }} />
          <p className="text-xs text-gray-400 mt-2 text-center">
            {filtered.length} {t('trips.trips_count')}
          </p>
        </>
      ) : (
        <>
          <div className="space-y-3">
            {paginated.map(trip => (
              <div key={trip.id}>
                <TripCard trip={trip} onClick={handleClick} onCancelled={handleCancelled} />
                {selected?.id === trip.id && (
                  <TripDetail trip={selected} onClose={() => setSelected(null)}
                    onCancelled={handleCancelled} onCancelCompleted={handleCancelCompleted} />
                )}
              </div>
            ))}
          </div>
          <Pagination page={page} pages={totalPages} onChange={p => { setPage(p); setSelected(null); }} />
          <p className="text-xs text-gray-400 mt-2 text-center">
            {filtered.length} {t('trips.trips_count')}
          </p>
        </>
      )}
    </div>
  );
}
