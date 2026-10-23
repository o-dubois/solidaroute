/**
 * ForgotPassword Page  —  /forgot-password
 *
 * Public page. Collects the user's email and calls
 * POST /api/auth/forgot-password to trigger a password-reset email.
 *
 * Security: the API always returns the same generic message regardless
 * of whether the email exists (anti-enumeration). The UI mirrors this
 * by showing the same confirmation text in all cases.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../services/api';
import { useAppConfig } from '../context/AppConfigContext';
import PublicFooter from '../components/layout/PublicFooter';

export default function ForgotPassword() {
  const { t } = useTranslation();
  const { appName } = useAppConfig();
  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      // Show the server message if available; fall back to a generic string.
      setError(err.response?.data?.error || 'An error occurred. Please try again.');
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
          {sent ? (
            /* Confirmation state — same message regardless of whether email exists */
            <div className="text-center">
              <div className="w-16 h-16 bg-teal-100 dark:bg-teal-900/40 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                ✅
              </div>
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-3">{t('auth.check_email')}</h2>
              <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed">
                {t('auth.reset_link_sent')}
              </p>
            </div>
          ) : (
            /* Email input form */
            <>
              <h2 className="text-lg font-semibold mb-2">{t('auth.forgot_password_title')}</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm mb-5">{t('auth.forgot_password_desc')}</p>

              {error && (
                <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 text-red-600 text-sm rounded-lg p-3 mb-4">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="label">{t('auth.email')}</label>
                  <input className="input" type="email" autoComplete="email"
                    placeholder="name@example.ca"
                    value={email}
                    onChange={e => setEmail(e.target.value)} required />
                </div>
                <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
                  {loading ? t('auth.sending') : t('auth.send_reset_link')}
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
