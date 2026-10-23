/**
 * DriverTripAction — /driver-action?action=X&trip=T-xxx
 *
 * Public landing page. The driver arrives here after clicking Accept or Decline
 * in a preferred-driver notification email. The backend processes the one-time
 * token, updates the trip, then redirects here with a query param indicating
 * the outcome.
 *
 * Possible action values (set by backend/src/routes/trips/action.js):
 *   accepted  — driver claimed the trip
 *   declined  — driver declined; trip is now open to all nearby drivers
 *   expired   — token was already used or past its TTL
 *   too_late  — trip was already assigned by someone else
 *   invalid   — no token param was present in the original request
 *   error     — unexpected server error
 *
 * No authentication required — the driver may not have a browser session open.
 */
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppConfig } from '../context/AppConfigContext';

const CONFIG = {
  accepted: { icon: '✅', bg: 'bg-teal-100 dark:bg-teal-900/40',   titleKey: 'driver_action.accepted_title', descKey: 'driver_action.accepted_desc'  },
  declined: { icon: '↩️',  bg: 'bg-amber-100 dark:bg-amber-900/40',  titleKey: 'driver_action.declined_title', descKey: 'driver_action.declined_desc'  },
  expired:  { icon: '⏰',  bg: 'bg-gray-100 dark:bg-gray-700',   titleKey: 'driver_action.expired_title',  descKey: 'driver_action.expired_desc'   },
  too_late: { icon: 'ℹ️',  bg: 'bg-blue-100 dark:bg-blue-900/40',   titleKey: 'driver_action.too_late_title', descKey: 'driver_action.too_late_desc'  },
  invalid:  { icon: '❌',  bg: 'bg-red-100 dark:bg-red-900/40',    titleKey: 'driver_action.invalid_title',  descKey: 'driver_action.invalid_desc'   },
  error:    { icon: '⚠️',  bg: 'bg-red-100 dark:bg-red-900/40',    titleKey: 'driver_action.error_title',    descKey: 'driver_action.error_desc'     },
};

export default function DriverTripAction() {
  const { t } = useTranslation();
  const { appName } = useAppConfig();
  const [searchParams] = useSearchParams();

  const action   = searchParams.get('action') || 'invalid';
  const tripNum  = searchParams.get('trip');   // e.g. "4231" (without the T- prefix)

  const cfg = CONFIG[action] || CONFIG.invalid;

  // Build the description: insert trip number only when it's available
  const desc = tripNum
    ? t(cfg.descKey, { trip: tripNum })
    : t(cfg.descKey, { trip: '?' }).replace(/T-\?/g, '').trim();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        {/* Brand header */}
        <div className="text-center mb-6">
          <div className="w-12 h-12 bg-teal-600 rounded-xl flex items-center justify-center mx-auto mb-3">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">{appName}</h1>
        </div>

        <div className="card text-center">
          {/* Outcome icon */}
          <div className={`w-16 h-16 ${cfg.bg} rounded-full flex items-center justify-center mx-auto mb-4 text-3xl`}>
            {cfg.icon}
          </div>

          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-3">{t(cfg.titleKey)}</h2>
          <p className="text-gray-600 dark:text-gray-300 text-sm mb-6">{desc}</p>

          <Link to="/login" className="btn-primary inline-block">
            {t('driver_action.go_to_app')}
          </Link>
        </div>

        <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
          <Link to="/login" className="text-teal-600 dark:text-teal-400 hover:underline">
            ← {t('auth.back_to_login')}
          </Link>
        </p>
      </div>
    </div>
  );
}
