/**
 * @file OperatorManagement.jsx
 * @route /admin/operators
 * @access Operator, Superadmin
 *
 * Read-only list of operator (and superadmin, for superadmins) accounts.
 *
 * Operators are the staff members who book trips on behalf of clients via the
 * PhoneIntake workflow. This page allows them to see their colleagues and, if
 * they have sufficient privileges, enable or disable accounts.
 *
 * Important distinctions from AdminUserManagement.jsx:
 *   - This page is READ-ONLY for list purposes: no create, edit, or delete.
 *   - Full CRUD for operator/superadmin accounts lives in AdminUserManagement.jsx,
 *     which is only accessible to superadmins.
 *   - This page is reachable by ordinary operators, giving them a directory of
 *     staff without exposing the ability to create or destroy accounts.
 *
 * The enable/disable toggle is the only action available here, and it is
 * hidden for protected accounts and for the currently logged-in user.
 *
 * Sub-components (all defined in this file):
 *   - OperatorDetailPanel — slide-in panel with operator profile and status toggle
 *   - OperatorManagement  (default export) — page with table and filter toolbar
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { adminService } from '../../services/api';
import { LoadingPage, EmptyState, StatusBadge, RoleBadge, PhoneDisplay } from '../../components/common';

// ── Detail panel ────────────────────────────────────────────────

/**
 * OperatorDetailPanel
 *
 * Slide-in right-hand panel for an operator (or superadmin) account.
 *
 * Shows:
 *   - Account status badge + role badge
 *   - Enable/Disable toggle (hidden for the current user and for protected accounts)
 *   - Personal info: phone, member since, last login
 *
 * The lock icon (is_protected) and self-modification guard (isMe) mirror the
 * same safeguards used in AdminUserManagement.jsx.
 *
 * @param {object}   operator      - The operator account to display (from the list, not refetched).
 * @param {number}   currentUserId - ID of the logged-in user (prevents self-modification).
 * @param {boolean}  isSuperAdmin  - Whether the logged-in user is a superadmin (reserved for future use).
 * @param {Function} onClose         - Closes this panel.
 * @param {Function} onStatusChanged - Called with (userId, newStatus) after enable/disable.
 */
