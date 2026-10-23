/**
 * @file Dashboard.jsx
 * @route /admin  (or /admin/dashboard)
 * @access Operator, Superadmin
 *
 * The main landing page for all admin and operator users after login.
 * Provides an at-a-glance overview of the platform's current state via two
 * groups of stat tiles:
 *
 *   1. User stats  — total clients, total drivers, pending driver applications,
 *                    and (superadmin only) total operators
 *   2. Trip stats  — counts broken down by trip lifecycle status, plus a grand total
 *
 * Each tile is a clickable link that navigates to the relevant filtered list
 * page, making this page a navigation hub as much as an information display.
 *
 * Role-based visibility:
 *   - Operators  : see all tiles EXCEPT operator count and revenue
 *   - Superadmins: see every tile including the revenue banner
 *
 * Trip status semantics (all buckets are mutually exclusive and exhaustive):
 *   pending      — trip booked but no driver assigned yet
 *   upcoming     — driver assigned, departure in the future
 *   active       — departure has passed but the return window is still open
 *                  (dynamically calculated server-side, not a stored status)
 *   completed    — driver confirmed trip as done
 *   past_assigned— departure AND return window passed but never confirmed —
 *                  shown as an alert because these need follow-up
 *   cancelled    — trip was cancelled before completion
 *   all_trips    — grand total across all statuses
 *
 * Alert banners appear below the trip tiles when there are pending trips or
 * pending driver applications, drawing the operator's attention to items
 * that require immediate action.
 */
import { formatAmount, currencySymbol } from '../../utils/format';
import { useAppConfig } from '../../context/AppConfigContext';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { adminService } from '../../services/api';
import { LoadingPage } from '../../components/common';

/**
 * AdminDashboard (default export)
 *
 * Fetches a single `stats` object from the backend on mount and derives all
 * tile values from it. No sub-components are needed; the page is simple enough
 * to render inline.
 *
 * Key state:
 *   stats   — the dashboard payload from the API; null until loaded or on error
 *   loading — shows the full-page spinner while the first fetch is in flight
 */
