/**
 * mobile/src/utils/format.js
 *
 * Shared formatting utilities for the React Native app.
 *
 * currencySymbol(code)
 *   Returns a disambiguated display symbol for an ISO 4217 currency code.
 *   Uses a lookup table as the primary path for Hermes-engine safety (Hermes
 *   has partial Intl support on older React Native versions), then falls back
 *   to Intl.NumberFormat for any currency not in the table.
 *
 *   Dollar-family currencies are always disambiguated so users know exactly
 *   which dollar they are seeing: CAD → "CA$", USD → "US$", AUD → "AU$", etc.
 *   Unambiguous currencies use their native symbol: EUR → "€", GBP → "£".
 *
 * Usage:
 *   import { currencySymbol } from '../../utils/format';
 *   currencySymbol('CAD')  // → "CA$"
 *   currencySymbol('EUR')  // → "€"
 *   currencySymbol('USD')  // → "US$"
 */

const SYMBOLS = {
  CAD: 'CA$',
  USD: 'US$',
  EUR: '€',
  GBP: '£',
  AUD: 'AU$',
  NZD: 'NZ$',
  CHF: 'CHF',
  MXN: 'MX$',
  JPY: '¥',
  CNY: 'CN¥',
  HKD: 'HK$',
  SGD: 'SG$',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  BRL: 'R$',
  INR: '₹',
};

/**
 * @param {string} code  ISO 4217 currency code, e.g. 'CAD', 'EUR'
 * @returns {string}
 */
export function currencySymbol(code) {
  if (!code) return '$';
  const upper = code.toUpperCase();
  if (SYMBOLS[upper]) return SYMBOLS[upper];
  try {
    const parts = new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: upper,
      currencyDisplay: 'symbol',
    }).formatToParts(0);
    return parts.find(p => p.type === 'currency')?.value ?? upper;
  } catch {
    return upper;
  }
}
