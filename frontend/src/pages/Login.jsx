/**
 * @file pages/Login.jsx
 * @description Login page — /login
 *
 * Public page. Already-authenticated users are redirected by HomeRedirect in App.jsx
 * before this component even mounts.
 *
 * Features:
 *   - Email + password form that calls POST /api/auth/login
 *   - Generic "Invalid credentials" message for wrong email or wrong password
 *     (avoids disclosing whether the email exists in the system)
 *   - Special handling for EMAIL_NOT_VERIFIED error code:
 *     Shows an inline amber banner with a "Resend verification" button that calls
 *     POST /api/auth/resend-verification.  This path is reached when a user signs
 *     up but clicks Login before opening the verification email.
 *   - Link to /forgot-password for password reset via email
 *   - Link to /register for new registrations
 *
 * On success the JWT is stored in localStorage (key: 'sr_token') via AuthContext,
 * and the user is redirected to their role-appropriate dashboard.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useAppConfig } from '../context/AppConfigContext';
import api from '../services/api';
import toast from 'react-hot-toast';
import PublicFooter from '../components/layout/PublicFooter';

export default function Login() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const { appName } = useAppConfig();
  const navigate  = useNavigate();
  const [form, setForm]       = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [unverified, setUnverified] = useState(false);
  const [resend, setResend]   = useState({ loading: false, done: false });

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setUnverified(false);
    setLoading(true);
    try {
      const user = await login(form.email, form.password);
      toast.success(t('auth.welcome', { name: user.first_name }));
      if (user.role === 'client')       navigate('/client');
      else if (user.role === 'driver')  navigate('/driver');
      else                              navigate('/admin');
    } catch (err) {
      const code = err.response?.data?.code;
      const msg  = err.response?.data?.error || 'Login error.';
      if      (code === 'EMAIL_NOT_VERIFIED') setUnverified(true);
      else if (code === 'ACCOUNT_LOCKED')     setError(t('auth.account_locked'));
      else setError(msg);
    } finally { setLoading(false); }
  }

  async function handleResend() {
    setResend({ loading: true, done: false });
    try {
      await api.post('/auth/resend-verification', { email: form.email });
      setResend({ loading: false, done: true });
    } catch {
      setResend({ loading: false, done: false });
      toast.error('Failed to send. Please try again.');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
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
          <h2 className="text-lg font-semibold mb-5">{t('auth.login')}</h2>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 text-red-600 text-sm rounded-lg p-3 mb-4">
              {error}
            </div>
          )}

          {unverified && (
            <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 rounded-lg p-4 mb-4">
              <p className="text-amber-800 dark:text-amber-200 text-sm font-medium mb-1">{t('auth.email_not_verified')}</p>
              <p className="text-amber-700 dark:text-amber-300 text-xs leading-relaxed mb-3">{t('auth.email_not_verified_desc')}</p>
              {resend.done ? (
                <p className="text-teal-700 dark:text-teal-300 text-xs font-medium">{t('auth.resent_success')}</p>
              ) : (
                <button onClick={handleResend} disabled={resend.loading}
                  className="text-xs text-amber-800 dark:text-amber-200 underline hover:no-underline font-medium">
                  {resend.loading ? t('auth.resending') : t('auth.resend_verification')}
                </button>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">{t('auth.email')}</label>
              <input className="input" type="email" autoComplete="email"
                placeholder="name@example.ca"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
            </div>
            <div>
              <label className="label">{t('auth.password')}</label>
              <input className="input" type="password" autoComplete="current-password"
                placeholder="••••••••"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
              {loading ? t('auth.signing_in') : t('auth.sign_in')}
            </button>
          </form>

          <p className="text-center text-xs text-gray-400 mt-4">
            <Link to="/forgot-password" className="text-teal-600 dark:text-teal-400 hover:underline">
              {t('auth.forgot_password')}
            </Link>
          </p>
        </div>

        <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
          {t('auth.no_account')}{' '}
          <Link to="/register" className="text-teal-600 dark:text-teal-400 font-medium hover:underline">
            {t('auth.register')}
          </Link>
        </p>

        <PublicFooter />
      </div>
    </div>
  );
}
