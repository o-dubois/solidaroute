/**
 * @file pages/admin/DriverDocuments.jsx
 * @description Admin document review page for a specific driver — /admin/drivers/:id/documents
 *
 * Allows operators and superadmins to review all files uploaded by a driver:
 *   license       — driver's licence (front + back)
 *   insurance     — vehicle insurance certificate
 *   registration  — vehicle registration
 *
 * Each document type may have up to two files (slot 1 = front, slot 2 = back).
 * Files are rendered as inline previews (images) or download links (PDFs) using
 * signed URLs from GET /api/admin/drivers/:id/documents/:docType/:slot.
 *
 * This page is READ-ONLY for admins — uploading and deleting documents is the
 * driver's responsibility via /driver/documents.  Approval / rejection of the
 * driver's overall profile happens on the DriverManagement page.
 *
 * A "Back to driver" link is shown at the top so the admin can return to the
 * driver detail panel in the management list without losing their place.
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { adminService } from '../../services/api';
import { LoadingPage } from '../../components/common';

const DOC_TYPES = ['license', 'insurance', 'registration'];

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso, lang) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-CA', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

export default function DriverDocuments() {
  const { id }        = useParams();
  const navigate      = useNavigate();
  const { t, i18n }  = useTranslation();
  const [docs,    setDocs]    = useState({});   // { license: [slot1, slot2?], ... }
  const [driver,  setDriver]  = useState(null);
  const [config,  setConfig]  = useState({});
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState(null); // '{type}_{slot}' while loading

  useEffect(() => {
    Promise.all([
      adminService.driverDocuments(id),
      adminService.driverDetail(id),
      adminService.getConfig(),
    ]).then(([docsRes, driverRes, cfgRes]) => {
      // Group by doc_type
      const docMap = {};
      (docsRes.data.documents || []).forEach(d => {
        if (!docMap[d.doc_type]) docMap[d.doc_type] = [];
        docMap[d.doc_type].push(d);
      });
      setDocs(docMap);
      setDriver(driverRes.data.driver);
      const cfgMap = {};
      (cfgRes.data.configuration || []).forEach(c => { cfgMap[c.key] = c.value; });
      setConfig(cfgMap);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [id]);

  async function handleView(docType, slot, mimeType) {
    const key = `${docType}_${slot}`;
    setViewing(key);
    try {
      const { data } = await adminService.driverDocView(id, docType, slot);
      const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { /* toast already fired by global interceptor */ } finally { setViewing(null); }
  }

  if (loading) return <LoadingPage />;

  const icons = { license: '🪪', insurance: '📋', registration: '🚘' };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/admin/drivers')}
          className="text-gray-400 hover:text-gray-600 text-sm">
          ← {t('trips.back')}
        </button>
        <div>
          <h1>{t('docs.admin_title')}</h1>
          {driver && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {driver.first_name} {driver.last_name} · {driver.email}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {DOC_TYPES.map(type => {
          const typeDocs = docs[type] || [];
          const slot1    = typeDocs.find(d => d.slot === 1) || null;
          const slot2    = typeDocs.find(d => d.slot === 2) || null;
          const required = config[`require_driver_${type}_doc`] === 'true';
          return (
            <div key={type} className="card py-4">
              {/* Header */}
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <span className="text-2xl">{icons[type]}</span>
                <span className="font-medium text-sm text-gray-800 dark:text-gray-100">{t(`docs.${type}`)}</span>
                {required ? (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-medium">
                    {t('docs.required')}
                  </span>
                ) : (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                    {t('docs.optional')}
                  </span>
                )}
              </div>
              {/* Two slots */}
              <div className="space-y-2">
                {[{ slot: 1, doc: slot1 }, { slot: 2, doc: slot2 }].map(({ slot, doc }) => (
                  <div key={slot} className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg ${
                    slot === 2
                      ? 'bg-gray-50 dark:bg-gray-700/50 border border-dashed border-gray-200 dark:border-gray-700'
                      : 'bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700'
                  }`}>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                        {slot === 1 ? t('docs.slot_1') : t('docs.slot_2')}
                      </p>
                      {doc ? (
                        <p className="text-xs text-teal-600 dark:text-teal-400 mt-0.5">
                          ✅ {t('docs.uploaded_on', { date: formatDate(doc.uploaded_at, i18n.language) })}
                          {doc.file_size && <span className="text-gray-400 ml-1">· {formatBytes(doc.file_size)}</span>}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {required && slot === 1 ? `⚠️ ${t('docs.not_uploaded')}` : t('docs.not_uploaded')}
                        </p>
                      )}
                    </div>
                    {doc && (
                      <button
                        onClick={() => handleView(type, slot, doc.mime_type)}
                        disabled={viewing === `${type}_${slot}`}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium border bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 hover:bg-blue-100 disabled:opacity-50 transition-colors flex-shrink-0">
                        {viewing === `${type}_${slot}` ? '…' : t('docs.view_btn')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
