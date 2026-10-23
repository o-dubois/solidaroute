/**
 * @file AdminUserManagement.jsx
 * @route /admin/user-management
 * @access Superadmin only
 *
 * The top-level user management console for superadmins. This page is the
 * single place where operator and superadmin accounts are created, edited,
 * enabled/disabled, and deleted. Regular admins (operators) cannot access
 * this page — they are themselves managed here.
 *
 * Layout: two tabs, one per role (Operators | Administrators/Superadmins).
 * Each tab renders the same <AccountTab> component, keyed by role so that
 * state resets cleanly when switching tabs.
 *
 * Protected accounts (is_protected = true, typically the seed superadmin)
 * show a lock icon and block all edits and deletion to prevent accidental
 * lockout of the system.
 *
 * Sub-components (all defined in this file):
 *   - AccountFormPanel  — slide-in form for creating or editing an account
 *   - AccountDetailPanel — slide-in view of an account with actions
 *   - AccountTab         — full tab content (list + both panels)
 *   - AdminUserManagement (default export) — page shell with tab switcher
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { adminService } from '../../services/api';
import { LoadingPage, EmptyState, StatusBadge, RoleBadge, PhoneField, PhoneDisplay, validatePhone } from '../../components/common';

// ── Form panel (create / edit) ──────────────────────────────────

/**
 * AccountFormPanel
 *
 * Slide-in right-hand panel used for both creating a new account and editing
 * an existing one. The `editing` prop distinguishes the two modes:
 *   - undefined / null  → create mode (email field is editable, password required)
 *   - user object       → edit mode   (email is read-only, password optional)
 *
 * Email is intentionally locked after creation because it acts as the login
 * identifier and changing it could break active sessions or verification links.
 *
 * On success the parent receives the saved user object via `onSaved(user, mode)`
 * so it can update the list without a full refetch.
 *
 * @param {object|null|undefined} editing - The account being edited, or falsy for create mode.
 * @param {Function} onClose  - Called when the panel should close (backdrop click or cancel).
 * @param {Function} onSaved  - Called with (savedUser, 'created'|'updated') on success.
 */
