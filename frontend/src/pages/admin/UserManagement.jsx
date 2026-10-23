/**
 * @file UserManagement.jsx
 * @route /admin/users
 * @access Operator, Superadmin
 *
 * Admin view of all client accounts in the system.
 *
 * Clients are the passengers that drivers transport to medical or other
 * appointments. This page lets operators review client profiles, check
 * when they last logged in, and suspend accounts when necessary.
 *
 * The list is filtered client-side by name and by a "disabled only" toggle.
 * Clicking any row fetches the full user record from the detail endpoint and
 * opens a slide-in panel — the detail panel intentionally loads on demand so
 * the initial page renders quickly even for large client lists.
 *
 * Actions available from the detail panel:
 *   - Enable / Disable (toggle account status)
 *
 * CRUD operations (create/delete) are not available here; clients self-register.
 * Full account CRUD for staff roles lives in AdminUserManagement.jsx.
 *
 * Sub-components (all defined in this file):
 *   - UserDetailPanel    — slide-in panel with full client profile and actions
 *   - UserManagement     (default export) — page with table and filter toolbar
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { adminService } from '../../services/api';
import { LoadingPage, EmptyState, StatusBadge, RoleBadge, PhoneDisplay } from '../../components/common';

// ── Detail panel ───────────────────────────────────────────────

/**
 * UserDetailPanel
 *
 * Slide-in right-hand panel showing the full profile of a client account.
 *
 * The detail record is fetched from the API when the panel opens (not before)
 * so that the lightweight list row doesn't need to carry fields like address,
 * emergency contact, and mobility notes that are only needed on demand.
 *
 * Sections displayed:
 *   - Account status badge + role badge + enable/disable toggle
 *   - Personal info: phone, member since, last login
 *   - Client profile: home address, emergency contact, mobility/accessibility notes
 *
 * The enable/disable button is hidden for the currently logged-in user to
 * prevent accidental self-lockout.
 *
 * When status changes, `onStatusChanged` is called so the parent list row
 * badge updates immediately without a full refetch.
 *
 * @param {number}   userId          - ID of the client to load.
 * @param {Function} onClose         - Closes this panel.
 * @param {Function} onStatusChanged - Called with (userId, newStatus) after toggle.
 */
