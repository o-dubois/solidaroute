/**
 * @file MyTrips.jsx
 * @description Client-facing trip history page for SolidaRoute.
 *
 * Displays all trips belonging to the authenticated client, grouped/filtered
 * by status. Arriving here with a `?status=` query param (e.g. from a
 * dashboard tile) pre-selects the matching filter tab.
 *
 * Display strategy:
 *   - "pending" and "upcoming" — full cards (TripCard), because few trips are
 *     expected and each card benefits from more context (addresses, driver, etc.)
 *   - "cancelled" — also full cards for the same reason.
 *   - "completed" and "all" (null) — compact rows (TripRow) inside a
 *     scrollable panel, because these lists can grow large over time and the
 *     full-card layout would be unwieldy.
 *
 * Interaction model:
 *   Clicking any TripCard or TripRow toggles an inline TripDetail panel
 *   directly below it. Clicking the same item again (or the ✕ button)
 *   collapses the panel. Only one detail panel is open at a time.
 *
 * "upcoming" is a virtual filter — it is resolved server-side as
 *   status IN ('pending', 'assigned') AND departure_at > NOW().
 *   The frontend just passes `status: 'upcoming'` to the API.
 *
 * Cancellation is intentionally NOT implemented in this component; clients
 * cancel through other means (contact coordinator). The CTA at the top links
 * to NewTrip so clients can book additional rides directly from this page.
 */
import { formatAmount, currencySymbol } from '../../utils/format';
import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { tripService, reviewService } from '../../services/api';
import { LoadingPage, StatusBadge, PhoneDisplay, Pagination } from '../../components/common';
import { StarInput, StarDisplay } from '../../components/common/StarDisplay';
import toast from 'react-hot-toast';

const PAGE_SIZE = 20;

/**
 * FILTERS — ordered list of status filter tabs shown in the filter bar.
 *
 * `key: null` represents "all" (no status filter). It is passed as-is to the
 * API which interprets a missing/null status as "return everything".
 * The order here determines left-to-right tab order in the UI.
 */
const FILTERS = [
  { key: 'pending',   labelKey: 'trips.filter_pending'   },
  { key: 'upcoming',  labelKey: 'trips.filter_upcoming'  },
  { key: 'completed', labelKey: 'trips.filter_completed' },
  { key: 'cancelled', labelKey: 'trips.filter_cancelled' },
  { key: null,        labelKey: 'trips.filter_all'       },
];

/**
 * COMPACT_FILTERS — status keys that trigger the compact scrollable view.
 * Defined as a constant (rather than inline) to make the intent explicit
 * and easy to update if display preferences change in the future.
 * `null` = the "all" filter.
 */
const COMPACT_FILTERS = ['completed', 'cancelled', null];

/**
 * formatDuration — converts a duration in minutes to a human-readable string.
 * Returns null (not '—') when min is falsy so callers can conditionally render.
 * Examples: 45 → "45 min", 90 → "1h30min", 120 → "2h"
 *
 * @param {number|null} min — duration in minutes
 * @returns {string|null}
 */
function formatDuration(min) {
  if (!min) return null;
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}min` : ''}`;
}

/**
 * calcRoundTripDuration — computes a breakdown of durations for a round trip.
 *
 * For a round trip we know:
 *   - outbound drive time = duration_minutes (stored on the trip)
 *   - waiting time at destination = gap between departure_at and return_at
 *     minus the outbound drive (approximation: we assume equal drive time both ways)
 *   - return drive time = same as outbound (symmetric assumption)
 *   - total time door-to-door = waiting + outbound + return
 *
 * Returns null when the required fields are absent (one-way trip, or data not yet loaded).
 *
 * @param {object} trip — trip object from the API
 * @returns {{ outbound: number, waiting: number, returnDur: number, total: number }|null}
 */
function calcRoundTripDuration(trip) {
  if (!trip.return_at || !trip.duration_minutes) return null;
  const outbound  = parseInt(trip.duration_minutes);
  const returnDur = outbound; // symmetric route assumption
  const gapMin  = Math.round((new Date(trip.return_at) - new Date(trip.departure_at)) / 60000);
  const waiting = Math.max(0, gapMin - outbound); // gap minus outbound drive
  const total   = gapMin + returnDur;             // gap + return drive
  return { outbound, waiting, returnDur, total };
}

