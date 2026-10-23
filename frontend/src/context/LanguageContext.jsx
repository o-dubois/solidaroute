/**
 * Language Context
 *
 * Fetches frontend_language from GET /api/admin/configuration/public on mount.
 * Uses plain fetch() — never axios — to avoid 401 redirect loops on public pages.
 *
 * Enforcement:
 *   'fr'   → applyLanguageConfig('fr') forces French, sets sr_lang_locked, hides selector
 *   'en'   → applyLanguageConfig('en') forces English, sets sr_lang_locked, hides selector
 *   'both' → user can switch freely, selector visible
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyLanguageConfig, isLanguageLocked } from '../i18n';
import { detectApiUrl } from '../services/api';

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const { i18n } = useTranslation();
  const [langConfig,    setLangConfig]    = useState('both');
  const [locked,        setLocked]        = useState(false);
  const [ready,         setReady]         = useState(false);
  const [phoneCountry,  setPhoneCountry]  = useState('CA');

  function fetchConfig() {
    // No Authorization header — this endpoint is intentionally public
    fetch(`${detectApiUrl()}/admin/configuration/public`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        const cfg     = data?.configuration || [];
        const value   = cfg.find(c => c.key === 'frontend_language')?.value      ?? 'both';
        const country = cfg.find(c => c.key === 'default_phone_country')?.value  ?? 'CA';

        setLangConfig(value);
        setPhoneCountry(country.toUpperCase());

        // applyLanguageConfig handles i18n.changeLanguage + localStorage + sr_lang_locked
        applyLanguageConfig(value);

        // locked = admin forced a single language
        setLocked(value !== 'both');
      })
      .catch(() => {
        // Network error — use whatever is stored in localStorage
        setLocked(isLanguageLocked());
      })
      .finally(() => setReady(true));
  }

  useEffect(() => { fetchConfig(); }, []);

  function switchLanguage(lang) {
    if (locked) return;
    i18n.changeLanguage(lang);
    localStorage.setItem('sr_language', lang);
  }

  return (
    <LanguageContext.Provider value={{
      langConfig,
      locked,
      ready,
      phoneCountry,
      currentLang: i18n.language?.slice(0, 2) || 'fr',
      switchLanguage,
      refreshConfig: fetchConfig,
    }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider');
  return ctx;
}
