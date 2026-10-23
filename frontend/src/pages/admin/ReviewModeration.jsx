/**
 * ReviewModeration — /admin/reviews
 *
 * Moderation queue for pending reviews.
 * Operators see client ↔ driver reviews.
 * Superadmin sees all (including operator ↔ client reviews).
 *
 * Actions: Approve (green) / Reject (red, silent — kept in DB with rejected status)
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reviewService } from '../../services/api';
import { StarDisplay } from '../../components/common/StarDisplay';
import toast from 'react-hot-toast';

export default function ReviewModeration() {
  const { t, i18n } = useTranslation();
  const [reviews,   setReviews]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [acting,    setActing]    = useState(null); // id currently being processed

  function load() {
    setLoading(true);
    reviewService.pending()
      .then(({ data }) => setReviews(data.reviews || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function handleAction(id, action) {
    setActing(id);
    try {
      if (action === 'approve') await reviewService.approve(id);
      else                      await reviewService.reject(id);
      toast.success(action === 'approve'
        ? t('reviews.mod_approved')
        : t('reviews.mod_rejected'));
      setReviews(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      toast.error(err.response?.data?.error || t('common.error'));
    } finally {
      setActing(null);
    }
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(
      i18n.language === 'fr' ? 'fr-CA' : 'en-CA',
      { day: 'numeric', month: 'short', year: 'numeric' }
    );
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1>{t('reviews.mod_title')}</h1>
        {!loading && (
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {reviews.length} {t('reviews.mod_pending_count')}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm py-16 justify-center">
          <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : reviews.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">✅</div>
          <p className="text-sm">{t('reviews.mod_empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map(r => (
            <div key={r.id} className="card">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  {/* Trip + parties */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-xs font-mono font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
                      T-{r.trip_number}
                    </span>
                    <span className="text-sm text-gray-700 dark:text-gray-200">
                      <span className="font-medium">{r.reviewer_first} {r.reviewer_last}</span>
                      <span className="text-gray-400 mx-1">→</span>
                      <span className="font-medium">{r.reviewee_first} {r.reviewee_last}</span>
                    </span>
                    <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                      {t(`roles.${r.reviewer_role}`, { defaultValue: r.reviewer_role })}
                      {' → '}
                      {t(`roles.${r.reviewee_role}`, { defaultValue: r.reviewee_role })}
                    </span>
                  </div>

                  {/* Stars + comment */}
                  <StarDisplay rating={r.rating} />
                  {r.comment
                    ? <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 italic">"{r.comment}"</p>
                    : <p className="text-xs text-gray-400 mt-1">{t('reviews.no_comment')}</p>
                  }
                  <p className="text-xs text-gray-400 mt-1">{formatDate(r.created_at)}</p>
                </div>

                {/* Action buttons */}
                <div className="flex flex-col gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleAction(r.id, 'approve')}
                    disabled={acting === r.id}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-teal-600
                               text-white hover:bg-teal-700 transition-colors disabled:opacity-50">
                    ✓ {t('reviews.mod_approve')}
                  </button>
                  <button
                    onClick={() => handleAction(r.id, 'reject')}
                    disabled={acting === r.id}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-50 dark:bg-red-900/30
                               text-red-600 border border-red-200 hover:bg-red-100
                               transition-colors disabled:opacity-50">
                    ✕ {t('reviews.mod_reject')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
