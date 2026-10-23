/**
 * PasswordStrength — Real-time password strength indicator
 *
 * Fetches the current complexity rules from GET /api/auth/password-rules
 * on first render and caches them at the module level (persists across
 * component mount/unmount within the same session).
 *
 * Displays:
 *   - A color-coded progress bar (red → amber → teal)
 *   - A strength label (Weak / Medium / Strong / Almost…)
 *   - A checklist of criteria (only the ones the admin has enabled)
 *
 * Active criteria are dynamically determined from the fetched rules —
 * if the admin disables "require number", that row disappears from the list.
 *
 * Props:
 *   password {string} — The current value of the password input field
 *
 * Rendering:
 *   Returns null when no password has been entered yet (empty string)
 *   or before the rules have loaded, to keep the UI clean.
 *
 * Usage:
 *   <input type="password" value={pw} onChange={...} />
 *   <PasswordStrength password={pw} />
 */
// components/common/PasswordStrength.jsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';

/**
 * Module-level cache for the password rules fetched from the server.
 * Using a module-level variable (not React state) means the rules are
 * fetched only once per page load, even if the component is mounted and
 * unmounted multiple times (e.g. opening/closing a modal).
 */
let cachedRules = null;

/**
 * PasswordStrength component.
 *
 * State:
 *   rules — the fetched password rule configuration object, or null while loading.
 *           If the API call fails, a safe default set of rules is used so the
 *           component still renders rather than staying blank.
 */
export default function PasswordStrength({ password }) {
  const { t } = useTranslation();
  // Initialize from module cache — avoids a re-fetch if the component re-mounts
  const [rules, setRules] = useState(cachedRules);

  /**
   * Fetch password complexity rules from the backend on first render.
   * Skips the fetch if cachedRules is already populated from a previous mount.
   * On error: applies a sensible fallback so the component stays functional
   * even if the API is temporarily unavailable.
   */
  useEffect(() => {
    if (cachedRules) return;
    api.get('/auth/password-rules')
      .then(({ data }) => {
        cachedRules = data.rules;
        setRules(data.rules);
      })
      .catch(() => {
        // Fallback rules — common defaults used when the API call fails
        cachedRules = {
          minLength: 8, requireUppercase: true,
          requireLowercase: true, requireNumber: true, requireSpecial: false,
        };
        setRules(cachedRules);
      });
  }, []);

  // Render nothing until both rules are loaded and the user has started typing
  if (!rules || !password) return null;

  /**
   * Criteria array — each entry represents one password rule check.
   * The `active` flag controls whether the row is shown at all; rules that
   * the admin has disabled (requireSpecial = false, etc.) are filtered out
   * so the checklist only shows rules that actually apply.
   *
   * `ok` is true when the current password satisfies the criterion.
   */
  const criteria = [
    {
      key: 'length',
      // Use singular vs. plural translation key for "1 character" vs. "N characters"
      label: rules.minLength === 1
        ? t('password_strength.min_length', { count: rules.minLength })
        : t('password_strength.min_length_plural', { count: rules.minLength }),
      ok: password.length >= rules.minLength,
      active: true, // min length is always active
    },
    { key: 'upper',   label: t('password_strength.uppercase'), ok: /[A-Z]/.test(password),   active: rules.requireUppercase },
    { key: 'lower',   label: t('password_strength.lowercase'), ok: /[a-z]/.test(password),   active: rules.requireLowercase },
    { key: 'number',  label: t('password_strength.number'),    ok: /[0-9]/.test(password),   active: rules.requireNumber },
    // Special characters regex covers common symbols; escape characters ensure correctness
    { key: 'special', label: t('password_strength.special'),   ok: /[!@#$%^&*\-_=+[\]{};:'",.<>/?\\|`~()]/.test(password), active: rules.requireSpecial },
  ].filter(c => c.active); // remove disabled criteria from the list entirely

  const passed = criteria.filter(c => c.ok).length;
  const total  = criteria.length;
  // pct drives both the progress bar width and the color/label selection
  const pct    = total > 0 ? Math.round((passed / total) * 100) : 0;
  // allOk: true only when every active criterion is satisfied (used for "Strong" vs. "Almost")
  const allOk  = passed === total;

  // Bar color transitions: red (weak) → amber (medium) → teal (strong)
  const barColor = pct <= 33 ? 'bg-red-400' : pct <= 66 ? 'bg-amber-400' : 'bg-teal-500';
  // "Almost" is shown when ≥67% pass but not all criteria are met yet
  const label    = pct <= 33
    ? t('password_strength.weak')
    : pct <= 66
    ? t('password_strength.medium')
    : allOk ? t('password_strength.strong') : t('password_strength.almost');

  return (
    <div className="mt-2 space-y-2">
      {/* Progress bar + strength label in one row */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
          {/* Width animates smoothly (transition-all 300ms) as the user types */}
          <div
            className={`h-full rounded-full transition-all duration-300 ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {/* Strength label color matches the bar color for visual consistency */}
        <span className={`text-xs font-medium w-16 text-right ${
          pct <= 33 ? 'text-red-500' : pct <= 66 ? 'text-amber-500' : 'text-teal-600 dark:text-teal-400'
        }`}>
          {label}
        </span>
      </div>
      {/* Checklist — green ✓ for satisfied criteria, gray ○ for outstanding ones */}
      <ul className="space-y-0.5">
        {criteria.map(c => (
          <li key={c.key}
            className={`flex items-center gap-1.5 text-xs transition-colors ${
              c.ok ? 'text-teal-600 dark:text-teal-400' : 'text-gray-400'
            }`}>
            {/* Fixed-width icon column keeps label text aligned regardless of icon */}
            <span className="w-3.5 text-center flex-shrink-0">{c.ok ? '✓' : '○'}</span>
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
