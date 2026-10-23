/**
 * Common UI Components  —  components/common/index.jsx
 *
 * Shared presentational components used throughout the application.
 * All components are i18n-aware (use useTranslation internally).
 *
 * Exports:
 *   PhoneField           — phone number input with country flag selector (E.164 output)
 *   PhoneDisplay         — renders an E.164 number in national format with a country flag
 *   validatePhone        — returns true if the value is a valid E.164 number or empty
 *   LoadingPage          — full-height loading state ("Loading…")
 *   EmptyState           — centered empty state with icon and message
 *   FormField            — label + input wrapper with optional hint text
 *   StatusBadge          — color-coded pill for user/trip/payment statuses
 *   RoleBadge            — color-coded pill for user roles
 *   VulnerabilityBadge   — pill for client vulnerability types
 *   AddressAutocomplete  — debounced address search field backed by Nominatim
 *   Pagination           — numbered page controls with ellipsis for long ranges
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import ReactPhoneInput, { isValidPhoneNumber, parsePhoneNumber, formatPhoneNumber } from 'react-phone-number-input';
import { useLanguage } from '../../context/LanguageContext';
import { detectApiUrl } from '../../services/api';

/**
 * PhoneField — phone number input with country selector.
 *
 * Props:
 *   value     — current E.164 value (e.g. "+15145551234"), controlled
 *   onChange  — called with the new E.164 string whenever the value changes
 *   error     — optional validation error message to display below the field
 *   required  — passed through to the underlying input element
 *
 * Default country comes from the admin configuration (default_phone_country),
 * read via the LanguageContext. This ensures operators serving different regions
 * can set a locale-appropriate default without code changes.
 *
 * No `international` prop — users enter only the national number;
 * the country code is set exclusively via the flag dropdown.
 * This prevents manual prefix editing (e.g. deleting "1" to get "+514…").
 *
 * Renders a disabled placeholder until the config is loaded to guarantee that
 * ReactPhoneInput first mounts with the correct defaultCountry value — not the
 * 'CA' placeholder from the initial context state.
 */
export function PhoneField({ value, onChange, error, required = false }) {
  const { phoneCountry, ready } = useLanguage();

  // Block rendering until the config is fetched.  This guarantees that when
  // ReactPhoneInput first mounts, defaultCountry already holds the admin-configured
  // value — not the 'CA' placeholder from the initial context state.
  if (!ready) {
    return <input className="input" type="tel" disabled placeholder="…" />;
  }

  return (
    <div>
      <ReactPhoneInput
        defaultCountry={phoneCountry}
        international={false}
        value={value}
        onChange={onChange}
        required={required}
        className="phone-input-wrapper"
        numberInputProps={{ className: 'input' }}
      />
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
    </div>
  );
}

/**
 * PhoneDisplay — renders a phone number in national format with a country flag.
 *
 * Props:
 *   phone — E.164 value (e.g. "+15141234567")
 *
 * Output: "(514) 123-4567 🇨🇦" — a clickable tel: link beside the flag icon.
 * Falls back to displaying the raw E.164 value if parsing fails (e.g. unknown
 * country code or malformed input).
 *
 * The flag is rendered using the 'fi fi-xx' CSS class (flag-icons library).
 */
export function PhoneDisplay({ phone }) {
  if (!phone) return null;

  // formatPhoneNumber uses the max metadata build and returns the national
  // format (e.g. "(450) 222-0001") — no country code prefix.
  // parsePhoneNumber is used separately only to extract the country for the flag.
  const national = formatPhoneNumber(phone);
  const display  = national || phone;  // fall back to raw E.164 if parsing fails
  let country = null;
  try {
    country = parsePhoneNumber(phone)?.country || null;
  } catch (_e) { /* no flag */ }

  return (
    <span className="inline-flex items-center gap-1.5">
      {/* tel: href enables native dialer on mobile devices */}
      <a href={`tel:${phone}`} className="hover:underline">{display}</a>
      {country && (
        <span
          className={`fi fi-${country.toLowerCase()} flex-shrink-0`}
          style={{ width: '1.2em', height: '0.9em', display: 'inline-block', borderRadius: '2px' }}
        />
      )}
    </span>
  );
}

/**
 * validatePhone — phone validation helper used by forms before submission.
 * Returns true if the value is empty (phone is optional on most forms)
 * or if it is a valid E.164 number according to the libphonenumber library.
 * Returns false only when a non-empty, non-valid value is present.
 */