function OperatorDetailPanel({ operator, currentUserId, isSuperAdmin: _isSuperAdmin, onClose, onStatusChanged }) {
  const { t, i18n } = useTranslation();
  const [toggling, setToggling] = useState(false);

  // Prevent an operator from accidentally disabling their own account
  const isMe = operator.id === currentUserId;

  /**
   * Toggles the operator account between active and suspended.
   * Optimistically updates the parent list via onStatusChanged rather than
   * waiting for a refetch.
   */
  function handleToggleStatus() {
    const newStatus = operator.status === 'active' ? 'suspended' : 'active';
    setToggling(true);
    adminService.updateStatus(operator.id, { status: newStatus })
      .then(() => onStatusChanged(operator.id, newStatus))
      .catch(() => {})
      .finally(() => setToggling(false));
  }

  /**
   * Formats a UTC date string into a localised human-readable date.
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
      {/* Backdrop — clicking outside closes the panel */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Slide-in panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-gray-800 shadow-xl z-50 overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-50">
                {operator.first_name} {operator.last_name}
              </h2>
              {/* Lock icon: this account is protected from modification */}
              {operator.is_protected && <span title={t('admin.operators_protected')}>🔒</span>}
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{operator.email}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl p-1"
            aria-label={t('admin.drivers_close')}>✕</button>
        </div>

        <div className="p-5 space-y-6">
          {/* Status row: badges + enable/disable toggle */}
          <div className="flex flex-wrap gap-2 items-center justify-between">
            <div className="flex flex-wrap gap-2 items-center">
              <StatusBadge status={operator.status} />
              <RoleBadge role={operator.role} />
            </div>
            {isMe ? (
              // Self-modification guard: show a muted label instead of the action button
              <span className="text-xs text-gray-300">{t('admin.cannot_self_modify')}</span>
            ) : operator.is_protected ? null : (
              // Button colour flips: red when account is active (suspend), teal when suspended (re-enable)
              <button
                onClick={handleToggleStatus}
                disabled={toggling}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50
                  ${operator.status === 'active'
                    ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 hover:bg-red-100'
                    : 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border-teal-200 hover:bg-teal-100'}`}
              >
                {toggling ? '…' : operator.status === 'active' ? t('admin.disable_user') : t('admin.enable_user')}
              </button>
            )}
          </div>

          {/* Personal information section */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              {t('profile.personal_info')}
            </p>
            <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-200">
              {operator.phone && (
                <div className="flex gap-2">
                  <span className="text-gray-400 w-5">📞</span>
                  <PhoneDisplay phone={operator.phone} />
                </div>
              )}
              <div className="flex gap-2">
                <span className="text-gray-400 w-5">📅</span>
                <span>{t('admin.drivers_member_since')} : {fmt(operator.created_at)}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-400 w-5">🔑</span>
                <span>{t('admin.drivers_last_login')} : {operator.last_login_at ? fmt(operator.last_login_at) : t('admin.drivers_never_logged_in')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main page ────────────────────────────────────────────────────

/**
 * OperatorManagement (default export)
 *
 * Operator account list page.
 *
 * Loads all operator-role accounts on mount. Superadmins also see superadmin
 * accounts via the same endpoint (the API returns both roles when called by
 * a superadmin). The isSuperAdmin flag is passed to the detail panel for any
 * future role-conditional behaviour.
 *
 * Key state:
 *   users        — full list, sorted alphabetically by last name
 *   selected     — the full operator object shown in the detail panel (null = closed)
 *   search       — live-filter applied against name fields
 *   disabledOnly — when true, shows only suspended accounts
 *
 * The "Actions" column in the table shows one of three things per row:
 *   - "View" label  — standard row (clicking opens the detail panel)
 *   - Lock icon     — protected account (no actions possible)
 *   - "Can't modify self" label — the logged-in user's own row
 */
export default function OperatorManagement() {
  const { t }        = useTranslation();
  const { user }     = useAuth();
  // Used to conditionally pass superadmin context to the detail panel
  const isSuperAdmin = user?.role === 'superadmin';

  const [users, setUsers]               = useState([]);
  const [loading, setLoading]           = useState(true);
  // Unlike UserManagement, the full operator object is stored (not just an ID)
  // because operators are loaded from the list and not refetched on panel open
  const [selected, setSelected]         = useState(null);
  const [search, setSearch]             = useState('');
  const [disabledOnly, setDisabledOnly] = useState(false);

  /**
   * Fetch operator accounts on mount.
   * The API endpoint respects the caller's role: a superadmin sees all operators
   * and superadmins, an operator sees only operators.
   * Sorted alphabetically by last name + first name for a predictable list.
   */
  useEffect(() => {
    adminService.users({ role: 'operator' })
      .then(({ data }) => {
        setUsers([...data.users].sort((a, b) =>
          `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`)
        ));
      })
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Client-side filter applied on every render.
   * Matches against both "First Last" and "Last First" orderings.
   */
  const filtered = users.filter(u => {
    if (disabledOnly && u.status === 'active') return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const full = `${u.first_name} ${u.last_name}`.toLowerCase();
      const rev  = `${u.last_name} ${u.first_name}`.toLowerCase();
      if (!full.includes(q) && !rev.includes(q)) return false;
    }
    return true;
  });

  /**
   * Updates a single user's status in the local list and, if that user's detail
   * panel is open, keeps the panel badge in sync without a refetch.
   */
  function handleStatusChanged(userId, newStatus) {
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, status: newStatus } : u));
    setSelected(prev => prev?.id === userId ? { ...prev, status: newStatus } : prev);
  }

  if (loading) return <LoadingPage />;

  return (
    <div>
      {/* Header: page title + unfiltered total count */}
      <div className="flex items-center justify-between mb-4">
        <h1>{t('admin.operators_title')}</h1>
        <span className="text-sm text-gray-400">{users.length} {t('admin.operators_count_label')}</span>
      </div>

      {/* Search + disabled filter toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          className="input w-full max-w-sm"
          placeholder={t('admin.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoComplete="off"
        />
        {/* Toggle to isolate suspended operator accounts */}
        <button
          onClick={() => setDisabledOnly(v => !v)}
          className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors whitespace-nowrap
            ${disabledOnly
              ? 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-300'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
        >
          🚫 {t('admin.drivers_filter_disabled')}
        </button>
      </div>

      {users.length === 0 ? (
        <EmptyState icon="🎧" message={t('admin.operators_no_results')} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 dark:bg-gray-700/50 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <th className="text-left px-4 py-3">{t('auth.first_name')} {t('auth.last_name')}</th>
                <th className="text-left px-4 py-3">{t('common.role')}</th>
                <th className="text-left px-4 py-3">{t('admin.drivers_account_status')}</th>
                <th className="text-right px-4 py-3">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400 text-sm">
                    {t('admin.operators_no_results')}
                  </td>
                </tr>
              ) : filtered.map((u, index) => {
                // Determine per-row if this is the logged-in user (affects the Actions column label)
                const isMe = u.id === user?.id;
                return (
                  <tr
                    key={u.id}
                    onClick={() => setSelected(u)}
                    className={`border-b last:border-0 cursor-pointer transition-colors hover:bg-teal-50
                      ${index % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50'}`}
                  >
                    {/* Name + email subtitle; lock icon for protected system accounts */}
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-50 flex items-center gap-1.5">
                        {u.first_name} {u.last_name}
                        {u.is_protected && <span className="text-xs" title={t('admin.operators_protected')}>🔒</span>}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">{u.email}</div>
                    </td>
                    <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                    <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                    {/*
                      Actions column: shows a contextual label rather than actual buttons
                      since this is a read-only list. The detail panel handles the actual toggle.
                    */}
                    <td className="px-4 py-3 text-right">
                      {isMe ? (
                        // The logged-in user cannot modify their own account
                        <span className="text-xs text-gray-300">{t('admin.cannot_self_modify')}</span>
                      ) : u.is_protected ? (
                        // Protected accounts show only a lock — no action hint
                        <span className="text-xs">🔒</span>
                      ) : (
                        // Normal rows show "View" to hint that the row is clickable
                        <span className="text-xs text-gray-400">{t('admin.view')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel — rendered as an overlay when a row is clicked */}
      {selected && (
        <OperatorDetailPanel
          operator={selected}
          currentUserId={user?.id}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setSelected(null)}
          onStatusChanged={handleStatusChanged}
        />
      )}
    </div>
  );
}
