/**
 * Driver Earnings — /driver/earnings
 *
 * Lists all completed trips for the driver with the amount they earned on each.
 * The amount shown is the driver's share (driver_share_percent from system config)
 * as calculated and stored by the backend — the frontend just displays it.
 *
 * Export button: generates a CSV file in the browser with no server round-trip.
 *   Semicolon separator is used for better Excel/LibreOffice compatibility.
 *   UTF-8 BOM is prepended so accented characters render correctly on Windows.
 *
 * Export content:
 *   Columns : Nº trajet | Date | Adresse départ | Usager | Montant (CAD)
 *   Last row: TOTAL | | | | sum
 */
import { formatAmount, currencySymbol } from '../../utils/format';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { driverService } from '../../services/api';
import { LoadingPage } from '../../components/common';
import { useAppConfig } from '../../context/AppConfigContext';

/**
 * Format an ISO date for display in the earnings list.
 * Uses the browser's locale for a localized long-form date string.
 * Returns an em-dash for missing values.
 */
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

/**
 * Format a date as YYYY-MM-DD for use in CSV export rows and the filename.
 * ISO-style date keeps the filename sortable and unambiguous across locales.
 */
function formatDateExport(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/**
 * Build the data structure shared by both export formats (CSV).
 * Returns:
 *   headers  — translated column header strings
 *   dataRows — 2D array of string values, one row per earning entry
 *   totalRow — summary row with total amount in the last column
 *
 * Amount uses fallback chain: row.amount → row.estimated_cost → 0
 * (older trips may not have a settled amount yet).
 */
function buildRows(earnings, t, lang, currency) {
  const headers = [
    t('dashboard.export_col_trip'),
    t('dashboard.export_col_date'),
    t('dashboard.export_col_pickup'),
    t('dashboard.export_col_client'),
    t('dashboard.export_col_amount', { currency }),
  ];

  const dataRows = earnings.map(row => {
    const amount = row.amount ?? row.estimated_cost ?? 0;
    return [
      row.trip_number ? `T-${row.trip_number}` : '',
      formatDateExport(row.completed_at || row.departure_at),
      row.pickup_address || '',
      row.client_name   || '',
      formatAmount(amount, lang),
    ];
  });

  // Compute total as plain float sum before formatting, to preserve precision
  const total = earnings.reduce((sum, r) => {
    return sum + parseFloat(r.amount ?? r.estimated_cost ?? 0);
  }, 0);

  const totalRow = [
    t('dashboard.export_col_total'),
    '', '', '',
    total.toFixed(2),
  ];

  return { headers, dataRows, totalRow };
}

/**
 * exportCSV — generates and triggers a browser download of a CSV file.
 *
 * No external libraries — uses the Blob + anchor click trick.
 * Attaches the anchor to the DOM before clicking because Firefox and some
 * Chromium versions require the element to be in the document tree.
 * Revokes the object URL after 10 seconds to free memory.
 */
function exportCSV(earnings, t, lang, currency) {
  const { headers, dataRows, totalRow } = buildRows(earnings, t, lang, currency);

  // Use semicolon as separator — better compatibility with European Excel/LibreOffice
  const SEP = ';';

  const escape = val => {
    const s = String(val);
    // Quote fields containing semicolon, double-quote, or newline
    return s.includes(SEP) || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const lines = [
    headers.map(escape).join(SEP),
    ...dataRows.map(row => row.map(escape).join(SEP)),
    totalRow.map(escape).join(SEP),
  ];

  const bom  = '\uFEFF'; // UTF-8 BOM — required for Excel/LibreOffice accent support
  const blob = new Blob([bom + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const today = formatDateExport(new Date().toISOString());

  // Attach to DOM before clicking — required by Firefox and some Chromium versions
  const anchor = document.createElement('a');
  anchor.href     = url;
  anchor.download = `${t('dashboard.export_filename')}-${today}.csv`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// ── Main component ─────────────────────────────────────────────

/**
 * Earnings — main page component.
 *
 * State:
 *   earnings — array of earning rows (one per completed trip)
 *   summary  — { total } — aggregate across all rows, computed by the backend
 *   loading  — true during initial fetch
 *
 * The summary total tile is only shown when there is at least one earning row,
 * since showing "0.00 $" when empty is redundant with the empty state message.
 */
export default function Earnings() {
  const { t, i18n } = useTranslation();
  const { currency } = useAppConfig();
  const [earnings, setEarnings] = useState([]);
  const [summary,  setSummary]  = useState(null);
  const [loading,  setLoading]  = useState(true);

  /** Fetch all earnings rows and summary on mount. */
  useEffect(() => {
    driverService.earnings()
      .then(({ data }) => {
        setEarnings(data.earnings || []);
        setSummary(data.summary  || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingPage />;

  return (
    <div>
      {/* Header + export buttons — export only shown when there is data to export */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1>{t('dashboard.earnings_title')}</h1>
        {earnings.length > 0 && (
          <div className="flex gap-2">
            <button
              onClick={() => exportCSV(earnings, t, i18n.language, currency)}
              className="btn-secondary text-sm flex items-center gap-1.5"
            >
              📄 {t('dashboard.export_csv')}
            </button>

          </div>
        )}
      </div>

      {/* Total summary tile — teal card showing overall earnings at a glance */}
      {summary && earnings.length > 0 && (
        <div className="card border border-teal-200 bg-teal-50 dark:bg-teal-900/30 mb-8 inline-block min-w-[200px]">
          <p className="text-xs text-teal-600 dark:text-teal-400 font-medium mb-1">
            {t('dashboard.earnings_total')}
          </p>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold text-teal-700 dark:text-teal-300">
              {formatAmount(summary.total, i18n.language)}
            </span>
            <span className="text-sm text-teal-500">{currencySymbol(currency)}</span>
          </div>
          <p className="text-xs text-teal-400 mt-1">
            {earnings.length} {t('trips.trips_count')}
          </p>
        </div>
      )}

      {/* Earnings list — empty state or scrollable row list */}
      {earnings.length === 0 ? (
        <div className="card text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">💰</div>
          <p className="text-sm">{t('dashboard.earnings_empty')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {earnings.map((row, idx) => {
            // Amount fallback: use settled amount if available, otherwise estimated cost
            const amount = row.amount ?? row.estimated_cost ?? null;
            return (
              <div
                key={row.trip_id}
                className={`flex items-center gap-4 px-4 py-3 ${
                  idx < earnings.length - 1 ? 'border-b border-gray-100 dark:border-gray-700' : ''
                }`}
              >
                {/* Trip info — number, date, pickup address, client name */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-0.5">
                    {row.trip_number && (
                      <span className="text-xs font-mono font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                        T-{row.trip_number}
                      </span>
                    )}
                    {/* Use completed_at if present; fall back to departure_at for older trips */}
                    <span className="text-xs text-gray-400">
                      {formatDate(row.completed_at || row.departure_at)}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                    📍 {row.pickup_address}
                  </p>
                  {row.client_name && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      🧑 {row.client_name}
                    </p>
                  )}
                </div>

                {/* Amount — right-aligned, bold teal for positive amounts; dash for null */}
                <div className="flex-shrink-0 text-right">
                  {amount !== null ? (
                    <p className="text-lg font-bold text-teal-700 dark:text-teal-300">
                      {formatAmount(amount, i18n.language)} {currencySymbol(currency)}
                    </p>
                  ) : (
                    <p className="text-sm text-gray-400">—</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
