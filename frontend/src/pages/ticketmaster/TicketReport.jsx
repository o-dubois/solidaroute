/**
 * @file pages/ticketmaster/TicketReport.jsx
 * @description Ticket Master — used-ticket payment report.
 *              Route: /ticket-master/reports  (role: ticket_master only)
 *
 * Allows the ticket master to retrieve a list of mobility tickets that have
 * been marked as 'used' (i.e. the trip is complete and the delay window has
 * passed) within a selected date range. This list is the basis for paying
 * drivers outside the application (bank transfer, cheque, etc.).
 *
 * Features:
 *   - From / To date pickers
 *   - Fetch button — loads the report on demand (not on every keystroke)
 *   - Results table: ticket #, date used, trip #, customer, driver
 *   - CSV export button — generates a downloadable file in the browser
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ticketService } from '../../services/api';
import toast from 'react-hot-toast';

// ── Date helpers ───────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

// ── CSV export ─────────────────────────────────────────────────────────────

function exportCSV(tickets, t) {
  const SEP = ';';
  const escape = val => {
    const s = String(val ?? '');
    return s.includes(SEP) || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const headers = [
    t('tickets.report_col_ticket'),
    t('tickets.report_col_date'),
    t('tickets.report_col_trip'),
    t('tickets.report_col_customer'),
    t('tickets.report_col_driver'),
  ];

  const rows = tickets.map(r => [
    r.ticket_number,
    r.used_at ? new Date(r.used_at).toISOString().slice(0, 10) : '',
    r.trip_number ? `T-${r.trip_number}` : '',
    r.customer_name ?? '',
    r.driver_name   ?? '',
  ]);

  const lines = [
    headers.map(escape).join(SEP),
    ...rows.map(row => row.map(escape).join(SEP)),
  ];

  const bom  = '\uFEFF';
  const blob = new Blob([bom + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const filename = `${t('tickets.report_export_filename')}-${today()}.csv`;

  const anchor = document.createElement('a');
  anchor.href     = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// ── Main component ─────────────────────────────────────────────────────────

export default function TicketReport() {
  const { t } = useTranslation();
  const [from,    setFrom]    = useState(firstOfMonth());
  const [to,      setTo]      = useState(today());
  const [tickets, setTickets] = useState(null); // null = not yet searched
  const [loading, setLoading] = useState(false);

  function handleSearch() {
    if (!from || !to) {
      toast.error(t('tickets.report_date_required'));
      return;
    }
    if (new Date(from) > new Date(to)) {
      toast.error(t('tickets.report_date_invalid'));
      return;
    }
    setLoading(true);
    ticketService.usedReport(from, to)
      .then(({ data }) => setTickets(data.tickets || []))
      .catch(() => setTickets([]))
      .finally(() => setLoading(false));
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1>{t('tickets.report_title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('tickets.report_subtitle')}</p>
      </div>

      {/* Date range + search */}
      <div className="card mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              {t('tickets.report_from')}
            </label>
            <input
              type="date"
              className="input"
              value={from}
              max={to}
              onChange={e => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              {t('tickets.report_to')}
            </label>
            <input
              type="date"
              className="input"
              value={to}
              min={from}
              max={today()}
              onChange={e => setTo(e.target.value)}
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={loading}
            className="btn-primary disabled:opacity-50"
          >
            {loading ? '…' : t('tickets.report_search')}
          </button>
        </div>
      </div>

      {/* Results */}
      {tickets === null ? null : tickets.length === 0 ? (
        <div className="card text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">🎫</div>
          <p className="text-sm">{t('tickets.report_empty')}</p>
        </div>
      ) : (
        <>
          {/* Export + count */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {tickets.length} {t('tickets.report_results')}
            </p>
            <button
              onClick={() => exportCSV(tickets, t)}
              className="btn-secondary text-sm flex items-center gap-1.5"
            >
              📄 {t('tickets.report_export_csv')}
            </button>
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 dark:bg-gray-700/50 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  <th className="text-left px-4 py-3">{t('tickets.report_col_ticket')}</th>
                  <th className="text-left px-4 py-3">{t('tickets.report_col_date')}</th>
                  <th className="text-left px-4 py-3">{t('tickets.report_col_trip')}</th>
                  <th className="text-left px-4 py-3">{t('tickets.report_col_customer')}</th>
                  <th className="text-left px-4 py-3">{t('tickets.report_col_driver')}</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((row, idx) => (
                  <tr
                    key={row.ticket_number}
                    className={`border-b last:border-0 ${idx % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50'}`}
                  >
                    <td className="px-4 py-2.5 font-mono font-semibold text-gray-700 dark:text-gray-200">
                      {row.ticket_number}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
                      {formatDate(row.used_at)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-gray-700 dark:text-gray-200">
                      {row.trip_number ? `T-${row.trip_number}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-800 dark:text-gray-100">
                      {row.customer_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-800 dark:text-gray-100">
                      {row.driver_name || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