function UserDetailPanel({ userId, onClose, onStatusChanged }) {
  const { t, i18n } = useTranslation();
  const { user: currentUser } = useAuth();
  // Full user record fetched on mount; null until the API call resolves
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  /**
   * Fetch the full client record when the panel opens.
   * The list view only carries lightweight fields; address, emergency contact,
   * and mobility notes are only available from the detail endpoint.
   */
  useEffect(() => {
    adminService.userDetail(userId)
      .then(({ data }) => setUser(data.user))
      .catch(() => toast.error(t('common.error')))
      .finally(() => setLoading(false));
  }, [userId, t]);

  /**
   * Toggles the client account between active and suspended.
   * Updates local state immediately (optimistic) and propagates the change
   * to the parent list via `onStatusChanged` so the list badge stays in sync.
   */
  function handleToggleStatus() {
    const newStatus = user.status === 'active' ? 'suspended' : 'active';
    setToggling(true);
    adminService.updateStatus(user.id, { status: newStatus })
      .then(() => {
        // Update the panel's own copy of the user record so the badge flips immediately
        setUser(prev => ({ ...prev, status: newStatus }));
        // Propagate the change up so the list row badge also flips without a refetch
        onStatusChanged(user.id, newStatus);
      })
      .catch(() => {})
      .finally(() => setToggling(false));
  }

  // Prevent an operator from accidentally disabling their own account
  const isMe = user?.id === currentUser?.id;

  // Format dates using the active locale (en-CA or fr-CA) for consistency with the rest of the UI
  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(
        i18n.language === 'en' ? 'en-CA' : 'fr-CA',
        { year: 'numeric', month: 'long', day: 'numeric' }
      )
    : '—';

  const lastLogin = user?.last_login_at
    ? new Date(user.last_login_at).toLocaleDateString(
        i18n.language === 'en' ? 'en-CA' : 'fr-CA',
        { year: 'numeric', month: 'long', day: 'numeric' }
      )
    : t('admin.drivers_never_logged_in');

  return (
    <>
      {/* Backdrop — clicking outside closes the panel */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Slide-in panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-gray-800 shadow-xl z-50 overflow-y-auto">
        {/* Header — shows "…" while loading so the panel size is stable */}
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-50">
              {loading ? '…' : `${user?.first_name} ${user?.last_name}`}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{user?.email}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1"
            aria-label={t('admin.drivers_close')}
          >
            ✕
          </button>
        </div>

        {loading ? (
          // Inline loading text while the detail request is in flight
          <div className="p-5 text-gray-400 text-sm">{t('common.loading')}</div>
        ) : user ? (
          <div className="p-5 space-y-6">

            {/* Status row: badges on the left, enable/disable toggle on the right */}
            <div className="flex flex-wrap gap-2 items-center justify-between">
              <div className="flex flex-wrap gap-2 items-center">
                <StatusBadge status={user.status} />
                <RoleBadge role={user.role} />
              </div>
              {isMe ? (
                // Self-modification guard: show a muted hint instead of the action button
                <span className="text-xs text-gray-300">{t('admin.cannot_self_modify')}</span>
              ) : (
                // Button label and colour flip based on current account status
                <button
                  onClick={handleToggleStatus}
                  disabled={toggling}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50
                    ${user.status === 'active'
                      ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 hover:bg-red-100'
                      : 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border-teal-200 hover:bg-teal-100'}`}
                >
                  {toggling ? '…' : user.status === 'active' ? t('admin.disable_user') : t('admin.enable_user')}
                </button>
              )}
            </div>

            {/* Personal info: contact details and account timeline */}
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                {t('profile.personal_info')}
              </p>
              <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-200">
                {user.member_number && (
                  <div className="flex gap-2">
                    <span className="text-gray-400 w-5">🪪</span>
                    <span className="font-mono font-semibold text-teal-700 dark:text-teal-300">
                      {user.role === 'driver' ? 'D' : user.role === 'client' ? 'C' : 'A'}-{String(user.member_number).padStart(4, '0')}
                    </span>
                  </div>
                )}
                {user.phone && (
                  <div className="flex gap-2">
                    <span className="text-gray-400 w-5">📞</span>
                    <PhoneDisplay phone={user.phone} />
                  </div>
                )}
                <div className="flex gap-2">
                  <span className="text-gray-400 w-5">📅</span>
                  <span>{t('admin.drivers_member_since')} : {memberSince}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-gray-400 w-5">🔑</span>
                  <span>{t('admin.drivers_last_login')} : {lastLogin}</span>
                </div>
              </div>
            </div>

            {/*
              Client-specific profile fields — only rendered when at least one is present.
              These fields are important for drivers to know before picking up a client:
                - address: the client's home address (default pickup location)
                - emergency_contact_name/phone: who to call if something goes wrong during transport
                - mobility_notes: accessibility requirements (e.g. wheelchair, walking aid)
            */}
            {(user.address || user.emergency_contact_name || user.mobility_notes) && (
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  {t('profile.client_profile')}
                </p>
                <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-200">
                  {user.address && (
                    <div className="flex gap-2">
                      <span className="text-gray-400 w-5">🏠</span>
                      <span>{user.address}</span>
                    </div>
                  )}
                  {user.emergency_contact_name && (
                    <div className="flex gap-2">
                      <span className="text-gray-400 w-5">🚨</span>
                      <span>
                        {user.emergency_contact_name}
                        {/* Show the contact's phone inline with an em-dash separator */}
                        {user.emergency_contact_phone && <> — <PhoneDisplay phone={user.emergency_contact_phone} /></>}
                      </span>
                    </div>
                  )}
                  {user.mobility_notes && (
                    <div className="flex gap-2">
                      <span className="text-gray-400 w-5">♿</span>
                      <span>{user.mobility_notes}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        ) : null}
      </div>
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────

/**
 * UserManagement (default export)
 *
 * Client account list page.
 *
 * Key state:
 *   users        — full list of clients, sorted alphabetically by last name
 *   selectedId   — ID of the client whose detail panel is open (null = closed)
 *   search       — live-filter text applied against first+last name combinations
 *   disabledOnly — when true, shows only suspended/disabled accounts
 *
 * The list is sorted on load and never re-sorted; new status changes don't
 * reorder rows so the operator doesn't lose their place while working.
 */
export default function UserManagement() {
  const { t }       = useTranslation();
  const { user: _user } = useAuth();

  const [users, setUsers]               = useState([]);
  const [loading, setLoading]           = useState(true);
  // Store only the selected user's ID; the full record is fetched by the detail panel
  const [selectedId, setSelectedId]     = useState(null);
  const [search, setSearch]             = useState('');
  const [disabledOnly, setDisabledOnly] = useState(false);

  /**
   * Fetch all client accounts on mount.
   * Sorted alphabetically by last_name + first_name so the list is consistent
   * regardless of registration order.
   */
  useEffect(() => {
    adminService.users({ role: 'client' })
      .then(({ data }) => {
        const sorted = [...data.users].sort((a, b) =>
          `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`)
        );
        setUsers(sorted);
      })
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Client-side filter applied on every render.
   * Matches against both "First Last" and "Last First" orderings so that
   * typing part of either name finds the record.
   */
  const filtered = users.filter(u => {
    if (disabledOnly && u.status === 'active') return false;
    if (search.trim() !== '') {
      const full = `${u.first_name} ${u.last_name}`.toLowerCase();
      const rev  = `${u.last_name} ${u.first_name}`.toLowerCase();
      const q    = search.toLowerCase();
      if (!full.includes(q) && !rev.includes(q)) return false;
    }
    return true;
  });

  /**
   * Reflects a status change (triggered from inside the detail panel) back into
   * the list without a refetch, so the badge updates immediately.
   */
  function handleStatusChanged(userId, newStatus) {
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, status: newStatus } : u));
  }

  if (loading) return <LoadingPage />;

  return (
    <div>
      {/* Header: page title + unfiltered total count */}
      <div className="flex items-center justify-between mb-4">
        <h1>{t('admin.users_title')}</h1>
        <span className="text-sm text-gray-400">{users.length} {t('admin.users_count_label')}</span>
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
        {/* Toggle to quickly isolate suspended accounts for review or re-enabling */}
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
        <EmptyState icon="🧑" message={t('admin.users_no_results')} />
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
                // Shown when search/filter combination matches no records
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-gray-400 text-sm">
                    {t('admin.users_no_results')}
                  </td>
                </tr>
              ) : filtered.map((u, index) => (
                <tr
                  key={u.id}
                  // Store only the ID; detail panel fetches the full record on open
                  onClick={() => setSelectedId(u.id)}
                  className={`border-b last:border-0 cursor-pointer transition-colors hover:bg-teal-50
                    ${index % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50'}`}
                >
                  {/* Name + email subtitle */}
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-50">
                      {u.first_name} {u.last_name}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{u.email}</div>
                  </td>

                  {/* Role badge — all users on this page should be 'client' */}
                  <td className="px-4 py-3">
                    <RoleBadge role={u.role} />
                  </td>

                  {/* Account status: active (can log in) or suspended (blocked) */}
                  <td className="px-4 py-3">
                    <StatusBadge status={u.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel — rendered as an overlay when a row is clicked */}
      {selectedId && (
        <UserDetailPanel
          userId={selectedId}
          onClose={() => setSelectedId(null)}
          onStatusChanged={handleStatusChanged}
        />
      )}
    </div>
  );
}
