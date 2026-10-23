/**
 * @file pages/driver/Documents.jsx
 * @description Driver document upload page — /driver/documents
 *
 * Drivers must upload three document types before their profile can be approved:
 *   license       — driver's licence (front + back)
 *   insurance     — vehicle insurance certificate
 *   registration  — vehicle registration
 *
 * Each document type has two upload slots (slot 1 = front/recto, slot 2 = back/verso).
 * The admin can toggle which document types are required via the Configuration page
 * (required_doc_* keys); the driver's upload UI reflects those toggles.
 *
 * Upload rules:
 *   - Accepted formats: image (JPEG/PNG/WebP) or PDF.
 *   - Max file size: controlled by the max_document_size_mb configuration key.
 *   - Uploading to a slot that is already occupied requires a confirmation modal
 *     (shown by ConfirmModal) and deletes BOTH slots for that doc type before the
 *     new file is uploaded.  This is intentional — a partial replace (e.g. only the
 *     front page) would leave the admin with mismatched document versions.
 *   - Every upload, replacement, or deletion resets the driver's approval_status
 *     to 'pending' so the admin must re-review the complete updated set.
 *
 * Sub-components (all defined in this file):
 *   ConfirmModal — generic destructive-action confirmation dialog
 *   FileSlot     — one upload slot for a single document side; handles file picking,
 *                  inline preview (via a signed URL), upload progress, and deletion
 */
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { documentService } from '../../services/api';
import api from '../../services/api';
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

/**
 * ConfirmModal — generic destructive-action confirmation dialog.
 *
 * Props:
 *   open     — whether the modal is visible
 *   title    — heading text
 *   body     — description / warning text
 *   confirmLabel — label for the destructive confirm button
 *   onConfirm — callback when the user confirms
 *   onCancel  — callback when the user cancels or clicks outside
 */