/**
 * formatDate — formats an ISO datetime string as a locale-aware, full
 * human-readable string including weekday, date, and time.
 * Returns '—' for null/undefined to avoid empty cells in the detail panel.
 *
 * @param {string|null} iso — ISO 8601 datetime string
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
 * TripCard — full-size card component used for "pending", "upcoming", and "cancelled" trips.
 *
 * Renders as a clickable button (rather than a div) so it is keyboard-accessible
 * and screen-reader-friendly out of the box. The `hover:scale-[1.01]` gives a
 * subtle lift effect on hover to reinforce interactivity.
 *
 * Props:
 *   trip    — trip object from the API
 *   onClick — callback invoked with the trip object when the card is clicked;
 *             the parent uses this to toggle the inline detail panel
 */
function TripCard({ trip, onClick }) {
  const { t } = useTranslation();
  return (
    <button onClick={() => onClick(trip)}
      className="w-full text-left card hover:shadow-md transition-all hover:scale-[1.01] cursor-pointer">
      {/* Top row: trip number + metadata + status badge */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400 min-w-0">
          <span className="font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded flex-shrink-0">
            T-{trip.trip_number}
          </span>
          <span>📅 {formatDate(trip.departure_at)}</span>
          {trip.return_at && <span>🔄 {formatDate(trip.return_at)}</span>}
          <span>👥 {trip.passenger_count} {t('trips.passengers')}</span>
          {trip.distance_km && <span>📍 {trip.distance_km} km</span>}
          {trip.driver_name && <span>🚗 {trip.driver_name}</span>}
        </div>
        <StatusBadge status={trip.status} />
      </div>
      {/* Pickup address */}
      <div className="flex items-start gap-2 mb-1.5">
        <span className="text-green-500 mt-0.5 flex-shrink-0 text-sm">●</span>
        <p className="text-sm text-gray-700 dark:text-gray-200 truncate">{trip.pickup_address}</p>
      </div>
      {/* Dropoff address */}
      <div className="flex items-start gap-2">
        <span className="text-red-500 mt-0.5 flex-shrink-0 text-sm">●</span>
        <p className="text-sm text-gray-700 dark:text-gray-200 truncate">{trip.dropoff_address}</p>
      </div>
    </button>
  );
}

/**
 * TripRow — compact single-line row used inside the scrollable panel for
 * "completed" and "all" views.
 *
 * Designed to show the minimum useful information in a tight horizontal
 * layout so many trips can be scanned at once. A chevron (›) on the right
 * signals that clicking opens more detail.
 *
 * The round-trip/one-way badge uses different color schemes to let users
 * visually distinguish trip types at a glance without reading the label.
 *
 * Props: same as TripCard — trip object and onClick callback.
 */
function TripRow({ trip, onClick }) {
  const { t } = useTranslation();
  return (
    <button onClick={() => onClick(trip)}
      className="w-full text-left flex items-center gap-3 px-3 py-2.5
                 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div className="flex-1 min-w-0">
        {/* Pickup line — trip number badge inline for easy cross-referencing */}
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-green-500 text-xs flex-shrink-0">●</span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-mono font-bold text-white bg-gray-500 px-1.5 py-0.5 rounded flex-shrink-0">
              T-{trip.trip_number}
            </span>
            <p className="text-xs text-gray-700 dark:text-gray-200 truncate">{trip.pickup_address}</p>
          </div>
        </div>
        {/* Dropoff line */}
        <div className="flex items-center gap-2">
          <span className="text-red-500 text-xs flex-shrink-0">●</span>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{trip.dropoff_address}</p>
        </div>
      </div>
      {/* Right column: date, round-trip indicator, status badge */}
      <div className="flex-shrink-0 text-right space-y-0.5">
        <p className="text-xs text-gray-400">{new Date(trip.departure_at).toLocaleDateString(undefined, {
          day: 'numeric', month: 'short', year: 'numeric'
        })}</p>
        {trip.return_at && (
          <p className="text-xs text-purple-500">🔄 {t('trips.round_trip')}</p>
        )}
        <StatusBadge status={trip.status} />
      </div>
      {/* Chevron — purely decorative affordance indicating the row is expandable */}
      <span className="text-gray-300 text-sm flex-shrink-0">›</span>
    </button>
  );
}

/**
 * TripDetail — inline detail panel that expands below a card or row when clicked.
 *
 * Renders a teal-tinted card containing all trip fields. Conditionally shows:
 *   - Return trip timing (only if trip has a return leg)
 *   - Duration breakdown (outbound and return separately for round trips)
 *   - Estimated cost (if available — some legacy trips may lack this)
 *   - Driver name (always when assigned)
 *   - Driver phone (only when status is 'assigned' — avoids showing stale contact info)
 *   - Vehicle info block (only for assigned trips with vehicle data)
 *   - Client notes (only when notes were recorded)
 *   - "Booked by" (when a coordinator booked on behalf of the client)
 *
 * Returns null immediately when `trip` is null so the parent can render it
 * unconditionally without a guard.
 *
 * Props:
 *   trip    — currently selected trip object
 *   onClose — callback to clear the selection (collapses the panel)
 */
function ReviewPanel({ tripId }) {
  const { t } = useTranslation();
  const [myReview, setMyReview] = useState(undefined); // undefined = loading
  const [rating,   setRating]   = useState(0);
  const [comment,  setComment]  = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    reviewService.forTrip(tripId)
      .then(({ data }) => setMyReview(data.my_review || null))
      .catch(() => setMyReview(null));
  }, [tripId]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!rating) return;
    setSubmitting(true);
    try {
      const { data } = await reviewService.submit({ trip_id: tripId, rating, comment: comment.trim() || null });
      setMyReview(data.review);
      toast.success(t('reviews.submitted'));
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'ALREADY_REVIEWED') toast.error(t('reviews.already_reviewed'));
      else if (code === 'COMMENT_TOO_LONG') toast.error(t('reviews.comment_too_long'));
      else toast.error(t('common.error'));
    } finally {
      setSubmitting(false);
    }
  }

  if (myReview === undefined) return null; // still loading

  return (
    <div className="mt-3 pt-3 border-t border-teal-100 dark:border-teal-800">
      {myReview ? (
        // Already reviewed — show what they submitted
        <div>
          <p className="text-xs text-teal-600 dark:text-teal-400 font-medium mb-1">⭐ {t('reviews.your_review')}</p>
          <StarDisplay rating={myReview.rating} />
          {myReview.comment && (
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-1 italic">"{myReview.comment}"</p>
          )}
          <p className="text-xs text-gray-400 mt-0.5">
            {myReview.status === 'pending' ? t('reviews.status_pending') : ''}
          </p>
        </div>
      ) : (
        // Review form
        <form onSubmit={handleSubmit} className="space-y-2">
          <p className="text-xs text-teal-600 dark:text-teal-400 font-medium">{t('reviews.leave_review')}</p>
          <StarInput value={rating} onChange={setRating} disabled={submitting} />
          <div className="relative">
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              maxLength={100}
              rows={2}
              placeholder={t('reviews.comment_placeholder')}
              className="input resize-none text-xs w-full pr-12"
              disabled={submitting}
            />
            <span className={`absolute bottom-2 right-2 text-xs ${
              comment.length > 80 ? 'text-amber-500' : 'text-gray-300'
            }`}>
              {100 - comment.length}
            </span>
          </div>
          <button
            type="submit"
            disabled={!rating || submitting}
            className="btn-primary text-xs px-4 py-1.5 disabled:opacity-50">
            {submitting ? t('common.loading') : t('reviews.submit_btn')}
          </button>
        </form>
      )}
    </div>
  );
}

