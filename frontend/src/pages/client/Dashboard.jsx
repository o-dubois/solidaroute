/**
 * @file pages/client/Dashboard.jsx
 * @description Client home screen after login — /client
 *
 * Displays a row of trip stat tiles (Pending, Upcoming, Completed, Cancelled, All).
 * Every tile is a clickable Link that navigates to /client/trips?status=<status>,
 * landing the user directly on the filtered trip list.  The "All" tile links to
 * /client/trips with no status param so all trips are shown.
 *
 * Stats are fetched from GET /api/trips/stats on mount.  If the request fails,
 * all counts show as 0 rather than blocking the page with an error state.
 *
 * A "New trip" CTA button in the header is the primary action on this page.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { tripService } from '../../services/api';
import { LoadingPage } from '../../components/common';

export default function ClientDashboard() {
  const { t }    = useTranslation();
  const { user } = useAuth();
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    tripService.stats()
      .then(({ data }) => setStats(data.stats))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingPage />;

  // Each card links to the trips page with the matching status filter.
  // 'all' has no status param — shows everything.
  const cards = [
    { label: t('dashboard.pending'),   value: stats?.pending   ?? 0, color: 'bg-amber-50 dark:bg-amber-900/30  text-amber-700 dark:text-amber-300  border-amber-200',  icon: '⏳', status: 'pending'   },
    { label: t('dashboard.upcoming'),  value: stats?.upcoming  ?? 0, color: 'bg-blue-50 dark:bg-blue-900/30   text-blue-700 dark:text-blue-300   border-blue-200',   icon: '📅', status: 'upcoming'  },
    { label: t('dashboard.completed'), value: stats?.completed ?? 0, color: 'bg-teal-50 dark:bg-teal-900/30   text-teal-700 dark:text-teal-300   border-teal-200',   icon: '✅', status: 'completed' },
    { label: t('dashboard.cancelled'), value: stats?.cancelled ?? 0, color: 'bg-gray-50 dark:bg-gray-700/50   text-gray-500 dark:text-gray-400   border-gray-200 dark:border-gray-700',   icon: '✕',  status: 'cancelled' },
    { label: t('dashboard.all'),       value: stats?.all_trips ?? 0, color: 'bg-white dark:bg-gray-800     text-gray-700 dark:text-gray-200   border-gray-300 dark:border-gray-600',   icon: '📋', status: null        },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1>{t('dashboard.title')}</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            {t('dashboard.welcome_back', { name: user?.first_name })}
          </p>
        </div>
        <Link to="/client/trips/new" className="btn-primary">
          + {t('dashboard.new_trip_cta')}
        </Link>
      </div>

      {/* Clickable trip stat tiles */}
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
        {t('dashboard.my_trips')}
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
        {cards.map(card => {
          const to = card.status
            ? `/client/trips?status=${card.status}`
            : '/client/trips';
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