function ConfirmModal({ open, title, body, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
         onClick={onCancel}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6"
           onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50 mb-2">{title}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-5">{body}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 transition-colors">
            {cancelLabel}
          </button>
          <button onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * FileSlot — one upload sub-slot within a document type.
 *
 * Props:
 *   docType    — 'license' | 'insurance' | 'registration'
 *   slot       — 1 or 2
 *   doc        — existing document object for this slot, or null
 *   hasAnyDoc  — true if ANY slot for this doc type already has a file
 *   docName    — human-readable doc type name (for the confirmation text)
 *   onUploaded — callback after a successful upload
 *   onDeleteAll — async callback that deletes all slots for this doc type
 */
function FileSlot({ docType, slot, doc, docName, disabledReason, onUploaded, onDeleteAll }) {
  const { t, i18n }   = useTranslation();
  const inputRef       = useRef(null);
  const [uploading,   setUploading]   = useState(false);
  const [viewing,     setViewing]     = useState(false);
  const [confirming,  setConfirming]  = useState(false);
  const [pendingFile, setPendingFile] = useState(null); // file chosen after confirm

  // Called when the user picks a file via the hidden input
  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (doc) {
      // This slot already has a file — warn before deleting both slots
      setPendingFile(file);
      setConfirming(true);
    } else {
      // Empty slot — upload directly, then inform about approval process
      await doUpload(file, true);
    }
  }

  // Called when the user confirms the replacement warning
  async function handleConfirm() {
    setConfirming(false);
    if (!pendingFile) return;
    try {
      await onDeleteAll();                  // delete all slots for this type
      await doUpload(pendingFile, false, 1); // always land on slot 1 after replace
    } catch {
      // onDeleteAll or doUpload already show toasts on errors
    } finally {
      setPendingFile(null);
    }
  }

  function handleCancel() {
    setConfirming(false);
    setPendingFile(null);
  }

  async function doUpload(file, isFirstUpload = false, targetSlot = slot) {
    setUploading(true);
    try {
      await documentService.upload(docType, targetSlot, file);
      if (isFirstUpload) {
        toast.success(t('docs.upload_approval_info'), { duration: 5000 });
      } else {
        toast.success(t('docs.upload_success'));
      }
      onUploaded();
    } catch (err) {
      const code  = err.response?.data?.code;
      const maxMb = err.response?.data?.max_mb;
      if (code === 'FILE_TOO_LARGE')     toast.error(t('docs.error_size', { max: maxMb }));
      else if (code === 'INVALID_FILE_TYPE') toast.error(t('docs.error_type'));
    } finally { setUploading(false); }
  }

  async function handleView() {
    setViewing(true);
    try {
      const { data } = await documentService.view(docType, slot);
      const url = URL.createObjectURL(new Blob([data], { type: doc.mime_type }));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { /* toast already fired by global interceptor */ } finally { setViewing(false); }
  }

  return (
    <>
      <ConfirmModal
        open={confirming}
        title={t('docs.replace_confirm_title')}
        body={t('docs.replace_confirm_body', { name: docName })}
        confirmLabel={t('docs.replace_confirm_btn')}
        cancelLabel={t('common.cancel')}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />

      <div className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg ${
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
            <p className="text-xs text-gray-400 mt-0.5">{t('docs.not_uploaded')}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {doc && (
            <button onClick={handleView} disabled={viewing}
              className="px-2.5 py-1 rounded-lg text-xs font-medium border bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 hover:bg-blue-100 disabled:opacity-50 transition-colors">
              {viewing ? '…' : t('docs.view_btn')}
            </button>
          )}
          <button
            onClick={() => !disabledReason && inputRef.current?.click()}
            disabled={uploading || disabledReason}
            title={disabledReason ? t('docs.slot2_requires_slot1') : undefined}
            className="px-2.5 py-1 rounded-lg text-xs font-medium border bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 border-teal-200 hover:bg-teal-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {uploading ? t('docs.uploading') : doc ? t('docs.replace_btn') : t('docs.upload_btn')}
          </button>
          <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png"
            className="hidden" onChange={handleFileChange} />
        </div>
      </div>
    </>
  );
}

/**
 * DocSlot — one card per document type, containing 2 FileSlot sub-components.
 * Owns the deleteAll logic so both slots share the same delete call.
 */
function DocSlot({ docType, docs, required, onUploaded }) {
  const { t } = useTranslation();
  const icons  = { license: '🪪', insurance: '📋', registration: '🚘' };

  const slot1   = docs.find(d => d.slot === 1) || null;
  const slot2   = docs.find(d => d.slot === 2) || null;
  const docName = t(`docs.${docType}`);

  async function handleDeleteAll() {
    await documentService.deleteType(docType);
    // Refresh list so slots show as empty before re-upload
    onUploaded();
  }

  return (
    <div className="card py-4">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="text-2xl">{icons[docType]}</span>
        <span className="font-medium text-sm text-gray-800 dark:text-gray-100">{docName}</span>
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
      <div className="space-y-2">
        <FileSlot docType={docType} slot={1} doc={slot1}
          docName={docName} onUploaded={onUploaded} onDeleteAll={handleDeleteAll} />
        <FileSlot docType={docType} slot={2} doc={slot2} disabledReason={!slot1}
          docName={docName} onUploaded={onUploaded} onDeleteAll={handleDeleteAll} />
      </div>
    </div>
  );
}

export default function Documents() {
  const { t } = useTranslation();
  const [docs,    setDocs]    = useState({});
  const [config,  setConfig]  = useState({});
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const [docsRes, cfgRes] = await Promise.all([
        documentService.list(),
        api.get('/admin/configuration/public'),
      ]);
      const docMap = {};
      (docsRes.data.documents || []).forEach(d => {
        if (!docMap[d.doc_type]) docMap[d.doc_type] = [];
        docMap[d.doc_type].push(d);
      });
      setDocs(docMap);
      const cfgMap = {};
      (cfgRes.data.configuration || []).forEach(c => { cfgMap[c.key] = c.value; });
      setConfig(cfgMap);
    } catch { /* best-effort load — ignore failure */ } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <LoadingPage />;

  return (
    <div>
      <div className="mb-6">
        <h1>{t('docs.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('docs.subtitle')}</p>
      </div>
      <div className="space-y-3">
        {DOC_TYPES.map(type => (
          <DocSlot
            key={type}
            docType={type}
            docs={docs[type] || []}
            required={config[`require_driver_${type}_doc`] === 'true'}
            onUploaded={load}
          />
        ))}
      </div>
    </div>
  );
}
