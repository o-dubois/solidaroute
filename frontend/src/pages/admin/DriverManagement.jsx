/**
 * @file DriverManagement.jsx
 * @route /admin/drivers
 * @access Operator, Superadmin
 *
 * Lists every driver in the system (regardless of approval or account status)
 * alongside their upcoming and completed trip counts. Clicking any row fetches
 * the full driver profile and opens a slide-in detail panel where the admin
 * can approve, reject, suspend, or enable/disable the driver.
 *
 * Driver approval workflow:
 *   register → email verify → pending (shows here) → admin approves → driver can receive trips
 *
 * The list supports two quick-filter toggles that can also be activated via
 * URL query params (e.g. from a dashboard "pending drivers" link):
 *   ?filter=pending  → pre-activates the "Pending Only" filter
 *   ?filter=disabled → pre-activates the "Disabled Only" filter
 *
 * Sub-components (all defined in this file):
 *   - ApprovalBadge     — coloured pill showing pending/approved/rejected/suspended
 *   - DriverDetailPanel — slide-in panel with profile, stats, and action buttons
 *   - DriverManagement  (default export) — page with table and filter toolbar
 */
import { formatNumber } from '../../utils/format';
import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { adminService } from '../../services/api';
import { LoadingPage, EmptyState, StatusBadge, PhoneDisplay } from '../../components/common';

// ── Approval status badge ──────────────────────────────────────

/**
 * ApprovalBadge
 *
 * Displays the driver's approval_status as a coloured pill.
 * This is distinct from the account status (active/suspended) — a driver
 * can have an active account but still be pending approval, meaning they
 * cannot yet be assigned trips.
 *
 * Statuses:
 *   incomplete — driver has not yet filled all mandatory profile fields
 *   approved   — cleared to receive trip assignments
 *   pending    — profile complete, waiting for admin review
 *   rejected   — application was declined
 *   suspended  — was approved but approval has since been revoked
 *
 * @param {string} status - One of: 'incomplete' | 'approved' | 'pending' | 'rejected' | 'suspended'
 */
function ApprovalBadge({ status }) {
  const { t } = useTranslation();
  // Colour map mirrors the semantic meaning: blue=incomplete, green=good, amber=waiting, red=bad, orange=warning
  const styles = {
    incomplete: 'bg-blue-100 dark:bg-blue-900/40  text-blue-700 dark:text-blue-300',
    approved:   'bg-teal-100 dark:bg-teal-900/40  text-teal-700 dark:text-teal-300',
    pending:    'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
    rejected:   'bg-red-100 dark:bg-red-900/40   text-red-700 dark:text-red-300',
    suspended:  'bg-orange-100 text-orange-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
      {t(`status.${status}`, { defaultValue: status })}
    </span>
  );
}

// ── Detail panel ───────────────────────────────────────────────

/**
 * DriverDetailPanel
 *
 * Full profile slide-in panel for a selected driver. Contains:
 *   - Account status + approval status + on/off-duty indicator
 *   - Enable/Disable toggle (account-level, always available)
 *   - Approve / Reject / Suspend approval buttons (approval-level, context-sensitive)
 *   - Trip statistics (upcoming, completed, cancelled, average rating)
 *   - Personal info (phone, member since, last login)
 *   - Vehicle details (make, model, colour, year, plate, seat count)
 *   - Home address
 *   - Link to the dedicated Documents page for this driver
 *
 * The approval action area adapts to the current approval_status:
 *   - Not yet approved: shows Approve (with confirmation step) and Reject buttons
 *   - Already approved: shows Suspend button instead
 *
 * The confirmation step for approval asks the admin to confirm they have
 * verified the driver's documents before approving, enforcing a manual check.
 * On successful approval the backend sends a notification email to the driver.
 *
 * @param {object}   driver             - Full driver record (from driverDetail API call).
 * @param {Function} onClose            - Closes this panel.
 * @param {Function} onStatusChanged    - Called with (driverId, newStatus) after enable/disable.
 * @param {Function} onApprovalChanged  - Called with (driverId, newApproval) after approval action.
 */
