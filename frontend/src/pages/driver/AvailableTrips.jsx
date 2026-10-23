/**
 * AvailableTrips — /driver/available
 *
 * Shows pending trips in EXCLUSIVE distance bands from the driver's home.
 *
 * Band logic (based on driver_suggestion_radius_km = base, default 10 km):
 *   Band 1: 0      → base      km  (e.g. "Moins de 10 km")
 *   Band 2: base   → base×2    km  (e.g. "Entre 10 et 20 km")
 *   Band 3: base×2 → base×3    km  (e.g. "Entre 20 et 30 km")
 *
 * Preferred trips are shown in a dedicated section ABOVE the band tabs —
 * they never appear inside the band lists to avoid showing the same trip twice.
 *
 * Guard conditions:
 *   - Driver must be approved (approval_status = 'approved')
 *   - Driver must be on duty (is_available = true)
 */
import { formatAmount, formatNumber, currencySymbol } from '../../utils/format';
import { useAppConfig } from '../../context/AppConfigContext';
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api, { tripService } from '../../services/api';
import { LoadingPage, PhoneDisplay } from '../../components/common';
import toast from 'react-hot-toast';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Format an ISO timestamp as a short HH:MM time string.
 * Always uses 24-hour fr-CA locale. Falls back to 'America/Toronto' if no tz provided.
 */
function formatTime(isoString, tz) {
  return new Date(isoString).toLocaleTimeString('fr-CA', {
    hour: '2-digit', minute: '2-digit', timeZone: tz || 'America/Toronto',
  });
}

/**
 * Format an ISO timestamp as "weekday, DD Month à HH:MM" in French.
 * Used to display departure and return times on trip cards.
 */
function formatDateTime(isoString, tz) {
  const d = new Date(isoString);
  return d.toLocaleDateString('fr-CA', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: tz || 'America/Toronto',
  }) + ' à ' + formatTime(isoString, tz);
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
 *   - waiting:   time the driver waits at destination (return_at − departure_at)
 *   - returnDur: assumed equal to outbound (same route, reversed)
 *   - total:     waiting + returnDur (total block of driver time after drop-off)
 *
 * Returns null if the trip is one-way or duration is missing.
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
 * Format the waiting window between drop-off and return pickup as "Xh YY" or "X min".
 * This is displayed on round-trip cards to help drivers plan their time.
 */
