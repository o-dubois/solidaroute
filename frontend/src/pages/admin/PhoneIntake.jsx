/**
 * Phone Intake — /admin/phone-intake
 *
 * Allows operators to book a trip on behalf of a client who calls in.
 * This is the staff-side mirror of the client-facing NewTrip wizard.
 *
 * Two-phase flow:
 *
 * Phase 1 — Client selection (ClientSearch component)
 *   The operator searches the existing user list by name and/or phone number.
 *   All users with role 'client' are loaded once on mount and filtered
 *   client-side in real time. Clicking a table row selects the client and
 *   advances to Phase 2.
 *
 * Phase 2 — Trip wizard (TripWizard component)
 *   A 5-step form that mirrors the client NewTrip page:
 *     Step 1 — Pickup/dropoff addresses and passenger count
 *     Step 2 — Departure date/time; optional return date/time
 *     Step 3 — Distance/duration/cost estimate returned by the server
 *     Step 4 — Preferred driver selection (nearby + free-text search)
 *     Step 5 — Confirmation summary before final booking
 *   On success the wizard advances to step 6 (a success screen) and the
 *   operator can immediately book another trip for the same or a different client.
 *
 *   The trip is created with `client_id` set to the selected client; the
 *   backend already authorises this for operator and superadmin roles.
 *   Same lead-time, max-advance, return-delay, and overlap rules apply
 *   as for client self-booking.
 *
 * Accessible to: operator, superadmin
 */
import { formatAmount, formatNumber, currencySymbol } from '../../utils/format';
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import api, { tripService, driverService, adminService } from '../../services/api';
import { LoadingPage, StatusBadge, PhoneDisplay, AddressAutocomplete } from '../../components/common';
import PaymentStep from '../../components/payment/PaymentStep';
import toast from 'react-hot-toast';

// ── Shared helpers ─────────────────────────────────────────────

/**
 * todayStr — returns today's date as a YYYY-MM-DD string in local time.
 * Used as the `min` attribute on date inputs to prevent past bookings.
 */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * maxDateStr — returns the date `days` calendar days from now as YYYY-MM-DD.
 * Used as the `max` attribute on date inputs to enforce the max-advance-days
 * booking window configured by the admin.
 *
 * @param {number} days - number of days ahead from today
 */
function maxDateStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * buildISO — combines a YYYY-MM-DD date string and HH:MM time string into
 * a full ISO 8601 UTC timestamp. Returns null if either part is missing.
 * The Date constructor treats the combined local-time string as local time,
 * which is the correct behaviour for trip scheduling.
 *
 * @param {string} date - YYYY-MM-DD
 * @param {string} time - HH:MM
 * @returns {string|null} ISO timestamp string or null
 */
function buildISO(date, time) {
  if (!date || !time) return null;
  return new Date(`${date}T${time}`).toISOString();
}

/**
 * formatDuration — converts a raw number of minutes into a human-readable
 * string such as "45 min" or "1h 30min". Returns '—' for falsy input.
 *
 * @param {number} min - duration in minutes
 * @returns {string}
 */
function formatDuration(min) {
  if (!min) return '—';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}min` : ''}`;
}

/**
 * diffMinutes — returns the signed difference in minutes between two ISO
 * timestamps (b − a). A positive result means b is later than a.
 *
 * @param {string} a - start ISO timestamp
 * @param {string} b - end ISO timestamp
 * @returns {number} difference in minutes
 */
function diffMinutes(a, b) {
  return (new Date(b) - new Date(a)) / 60000;
}

// ── Step indicator ─────────────────────────────────────────────

/**
 * StepIndicator
 *
 * Horizontal progress bar showing the current wizard step.
 * Steps before `current` render with a filled teal circle and a checkmark.
 * The active step renders with a teal ring for emphasis.
 * Future steps are grayed out.
 * Step labels are hidden on mobile (sm:block) to save horizontal space.
 *
 * Props:
 *   current {number} — 1-based index of the active step
 *   steps   {string[]} — array of step label strings
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
 * SummaryRow
 *
 * A single labelled row used in the Step 5 confirmation summary.
 * Displays an icon, a small gray label, and the value in bold below it.
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

/**
 * DriverCard
 *
 * Selectable card representing a single driver option in Step 4.
 * Visually distinguishes three states:
 *   - unavailable: grayed out, pointer-events disabled (driver has marked
 *     themselves unavailable for the requested time window)
 *   - selected: teal border and avatar background with a checkmark
 *   - default: white with a subtle hover border
 *
 * Shows the driver's vehicle info, distance from pickup (if provided by the
 * nearby API), average rating, and review count.
 *
 * Props:
 *   driver   {object}   — driver record from the API
 *   selected {object}   — currently selected driver object (or null)
 *   onSelect {function} — callback invoked with the driver object on click
 */