export function validatePhone(value) {
  if (!value) return true;
  return isValidPhoneNumber(value);
}

/**
 * LoadingPage — full-height centered loading indicator.
 * Used as a page-level placeholder while async data is being fetched.
 */
export function LoadingPage() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
      {t('common.loading')}
    </div>
  );
}

/**
 * EmptyState — centered empty state with a large icon and a short message.
 * Used when a list or table has no rows to display.
 *
 * Props:
 *   message — text to show below the icon
 *   icon    — emoji or symbol (default: 📭)
 */
export function EmptyState({ message, icon = '📭' }) {
  return (
    <div className="text-center py-16 text-gray-400">
      <div className="text-4xl mb-3">{icon}</div>
      <p className="text-sm">{message}</p>
    </div>
  );
}

/**
 * FormField — label + children + optional hint wrapper.
 * Provides consistent spacing and label styling across all forms.
 *
 * Props:
 *   label    — text label rendered above the child input
 *   children — the input element(s) to wrap
 *   hint     — optional small gray text rendered below the input
 */
export function FormField({ label, children, hint }) {
  return (
    <div>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

/**
 * StatusBadge — color-coded pill for trip, user, and payment statuses.
 *
 * Props:
 *   status — string key (e.g. 'pending', 'assigned', 'completed', 'cancelled')
 *
 * Colors encode meaning at a glance:
 *   teal   → active / approved / completed
 *   amber  → pending (waiting for action)
 *   blue   → assigned (in queue)
 *   purple → in_progress (actively happening)
 *   gray   → cancelled / deleted / inactive
 *   red    → rejected / suspended
 *
 * Unknown statuses fall back to neutral gray.
 */
export function StatusBadge({ status }) {
  const { t } = useTranslation();
  const styles = {
    active:    'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300',
    pending:   'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
    suspended: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    deleted:   'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
    approved:  'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300',
    rejected:  'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    assigned:  'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    in_progress: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
    completed: 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300',
    cancelled: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
  };
  const label = t(`status.${status}`, { defaultValue: status });
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
      {label}
    </span>
  );
}

/**
 * RoleBadge — color-coded pill for user roles.
 *
 * Props:
 *   role — 'client' | 'driver' | 'operator' | 'superadmin'
 *
 * Each role has a distinct color so users and operators can identify roles
 * at a glance in user lists and trip assignment panels.
 */
export function RoleBadge({ role }) {
  const { t } = useTranslation();
  const styles = {
    client:     'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    driver:     'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300',
    operator:   'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
    superadmin: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[role] || 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
      {t(`roles.${role}`, { defaultValue: role })}
    </span>
  );
}

/**
 * VulnerabilityBadge — pill for client vulnerability/situation types.
 * Renders nothing when type is empty/null (field is optional).
 *
 * Props:
 *   type — vulnerability type key (e.g. 'elderly', 'hearing_impaired')
 *
 * Uses a consistent indigo color to distinguish it from status and role badges.
 */
export function VulnerabilityBadge({ type }) {
  const { t } = useTranslation();
  if (!type) return null;
  const label = t(`vulnerability.${type}`, { defaultValue: type });
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
      {label}
    </span>
  );
}

/**
 * AddressAutocomplete — debounced address search field backed by Nominatim
 * via the /api/trips/address-search endpoint.
 *
 * Props:
 *   value          — current text value (controlled)
 *   onChange       — fn(text) called whenever the user types
 *   onSelect       — fn({ label, lat, lon }) called when the user picks a suggestion
 *   placeholder    — input placeholder text
 *   required       — passed to the underlying input element
 *   id             — for label association
 *   inputClassName — additional CSS classes for the input element
 *
 * Debounce: 350 ms after the last keystroke before the API call is fired.
 * This reduces backend load while still feeling responsive to the user.
 *
 * Minimum query length: 3 characters — shorter strings produce too many
 * irrelevant results from Nominatim.
 *
 * sr_token: the JWT is manually attached to the fetch() call because this
 * component uses the native fetch API instead of the Axios instance (to allow
 * reading the response as a ReadableStream efficiently).
 *
 * onMouseDown vs. onClick on list items:
 *   onMouseDown fires BEFORE the input's onBlur event.  If we used onClick,
 *   the input would lose focus first, the dropdown would close, and the click
 *   would never reach the list item.  onMouseDown avoids this blur race condition.
 */
