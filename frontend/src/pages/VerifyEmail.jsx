/**
 * Email Verification Page  —  /verify-email?token=xxx
 *
 * Public page. Automatically called when the user clicks the link in their
 * verification email. Calls GET /api/auth/verify-email?token=xxx on mount.
 *
 * Possible states:
 *   loading      — spinner while the API call is in progress
 *   success      — account activated; shows "Log in" button (client) or
 *                  "pending approval" notice (driver)
 *   already_used — token was already consumed; account is already confirmed
 *   expired      — token expired (24h TTL); shows resend form
 *   invalid      — token not found in DB; shows resend form
 *
 * The ResendForm sub-component handles POST /api/auth/resend-verification.
 * It uses the same generic success message regardless of whether the email
 * exists (anti-enumeration measure).
 *
 * Role-specific success behaviour:
 *   client — shows a "Log in now" button; account is fully active
 *   driver — shows an amber "pending approval" notice; account is verified
 *            but must still be reviewed by an admin before login is allowed
 */
import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../services/api';
import { useAppConfig } from '../context/AppConfigContext';

/**
 * STATE constants — used as the `state` value throughout this component.
 * Defined as an object rather than individual strings to avoid typos and
 * enable IDE auto-complete.
 */
const STATE = { LOADING: 'loading', SUCCESS: 'success', ALREADY_USED: 'already_used', EXPIRED: 'expired', INVALID: 'invalid' };

/**
 * ResendForm — shown when a token is expired or invalid.
 * Collects the user's email and calls POST /api/auth/resend-verification.
 *
 * The server always returns a generic "check your inbox" response, even if the
 * email does not exist in the database, to prevent email enumeration attacks.
 *
 * State:
 *   email  — the email address entered by the user
 *   resend — { loading, done, error } — tracks the resend request state
 */
function ResendForm({ t }) {
  const [email, setEmail]   = useState('');
  const [resend, setResend] = useState({ loading: false, done: false, error: '' });

  /**
   * Submit the resend request.
   * On success: shows the generic "check your inbox" confirmation.
   * On failure: shows a plain error message (not role- or reason-specific).
   */
  async function handleSubmit(e) {
    e.preventDefault();
    setResend({ loading: true, done: false, error: '' });
    try {
      await api.post('/auth/resend-verification', { email });
      setResend({ loading: false, done: true, error: '' });
    } catch {
      setResend({ loading: false, done: false, error: 'Failed to send. Please try again.' });
    }
  }

  // After a successful resend, replace the form with a confirmation message
  if (resend.done) return (
    <div className="bg-teal-50 dark:bg-teal-900/30 border border-teal-100 dark:border-teal-800 rounded-lg p-4 text-sm text-teal-700 dark:text-teal-300">
      {t('verify_email.resent')}
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="text-left">
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3 font-medium">{t('verify_email.new_link_label')}</p>
      <input className="input mb-2" type="email" placeholder="your@email.ca"
        value={email} onChange={e => setEmail(e.target.value)} required />
      {resend.error && <p className="text-red-500 text-xs mb-2">{resend.error}</p>}
      <button type="submit" disabled={resend.loading} className="btn-primary w-full">
        {resend.loading ? t('auth.resending') : t('verify_email.resend_button')}
      </button>
    </form>
  );
}

/**
 * VerifyEmail — main page component.
 *
 * State:
 *   state      — current verification outcome (one of the STATE constants above)
 *   message    — human-readable message from the API response or error
 *   role       — 'client' or 'driver', returned on success to drive post-verify UI
 *   firstName  — returned on success to personalize the greeting
 */
