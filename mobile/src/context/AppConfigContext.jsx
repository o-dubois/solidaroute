/**
 * AppConfigContext — fetches the public configuration once on app start.
 * Provides appName (and any future public config values) to all screens.
 */
import { createContext, useContext, useState, useEffect } from 'react';
import { configService } from '../services/api';
import i18n from '../i18n/index';

const AppConfigContext = createContext({ appName: 'SolidaRoute', currency: 'CAD' });

export function AppConfigProvider({ children }) {
  const [appName,              setAppName]              = useState('SolidaRoute');
  const [currency,             setCurrency]             = useState('CAD');
  const [paymentProvider,      setPaymentProvider]      = useState('manual');
  const [frontendLanguage,     setFrontendLanguage]     = useState('fr');
  const [stripePublishableKey, setStripePublishableKey] = useState('');
  const [webAppUrl,            setWebAppUrl]            = useState('');

  useEffect(() => {
    configService.public()
      .then(({ data }) => {
        const cfg = data?.configuration || [];
        const get = key => cfg.find(c => c.key === key)?.value;
        if (get('app_name'))              setAppName(get('app_name'));
        if (get('payment_currency'))      setCurrency(get('payment_currency').toUpperCase());
        if (get('payment_provider'))      setPaymentProvider(get('payment_provider'));
        if (get('frontend_language')) {
          const lang = get('frontend_language');
          setFrontendLanguage(lang);
          // Enforce the admin-configured language immediately; skip when 'both'
          // so the user's own choice (stored by i18next) is preserved.
          if (lang !== 'both') i18n.changeLanguage(lang);
        }
        if (get('stripe_publishable_key')) setStripePublishableKey(get('stripe_publishable_key'));
        if (get('frontend_url'))          setWebAppUrl(get('frontend_url'));
      })
      .catch(() => {});
  }, []);

  return (
    <AppConfigContext.Provider value={{ appName, currency, paymentProvider, frontendLanguage, stripePublishableKey, webAppUrl }}>
      {children}
    </AppConfigContext.Provider>
  );
}

export function useAppConfig() {
  return useContext(AppConfigContext);
}
