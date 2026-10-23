/**
 * Driver Dashboard — /driver
 *
 * The driver's home screen after login. Displays three info cards at the top
 * (approval status + on/off duty toggle, star rating, pending earnings) followed
 * by a grid of clickable trip-count tiles that link to the MyTrips page filtered
 * by status.
 *
 * Three info cards: status tile (approval + on/off duty switch), rating, earnings.
 * Clickable trip stat tiles linking to /driver/my-trips?status=xxx.
 *
 * Status tile behaviour:
 *   - Reads app_name from GET /api/admin/configuration/public on mount
 *   - Shows "Approuvé par [app_name]" as approval line
 *   - Toggle switch calls PATCH /api/drivers/availability
 *   - When is_available = false the driver is excluded from nearby suggestions
 *     and cannot be manually selected in NewTrip
 *
 * Email action toasts:
 *   When a driver clicks Accept/Decline in an email notification, they land here
 *   with ?action=accepted|declined|expired|too_late in the URL. The component
 *   reads that param, shows the appropriate toast, then cleans the URL.
 */
import { formatAmount, formatNumber, currencySymbol } from '../../utils/format';
import { useAppConfig } from '../../context/AppConfigContext';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import api, { tripService, driverService } from '../../services/api';
import { LoadingPage } from '../../components/common';
import toast from 'react-hot-toast';
import ProfileCompletenessModal from '../../components/driver/ProfileCompletenessModal';

// sessionStorage key used to track whether the completeness modal has already
// been shown this login session.  Cleared automatically when the browser tab
// is closed (sessionStorage lifetime = one tab session).
const SESSION_KEY = 'sr_completeness_shown';

