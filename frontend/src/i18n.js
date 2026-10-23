/**
 * i18next Configuration  —  Internationalization (i18n)
 *
 * Supports two languages: French (fr) and English (en).
 * Translation strings live in:
 *   src/locales/fr/translation.json
 *   src/locales/en/translation.json
 *
 * Language selection logic (in priority order):
 *   1. localStorage key 'sr_language' (set by the user or applyLanguageConfig)
 *   2. Browser language (navigator.language)
 *   3. Fallback: French ('fr')
 *
 * Admin-controlled locking (via the 'frontend_language' config key):
 *   'fr'   — Force French everywhere; 'sr_lang_locked' = 'true' in localStorage
 *   'en'   — Force English everywhere; 'sr_lang_locked' = 'true' in localStorage
 *   'both' — User can freely switch; language selector shown in sidebar
 *
 * This file must be imported in main.jsx BEFORE the App component.
 */
// src/i18n.js
// i18next configuration for SolidaRoute
// Supported languages: fr (French), en (English)
// Language is controlled by:
//   1. The 'frontend_language' configuration key (from API)
//   2. Falls back to browser language detection
//   3. Falls back to French (fr)

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import fr from './locales/fr/translation.json';
import en from './locales/en/translation.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      fr: { translation: fr },
      en: { translation: en },
    },
    fallbackLng: 'fr',
    supportedLngs: ['fr', 'en'],
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'sr_language',
    },
  });

export default i18n;

// Helper: force language based on app configuration
// Call this after fetching the 'frontend_language' config key
export function applyLanguageConfig(configValue) {
  if (configValue === 'fr') {
    i18n.changeLanguage('fr');
    localStorage.setItem('sr_language', 'fr');
    localStorage.setItem('sr_lang_locked', 'true');
  } else if (configValue === 'en') {
    i18n.changeLanguage('en');
    localStorage.setItem('sr_language', 'en');
    localStorage.setItem('sr_lang_locked', 'true');
  } else {
    // 'both' — user can choose freely
    localStorage.removeItem('sr_lang_locked');
  }
}

export function isLanguageLocked() {
  return localStorage.getItem('sr_lang_locked') === 'true';
}
