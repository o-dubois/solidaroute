/**
 * @file pages/ticketmaster/TicketTrips.jsx
 * @description Ticket Master — trips that were paid with mobility tickets.
 *              Route: /ticket-master/trips  (roles: ticket_master, operator, superadmin)
 *
 * Read-only audit view that lets the ticket master trace the lifecycle of each
 * mobility ticket used as a payment method:
 *   - Which trip the ticket was reserved for
 *   - The trip's current status (pending / assigned / completed / cancelled)
 *   - The payment record status (authorized / paid / failed)
 *   - Which notebook the ticket came from and its slot number
 *
 * Data is fetched from GET /api/tickets/trips and filtered client-side.
 * An inline search box filters by client name, driver name, or trip number.
 *
 * STATUS_STYLE and PAYMENT_STYLE maps control the badge colours for trip status
 * and payment status respectively — defined once at module level so all rows
 * share a consistent colour scheme.
 */
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ticketService } from '../../services/api';

const STATUS_STYLE = {
  pending:   'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200',
  assigned:  'bg-blue-100 dark:bg-blue-900/40  text-blue-800 dark:text-blue-200',
  completed: 'bg-teal-100 dark:bg-teal-900/40  text-teal-800 dark:text-teal-200',
  cancelled: 'bg-gray-100 dark:bg-gray-700  text-gray-500 dark:text-gray-400',
};

const PAYMENT_STYLE = {
  authorized: 'bg-blue-50 dark:bg-blue-900/30  text-blue-700 dark:text-blue-300',
  paid:       'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  failed:     'bg-red-50 dark:bg-red-900/30   text-red-700 dark:text-red-300',
};

export default function TicketTrips() {
  const { t } = useTranslation();
  const [loading,       setLoading]       = useState(true);
  const [trips,         setTrips]         = useState([]);
  const [filter,        setFilter]        = useState('');
  const [search,      setSearch]      = useState('');
  const [dateFilter,  setDateFilter]  = useState('');

  useEffect(() => {
    setLoading(true);
    ticketService.trips(filter ? { status: filter } : {})
      .then(({ data }) => setTrips(data.trips || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filter]);

  // Client-side filtering: name search + ticket payment status + date
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return trips.filter(trip => {
      if (q) {
        const client = `${trip.client_first_name || ''} ${trip.client_last_name || ''}`.toLowerCase();
        const driver = `${trip.driver_first_name || ''} ${trip.driver_last_name || ''}`.toLowerCase();
        if (!client.includes(q) && !driver.includes(q)) return false;
      }
      if (dateFilter.trim()) {
        const tripDate = trip.departure_at?.slice(0, 10) ?? '';
        if (!tripDate.startsWith(dateFilter.trim())) return false;
      }
      return true;
    });
  }, [trips, search, dateFilter]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1>{t('tickets.trips_title')}</h1>
        {/* Status filter tabs */}
        <div className="flex gap-2 flex-wrap">
          {['', 'pending', 'assigned', 'completed', 'cancelled'].map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
                filter === s
                  ? 'bg-teal-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200'
              }`}
            >
              {s ? t(`status.${s}`) : t('common.all', { defaultValue: 'All' })}
            </button>
          ))}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Name search */}
        <div className="relative flex-1 min-w-[9rem]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('tickets.search_trips_placeholder', { defaultValue: 'Client or driver…' })}
            className="input pl-8 text-sm w-full"
          />
        </div>

        {/* Date filter */}
        <div className="relative flex-1 min-w-[9rem]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">📅</span>
          <input
            type="text"
            value={dateFilter}
            onChange={e => setDateFilter(e.target.value)}
            placeholder={t('tickets.filter_date_placeholder')}
            className="input pl-8 text-sm w-full"
          />
        </div>

        {(search || dateFilter) && (
          <button
            type="button"
            onClick={() => { setSearch(''); setDateFilter(''); }}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
          >
            ✕ {t('common.clear', { defaultValue: 'Clear' })}
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm py-8 justify-center">
          <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : trips.length === 0 ? (
        <div className="card text-center py-10 text-gray-400">
          <p className="text-3xl mb-3">🎫</p>
          <p className="text-sm">{t('tickets.no_trips')}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-10 text-gray-400">
          <p className="text-3xl mb-3">🔍</p>
          <p className="text-sm">{t('common.no_results', { defaultValue: 'No trips match your search.' })}</p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {filtered.map(trip => (
              <div key={trip.id} className="card space-y-2">
                {/* Header row */}
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-white bg-gray-500 rounded px-2 py-0.5 text-xs">
                      T-{trip.trip_number}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[trip.status] || ''}`}>
                      {t(`status.${trip.status}`)}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PAYMENT_STYLE[trip.payment_status] || 'bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400'}`}>
                      🎫 {t(`tickets.payment_${trip.payment_status}`)}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {new Date(trip.departure_at).toLocaleDateString()}
                  </span>
                </div>

                {/* Addresses */}
                <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                  <p>📍 {trip.pickup_address}</p>
                  <p>🏁 {trip.dropoff_address}</p>
                </div>

                {/* Client / Driver */}
                <div className="flex gap-4 text-xs text-gray-600 dark:text-gray-300">
                  <span>👤 {trip.client_first_name} {trip.client_last_name}</span>
                  {trip.driver_first_name && (
                    <span>🚗 {trip.driver_first_name} {trip.driver_last_name}</span>
                  )}
                </div>

                {/* Ticket numbers */}
                {trip.ticket_numbers && trip.ticket_numbers.filter(Boolean).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {trip.ticket_numbers.filter(Boolean).map(num => (
                      <span
                        key={num}
                        className="font-mono text-xs bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border border-teal-200 rounded px-2 py-0.5"
                      >
                        {num}
                      </span>
                    ))}
                  </div>
                )}

                {/* Amount */}
                {trip.payment_amount && (
                  <p className="text-xs text-gray-400 text-right">
                    {parseFloat(trip.payment_amount).toFixed(2)} {trip.payment_currency}
                  </p>
                )}
              </div>
            ))}
          </div>
          {filtered.length < trips.length && (
            <p className="text-xs text-gray-400 text-center">
              {t('common.showing_of', {
                shown: filtered.length,
                total: trips.length,
                defaultValue: `Showing ${filtered.length} of ${trips.length}`,
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