export default function AdminDashboard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { currency } = useAppConfig();
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);

  /**
   * Fetch dashboard statistics on mount.
   * On error, stats stays null and all tile values fall back to 0 via `?? 0`,
   * so the page still renders rather than showing a broken state.
   */
  useEffect(() => {
    adminService.dashboard()
      .then(({ data }) => setStats(data.stats))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingPage />;

  // Derive role once so it can be used in multiple conditional sections below
  const isSuperAdmin = user?.role === 'superadmin';

  /**
   * User stat tiles.
   * Each tile links to its management page for one-click navigation.
   * The "pending drivers" tile links directly to the filtered ?filter=pending
   * view because pending applications are the most time-sensitive user metric.
   * The operator tile is only included for superadmins (operators don't manage
   * their own peers via this page).
   */
  const userCards = [
    {
      label: t('dashboard.total_clients'),
      value: stats?.total_clients   ?? 0,
      icon: '🧑', color: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-800',
      link: '/admin/users',
    },
    {
      label: t('dashboard.total_drivers'),
      value: stats?.total_drivers   ?? 0,
      icon: '🚗', color: 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border-teal-100 dark:border-teal-800',
      link: '/admin/drivers',
    },
    {
      label: t('dashboard.pending_drivers'),
      value: stats?.pending_drivers ?? 0,
      icon: '⏳', color: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-100 dark:border-amber-800',
      // Deep link into DriverManagement with pending filter pre-activated
      link: '/admin/drivers?filter=pending',
    },
    // Spread the operator tile in only for superadmins; regular operators cannot
    // manage their peers from this page, so the tile would be misleading for them
    ...(isSuperAdmin ? [{
      label: t('dashboard.total_operators'),
      value: stats?.total_operators ?? 0,
      icon: '🎧', color: 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800',
      link: '/admin/operators',
    }] : []),
  ];

  /**
   * Trip stat tiles — one per lifecycle status plus a grand total.
   *
   * The `status` field maps to the query param used by the Trips page filter.
   * Tiles with status=null link to /admin/trips without a filter (show all).
   *
   * Note: "active" trips have no stored status of their own — the backend
   * calculates them dynamically, so there is no ?status=active filter link.
   */
  const tripCards = [
    { label: t('dashboard.pending'),      value: stats?.pending_trips   ?? 0, icon: '⏳', color: 'bg-amber-50 dark:bg-amber-900/30  text-amber-700 dark:text-amber-300  border-amber-100 dark:border-amber-800',  status: 'pending'   },
    { label: t('dashboard.upcoming'),     value: stats?.upcoming_trips  ?? 0, icon: '📅', color: 'bg-blue-50 dark:bg-blue-900/30   text-blue-700 dark:text-blue-300   border-blue-100 dark:border-blue-800',   status: 'assigned'  },
    { label: t('dashboard.active_trips'), value: stats?.active_trips    ?? 0, icon: '🚗', color: 'bg-green-50 dark:bg-green-900/30  text-green-700 dark:text-green-300  border-green-100 dark:border-green-800',  status: null        },
    { label: t('dashboard.completed'),    value: stats?.completed_trips ?? 0, icon: '✅', color: 'bg-teal-50 dark:bg-teal-900/30   text-teal-700 dark:text-teal-300   border-teal-100 dark:border-teal-800',   status: 'completed' },
    { label: t('dashboard.cancelled'),    value: stats?.cancelled_trips ?? 0, icon: '✕',  color: 'bg-gray-50 dark:bg-gray-700/50   text-gray-500 dark:text-gray-400   border-gray-100 dark:border-gray-700',   status: 'cancelled' },
    // "All" tile: links to unfiltered trip list — value is the server-computed grand total
    { label: t('dashboard.all'),          value: stats?.all_trips       ?? 0, icon: '📋', color: 'bg-white dark:bg-gray-800     text-gray-700 dark:text-gray-200   border-gray-300 dark:border-gray-600',   status: null        },
  ];

  return (
    <div>
      {/* Page header: personalised greeting + quick link to the full trip list */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1>{t('dashboard.title')}</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            {t('dashboard.welcome_back', { name: user?.first_name })}
          </p>
        </div>
        <Link to="/admin/trips" className="btn-secondary text-sm">
          {t('dashboard.all_trips')} →
        </Link>
      </div>

      {/*
        Revenue banner — superadmin only.
        Shows rolling 30-day revenue as a prominent teal card.
        Regular operators don't see financial data.
      */}
      {isSuperAdmin && (
        <div className="card bg-teal-600 text-white mb-6 flex items-center justify-between">
          <div>
            <p className="text-teal-200 text-xs font-medium uppercase tracking-wider">
              {t('dashboard.revenue_30d')}
            </p>
            <p className="text-3xl font-bold mt-1">
              {formatAmount(stats?.revenue_last_30d ?? 0, i18n.language)} {currencySymbol(currency)}
            </p>
          </div>
          {/* Large decorative icon — muted opacity so it doesn't compete with the number */}
          <div className="text-5xl opacity-20">💰</div>
        </div>
      )}

      {/* ── User stats section ───────────────────────────────── */}
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
        {t('dashboard.global_stats')}
      </h2>
      {/*
        2-column on mobile, 4-column on md+ breakpoint.
        Each card is a Link so the whole tile is clickable, not just a button inside it.
      */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {userCards.map(card => (
          <Link key={card.label} to={card.link}
            className={`card border flex items-center gap-3 py-4 hover:shadow-md transition-shadow ${card.color}`}>
            <span className="text-2xl">{card.icon}</span>
            <div>
              <div className="text-2xl font-bold">{card.value}</div>
              <div className="text-xs font-medium mt-0.5 leading-tight">{card.label}</div>
            </div>
          </Link>
        ))}
      </div>

      {/* ── Trip stats section ───────────────────────────────── */}
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
        {t('dashboard.all_trips')}
      </h2>

      {/*
        2-column on mobile, 3-column on md+ breakpoint.
        Tiles scale up slightly on hover to reinforce that they are navigable links.
        The `to` URL is built from the tile's `status` field: if status is set,
        append ?status=<value> to pre-filter the Trips page; otherwise link unfiltered.
      */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
        {tripCards.map(card => {
          const to = card.status
            ? `/admin/trips?status=${card.status}`
            : '/admin/trips';
          return (
            <Link
              key={card.label}
              to={to}
              title={t('dashboard.click_to_filter')}
              className={`card border flex items-center gap-4 py-4 transition-all
                          hover:shadow-md hover:scale-[1.02] cursor-pointer ${card.color}`}
            >
              <span className="text-2xl">{card.icon}</span>
              <div className="min-w-0">
                <div className="text-2xl font-bold">{card.value}</div>
                <div className="text-xs font-medium mt-0.5 leading-tight">{card.label}</div>
              </div>
            </Link>
          );
        })}
      </div>

      {/*
        Alert banners — only rendered when their respective counts are non-zero.
        These are intentionally prominent (amber/blue backgrounds) to drive
        operators to take action on items that are blocking or time-sensitive.
      */}

      {/* Pending trips alert: trips with no driver assigned yet */}
      {(stats?.pending_trips ?? 0) > 0 && (
        <div className="mt-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-100 dark:border-amber-800 rounded-lg p-4
                        flex items-center justify-between">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            🕐 {stats.pending_trips} {t('dashboard.pending_trips_alert')}
          </p>
          <Link to="/admin/trips" className="text-sm font-medium text-amber-700 dark:text-amber-300 underline ml-4 whitespace-nowrap">
            {t('dashboard.all_trips')} →
          </Link>
        </div>
      )}

      {/* Pending drivers alert: driver applications awaiting admin review */}
      {(stats?.pending_drivers ?? 0) > 0 && (
        <div className="mt-3 bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 rounded-lg p-4
                        flex items-center justify-between">
          <p className="text-sm text-blue-800 dark:text-blue-200">
            🚗 {stats.pending_drivers} {t('dashboard.pending_drivers_alert')}
          </p>
          {/* Link goes directly to the driver list (admin will activate the filter there) */}
          <Link to="/admin/drivers" className="text-sm font-medium text-blue-700 dark:text-blue-300 underline ml-4 whitespace-nowrap">
            {t('nav.drivers')} →
          </Link>
        </div>
      )}
    </div>
  );
}
