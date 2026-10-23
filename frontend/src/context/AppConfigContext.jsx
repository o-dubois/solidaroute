/**
 * AppConfigContext — fetches the public configuration once on app load
 * and exposes app-wide settings that don't require authentication.
 *
 * Exposes:
 *   appName  — display name of the application (from `app_name` config key)
 *              Defaults to 'SolidaRoute' until the API responds.
 *   currency — ISO 4217 currency code (from `payment_currency` config key)
 *              Defaults to 'CAD'. Used with currencySymbol() from utils/format
 *              to display the correct symbol on all monetary amounts.
 *
 * Usage:
 *   const { appName, currency } = useAppConfig();
 */
import { createContext, useContext, useState, useEffect } from 'react';
import { detectApiUrl } from '../services/api';

const AppConfigContext = createContext({ appName: 'SolidaRoute', currency: 'CAD' });

export function AppConfigProvider({ children }) {
  const [appName,  setAppName]  = useState('SolidaRoute');
  const [currency, setCurrency] = useState('CAD');

  useEffect(() => {
    fetch(`${detectApiUrl()}/admin/configuration/public`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const cfg  = data?.configuration || [];
        const name = cfg.find(c => c.key === 'app_name')?.value;
        const curr = cfg.find(c => c.key === 'payment_currency')?.value;
        if (name) {
          setAppName(name);
          // Keep the browser tab title in sync with the configured app name.
          document.title = name;
        }
        if (curr) setCurrency(curr.toUpperCase());
      })
      .catch(() => {}); // keep defaults on network error
  }, []);

  return (
    <AppConfigContext.Provider value={{ appName, currency }}>
      {children}
    </AppConfigContext.Provider>
  );
}

export function useAppConfig() {
  return useContext(AppConfigContext);
}
