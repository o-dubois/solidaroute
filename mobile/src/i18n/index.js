/**
 * i18next setup for React Native.
 * Detects device locale via expo-localization and defaults to French
 * when the device language is not explicitly English.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';

import en from './en.json';
import fr from './fr.json';

const deviceLang = getLocales()[0]?.languageCode || 'fr';
const lng = deviceLang === 'en' ? 'en' : 'fr';

i18n
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng,
    fallbackLng: 'fr',
    interpolation: { escapeValue: false },
    compatibilityJSON: 'v3',
  });

export default i18n;
