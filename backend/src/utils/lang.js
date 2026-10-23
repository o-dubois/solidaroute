'use strict';
/**
 * @file lang.js
 * @description Email language resolution utility for SolidaRoute.
 *
 * Determines which language ('fr' or 'en') should be used when composing a
 * transactional email. The decision depends on two configuration values:
 *
 *   1. `frontend_language` (from the `configuration` table)
 *      The operator-level setting that controls what language the platform uses.
 *      Possible values:
 *        'fr'   — Force French for ALL emails, regardless of individual preferences
 *        'en'   — Force English for ALL emails, regardless of individual preferences
 *        'both' — Honour each recipient's own language preference (bilingual mode)
 *
 *   2. `preferred_language` (from the recipient's user record)
 *      The individual user's language preference, stored on their profile.
 *      Possible values: 'fr' | 'en'
 *
 * Priority rules:
 *   1. If the platform is set to 'fr' → always 'fr'  (operator overrides individual)
 *   2. If the platform is set to 'en' → always 'en'  (operator overrides individual)
 *   3. If the platform is set to 'both' → use the recipient's preferred_language
 *      Defaults to 'fr' if preferred_language is absent/unknown, since Quebec French
 *      is the primary language of the service area.
 *
 * Design rationale:
 *   - Keeping this logic in one place prevents the language-selection rules from
 *     being duplicated across every email-sending function in email.js.
 *   - The 'both' mode is specifically designed for organizations that serve a
 *     mixed French/English clientele (e.g., bilingual communities in Quebec).
 *
 * @module lang
 *
 * Règle de priorité (résumé en français) :
 *   1. Si config = 'fr'   → toujours 'fr'
 *   2. Si config = 'en'   → toujours 'en'
 *   3. Si config = 'both' → langue préférée du destinataire (preferred_language)
 *                           défaut 'fr' si non renseigné
 */

/**
 * Resolves the email language to use for a specific recipient.
 *
 * @param {string} configLang    - The `frontend_language` value from the configuration table
 *                                 ('fr' | 'en' | 'both')
 * @param {string} recipientLang - The recipient's `preferred_language` from the users table
 *                                 ('fr' | 'en')
 * @returns {'fr' | 'en'}        - The resolved language for email composition
 *
 * @example
 * // Platform forced to French — individual preference is ignored
 * resolveEmailLang('fr', 'en') // => 'fr'
 *
 * // Bilingual mode — follow the recipient's preference
 * resolveEmailLang('both', 'en') // => 'en'
 * resolveEmailLang('both', 'fr') // => 'fr'
 *
 * // Bilingual mode — recipient has no preference stored, fall back to French
 * resolveEmailLang('both', undefined) // => 'fr'
 */
function resolveEmailLang(configLang, recipientLang) {
  // Operator has locked the platform to English — no individual override allowed
  if (configLang === 'en') return 'en';
  // Operator has locked the platform to French — no individual override allowed
  if (configLang === 'fr') return 'fr';
  // 'both' (or any unexpected value) — defer to the recipient's stored preference.
  // Default to 'fr' if preference is unset, null, or an unrecognized value.
  return recipientLang === 'en' ? 'en' : 'fr';
}

module.exports = { resolveEmailLang };