export function AddressAutocomplete({ value, onChange, onSelect, placeholder = '', required = false, id, inputClassName = '' }) {
  const { t }                         = useTranslation();
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen]               = useState(false);
  const [loading, setLoading]         = useState(false);
  const [recentAddrs, setRecentAddrs] = useState([]);
  // isFocused tracks whether the input is currently active. Decoupled from `open`
  // so that recents can appear even if they loaded after the user focused the field.
  const [isFocused, setIsFocused]     = useState(false);
  const debounceRef                   = useRef(null);
  const containerRef                  = useRef(null);

  // Fetch the user's recent addresses once on mount.
  useEffect(() => {
    const token = localStorage.getItem('sr_token');
    if (!token) return;
    fetch(`${detectApiUrl()}/trips/recent-addresses`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { results: [] })
      .then(d => setRecentAddrs(d.results || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setIsFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const search = useCallback(async (q) => {
    if (q.length < 3) { setSuggestions([]); return; }
    setLoading(true);
    try {
      const token = localStorage.getItem('sr_token');
      const res   = await fetch(
        `${detectApiUrl()}/trips/address-search?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      setSuggestions(data.results || []);
      setOpen((data.results || []).length > 0);
    } catch (_) {
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleChange(e) {
    const text = e.target.value;
    onChange(text);
    clearTimeout(debounceRef.current);
    if (text.length < 3) {
      setSuggestions([]);
      setOpen(false);
    } else {
      debounceRef.current = setTimeout(() => search(text), 350);
    }
  }

  function handlePick(item) {
    onChange(item.label);
    if (onSelect) onSelect({ label: item.label, lat: item.lat, lon: item.lon });
    setSuggestions([]);
    setOpen(false);
    setIsFocused(false);
  }

  // Recents are shown when the field is focused and the query is too short to
  // trigger a search. Decoupled from `open` so they appear even if the user
  // focused before the async fetch completed.
  const showRecents = isFocused && value.length < 3 && recentAddrs.length > 0 && suggestions.length === 0;

  return (
    <div className="relative" ref={containerRef}>
      <input
        id={id}
        type="text"
        className={`input w-full ${inputClassName}`}
        value={value}
        onChange={handleChange}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
      />
      {loading && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">…</span>
      )}
      {(showRecents || (open && suggestions.length > 0)) && (
        <ul className="absolute z-50 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg mt-1 max-h-60 overflow-y-auto text-sm">
          {showRecents && (
            <>
              <li className="px-3 pt-2 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wide select-none">
                {t('trips.recent_addresses')}
              </li>
              {recentAddrs.map((item, i) => (
                <li
                  key={`recent-${i}`}
                  className="px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer truncate flex items-center gap-2"
                  onMouseDown={() => handlePick(item)}
                  title={item.label}
                >
                  <span className="text-gray-400 text-xs">🕐</span>
                  {item.label}
                </li>
              ))}
            </>
          )}
          {suggestions.map((item) => (
            <li
              key={item.place_id}
              className="px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer truncate"
              onMouseDown={() => handlePick(item)}
              title={item.label}
            >
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Pagination — numbered page navigation bar.
 *
 * Renders ‹ prev | 1 2 … 5 6 7 … 12 13 | next › controls.
 * Collapses middle pages to an ellipsis when there are more than 7 pages.
 *
 * Props:
 *   page     {number}   — current page (1-based)
 *   pages    {number}   — total number of pages
 *   onChange {function} — called with the new page number when a button is clicked
 */
export function Pagination({ page, pages, onChange }) {
  if (pages <= 1) return null;

  function buildRange() {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
    const range = [1];
    if (page > 4)          range.push(null);
    const lo = Math.max(2, page - 2);
    const hi = Math.min(pages - 1, page + 2);
    for (let p = lo; p <= hi; p++) range.push(p);
    if (page < pages - 3) range.push(null);
    range.push(pages);
    return range;
  }

  return (
    <div className="flex items-center justify-center gap-1 mt-4">
      <button
        onClick={() => onChange(page - 1)}
        disabled={page === 1}
        className="px-2 py-1 rounded text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
        ‹
      </button>
      {buildRange().map((p, i) =>
        p === null
          ? <span key={`e${i}`} className="px-2 text-gray-300">…</span>
          : <button
              key={p}
              onClick={() => onChange(p)}
              className={`min-w-[2rem] px-2 py-1 rounded text-sm font-medium transition-colors ${
                p === page ? 'bg-teal-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}>
              {p}
            </button>
      )}
      <button
        onClick={() => onChange(page + 1)}
        disabled={page === pages}
        className="px-2 py-1 rounded text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
        ›
      </button>
    </div>
  );
}