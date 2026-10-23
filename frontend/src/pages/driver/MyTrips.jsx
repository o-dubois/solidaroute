/**
 * Driver — My Trips  —  /driver/my-trips
 *
 * Shows all trips assigned to the currently logged-in driver, with filtering
 * by status.  Two display modes are used depending on the active filter:
 *
 *   - "upcoming" and "cancelled" → full TripCard components (important details visible)
 *   - "completed" and "all"      → compact TripRow components in a scrollable list
 *                                  (these views typically have many rows)
 *
 * Clicking any trip (card or row) expands an inline TripDetail panel below it.
 * Clicking the same trip again collapses the panel.
 *
 * Complete button:
 *   Shown on assigned trips whose departure_at has passed.
 *   Sets completion_source = 'driver' on the backend.
 *   Button hidden if departure is in the future (too early to complete).
 */
import { formatAmount, currencySymbol } from '../../utils/format';
import { useAppConfig } from '../../context/AppConfigContext';
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { tripService, reviewService } from '../../services/api';
import { LoadingPage, StatusBadge, PhoneDisplay, Pagination } from '../../components/common';
import { StarInput, StarDisplay } from '../../components/common/StarDisplay';
import toast from 'react-hot-toast';

const PAGE_SIZE = 20;

/**
 * Filter definitions for the tab bar.
 * key: null means "all statuses" (no ?status= param in URL).
 */
const FILTERS = [
  { key: 'upcoming',  labelKey: 'trips.filter_upcoming'  },
  { key: 'completed', labelKey: 'trips.filter_completed' },
  { key: 'cancelled', labelKey: 'trips.filter_cancelled' },
  { key: null,        labelKey: 'trips.filter_all'       },
];

/**
 * Format an ISO timestamp as a localized date+time string using the browser locale.
 * Returns an em-dash for null/undefined values.
 */
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Convert a duration in minutes to a human-readable string.
 * Examples: 45 → "45 min", 90 → "1h 30min", 60 → "1h"
 */
function formatDuration(min) {
  if (!min) return null;
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}min` : ''}`;
}

/**
 * For round trips, compute the full service duration breakdown:
 *   - outbound:  the one-way drive duration (from trip.duration_minutes)
 *   - waiting:   time spent at destination waiting (return_at − departure_at)
 *   - returnDur: same as outbound (same route in reverse)
 *   - total:     waiting + returnDur (total additional time after first drop-off)
 *
 * Returns null for one-way trips or when duration_minutes is absent.
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
 * Returns true if the driver is allowed to mark this trip as complete.
 * Business rule: departure_at must be in the past — the trip must have actually
 * started before the driver can record completion.
 */
function canComplete(trip) {
  return trip.status === 'assigned' && new Date(trip.departure_at) <= new Date();
}

/**
 * CompletionBadge — small colored pill indicating who completed the trip.
 * Possible sources:
 *   driver    — driver pressed the Complete button themselves
 *   safeguard — automated safeguard job completed the trip after a timeout
 *   operator  — an operator manually marked it complete from the admin panel
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
 * TripCard — full-detail card used for upcoming and cancelled trips.
 *
 * Props:
 *   trip       — trip object
 *   onClick    — expand/collapse handler
 *   onComplete — callback(tripId) to mark trip as completed
 *   completing — trip id currently being completed (to show spinner on that card)
 */