function DriverDetailPanel({ driver, onClose, onStatusChanged, onApprovalChanged }) {
  const { t, i18n } = useTranslation();
  const navigate    = useNavigate();
  const [toggling,          setToggling]          = useState(false);
  const [approving,         setApproving]         = useState(false);
  // 'approve' = standard doc-check confirmation step
  // 'override' = override confirmation (warns admin they accept full responsibility)
  // null = no confirmation in progress
  const [confirmMode, setConfirmMode] = useState(null);

  /**
   * Toggles the driver's account between active and suspended.
   * This is independent of approval status — suspending the account prevents
   * login entirely, whereas suspending approval prevents trip assignment.
   */
  function handleToggleStatus() {
    const newStatus = driver.status === 'active' ? 'suspended' : 'active';
    setToggling(true);
    adminService.updateStatus(driver.id, { status: newStatus })
      .then(() => onStatusChanged(driver.id, newStatus))
      .catch(() => {})
      .finally(() => setToggling(false));
  }

  /**
   * Executes the standard approval after the admin has confirmed the document check.
   * A success toast informs the admin that a notification email was sent to the driver.
   */
  function doApprove() {
    setConfirmMode(null);
    setApproving(true);
    adminService.approveDriver(driver.id, { status: 'approved' })
      .then(() => {
        // Pass clearOverride=true so the override icon is removed from the local list.
        onApprovalChanged(driver.id, 'approved', false, true);
        toast.success(t('admin.approve_email_sent'));
      })
      .catch(() => toast.error(t('common.error')))
      .finally(() => setApproving(false));
  }

  /**
   * Executes the override approval — bypasses the document requirement but still
   * checks that minimum personal and vehicle fields are filled.
   * The backend records the override (actor, timestamp) in the audit trail.
   * A distinct toast message reminds the admin the override has been logged.
   */
  function doOverrideApprove() {
    setConfirmMode(null);
    setApproving(true);
    adminService.approveDriverOverride(driver.id)
      .then(() => {
        onApprovalChanged(driver.id, 'approved', true /* overridden */);
        toast.success(t('admin.override_approved'));
      })
      .catch(err => {
        const missing = err.response?.data?.missing;
        if (missing?.length) {
          toast.error(`${t('admin.override_missing_fields')}: ${missing.join(', ')}`);
        } else {
          toast.error(t('common.error'));
        }
      })
      .finally(() => setApproving(false));
  }

  /**
   * Handles reject and suspend approval actions (no confirmation needed for
   * these — they are lower-stakes than granting access).
   *
   * @param {string} newApproval - 'rejected' or 'suspended'
   */
  function handleApproval(newApproval) {
    setApproving(true);
    adminService.approveDriver(driver.id, { status: newApproval })
      .then(() => onApprovalChanged(driver.id, newApproval))
      .catch(() => toast.error(t('common.error')))
      .finally(() => setApproving(false));
  }

  // Format dates once for use throughout the panel
  const memberSince = driver.created_at
    ? new Date(driver.created_at).toLocaleDateString(i18n.language === 'en' ? 'en-CA' : 'fr-CA', { year: 'numeric', month: 'long', day: 'numeric' })
    : '—';

  const lastLogin = driver.last_login_at
    ? new Date(driver.last_login_at).toLocaleDateString(i18n.language === 'en' ? 'en-CA' : 'fr-CA', { year: 'numeric', month: 'long', day: 'numeric' })
    : t('admin.drivers_never_logged_in');

  /**
   * Build a single human-readable vehicle description line from the individual
   * fields stored on the driver profile. Fields are filtered so that missing
   * values don't produce trailing spaces or extra separators.
   */
  const vehicleLine = [
    driver.vehicle_color,
    driver.vehicle_make,
    driver.vehicle_model,
    driver.vehicle_year,
  ].filter(Boolean).join(' ');

  return (
    <>
      {/* Backdrop — clicking it closes the panel */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-gray-800 shadow-xl z-50 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-50">
              {driver.first_name} {driver.last_name}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{driver.email}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1"
            aria-label={t('admin.drivers_close')}
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-6">

          {/* Status row: account status, approval badge, on/off-duty, and enable/disable toggle */}
          <div className="flex flex-wrap gap-2 items-center justify-between">
            <div className="flex flex-wrap gap-2 items-center">
              <StatusBadge status={driver.status} />
              <ApprovalBadge status={driver.approval_status || 'pending'} />
              {/* is_available is set by the driver themselves via their app toggle */}
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${driver.is_available ? 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                {driver.is_available ? t('admin.drivers_on_duty') : t('admin.drivers_off_duty')}
              </span>
            </div>
            {/* Enable/Disable button affects login ability, not approval status */}
            <button
              onClick={handleToggleStatus}
              disabled={toggling}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50
                ${driver.status === 'active'
                  ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 hover:bg-red-100'
                  : 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border-teal-200 hover:bg-teal-100'}`}
            >
              {toggling ? '…' : driver.status === 'active' ? t('admin.disable_user') : t('admin.enable_user')}
            </button>
          </div>

          {/* Override badge — visible in the detail panel when this approval was an override */}
          {driver.approval_overridden && (
            <div className="bg-orange-50 dark:bg-orange-900/30 border border-orange-200 rounded-lg px-3 py-2 text-xs text-orange-700 flex items-center gap-1.5">
              <span>⚡</span>
              <span>{t('admin.override_badge')}</span>
            </div>
          )}

          {/* Approval actions — only shown when the driver is NOT yet approved */}
          {driver.approval_status !== 'approved' && (
            <div className="space-y-2">
              {/* Standard approval confirmation: doc-check reminder */}
              {confirmMode === 'approve' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/30 p-3">
                  <p className="text-sm text-amber-800 dark:text-amber-200 mb-3">
                    {t('admin.approve_doc_check_body')}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={doApprove}
                      disabled={approving}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 transition-colors"
                    >
                      {approving ? '…' : `✅ ${t('common.yes')}`}
                    </button>
                    <button
                      onClick={() => setConfirmMode(null)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    >
                      {t('common.no')}
                    </button>
                  </div>
                </div>
              )}

              {/* Override confirmation: strong warning that admin accepts responsibility */}
              {confirmMode === 'override' && (
                <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/30 p-3">
                  <p className="text-sm font-semibold text-red-800 dark:text-red-200 mb-1">
                    ⚡ {t('admin.override_approval_title')}
                  </p>
                  <p className="text-xs text-red-700 dark:text-red-300 mb-3 leading-relaxed">
                    {t('admin.override_approval_warning')}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={doOverrideApprove}
                      disabled={approving}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                    >
                      {approving ? '…' : `⚡ ${t('common.yes')}`}
                    </button>
                    <button
                      onClick={() => setConfirmMode(null)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    >
                      {t('common.no')}
                    </button>
                  </div>
                </div>
              )}

              {/* Default button row — shown when no confirmation is in progress */}
              {confirmMode === null && (
                <div>
                  <div className="flex flex-wrap gap-2">
                    {/* Approve button — disabled until all required fields AND documents are present.
                        driver.is_complete comes from the completeness check run server-side on detail load. */}
                    <button
                      onClick={() => setConfirmMode('approve')}
                      disabled={approving || !driver.is_complete}
                      title={!driver.is_complete ? t('admin.approve_incomplete_tooltip') : undefined}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border-teal-200 hover:bg-teal-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {`✅ ${driver.approval_status === 'suspended' ? t('admin.driver_reapprove_btn') : t('admin.approve')}`}
                    </button>
                    {/* Override button — always active; intended for emergencies / special cases */}
                    <button
                      onClick={() => setConfirmMode('override')}
                      disabled={approving}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-orange-50 dark:bg-orange-900/30 text-orange-700 border-orange-200 hover:bg-orange-100 disabled:opacity-50 transition-colors"
                    >
                      {`⚡ ${t('admin.override_approval_btn')}`}
                    </button>
                    {/* Reject button is disabled if already rejected */}
                    <button
                      onClick={() => handleApproval('rejected')}
                      disabled={approving || driver.approval_status === 'rejected'}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 hover:bg-red-100 disabled:opacity-50 transition-colors"
                    >
                      {`❌ ${t('admin.reject')}`}
                    </button>
                  </div>
                  {/* Explanatory note shown when profile is not yet complete */}
                  {!driver.is_complete && (
                    <div className="mt-2 space-y-1">
                      <p className="text-xs text-gray-400 leading-relaxed">
                        ⚠️ {t('admin.approve_incomplete_note')}
                      </p>
                      {driver.missing_fields?.length > 0 && (
                        <ul className="text-xs text-red-500 list-disc list-inside space-y-0.5">
                          {driver.missing_fields.map(f => (
                            <li key={f}>{t(`admin.missing_field.${f}`, { defaultValue: f })}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Approval action for already-approved drivers: only "Suspend approval" is available */}
          {driver.approval_status === 'approved' && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleApproval('suspended')}
                disabled={approving}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-orange-50 dark:bg-orange-900/30 text-orange-700 border-orange-200 hover:bg-orange-100 disabled:opacity-50 transition-colors"
              >
                {approving ? '…' : `⏸️ ${t('admin.driver_suspend_btn')}`}
              </button>
            </div>
          )}

          {/* Trip statistics: three-column grid for quick at-a-glance assessment */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              {t('admin.drivers_stats')}
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-blue-50 dark:bg-blue-900/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">{driver.upcoming_trips ?? 0}</div>
                <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">{t('admin.drivers_upcoming')}</div>
              </div>
              <div className="bg-teal-50 dark:bg-teal-900/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-teal-700 dark:text-teal-300">{driver.completed_trips ?? 0}</div>
                <div className="text-xs text-teal-600 dark:text-teal-400 mt-0.5">{t('admin.drivers_completed')}</div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-gray-600 dark:text-gray-300">{driver.cancelled_trips ?? 0}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t('status.cancelled')}</div>
              </div>
            </div>
            {/* Only show rating if the driver has at least one review */}
            {driver.review_count > 0 && (
              <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
                ⭐ {formatNumber(driver.average_rating, 1, i18n.language)} / 5
                <span className="text-gray-400 ml-1">({driver.review_count} {t('admin.drivers_reviews')})</span>
              </p>
            )}
          </div>

          {/* Personal information */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              {t('profile.personal_info')}
            </p>
            <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-200">
              {driver.phone && (
                <div className="flex gap-2">
                  <span className="text-gray-400 w-5">📞</span>
                  <PhoneDisplay phone={driver.phone} />
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

          {/* Vehicle details — only rendered if any vehicle info is present */}
          {(driver.vehicle_make || driver.license_plate) && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                {t('admin.drivers_vehicle')}
              </p>
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 space-y-1 text-sm text-gray-700 dark:text-gray-200">
                {vehicleLine && <p>{vehicleLine}</p>}
                {/* Plate number is displayed in monospace for readability */}
                {driver.license_plate && (
                  <p className="font-mono font-bold tracking-widest text-gray-900 dark:text-gray-50">
                    {driver.license_plate}
                  </p>
                )}
                {driver.seat_count && (
                  <p className="text-gray-500 dark:text-gray-400">
                    {driver.seat_count} {t('common.seats')}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Home address (used for proximity-based matching and routing) */}
          {driver.home_address && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                {t('admin.drivers_home_address')}
              </p>
              <p className="text-sm text-gray-700 dark:text-gray-200">{driver.home_address}</p>
            </div>
          )}

          {/* Documents button: navigates to the dedicated driver document review page */}
          <div>
            <button
              onClick={() => { onClose(); navigate(`/admin/drivers/${driver.id}/documents`); }}
              className="w-full px-4 py-2.5 rounded-lg text-sm font-medium border bg-gray-50 dark:bg-gray-700/50 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left flex items-center gap-2"
            >
              📄 {t('admin.driver_documents_btn')}
            </button>
          </div>

        </div>
      </div>

    </>
  );
}

// ── Main page ──────────────────────────────────────────────────

/**
 * DriverManagement (default export)
 *
 * Main driver list page. Fetches all drivers on mount and renders them in a
 * sortable-by-name table with two filter toggles:
 *   - Pending Only: hides approved drivers — used to review new applications
 *   - Disabled Only: shows only suspended accounts — useful for re-enabling
 *
 * Detail data (vehicle, stats, documents) is fetched on demand when a row is
 * clicked rather than being loaded upfront, keeping the initial page load fast.
 *
 * The `detailLoading` state disables all row clicks while a detail request is
 * in flight to prevent duplicate panel openings.
 */
export default function DriverManagement() {
  const { t } = useTranslation();
  // Read URL query params to pre-activate filters when arriving from the dashboard
  const [searchParams] = useSearchParams();

  const [drivers, setDrivers]             = useState([]);
  const [loading, setLoading]             = useState(true);
  // The fully-loaded driver object shown in the detail panel (null = panel closed)
  const [selected, setSelected]           = useState(null);
  // Prevents clicking a row while a detail fetch is already in progress
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch]               = useState('');
  // Pre-activate pending filter if the URL contains ?filter=pending
  const [pendingOnly, setPendingOnly]     = useState(searchParams.get('filter') === 'pending');
  // Pre-activate disabled filter if the URL contains ?filter=disabled
  const [disabledOnly, setDisabledOnly]   = useState(searchParams.get('filter') === 'disabled');

  /**
   * Fetch the lightweight driver list on mount.
   * This list includes approval_status, account status, and trip counts but
   * not the full profile (vehicle, documents, etc.) — those come on row click.
   */
  useEffect(() => {
    adminService.drivers()
      .then(({ data }) => setDrivers(data.drivers))
      .catch(() => setDrivers([]))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Client-side filter applied on every render.
   * Pending-only and disabled-only filters can be combined.
   * Search matches both "First Last" and "Last First" orderings.
   */
  const filtered = drivers.filter(d => {
    // pendingOnly shows all non-approved drivers (pending, rejected, suspended)
    if (pendingOnly && d.approval_status === 'approved') return false;
    if (disabledOnly && d.status === 'active') return false;
    if (search.trim() !== '') {
      const full = `${d.first_name} ${d.last_name}`.toLowerCase();
      const rev  = `${d.last_name} ${d.first_name}`.toLowerCase();
      const q    = search.toLowerCase();
      if (!full.includes(q) && !rev.includes(q)) return false;
    }
    return true;
  });

  /**
   * Fetches full driver details on row click and opens the detail panel.
   * Uses the detail endpoint rather than the list endpoint because the list
   * omits vehicle, address, documents, and rating data to keep responses small.
   */
  function handleRowClick(driverId) {
    setDetailLoading(true);
    adminService.driverDetail(driverId)
      .then(({ data }) => setSelected(data.driver))
      .catch(() => toast.error(t('common.error')))
      .finally(() => setDetailLoading(false));
  }

  /**
   * Updates account status in the local list and the open detail panel
   * without a full refetch.
   */
  function handleStatusChanged(driverId, newStatus) {
    setDrivers(prev => prev.map(d => d.id === driverId ? { ...d, status: newStatus } : d));
    setSelected(prev => prev ? { ...prev, status: newStatus } : prev);
  }

  /**
   * Updates approval status in both the local list and the open detail panel.
   * For override approvals the `overridden` flag is also set so the override icon
   * appears immediately without a full re-fetch.
   * The generic toast is suppressed for overrides — `doOverrideApprove` shows its own.
   */
  function handleApprovalChanged(driverId, newApproval, overridden = false, clearOverride = false) {
    const patch = {
      approval_status: newApproval,
      ...(overridden    && { approval_overridden: true }),
      ...(clearOverride && { approval_overridden: false }),
    };
    setDrivers(prev => prev.map(d => d.id === driverId ? { ...d, ...patch } : d));
    setSelected(prev => prev ? { ...prev, ...patch } : prev);
    if (!overridden) {
      toast.success(t(`admin.${newApproval === 'approved' ? 'approve' : newApproval === 'rejected' ? 'reject' : 'disable'}`));
    }
  }

  if (loading) return <LoadingPage />;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1>{t('admin.drivers_title')}</h1>
        <span className="text-sm text-gray-400">{drivers.length} {t('roles.driver').toLowerCase()}s</span>
      </div>

      {/* Search bar + filter toggles */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          className="input w-full max-w-sm"
          placeholder={t('admin.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoComplete="off"
        />
        {/* Pending filter: highlights the button when active */}
        <button
          onClick={() => setPendingOnly(v => !v)}
          className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors whitespace-nowrap
            ${pendingOnly
              ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-300'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
        >
          ⏳ {t('admin.drivers_filter_pending')}
        </button>
        {/* Disabled filter */}
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

      {drivers.length === 0 ? (
        <EmptyState icon="🚗" message={t('admin.drivers_no_results')} />
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 dark:bg-gray-700/50 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <th className="text-left px-4 py-3">{t('auth.first_name')} {t('auth.last_name')}</th>
                <th className="text-left px-4 py-3">{t('admin.drivers_approval_status')}</th>
                <th className="text-left px-4 py-3">{t('admin.drivers_account_status')}</th>
                <th className="text-center px-4 py-3">{t('admin.drivers_upcoming')}</th>
                <th className="text-center px-4 py-3">{t('admin.drivers_completed')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">
                    {t('admin.drivers_no_results')}
                  </td>
                </tr>
              ) : filtered.map((driver, index) => (

                <tr
                  key={driver.id}
                  onClick={() => handleRowClick(driver.id)}
                  className={`border-b last:border-0 cursor-pointer transition-colors hover:bg-teal-50
                    ${detailLoading ? 'pointer-events-none opacity-60' : ''}
                    ${index % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50'}`}
                >
                  {/* Name + email — override icon shown when approval was granted via override */}
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-50 flex items-center gap-1.5">
                      {driver.first_name} {driver.last_name}
                      {driver.approval_overridden && (
                        <span title={t('admin.override_badge')} className="text-orange-500 text-xs">⚡</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{driver.email}</div>
                  </td>

                  {/* Approval status — the key field for the pending review workflow */}
                  <td className="px-4 py-3">
                    <ApprovalBadge status={driver.approval_status || 'pending'} />
                  </td>

                  {/* Account (login) status */}
                  <td className="px-4 py-3">
                    <StatusBadge status={driver.status} />
                  </td>

                  {/* Upcoming trips — blue highlight when non-zero (driver has active commitments) */}
                  <td className="px-4 py-3 text-center">
                    <span className={`font-semibold ${driver.upcoming_trips > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>
                      {driver.upcoming_trips ?? 0}
                    </span>
                  </td>

                  {/* Completed trips — teal highlight when non-zero (driver has a track record) */}
                  <td className="px-4 py-3 text-center">
                    <span className={`font-semibold ${driver.completed_trips > 0 ? 'text-teal-600 dark:text-teal-400' : 'text-gray-400'}`}>
                      {driver.completed_trips ?? 0}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel — rendered as an overlay when a row is selected */}
      {selected && (
        <DriverDetailPanel
          driver={selected}
          onClose={() => setSelected(null)}
          onStatusChanged={handleStatusChanged}
          onApprovalChanged={handleApprovalChanged}
        />
      )}
    </div>
  );
}
