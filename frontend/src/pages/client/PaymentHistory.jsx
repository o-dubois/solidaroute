/**
 * @file pages/client/PaymentHistory.jsx
 * @description Paginated payment history for the authenticated client.
 *
 * Displays all payments associated with the client's trips, sorted newest
 * to oldest. 30 entries per page with numbered pagination controls.
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { paymentService } from '../../services/api';
import { LoadingPage, Pagination } from '../../components/common';
import { formatAmount, currencySymbol } from '../../utils/format';

const PAGE_SIZE = 30;

/** Map a payment_method value to an icon + translation key. */
function methodInfo(method) {
  if (method === 'mobility') return { icon: '🎫', key: 'payment.method_mobility' };
  if (method === 'manual')   return { icon: '💵', key: 'payment.method_manual'   };
  return                            { icon: '💳', key: 'payment.method_stripe'   };
}

/** Colored badge for payment status. */
function PaymentStatusBadge({ status }) {
  const { t } = useTranslation();
  const cfg = {
    paid:       'bg-green-100 dark:bg-green-900/40  text-green-700 dark:text-green-300',
    authorized: 'bg-blue-100 dark:bg-blue-900/40   text-blue-700 dark:text-blue-300',
    failed:     'bg-red-100 dark:bg-red-900/40    text-red-700 dark:text-red-300',
    refunded:   'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
    pending:    'bg-gray-100 dark:bg-gray-700   text-gray-500 dark:text-gray-400',
  };
  const classes = cfg[status] || cfg.pending;
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${classes}`}>
      {t(`payment.status_${status}`, { defaultValue: status })}
    </span>
  );
}

export default function PaymentHistory() {
  const { t, i18n } = useTranslation();
  const [payments, setPayments] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [page,     setPage]     = useState(1);
  const [total,    setTotal]    = useState(0);
  const [pages,    setPages]    = useState(1);

  useEffect(() => {
    setLoading(true);
    paymentService.list({ page, limit: PAGE_SIZE })
      .then(({ data }) => {
        setPayments(data.payments || []);
        setTotal(data.total   || 0);
        setPages(data.pages   || 1);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page]);

  function handlePageChange(p) {
    setPage(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(i18n.language === 'fr' ? 'fr-CA' : 'en-CA', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  return (
    <div className="space-y-5">
      <h1>{t('payment.history_title')}</h1>

      {loading ? (
        <LoadingPage />
      ) : payments.length === 0 ? (
        <div className="card text-center py-12 text-gray-400">
          <p className="text-4xl mb-3">💳</p>
          <p className="text-sm">{t('payment.no_payments')}</p>
        </div>
      ) : (
        <>
          {/* ── Payment table ────────────────────────────────── */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3">{t('payment.col_date')}</th>
                  <th className="text-left px-4 py-3 hidden sm:table-cell">{t('trips.trip_number_label', { defaultValue: 'Trip' })}</th>
                  <th className="text-left px-4 py-3 hidden sm:table-cell">{t('payment.col_trip')}</th>
                  <th className="text-right px-4 py-3">{t('payment.col_amount')}</th>
                  <th className="text-left px-4 py-3 hidden md:table-cell">{t('payment.col_method')}</th>
                  <th className="text-left px-4 py-3">{t('payment.col_status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {payments.map(p => {
                  const { icon, key } = methodInfo(p.payment_method);
                  return (
                    <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                      {/* Date */}
                      <td className="px-4 py-3 whitespace-nowrap text-gray-600 dark:text-gray-300">
                        {formatDate(p.paid_at || p.created_at)}
                      </td>

                      {/* Trip number badge */}
                      <td className="px-4 py-3 hidden sm:table-cell whitespace-nowrap">
                        <span className="text-xs font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
                          T-{p.trip_number}
                        </span>
                      </td>

                      {/* Trip route — truncated addresses */}
                      <td className="px-4 py-3 hidden sm:table-cell max-w-xs">
                        <div className="flex items-start gap-1.5 min-w-0">
                          <span className="text-green-500 text-xs mt-0.5 flex-shrink-0">●</span>
                          <p className="text-xs text-gray-700 dark:text-gray-200 truncate">{p.pickup_address}</p>
                        </div>
                        <div className="flex items-start gap-1.5 min-w-0 mt-0.5">
                          <span className="text-red-500 text-xs mt-0.5 flex-shrink-0">●</span>
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{p.dropoff_address}</p>
                        </div>
                      </td>

                      {/* Amount */}
                      <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-800 dark:text-gray-100">
                        {formatAmount(p.amount, i18n.language)} {currencySymbol(p.currency ?? 'CAD')}
                      </td>

                      {/* Method */}
                      <td className="px-4 py-3 hidden md:table-cell whitespace-nowrap text-gray-600 dark:text-gray-300">
                        {icon} {t(key)}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <PaymentStatusBadge status={p.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Pagination + summary ─────────────────────────── */}
          <Pagination page={page} pages={pages} onChange={handlePageChange} />
          <p className="text-xs text-gray-400 text-center">
            {t('payment.page_info', { page, pages, total })}
          </p>
        </>
      )}
    </div>
  );
}
