/**
 * My Profile Page  —  /client/profile, /driver/profile, /admin/profile
 *
 * Authenticated page — users can view and edit their own profile.
 * The courriel (email) field is read-only (it is the permanent account identifier).
 *
 * Tab structure:
 *   "Personal Information" — first name, last name, phone (all roles)
 *   "Rider Profile"        — vulnerability type (optional), address,
 *                            emergency contact, mobility notes (clients only)
 *   "Vehicle"              — vehicle details, home address, service radius (drivers only)
 *   "Security"             — change password, delete account (all roles)
 *
 * Vulnerability type note:
 *   This field is entirely optional and is not collected at registration.
 *   A descriptive note explains its purpose to reassure users.
 *
 * Account deletion (Law 25 / GDPR):
 *   GET /profile/check-deletion is called first to determine the correct action.
 *   Users with no payment history → hard delete immediately.
 *   Users with payment history    → anonymization only.
 *   Confirmation requires typing: "DELETE MY ACCOUNT"
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { profileService } from '../services/api';
import { LoadingPage, FormField, PhoneField, validatePhone, AddressAutocomplete } from '../components/common';
import PasswordStrength from '../components/common/PasswordStrength';
import toast from 'react-hot-toast';

/**
 * Vulnerability type options for the client profile dropdown.
 * The empty string value corresponds to "Prefer not to say" — this is the default
 * and means the field is not filled in, which is perfectly valid.
 */
const VULNERABILITY_TYPES = [
  { val: '',                    key: 'vulnerability.prefer_not_to_say' },
  { val: 'elderly',             key: 'vulnerability.elderly' },
  { val: 'hearing_impaired',    key: 'vulnerability.hearing_impaired' },
  { val: 'mild_disability',     key: 'vulnerability.mild_disability' },
  { val: 'no_drivers_license',  key: 'vulnerability.no_drivers_license' },
  { val: 'other',               key: 'vulnerability.other' },
];

/**
 * MyProfile — main page component.
 *
 * State:
 *   profile          — raw profile object from the API (used for display-only fields)
 *   loading          — true during initial profile fetch
 *   tab              — active tab key: 'info' | 'client' | 'driver' | 'security'
 *   saving           — true while any save/delete request is in-flight
 *   showPwModal      — true when the change-password modal is open
 *   showDeleteModal  — holds the response from check-deletion (null = modal closed)
 *   deleteConfirm    — text the user must type to confirm account deletion
 *
 *   formInfo    — editable fields for the Personal Information tab
 *   formClient  — editable fields for the Rider Profile tab (clients only)
 *   formDriver  — editable fields for the Vehicle tab (drivers only)
 *   formPw      — fields for the change-password modal
 */