export default function DriverDashboard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { currency } = useAppConfig();

  // stats: { profile, earnings, pending, upcoming, completed, cancelled, all_trips, available_trips }
  const [stats, setStats]       = useState(null);
  const [loading, setLoading]   = useState(true);
  // toggling: true while the PATCH /drivers/availability request is in-flight
  const [toggling, setToggling]   = useState(false);
  // appName: fetched from public config to display in "Approved by [appName]"
  const [appName, setAppName]     = useState('SolidaRoute');
  // Completeness modal state — only shown once per session for incomplete drivers
  const [missingFields, setMissingFields] = useState(null); // null = hidden
  // Missing fields banner — shown every visit when driver has outstanding required items.
  // Not session-gated: it stays until the driver fills in the required information.
  const [missingDocs, setMissingDocs]         = useState(null); // null = hidden (override-approved case)
  const [missingAllFields, setMissingAllFields] = useState(null); // null = hidden (incomplete/pending case)

  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Check for an email action result in the URL query string.
   * Drivers are redirected here after clicking Accept/Decline links in their
   * trip notification emails. The ?action= param signals what happened so we
   * can show a contextual toast message.
   *
   * Uses setTimeout(300) so the toast renders after the page has painted —
   * avoids a flash where the toast appears before layout is complete.
   * Cleans the URL after reading to avoid re-showing on refresh.
   */
  useEffect(() => {
    // Show toast for email action results (accept/decline via email link)
    const action = searchParams.get('action');
    if (action) {
      const messages = {
        accepted:  t('trips.action_accepted'),
        declined:  t('trips.action_declined'),
        expired:   t('trips.action_expired'),
        too_late:  t('trips.action_too_late'),
        error:     t('trips.action_error'),
        invalid:   t('trips.action_error'),
      };
      if (messages[action]) {
        setTimeout(() => {
          if (['accepted'].includes(action)) toast.success(messages[action]);
          else toast.error(messages[action]);
        }, 300);
      }
      setSearchParams({}, { replace: true }); // clean up URL
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * On mount: load trip stats and the public configuration in parallel.
   * Stats provide the driver profile (for approval status and is_available flag)
   * and the numeric trip counts shown on the dashboard tiles.
   * Public config provides the app name used in the "Approved by" line.
   *
   * Additionally: if the driver's profile is 'incomplete' and the completeness
   * modal has not been shown yet this session, fetch the missing fields and
   * show the modal once.  Uses sessionStorage so the modal is not shown again
   * if the driver navigates away and returns to the dashboard.
   */
  useEffect(() => {
    tripService.stats()
      .then(({ data }) => {
        setStats(data.stats);
        const approvalStatus    = data.stats?.profile?.approval_status;
        const approvalOverridden = data.stats?.profile?.approval_overridden;

        // Completeness modal — shown once per session for incomplete drivers only.
        if (approvalStatus === 'incomplete' && !sessionStorage.getItem(SESSION_KEY)) {
          sessionStorage.setItem(SESSION_KEY, '1');
          api.get('/profile/completeness')
            .then(({ data: comp }) => {
              if (!comp.complete && comp.missing?.length > 0) {
                setMissingFields(comp.missing);
              }
            })
            .catch(() => {}); // non-fatal — modal simply won't show
        }

        // Persistent missing-fields banner — shown every visit for incomplete/pending
        // drivers so they always know what to fill in, not just on first login.
        if (approvalStatus === 'incomplete' || approvalStatus === 'pending') {
          api.get('/profile/completeness')
            .then(({ data: comp }) => {
              if (!comp.complete && comp.missing?.length > 0) {
                setMissingAllFields(comp.missing);
              }
            })
            .catch(() => {});
        }

        // Document reminder banner — shown on every visit when the driver was
        // approved via override but still has outstanding document submissions.
        if (approvalStatus === 'approved' && approvalOverridden) {
          api.get('/profile/completeness')
            .then(({ data: comp }) => {
              const DOC_FIELDS = ['doc_license', 'doc_insurance', 'doc_registration'];
              const missingDocList = (comp.missing || []).filter(f => DOC_FIELDS.includes(f));
              if (missingDocList.length > 0) setMissingDocs(missingDocList);
            })
            .catch(() => {}); // non-fatal
        }
      })
      .catch(() => setStats(null))
      .finally(() => setLoading(false));

    // Read app_name from the public config route (accessible to all roles)
    api.get('/admin/configuration/public')
      .then(({ data }) => {
        const cfg = data.configuration || [];
        const name = cfg.find(c => c.key === 'app_name')?.value;
        if (name) setAppName(name);
      })
      .catch(() => {}); // keep default on error
  }, []);

  /**
   * Toggle the driver's on-duty / off-duty status.
   * Optimistically updates local stats so the toggle reflects immediately,
   * without waiting for a refetch. The backend is the source of truth if
   * the request fails — but we don't roll back here because failures are rare
   * and the user can simply toggle again.
   */
  async function toggleAvailability() {
    if (!stats?.profile) return;
    setToggling(true);
    const newVal = !stats.profile.is_available;
    try {
      await driverService.setAvailability({ is_available: newVal });
      // Update only the is_available flag inside the nested profile object
      setStats(prev => ({
        ...prev,
        profile: { ...prev.profile, is_available: newVal },
      }));
      toast.success(newVal ? t('dashboard.on_duty') : t('dashboard.off_duty'));
    } catch { /* toast already fired by global interceptor */ }
    finally { setToggling(false); }
  }

  if (loading) return <LoadingPage />;

  const profile  = stats?.profile;
  const earnings = stats?.earnings;
  const approved = profile?.approval_status === 'approved';

  /**
   * Trip stat tile definitions.
   * Each tile links to MyTrips pre-filtered by `status`.
   * status: null → "All trips" (no filter param).
   * value: falls back to 0 when stats haven't loaded yet to avoid NaN rendering.
   */
  const tripCards = [
    { label: t('dashboard.pending'),   value: stats?.pending   ?? 0, icon: '⏳', color: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200', status: 'pending'   },
    { label: t('dashboard.upcoming'),  value: stats?.upcoming  ?? 0, icon: '📅', color: 'bg-blue-50 dark:bg-blue-900/30  text-blue-700 dark:text-blue-300  border-blue-200',  status: 'upcoming'  },
    { label: t('dashboard.completed'), value: stats?.completed ?? 0, icon: '✅', color: 'bg-teal-50 dark:bg-teal-900/30  text-teal-700 dark:text-teal-300  border-teal-200',  status: 'completed' },
    { label: t('dashboard.cancelled'), value: stats?.cancelled ?? 0, icon: '✕',  color: 'bg-gray-50 dark:bg-gray-700/50  text-gray-500 dark:text-gray-400  border-gray-200 dark:border-gray-700',  status: 'cancelled' },
    { label: t('dashboard.all'),       value: stats?.all_trips ?? 0, icon: '📋', color: 'bg-white dark:bg-gray-800    text-gray-700 dark:text-gray-200  border-gray-300 dark:border-gray-600',  status: null        },
  ];

  return (
    <div>
      {/* Profile completeness modal — shown once per session for incomplete drivers */}
      {missingFields && (
        <ProfileCompletenessModal
          missing={missingFields}
          onClose={() => setMissingFields(null)}
        />
      )}

      {/* Header — greeting + CTA button to browse available trips */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1>{t('dashboard.title')}</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            {t('dashboard.welcome_back', { name: user?.first_name })}
          </p>
        </div>
        {/* Only show "Find Trips" CTA when driver is approved; badge shows count of open trips */}
        {approved && (
          <Link to="/driver/available" className="btn-primary">
            {t('dashboard.available_trips_cta')}
            {stats?.available_trips > 0 && (
              <span className="ml-2 bg-white dark:bg-gray-800 text-teal-700 dark:text-teal-300 text-xs font-bold px-2 py-0.5 rounded-full">
                {stats.available_trips}
              </span>
            )}
          </Link>
        )}
      </div>

      {/* Approval warning — shown when driver account is pending admin review */}
      {!approved && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 rounded-lg p-4 mb-6">
          <p className="text-amber-800 dark:text-amber-200 text-sm font-medium">
            ⏳ {t('dashboard.status_pending_approval')}
          </p>
          <p className="text-amber-700 dark:text-amber-300 text-xs mt-1">
            {t('verify_email.driver_pending_desc')}
          </p>
          {/* Persistent list of missing required fields */}
          {missingAllFields?.length > 0 && (
            <div className="mt-3 border-t border-amber-200 pt-3">
              <p className="text-amber-800 dark:text-amber-200 text-xs font-semibold mb-1">
                {t('dashboard.missing_fields_title')}
              </p>
              <ul className="text-xs text-amber-700 dark:text-amber-300 list-disc list-inside space-y-0.5">
                {missingAllFields.map(f => (
                  <li key={f}>{t(`admin.missing_field.${f}`, { defaultValue: f })}</li>
                ))}
              </ul>
              <div className="flex gap-2 mt-2">
                {missingAllFields.some(f => !f.startsWith('doc_')) && (
                  <a href="/driver/profile" className="text-xs font-medium text-amber-900 underline">{t('profile.go_to_profile')}</a>
                )}
                {missingAllFields.some(f => f.startsWith('doc_')) && (
                  <a href="/driver/documents" className="text-xs font-medium text-amber-900 underline">{t('profile.go_to_documents')}</a>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Override document reminder — shown every visit when driver was approved via
          override but still has outstanding document uploads.  Links to Documents page. */}
      {approved && missingDocs && missingDocs.length > 0 && (
        <div className="bg-orange-50 dark:bg-orange-900/30 border border-orange-200 rounded-lg p-4 mb-6">
          <p className="text-orange-800 text-sm font-semibold mb-1">
            📄 {t('dashboard.override_docs_title')}
          </p>
          <p className="text-orange-700 text-xs mb-3 leading-relaxed">
            {t('dashboard.override_docs_desc')}
          </p>
          <ul className="text-xs text-orange-700 list-disc list-inside mb-3 space-y-0.5">
            {missingDocs.map(f => (
              <li key={f}>{t(`admin.missing_field.${f}`, { defaultValue: f })}</li>
            ))}
          </ul>
          <Link to="/driver/documents" className="inline-block text-xs font-medium px-3 py-1.5 rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors">
            {t('profile.go_to_documents')} →
          </Link>
        </div>
      )}

      {/* Info cards: status, rating, earnings — only shown to approved drivers */}
      {approved && profile && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">

          {/* ── Status tile ─────────────────────────────────── */}
          <div className="card">
            {/* Tile title */}
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
              {t('dashboard.your_status')}
            </p>

            {/* Approval line — fetched app_name shows the organization name */}
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              ✅ {t('dashboard.approved_by', { name: appName })}
            </p>

            {/* On/off duty toggle switch */}
            {/* When off duty: driver is hidden from suggested/nearby and from operator dropdowns */}
            <div className="flex items-center justify-between">
              <span className={`text-sm font-semibold ${
                profile.is_available ? 'text-teal-700 dark:text-teal-300' : 'text-gray-400'
              }`}>
                {profile.is_available ? t('dashboard.on_duty') : t('dashboard.off_duty')}
              </span>
              <button
                onClick={toggleAvailability}
                disabled={toggling}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  profile.is_available ? 'bg-teal-500' : 'bg-gray-300'
                } ${toggling ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {/* Thumb slides right when on duty, left when off duty */}
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-800 shadow
                  transition-transform ${profile.is_available ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>
          </div>

          {/* ── Rating ──────────────────────────────────────── */}
          <div className="card">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('dashboard.your_rating')}</p>
            <div className="flex items-baseline gap-2">
              {/* Average rating formatted to 1 decimal place using locale-aware number formatting */}
              <span className="text-2xl font-bold text-teal-700 dark:text-teal-300">
                {formatNumber(profile.average_rating || 0, 1, i18n.language)}
              </span>
              <span className="text-yellow-400 text-lg">★</span>
              <span className="text-xs text-gray-400">
                ({profile.review_count} {t('dashboard.reviews')})
              </span>
            </div>
          </div>

          {/* ── Earnings ────────────────────────────────────── */}
          {/* pending_earnings: sum of driver's share for completed-but-not-yet-paid trips */}
          <div className="card">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('dashboard.earnings_pending')}</p>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-teal-700 dark:text-teal-300">
                {formatAmount(earnings?.pending_earnings || 0, i18n.language)}
              </span>
              <span className="text-sm text-gray-400">{currencySymbol(currency)}</span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {t('dashboard.earnings_total')}: {formatAmount(earnings?.total_earnings || 0, i18n.language)} {currencySymbol(currency)}
            </p>
          </div>
        </div>
      )}

      {/* Trip stat tiles — clickable shortcut links to MyTrips with pre-applied filter */}
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
        {t('dashboard.my_trips')}
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {tripCards.map(card => {
          // Build URL: include ?status=xxx unless it's the "all" tile (no filter)
          const to = card.status
            ? `/driver/my-trips?status=${card.status}`
            : '/driver/my-trips';
          return (
            <Link
              key={card.label}
              to={to}
              title={t('dashboard.click_to_filter')}
              className={`card border flex items-center gap-4 py-4 transition-all
                          hover:shadow-md hover:scale-[1.02] cursor-pointer ${card.color}`}
            >
              <span className="text-2xl">{card.icon}</span>
              <div>
                <div className="text-2xl font-bold">{card.value}</div>
                <div className="text-xs font-medium mt-0.5">{card.label}</div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