function AccountFormPanel({ editing, defaultRole = 'operator', onClose, onSaved }) {
  const { t } = useTranslation();
  // Derive create vs. edit mode from the presence of an existing account object
  const isCreate = !editing;

  // Form field state — email is only used when creating (see validate/handleSubmit)
  const [form, setForm] = useState({
    first_name: editing?.first_name || '',
    last_name:  editing?.last_name  || '',
    email:      '',                          // not pre-filled: email is immutable after creation
    phone:      editing?.phone      || '',
    // Use the tab's role as the default so "New account" on the Superadmin tab
    // doesn't silently create an operator if the dropdown is left untouched.
    role:       editing?.role       || defaultRole,
    password:   '',
    confirm:    '',
  });
  const [saving, setSaving] = useState(false);
  // Per-field validation errors keyed by field name
  const [errors, setErrors] = useState({});

  /**
   * Generic field setter that also clears the validation error for that field,
   * giving the user immediate visual feedback as they correct a mistake.
   */
  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
    setErrors(e => ({ ...e, [field]: undefined }));
  }

  /**
   * Client-side validation before hitting the API.
   * Returns an object of { fieldName: errorMessage }. Empty object = valid.
   *
   * Password confirmation is checked only when a password is actually provided,
   * which allows editing without touching the password at all.
   */
  function validate() {
    const e = {};
    const req = t('common.field_required');
    if (!form.first_name.trim()) e.first_name = req;
    if (!form.last_name.trim())  e.last_name  = req;
    if (isCreate) {
      // Email is required and must be a valid address on create
      if (!form.email.trim()) {
        e.email = req;
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
        e.email = t('auth.email_invalid');
      }
      // Password is mandatory when creating a new account
      if (!form.password) e.password = req;
    }
    // Confirm must match if the user typed anything in the password field
    if (form.password && form.password !== form.confirm) e.confirm = t('profile.passwords_no_match');
    if (!form.phone.trim())        e.phone = req;
    else if (!validatePhone(form.phone)) e.phone = t('auth.phone_invalid');
    return e;
  }

  /**
   * Submits the form to the API.
   *
   * Payload is built conservatively — password is only sent when the field has
   * a value, and email is only included for new accounts.
   *
   * The API may return structured field errors (EMAIL_IN_USE, PHONE_IN_USE) that
   * are surfaced inline rather than as a generic toast so the user knows exactly
   * what to fix.
   */
  async function handleSubmit(ev) {
    ev.preventDefault();
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    setSaving(true);
    try {
      const payload = {
        first_name: form.first_name.trim(),
        last_name:  form.last_name.trim(),
        phone:      form.phone.trim(),
        role:       form.role,
      };
      // Only send password when the field was filled (allows edits without resetting it)
      if (form.password) payload.password = form.password;
      // Email is immutable after creation — only include it when creating
      if (isCreate)      payload.email    = form.email.trim();

      if (isCreate) {
        const { data } = await adminService.createOperator(payload);
        toast.success(t('admin.operators_created'));
        onSaved(data.user, 'created');
      } else {
        const { data } = await adminService.updateOperator(editing.id, payload);
        toast.success(t('admin.operators_updated'));
        onSaved(data.user, 'updated');
      }
    } catch (err) {
      // The API returns structured error codes for uniqueness violations so we
      // can point the user to the exact field rather than showing a vague toast
      const data = err.response?.data;
      if (data?.code === 'EMAIL_IN_USE') {
        setErrors(e => ({ ...e, email: data.error }));
      } else if (data?.code === 'PHONE_IN_USE') {
        setErrors(e => ({ ...e, phone: data.error }));
      } else if (data?.error) {
        toast.error(data.error);
      } else if (data?.errors) {
        // Express-validator returns an array of { msg } objects
        toast.error(data.errors.map(e => e.msg).join(' · ') || t('common.error'));
      }
    } finally {
      setSaving(false);
    }
  }

  /**
   * Returns the Tailwind class string for an input field, adding a red tint
   * when the field currently has a validation error.
   */
  const cls = (field) => `input w-full ${errors[field] ? 'border-red-400 bg-red-50 dark:bg-red-900/30' : ''}`;

  return (
    <>
      {/* Semi-transparent backdrop — clicking it closes the panel */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      {/* Slide-in panel (right side) */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-gray-800 shadow-xl z-50 overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-50">
            {isCreate ? t('admin.operators_create_title') : t('admin.operators_edit_title')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl p-1">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{t('auth.first_name')}</label>
              <input className={cls('first_name')} value={form.first_name}
                onChange={e => set('first_name', e.target.value)} autoComplete="given-name" />
              {errors.first_name && <p className="text-red-500 text-xs mt-1">{errors.first_name}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{t('auth.last_name')}</label>
              <input className={cls('last_name')} value={form.last_name}
                onChange={e => set('last_name', e.target.value)} autoComplete="family-name" />
              {errors.last_name && <p className="text-red-500 text-xs mt-1">{errors.last_name}</p>}
            </div>
          </div>

          {/* Email: editable on create, read-only on edit (email is the login identifier) */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{t('auth.email')}</label>
            {isCreate ? (
              <>
                <input className={cls('email')} value={form.email}
                  onChange={e => set('email', e.target.value)} type="email" autoComplete="email" />
                {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email}</p>}
              </>
            ) : (
              // Grayed-out read-only input to make it visually clear the field is locked
              <input className="input w-full bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400" value={editing.email} readOnly />
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{t('auth.phone')}</label>
            {/* PhoneField handles international formatting and E.164 normalisation */}
            <PhoneField value={form.phone} onChange={v => set('phone', v || '')} error={errors.phone || undefined} />
          </div>

          {/* Role selector: operator, ticket_master, or superadmin */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{t('admin.operators_role_label')}</label>
            <select className="input w-full" value={form.role} onChange={e => set('role', e.target.value)}>
              <option value="operator">{t('roles.operator')}</option>
              <option value="ticket_master">{t('roles.ticket_master')}</option>
              <option value="superadmin">{t('roles.superadmin')}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{t('auth.password')}</label>
            {/* On edit, remind the admin that leaving this blank keeps the existing password */}
            {!isCreate && (
              <p className="text-xs text-gray-400 mb-1">{t('admin.operators_password_hint')}</p>
            )}
            <input className={cls('password')} value={form.password} type="password"
              onChange={e => set('password', e.target.value)} autoComplete="new-password" />
            {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{t('auth.confirm_password')}</label>
            <input className={cls('confirm')} value={form.confirm} type="password"
              onChange={e => set('confirm', e.target.value)} autoComplete="new-password" />
            {errors.confirm && <p className="text-red-500 text-xs mt-1">{errors.confirm}</p>}
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving} className="btn-primary flex-1 disabled:opacity-50">
              {saving ? t('admin.saving') : isCreate ? t('admin.operators_create_btn') : t('admin.operators_save_btn')}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">
              {t('admin.cancel')}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// ── Detail panel ────────────────────────────────────────────────

/**
 * AccountDetailPanel
 *
 * Slide-in panel that shows the full profile of an operator or superadmin
 * account, and exposes the actions that can be taken on it:
 *   - Enable / Disable (toggle account status)
 *   - Edit (opens AccountFormPanel over this panel)
 *   - Delete (soft delete, with an inline two-step confirmation)
 *
 * Several safety guards are in place:
 *   - Protected accounts (is_protected) show a lock notice and hide all actions.
 *   - The currently logged-in user cannot modify their own account (isMe).
 *   - Delete shows a confirmation step before calling the API to prevent accidents.
 *
 * @param {object}   account         - The account object to display.
 * @param {object}   currentUser     - The logged-in user (from AuthContext).
 * @param {Function} onClose         - Closes this panel.
 * @param {Function} onStatusChanged - Called with (userId, newStatus) after toggle.
 * @param {Function} onEdit          - Called with the account object to open the edit form.
 * @param {Function} onDeleted       - Called with userId after successful deletion.
 */
function AccountDetailPanel({ account, currentUser, onClose, onStatusChanged, onEdit, onDeleted }) {
  const { t, i18n } = useTranslation();
  // Prevent an admin from accidentally disabling or deleting themselves
  const isMe        = account.id === currentUser?.id;
  // Seed/system accounts that must never be modified
  const isProtected = account.is_protected;

  const [toggling, setToggling]           = useState(false);
  // Two-step delete: first click sets confirmDelete=true, second click calls the API
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]           = useState(false);

  /**
   * Toggles the account between active and suspended.
   * Optimistically updates the parent list via onStatusChanged rather than
   * waiting for a refetch, keeping the UI snappy.
   */
  function handleToggleStatus() {
    const newStatus = account.status === 'active' ? 'suspended' : 'active';
    setToggling(true);
    adminService.updateStatus(account.id, { status: newStatus })
      .then(() => onStatusChanged(account.id, newStatus))
      .catch(() => {})
      .finally(() => setToggling(false));
  }

  /**
   * Performs the confirmed hard-delete (soft-delete on the server).
   * On success the account is removed from the parent list and this panel closes.
   * On failure the error is shown as a toast and the confirm state is reset so
   * the user can try again or cancel.
   */
  async function handleDelete() {
    setDeleting(true);
    try {
      await adminService.deleteOperator(account.id);
      toast.success(t('admin.operators_deleted'));
      onDeleted(account.id);
    } catch (err) {
      const msg = err.response?.data?.error;
      if (msg) toast.error(msg);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  /**
   * Formats a UTC date string into a localised, human-readable date.
   * Locale is derived from the active i18n language to match the rest of the UI.
   * Falls back to an em-dash for null/undefined values.
   */
  const fmt = (dateStr) => dateStr
    ? new Date(dateStr).toLocaleDateString(
        i18n.language === 'en' ? 'en-CA' : 'fr-CA',
        { year: 'numeric', month: 'long', day: 'numeric' }
      )
    : '—';

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      {/* Slide-in panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-gray-800 shadow-xl z-50 overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-50">
                {account.first_name} {account.last_name}
              </h2>
              {/* Lock icon signals to the viewer that this account cannot be modified */}
              {isProtected && <span title={t('admin.operators_protected')}>🔒</span>}
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{account.email}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl p-1">✕</button>
        </div>

        <div className="p-5 space-y-6">
          {/* Warning banner for protected system accounts */}
          {isProtected && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              🔒 {t('admin.operators_protected')}
            </div>
          )}

          {/* Status row: badges on the left, enable/disable button on the right */}
          <div className="flex flex-wrap gap-2 items-center justify-between">
            <div className="flex flex-wrap gap-2 items-center">
              <StatusBadge status={account.status} />
              <RoleBadge role={account.role} />
            </div>
            {isMe ? (
              // Self-modification guard: show a muted hint instead of the action button
              <span className="text-xs text-gray-300">{t('admin.cannot_self_modify')}</span>
            ) : isProtected ? null : (
              // Button label and colour flip based on current status
              <button
                onClick={handleToggleStatus}
                disabled={toggling}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50
                  ${account.status === 'active'
                    ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 hover:bg-red-100'
                    : 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border-teal-200 hover:bg-teal-100'}`}
              >
                {toggling ? '…' : account.status === 'active' ? t('admin.disable_user') : t('admin.enable_user')}
              </button>
            )}
          </div>

          {/* Personal info section */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              {t('profile.personal_info')}
            </p>
            <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-200">
              {account.phone && (
                <div className="flex gap-2">
                  <span className="text-gray-400 w-5">📞</span>
                  <PhoneDisplay phone={account.phone} />
                </div>
              )}
              <div className="flex gap-2">
                <span className="text-gray-400 w-5">📅</span>
                <span>{t('admin.drivers_member_since')} : {fmt(account.created_at)}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-400 w-5">🔑</span>
                <span>{t('admin.drivers_last_login')} : {account.last_login_at ? fmt(account.last_login_at) : t('admin.drivers_never_logged_in')}</span>
              </div>
            </div>
          </div>

          {/* Destructive actions — hidden entirely for protected accounts */}
          {!isProtected && (
            <div className="space-y-3 border-t pt-4">
              <button
                onClick={() => onEdit(account)}
                className="w-full px-3 py-2 rounded-lg text-sm font-medium border bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 hover:bg-blue-100 transition-colors"
              >
                ✏️ {t('admin.operators_edit_btn')}
              </button>

              {/* Delete is also hidden for the currently logged-in user */}
              {!isMe && (
                confirmDelete ? (
                  // Inline confirmation — avoids a modal and keeps the flow in context
                  <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/30 p-3">
                    <p className="text-sm text-red-800 dark:text-red-200 mb-3">{t('admin.operators_delete_confirm')}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleDelete}
                        disabled={deleting}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {deleting ? '…' : t('common.confirm')}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  // First click only arms the confirmation; no destructive API call yet
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="w-full px-3 py-2 rounded-lg text-sm font-medium border bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 hover:bg-red-100 transition-colors"
                  >
                    🗑 {t('admin.operators_delete_btn')}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Tab content ─────────────────────────────────────────────────

/**
 * AccountTab
 *
 * Reusable tab body rendered once per role (operator / superadmin).
 * It owns all state for the accounts of one role:
 *   - The full list fetched on mount
 *   - Which account is selected (opens the detail panel)
 *   - Which account is being edited / created (opens the form panel)
 *   - Search text and the "disabled only" filter toggle
 *
 * The component is rendered with `key={activeTab}` in the parent so that
 * switching tabs fully resets state and triggers a fresh fetch.
 *
 * @param {string} role        - 'operator' or 'superadmin' — determines which accounts to load.
 * @param {object} currentUser - The logged-in superadmin (used to prevent self-modification).
 */
function AccountTab({ role, currentUser }) {
  const { t } = useTranslation();

  const [users, setUsers]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState(null);
  // editTarget: null = form closed, false = create mode, object = edit mode
  const [editTarget, setEditTarget] = useState(null);
  const [search, setSearch]         = useState('');
  const [disabledOnly, setDisabledOnly] = useState(false);

  /**
   * Fetch all accounts for this role on mount.
   * Sorted alphabetically by last name + first name so the list is predictable
   * regardless of insertion order from the database.
   */
  useEffect(() => {
    setLoading(true);
    adminService.users({ role })
      .then(({ data }) => {
        setUsers([...data.users].sort((a, b) =>
          `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`)
        ));
      })
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [role]);

  /**
   * Client-side filtering applied to the full list.
   * Search matches against both "First Last" and "Last First" orderings so that
   * typing part of either name finds the record.
   */
  const filtered = users.filter(u => {
    if (disabledOnly && u.status === 'active') return false;
    if (search.trim()) {
      const q    = search.toLowerCase();
      const full = `${u.first_name} ${u.last_name}`.toLowerCase();
      const rev  = `${u.last_name} ${u.first_name}`.toLowerCase();
      if (!full.includes(q) && !rev.includes(q)) return false;
    }
    return true;
  });

  /**
   * Updates a single user's status in the local list and, if that user is
   * currently shown in the detail panel, keeps the panel in sync as well.
   * This avoids a full refetch just to reflect an enable/disable toggle.
   */
  function handleStatusChanged(userId, newStatus) {
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, status: newStatus } : u));
    setSelected(prev => prev?.id === userId ? { ...prev, status: newStatus } : prev);
  }

  /**
   * Handles both the create and update outcomes from AccountFormPanel.
   * - 'created': inserts the new user and re-sorts the list.
   * - 'updated': replaces the stale record in the list; also updates the detail
   *   panel if that account is currently open.
   */
  function handleSaved(savedUser, mode) {
    if (mode === 'created') {
      setUsers(prev =>
        [...prev, savedUser].sort((a, b) =>
          `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`)
        )
      );
    } else {
      setUsers(prev => prev.map(u => u.id === savedUser.id ? savedUser : u));
      // Keep the detail panel current if this account was open while being edited
      if (selected?.id === savedUser.id) setSelected(savedUser);
    }
    setEditTarget(null);
  }

  /**
   * Removes the deleted account from the list and dismisses the detail panel.
   */
  function handleDeleted(userId) {
    setUsers(prev => prev.filter(u => u.id !== userId));
    setSelected(null);
  }

  /**
   * Closes the detail panel and immediately opens the edit form for the same
   * account. Closing the detail first avoids two slide-in panels stacking.
   */
  function openEdit(account) {
    setSelected(null);
    setEditTarget(account);
  }

  if (loading) return <LoadingPage />;

  // Icon used in the empty state differs per role for visual clarity
  const emptyIcon = role === 'operator' ? '🎧' : role === 'ticket_master' ? '🎫' : '🛡️';

  return (
    <div>
      {/* Toolbar: search, disabled filter, total count, create button */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          className="input w-full max-w-sm"
          placeholder={t('admin.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoComplete="off"
        />
        {/* Toggle filter: when active, shows only suspended/disabled accounts */}
        <button
          onClick={() => setDisabledOnly(v => !v)}
          className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors whitespace-nowrap
            ${disabledOnly
              ? 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-300'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
        >
          🚫 {t('admin.drivers_filter_disabled')}
        </button>
        {/* Total count — role label is derived from the current tab so it reads
            "3 Operators", "1 Ticket Master", "2 Super Admin" rather than always "operators" */}
        <span className="text-sm text-gray-400 ml-auto">{users.length} {t(`roles.${role}`)}</span>
        {/* editTarget=false signals create mode to AccountFormPanel */}
        <button onClick={() => setEditTarget(false)} className="btn-primary text-sm">
          + {t('admin.operators_new_btn')}
        </button>
      </div>

      {users.length === 0 ? (
        <EmptyState icon={emptyIcon} message={t('admin.operators_no_results')} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 dark:bg-gray-700/50 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <th className="text-left px-4 py-3">{t('auth.first_name')} {t('auth.last_name')}</th>
                <th className="text-left px-4 py-3">{t('common.role')}</th>
                <th className="text-left px-4 py-3">{t('admin.drivers_account_status')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-gray-400 text-sm">
                    {t('admin.operators_no_results')}
                  </td>
                </tr>
              ) : filtered.map((u, index) => (
                <tr
                  key={u.id}
                  onClick={() => setSelected(u)}
                  className={`border-b last:border-0 cursor-pointer transition-colors hover:bg-teal-50
                    ${index % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50'}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-50 flex items-center gap-1.5">
                      {u.first_name} {u.last_name}
                      {/* Inline lock icon — no tooltip needed, the title attribute handles it */}
                      {u.is_protected && <span className="text-xs" title={t('admin.operators_protected')}>🔒</span>}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{u.email}</div>
                  </td>
                  <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                  <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel — rendered as an overlay when a row is clicked */}
      {selected && (
        <AccountDetailPanel
          account={selected}
          currentUser={currentUser}
          onClose={() => setSelected(null)}
          onStatusChanged={handleStatusChanged}
          onEdit={openEdit}
          onDeleted={handleDeleted}
        />
      )}

      {/* Form panel — rendered for both create (editTarget===false) and edit (editTarget is an object) */}
      {editTarget !== null && (
        <AccountFormPanel
          editing={editTarget || null}
          defaultRole={role}
          onClose={() => setEditTarget(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────

/**
 * AdminUserManagement (default export)
 *
 * Page shell that renders the two-tab header (Operators | Superadmins) and
 * delegates all list/form rendering to <AccountTab>.
 *
 * The `key={activeTab}` prop on AccountTab ensures that when the user switches
 * tabs, all state (selected row, search text, filter) is reset cleanly and a
 * new API call is made for the appropriate role.
 */
export default function AdminUserManagement() {
  const { t }    = useTranslation();
  const { user } = useAuth();
  // Track which tab is currently active; default to 'operator'
  const [activeTab, setActiveTab] = useState('operator');

  const tabs = [
    { key: 'operator',      label: t('roles.operator'),      icon: '🎧' },
    { key: 'ticket_master', label: t('roles.ticket_master'), icon: '🎫' },
    { key: 'superadmin',    label: t('roles.superadmin'),    icon: '🛡️' },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1>{t('admin.user_mgmt_title')}</h1>
      </div>

      {/* Tab bar — active tab has a teal underline indicator */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 dark:border-gray-700">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px
              ${activeTab === tab.key
                ? 'border-teal-600 text-teal-700 dark:text-teal-300'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700'}`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/*
        key={activeTab} is critical: it forces React to unmount and remount
        AccountTab whenever the tab changes, resetting all local state and
        firing the useEffect fetch for the new role.
      */}
      <AccountTab key={activeTab} role={activeTab} currentUser={user} />
    </div>
  );
}