function waitingDuration(departureIso, returnIso) {
  const diff = Math.round((new Date(returnIso) - new Date(departureIso)) / 60000);
  if (diff < 60) return `${diff} min`;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// ── Trip card ─────────────────────────────────────────────────

/**
 * TripCard — displays all details for a single available trip
 * and provides Accept / Decline action buttons.
 *
 * Props:
 *   trip        — trip object from the API (includes driver_action if already actioned)
 *   onAccepted  — callback(tripId) called after a successful accept
 *   onDeclined  — callback(tripId) called after a successful decline
 *   isPreferred — true if this trip was matched to the driver as a preferred suggestion
 *   t, tz, locale — passed down from parent to avoid re-reading context on every card
 *
 * State:
 *   accepting / declining — request in-flight flags (disables buttons)
 *   actionDone            — true once an action has been recorded; locks both buttons
 *                           to prevent double-submission
 *   actionLabel           — badge shown after an action (e.g. "Accepted on Jan 5 at 10:00")
 */
function TripCard({ trip, onAccepted, onDeclined, isPreferred, t, tz, locale }) {
  const [accepting, setAccepting]   = useState(false);
  const [declining, setDeclining]   = useState(false);
  // actionDone locks both buttons after a successful action to prevent double-clicks
  const [actionDone, setActionDone] = useState(
    // Pre-lock if we already have a recorded action from a previous visit
    trip.driver_action != null
  );
  const [actionLabel, setActionLabel] = useState(
    // Pre-populate badge label if already actioned
    trip.driver_action
      ? buildActionLabel(trip.driver_action, trip.driver_action_is_preferred,
                        trip.driver_actioned_at, t, tz, locale)
      : null
  );
  // Feature B: schedule conflict soft-warning state
  // Set when the backend returns schedule_conflict_warning (409).
  // Cleared on cancel or after forced accept.
  const [conflictWarning, setConflictWarning] = useState(null);

  /**
   * Build the human-readable text for the "already actioned" badge.
   * The badge tells the driver when and in what capacity they acted on this trip
   * (preferred offer vs. broadcast), so they don't wonder why buttons are locked.
   */
  function buildActionLabel(action, isPref, actionedAt, t, tz, locale) {
    if (!action || !actionedAt) return null;
    const localeStr = locale === 'en' ? 'en-CA' : 'fr-CA';
    const date = new Date(actionedAt).toLocaleDateString(localeStr,
      { day: 'numeric', month: 'short', timeZone: tz });
    const time = new Date(actionedAt).toLocaleTimeString(localeStr,
      { hour: '2-digit', minute: '2-digit', timeZone: tz });
    // Role label tells the driver whether they saw this as a preferred or broadcast trip
    const role = isPref
      ? t('trips.action_role_preferred')
      : t('trips.action_role_broadcast');
    const key = action === 'accepted' ? 'trips.already_accepted_on' : 'trips.already_declined_on';
    return { action, text: t(key, { role, date, time }) };
  }

  // Derived flags used by the card UI
  const isRoundTrip = !!trip.return_at;
  // Disable both buttons while a request is in-flight OR after any action is recorded
  const buttonsDisabled = accepting || declining || actionDone;

  /**
   * Accept the trip — first attempt.
   *
   * The backend returns two distinct 409 shapes:
   *   schedule_conflict_warning — driver has an overlapping trip but MAY proceed.
   *     → sets conflictWarning state to show the inline amber panel (Feature B).
   *   anything else (trip already claimed) → toast error, no retry.
   *
   * On success: marks actionDone, calls onAccepted to remove the card from lists.
   */
  async function handleAccept() {
    if (!window.confirm(t('trips.accept_confirm'))) return;
    setAccepting(true);
    try {
      await tripService.accept(trip.id);
      toast.success(t('trips.accepted_success'));
      setActionDone(true);
      setActionLabel({
        action: 'accepted',
        text: buildActionLabel('accepted', isPreferred,
          new Date().toISOString(), t, tz, locale)?.text,
      });
      onAccepted(trip.id);
    } catch (err) {
      if (err.response?.status === 409) {
        const code = err.response?.data?.code || err.response?.data?.error;
        if (code === 'schedule_conflict_warning') {
          // Show inline warning panel — driver decides whether to proceed
          setConflictWarning({ conflict_numbers: err.response.data.conflict_numbers || '' });
        } else {
          toast.error(t('trips.accept_too_late'));
        }
      } else {
        toast.error(err.response?.data?.error || t('common.error'));
      }
    } finally {
      setAccepting(false);
    }
  }

  /**
   * Force-accept after the driver confirms the schedule overlap warning.
   * Sends force_conflict: true to bypass the conflict check server-side.
   */
  async function handleForceAccept() {
    setConflictWarning(null);
    setAccepting(true);
    try {
      await tripService.accept(trip.id, { force_conflict: true });
      toast.success(t('trips.accepted_success'));
      setActionDone(true);
      setActionLabel({
        action: 'accepted',
        text: buildActionLabel('accepted', isPreferred,
          new Date().toISOString(), t, tz, locale)?.text,
      });
      onAccepted(trip.id);
    } catch (err) {
      toast.error(err.response?.data?.error || t('common.error'));
    } finally {
      setAccepting(false);
    }
  }

  /**
   * Decline the trip.
   * On success: marks actionDone and calls onDeclined.
   * The trip card stays visible in the band list with the declined badge,
   * but is removed from the preferred section.
   */
  async function handleDecline() {
    if (!window.confirm(t('trips.decline_confirm'))) return;
    setDeclining(true);
    try {
      await tripService.decline(trip.id);
      toast.success(t('trips.declined_success'));
      setActionDone(true);
      setActionLabel({
        action: 'declined',
        text: buildActionLabel('declined', isPreferred,
          new Date().toISOString(), t, tz, locale)?.text,
      });
      onDeclined(trip.id);
    } catch (err) {
      toast.error(err.response?.data?.error || t('common.error'));
    } finally {
      setDeclining(false);
    }
  }

  return (
    <div className="card border border-gray-200 dark:border-gray-700 hover:border-teal-200 hover:shadow-md transition-all">

      {/* ── Trip number — always visible at top ────────────── */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
          T-{trip.trip_number}
        </span>
        {/* Star badge only shown for preferred trips (operator-matched to this driver) */}
        {isPreferred && (
          <span className="text-xs font-semibold text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-900/30 border border-teal-200 px-2 py-0.5 rounded">
            ⭐ {t('trips.preferred_badge')}
          </span>
        )}
      </div>

      {/* ── Top badges row ────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {/* Distance from driver's home address — helps driver decide quickly */}
        <span className="text-xs font-semibold text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-900/30 border border-teal-200 px-2 py-0.5 rounded-full">
          🏠 {trip.distance_from_home_km} km
        </span>
        {/* Round-trip badge — important: driver must wait and drive back */}
        {isRoundTrip && (
          <span className="text-xs font-semibold text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/30 border border-purple-200 px-2 py-0.5 rounded-full">
            🔄 {t('trips.round_trip_badge')}
          </span>
        )}
        {/* Show passenger count only when more than 1 to flag capacity requirements */}
        {trip.passenger_count > 1 && (
          <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
            👥 {trip.passenger_count} {t('trips.passengers_label')}
          </span>
        )}
        {/* Estimated earnings — right-aligned for quick visual scanning */}
        {trip.estimated_cost && (
          <span className="ml-auto text-sm font-bold text-teal-700 dark:text-teal-300">
            {formatAmount(trip.estimated_cost, locale)} {currencySymbol(currency)}
          </span>
        )}
      </div>

      {/* ── Addresses ─────────────────────────────────────── */}
      <div className="space-y-2 mb-3">
        <div className="flex items-start gap-2">
          <span className="text-green-500 text-sm mt-0.5 flex-shrink-0">▲</span>
          <div className="min-w-0">
            <p className="text-xs text-gray-400">{t('trips.pickup_label')}</p>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{trip.pickup_address}</p>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-red-400 text-sm mt-0.5 flex-shrink-0">▼</span>
          <div className="min-w-0">
            <p className="text-xs text-gray-400">{t('trips.dropoff_label')}</p>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{trip.dropoff_address}</p>
          </div>
        </div>
      </div>

      {/* ── Schedule ──────────────────────────────────────── */}
      {/* Purple background for round trips makes them visually distinct at a glance */}
      <div className={`rounded-lg px-3 py-2 mb-3 text-xs space-y-1 ${
        isRoundTrip ? 'bg-purple-50 dark:bg-purple-900/30 border border-purple-100 dark:border-purple-800' : 'bg-gray-50 dark:bg-gray-700/50 border border-gray-100 dark:border-gray-700'
      }`}>
        <div className="flex items-center gap-2">
          <span className="text-gray-400 w-16 flex-shrink-0">{t('trips.departure_label')}</span>
          <span className="font-medium text-gray-800 dark:text-gray-100">{formatDateTime(trip.departure_at, tz)}</span>
        </div>
        {/* Return time and waiting duration — only for round trips */}
        {isRoundTrip && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-purple-400 w-16 flex-shrink-0">{t('trips.return_at_label')}</span>
              <span className="font-semibold text-purple-800 dark:text-purple-200">{formatDateTime(trip.return_at, tz)}</span>
            </div>
            <div className="flex items-center gap-2 pt-0.5 border-t border-purple-100 dark:border-purple-800">
              <span className="text-purple-400 w-16 flex-shrink-0">⏳</span>
              <span className="font-semibold text-purple-700 dark:text-purple-300">
                {t('trips.waiting_duration', {
                  duration: waitingDuration(trip.departure_at, trip.return_at),
                })}
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Client info ───────────────────────────────────── */}
      {/* stopPropagation on the phone link prevents any parent click handlers from firing */}
      <div className="flex items-center gap-4 bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 rounded-lg px-3 py-2 mb-3 text-xs">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-blue-400">🧑</span>
          <span className="font-semibold text-blue-800 dark:text-blue-200 truncate">{trip.client_name}</span>
        </div>
        {trip.client_phone && (
          <span
            className="flex items-center gap-1 flex-shrink-0"
            onClick={e => e.stopPropagation()}>
            <span>📞</span>
            <PhoneDisplay phone={trip.client_phone} />
          </span>
        )}
      </div>

      {/* ── Trip distance + duration ──────────────────────── */}
      {(trip.distance_km || trip.duration_minutes) && (
        <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-100 dark:border-gray-700 rounded-lg px-3 py-2 mb-3 text-xs space-y-1">
          <div className="flex items-center gap-4">
            {trip.distance_km && (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-400">🛣️</span>
                <span className="font-medium text-gray-800 dark:text-gray-100">{formatNumber(trip.distance_km, 1, locale)} km</span>
              </div>
            )}
            {trip.duration_minutes && (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-400">⏱️</span>
                <span className="font-medium text-gray-800 dark:text-gray-100">
                  {t('trips.duration_outbound')} : {formatDuration(trip.duration_minutes)}
                </span>
              </div>
            )}
          </div>
          {/* Round-trip total service time breakdown — rendered via IIFE to keep JSX flat */}
          {trip.return_at && trip.duration_minutes && (() => {
            const rt = calcRoundTripDuration(trip);
            if (!rt) return null;
            return (
              <div className="pt-1 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-gray-400">⏱️</span>
                  <span className="font-medium text-gray-800 dark:text-gray-100">
                    {t('trips.duration_return')} : {formatDuration(rt.returnDur)}
                  </span>
                </div>
                {/* Total highlighted in purple to stand out as the most important time figure */}
                <div className="flex items-center gap-1.5 text-purple-700 dark:text-purple-300 font-semibold">
                  <span>🕐</span>
                  <span>{t('trips.duration_total_service')} : {formatDuration(rt.total)}</span>
                </div>
                {/* Breakdown formula: outbound drive + waiting at destination + return drive */}
                <p className="text-gray-400 mt-0.5">
                  {t('trips.duration_breakdown', {
                    outbound: formatDuration(rt.outbound),
                    waiting:  formatDuration(rt.waiting),
                    ret:      formatDuration(rt.returnDur),
                  })}
                </p>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Client notes ──────────────────────────────────── */}
      {/* Amber background flags this as important information (accessibility needs, etc.) */}
      {trip.client_notes && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-100 dark:border-amber-800 rounded-lg px-3 py-2 mb-3">
          <p className="text-xs text-amber-700 dark:text-amber-300 font-medium mb-0.5">{t('trips.notes_label')}</p>
          <p className="text-xs text-amber-800 dark:text-amber-200">{trip.client_notes}</p>
        </div>
      )}

      {/* ── Previous action badge ─────────────────────────── */}
      {/* Shown when the driver already accepted or declined this trip in a previous session */}
      {actionLabel && (
        <div className={`mb-3 rounded-lg px-3 py-1.5 text-xs flex items-center gap-1.5 ${
          actionLabel.action === 'accepted'
            ? 'bg-teal-50 dark:bg-teal-900/30 border border-teal-200 text-teal-700 dark:text-teal-300'
            : 'bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400'
        }`}>
          <span>{actionLabel.action === 'accepted' ? '✅' : '🚫'}</span>
          <span>{actionLabel.text}</span>
        </div>
      )}

      {/* ── Schedule conflict warning panel (Feature B) ──── */}
      {/* Shown when backend returns 409 schedule_conflict_warning.
          Driver can cancel (keep buttons available) or force-accept despite the overlap. */}
      {conflictWarning && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/30 px-3 py-3 text-xs">
          <p className="font-semibold text-amber-800 dark:text-amber-200 mb-1">
            ⚠️ {t('trips.accept_schedule_conflict_warning')}
          </p>
          {conflictWarning.conflict_numbers && (
            <p className="text-amber-700 dark:text-amber-300 mb-2">
              {t('trips.accept_conflict_trips', { trips: conflictWarning.conflict_numbers })}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleForceAccept}
              className="flex-1 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs transition-colors"
            >
              {t('trips.accept_conflict_proceed')}
            </button>
            <button
              onClick={() => setConflictWarning(null)}
              className="flex-1 px-3 py-1.5 rounded-lg border border-amber-300 text-amber-800 dark:text-amber-200 hover:bg-amber-100 font-medium text-xs transition-colors"
            >
              {t('trips.accept_conflict_cancel')}
            </button>
          </div>
        </div>
      )}

      {/* ── Action buttons ────────────────────────────────── */}
      {/* Both buttons share buttonsDisabled — one request at a time, locks after any action */}
      <div className="flex gap-2">
        <button
          onClick={handleAccept}
          disabled={buttonsDisabled}
          className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition-colors justify-center ${
            buttonsDisabled
              ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 cursor-not-allowed border border-gray-200 dark:border-gray-700'
              : 'bg-teal-600 hover:bg-teal-700 text-white'
          }`}
        >
          {accepting ? t('trips.accepting') : t('trips.accept')}
        </button>
        <button
          onClick={handleDecline}
          disabled={buttonsDisabled}
          className={`flex-1 px-4 py-2 rounded-xl border-2 text-sm font-medium transition-colors justify-center ${
            buttonsDisabled
              ? 'border-gray-200 dark:border-gray-700 text-gray-300 cursor-not-allowed'
              : 'border-red-200 text-red-600 hover:bg-red-50'
          }`}
        >
          {declining ? t('trips.declining') : t('trips.decline_btn')}
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────

/**
 * AvailableTrips — main page component.
 *
 * State:
 *   preferredTrips — trips the operator specifically matched to this driver
 *   bandTrips      — all pending trips within the selected distance band
 *   loading        — true during initial load and band switches
 *   baseRadius     — driver_suggestion_radius_km from config (default 10)
 *   activeBand     — index of the currently selected distance band tab (0–2)
 *   profile        — driver's own profile object (used for guard checks)
 *   tz             — app timezone string from config (used for date display)
 */
export default function AvailableTrips() {
  const { t, i18n } = useTranslation();
  const { currency } = useAppConfig();

  const [preferredTrips, setPreferredTrips] = useState([]);
  const [bandTrips,      setBandTrips]      = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [baseRadius,     setBaseRadius]     = useState(10);
  const [activeBand,     setActiveBand]     = useState(0);
  const [profile,        setProfile]        = useState(null);
  const [tz,             setTz]             = useState('America/Toronto');

  /**
   * Build the three band definitions for the tab bar.
   * All labels are computed from a single base radius value, so changing the
   * config key automatically re-generates correct labels without any code change.
   */
  function getBands(base) {
    return [
      { min: 0,      max: base,    label: t('trips.radius_band_1', { km: base }) },
      { min: base,   max: base*2,  label: t('trips.radius_band_2', { min: base,   max: base*2 }) },
      { min: base*2, max: base*3,  label: t('trips.radius_band_2', { min: base*2, max: base*3 }) },
    ];
  }

  /**
   * Fetch trips for a specific distance band.
   * Sends radius_min / radius_max to the backend so only trips within that
   * exclusive range are returned.  Preferred trips are included in the same
   * response and always shown above the band list.
   *
   * Wrapped in useCallback so it can be called both from useEffect (on init)
   * and from handleBandChange without re-creating the function on every render.
   */
  const fetchBand = useCallback(async (base, bandIndex) => {
    const bands = [
      { min: 0,      max: base    },
      { min: base,   max: base*2  },
      { min: base*2, max: base*3  },
    ];
    const { min, max } = bands[bandIndex];
    setLoading(true);
    try {
      const { data } = await tripService.available({ radius_min: min, radius_max: max });
      setPreferredTrips(data.preferred_trips || []);
      setBandTrips(data.trips || []);
    } catch {
      setPreferredTrips([]);
      setBandTrips([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * On mount: load public config (for base radius + timezone) and driver stats
   * (for approval/availability guard check) in parallel.
   * Only fetches band 0 trips if the driver is approved AND on duty — otherwise
   * we show the appropriate warning and skip the unnecessary API call.
   *
   * Note: `base` is used directly instead of the `baseRadius` state variable
   * because state updates are asynchronous — `baseRadius` hasn't re-rendered yet.
   */
  useEffect(() => {
    async function init() {
      try {
        const [{ data: cfgData }, { data: statsData }] = await Promise.all([
          api.get('/admin/configuration/public'),
          tripService.stats(),
        ]);

        const cfg      = cfgData.configuration || [];
        const base     = parseFloat(cfg.find(c => c.key === 'driver_suggestion_radius_km')?.value || '10');
        const timezone = cfg.find(c => c.key === 'app_timezone')?.value || 'America/Toronto';
        setTz(timezone);
        setBaseRadius(base);

        const p = statsData.stats?.profile || null;
        setProfile(p);

        if (p?.approval_status === 'approved' && p?.is_available) {
          // Use `base` directly — setBaseRadius hasn't re-rendered yet at this point
          const { data } = await tripService.available({ radius_min: 0, radius_max: base });
          setPreferredTrips(data.preferred_trips || []);
          setBandTrips(data.trips || []);
        }
      } catch {
        // keep empty state
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  /** Switch to a new distance band tab and reload trips for that range. */
  function handleBandChange(index) {
    setActiveBand(index);
    fetchBand(baseRadius, index);
  }

  /**
   * Remove an accepted trip from BOTH lists immediately — once accepted it
   * is no longer pending and should not be shown to this driver again.
   */
  function handleAccepted(tripId) {
    // Remove from both lists — once accepted it's no longer pending
    setPreferredTrips(prev => prev.filter(t => t.id !== tripId));
    setBandTrips(prev => prev.filter(t => t.id !== tripId));
  }

  /**
   * On decline: remove from preferred list (so it doesn't clog the starred section),
   * but KEEP in the band list so the card can show the "declined" badge.
   * This way the driver sees they already declined it if they scroll down.
   */
  function handleDeclined(tripId) {
    // Remove from preferred list on decline; keep in band list so badge shows
    setPreferredTrips(prev => prev.filter(t => t.id !== tripId));
    // Band trips stay — the card will show the "declined" badge and disabled buttons
  }

  // ── Guards ────────────────────────────────────────────────
  // Show full-page spinner while the initial data load is in progress
  if (loading && profile === null) return <LoadingPage />;

  const notApproved = profile?.approval_status !== 'approved';
  const offDuty     = profile?.is_available === false;
  const bands       = getBands(baseRadius);
  const locale      = i18n.language;

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1>{t('trips.available_title')}</h1>
      </div>

      {/* Not approved — driver account pending admin review */}
      {notApproved && (
        <div className="card bg-amber-50 dark:bg-amber-900/30 border border-amber-200 text-amber-800 dark:text-amber-200 text-sm">
          ⏳ {t('dashboard.status_pending_approval')}
        </div>
      )}

      {/* Off duty warning — driver is approved but has toggled themselves unavailable */}
      {!notApproved && offDuty && (
        <div className="card bg-orange-50 dark:bg-orange-900/30 border border-orange-200">
          <p className="text-orange-800 text-sm font-medium mb-2">
            ⏸ {t('dashboard.off_duty_warning')}
          </p>
          <Link to="/driver" className="text-sm text-teal-600 dark:text-teal-400 underline">
            ← {t('dashboard.title')}
          </Link>
        </div>
      )}

      {/* Main content — only rendered when driver is approved AND on duty */}
      {!notApproved && !offDuty && (
        <>
          {/* ── Preferred trips — shown above band tabs, always ── */}
          {/* These are trips the operator specifically matched to this driver;
              they appear here regardless of which distance band is selected. */}
          {preferredTrips.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-teal-700 dark:text-teal-300 mb-3 flex items-center gap-2">
                ⭐ {t('trips.preferred_section_title')}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {preferredTrips.map(trip => (
                  <TripCard
                    key={trip.id}
                    trip={trip}
                    isPreferred={true}
                    onAccepted={handleAccepted}
                    onDeclined={handleDeclined}
                    t={t}
                    tz={tz}
                    locale={locale}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Band selector ──────────────────────────────── */}
          {/* Three tab buttons corresponding to increasing distance rings from home */}
          <div className="flex flex-wrap gap-2 mb-6">
            {bands.map((band, i) => (
              <button
                key={i}
                onClick={() => handleBandChange(i)}
                className={`px-5 py-2.5 rounded-xl text-sm font-medium border transition-all text-center leading-snug whitespace-pre-line ${
                  activeBand === i
                    ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-teal-400 hover:text-teal-600'
                }`}
              >
                {band.label}
              </button>
            ))}
          </div>

          {/* ── Band trip list ─────────────────────────────── */}
          {loading ? (
            <LoadingPage />
          ) : bandTrips.length === 0 ? (
            <div className="card text-gray-500 dark:text-gray-400 text-sm text-center py-8">
              {t('trips.no_available_band')}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {bandTrips.map(trip => (
                <TripCard
                  key={trip.id}
                  trip={trip}
                  isPreferred={false}
                  onAccepted={handleAccepted}
                  onDeclined={handleDeclined}
                  t={t}
                  tz={tz}
                  locale={locale}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