export default function VerifyEmail() {
  const { t } = useTranslation();
  const { appName } = useAppConfig();
  const [searchParams] = useSearchParams();
  const [state, setState]         = useState(STATE.LOADING);
  const [message, setMessage]     = useState('');
  const [role, setRole]           = useState('');
  const [firstName, setFirstName] = useState('');

  /**
   * On mount: extract the token from the URL query string and call the
   * verification endpoint. Map the backend's error code to a UI state.
   *
   * If no token is present (e.g. user navigated here manually), immediately
   * show the invalid state rather than sending a broken request.
   */
  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) { setState(STATE.INVALID); setMessage('No verification token found in link.'); return; }

    api.get(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(({ data }) => {
        setState(STATE.SUCCESS);
        setMessage(data.message);
        setRole(data.role || '');
        setFirstName(data.first_name || '');
      })
      .catch(err => {
        const code = err.response?.data?.code;
        const msg  = err.response?.data?.error || 'An error occurred.';
        setMessage(msg);
        // Map backend error codes to UI states
        if (code === 'TOKEN_ALREADY_USED') setState(STATE.ALREADY_USED);
        else if (code === 'TOKEN_EXPIRED')  setState(STATE.EXPIRED);
        else                               setState(STATE.INVALID);
      });
  }, [searchParams]);

  // Icon/color/title lookup tables — keyed by STATE value for clean rendering
  const icons  = { loading: null, success: '✅', already_used: 'ℹ️', expired: '⏰', invalid: '❌' };
  const colors = { success: 'bg-teal-100 dark:bg-teal-900/40', already_used: 'bg-blue-100 dark:bg-blue-900/40', expired: 'bg-amber-100 dark:bg-amber-900/40', invalid: 'bg-red-100 dark:bg-red-900/40' };
  const titles = {
    success:      t('verify_email.confirmed_title'),
    already_used: t('verify_email.already_used_title'),
    expired:      t('verify_email.expired_title'),
    invalid:      t('verify_email.invalid_title'),
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* App logo / brand mark — same header used on /login and /register */}
        <div className="text-center mb-6">
          <div className="w-12 h-12 bg-teal-600 rounded-xl flex items-center justify-center mx-auto mb-3">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
          </div>
          <h1 className="text-xl font-bold">{appName}</h1>
        </div>

        <div className="card text-center">
          {/* Loading state — animated spinner while the API call is in progress */}
          {state === STATE.LOADING && (
            <>
              <div className="w-14 h-14 border-4 border-teal-200 border-t-teal-600 rounded-full animate-spin mx-auto mb-4" />
              <p className="text-gray-500 dark:text-gray-400 text-sm">{t('verify_email.loading')}</p>
            </>
          )}

          {/* All non-loading states share the same icon + title + message structure */}
          {state !== STATE.LOADING && (
            <>
              {/* Colored icon circle — color conveys the verification outcome at a glance */}
              <div className={`w-16 h-16 ${colors[state]} rounded-full flex items-center justify-center mx-auto mb-4 text-3xl`}>
                {icons[state]}
              </div>
              {/* Personalized greeting only on success, when we know the user's name */}
              {firstName && state === STATE.SUCCESS && (
                <p className="text-gray-500 dark:text-gray-400 text-sm mb-1">Hello {firstName}!</p>
              )}
              <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-3">{titles[state]}</h2>
              <p className="text-gray-600 dark:text-gray-300 text-sm mb-6">{message}</p>

              {/* Success — client: "Log in now" button; account is immediately active */}
              {state === STATE.SUCCESS && role === 'client' && (
                <Link to="/login" className="btn-primary inline-block">{t('verify_email.login_now')}</Link>
              )}
              {/* Success — driver: can now log in and complete profile */}
              {state === STATE.SUCCESS && role === 'driver' && (
                <>
                  <div className="bg-teal-50 dark:bg-teal-900/30 border border-teal-100 dark:border-teal-800 rounded-lg p-4 text-left mb-4">
                    <p className="text-teal-800 dark:text-teal-200 text-sm font-medium mb-1">{t('verify_email.driver_ready_title')}</p>
                    <p className="text-teal-700 dark:text-teal-300 text-xs leading-relaxed">{t('verify_email.driver_ready_desc')}</p>
                  </div>
                  <Link to="/login" className="btn-primary inline-block">{t('verify_email.login_now')}</Link>
                </>
              )}
              {/* Already used — account already confirmed; just direct to login */}
              {state === STATE.ALREADY_USED && (
                <Link to="/login" className="btn-primary inline-block">{t('auth.sign_in')}</Link>
              )}
              {/* Expired or invalid — show the resend form so the user can get a fresh link */}
              {(state === STATE.EXPIRED || state === STATE.INVALID) && (
                <ResendForm t={t} />
              )}
            </>
          )}
        </div>

        {/* "Back to login" footer link — always visible */}
        <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
          <Link to="/login" className="text-teal-600 dark:text-teal-400 hover:underline">← {t('auth.back_to_login')}</Link>
        </p>
      </div>
    </div>
  );
}
