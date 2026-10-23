/**
 * @file pages/ticketmaster/Dashboard.jsx
 * @description Ticket Master landing page — /ticket-master  (role: ticketmaster)
 *
 * Displays an at-a-glance summary of the entire mobility ticket inventory,
 * computed in JS from the list of notebooks returned by GET /api/tickets/notebooks.
 *
 * Stat tiles:
 *   Notebooks  — total number of ticket books in the system
 *   Available  — tickets that can still be reserved for a trip
 *   Reserved   — tickets currently linked to an upcoming trip
 *   Used       — tickets consumed by a completed trip (permanent)
 *   Voided     — tickets cancelled by an admin (permanent)
 *   Total      — grand total of all ticket rows across all notebooks
 *
 * Below the stats, the five most recently created notebooks are shown as
 * a quick-access list.  "View all" and the "+ Create notebook" button in the
 * header both navigate to /ticket-master/notebooks for the full management
 * interface.
 *
 * Stats are derived client-side (no separate stats API call) — the notebooks
 * list already contains per-notebook counts, so we aggregate them here.
 */
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ticketService } from '../../services/api';

export default function TicketMasterDashboard() {
  const { t } = useTranslation();
  const [loading,    setLoading]    = useState(true);
  const [notebooks,  setNotebooks]  = useState([]);

  useEffect(() => {
    ticketService.notebooks()
      .then(({ data }) => setNotebooks(data.notebooks || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Compute aggregate stats from notebooks
  const totalNotebooks   = notebooks.length;
  const totalTickets     = notebooks.reduce((s, n) => s + parseInt(n.total_tickets    || 0), 0);
  const availableTickets = notebooks.reduce((s, n) => s + parseInt(n.available_tickets || 0), 0);
  const reservedTickets  = notebooks.reduce((s, n) => s + parseInt(n.reserved_tickets  || 0), 0);
  const usedTickets      = notebooks.reduce((s, n) => s + parseInt(n.used_tickets       || 0), 0);
  const voidedTickets    = notebooks.reduce((s, n) => s + parseInt(n.voided_tickets     || 0), 0);

  const stats = [
    { label: t('tickets.stat_notebooks'),  value: totalNotebooks,   color: 'teal',  icon: '📒' },
    { label: t('tickets.stat_available'),  value: availableTickets, color: 'green', icon: '✅' },
    { label: t('tickets.stat_reserved'),   value: reservedTickets,  color: 'blue',  icon: '🔒' },
    { label: t('tickets.stat_used'),       value: usedTickets,      color: 'gray',  icon: '✓'  },
    { label: t('tickets.stat_voided'),     value: voidedTickets,    color: 'red',   icon: '🚫' },
    { label: t('tickets.stat_total'),      value: totalTickets,     color: 'white', icon: '🎫' },
  ];

  const colorMap = {
    teal:  'bg-teal-50 dark:bg-teal-900/30  text-teal-700 dark:text-teal-300  border-teal-100 dark:border-teal-800',
    green: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-100 dark:border-green-800',
    blue:  'bg-blue-50 dark:bg-blue-900/30  text-blue-700 dark:text-blue-300  border-blue-100 dark:border-blue-800',
    gray:  'bg-gray-50 dark:bg-gray-700/50  text-gray-600 dark:text-gray-300  border-gray-100 dark:border-gray-700',
    red:   'bg-red-50 dark:bg-red-900/30   text-red-600   border-red-100 dark:border-red-800',
    white: 'bg-white dark:bg-gray-800    text-gray-800 dark:text-gray-100  border-gray-200 dark:border-gray-700',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1>{t('tickets.dashboard_title')}</h1>
        <Link to="/ticket-master/notebooks" className="btn-primary text-sm">
          + {t('tickets.create_notebook')}
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm py-8 justify-center">
          <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <>
          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {stats.map(s => (
              <div key={s.label} className={`rounded-xl border p-4 ${colorMap[s.color]}`}>
                <div className="text-2xl mb-1">{s.icon}</div>
                <div className="text-2xl font-bold">{s.value}</div>
                <div className="text-xs mt-0.5 opacity-75">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Recent notebooks */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold">{t('tickets.recent_notebooks')}</h2>
              <Link to="/ticket-master/notebooks" className="text-xs text-teal-600 dark:text-teal-400 hover:underline">
                {t('tickets.view_all')} →
              </Link>
            </div>
            {notebooks.length === 0 ? (
              <p className="text-sm text-gray-400">{t('tickets.no_notebooks')}</p>
            ) : (
              <div className="space-y-2">
                {notebooks.slice(0, 5).map(nb => (
                  <Link
                    key={nb.id}
                    to={`/ticket-master/notebooks/${nb.id}`}
                    className="flex items-center justify-between p-3 rounded-xl border border-gray-100 dark:border-gray-700
                               hover:border-teal-200 hover:bg-teal-50 transition-colors"
                  >
                    <div>
                      <span className="font-mono text-xs font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded px-1.5 py-0.5 mr-2">
                        N-{String(nb.notebook_number).padStart(4, '0')}
                      </span>
                      <span className="text-sm text-gray-700 dark:text-gray-200">
                        {nb.owner_type === 'client'
                          ? `${nb.owner_first_name} ${nb.owner_last_name}`
                          : `🏢 ${nb.org_name || t('tickets.owner_organization')}`}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-gray-400">
                        {nb.available_tickets}/{nb.total_tickets} {t('tickets.available')}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
