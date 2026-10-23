/**
 * Number formatting utilities — frontend/src/utils/format.js
 *
 * Formats numbers and monetary amounts according to the active i18n locale,
 * so decimal separators follow the interface language automatically:
 *   fr / fr-CA / fr-FR → comma  (8,72 $)
 *   en / en-CA / en-US → period (8.72 $)
 *
 * Usage:
 *   import { formatAmount, formatNumber, currencySymbol } from '../../utils/format';
 *   formatAmount(8.72, i18n.language)   // → "8,72" or "8.72"
 *   formatNumber(7.8, 1, i18n.language) // → "7,8"  or "7.8"
 *   currencySymbol('CAD')               // → "CA$"
 *   currencySymbol('EUR')               // → "€"
 *
 * NOTE: formatAmount returns the numeric string only (no currency symbol).
 * Use currencySymbol() to get the locale-aware symbol and compose them in JSX
 * so each part can be styled independently.
 *
 * For CSV/XLSX export, always use plain toFixed(2) to ensure
 * spreadsheet applications parse the number correctly.
 */

/**
 * Format a monetary amount (2 decimal places) per locale.
 * @param {number|string} value
 * @param {string} locale  - i18n language code, e.g. 'fr', 'en', 'fr-CA'
 * @returns {string}
 */
export function formatAmount(value, locale) {
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  try {
    return num.toLocaleString(locale || 'fr', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return num.toFixed(2);
  }
}

/**
 * Return a locale-aware currency symbol for the given ISO 4217 code.
 * Always uses 'en-CA' as the reference locale so dollar-family currencies are
 * unambiguous: CAD → "CA$", USD → "US$", AUD → "AU$", etc.
 * Unambiguous currencies are returned as their native symbol: EUR → "€", GBP → "£".
 * Falls back to the ISO code itself if the runtime does not recognise it.
 * @param {string} code  ISO 4217 currency code, e.g. 'CAD', 'EUR'
 * @returns {string}
 */
export function currencySymbol(code) {
  if (!code) return '$';
  try {
    const parts = new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: code.toUpperCase(),
      currencyDisplay: 'symbol',
    }).formatToParts(0);
    return parts.find(p => p.type === 'currency')?.value ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/**
 * Format a generic number with a given number of decimal places per locale.
 * @param {number|string} value
 * @param {number} decimals - number of decimal places (default 1)
 * @param {string} locale
 * @returns {string}
 */
export function formatNumber(value, decimals = 1, locale) {
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  try {
    return num.toLocaleString(locale || 'fr', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  } catch {
    return num.toFixed(decimals);
  }
}
