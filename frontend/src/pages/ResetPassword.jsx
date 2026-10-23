/**
 * ResetPassword Page  —  /reset-password?token=xxx
 *
 * Public page. Called when the user clicks the link in the password-reset email.
 * Reads the token from the URL query string and displays a form to set a new password.
 *
 * Possible states:
 *   form    — initial state; user fills in and confirms the new password
 *   success — password was reset; shows a "Log in" button
 *   error   — token invalid, expired, or already used; links back to /forgot-password
 *
 * Password-complexity errors (policy violations) are shown inline under the form,
 * not mapped to the error state, so the user can adjust their password without
 * having to navigate back.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../services/api';
import { useAppConfig } from '../context/AppConfigContext';
import PublicFooter from '../components/layout/PublicFooter';

const STATE = { FORM: 'form', SUCCESS: 'success', ERROR: 'error' };

export default function ResetPassword() {
  const { t } = useTranslation();
  const { appName } = useAppConfig();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [state,    setState]    = useState(token ? STATE.FORM : STATE.ERROR);
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [loading,  setLoading]  = useState(false);
  // errorMsg: fatal token errors (invalid/expired/used) — switches to ERROR state
  const [errorMsg, setErrorMsg] = useState(
    token ? '' : 'No reset token found in link.'
  );
  // pwErrors: password policy violations — shown inline, stay in FORM state
  const [pwErrors, setPwErrors] = useState([]);

  async function handleSubmit(e) {
    e.preventDefault();
    setPwErrors([]);

    if (password !== confirm) {
      setPwErrors([t('auth.passwords_dont_match')]);
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setState(STATE.SUCCESS);
    } catch (err) {
      const data = err.response?.data || {};
      const code = data.code;

      if (data.password_errors?.length) {
        // Policy violation — stay in FORM state so user can fix the password.
        setPwErrors(data.password_errors);
      } else if (code === 'TOKEN_INVALID' || code === 'TOKEN_ALREADY_USED' || code === 'TOKEN_EXPIRED') {
        setErrorMsg(data.error || 'This link is invalid or has expired.');
        setState(STATE.ERROR);
      } else {
        setErrorMsg(data.error || 'An error occurred. Please try again.');
        setState(STATE.ERROR);
      }
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Brand header */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-teal-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50">{appName}</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">{t('app.tagline')}</p>
        </div>

        <div className="card">
          {/* ── Success ─────────────────────────────────────────── */}
          {state === STATE.SUCCESS && (
            <div className="text-center">
              <div className="w-16 h-16 bg-teal-100 dark:bg-teal-900/40 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                ✅
              </div>
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-3">{t('auth.reset_password_title')}</h2>
              <p className="text-gray-600 dark:text-gray-300 text-sm mb-6">{t('auth.password_reset_success')}</p>
              <Link to="/login" className="btn-primary inline-block">{t('auth.sign_in')}</Link>
            </div>
          )}

          {/* ── Token error ─────────────────────────────────────── */}
          {state === STATE.ERROR && (
            <div className="text-center">
              <div className="w-16 h-16 bg-red-100 dark:bg-red-900/40 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                ❌
              </div>
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-3">{t('auth.reset_invalid_title')}</h2>
              <p className="text-gray-600 dark:text-gray-300 text-sm mb-6">{errorMsg}</p>
              <Link to="/forgot-password" className="btn-primary inline-block">
                {t('auth.send_reset_link')}
              </Link>
            </div>
          )}

          {/* ── Password form ───────────────────────────────────── */}
          {state === STATE.FORM && (
            <>
              <h2 className="text-lg font-semibold mb-5">{t('auth.reset_password_title')}</h2>

              {pwErrors.length > 0 && (
                <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 text-red-600 text-sm rounded-lg p-3 mb-4">
                  <ul className="list-disc list-inside space-y-1">
                    {pwErrors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="label">{t('auth.new_password')}</label>
                  <input className="input" type="password" autoComplete="new-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)} required />
                </div>
                <div>
                  <label className="label">{t('auth.confirm_new_password')}</label>
                  <input className="input" type="password" autoComplete="new-password"
                    placeholder="••••••••"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)} required />
                </div>
                <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
                  {loading ? t('auth.resetting') : t('auth.reset_password_submit')}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
          <Link to="/login" className="text-teal-600 dark:text-teal-400 hover:underline">← {t('auth.back_to_login')}</Link>
        </p>
        <PublicFooter />
      </div>
    </div>
  );
}
