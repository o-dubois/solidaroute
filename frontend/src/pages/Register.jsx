/**
 * Registration Page  —  /register
 *
 * Public page — 3-step flow:
 *   Step 1 — Role selection: "I am a rider" or "I am a volunteer driver"
 *   Step 2 — Personal info form (first name, last name, email, phone, password)
 *   Step 3 — Confirmation screen: "Check your inbox" with next-steps instructions
 *
 * No "situation" (vulnerability type) is collected at registration.
 * That information is optional and goes in the profile after login.
 *
 * On submit: calls POST /api/auth/register
 * On success: transitions to step 3 (does NOT navigate away or auto-login)
 *
 * Password validation:
 *   The PasswordStrength component shows a real-time indicator.
 *   The backend also validates and returns password_errors[] if rules are not met.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authService } from '../services/api';
import { useAppConfig } from '../context/AppConfigContext';
import PasswordStrength from '../components/common/PasswordStrength';
import { PhoneField, validatePhone } from '../components/common';
import PublicFooter from '../components/layout/PublicFooter';

/**
 * Register — main page component.
 *
 * State:
 *   step        — current step number: 1 (role), 2 (form), 3 (done)
 *   role        — 'client' or 'driver', chosen in step 1
 *   form        — all form field values for step 2
 *   loading     — true while the registration API call is in-flight
 *   errors      — field-level and global validation error messages
 *   emailSentTo — the email address shown on the step-3 confirmation screen
 */