function TripCard({ trip, onClick, onComplete, completing }) {
  const { t, i18n } = useTranslation();
  // Determine whether the Complete button should appear on this card
  const eligible = canComplete(trip);
  return (
    <div className="card hover:shadow-md transition-shadow">
      {/* Clickable area covers most of the card; phone link has stopPropagation */}
      <button onClick={() => onClick(trip)} className="w-full text-left">
        {/* Top row: trip number + metadata + status badge */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400 min-w-0">
            <span className="font-mono font-bold text-white bg-gray-500 px-1.5 py-0.5 rounded flex-shrink-0">
              T-{trip.trip_number}
            </span>
            <span>📅 {formatDate(trip.departure_at)}</span>
            {trip.return_at && <span>🔄 {formatDate(trip.return_at)}</span>}
            <span>👥 {trip.passenger_count} {t('trips.passengers')}</span>
            {trip.distance_km && <span>🛣️ {trip.distance_km} km</span>}
            {trip.duration_minutes && (
              <span>⏱️ {formatDuration(trip.duration_minutes)}
                {trip.return_at && (() => {
                  const rt = calcRoundTripDuration(trip);
                  return rt ? ` · ${t('trips.duration_total_short', { total: formatDuration(rt.total) })}` : null;
                })()}
              </span>
            )}
            {trip.client_name && <span>🧑 {trip.client_name}</span>}
            {trip.client_phone && (
              <span onClick={e => e.stopPropagation()}>
                📞 <PhoneDisplay phone={trip.client_phone} />
              </span>
            )}
            {trip.estimated_cost && (
              <span>💰 {formatAmount(trip.estimated_cost, i18n.language)} {currencySymbol(trip.payment_currency ?? currency)}</span>
            )}
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

      {/* Client notes — amber background flags important information for the driver */}
      {trip.client_notes && (
        <div className="mt-2 bg-amber-50 dark:bg-amber-900/30 border border-amber-100 dark:border-amber-800 rounded-lg px-3 py-2">
          <p className="text-xs text-amber-700 dark:text-amber-300 font-medium mb-0.5">
            {t('trips.client_notes_label', { defaultValue: 'Note du client' })}
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-200">{trip.client_notes}</p>
        </div>
      )}

      {/* Complete button — only shown when departure has passed */}
      {eligible && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
          <button
            onClick={e => { e.stopPropagation(); onComplete(trip.id); }}
            disabled={completing === trip.id}
            className="btn-primary text-sm w-full"
          >
            {completing === trip.id
              ? <span className="flex items-center gap-2 justify-center">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  {t('trips.completing')}
                </span>
              : `✓ ${t('trips.complete_btn')}`
            }
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * TripRow — compact single-line row used in the completed/all views.
 * Clicking expands an inline TripDetail panel directly below this row.
 * The "›" chevron on the right is a visual affordance for the click action.
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
      </div>
      <div className="flex-shrink-0 text-right space-y-0.5">
        <p className="text-xs text-gray-400">{new Date(trip.departure_at).toLocaleDateString(undefined, {
          day: 'numeric', month: 'short', year: 'numeric'
        })}</p>
        {trip.return_at && (
          <p className="text-xs text-purple-500">🔄 {t('trips.round_trip')}</p>
        )}
        <StatusBadge status={trip.status} />
      </div>
      <span className="text-gray-300 text-sm flex-shrink-0">›</span>
    </button>
  );
}

/**
 * TripDetail — inline expandable panel that appears below a clicked trip.
 *
 * Shows all trip fields in a structured label+value layout.
 * Also includes the Complete button if the trip is eligible, allowing the
 * driver to complete directly from the detail panel without going back to the card.
 *
 * Props:
 *   trip       — the expanded trip object
 *   onClose    — callback to collapse this panel
 *   onComplete — callback(tripId) to mark complete
 *   completing — trip id currently being completed
 */
function ReviewPanel({ tripId }) {
  const { t } = useTranslation();
  const [myReview,   setMyReview]   = useState(undefined);
  const [rating,     setRating]     = useState(0);
  const [comment,    setComment]    = useState('');
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

  if (myReview === undefined) return null;

  return (
    <div className="mt-3 pt-3 border-t border-teal-100 dark:border-teal-800">
      {myReview ? (
        <div>
          <p className="text-xs text-teal-600 dark:text-teal-400 font-medium mb-1">⭐ {t('reviews.your_review')}</p>
          <StarDisplay rating={myReview.rating} />
          {myReview.comment && (
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-1 italic">"{myReview.comment}"</p>
          )}
          {myReview.status === 'pending' && (
            <p className="text-xs text-gray-400 mt-0.5">{t('reviews.status_pending')}</p>
          )}
        </div>
      ) : (
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

function TripDetail({ trip, onClose, onComplete, completing }) {
  const { t, i18n } = useTranslation();
  const eligible = canComplete(trip);
  return (
    <div className="card border-teal-200 border bg-teal-50 dark:bg-teal-900/30 mt-1 mx-3 mb-2">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-teal-800 dark:text-teal-200">
            {t('trips.trip_detail', { defaultValue: 'Détails du trajet' })}
          </h3>
          <span className="text-xs font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
            T-{trip.trip_number}
          </span>
          <Link
            to={`/messages/trip/${trip.id}`}
            className="flex items-center gap-1 text-xs font-medium text-white
                       bg-teal-600 hover:bg-teal-700 px-2.5 py-0.5 rounded-full
                       transition-colors"
          >
            💬 {t('messages.open_chat')}
          </Link>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl px-1">✕</button>
      </div>
      {/* Review panel — right below the header for visibility */}
      {trip.status === 'completed' && (
        <ReviewPanel tripId={trip.id} />
      )}
      <div className="space-y-2 text-sm">
        <Row icon="🟢" label={t('trips.confirm_pickup')}    value={trip.pickup_address} />
        <Row icon="🔴" label={t('trips.confirm_dropoff')}   value={trip.dropoff_address} />
        <Row icon="📅" label={t('trips.confirm_departure')} value={formatDate(trip.departure_at)} />
        {/* Return time — only rendered for round trips */}
        {trip.return_at && <Row icon="🔄" label={t('trips.confirm_return')} value={formatDate(trip.return_at)} />}
        <Row icon="👥" label={t('trips.confirm_passengers')}
          value={`${trip.passenger_count} ${t('trips.passengers')}`} />
        {trip.distance_km && <Row icon="🛣️" label={t('trips.distance')} value={`${trip.distance_km} km`} />}
        {trip.duration_minutes && (
          <Row icon="⏱️" label={t('trips.duration_outbound')} value={formatDuration(trip.duration_minutes)} />
        )}
        {/* Round-trip time breakdown — IIFE keeps the JSX tree clean */}
        {trip.return_at && trip.duration_minutes && (() => {
          const rt = calcRoundTripDuration(trip);
          if (!rt) return null;
          return (
            <>
              <Row icon="⏱️" label={t('trips.duration_return')} value={formatDuration(rt.returnDur)} />
              {/* Purple highlight box for total service time — most important figure */}
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
        {trip.estimated_cost && (
          <Row icon="💰" label={t('trips.estimated_cost')}
            value={`${formatAmount(trip.estimated_cost, i18n.language)} ${currencySymbol(trip.payment_currency ?? currency)}`} />
        )}
        {trip.client_name && <Row icon="🧑" label={t('trips.client_label')} value={trip.client_name} />}
        {trip.client_phone && <Row icon="📞" label={t('trips.client_phone')} value={
          <PhoneDisplay phone={trip.client_phone} />
        } />}
        {/* booked_by_name — the operator who created the trip on behalf of the client */}
        {trip.booked_by_name && (
          <Row icon="📋" label={t('trips.booked_by')} value={trip.booked_by_name} />
        )}
        {trip.client_notes && (
          <Row icon="💬"
            label={t('trips.client_notes_label', { defaultValue: 'Note du client' })}
            value={trip.client_notes} />
        )}
        {/* Completion source — explains how/who completed the trip */}
        {trip.completion_source && (
          <div className="flex items-start gap-2">
            <span className="flex-shrink-0 text-sm">🏁</span>
            <div>
              <p className="text-xs text-teal-600 dark:text-teal-400">{t('trips.completion_source')}</p>
              <CompletionBadge source={trip.completion_source} />
            </div>
          </div>
        )}
        <div className="pt-2 border-t border-teal-100 dark:border-teal-800">
          <StatusBadge status={trip.status} />
        </div>
      </div>

      {/* Complete button in detail panel — same action as the card button */}
      {eligible && (
        <div className="mt-3 pt-3 border-t border-teal-100 dark:border-teal-800">
          <button
            onClick={() => onComplete(trip.id)}
            disabled={completing === trip.id}
            className="btn-primary text-sm w-full"
          >
            {completing === trip.id
              ? t('trips.completing')
              : `✓ ${t('trips.complete_btn')}`
            }
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Row — reusable icon+label+value layout used inside TripDetail.
 * Keeps the detail panel's structure consistent without repeating markup.
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

/**
 * DriverMyTrips — main page component.
 *
 * State:
 *   trips      — list of trips returned by the current filter
 *   loading    — true while fetching
 *   selected   — the currently expanded trip object (null = none expanded)
 *   completing — id of the trip whose complete request is in-flight
 *
 * URL params:
 *   ?status=upcoming|completed|cancelled  — active filter (null = all)
 *
 * Layout decision:
 *   useCompact = true for completed/all views because these can have many rows
 *   and the full card layout would make the page too tall to navigate easily.
 */
export default function DriverMyTrips() {
  const { t } = useTranslation();
  const { currency } = useAppConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const [trips,      setTrips]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [selected,   setSelected]   = useState(null);
  const [completing, setCompleting] = useState(null);
  const [page,       setPage]       = useState(1);

  // Derive active filter from URL — null means "all"
  const activeStatus = searchParams.get('status') || null;
  // Compact layout for completed / all — these lists can be very long
  const useCompact   = activeStatus === 'completed' || activeStatus === 'cancelled' || activeStatus === null;

  /**
   * Fetch trips for the current status filter.
   * Resets the selected trip on each reload so a stale detail panel doesn't persist.
   * Wrapped in useCallback so useEffect's dependency array stays stable.
   */
  const load = useCallback(() => {
    setLoading(true);
    setSelected(null);
    setPage(1);
    tripService.myTrips({ status: activeStatus })
      .then(({ data }) => setTrips(data.trips || []))
      .catch(() => setTrips([]))
      .finally(() => setLoading(false));
  }, [activeStatus]);

  // Re-fetch whenever the filter changes
  useEffect(() => { load(); }, [load]);

  /** Update the URL query param to change the active filter tab. */
  function setFilter(status) {
    if (status) setSearchParams({ status });
    else setSearchParams({});
  }

  /**
   * Toggle the detail panel for the clicked trip.
   * Clicking the same trip again collapses the panel (returns to null).
   */
  function handleClick(trip) {
    setSelected(prev => prev?.id === trip.id ? null : trip);
  }

  /**
   * Mark a trip as completed by the driver.
   * On success: optimistically updates the trip status in local state to avoid
   * a full list reload — keeps the UI snappy and preserves scroll position.
   * Also updates the selected trip in case the detail panel is open.
   *
   * Error handling: 'TOO_EARLY' is a business-rule error (not a network error)
   * and must be surfaced with a specific message.
   */
  async function handleComplete(tripId) {
    setCompleting(tripId);
    try {
      await tripService.complete(tripId);
      toast.success(t('trips.completed_success'));
      // Update trip in local state without full reload
      setTrips(prev => prev.map(t =>
        t.id === tripId
          ? { ...t, status: 'completed', completion_source: 'driver' }
          : t
      ));
      // Also update the expanded detail panel if it's showing this trip
      setSelected(prev => prev?.id === tripId
        ? { ...prev, status: 'completed', completion_source: 'driver' }
        : prev
      );
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'TOO_EARLY') {
        toast.error(t('trips.complete_too_early'));
      }
    } finally {
      setCompleting(null);
    }
  }

  return (
    <div>
      <h1 className="mb-6">{t('trips.title')}</h1>

      {/* Redirect banner for pending — drivers find pending trips in AvailableTrips, not here */}
      {activeStatus === 'pending' && (
        <div className="card bg-blue-50 dark:bg-blue-900/30 border border-blue-200 mb-6 flex items-start gap-3">
          <span className="text-2xl flex-shrink-0">🗺️</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-blue-800 dark:text-blue-200 mb-1">
              {t('trips.pending_redirect_title')}
            </p>
            <p className="text-xs text-blue-600 dark:text-blue-400 mb-3">
              {t('trips.pending_redirect_msg')}
            </p>
            <Link
              to="/driver/available"
              className="inline-flex items-center gap-1.5 bg-teal-600 text-white
                         text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-teal-700 transition-colors">
              → {t('nav.available_trips')}
            </Link>
          </div>
        </div>
      )}

      {/* Filter bar — tab buttons for upcoming / completed / cancelled / all */}
      <div className="flex gap-2 mb-6 flex-wrap">
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

      {/* Content — spinner / empty state / compact list / full cards */}
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
                  <TripRow trip={trip} onClick={handleClick} />
                  {selected?.id === trip.id && (
                    <TripDetail trip={selected} onClose={() => setSelected(null)}
                      onComplete={handleComplete} completing={completing} />
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
                  <TripCard trip={trip} onClick={handleClick}
                    onComplete={handleComplete} completing={completing} />
                  {selected?.id === trip.id && (
                    <TripDetail trip={selected} onClose={() => setSelected(null)}
                      onComplete={handleComplete} completing={completing} />
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