export default function MyProfile() {
  const { t } = useTranslation();
  const { user, refreshUser, logout } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState('info');
  const [saving, setSaving]     = useState(false);
  const [showPwModal, setShowPwModal]         = useState(false);
  // showDeleteModal holds the API response shape: { anonymize_only, reason }
  const [showDeleteModal, setShowDeleteModal] = useState(null);
  const [deleteConfirm, setDeleteConfirm]     = useState('');

  // Separate form state objects per tab — avoids mixing fields across sections
  const [formInfo,   setFormInfo]   = useState({});
  const [formClient, setFormClient] = useState({});
  const [formDriver, setFormDriver] = useState({});
  const [formPw,     setFormPw]     = useState({ current: '', new: '', confirm: '' });

  // Convenience flags for conditional tab/field rendering
  const isDriver = user?.role === 'driver';
  const isClient = user?.role === 'client';

  /**
   * On mount: fetch the full profile and populate each form state object
   * from the returned data. Nested objects (client_profile, driver_profile)
   * are flattened into their respective form state for simpler input binding.
   */
  useEffect(() => {
    profileService.get().then(({ data }) => {
      const p = data.profile;
      setProfile(p);
      setFormInfo({ first_name: p.first_name, last_name: p.last_name, phone: p.phone || '' });
      if (p.client_profile) {
        setFormClient({
          vulnerability_type:      p.client_profile.vulnerability_type || '',
          address:                 p.client_profile.address || '',
          emergency_contact_name:  p.client_profile.emergency_contact_name || '',
          emergency_contact_phone: p.client_profile.emergency_contact_phone || '',
          mobility_notes:          p.client_profile.mobility_notes || '',
          preferred_language:      p.client_profile.preferred_language || 'fr',
        });
      }
      if (p.driver_profile) {
        setFormDriver({
          vehicle_make:  p.driver_profile.vehicle_make  || '',
          vehicle_model: p.driver_profile.vehicle_model || '',
          vehicle_year:  p.driver_profile.vehicle_year  || new Date().getFullYear(),
          vehicle_color: p.driver_profile.vehicle_color || '',
          license_plate: p.driver_profile.license_plate || '',
          seat_count:    p.driver_profile.seat_count    || 4,
          home_address:  p.driver_profile.home_address  || '',
          // service_radius_km is NOT editable — it is read from profile.driver_profile
          // and displayed as a read-only field.  Admin controls it via Configuration.
        });
      }
    }).finally(() => setLoading(false));
  }, []);

  /**
   * Save the Personal Information tab (first name, last name, phone).
   * Validates phone via the shared validatePhone utility before submitting.
   * refreshUser() updates the AuthContext so the sidebar name reflects the change.
   */
  async function saveInfo(e) {
    e.preventDefault();
    if (!validatePhone(formInfo.phone)) {
      toast.error(t('auth.phone_invalid'));
      return;
    }
    setSaving(true);
    try { await profileService.update(formInfo); await refreshUser(); toast.success(t('profile.saved')); }
    catch { /* error toast handled by api.js interceptor */ } finally { setSaving(false); }
  }

  /**
   * Save the Rider Profile tab (vulnerability type, address, emergency contact, etc.).
   * Client-only fields — this endpoint is not called for drivers or admins.
   */
  async function saveClient(e) {
    e.preventDefault(); setSaving(true);
    try { await profileService.updateClient(formClient); toast.success(t('profile.saved')); }
    catch { /* error toast handled by api.js interceptor */ } finally { setSaving(false); }
  }

  /**
   * Save the Vehicle tab (make, model, year, plate, seat count, home address).
   * Driver-only fields — this endpoint is not called for clients or admins.
   *
   * Handles two non-error responses from the server:
   *   geocode_warning    — address text could not be verified; other fields were saved
   *   promoted_to_pending — profile is now complete and was auto-promoted for admin review
   */
  async function saveDriver(e) {
    e.preventDefault(); setSaving(true);
    try {
      const { data } = await profileService.updateDriver(formDriver);
      if (data.geocode_warning) {
        toast.error(t('profile.geocode_warning'));
      } else {
        toast.success(t('profile.saved'));
      }
      if (data.promoted_to_pending) {
        toast.success(t('profile.promoted_to_pending'));
      }
      // Refresh the profile so the approval status banner reflects any change.
      const refreshed = await profileService.get();
      setProfile(refreshed.data.profile);
    } catch { /* toast already fired by global interceptor */ } finally { setSaving(false); }
  }

  /**
   * Change the user's password via the Security tab modal.
   * Validates that new and confirm match on the client side first.
   * On success: closes the modal and resets the password form fields.
   * On failure: backend may return password_errors[] for rule violations
   * (e.g. "must be at least 8 characters") — all errors are joined and shown.
   */
  async function changePassword(e) {
    e.preventDefault();
    if (formPw.new !== formPw.confirm) { toast.error(t('profile.passwords_no_match')); return; }
    setSaving(true);
    try {
      await profileService.changePassword({ current_password: formPw.current, new_password: formPw.new });
      toast.success(t('profile.password_changed'));
      setShowPwModal(false);
      setFormPw({ current: '', new: '', confirm: '' });
    } catch (err) {
      const pwErr = err.response?.data?.password_errors;
      if (pwErr?.length) toast.error(pwErr.join(' · '));
    } finally { setSaving(false); }
  }

  /**
   * Pre-flight check before showing the account deletion modal.
   * The backend determines whether to hard-delete or anonymize based on
   * whether the user has any payment history (Law 25 / GDPR compliance).
   * The response is stored in showDeleteModal and drives the modal's messaging.
   */
  async function checkDelete() {
    const { data } = await profileService.checkDeletion();
    setShowDeleteModal(data);
    setDeleteConfirm('');
  }

  /**
   * Execute the account deletion/anonymization.
   * The exact phrase "DELETE MY ACCOUNT" must be typed to confirm — this
   * prevents accidental clicks on the destructive action button.
   * On success: logs the user out and redirects to /login.
   */
  async function deleteAccount() {
    // The confirmation phrase is intentionally kept in English in all locales — the
    // backend validates against the fixed string 'DELETE MY ACCOUNT'.
    if (deleteConfirm !== 'DELETE MY ACCOUNT') {
      toast.error(t('profile.confirm_delete_mismatch')); return;
    }
    setSaving(true);
    try {
      const { data } = await profileService.deleteAccount({ confirmation: 'DELETE MY ACCOUNT' });
      toast.success(data.type === 'anonymized' ? t('profile.anonymized_success') : t('profile.deleted_success'));
      logout(); navigate('/login');
    } catch { /* toast already fired by global interceptor */ } finally { setSaving(false); }
  }

  // Curried change handlers: fi('first_name') returns an onChange handler that
  // updates formInfo.first_name. This avoids writing repetitive onChange functions.
  const fi = k => e => setFormInfo(p => ({ ...p, [k]: e.target.value }));
  const fc = k => e => setFormClient(p => ({ ...p, [k]: e.target.value }));
  const fd = k => e => setFormDriver(p => ({ ...p, [k]: e.target.value }));

  /**
   * Tab definitions — role-specific tabs are conditionally included.
   * Clients get the "Rider Profile" tab; drivers get the "Vehicle" tab.
   * All roles see Personal Info and Security.
   */
  const TABS = [
    { val: 'info',   label: t('profile.personal_info') },
    ...(isClient ? [{ val: 'client', label: t('profile.client_profile') }] : []),
    ...(isDriver ? [{ val: 'driver', label: t('profile.vehicle') }]        : []),
    { val: 'security', label: t('profile.security') },
  ];

  if (loading) return <LoadingPage />;
  if (!profile) return null;

  // Avatar initials — first letter of first name + first letter of last name, uppercased
  const initials = `${profile.first_name[0]}${profile.last_name[0]}`.toUpperCase();

  // Format the member number with role prefix and zero-padded to 4 digits
  const memberPrefix = profile.role === 'driver' ? 'D' : profile.role === 'client' ? 'C' : 'A';
  const memberTag = profile.member_number
    ? `${memberPrefix}-${String(profile.member_number).padStart(4, '0')}`
    : null;

  return (
    <div>
      {/* Header — avatar initials, full name, email, member-since date */}
      <div className="flex items-center gap-5 mb-8">
        <div className="w-16 h-16 rounded-full bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center text-teal-700 dark:text-teal-300 font-bold text-2xl flex-shrink-0">
          {initials}
        </div>
        <div>
          <h1>{profile.first_name} {profile.last_name}</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-0.5">{profile.email}</p>
          {memberTag && (
            <p className="mt-1">
              <span className="inline-flex items-center gap-1 bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border border-teal-200 rounded px-2 py-0.5 text-xs font-mono font-semibold">
                🪪 {t('profile.member_id')} : {memberTag}
              </span>
            </p>
          )}
          <p className="text-gray-400 text-xs mt-0.5">
            {t('profile.member_since')} {new Date(profile.created_at).toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
      </div>

      {/* Tab bar — horizontally scrollable on small screens */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700 mb-6 overflow-x-auto">
        {TABS.map(tab_ => (
          <button key={tab_.val} onClick={() => setTab(tab_.val)}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
              tab === tab_.val ? 'border-teal-500 text-teal-600 dark:text-teal-400 font-medium' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700'
            }`}>
            {tab_.label}
          </button>
        ))}
      </div>

      {/* ── Personal info tab ──────────────────────────────────── */}
      {tab === 'info' && (
        <form onSubmit={saveInfo} className="card max-w-lg space-y-4">
          <h2 className="text-base">{t('profile.personal_info')}</h2>
          {/* Email is permanently read-only — it is the unique account identifier */}
          <div>
            <label className="label">{t('auth.email')} ({t('auth.permanent_email_note').slice(0,20)}…)</label>
            <input className="input bg-gray-50 dark:bg-gray-700/50 text-gray-400 cursor-not-allowed" value={profile.email} disabled />
            <p className="text-xs text-gray-400 mt-1">{t('auth.permanent_email_note')}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label={<><span className="text-red-500 mr-1">*</span>{t('auth.first_name')}</>}>
              <input className="input" value={formInfo.first_name} onChange={fi('first_name')} required />
            </FormField>
            <FormField label={<><span className="text-red-500 mr-1">*</span>{t('auth.last_name')}</>}>
              <input className="input" value={formInfo.last_name} onChange={fi('last_name')} required />
            </FormField>
          </div>
          <FormField label={<><span className="text-red-500 mr-1">*</span>{t('auth.phone')}</>}>
            {/* PhoneField outputs E.164 format; we store the raw value in formInfo.phone */}
            <PhoneField value={formInfo.phone} onChange={v => setFormInfo(p => ({ ...p, phone: v || '' }))} />
          </FormField>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? t('profile.saving') : t('profile.save')}
          </button>
        </form>
      )}

      {/* ── Rider profile tab (clients only) ──────────────────── */}
      {tab === 'client' && (
        <form onSubmit={saveClient} className="card max-w-lg space-y-4">
          <h2 className="text-base">{t('profile.client_profile')}</h2>
          {/* Blue info box explains why vulnerability type is optional and how it is used */}
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 rounded-lg p-3">
            <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">{t('profile.situation_note')}</p>
          </div>
          <FormField label={t('profile.situation_title')}>
            <select className="input" value={formClient.vulnerability_type} onChange={fc('vulnerability_type')}>
              {VULNERABILITY_TYPES.map(v => (
                <option key={v.val} value={v.val}>{t(v.key)}</option>
              ))}
            </select>
          </FormField>
          <FormField label={t('profile.address')}>
            <input className="input" placeholder="Ex: 145 Sherbrooke St, Montreal, QC"
              value={formClient.address} onChange={fc('address')} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t('profile.emergency_contact')}>
              <input className="input" value={formClient.emergency_contact_name} onChange={fc('emergency_contact_name')} />
            </FormField>
            <FormField label={t('profile.emergency_phone')}>
              <PhoneField value={formClient.emergency_contact_phone} onChange={v => setFormClient(p => ({ ...p, emergency_contact_phone: v || '' }))} />
            </FormField>
          </div>
          <FormField label={t('profile.mobility_notes')}>
            {/* Free-text field for accessibility needs (wheelchair, walker, etc.) */}
            <textarea className="input" rows={3} placeholder={t('profile.mobility_placeholder')}
              value={formClient.mobility_notes} onChange={fc('mobility_notes')} />
          </FormField>
          <FormField label={t('profile.preferred_language')}>
            {/* Preferred language affects which language the client receives emails in */}
            <select className="input" value={formClient.preferred_language} onChange={fc('preferred_language')}>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </FormField>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? t('profile.saving') : t('profile.save_client')}
          </button>
        </form>
      )}

      {/* ── Vehicle tab (drivers only) ─────────────────────────── */}
      {tab === 'driver' && (
        <form onSubmit={saveDriver} className="card max-w-lg space-y-4">
          <h2 className="text-base">{t('profile.vehicle')}</h2>

          {/* Approval status banner */}
          {profile.driver_profile?.approval_status && (
            <div className={`text-xs rounded-lg px-3 py-2 ${
              profile.driver_profile.approval_status === 'approved'
                ? 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border border-teal-100 dark:border-teal-800'
                : profile.driver_profile.approval_status === 'incomplete'
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-800'
                : 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-100 dark:border-amber-800'
            }`}>
              {t('profile.approval_status')}: <strong>{t(`status.${profile.driver_profile.approval_status}`)}</strong>
              {profile.driver_profile.approval_status === 'incomplete' && (
                <span className="ml-2 opacity-80">— {t('profile.incomplete_hint')}</span>
              )}
            </div>
          )}

          {/* Required field legend */}
          <p className="text-xs text-gray-400">{t('profile.required_field_note')}</p>

          <div className="grid grid-cols-2 gap-3">
            <FormField label={<><span className="text-red-500 mr-1">*</span>{t('profile.vehicle_make')}</>}>
              <input className="input" placeholder="Toyota" value={formDriver.vehicle_make}
                onChange={fd('vehicle_make')} required />
            </FormField>
            <FormField label={<><span className="text-red-500 mr-1">*</span>{t('profile.vehicle_model')}</>}>
              <input className="input" placeholder="Camry" value={formDriver.vehicle_model}
                onChange={fd('vehicle_model')} required />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label={<><span className="text-red-500 mr-1">*</span>{t('profile.vehicle_year')}</>}>
              {/* Select dropdown avoids browser number-input quirks and constrains valid range */}
              <select className="input" value={formDriver.vehicle_year} onChange={fd('vehicle_year')} required>
                {Array.from(
                  { length: new Date().getFullYear() + 2 - 1990 },
                  (_, i) => new Date().getFullYear() + 1 - i
                ).map(year => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </FormField>
            <FormField label={<><span className="text-red-500 mr-1">*</span>{t('profile.license_plate')}</>}>
              <input className="input" placeholder="ABC-1234" value={formDriver.license_plate}
                onChange={fd('license_plate')} required />
            </FormField>
            <FormField label={<><span className="text-red-500 mr-1">*</span>{t('profile.vehicle_color')}</>}>
              <input className="input" placeholder="Blanc, Noir, Rouge…" value={formDriver.vehicle_color}
                onChange={fd('vehicle_color')} required />
            </FormField>
            <FormField label={t('profile.seat_count')}>
              <select className="input" value={formDriver.seat_count} onChange={fd('seat_count')}>
                {[1,2,3,4,5,6,7,8].map(n => (
                  <option key={n} value={n}>{n} {n > 1 ? t('common.seats') : t('common.seats_one')}</option>
                ))}
              </select>
            </FormField>
          </div>

          {/* Service radius — read-only, set by admin configuration */}
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">{t('profile.service_radius')}</p>
            <p className="text-sm text-gray-700 dark:text-gray-200 font-semibold">
              {profile.driver_profile?.service_radius_km ?? '—'} km
            </p>
            <p className="text-xs text-gray-400 mt-0.5">{t('profile.service_radius_info')}</p>
          </div>

          <FormField label={<><span className="text-red-500 mr-1">*</span>{t('profile.home_address')}</>}>
            {/* AddressAutocomplete provides Nominatim-backed suggestions, same as the trip wizard */}
            <AddressAutocomplete
              value={formDriver.home_address}
              onChange={v => setFormDriver(p => ({ ...p, home_address: v }))}
              onSelect={({ label }) => setFormDriver(p => ({ ...p, home_address: label }))}
              placeholder="55 Wellington St, Verdun, QC"
              required
            />
            <p className="text-xs text-gray-400 mt-1">{t('profile.home_address_hint')}</p>
          </FormField>

          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? t('profile.saving') : t('profile.save_vehicle')}
          </button>
        </form>
      )}

      {/* ── Security tab ───────────────────────────────────────── */}
      {tab === 'security' && (
        <div className="space-y-5 max-w-lg">
          {/* Change password card */}
          <div className="card">
            <h2 className="text-base mb-4">{t('auth.password')}</h2>
            <button onClick={() => setShowPwModal(true)} className="btn-secondary">
              {t('profile.change_password')}
            </button>
          </div>
          {/* Danger zone — account deletion/anonymization */}
          <div className="card border-red-100 dark:border-red-800">
            <h2 className="text-base mb-2 text-red-700 dark:text-red-300">{t('profile.danger_zone')}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('profile.delete_warning')}</p>
            {/* checkDelete runs the pre-flight API call before showing the confirm modal */}
            <button onClick={checkDelete} className="btn-danger text-sm">{t('profile.delete_account')}</button>
          </div>
        </div>
      )}

      {/* ── Change password modal ──────────────────────────────── */}
      {showPwModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-base font-semibold">{t('profile.change_password')}</h2>
              <button onClick={() => setShowPwModal(false)} className="text-gray-400 text-xl px-2">✕</button>
            </div>
            <form onSubmit={changePassword} className="space-y-4">
              <FormField label={t('profile.current_password')}>
                <input className="input" type="password" value={formPw.current}
                  onChange={e => setFormPw(p => ({ ...p, current: e.target.value }))} required />
              </FormField>
              <FormField label={t('profile.new_password')}>
                <input className="input" type="password" value={formPw.new}
                  onChange={e => setFormPw(p => ({ ...p, new: e.target.value }))} required />
                {/* Live strength indicator shown below the new password field */}
                <PasswordStrength password={formPw.new} />
              </FormField>
              <FormField label={t('profile.confirm_new_password')}>
                <input className="input" type="password" value={formPw.confirm}
                  onChange={e => setFormPw(p => ({ ...p, confirm: e.target.value }))} required />
              </FormField>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowPwModal(false)} className="btn-secondary flex-1">{t('common.cancel')}</button>
                <button type="submit" disabled={saving} className="btn-primary flex-1">
                  {saving ? t('profile.saving') : t('common.confirm')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Account deletion / anonymization confirm modal ─────── */}
      {/* showDeleteModal holds: { anonymize_only: bool, reason: string } */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-4">
              {/* Title differs based on whether the account has payment history */}
              <h2 className="text-base font-semibold text-red-700 dark:text-red-300">
                {showDeleteModal.anonymize_only ? t('profile.delete_title_anonymize') : t('profile.delete_title_permanent')}
              </h2>
              <button onClick={() => setShowDeleteModal(null)} className="text-gray-400 text-xl px-2">✕</button>
            </div>
            {/* Reason box — backend explains why hard delete vs. anonymize is chosen */}
            <div className={`rounded-lg p-4 mb-5 text-sm ${showDeleteModal.anonymize_only ? 'bg-amber-50 dark:bg-amber-900/30 border border-amber-100 dark:border-amber-800 text-amber-800 dark:text-amber-200' : 'bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-800 text-red-800 dark:text-red-200'}`}>
              {showDeleteModal.reason}
            </div>
            {/* Confirmation phrase — must match exactly "DELETE MY ACCOUNT" */}
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              {t('profile.confirm_delete')}{' '}
              <strong className="font-mono">{t('profile.confirm_delete_phrase')}</strong>
            </p>
            <input className="input mb-4" placeholder="DELETE MY ACCOUNT"
              value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} />
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteModal(null)} className="btn-secondary flex-1">{t('common.cancel')}</button>
              <button onClick={deleteAccount} disabled={saving} className="btn-danger flex-1">
                {saving ? t('profile.deleting') : showDeleteModal.anonymize_only ? t('profile.anonymize_button') : t('profile.delete_button')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