function TripDetail({ trip, onClose, onRebook }) {
  const { t, i18n } = useTranslation();
  if (!trip) return null;
  return (
    <div className="card border-teal-200 border bg-teal-50 dark:bg-teal-900/30 mt-2">
      {/* Panel header: title, trip number badge, chat button, and close button */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-teal-800 dark:text-teal-200">
            {t('trips.trip_detail', { defaultValue: 'Détails du trajet' })}
          </h3>
          <span className="text-xs font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
            T-{trip.trip_number}
          </span>
          {trip.driver_id && (
            <Link
              to={`/messages/trip/${trip.id}`}
              className="flex items-center gap-1 text-xs font-medium text-white
                         bg-teal-600 hover:bg-teal-700 px-2.5 py-0.5 rounded-full
                         transition-colors"
            >
              💬 {t('messages.open_chat')}
            </Link>
          )}
        </div>
        <button onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-xl px-1">✕</button>
      </div>
      {/* Review panel — right below the header for visibility */}
      {trip.status === 'completed' && trip.driver_id && (
        <ReviewPanel tripId={trip.id} />
      )}
      <div className="space-y-3 text-sm">
        {/* Core route and timing */}
        <DetailRow icon="🟢" label={t('trips.confirm_pickup')}   value={trip.pickup_address} />
        <DetailRow icon="🔴" label={t('trips.confirm_dropoff')}  value={trip.dropoff_address} />
        <DetailRow icon="📅" label={t('trips.confirm_departure')} value={formatDate(trip.departure_at)} />
        {/* Return row — only rendered for round trips */}
        {trip.return_at && (
          <DetailRow icon="🔄" label={t('trips.confirm_return')} value={formatDate(trip.return_at)} />
        )}
        <DetailRow icon="👥" label={t('trips.confirm_passengers')}
          value={`${trip.passenger_count} ${t('trips.passengers')}`} />
        {/* Trip type badge — distinct colors for one-way vs round trip */}
        <div className="mb-2">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
            trip.return_at
              ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200'
              : 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200'
          }`}>
            {trip.return_at ? `🔄 ${t('trips.round_trip')}` : `➡️ ${t('trips.one_way')}`}
          </span>
        </div>
        {/* Distance and outbound duration — only if populated (routing may have failed) */}
        {trip.distance_km && (
          <DetailRow icon="🛣️" label={t('trips.distance')}
            value={`${trip.distance_km} km`} />
        )}
        {trip.duration_minutes && (
          <DetailRow icon="⏱️" label={t('trips.duration_outbound')}
            value={formatDuration(trip.duration_minutes)} />
        )}
        {/* Return-leg duration — uses an IIFE to call calcRoundTripDuration and
            conditionally render without a named variable polluting the JSX scope */}
        {trip.return_at && trip.duration_minutes && (() => {
          const rt = calcRoundTripDuration(trip);
          if (!rt) return null;
          return (
            <DetailRow icon="⏱️" label={t('trips.duration_return')}
              value={formatDuration(rt.returnDur)} />
          );
        })()}
        {/* Financial info — label changes based on trip status:
            - pending: "Estimated cost" (quote only, not yet charged)
            - assigned/in_progress: "Amount to be charged" (card saved, charge pending)
            - completed: "Amount charged" (money already taken)
            - cancelled: omit (no charge applies) */}
        {trip.estimated_cost && trip.status !== 'cancelled' && (
          <DetailRow icon="💰"
            label={
              trip.status === 'completed'
                ? t('trips.amount_charged')
                : trip.status === 'pending'
                  ? t('trips.estimated_cost')
                  : t('trips.amount_to_charge')
            }
            value={`${formatAmount(trip.estimated_cost, i18n.language)} ${currencySymbol(trip.payment_currency ?? 'CAD')}`} />
        )}
        {/* Driver info — name is always shown if assigned; phone only when currently assigned
            (hiding it for completed/cancelled trips avoids confusing drivers with old contact requests) */}
        {trip.driver_name && (
          <DetailRow icon="🚗" label={t('trips.driver_label')} value={trip.driver_name} />
        )}
        {/* "Booked by" — shown when the trip was created by a coordinator on the client's behalf */}
        {trip.booked_by_name && (
          <DetailRow icon="📋" label={t('trips.booked_by')} value={trip.booked_by_name} />
        )}
        {/* Driver phone — only shown for active (assigned) trips so the client can call their driver */}
        {trip.driver_phone && trip.status === 'assigned' && (
          <DetailRow icon="📞" label={t('trips.driver_phone')} value={
            <PhoneDisplay phone={trip.driver_phone} />
          } />
        )}
        {/* Vehicle info block — only shown for assigned trips with at least a vehicle make on record.
            The blue highlight differentiates it visually from the plain DetailRow entries above. */}
        {trip.status === 'assigned' && trip.driver_vehicle_make && (
          <div className="mt-1 bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 rounded-lg px-3 py-2">
            <p className="text-xs text-blue-500 font-medium mb-1">🚘 {t('trips.vehicle_info')}</p>
            {/* Concatenate all vehicle descriptor fields that exist, filtering out nulls */}
            <p className="text-sm font-semibold text-blue-900">
              {[trip.driver_vehicle_color, trip.driver_vehicle_make, trip.driver_vehicle_model, trip.driver_vehicle_year]
                .filter(Boolean).join(' ')}
            </p>
            {/* License plate — mono font with wider tracking for readability */}
            {trip.driver_license_plate && (
              <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5 font-mono tracking-wider">
                🪪 {trip.driver_license_plate}
              </p>
            )}
          </div>
        )}
        {/* Client notes — shown when the client or coordinator recorded a note at booking time */}
        {trip.client_notes && (
          <DetailRow icon="💬"
            label={t('trips.client_notes_label', { defaultValue: 'Note' })}
            value={trip.client_notes} />
        )}
        {/* Payment info — shown when a payment row exists for this trip */}
        {trip.payment_status && (
          <div className={`mt-1 rounded-lg px-3 py-2 border ${
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
               : trip.payment_status}
            </p>
            {trip.payment_method === 'manual' && trip.payment_reference && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {t('payment.reference_label')}: {trip.payment_reference}
              </p>
            )}
          </div>
        )}
        {/* Status badge at the bottom of the panel as a clear summary of where the trip stands */}
        <div className="pt-2 border-t border-teal-100 dark:border-teal-800 flex items-center justify-between flex-wrap gap-2">
          <StatusBadge status={trip.status} />
          {onRebook && (
            <button
              onClick={() => onRebook(trip)}
              className="flex items-center gap-1.5 text-xs font-medium text-teal-700 dark:text-teal-300
                         bg-teal-50 dark:bg-teal-900/30 hover:bg-teal-100 border border-teal-200 px-3 py-1.5
                         rounded-lg transition-colors"
            >
              📋 {t('trips.book_again')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * DetailRow — atomic label/value row used inside TripDetail.
 *
 * Keeps the detail panel layout consistent: icon on the left, then a small
 * grey label above the bolder value. The icon is flex-shrink-0 to prevent
 * it collapsing when value text is very long.
 *
 * Props:
 *   icon  — emoji or character used as a visual anchor
 *   label — small grey descriptive label (e.g. "Departure")
 *   value — the actual data value; can be a string or a React node (e.g. PhoneDisplay)
 */
function DetailRow({ icon, label, value }) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex-shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-teal-600 dark:text-teal-400">{label}</p>
        <p className="text-sm text-gray-800 dark:text-gray-100 font-medium leading-snug">{value}</p>
      </div>
    </div>
  );
}

/**
 * MyTrips — main page component for the client's trip history.
 *
 * State:
 *   trips    — array of trip objects fetched from the API for the active filter
 *   loading  — true while the API request is in-flight (shows LoadingPage spinner)
 *   selected — the trip currently expanded in a detail panel, or null if none
 *
 * URL state (via React Router useSearchParams):
 *   ?status=  — the currently active filter key; absent means "all" (null)
 *   Stored in the URL so the browser back button and direct links work correctly,
 *   and so the dashboard's "View all" tile links can pre-select a tab.
 *
 * Layout decisions:
 *   useCompact — derived from activeStatus; true for 'completed' and null ('all').
 *   When true, trips render as compact rows inside a fixed-height scrollable panel
 *   (max-h-[480px]) to avoid infinitely long pages for clients with many trips.
 *   When false, trips render as full cards with more whitespace and detail.
 */
export default function MyTrips() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // searchParams drives the active filter tab; setSearchParams updates the URL
  const [searchParams, setSearchParams] = useSearchParams();
  const [trips,    setTrips]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState(null);
  const [page,     setPage]     = useState(1);

  // Derive the active filter from the URL param.
  // `null` is the "all trips" state — no status filter is applied.
  const activeStatus = searchParams.get('status') || null;

  // Use compact scrollable rows for filters that may return many results.
  // Full cards for pending/upcoming/cancelled where the list is typically short
  // and the extra detail (driver name, time, distance) is more immediately useful.
  const useCompact = COMPACT_FILTERS.includes(activeStatus);

  /**
   * load — fetches trips for the current filter from the API.
   *
   * Wrapped in useCallback so the identity is stable across renders and can be
   * used as a useEffect dependency without causing infinite re-fetch loops.
   * Resets `selected` to null on every load so stale detail panels close
   * automatically when the user switches filter tabs.
   */
  const load = useCallback(() => {
    setLoading(true);
    setSelected(null);
    setPage(1);
    tripService.myTrips({ status: activeStatus })
      .then(({ data }) => setTrips(data.trips || []))
      .catch(() => setTrips([]))   // on error, show empty state rather than crashing
      .finally(() => setLoading(false));
  }, [activeStatus]); // re-run whenever the active filter changes

  // Re-fetch whenever the active filter changes (including on first mount)
  useEffect(() => { load(); }, [load]);

  /**
   * setFilter — updates the `?status=` query param in the URL.
   * Passing null (the "all" filter) removes the param entirely rather than
   * setting it to the string "null", keeping URLs clean.
   */
  function setFilter(status) {
    if (status) setSearchParams({ status });
    else setSearchParams({});
  }

  /**
   * handleCardClick — toggles the detail panel for the clicked trip.
   * If the same trip is clicked again, the panel collapses (toggle behavior).
   * This avoids needing a separate close button on every card/row — the card
   * itself acts as the toggle.
   */
  function handleCardClick(trip) {
    setSelected(prev => prev?.id === trip.id ? null : trip);
  }

  /**
   * handleRebook — navigates to the booking wizard pre-filled with the selected
   * trip's pickup and dropoff addresses. All other fields start empty.
   */
  function handleRebook(trip) {
    navigate('/client/trips/new', {
      state: { pickup: trip.pickup_address, dropoff: trip.dropoff_address },
    });
  }


  return (
    <div>
      {/* Page header: title on the left, "New trip" CTA on the right */}
      <div className="flex items-center justify-between mb-6">
        <h1>{t('trips.title')}</h1>
        <Link to="/client/trips/new" className="btn-primary text-sm">
          + {t('dashboard.new_trip_cta')}
        </Link>
      </div>

      {/* Filter bar — one button per FILTERS entry.
          Active filter gets the teal highlight; others are neutral gray.
          `key={key ?? 'all'}` avoids using null as a React key. */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {FILTERS.map(f => {
          const key = f.key;
          const isActive = activeStatus === f.key;
          return (
            <button key={key ?? 'all'} onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                isActive ? 'bg-teal-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200'
              }`}>
              {t(f.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Three-way render: loading spinner → empty state → trip list */}
      {loading ? (
        <LoadingPage />
      ) : trips.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">🗺️</div>
          <p className="text-sm">{t('trips.no_trips_filter')}</p>
        </div>
      ) : (() => {
        const totalPages = Math.ceil(trips.length / PAGE_SIZE);
        const paginated  = trips.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        const paginationBar = (
          <>
            <Pagination page={page} pages={totalPages} onChange={p => { setPage(p); setSelected(null); }} />
            <p className="text-xs text-gray-400 mt-2 text-center">
              {trips.length} {t('trips.trips_count', { defaultValue: 'trajet(s)' })}
            </p>
          </>
        );
        return useCompact ? (
          <>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              {paginated.map(trip => (
                <div key={trip.id}>
                  <TripRow trip={trip} onClick={handleCardClick} />
                  {selected?.id === trip.id && (
                    <div className="px-3 pb-3">
                      <TripDetail trip={selected} onClose={() => setSelected(null)} onRebook={handleRebook} />
                    </div>
                  )}
                </div>
              ))}
            </div>
            {paginationBar}
          </>
        ) : (
          <>
            <div className="space-y-3">
              {paginated.map(trip => (
                <div key={trip.id}>
                  <TripCard trip={trip} onClick={handleCardClick} />
                  {selected?.id === trip.id && (
                    <TripDetail trip={selected} onClose={() => setSelected(null)} onRebook={handleRebook} />
                  )}
                </div>
              ))}
            </div>
            {paginationBar}
          </>
        );
      })()}
    </div>
  );
}
