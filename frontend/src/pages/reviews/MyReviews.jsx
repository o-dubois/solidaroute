/**
 * MyReviews — /client/reviews  /driver/reviews  /admin/reviews (own reviews)
 *
 * Two tabs:
 *   Given    — reviews the current user submitted (all statuses shown,
 *               pending/rejected displayed with a subtle status badge)
 *   Received — approved reviews written about the current user,
 *               with an overall average at the top.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reviewService } from '../../services/api';
import { StarDisplay } from '../../components/common/StarDisplay';

export default function MyReviews() {
  const { t, i18n } = useTranslation();
  const [tab,      setTab]      = useState('given');
  const [given,    setGiven]    = useState([]);
  const [received, setReceived] = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    reviewService.mine()
      .then(({ data }) => {
        setGiven(data.given || []);
        setReceived(data.received || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(
      i18n.language === 'fr' ? 'fr-CA' : 'en-CA',
      { day: 'numeric', month: 'short', year: 'numeric' }
    );
  }

  const avgReceived = received.length
    ? (received.reduce((s, r) => s + r.rating, 0) / received.length).toFixed(1)
    : null;

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 text-sm py-16 justify-center">
      <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
      {t('common.loading')}
    </div>
  );

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6">{t('reviews.title')}</h1>

      {/* Tab bar */}
      <div className="flex gap-2 mb-6">
        {['given', 'received'].map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === k ? 'bg-teal-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200'
            }`}>
            {t(`reviews.tab_${k}`)}
            {k === 'given'    && given.length    > 0 && (
              <span className="ml-1.5 text-xs opacity-75">({given.length})</span>
            )}
            {k === 'received' && received.length > 0 && (
              <span className="ml-1.5 text-xs opacity-75">({received.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Given tab */}
      {tab === 'given' && (
        given.length === 0
          ? <EmptyState icon="✍️" text={t('reviews.no_given')} />
          : (
            <div className="space-y-3">
              {given.map(r => (
                <div key={r.id} className="card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-xs font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
                          T-{r.trip_number}
                        </span>
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                          {r.reviewee_first} {r.reviewee_last}
                        </span>
                        <StatusPill status={r.status} t={t} />
                      </div>
                      <StarDisplay rating={r.rating} />
                      {r.comment && (
                        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 italic">"{r.comment}"</p>
                      )}
                    </div>
                    <span className="text-xs text-gray-400 flex-shrink-0">{formatDate(r.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )
      )}

      {/* Received tab */}
      {tab === 'received' && (
        received.length === 0
          ? <EmptyState icon="⭐" text={t('reviews.no_received')} />
          : (
            <>
              {/* Average banner */}
              <div className="card bg-teal-50 dark:bg-teal-900/30 border-teal-200 border mb-4 flex items-center gap-4">
                <div className="text-3xl font-bold text-teal-700 dark:text-teal-300">{avgReceived}</div>
                <div>
                  <StarDisplay rating={parseFloat(avgReceived)} />
                  <p className="text-xs text-teal-600 dark:text-teal-400 mt-0.5">
                    {received.length} {t('reviews.reviews_count')}
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {received.map(r => (
                  <div key={r.id} className="card">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
                            T-{r.trip_number}
                          </span>
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                            {r.reviewer_first} {r.reviewer_last}
                          </span>
                        </div>
                        <StarDisplay rating={r.rating} />
                        {r.comment && (
                          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 italic">"{r.comment}"</p>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0">{formatDate(r.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )
      )}
    </div>
  );
}

function EmptyState({ icon, text }) {
  return (
    <div className="text-center py-14 text-gray-400">
      <div className="text-4xl mb-3">{icon}</div>
      <p className="text-sm">{text}</p>
    </div>
  );
}

function StatusPill({ status, t }) {
  if (status === 'approved') return null; // no pill needed
  const styles = {
    pending:  'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200',
    rejected: 'bg-red-50 dark:bg-red-900/30 text-red-400 border border-red-100 dark:border-red-800',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status] || ''}`}>
      {t(`reviews.status_${status}`)}
    </span>
  );
}