function DriverCard({ driver, selected, onSelect }) {
  const { t, i18n } = useTranslation();
  const isSelected  = selected?.id === driver.id;
  const unavailable = driver.is_available === false;
  return (
    <button
      type="button"
      onClick={() => { if (!unavailable) onSelect(driver); }}
      disabled={unavailable}
      className={`w-full text-left p-3 rounded-xl border-2 transition-all ${
        unavailable ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 opacity-60 cursor-not-allowed'
          : isSelected ? 'border-teal-400 bg-teal-50 dark:bg-teal-900/30'
          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 bg-white dark:bg-gray-800'
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Avatar — initials-based, colour reflects selection/availability state */}
        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${
          unavailable ? 'bg-gray-200 dark:bg-gray-600 text-gray-400'
            : isSelected ? 'bg-teal-600 text-white'
            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
        }`}>
          {driver.first_name[0]}{driver.last_name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-gray-800 dark:text-gray-100">
            {driver.first_name} {driver.last_name}
            {/* Distance from pickup in km, returned by the nearby-drivers API */}
            {driver.distance_km !== undefined && (
              <span className="text-gray-400 font-normal text-xs ml-2">({driver.distance_km} km)</span>
            )}
          </p>
          <p className="text-xs text-gray-400 truncate">
            {driver.vehicle_make} {driver.vehicle_model} {driver.vehicle_year}
          </p>
          {unavailable && (
            <p className="text-xs text-orange-500 font-medium mt-0.5">
              ⏸ {t('trips.driver_unavailable')}
            </p>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          {parseFloat(driver.average_rating || 0) > 0 ? (
            <>
              <p className="text-sm font-bold text-amber-500">
                ★ {formatNumber(driver.average_rating, 1, i18n.language)}
              </p>
              <p className="text-xs text-gray-400">{driver.review_count} {t('trips.driver_rating')}</p>
            </>
          ) : (
            // New driver — no rating history yet
            <p className="text-xs text-gray-400">{t('admin.phone_intake_new')}</p>
          )}
        </div>
        {isSelected && !unavailable && (
          <span className="text-teal-500 text-lg flex-shrink-0">✓</span>
        )}
      </div>
    </button>
  );
}

// ── Phase 1 — Client search ────────────────────────────────────

/**
 * ClientSearch
 *
 * Phase 1 of the phone intake flow. Renders a searchable table of all
 * clients so the operator can find the caller and select them.
 *
 * All clients are loaded once on mount (no pagination). The list is sorted
 * alphabetically by last name + first name so the operator can scan quickly.
 * Two filter inputs allow simultaneous filtering by:
 *   - name: matches against "First Last" and "Last First" (so partial last
 *     name searches work even when typed in the other order)
 *   - phone: strips non-digits from both the query and the stored value before
 *     comparing, so formatting differences don't cause missed matches.
 *
 * Props:
 *   onSelect {function} — called with the selected client object; causes the
 *                         parent to swap to Phase 2 (TripWizard)
 */
function ClientSearch({ onSelect }) {
  const { t } = useTranslation();
  const [clients, setClients]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [nameQ,   setNameQ]     = useState('');
  const [phoneQ,  setPhoneQ]    = useState('');

  // Load the full client list on mount; sorted by last+first for easy scanning
  useEffect(() => {
    adminService.users({ role: 'client' })
      .then(({ data }) => {
        const sorted = [...(data.users || [])].sort((a, b) =>
          `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`)
        );
        setClients(sorted);
      })
      .catch(() => setClients([]))
      .finally(() => setLoading(false));
  }, []);

  // Apply both name and phone filters simultaneously (AND logic)
  const filtered = clients.filter(c => {
    const nameMatch = nameQ.trim() === '' || (() => {
      const q    = nameQ.toLowerCase();
      // Check both "First Last" and "Last First" orderings so partial last-name
      // queries work even if the operator types the name in a different order
      const full = `${c.first_name} ${c.last_name}`.toLowerCase();
      const rev  = `${c.last_name} ${c.first_name}`.toLowerCase();
      return full.includes(q) || rev.includes(q);
    })();
    // Strip all non-digit characters before comparing so formatted phone
    // numbers (e.g. "+1 (514) 555-0123") still match a raw digit search
    const phoneMatch = phoneQ.trim() === '' ||
      (c.phone || '').replace(/\D/g, '').includes(phoneQ.replace(/\D/g, ''));
    return nameMatch && phoneMatch;
  });

  return (
    <div>
      <h1 className="mb-6">{t('nav.phone_intake')}</h1>

      <div className="card mb-4">
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">
          {t('admin.phone_intake_select_client')}
        </p>
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            className="input flex-1 min-w-[200px]"
            placeholder={t('admin.phone_intake_search_name')}
            value={nameQ}
            onChange={e => setNameQ(e.target.value)}
            autoComplete="off"
          />
          <input
            type="text"
            className="input flex-1 min-w-[160px]"
            placeholder={t('admin.phone_intake_search_phone')}
            value={phoneQ}
            onChange={e => setPhoneQ(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      {loading ? (
        <LoadingPage />
      ) : filtered.length === 0 ? (
        <div className="card text-center py-10 text-gray-400">
          <div className="text-4xl mb-2">🧑</div>
          <p className="text-sm">{t('admin.phone_intake_no_results')}</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 dark:bg-gray-700/50 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <th className="text-left px-4 py-3">{t('auth.first_name')} {t('auth.last_name')}</th>
                <th className="text-left px-4 py-3">{t('auth.phone')}</th>
                <th className="text-left px-4 py-3">{t('admin.drivers_account_status')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, index) => (
                <tr
                  key={c.id}
                  onClick={() => onSelect(c)}
                  // Alternate row shading (zebra striping) for readability
                  className={`border-b last:border-0 cursor-pointer transition-colors hover:bg-teal-50
                    ${index % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50'}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-50">{c.first_name} {c.last_name}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{c.email}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {c.phone ? <PhoneDisplay phone={c.phone} /> : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Phase 2 — Trip wizard ──────────────────────────────────────

/**
 * TripWizard
 *
 * Phase 2 of the phone intake flow. A 5-step booking wizard identical in
 * logic to the client-facing NewTrip page, with the following differences:
 *   - The selected client's name and phone are shown in a persistent banner
 *     at the top of every step, with a "Change client" link.
 *   - The trip is submitted with `client_id` set to the selected client.
 *
 * Configuration values (lead time, max advance days, etc.) are fetched from
 * the public configuration endpoint on mount so that the same server-enforced
 * rules are reflected in the UI. Defaults are set conservatively until the
 * fetch resolves.
 *
 * State overview:
 *   step           — current wizard step (1–5 active, 6 = success screen)
 *   config         — booking rule values pulled from server configuration
 *   pickup/dropoff — free-text address strings entered by the operator
 *   passengers     — passenger count (1–7, controlled with +/- buttons)
 *   departDate/Time — departure date and time (separate fields, combined to ISO on submit)
 *   hasReturn      — whether the trip is round-trip
 *   returnDate/Time — return date/time (only relevant when hasReturn = true)
 *   returnErr      — validation error message for the return time field
 *   estimate       — distance/duration/cost object returned by tripService.estimate()
 *   estimating     — true while the estimate API call is in flight
 *   geocodeErr     — set when the estimate fails due to an unresolvable address
 *   nearbyDrivers  — list of available drivers within driverRadius km of pickup
 *   loadingDrivers — true while the nearby-drivers API call is in flight
 *   selectedDriver — the driver object chosen by the operator (or null)
 *   searchQuery    — free-text query for the driver search input
 *   searchResults  — debounced search results from driverService.search()
 *   searching      — true while a debounced driver search is in flight
 *   clientNotes    — optional note for the driver (max 500 chars)
 *   booking        — true while the final tripService.create() call is in flight
 *
 * Props:
 *   client         {object}   — the client selected in Phase 1
 *   onChangeClient {function} — resets selectedClient in the parent so Phase 1 is shown again
 */
function TripWizard({ client, onChangeClient }) {
  const { t, i18n } = useTranslation();

  const [step, setStep] = useState(1);

  // Booking rule defaults — overwritten once the public config endpoint responds.
  // These conservative defaults prevent the UI from silently allowing invalid
  // bookings if the config fetch fails.
  const [config, setConfig] = useState({
    maxReturnMinutes:    150,
    minLeadHours:        48,
    maxAdvanceDays:      180,
    driverRadius:        10,
    driverRequired:      true,
    paymentProvider:     'manual',  // operators default to manual; overridden by config
    stripePublishableKey: '',
    paymentCurrency:     'CAD',
  });

  // Fetch public configuration rules on mount to mirror server-side validation
  useEffect(() => {
    api.get('/admin/configuration/public').then(({ data }) => {
      const cfg = data.configuration || [];
      // Helper to read a config key with a fallback default value
      const get = (key, def) => cfg.find(c => c.key === key)?.value ?? def;
      setConfig({
        maxReturnMinutes:    parseInt(get('max_return_delay_minutes', '150'), 10),
        minLeadHours:        parseInt(get('min_trip_lead_hours', '48'), 10),
        maxAdvanceDays:      parseInt(get('max_trip_advance_days', '180'), 10),
        driverRadius:        parseFloat(get('driver_suggestion_radius_km', '10')),
        // Config stores booleans as the string 'true'/'false'
        driverRequired:      get('driver_selection_required', 'true') === 'true',
        paymentProvider:     get('payment_provider', 'manual'),
        stripePublishableKey: get('stripe_publishable_key', ''),
        paymentCurrency:     (get('payment_currency', 'CAD')).toUpperCase(),
      });
    }).catch(() => {});
  }, []);

  // ── Step 1 state: addresses ──────────────────────────────────
  const [pickup,     setPickup]     = useState('');
  const [dropoff,    setDropoff]    = useState('');
  const [passengers, setPassengers] = useState(1);

  // ── Step 2 state: schedule ───────────────────────────────────
  const [departDate, setDepartDate] = useState('');
  const [departTime, setDepartTime] = useState('');
  const [hasReturn,  setHasReturn]  = useState(false);
  const [returnDate, setReturnDate] = useState('');
  const [returnTime, setReturnTime] = useState('');
  const [returnErr,  setReturnErr]  = useState('');

  // ── Step 3 state: estimate ───────────────────────────────────
  const [estimate,   setEstimate]   = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [geocodeErr, setGeocodeErr] = useState('');

  // ── Step 4 state: driver selection ──────────────────────────
  const [nearbyDrivers,  setNearbyDrivers]  = useState([]);
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [searchQuery,    setSearchQuery]    = useState('');
  const [searchResults,  setSearchResults]  = useState([]);
  const [searching,      setSearching]      = useState(false);
  const [clientNotes,    setClientNotes]    = useState('');
  // Ref used to debounce the driver name search so we don't hammer the API
  const searchTimer = useRef(null);

  // True while the final booking API call is in flight
  const [booking, setBooking] = useState(false);

  // ── Payment state ────────────────────────────────────────────
  // paymentMethod: which payment method the operator has selected.
  // Defaults to 'manual'; switches to 'stripe' only when the operator chooses
  // it and Stripe is configured (stripePublishableKey is non-empty).
  const [paymentMethod,  setPaymentMethod]  = useState('manual');

  // createdTripId: the ID of the trip created by handleBook().
  // Populated on success so PaymentStep can associate the payment.
  const [createdTripId,  setCreatedTripId]  = useState(null);

  // paymentDone: set to true after PaymentStep calls onComplete().
  // Triggers the success screen while keeping the trip/payment IDs available.
  const [_paymentDone,   setPaymentDone]    = useState(false);

  /**
   * validateReturn — checks that the return time is valid relative to departure.
   *
   * Business rules enforced here (mirroring server-side validation):
   *   1. Return must be strictly after departure.
   *   2. Gap between departure and return must not exceed maxReturnMinutes
   *      (configurable; default 150 min / 2h 30min). This prevents
   *      volunteers from being committed to excessively long service windows.
   *
   * @returns {boolean} true if valid (or if no return is set)
   */
  function validateReturn() {
    if (!hasReturn || !returnDate || !returnTime) return true;
    const dept = buildISO(departDate, departTime);
    const ret  = buildISO(returnDate, returnTime);
    const diff = diffMinutes(dept, ret);
    if (diff < 0) { setReturnErr(t('trips.return_after_departure', { defaultValue: 'Return must be after departure.' })); return false; }
    if (diff > config.maxReturnMinutes) {
      const h = Math.floor(config.maxReturnMinutes / 60);
      const m = config.maxReturnMinutes % 60;
      setReturnErr(t('trips.return_too_late', { max: config.maxReturnMinutes }) + ` (max ${h > 0 ? `${h}h` : ''}${m > 0 ? `${m}min` : ''})`);
      return false;
    }
    setReturnErr(''); return true;
  }

  /**
   * handleStep1 — advances from Step 1 (addresses) to Step 2 (schedule).
   * The form's required attributes handle empty-field validation.
   */
  function handleStep1(e) { e.preventDefault(); setStep(2); }

  /**
   * handleEstimate — validates the schedule and requests a fare + distance
   * estimate from the server (Step 2 → Step 3).
   *
   * Business rules checked before the API call:
   *   - min_trip_lead_hours: departure must be at least N hours in the future.
   *   - max_trip_advance_days: departure must not be more than N days away.
   *   - return time validity (delegated to validateReturn()).
   *
   * If geocoding fails on the server (bad address), the error is surfaced
   * inline below the form rather than as a toast, to keep the operator on
   * the same step for easy correction.
   */
  async function handleEstimate(e) {
    e.preventDefault();
    if (!validateReturn()) return;

    const departure = new Date(`${departDate}T${departTime}`);
    // Enforce minimum lead time — prevents same-hour bookings that drivers
    // couldn't realistically accept in time
    if (config.minLeadHours > 0 && (departure - new Date()) / 3600000 < config.minLeadHours) {
      toast.error(t('trips.lead_time_error', {
        hours: config.minLeadHours,
        defaultValue: `Le départ doit être planifié au moins ${config.minLeadHours} heures à l'avance.`,
      }));
      return;
    }
    // Enforce maximum advance booking window
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

    setGeocodeErr(''); setEstimating(true);
    try {
      const { data } = await tripService.estimate({
        pickup_address:  pickup.trim(),
        dropoff_address: dropoff.trim(),
        passenger_count: passengers,
        has_return:      hasReturn,
      });
      setEstimate(data); setStep(3);
    } catch (err) {
      // Surface geocoding failures inline so the operator can correct the address
      const msg = err.response?.data?.error || '';
      if (msg.toLowerCase().includes('geocod') || msg.toLowerCase().includes('address')) {
        setGeocodeErr(t('trips.geocode_error'));
      }
    } finally { setEstimating(false); }
  }

  /**
   * handleGoToDriverStep — fetches nearby available drivers and advances to
   * Step 4. The pickup coordinates from the estimate response are used as the
   * centre point for the radius search, so we don't need a separate geocode call.
   */
  async function handleGoToDriverStep() {
    setStep(4); setLoadingDrivers(true);
    try {
      const { data } = await driverService.nearby({
        lat: estimate.pickup.lat, lon: estimate.pickup.lon, radius: config.driverRadius,
      });
      setNearbyDrivers(data.drivers || []);
    } catch { setNearbyDrivers([]); }
    finally { setLoadingDrivers(false); }
  }

  /**
   * handleSearchChange — debounced free-text driver search.
   *
   * We wait 300 ms after the last keystroke before firing the API call to
   * avoid hammering the server on every character. Queries shorter than 2
   * characters are ignored to prevent overly broad results.
   *
   * The pickup coordinates are passed to the search endpoint so results can
   * be ranked by proximity to the pickup point.
   */
  function handleSearchChange(e) {
    const q = e.target.value;
    setSearchQuery(q);
    clearTimeout(searchTimer.current);
    if (q.length < 2) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await driverService.search(q, estimate?.pickup?.lat, estimate?.pickup?.lon);
        setSearchResults(data.drivers || []);
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 300);
  }

  /**
   * selectDriver — sets the chosen driver and clears the search UI.
   * Clearing the query and results collapses the dropdown cleanly.
   */
  function selectDriver(driver) { setSelectedDriver(driver); setSearchQuery(''); setSearchResults([]); }

  /**
   * handleGoToConfirm — advances from Step 4 to the confirmation screen.
   * Blocked if `driverRequired` is true and no driver has been chosen.
   */
  function handleGoToConfirm() { if (config.driverRequired && !selectedDriver) return; setStep(5); }

  /**
   * handleBook — submits the final trip booking (Step 5).
   *
   * Sends all collected data to the API with `client_id` set to the operator-
   * selected client (the backend authorises this for operator/superadmin roles).
   *
   * Error handling maps known server error codes back to specific wizard steps
   * so the operator lands on the right step to fix the problem:
   *   RETURN_TOO_LATE / MISSING_COORDINATES / INSUFFICIENT_LEAD_TIME → Step 2
   *   DRIVER_UNAVAILABLE → Step 4 (clears the selected driver so they must re-pick)
   */
  async function handleBook() {
    if (!estimate) return;
    setBooking(true);
    try {
      const response = await tripService.create({
        client_id:           client.id,
        pickup_address:      estimate.pickup.address,
        dropoff_address:     estimate.dropoff.address,
        pickup_lat:          estimate.pickup.lat,
        pickup_lon:          estimate.pickup.lon,
        dropoff_lat:         estimate.dropoff.lat,
        dropoff_lon:         estimate.dropoff.lon,
        departure_at:        buildISO(departDate, departTime),
        // Only include return_at if all three return fields are filled
        return_at:           hasReturn && returnDate && returnTime ? buildISO(returnDate, returnTime) : null,
        passenger_count:     passengers,
        distance_km:         estimate.distance_km,
        duration_minutes:    estimate.duration_minutes,
        estimated_cost:      estimate.estimated_cost,
        // preferred_driver_id is advisory — the driver must still accept the trip
        preferred_driver_id: selectedDriver?.id || null,
        client_notes:        clientNotes.trim() || null,
      });
      // Capture the new trip ID for the payment step that follows
      const tripId = response.data.trip?.id || response.data.id;
      setCreatedTripId(tripId);
      setStep(6); // → payment step
    } catch (err) {
      const code = err.response?.data?.code;
      const msg  = err.response?.data?.error || t('common.error');
      if (code === 'RETURN_TOO_LATE' || code === 'MISSING_COORDINATES' || code === 'INSUFFICIENT_LEAD_TIME') {
        // Date/time related errors — send the operator back to the schedule step
        toast.error(msg); setStep(2);
      } else if (code === 'DRIVER_UNAVAILABLE') {
        // The preferred driver became unavailable between selection and booking
        toast.error(msg); setSelectedDriver(null); setStep(4);
      } else { toast.error(msg); }
    } finally { setBooking(false); }
  }

  /**
   * resetWizard — resets all wizard state back to Step 1 so the operator
   * can immediately book another trip for the same client without a page reload.
   */
  function resetWizard() {
    setStep(1); setPickup(''); setDropoff(''); setPassengers(1);
    setDepartDate(''); setDepartTime('');
    setHasReturn(false); setReturnDate(''); setReturnTime(''); setReturnErr('');
    setEstimate(null); setGeocodeErr('');
    setSelectedDriver(null); setNearbyDrivers([]);
    setSearchQuery(''); setSearchResults([]);
    setClientNotes('');
    setCreatedTripId(null); setPaymentDone(false); setPaymentMethod('manual');
  }

  // Step labels shown in the StepIndicator bar (steps 1–6; step 7 = success screen)
  const stepLabels = [
    t('trips.step_addresses'), t('trips.step_schedule'),
    t('trips.estimate_title'), t('trips.step_driver'),
    t('trips.step_confirm'),   t('payment.step_title'),
  ];

  // ── Client banner (always visible) ──────────────────────────
  // Displayed above the wizard on every step so the operator can always see
  // whose trip they are booking and can switch clients if needed.
  const ClientBanner = (
    <div className="flex items-center justify-between bg-teal-50 dark:bg-teal-900/30 border border-teal-200
                    rounded-xl px-4 py-3 mb-6">
      <div>
        <p className="text-xs text-teal-500 font-medium">{t('admin.phone_intake_booking_for')}</p>
        <p className="text-sm font-bold text-teal-800 dark:text-teal-200">
          🧑 {client.first_name} {client.last_name}
        </p>
        {client.phone && <p className="text-xs text-teal-600 dark:text-teal-400 mt-0.5">📞 <PhoneDisplay phone={client.phone} /></p>}
      </div>
      <button
        onClick={onChangeClient}
        className="text-xs text-teal-600 dark:text-teal-400 hover:text-teal-800 underline flex-shrink-0 ml-4"
      >
        {t('admin.phone_intake_change_client')}
      </button>
    </div>
  );

  // ── SUCCESS ──────────────────────────────────────────────────
  // Step 7 is a terminal success screen. The operator can either book another
  // trip for the same client (resetWizard) or switch to a different client.
  if (step === 7) return (
    <div className="max-w-lg mx-auto">
      {ClientBanner}
      <div className="card text-center py-12">
        <div className="w-16 h-16 bg-teal-100 dark:bg-teal-900/40 rounded-full flex items-center justify-center text-4xl mx-auto mb-5">✅</div>
        <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-3">{t('trips.booked_title')}</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-8 leading-relaxed max-w-xs mx-auto">
          {t('trips.booked_message')}
        </p>
        {/* Show a note about which payment method was used for record-keeping */}
        <p className="text-xs text-gray-400 mb-6">
          {paymentMethod === 'stripe'   && `💳 ${t('payment.card_on_file')}`}
          {paymentMethod === 'manual'   && `📄 ${t('payment.method_manual')} — ${t('payment.confirm_manual')}`}
          {paymentMethod === 'mobility' && `🎫 ${t('payment.method_mobility')}`}
        </p>
        <div className="flex gap-3 justify-center flex-wrap">
          <button onClick={resetWizard} className="btn-primary">
            {t('admin.phone_intake_another_trip')}
          </button>
          <button onClick={onChangeClient} className="btn-secondary">
            {t('admin.phone_intake_change_client')}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="mb-2">{t('nav.phone_intake')}</h1>
      {ClientBanner}
      <StepIndicator current={step} steps={stepLabels} />

      {/* STEP 1 — Addresses
          The operator enters pickup and dropoff addresses using the shared
          AddressAutocomplete component, and sets the passenger count (1–7).
          Submitting this step does NOT call the API; data is held in state
          until Step 2 triggers the estimate call. */}
      {step === 1 && (
        <form onSubmit={handleStep1} className="card space-y-5">
          <h2 className="text-base font-semibold">{t('trips.step_addresses')}</h2>
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 rounded-lg p-3">
            <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">💡 {t('trips.address_tip')}</p>
          </div>
          <div>
            <label className="label">{t('trips.pickup')}</label>
            <div className="relative">
              {/* Green dot decorates the pickup field to match the map pin convention */}
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
              {/* Red dot decorates the dropoff field to match the map pin convention */}
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
            {/* Stepper buttons instead of a raw number input for faster one-handed operation */}
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => setPassengers(p => Math.max(1, p - 1))}
                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 text-xl font-bold flex items-center justify-center">−</button>
              <span className="text-xl font-bold w-8 text-center">{passengers}</span>
              <button type="button" onClick={() => setPassengers(p => Math.min(7, p + 1))}
                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 text-xl font-bold flex items-center justify-center">+</button>
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('trips.passengers')}</span>
            </div>
          </div>
          <button type="submit" className="btn-primary w-full">
            {t('common.next', { defaultValue: 'Suivant →' })}
          </button>
        </form>
      )}

      {/* STEP 2 — Schedule
          The operator picks a departure date/time and, optionally, a return
          date/time for round trips. Submitting this step calls tripService.estimate()
          to get a route distance, duration, and fare estimate from the server.
          The date input's min/max attributes enforce the booking window without
          relying solely on server-side validation. */}
      {step === 2 && (
        <form onSubmit={handleEstimate} className="card space-y-5">
          <h2 className="text-base font-semibold">{t('trips.step_schedule')}</h2>
          <div>
            <label className="label">📅 {t('trips.departure_date')}</label>
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
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
            {/* Toggle switch to enable the return trip fields */}
            <label className="flex items-center gap-3 cursor-pointer">
              <button type="button" onClick={() => { setHasReturn(v => !v); setReturnErr(''); }}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${hasReturn ? 'bg-teal-500' : 'bg-gray-300'}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-800 shadow transition-transform ${hasReturn ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('trips.return_date')}</p>
                {/* Show the configured max return delay so the operator knows the constraint */}
                <p className="text-xs text-gray-400">
                  {t('trips.return_hint')}{' '}
                  <span className="text-teal-600 dark:text-teal-400 font-medium">
                    (max {Math.floor(config.maxReturnMinutes / 60)}h{config.maxReturnMinutes % 60 > 0 ? `${config.maxReturnMinutes % 60}min` : ''})
                  </span>
                </p>
              </div>
            </label>
            {/* Return date/time inputs — only rendered when the toggle is on */}
            {hasReturn && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <p className="text-xs text-gray-400 mb-1">{t('trips.label_date')}</p>
                  <input className="input" type="date" min={departDate || todayStr()}
                    value={returnDate} onChange={e => { setReturnDate(e.target.value); setReturnErr(''); }} required={hasReturn} />
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">{t('trips.label_time')}</p>
                  <input className="input" type="time"
                    value={returnTime} onChange={e => { setReturnTime(e.target.value); setReturnErr(''); }} required={hasReturn} />
                </div>
              </div>
            )}
            {/* Inline validation error for the return time (shown below the inputs) */}
            {returnErr && <p className="text-red-500 text-xs">⚠️ {returnErr}</p>}
          </div>
          {/* Inline geocoding error — shown when the server couldn't resolve an address */}
          {geocodeErr && (
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 text-red-600 text-sm rounded-lg p-3">⚠️ {geocodeErr}</div>
          )}
          <div className="flex gap-3">
            <button type="button" onClick={() => setStep(1)} className="btn-secondary flex-1">{t('trips.back')}</button>
            <button type="submit" disabled={estimating} className="btn-primary flex-1">
              {estimating
                ? <span className="flex items-center gap-2 justify-center">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {t('trips.getting_estimate')}
                  </span>
                : t('trips.get_estimate')}
            </button>
          </div>
        </form>
      )}

      {/* STEP 3 — Estimate
          Displays the distance, duration, and estimated fare returned by the
          server after geocoding and routing. If the routing engine fell back
          to straight-line (haversine) distance because a road route could not
          be found, a warning is shown so the operator knows the estimate may
          be inaccurate. The operator can go back to correct addresses or
          proceed to driver selection. */}
      {step === 3 && estimate && (
        <div className="space-y-4">
          <div className="card bg-teal-600 text-white">
            <p className="text-teal-200 text-xs font-medium uppercase tracking-wider mb-3">{t('trips.estimate_title')}</p>
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
            {/* haversine fallback warning — straight-line distance is less accurate than road routing */}
            {estimate.routing_source === 'haversine' && (
              <p className="text-teal-300 text-xs mt-3 text-center">⚠️ {t('trips.routing_source_haversine')}</p>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={() => setStep(2)} className="btn-secondary flex-1">{t('trips.back')}</button>
            <button onClick={handleGoToDriverStep} className="btn-primary flex-1">
              {t('common.next', { defaultValue: 'Suivant →' })}
            </button>
          </div>
        </div>
      )}

      {/* STEP 4 — Driver selection
          Displays two driver lists:
            1. Nearby drivers — auto-loaded within the configured radius of the pickup point.
            2. Search — debounced free-text search across all drivers for when
               the caller has a specific driver preference outside the radius.
          A notes field lets the operator pass a message from the client to
          the driver (e.g. special instructions, mobility requirements).
          When `driverRequired` config is true the "Next" button is disabled
          until a driver is chosen; otherwise a "Skip" button is available. */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="card">
            <h2 className="text-base font-semibold mb-1">{t('trips.driver_nearby_title')}</h2>
            <p className="text-xs text-gray-400 mb-4">({config.driverRadius} km)</p>
            {/* Currently selected driver banner — shown above the list for clarity */}
            {selectedDriver && (
              <div className="flex items-center gap-3 bg-teal-50 dark:bg-teal-900/30 border border-teal-200 rounded-xl p-3 mb-4">
                <span className="text-teal-600 dark:text-teal-400 text-xl">✓</span>
                <div className="flex-1">
                  <p className="text-xs text-teal-600 dark:text-teal-400 font-medium">{t('trips.driver_selected')}</p>
                  <p className="text-sm font-semibold">{selectedDriver.first_name} {selectedDriver.last_name}</p>
                </div>
                {/* Deselect button — clears the choice so the operator can pick again */}
                <button onClick={() => setSelectedDriver(null)} className="text-gray-400 hover:text-red-400 text-xs px-2">✕</button>
              </div>
            )}
            {/* Nearby drivers list — loaded when entering this step */}
            {loadingDrivers ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
                <span className="w-4 h-4 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
                {t('common.loading')}
              </div>
            ) : nearbyDrivers.length > 0 ? (
              <div className="space-y-2 mb-4">
                {nearbyDrivers.map(d => (
                  <DriverCard key={d.id} driver={d} selected={selectedDriver} onSelect={selectDriver} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400 py-3 mb-4">{t('trips.driver_nearby_empty')}</p>
            )}
            {/* Free-text driver search — debounced, minimum 2 characters */}
            <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
              <label className="label">{t('trips.driver_search_label')}</label>
              <div className="relative">
                <input className="input pr-8" placeholder={t('trips.driver_search_placeholder')}
                  value={searchQuery} onChange={handleSearchChange} />
                {/* Spinner shown while a search request is in flight */}
                {searching && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    <span className="w-4 h-4 border-2 border-gray-200 dark:border-gray-700 border-t-teal-500 rounded-full animate-spin inline-block" />
                  </span>
                )}
              </div>
              {searchResults.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {searchResults.map(d => (
                    <DriverCard key={d.id} driver={d} selected={selectedDriver} onSelect={selectDriver} />
                  ))}
                </div>
              )}
              {/* Empty state — only shown after a completed search with no results */}
              {searchQuery.length >= 2 && !searching && searchResults.length === 0 && (
                <p className="text-xs text-gray-400 mt-2">{t('trips.driver_search_empty')}</p>
              )}
            </div>
            {/* Optional note for the driver — forwarded to the driver's trip detail view */}
            <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
              <label className="label">
                💬 {t('trips.client_notes_label', { defaultValue: 'Note pour le conducteur' })}
                <span className="text-gray-400 font-normal ml-1">({t('common.optional')})</span>
              </label>
              <textarea className="input resize-none" rows={3} maxLength={500}
                placeholder={t('trips.client_notes_placeholder', { defaultValue: '' })}
                value={clientNotes} onChange={e => setClientNotes(e.target.value)} />
              <p className="text-xs text-gray-400 mt-1 text-right">{clientNotes.length}/500</p>
            </div>
          </div>
          {/* Show a warning if the config requires a driver but none is selected yet */}
          {config.driverRequired && !selectedDriver && (
            <p className="text-amber-600 text-xs text-center">⚠️ {t('trips.driver_required_hint')}</p>
          )}
          <div className="flex gap-3">
            <button onClick={() => setStep(3)} className="btn-secondary flex-1">{t('trips.back')}</button>
            {/* Show "Skip" instead of "Next" when driver is optional and none is chosen */}
            {!config.driverRequired && !selectedDriver ? (
              <button onClick={() => setStep(5)} className="btn-secondary flex-1">{t('trips.driver_skip')}</button>
            ) : (
              <button onClick={handleGoToConfirm} disabled={config.driverRequired && !selectedDriver} className="btn-primary flex-1">
                {t('common.next', { defaultValue: 'Suivant →' })}
              </button>
            )}
          </div>
        </div>
      )}

      {/* STEP 5 — Confirm
          Read-only summary of all collected booking details. The operator
          reviews the information before clicking "Confirm" to submit.
          On success the component transitions to step 6 (success screen). */}
      {step === 5 && estimate && (
        <div className="space-y-4">
          <div className="card">
            <h2 className="text-base font-semibold mb-3">{t('trips.confirm_title')}</h2>
            <SummaryRow icon="🟢" label={t('trips.confirm_pickup')}    value={estimate.pickup.address} />
            <SummaryRow icon="🔴" label={t('trips.confirm_dropoff')}   value={estimate.dropoff.address} />
            {/* Format departure as a full locale date string for unambiguous display */}
            <SummaryRow icon="📅" label={t('trips.confirm_departure')}
              value={new Date(`${departDate}T${departTime}`).toLocaleString(undefined, {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
              })} />
            {hasReturn && returnDate && returnTime && (
              <SummaryRow icon="🔄" label={t('trips.confirm_return')}
                value={new Date(`${returnDate}T${returnTime}`).toLocaleString(undefined, {
                  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                  hour: '2-digit', minute: '2-digit'
                })} />
            )}
            <SummaryRow icon="👥" label={t('trips.confirm_passengers')}
              value={`${passengers} ${t('trips.passengers')}`} />
            <SummaryRow icon="📍" label={t('trips.distance')}
              value={`${estimate.distance_km} km — ${formatDuration(estimate.duration_minutes)}`} />
            <SummaryRow icon="💰" label={t('trips.confirm_cost')}
              value={`${formatAmount(estimate.estimated_cost, i18n.language)} ${currencySymbol(config.paymentCurrency)}`} />
            {selectedDriver && (
              <SummaryRow icon="🚗" label={t('trips.preferred_driver')}
                value={`${selectedDriver.first_name} ${selectedDriver.last_name}`} />
            )}
            {clientNotes.trim() && (
              <SummaryRow icon="💬" label={t('trips.client_notes_label', { defaultValue: 'Note' })}
                value={clientNotes.trim()} />
            )}
          </div>
          {/* ── Payment method selector ──────────────────────────────────────
              Shown in the confirmation step so the operator can choose how
              the client will pay before the trip is created. Only Stripe
              and Manual are currently supported. The Stripe option is hidden
              when no publishable key is configured (not set up yet). */}
          <div className="card space-y-3">
            <p className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">
              💳 {t('payment.step_title')}
            </p>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name="paymentMethodSelector"
                value="manual"
                checked={paymentMethod === 'manual'}
                onChange={() => setPaymentMethod('manual')}
                className="w-4 h-4 text-teal-600 dark:text-teal-400"
              />
              <span className="text-sm text-gray-800 dark:text-gray-100">📄 {t('payment.method_manual')}</span>
            </label>
            {/* Stripe option only shown when a publishable key is configured */}
            {config.stripePublishableKey && (
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="paymentMethodSelector"
                  value="stripe"
                  checked={paymentMethod === 'stripe'}
                  onChange={() => setPaymentMethod('stripe')}
                  className="w-4 h-4 text-teal-600 dark:text-teal-400"
                />
                <span className="text-sm text-gray-800 dark:text-gray-100">💳 {t('payment.method_stripe')}</span>
              </label>
            )}
            {/* Mobility tickets — always available */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name="paymentMethodSelector"
                value="mobility"
                checked={paymentMethod === 'mobility'}
                onChange={() => setPaymentMethod('mobility')}
                className="w-4 h-4 text-teal-600 dark:text-teal-400"
              />
              <span className="text-sm text-gray-800 dark:text-gray-100">🎫 {t('payment.method_mobility')}</span>
            </label>
          </div>

          <div className="flex gap-3">
            <button onClick={() => setStep(4)} className="btn-secondary flex-1">{t('trips.back')}</button>
            <button onClick={handleBook} disabled={booking} className="btn-primary flex-1">
              {booking
                ? <span className="flex items-center gap-2 justify-center">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {t('trips.confirming')}
                  </span>
                : t('trips.confirm_book')}
            </button>
          </div>
        </div>
      )}

      {/* STEP 6 — Payment
          Rendered after the trip is created. The operator either processes
          the client's card (Stripe path) or records a manual payment reference.
          onComplete advances to step 7 (success screen). */}
      {step === 6 && (
        <PaymentStep
          tripId={createdTripId}
          provider={paymentMethod}
          publishableKey={config.stripePublishableKey}
          isOperator={true}
          onComplete={() => setStep(7)}
          onBack={() => setStep(5)}
        />
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────

/**
 * PhoneIntake
 *
 * Root component for the /admin/phone-intake route.
 * Acts as a simple state machine with two states:
 *   - no client selected → renders ClientSearch (Phase 1)
 *   - client selected    → renders TripWizard (Phase 2)
 *
 * `selectedClient` is the single shared piece of state; setting it to null
 * (via the "Change client" button in TripWizard) returns to Phase 1.
 */
export default function PhoneIntake() {
  const [selectedClient, setSelectedClient] = useState(null);

  if (!selectedClient) {
    return <ClientSearch onSelect={setSelectedClient} />;
  }

  return (
    <TripWizard
      client={selectedClient}
      onChangeClient={() => setSelectedClient(null)}
    />
  );
}