export default function Register() {
  const { t } = useTranslation();
  const { appName } = useAppConfig();
  const [step, setStep]   = useState(1); // 1=role, 2=form, 3=done
  const [role, setRole]   = useState('');
  const [form, setForm]   = useState({
    first_name: '', last_name: '', email: '', phone: '', password: '', confirm: ''
  });
  const [loading, setLoading]   = useState(false);
  const [errors, setErrors]     = useState({});
  // emailSentTo is captured on submit so it persists on the step-3 screen
  const [emailSentTo, setEmailSentTo] = useState('');

  /**
   * Client-side validation for step 2.
   * Returns true if all checks pass; populates `errors` state otherwise.
   * These checks mirror the backend rules but run instantly without a network round-trip.
   */
  function validate() {
    const e = {};
    if (!form.first_name.trim()) e.first_name = t('common.error') + ': ' + t('auth.first_name');
    if (!form.last_name.trim())  e.last_name  = t('common.error') + ': ' + t('auth.last_name');
    if (!form.email.includes('@')) e.email = 'Invalid email address';
    // Password confirmation must match before hitting the API
    if (form.password !== form.confirm) e.confirm = t('profile.passwords_no_match');
    // validatePhone returns true for empty (phone is optional) or valid E.164 value
    if (!validatePhone(form.phone)) e.phone = t('auth.phone_invalid');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  /**
   * Submit the registration form.
   * On success: save the submitted email and advance to step 3.
   *   The user is NOT auto-logged in — they must verify their email first.
   * On failure: extract password rule errors from the response if present,
   *   otherwise show the generic error message.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      await authService.register({
        first_name: form.first_name, last_name: form.last_name,
        email: form.email, phone: form.phone,
        password: form.password, role,
      });
      setEmailSentTo(form.email);
      setStep(3);
    } catch (err) {
      const code     = err.response?.data?.code;
      const pwErrors = err.response?.data?.password_errors;
      if (code === 'REGISTRATION_DISABLED') {
        setErrors({ global: t('auth.registration_disabled', 'Registration is currently disabled. Please contact the administrator.') });
      } else if (pwErrors?.length) {
        // Backend sends an array of password rule violations — join them into one message
        setErrors({ global: 'Password requirements: ' + pwErrors.join(', ') + '.' });
      } else {
        setErrors({ global: err.response?.data?.error || 'Registration error.' });
      }
    } finally { setLoading(false); }
  }

  // Curried field change handler — f('first_name') returns an onChange that updates form.first_name
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* App logo / brand mark */}
        <div className="text-center mb-6">
          <div className="w-12 h-12 bg-teal-600 rounded-xl flex items-center justify-center mx-auto mb-3">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
          </div>
          <h1 className="text-xl font-bold">{appName}</h1>
        </div>

        {/* ── Step 1 — Role selection ────────────────────────── */}
        {/* The user picks their role before seeing the form so that
            we can show role-specific guidance (e.g. driver approval notice). */}
        {step === 1 && (
          <div className="card">
            <h2 className="text-base font-semibold mb-4">{t('auth.i_am')}</h2>
            <div className="space-y-3 mb-6">
              {[
                { val: 'client', label: t('auth.a_client'), desc: t('auth.a_client_desc'), icon: '🧑' },
                { val: 'driver', label: t('auth.a_driver'), desc: t('auth.a_driver_desc'), icon: '🚗' },
              ].map(opt => (
                <button key={opt.val} onClick={() => setRole(opt.val)}
                  className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
                    role === opt.val ? 'border-teal-400 bg-teal-50 dark:bg-teal-900/30' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                  }`}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{opt.icon}</span>
                    <div>
                      <div className="font-medium text-sm">{opt.label}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{opt.desc}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            {/* Driver-specific notice: new driver accounts require admin approval before login */}
            {role === 'driver' && (
              <p className="text-xs text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-900/30 border border-teal-100 dark:border-teal-800 rounded-lg p-3 mb-5">
                {t('auth.driver_pending_notice')}
              </p>
            )}
            {/* Continue button disabled until a role is selected */}
            <button className="btn-primary w-full" disabled={!role} onClick={() => setStep(2)}>
              {t('auth.continue')}
            </button>
          </div>
        )}

        {/* ── Step 2 — Personal info form ───────────────────── */}
        {step === 2 && (
          <div className="card">
            {/* Back button returns to role selection without losing the form data */}
            <button onClick={() => setStep(1)} className="text-xs text-gray-400 hover:text-gray-600 mb-4 flex items-center gap-1">
              {t('auth.back')}
            </button>
            <h2 className="text-base font-semibold mb-4">{t('auth.my_info')}</h2>

            {/* Global error box — shown for server errors (e.g. email already registered) */}
            {errors.global && (
              <div className="bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 text-red-600 text-sm rounded-lg p-3 mb-4">
                {errors.global}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">{t('auth.first_name')}</label>
                  <input className="input" value={form.first_name} onChange={f('first_name')} required />
                  {errors.first_name && <p className="text-red-500 text-xs mt-1">{errors.first_name}</p>}
                </div>
                <div>
                  <label className="label">{t('auth.last_name')}</label>
                  <input className="input" value={form.last_name} onChange={f('last_name')} required />
                  {errors.last_name && <p className="text-red-500 text-xs mt-1">{errors.last_name}</p>}
                </div>
              </div>
              <div>
                <label className="label">{t('auth.email')}</label>
                <input className="input" type="email" value={form.email} onChange={f('email')} required />
                {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email}</p>}
              </div>
              <div>
                <label className="label">{t('auth.phone')}</label>
                {/* PhoneField handles country flag + E.164 formatting */}
                <PhoneField value={form.phone} onChange={v => setForm(p => ({ ...p, phone: v || '' }))} error={errors.phone} />
              </div>
              <div>
                <label className="label">{t('auth.password')}</label>
                <input className="input" type="password" value={form.password} onChange={f('password')} required />
                {/* PasswordStrength renders a live checklist of password rules below the field */}
                <PasswordStrength password={form.password} />
              </div>
              <div>
                <label className="label">{t('auth.confirm_password')}</label>
                <input className="input" type="password" value={form.confirm} onChange={f('confirm')} required />
                {errors.confirm && <p className="text-red-500 text-xs mt-1">{errors.confirm}</p>}
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
                {loading ? t('auth.creating') : t('auth.create_account')}
              </button>
            </form>
          </div>
        )}

        {/* ── Step 3 — Email sent confirmation ──────────────── */}
        {/* No navigation away — user must go to their inbox and click the link.
            A "Back to login" button is shown in case they already verified. */}
        {step === 3 && (
          <div className="card text-center">
            <div className="w-16 h-16 bg-teal-100 dark:bg-teal-900/40 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">📧</div>
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-3">{t('auth.check_email')}</h2>
            <p className="text-gray-600 dark:text-gray-300 text-sm mb-2">{t('auth.confirm_email_sent')}</p>
            {/* Show the address so the user knows which inbox to check */}
            <p className="font-semibold text-teal-700 dark:text-teal-300 text-sm mb-5 break-all">{emailSentTo}</p>
            <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-100 dark:border-gray-700 rounded-lg p-4 text-left mb-5">
              <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                📌 <strong>{t('auth.next_steps')}</strong><br />
                1. {t('auth.next_step_1')}<br />
                2. {t('auth.next_step_2')}<br />
                3. {t('auth.next_step_3')}<br /><br />
                ⚠️ {t('auth.link_expires')}
              </p>
            </div>
            <Link to="/login" className="btn-secondary inline-block text-sm">
              {t('auth.back_to_login')}
            </Link>
          </div>
        )}

        {/* "Already have an account?" link — shown on steps 1 and 2 */}
        {step !== 3 && (
          <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
            {t('auth.already_have_account')}{' '}
            <Link to="/login" className="text-teal-600 dark:text-teal-400 font-medium hover:underline">{t('auth.login')}</Link>
          </p>
        )}

        <PublicFooter />
      </div>
    </div>
  );
}
