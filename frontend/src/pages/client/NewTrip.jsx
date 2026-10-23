/**
 * @file NewTrip.jsx
 * @description 6-step trip booking wizard for clients (passengers) on SolidaRoute.
 *
 * Step flow:
 *   1 — Addresses: pickup, dropoff, and passenger count
 *   2 — Schedule: departure date/time, optional return trip
 *   3 — Estimate: route distance, duration, and estimated cost (returned from API)
 *   4 — Driver selection: nearby suggestions + free-text name search + client notes
 *   5 — Confirmation: full summary; handles OVERLAPPING_TRIP inline (amber banner)
 *   6 — Success screen: trip booked; offers "New request" or "View my trips"
 *
 * Key design decisions:
 *   - Lead time (`min_trip_lead_hours`) and max-advance (`max_trip_advance_days`)
 *     are validated BOTH client-side here (fast UX feedback) AND server-side (security).
 *   - `onMouseDown` is used in AddressAutocomplete to prevent blur-before-select race;
 *     that detail lives in the AddressAutocomplete component itself.
 *   - OVERLAPPING_TRIP errors are shown as an inline amber banner in step 5, not a toast,
 *     because the user needs to actively choose to proceed — a toast would disappear.
 *   - TOO_FAR_IN_ADVANCE and INSUFFICIENT_LEAD_TIME errors send the user back to step 2
 *     so they can adjust the date without losing their address data.
 *   - `confirm_overlap: true` is sent on the second attempt when the user explicitly
 *     clicks "Create anyway" in the overlap banner.
 *   - Driver search is name-based only (no distance filter). The "nearby" list uses
 *     the configured radius; the search box casts a wider net for flexibility.
 *   - Authentication token is stored under the localStorage key `sr_token`.
 *
 * Config keys consumed (fetched from /api/admin/configuration/public on mount):
 *   max_return_delay_minutes    — maximum minutes between departure and return trip
 *   min_trip_lead_hours         — minimum hours of advance notice required
 *   max_trip_advance_days       — how far ahead a trip can be booked
 *   driver_suggestion_radius_km — radius for the nearby-drivers list
 *   driver_selection_required   — if "true", user cannot proceed without a driver
 */
// formatAmount: locale-aware monetary formatting (e.g. 1 234,56 for fr-CA)
// formatNumber: locale-aware number formatting used for driver ratings
// currencySymbol: returns disambiguated symbol for the configured currency (e.g. "CA$", "€")
import { formatAmount, formatNumber, currencySymbol } from '../../utils/format';
import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
// `api` is the raw Axios instance used for endpoints without a dedicated service method
//   (e.g. GET /admin/configuration/public).
// `adminService` is imported from the same module but not used directly in this file —
//   it is available if future steps need admin-level API calls.
import api, { tripService, driverService } from '../../services/api';
// driverService.checkAvailability is used in step 4 to block selecting a preferred
// driver who already has an assigned trip overlapping the requested time window.
// react-hot-toast: lightweight toast library for transient error/success notifications.
// Used for most errors here except OVERLAPPING_TRIP, which uses an inline banner instead.
import toast from 'react-hot-toast';
// AddressAutocomplete: shared component that wraps the address input with geocoding
// suggestions. Uses onMouseDown internally (not onClick) to prevent blur-before-select
// race conditions when the user clicks a suggestion from the dropdown.
import { AddressAutocomplete } from '../../components/common';
import { StarDisplay } from '../../components/common/StarDisplay';
import PaymentStep from '../../components/payment/PaymentStep';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Returns today's date as a YYYY-MM-DD string in local time.
 * Used as the `min` attribute on date inputs so past dates are blocked.
 */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns a future date as a YYYY-MM-DD string, `days` from now.
 * Used as the `max` attribute on the departure date input to enforce
 * the `max_trip_advance_days` booking window at the UI level.
 */
function maxDateStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Combines a local date string (YYYY-MM-DD) and a time string (HH:MM)
 * into a UTC ISO-8601 string suitable for sending to the API.
 * Returns null if either part is missing to avoid constructing invalid dates.
 */
function buildISO(date, time) {
  if (!date || !time) return null;
  return new Date(`${date}T${time}`).toISOString();
}

/**
 * Formats a duration given in minutes as a human-readable string.
 * Examples: 45 → "45 min", 90 → "1h30min", 120 → "2h"
 */
function formatDuration(min) {
  if (!min) return '—';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}min` : ''}`;
}

/**
 * Returns the signed difference in minutes between two Date-compatible values.
 * Negative result means dateB is earlier than dateA (used to detect return-before-departure).
 */
function diffMinutes(dateA, dateB) {
  return (new Date(dateB) - new Date(dateA)) / 60000;
}

// ── Sub-components ────────────────────────────────────────────

/**
 * StepIndicator — horizontal progress bar showing wizard step progress.
 *
 * Each step bubble is:
 *   - Filled teal with a checkmark  → completed step (num < current)
 *   - Filled teal with a ring       → active step (num === current)
 *   - Gray                          → future step
 *
 * The connector line between steps turns teal once the left step is done.
 * Labels are hidden on small screens (sm:block) to save horizontal space.
 */
function StepIndicator({ current, steps }) {
  return (
    <div className="flex items-center mb-8">
      {steps.map((label, i) => {
        const num    = i + 1;
        const done   = num < current;
        const active = num === current;
        return (
          <div key={num} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1 flex-shrink-0">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                done   ? 'bg-teal-600 text-white' :
                active ? 'bg-teal-600 text-white ring-4 ring-teal-100' :
                         'bg-gray-200 dark:bg-gray-600 text-gray-400'
              }`}>
                {done ? '✓' : num}
              </div>
              <span className={`text-xs hidden sm:block whitespace-nowrap ${
                active ? 'text-teal-700 dark:text-teal-300 font-medium' : done ? 'text-gray-400' : 'text-gray-300'
              }`}>{label}</span>
            </div>
            {/* Connector line — only rendered between steps, not after the last */}
            {i < steps.length - 1 && (
              <div className={`flex-1 h-0.5 mx-2 mb-4 ${done ? 'bg-teal-400' : 'bg-gray-200 dark:bg-gray-600'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * SummaryRow — a single label/value row used in the step 5 confirmation card.
 * The icon, a small grey label, and the bolded value are laid out horizontally.
 * `last:border-0` removes the bottom border on the final row in a list.
 */
function SummaryRow({ icon, label, value }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
      <span className="flex-shrink-0 text-base">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-gray-400 mb-0.5">{label}</p>
        <p className="text-sm text-gray-800 dark:text-gray-100 font-medium leading-snug">{value}</p>
      </div>
    </div>
  );
}

const REVIEWS_INITIAL = 3;

/**
 * DriverReviewsModal — shows approved reviews for a driver before the client
 * selects them. Displays 3 reviews initially with a "show more" toggle.
 *
 * Props:
 *   driver   — driver object (first_name, last_name, average_rating, review_count)
 *   onSelect — callback to select this driver and close the modal
 *   onClose  — callback to close without selecting
 */
function DriverReviewsModal({ driver, onSelect, onClose }) {
  const { t, i18n } = useTranslation();
  const [reviews,   setReviews]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [showAll,   setShowAll]   = useState(false);

  useEffect(() => {
    api.get(`/reviews/user/${driver.id}`)
      .then(r => setReviews(r.data.reviews || []))
      .catch(() => setReviews([]))
      .finally(() => setLoading(false));
  }, [driver.id]);

  const visible  = showAll ? reviews : reviews.slice(0, REVIEWS_INITIAL);
  const remaining = reviews.length - REVIEWS_INITIAL;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[85vh]"
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 flex items-center
                            justify-center text-sm font-bold flex-shrink-0">
              {driver.first_name[0]}{driver.last_name[0]}
            </div>
            <div>
              <p className="font-semibold text-sm text-gray-900 dark:text-gray-50">
                {driver.first_name} {driver.last_name}
              </p>
              {parseFloat(driver.average_rating || 0) > 0 ? (
                <div className="flex items-center gap-1 mt-0.5">
                  <StarDisplay rating={parseFloat(driver.average_rating)} size="sm" />
                  <span className="text-xs text-gray-400">
                    ({driver.review_count} {t('trips.driver_rating')})
                  </span>
                </div>
              ) : (
                <p className="text-xs text-gray-400">{t('trips.driver_reviews_new')}</p>
              )}
            </div>
          </div>
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1">✕</button>
        </div>

        {/* Reviews list */}
        <div className="overflow-y-auto flex-1 px-5 py-3">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
            {t('trips.driver_reviews_title')}
          </p>
          {loading ? (
            <div className="flex justify-center py-6">
              <span className="w-5 h-5 border-2 border-gray-200 dark:border-gray-700 border-t-teal-500
                               rounded-full animate-spin" />
            </div>
          ) : reviews.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">
              {t('trips.driver_reviews_none')}
            </p>
          ) : (
            <div className="space-y-3">
              {visible.map(r => (
                <div key={r.id} className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <StarDisplay rating={r.rating} size="sm" />
                    <span className="text-xs text-gray-400">
                      {new Date(r.created_at).toLocaleDateString(
                        i18n.language === 'en' ? 'en-CA' : 'fr-CA',
                        { day: 'numeric', month: 'short', year: 'numeric' }
                      )}
                    </span>
                  </div>
                  {r.comment && (
                    <p className="text-sm text-gray-700 dark:text-gray-200 mt-1">{r.comment}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    — {r.reviewer_first} {r.reviewer_last}
                  </p>
                </div>
              ))}

              {/* Show more / show less toggle */}
              {reviews.length > REVIEWS_INITIAL && (
                <button
                  onClick={() => setShowAll(v => !v)}
                  className="w-full text-xs text-teal-600 dark:text-teal-400 hover:text-teal-700 font-medium py-1">
                  {showAll
                    ? t('trips.driver_reviews_show_less')
                    : t('trips.driver_reviews_show_more', { count: remaining })}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex gap-2 px-5 py-4 border-t border-gray-100 dark:border-gray-700">
          <button onClick={onClose}
            className="flex-1 px-4 py-2 rounded-xl text-sm font-medium
                       border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={() => { onSelect(driver); onClose(); }}
            className="flex-1 px-4 py-2 rounded-xl text-sm font-medium
                       bg-teal-600 text-white hover:bg-teal-700 transition-colors">
            {t('trips.driver_reviews_select')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * DriverCard — selectable card representing a single driver in step 4.
 * Clicking the card opens DriverReviewsModal; the small ✓ button selects directly.
 *
 * Props:
 *   driver     — driver object from the API (nearby list or search results)
 *   selected   — currently selected driver object (or null)
 *   onSelect   — callback invoked to select this driver directly (bypasses modal)
 *   onReview   — callback invoked with the driver to open the reviews modal
 */
function DriverCard({ driver, selected, onSelect, onReview, checkingId }) {
  const { t, i18n } = useTranslation();
  const isSelected  = selected?.id === driver.id;
  const unavailable = driver.is_available === false;
  const isChecking  = checkingId === driver.id;

  return (
    <button
      type="button"
      onClick={() => { if (!unavailable) onReview(driver); }}
      disabled={unavailable}
      title={unavailable ? t('trips.driver_unavailable_msg') : undefined}
      className={`w-full text-left p-3 rounded-xl border-2 transition-all ${
        unavailable
          ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 opacity-60 cursor-not-allowed'
          : isSelected
            ? 'border-teal-400 bg-teal-50 dark:bg-teal-900/30'
            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 bg-white dark:bg-gray-800'
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Avatar: initials circle — color shifts based on selected/unavailable state */}
        <div className={`w-10 h-10 rounded-full flex items-center justify-center
          text-sm font-bold flex-shrink-0 ${
            unavailable ? 'bg-gray-200 dark:bg-gray-600 text-gray-400'
            : isSelected ? 'bg-teal-600 text-white'
            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
          }`}>
          {driver.first_name[0]}{driver.last_name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-gray-800 dark:text-gray-100">
            {driver.first_name} {driver.last_name}
            {/* Distance from pickup — only present on nearby-list drivers */}
            {driver.distance_km !== undefined && (
              <span className="text-gray-400 font-normal text-xs ml-2">({driver.distance_km} km)</span>
            )}
          </p>
          <p className="text-xs text-gray-400 truncate">
            {driver.vehicle_make} {driver.vehicle_model} {driver.vehicle_year}
          </p>
          {/* Explicit unavailability notice — warns coordinator not to select this driver */}
          {unavailable && (
            <p className="text-xs text-orange-500 font-medium mt-0.5">
              ⏸ {t('trips.driver_unavailable')}
            </p>
          )}
        </div>
        {/* Rating section — "Nouveau" shown when the driver has no reviews yet */}
        <div className="text-right flex-shrink-0">
          {parseFloat(driver.average_rating || 0) > 0 ? (
            <>
              <p className="text-sm font-bold text-amber-500">
                ★ {formatNumber(driver.average_rating, 1, i18n.language)}
              </p>
              <p className="text-xs text-gray-400">{driver.review_count} {t('trips.driver_rating')}</p>
            </>
          ) : (
            <p className="text-xs text-gray-400">{t('trips.driver_reviews_new')}</p>
          )}
        </div>
        {/* Direct select button — stops propagation so it doesn't open the review modal.
            Shows a spinner while the availability check is in-flight for this driver. */}
        {!unavailable && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onSelect(driver); }}
            disabled={isChecking}
            title={t('trips.driver_select_direct')}
            className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center
              text-sm font-bold transition-colors ${
                isChecking
                  ? 'bg-gray-100 dark:bg-gray-700 cursor-wait'
                  : isSelected
                    ? 'bg-teal-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-400 hover:bg-teal-100 hover:text-teal-600'
              }`}
          >
            {isChecking
              ? <span className="w-3 h-3 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin inline-block" />
              : '✓'}
          </button>
        )}
      </div>
    </button>
  );
}

// ── Main component ────────────────────────────────────────────

/**
 * NewTrip — the main trip booking wizard component.
 *
 * State is organized by wizard step:
 *   config        — admin settings fetched once on mount; used for validation thresholds
 *   step          — current step number (1–6); drives which panel is rendered
 *   pickup/dropoff/passengers — step 1 form data
 *   departDate/departTime/hasReturn/returnDate/returnTime — step 2 schedule data
 *   estimate      — step 3 API result: {distance_km, duration_minutes, estimated_cost, pickup, dropoff, routing_source}
 *   nearbyDrivers/selectedDriver/searchQuery/searchResults — step 4 driver state
 *   clientNotes   — optional free-text note to attach to the trip (entered in step 4)
 *   booking       — true while the step 5 POST /api/trips request is in-flight
 *   overlapTrip   — non-null when the server returns OVERLAPPING_TRIP; holds {trip_number, departure_at}
 *                   so the amber warning banner can show the conflicting trip's details
 *
 * Overall flow:
 *   handleStep1      — validates step 1 (browser-native required), advances to step 2
 *   handleEstimate   — client-side lead-time + advance-booking checks, then calls
 *                      POST /api/trips/estimate; on success advances to step 3
 *   handleGoToDriverStep — advances to step 4 and fetches the nearby-drivers list
 *   handleSearchChange   — debounced (300 ms) name search, min 2 chars
 *   handleGoToConfirm    — validates driver-required rule, advances to step 5
 *   handleBook       — POST /api/trips; handles all server error codes; step 6 on success
 *   reset            — clears all state back to step 1 for "New request"
 */
export default function NewTrip() {
  const { t, i18n } = useTranslation();
  const location = useLocation();

  // Current wizard step (1–6). Step 6 is the success screen rendered separately.
  const [step, setStep]   = useState(1);

  // Admin configuration values — initialized to safe defaults in case the API call
  // fails or is slow. The component is fully functional with these defaults.
  const [config, setConfig] = useState({
    maxReturnMinutes:    150,      // max gap between departure and return (minutes)
    minLeadHours:        48,       // minimum advance notice required
    maxAdvanceDays:      180,      // how far ahead trips can be booked
    driverRadius:        10,       // km radius for the nearby-drivers suggestion list
    driverRequired:      true,     // whether a driver must be selected to proceed past step 4
    paymentProvider:     'stripe', // active payment provider ('stripe' | 'manual' | etc.)
    stripePublishableKey: '',      // Stripe pk_... key (safe to expose; never the secret key)
    paymentCurrency:     'CAD',   // ISO 4217 currency code for display
  });

  // Fetch live config values from the public configuration endpoint on mount.
  // This endpoint does not require authentication so it works for all client roles.
  useEffect(() => {
    api.get('/admin/configuration/public').then(({ data }) => {
      const cfg = data.configuration || [];
      // Helper to extract a config value by key, falling back to `def` if absent
      const get = (key, def) => cfg.find(c => c.key === key)?.value ?? def;
      setConfig({
        maxReturnMinutes:    parseInt(get('max_return_delay_minutes', '150'), 10),
        minLeadHours:        parseInt(get('min_trip_lead_hours', '48'), 10),
        maxAdvanceDays:      parseInt(get('max_trip_advance_days', '180'), 10),
        driverRadius:        parseFloat(get('driver_suggestion_radius_km', '10')),
        driverRequired:      get('driver_selection_required', 'true') === 'true',
        paymentProvider:     get('payment_provider', 'stripe'),
        stripePublishableKey: get('stripe_publishable_key', ''),
        paymentCurrency:     (get('payment_currency', 'CAD')).toUpperCase(),
      });
    }).catch(() => {}); // silently fall back to defaults on network/auth error
  }, []);

  // ── Step 1 state ─────────────────────────────────────────────
  const [pickup,     setPickup]     = useState(location.state?.pickup  ?? '');
  const [dropoff,    setDropoff]    = useState(location.state?.dropoff ?? '');
  const [passengers, setPassengers] = useState(1);

  // ── Step 2 state ─────────────────────────────────────────────
  const [departDate, setDepartDate] = useState('');
  const [departTime, setDepartTime] = useState('');
  const [hasReturn,  setHasReturn]  = useState(false); // whether a return leg is requested
  const [returnDate, setReturnDate] = useState('');
  const [returnTime, setReturnTime] = useState('');
  const [returnErr,  setReturnErr]  = useState('');    // inline error message for the return fields

  // ── Step 3 state ─────────────────────────────────────────────
  // `estimate` holds the full response from POST /api/trips/estimate including
  // geocoded coordinates (pickup.lat/lon, dropoff.lat/lon) reused in later steps.
  const [estimate,   setEstimate]   = useState(null);
  const [estimating, setEstimating] = useState(false); // spinner while estimate is loading
  const [geocodeErr, setGeocodeErr] = useState('');    // shown if address geocoding fails

  // ── Step 4 state ─────────────────────────────────────────────
  const [nearbyDrivers,  setNearbyDrivers]  = useState([]);  // drivers within the configured radius
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState(null); // the chosen driver object (or null)
  const [searchQuery,    setSearchQuery]    = useState('');   // text in the name-search input
  const [searchResults,  setSearchResults]  = useState([]);   // results from the name-search API
  const [reviewingDriver, setReviewingDriver] = useState(null); // driver whose reviews modal is open
  const [searching,      setSearching]      = useState(false);
  const [clientNotes,    setClientNotes]    = useState('');   // optional note to the driver
  // availability check state (Feature A)
  const [checkingDriverId, setCheckingDriverId] = useState(null);  // id of driver being checked
  const [driverConflict,   setDriverConflict]   = useState(null);  // {driver, conflicts[]} when blocked

  // Ref used to debounce the driver name-search input so the API is not called on
  // every keystroke — fires 300 ms after the user stops typing.
  const searchTimer = useRef(null);

  // ── Step 6 state (payment) ───────────────────────────────────
  // Populated after a successful trip creation so PaymentStep can associate
  // the card / manual payment with the correct trip record.
  const [createdTripId, setCreatedTripId] = useState(null);

  // ── Step 5 state ─────────────────────────────────────────────
  const [booking,     setBooking]     = useState(false);    // true while POST /api/trips is in-flight
  // When the server returns OVERLAPPING_TRIP, we store the conflicting trip's
  // identifying info here so the amber warning banner can reference it by number/date.
  // Storing it in state (rather than just showing a toast) keeps the banner visible
  // until the user makes an explicit choice: cancel or confirm anyway.
  const [overlapTrip, setOverlapTrip] = useState(null);

  // ── Validate return time ──────────────────────────────────────
  /**
   * Client-side validation for the optional return trip fields.
   * Checks two conditions:
   *   1. Return must not be before departure (negative diff).
   *   2. Gap between departure and return must not exceed `maxReturnMinutes`.
   *      This mirrors the server-side RETURN_TOO_LATE check.
   * Returns true when valid (or when no return trip is configured).
   * Sets `returnErr` for inline display rather than a toast, because the
   * error is right next to the problematic inputs.
   */
  function validateReturn() {
    if (!hasReturn || !returnDate || !returnTime) return true;
    const dept = buildISO(departDate, departTime);
    const ret  = buildISO(returnDate, returnTime);
    const diff = diffMinutes(dept, ret);
    if (diff < 0) {
      setReturnErr(t('trips.return_after_departure', { defaultValue: 'Return must be after departure.' }));
      return false;
    }
    if (diff > config.maxReturnMinutes) {
      const h   = Math.floor(config.maxReturnMinutes / 60);
      const m   = config.maxReturnMinutes % 60;
      const max = h > 0 ? `${h}h${m > 0 ? m + 'min' : ''}` : `${m}min`;
      setReturnErr(t('trips.return_too_late', { max: config.maxReturnMinutes }) + ` (max ${max})`);
      return false;
    }
    // Gap must be at least the one-way trip duration (known after step 3 estimate)
    if (estimate?.duration_minutes && diff < estimate.duration_minutes) {
      setReturnErr(t('trips.return_gap_too_short', {
        duration: estimate.duration_minutes,
        gap: Math.round(diff),
      }));
      return false;
    }
    setReturnErr('');
    return true;
  }

  // ── Step 1 → 2 ───────────────────────────────────────────────
  /**
   * Advances from step 1 (addresses) to step 2 (schedule).
   * No custom validation needed here — browser `required` attributes on the
   * address inputs handle the empty-field case via form submission.
   */
  function handleStep1(e) {
    e.preventDefault();
    setStep(2);
  }

  // ── Step 2 → 3 (estimate) ────────────────────────────────────
  /**
   * Triggered by the "Get estimate" button in step 2.
   * Performs two client-side time-window checks before calling the API:
   *
   *   1. Lead time: departure must be at least `minLeadHours` hours from now.
   *      This prevents last-minute bookings that leave no time to find a driver.
   *      The check is duplicated server-side (INSUFFICIENT_LEAD_TIME) as the
   *      authoritative guard; the client check gives immediate feedback.
   *
   *   2. Max advance: departure must not be more than `maxAdvanceDays` days away.
   *      Long-advance bookings tie up driver slots and are discouraged by policy.
   *      Also duplicated server-side (TOO_FAR_IN_ADVANCE).
   *
   * On success, `estimate` is populated with geocoded coordinates and route stats.
   * Geocoding errors (address not found) are shown inline rather than as a toast
   * because the user needs to go back and correct the address in step 1.
   */
  async function handleEstimate(e) {
    e.preventDefault();
    // Run return-time validation before the async API call to avoid unnecessary requests
    if (!validateReturn()) return;

    const departure = new Date(`${departDate}T${departTime}`);

    // Client-side lead time check (mirrors server INSUFFICIENT_LEAD_TIME)
    if (config.minLeadHours > 0) {
      const hoursUntil = (departure - new Date()) / 3600000;
      if (hoursUntil < config.minLeadHours) {
        toast.error(t('trips.lead_time_error', {
          hours: config.minLeadHours,
          defaultValue: `Le départ doit être planifié au moins ${config.minLeadHours} heures à l'avance.`,
        }));
        return;
      }
    }

    // Client-side advance booking limit (mirrors server TOO_FAR_IN_ADVANCE)
    if (config.maxAdvanceDays > 0) {
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + config.maxAdvanceDays);
      if (departure > maxDate) {
        toast.error(t('trips.advance_booking_error', {
          days: config.maxAdvanceDays,
          defaultValue: `Les trajets ne peuvent pas être réservés plus de ${config.maxAdvanceDays} jours à l'avance.`,
        }));
        return;
      }
    }

    setGeocodeErr('');
    setEstimating(true);
    try {
      const { data } = await tripService.estimate({
        pickup_address:  pickup.trim(),
        dropoff_address: dropoff.trim(),
        passenger_count: passengers,
        has_return:      hasReturn,
      });

      // Coherence check: return trip must allow enough time for the one-way leg
      if (hasReturn && returnDate && returnTime && data.duration_minutes) {
        const departDt = new Date(`${departDate}T${departTime}`);
        const returnDt = new Date(`${returnDate}T${returnTime}`);
        const diffMins = (returnDt - departDt) / 60000;
        if (diffMins < data.duration_minutes) {
          setReturnErr(t('trips.return_gap_too_short', {
            duration: data.duration_minutes,
            gap: Math.round(diffMins),
          }));
          setEstimate(data); // store so validateReturn can use duration next time
          return;            // stay on step 2
        }
      }

      setEstimate(data);
      setStep(3);
    } catch (err) {
      // Geocoding errors are a common failure mode — surface them inline rather
      // than as a transient toast so the user understands they need to fix the address.
      const msg = err.response?.data?.error || '';
      if (msg.toLowerCase().includes('geocod') || msg.toLowerCase().includes('address')) {
        setGeocodeErr(t('trips.geocode_error'));
      }
    } finally {
      setEstimating(false);
    }
  }

  // ── Step 3 → 4 (load nearby drivers) ────────────────────────
  /**
   * Advances from the estimate screen (step 3) to driver selection (step 4),
   * and simultaneously fetches the list of drivers near the pickup point.
   *
   * The pickup coordinates come from the estimate response (already geocoded),
   * so we don't need to geocode again. The radius used is 3× the configured
   * `driver_suggestion_radius_km` to cast a wider net for suggestions while
   * still showing the configured radius label in the UI.
   *
   * Failures are handled silently — an empty list simply shows the "no nearby
   * drivers" message, and the user can still find a driver via name search.
   */
  async function handleGoToDriverStep() {
    setStep(4);
    setLoadingDrivers(true);
    try {
      const { data } = await driverService.nearby({
        lat:    estimate.pickup.lat,
        lon:    estimate.pickup.lon,
        radius: config.driverRadius,
      });
      setNearbyDrivers(data.drivers || []);
    } catch {
      setNearbyDrivers([]);
    } finally {
      setLoadingDrivers(false);
    }
  }

  // ── Driver search autocomplete ────────────────────────────────
  /**
   * Handles changes to the driver name-search input in step 4.
   * Debounces API calls by 300 ms so we don't hammer the server on every keystroke.
   * Requires at least 2 characters before searching (avoids overly broad queries).
   * The search is purely name-based — no distance filter is applied here, giving
   * coordinators flexibility to pick any active driver regardless of location.
   */
  function handleSearchChange(e) {
    const q = e.target.value;
    setSearchQuery(q);
    clearTimeout(searchTimer.current);
    if (q.length < 2) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        // Pass pickup coordinates as context; the API may use them for soft sorting
        // but does not use them as a hard filter.
        const { data } = await driverService.search(q, estimate?.pickup?.lat, estimate?.pickup?.lon);
        setSearchResults(data.drivers || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  /**
   * Selects a driver from either the nearby list or search results.
   * Clears the search input and results so the panel returns to a tidy state,
   * with only the selected-driver badge visible at the top of the card.
   */
  function selectDriver(driver) {
    setSelectedDriver(driver);
    setSearchQuery('');
    setSearchResults([]);
  }

  /**
   * Availability-checked driver selection (Feature A).
   *
   * Calls GET /api/drivers/:id/availability-check before selecting.
   * If the driver already has an assigned trip overlapping the requested
   * time window, the selection is blocked and a conflict modal is shown.
   * On API error the check fails open (driver is selected anyway) to avoid
   * blocking the UI on a transient network problem.
   *
   * Used as onSelect for all DriverCard instances and as the onSelect
   * callback in DriverReviewsModal.
   */
  async function handleSelectDriver(driver) {
    setCheckingDriverId(driver.id);
    try {
      const departureAt = buildISO(departDate, departTime);
      const returnAt    = hasReturn ? buildISO(returnDate, returnTime) : null;
      const { data } = await driverService.checkAvailability(driver.id, {
        departure_at:     departureAt,
        ...(returnAt              && { return_at:        returnAt }),
        ...(estimate?.duration_minutes && { duration_minutes: estimate.duration_minutes }),
      });
      if (!data.available) {
        setDriverConflict({ driver, conflicts: data.conflicts });
      } else {
        selectDriver(driver);
        setReviewingDriver(null);
      }
    } catch {
      // Fail open on network/server error — do not block the booking flow
      selectDriver(driver);
      setReviewingDriver(null);
    } finally {
      setCheckingDriverId(null);
    }
  }

  // ── Step 4 → 5 ───────────────────────────────────────────────
  /**
   * Guards the transition from step 4 (driver) to step 5 (confirmation).
   * If `driverRequired` is true and no driver has been selected, we block
   * advancement — the required-warning message is already shown below the list.
   * When `driverRequired` is false, a separate "Skip" button (rendered in the
   * JSX) lets the user bypass this function entirely.
   */
  function handleGoToConfirm() {
    if (config.driverRequired && !selectedDriver) return;
    setStep(5);
  }

  // ── Step 5 → confirm & book ───────────────────────────────────
  /**
   * Submits the trip booking to the server (POST /api/trips).
   *
   * @param {boolean} forceOverlap — true when the user clicks "Create anyway"
   *   after seeing the OVERLAPPING_TRIP amber banner. This sends
   *   `confirm_overlap: true` to bypass the server-side overlap guard.
   *
   * Server error codes and their handling:
   *   OVERLAPPING_TRIP      — sets `overlapTrip` state to show inline amber banner
   *                           (NOT a toast) so the user can choose to proceed or cancel.
   *   RETURN_TOO_LATE       — toast + send back to step 2 (return time must be corrected).
   *   MISSING_COORDINATES   — toast + send back to step 2 (geocoding issue; re-estimate needed).
   *   DRIVER_UNAVAILABLE    — toast + clear selected driver + send back to step 4.
   *   INSUFFICIENT_LEAD_TIME — toast + send back to step 2 (departure too soon).
   *   TOO_FAR_IN_ADVANCE    — toast + send back to step 2 (departure too far out).
   *   anything else         — generic toast error, stay on step 5.
   *
   * The coordinates used for the trip come from `estimate` (already geocoded) rather
   * than re-geocoding the address strings, ensuring consistency with the estimate.
   */
  /**
   * Called when the user clicks "Proceed to payment" on step 5.
   * If the trip was already created (e.g. user went Back from payment), just
   * re-enter step 6 without a second API call.
   * Otherwise advance to step 6 and kick off trip creation there.
   */
  function handleGoToPayment() {
    setOverlapTrip(null);
    setStep(6);
    if (!createdTripId) {
      handleBook(false);
    }
  }

  async function handleBook(forceOverlap = false) {
    if (!estimate) return;
    setBooking(true);
    setOverlapTrip(null); // clear any previously shown overlap banner before re-attempting
    try {
      const response = await tripService.create({
        pickup_address:      estimate.pickup.address,
        dropoff_address:     estimate.dropoff.address,
        pickup_lat:          estimate.pickup.lat,
        pickup_lon:          estimate.pickup.lon,
        dropoff_lat:         estimate.dropoff.lat,
        dropoff_lon:         estimate.dropoff.lon,
        departure_at:        buildISO(departDate, departTime),
        // Only include return_at when all three return fields are filled in
        return_at:           hasReturn && returnDate && returnTime
                               ? buildISO(returnDate, returnTime) : null,
        passenger_count:     passengers,
        distance_km:         estimate.distance_km,
        duration_minutes:    estimate.duration_minutes,
        estimated_cost:      estimate.estimated_cost,
        preferred_driver_id: selectedDriver?.id || null,
        client_notes:        clientNotes.trim() || null,
        // `confirm_overlap` is only sent (as true) when the user explicitly
        // chooses to create the trip despite a detected overlap.
        confirm_overlap:     forceOverlap || undefined,
      });
      // Capture the newly created trip ID for the payment step.
      // The API response nests the trip object differently depending on the
      // backend version; check both shapes.
      const tripId = response.data.trip?.id || response.data.id;
      setCreatedTripId(tripId);
      setStep(6); // → payment step
    } catch (err) {
      const code = err.response?.data?.code;
      const msg  = err.response?.data?.error || t('common.error', { defaultValue: 'An error occurred.' });
      if (code === 'OVERLAPPING_TRIP') {
        // Store overlap details for the inline amber banner — a toast would
        // auto-dismiss and the user might miss the choice to confirm or cancel.
        setOverlapTrip({
          trip_number:  err.response.data.trip_number,
          departure_at: err.response.data.departure_at,
        });
      } else if (code === 'RETURN_TOO_LATE' || code === 'RETURN_GAP_TOO_SHORT') {
        // Server-side enforcement of return time window; send back to fix dates
        toast.error(msg);
        setStep(2);
      } else if (code === 'MISSING_COORDINATES') {
        // Coordinates were not saved on the estimate; user must re-estimate
        toast.error(msg);
        setStep(2);
      } else if (code === 'DRIVER_UNAVAILABLE') {
        // Driver became unavailable between step 4 and the final submit
        toast.error(msg);
        setSelectedDriver(null);
        setStep(4);
      } else if (code === 'INSUFFICIENT_LEAD_TIME') {
        // Server-side lead-time guard (could fire if config changed after page load)
        toast.error(msg);
        setStep(2);
      } else if (code === 'TOO_FAR_IN_ADVANCE') {
        // Server-side max-advance guard (same as above)
        toast.error(msg);
        setStep(2);
      } else {
        toast.error(msg);
      }
    } finally {
      setBooking(false);
    }
  }

  /**
   * Resets the entire wizard back to step 1 with all fields cleared.
   * Called from the success screen's "New request" button so the user can
   * book another trip without a full page reload.
   */
  function reset() {
    setStep(1); setPickup(''); setDropoff(''); setPassengers(1);
    setDepartDate(''); setDepartTime('');
    setHasReturn(false); setReturnDate(''); setReturnTime(''); setReturnErr('');
    setEstimate(null); setGeocodeErr('');
    setSelectedDriver(null); setNearbyDrivers([]);
    setSearchQuery(''); setSearchResults([]);
    setClientNotes(''); setOverlapTrip(null);
    setCreatedTripId(null);
  }

  // Step labels for StepIndicator — one entry per visible step (steps 1–6).
  // Step 7 (success) is excluded because it renders outside the StepIndicator layout.
  // Translations are resolved at render time so locale switches are reflected immediately.
  const stepLabels = [
    t('trips.step_addresses'),
    t('trips.step_schedule'),
    t('trips.estimate_title'),
    t('trips.step_driver'),
    t('trips.step_confirm'),
    t('payment.step_title'),
  ];

  // ── SUCCESS (step 7) ──────────────────────────────────────────
  // Rendered as an early return so the step indicator and wizard card
  // are not shown — the success screen stands alone.
  if (step === 7) return (
    <div className="max-w-lg mx-auto">
      <div className="card text-center py-12">
        <div className="w-16 h-16 bg-teal-100 dark:bg-teal-900/40 rounded-full flex items-center justify-center
                        text-4xl mx-auto mb-5">✅</div>
        <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-3">{t('trips.booked_title')}</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-8 leading-relaxed max-w-xs mx-auto">
          {t('trips.booked_message')}
        </p>
        <div className="flex gap-3 justify-center flex-wrap">
          <Link to="/client/trips" className="btn-primary">{t('trips.booked_cta')}</Link>
          <button onClick={reset} className="btn-secondary">{t('trips.new_request')}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="mb-2">{t('trips.new_trip_title')}</h1>
      {/* Step indicator shows steps 1–5; step 6 (success) uses its own layout above */}
      <StepIndicator current={step} steps={stepLabels} />

      {/* ── STEP 1 — Addresses ──────────────────────────── */}
      {step === 1 && (
        <form onSubmit={handleStep1} className="card space-y-5">
          <h2 className="text-base font-semibold">{t('trips.step_addresses')}</h2>
          {/* Tip banner — reminds users to enter full addresses for accurate geocoding */}
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 rounded-lg p-3">
            <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">💡 {t('trips.address_tip')}</p>
          </div>
          <div>
            <label className="label">{t('trips.pickup')}</label>
            <div className="relative">
              {/* Green dot icon is purely decorative; pointer-events-none prevents
                  it from intercepting clicks destined for the input below */}
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-green-500 text-lg z-10 pointer-events-none">●</span>
              <AddressAutocomplete
                value={pickup}
                onChange={setPickup}
                onSelect={({ label }) => setPickup(label)}
                placeholder={t('trips.pickup_placeholder')}
                required
                inputClassName="pl-8"
              />
            </div>
          </div>
          <div>
            <label className="label">{t('trips.dropoff')}</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-red-500 text-lg z-10 pointer-events-none">●</span>
              <AddressAutocomplete
                value={dropoff}
                onChange={setDropoff}
                onSelect={({ label }) => setDropoff(label)}
                placeholder={t('trips.dropoff_placeholder')}
                required
                inputClassName="pl-8"
              />
            </div>
          </div>
          <div>
            <label className="label">{t('trips.passenger_count')}</label>
            {/* Stepper widget — clamped between 1 and 7 (typical van capacity) */}
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => setPassengers(p => Math.max(1, p - 1))}
                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 text-xl font-bold
                           flex items-center justify-center">−</button>
              <span className="text-xl font-bold w-8 text-center">{passengers}</span>
              <button type="button" onClick={() => setPassengers(p => Math.min(7, p + 1))}
                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 text-xl font-bold
                           flex items-center justify-center">+</button>
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('trips.passengers')}</span>
            </div>
          </div>
          <button type="submit" className="btn-primary w-full">
            {t('common.next', { defaultValue: 'Suivant →' })}
          </button>
        </form>
      )}

      {/* ── STEP 2 — Schedule ───────────────────────────── */}
      {step === 2 && (
        <form onSubmit={handleEstimate} className="card space-y-5">
          <h2 className="text-base font-semibold">{t('trips.step_schedule')}</h2>
          <div>
            <label className="label">📅 {t('trips.departure_date')}</label>
            {/* `min` and `max` enforce the booking window in the browser date picker.
                The same constraints are checked in handleEstimate and server-side. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-gray-400 mb-1">{t('trips.label_date')}</p>
                <input className="input" type="date" min={todayStr()} max={maxDateStr(config.maxAdvanceDays)}
                  value={departDate} onChange={e => setDepartDate(e.target.value)} required />
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">{t('trips.label_time')}</p>
                <input className="input" type="time"
                  value={departTime} onChange={e => setDepartTime(e.target.value)} required />
              </div>
            </div>
          </div>
          {/* Return trip toggle — displayed as a custom toggle switch */}
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              {/* Toggle button — uses type="button" to prevent form submission */}
              <button type="button" onClick={() => { setHasReturn(v => !v); setReturnErr(''); }}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full
                  transition-colors ${hasReturn ? 'bg-teal-500' : 'bg-gray-300'}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-800 shadow
                  transition-transform ${hasReturn ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('trips.return_date')}</p>
                {/* Show the configured max return window so users know the constraint upfront */}
                <p className="text-xs text-gray-400">
                  {t('trips.return_hint')}
                  {' '}
                  <span className="text-teal-600 dark:text-teal-400 font-medium">
                    (max {Math.floor(config.maxReturnMinutes / 60)}h
                    {config.maxReturnMinutes % 60 > 0 ? `${config.maxReturnMinutes % 60}min` : ''})
                  </span>
                </p>
              </div>
            </label>
            {/* Return date/time inputs — only rendered when toggle is on */}
            {hasReturn && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <p className="text-xs text-gray-400 mb-1">{t('trips.label_date')}</p>
                  <input className="input" type="date" min={departDate || todayStr()}
                    value={returnDate} onChange={e => { setReturnDate(e.target.value); setReturnErr(''); }}
                    required={hasReturn} />
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">{t('trips.label_time')}</p>
                  <input className="input" type="time"
                    value={returnTime} onChange={e => { setReturnTime(e.target.value); setReturnErr(''); }}
                    required={hasReturn} />
                </div>
              </div>
            )}
            {/* Inline return validation error — shown below the return fields */}
            {returnErr && (
              <p className="text-red-500 text-xs">⚠️ {returnErr}</p>
            )}
          </div>
          {/* Geocode error from a previous estimate attempt on this address pair */}
          {geocodeErr && (
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 text-red-600 text-sm rounded-lg p-3">
              ⚠️ {geocodeErr}
            </div>
          )}
          <div className="flex gap-3">
            <button type="button" onClick={() => setStep(1)} className="btn-secondary flex-1">
              {t('trips.back')}
            </button>
            <button type="submit" disabled={estimating} className="btn-primary flex-1">
              {/* Show spinner while the geocoding + routing estimate is in progress */}
              {estimating
                ? <span className="flex items-center gap-2 justify-center">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent
                                     rounded-full animate-spin" />
                    {t('trips.getting_estimate')}
                  </span>
                : t('trips.get_estimate')
              }
            </button>
          </div>
        </form>
      )}

      {/* ── STEP 3 — Estimate ───────────────────────────── */}
      {step === 3 && estimate && (
        <div className="space-y-4">
          {/* Dark teal card displays the three key metrics side-by-side */}
          <div className="card bg-teal-600 text-white">
            <p className="text-teal-200 text-xs font-medium uppercase tracking-wider mb-3">
              {t('trips.estimate_title')}
            </p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-white/10 rounded-xl py-3">
                <p className="text-2xl font-bold">{estimate.distance_km}</p>
                <p className="text-teal-200 text-xs mt-0.5">km</p>
              </div>
              <div className="bg-white/10 rounded-xl py-3">
                <p className="text-2xl font-bold">{formatDuration(estimate.duration_minutes)}</p>
                <p className="text-teal-200 text-xs mt-0.5">{t('trips.duration')}</p>
              </div>
              <div className="bg-white/10 rounded-xl py-3">
                <p className="text-2xl font-bold">{formatAmount(estimate.estimated_cost, i18n.language)} {currencySymbol(config.paymentCurrency)}</p>
              </div>
            </div>
            {/* Haversine fallback warning — shown when the routing API was unavailable
                and the server fell back to straight-line distance calculation.
                The estimate may be less accurate in this case. */}
            {estimate.routing_source === 'haversine' && (
              <p className="text-teal-300 text-xs mt-3 text-center">
                ⚠️ {t('trips.routing_source_haversine')}
              </p>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={() => setStep(2)} className="btn-secondary flex-1">
              {t('trips.back')}
            </button>
            <button onClick={handleGoToDriverStep} className="btn-primary flex-1">
              {t('common.next', { defaultValue: 'Suivant →' })}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 4 — Driver selection ────────────────────── */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="card">
            <h2 className="text-base font-semibold mb-1">{t('trips.driver_nearby_title')}</h2>
            <p className="text-xs text-gray-400 mb-4">
              {t('trips.driver_suggestion_radius_km', {
                defaultValue: `Rayon de recherche : ${config.driverRadius} km`
              })} ({config.driverRadius} km)
            </p>

            {/* Selected driver badge — shown at the top of the card once a driver is chosen */}
            {selectedDriver && (
              <div className="flex items-center gap-3 bg-teal-50 dark:bg-teal-900/30 border border-teal-200
                              rounded-xl p-3 mb-4">
                <span className="text-teal-600 dark:text-teal-400 text-xl">✓</span>
                <div className="flex-1">
                  <p className="text-xs text-teal-600 dark:text-teal-400 font-medium">{t('trips.driver_selected')}</p>
                  <p className="text-sm font-semibold">
                    {selectedDriver.first_name} {selectedDriver.last_name}
                  </p>
                </div>
                {/* ✕ button clears the selection so the user can pick someone else */}
                <button onClick={() => setSelectedDriver(null)}
                  className="text-gray-400 hover:text-red-400 text-xs px-2">✕</button>
              </div>
            )}

            {/* Nearby drivers list — loaded in handleGoToDriverStep when entering this step */}
            {loadingDrivers ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
                <span className="w-4 h-4 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500
                                 rounded-full animate-spin" />
                {t('common.loading')}
              </div>
            ) : nearbyDrivers.length > 0 ? (
              <div className="space-y-2 mb-4">
                {nearbyDrivers.map(d => (
                  <DriverCard key={d.id} driver={d}
                    selected={selectedDriver} onSelect={handleSelectDriver}
                    onReview={setReviewingDriver} checkingId={checkingDriverId} />
                ))}
              </div>
            ) : (
              /* No drivers in radius — user can still find one via the search box below */
              <p className="text-sm text-gray-400 py-3 mb-4">{t('trips.driver_nearby_empty')}</p>
            )}

            {/* Free-text driver name search — searches all active drivers, not just nearby */}
            <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
              <label className="label">{t('trips.driver_search_label')}</label>
              <div className="relative">
                <input className="input pr-8"
                  placeholder={t('trips.driver_search_placeholder')}
                  value={searchQuery}
                  onChange={handleSearchChange} />
                {/* Inline spinner during search — positioned inside the input on the right */}
                {searching && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    <span className="w-4 h-4 border-2 border-gray-200 dark:border-gray-700 border-t-teal-500
                                     rounded-full animate-spin inline-block" />
                  </span>
                )}
              </div>
              {searchResults.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {searchResults.map(d => (
                    <DriverCard key={d.id} driver={d}
                      selected={selectedDriver} onSelect={selectDriver} onReview={setReviewingDriver} />
                  ))}
                </div>
              )}
              {/* "No results" hint — only shown when search has run and returned nothing */}
              {searchQuery.length >= 2 && !searching && searchResults.length === 0 && (
                <p className="text-xs text-gray-400 mt-2">{t('trips.driver_search_empty')}</p>
              )}
            </div>

            {/* Optional note to driver — saved as client_notes on the trip */}
            <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
              <label className="label">
                💬 {t('trips.client_notes_label', { defaultValue: 'Note pour le conducteur' })}
                <span className="text-gray-400 font-normal ml-1">
                  ({t('common.optional', { defaultValue: 'optionnel' })})
                </span>
              </label>
              <textarea
                className="input resize-none"
                rows={3}
                maxLength={500}
                placeholder={t('trips.client_notes_placeholder', {
                  defaultValue: 'Ex: J\'utilise un déambulateur, entrée par la porte latérale, sonnez deux fois…'
                })}
                value={clientNotes}
                onChange={e => setClientNotes(e.target.value)}
              />
              {/* Character counter — helps users stay within the 500-char server limit */}
              <p className="text-xs text-gray-400 mt-1 text-right">
                {clientNotes.length}/500
              </p>
            </div>
          </div>

          {/* Warning shown only when driver is required but none is selected yet */}
          {config.driverRequired && !selectedDriver && (
            <p className="text-amber-600 text-xs text-center">
              ⚠️ {t('trips.driver_required_hint')}
            </p>
          )}

          <div className="flex gap-3">
            <button onClick={() => setStep(3)} className="btn-secondary flex-1">
              {t('trips.back')}
            </button>
            {/* When driver is optional and none is selected, show a "Skip" button instead
                of the normal "Next" button. This makes the optional path explicit. */}
            {!config.driverRequired && !selectedDriver ? (
              <button onClick={() => setStep(5)} className="btn-secondary flex-1">
                {t('trips.driver_skip')}
              </button>
            ) : (
              <button onClick={handleGoToConfirm}
                disabled={config.driverRequired && !selectedDriver}
                className="btn-primary flex-1">
                {t('common.next', { defaultValue: 'Suivant →' })}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── STEP 5 — Summary + confirm ───────────────────── */}
      {step === 5 && estimate && (
        <div className="space-y-4">
          {/* Full trip summary — lets the user review everything before committing */}
          <div className="card">
            <h2 className="text-base font-semibold mb-3">{t('trips.confirm_title')}</h2>
            <SummaryRow icon="🟢" label={t('trips.confirm_pickup')}
              value={estimate.pickup.address} />
            <SummaryRow icon="🔴" label={t('trips.confirm_dropoff')}
              value={estimate.dropoff.address} />
            {/* Departure is formatted as a full human-readable datetime for clarity */}
            <SummaryRow icon="📅" label={t('trips.confirm_departure')}
              value={new Date(`${departDate}T${departTime}`).toLocaleString(
                undefined, { weekday: 'long', year: 'numeric', month: 'long',
                             day: 'numeric', hour: '2-digit', minute: '2-digit' })} />
            {/* Return row only shown when the user opted in to a return trip */}
            {hasReturn && returnDate && returnTime && (
              <SummaryRow icon="🔄" label={t('trips.confirm_return')}
                value={new Date(`${returnDate}T${returnTime}`).toLocaleString(
                  undefined, { weekday: 'long', year: 'numeric', month: 'long',
                               day: 'numeric', hour: '2-digit', minute: '2-digit' })} />
            )}
            <SummaryRow icon="👥" label={t('trips.confirm_passengers')}
              value={`${passengers} ${t('trips.passengers')}`} />
            <SummaryRow icon="📍" label={t('trips.distance')}
              value={`${estimate.distance_km} km — ${formatDuration(estimate.duration_minutes)}`} />
            <SummaryRow icon="💰" label={t('trips.confirm_cost')}
              value={`${formatAmount(estimate.estimated_cost, i18n.language)} ${currencySymbol(config.paymentCurrency)}`} />
            {/* Preferred driver — only shown when the user actually selected one */}
            {selectedDriver && (
              <SummaryRow icon="🚗" label={t('trips.preferred_driver')}
                value={`${selectedDriver.first_name} ${selectedDriver.last_name}`} />
            )}
            {/* Client notes — only shown when the user entered something */}
            {clientNotes.trim() && (
              <SummaryRow icon="💬"
                label={t('trips.client_notes_label', { defaultValue: 'Note pour le conducteur' })}
                value={clientNotes.trim()} />
            )}
          </div>

          <div className="flex gap-3">
            <button onClick={() => setStep(4)} className="btn-secondary flex-1">
              {t('trips.back')}
            </button>
            {/* Advance to payment — trip creation and overlap check happen in step 6 */}
            <button onClick={handleGoToPayment} className="btn-primary flex-1">
              {t('trips.confirm_book')}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 6 — Trip creation + Payment ─────────────── */}
      {/* Trip creation happens here (not in step 5) so that navigating back
          and forth through the summary never triggers duplicate bookings.
          Three sub-states:
            booking=true            → spinner while POST /api/trips is in-flight
            overlapTrip set         → amber banner asking for confirmation
            createdTripId set       → hand off to PaymentStep               */}
      {step === 6 && (
        <>
          {/* Creating trip — spinner */}
          {booking && !createdTripId && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <span className="w-10 h-10 border-4 border-gray-200 dark:border-gray-700 border-t-teal-500
                               rounded-full animate-spin" />
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('trips.confirming')}</p>
            </div>
          )}

          {/* Overlap warning — user must confirm before the trip is created */}
          {overlapTrip && !createdTripId && (
            <div className="space-y-4">
              <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-300 rounded-xl p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <span className="text-2xl flex-shrink-0">⚠️</span>
                  <div>
                    <p className="font-semibold text-amber-800 dark:text-amber-200 text-sm">
                      {t('trips.overlap_warning_title', { defaultValue: 'Trajet en chevauchement' })}
                    </p>
                    <p className="text-amber-700 dark:text-amber-300 text-xs mt-1">
                      {t('trips.overlap_warning_body', {
                        number: overlapTrip.trip_number,
                        date: new Date(overlapTrip.departure_at).toLocaleString(
                          undefined, { weekday: 'short', month: 'short', day: 'numeric',
                                       hour: '2-digit', minute: '2-digit' }),
                        defaultValue: `Le client a déjà un trajet actif (T-${overlapTrip.trip_number}) proche de cette date. Voulez-vous quand même créer ce trajet ?`,
                      })}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  {/* Cancel — go back to step 5 summary */}
                  <button
                    onClick={() => { setOverlapTrip(null); setStep(5); }}
                    className="btn-secondary text-xs py-1.5 px-3">
                    {t('common.cancel', { defaultValue: 'Annuler' })}
                  </button>
                  {/* Confirm — re-submit with confirm_overlap: true, then proceed to payment */}
                  <button onClick={() => handleBook(true)} disabled={booking}
                    className="bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold py-1.5 px-3 rounded-lg transition-colors">
                    {t('trips.overlap_confirm', { defaultValue: 'Créer quand même' })}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Payment — only shown once the trip record exists in the DB */}
          {createdTripId && (
            <PaymentStep
              tripId={createdTripId}
              provider={config.paymentProvider}
              publishableKey={config.stripePublishableKey}
              isOperator={false}
              onComplete={() => setStep(7)}
              onBack={() => setStep(5)}
            />
          )}
        </>
      )}

      {/* ── Driver reviews modal ──────────────────────────── */}
      {reviewingDriver && (
        <DriverReviewsModal
          driver={reviewingDriver}
          onSelect={handleSelectDriver}
          onClose={() => setReviewingDriver(null)}
        />
      )}

      {/* ── Driver conflict modal (Feature A) ────────────── */}
      {/* Shown when the selected preferred driver already has an assigned trip
          that overlaps the requested time window. The client must pick another
          driver — there is no "force" option on the client side. */}
      {driverConflict && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm p-5"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <span className="text-2xl flex-shrink-0">⚠️</span>
              <div>
                <p className="font-semibold text-gray-900 dark:text-gray-50 text-sm mb-1">
                  {t('trips.driver_conflict_title')}
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t('trips.driver_conflict_message', {
                    name:  `${driverConflict.driver.first_name} ${driverConflict.driver.last_name}`,
                    trips: driverConflict.conflicts.map(c => `T-${c.trip_number}`).join(', '),
                  })}
                </p>
              </div>
            </div>
            <button
              onClick={() => setDriverConflict(null)}
              className="w-full px-4 py-2.5 rounded-xl bg-teal-600 text-white text-sm
                         font-medium hover:bg-teal-700 transition-colors">
              {t('trips.driver_conflict_close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
