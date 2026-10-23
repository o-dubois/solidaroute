/**
 * @file components/driver/ProfileCompletenessModal.jsx
 * @description Modal shown to incomplete drivers once per login session.
 *
 * Lists every missing required field with a short human-readable label and an
 * icon, then directs the driver to the Profile or Documents page to fix them.
 *
 * Session behaviour:
 *   The parent (driver Dashboard) only shows this modal when the driver's
 *   approval_status is 'incomplete' AND the sessionStorage flag
 *   'sr_completeness_shown' is not set.  Once the modal is dismissed or
 *   closed, the flag is set and the modal will not reappear until the driver
 *   logs out and logs back in.
 *
 * Props:
 *   missing  {string[]}  Array of field identifier strings from GET /api/profile/completeness
 *   onClose  {Function}  Called when the driver dismisses the modal
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// Maps each field identifier returned by the completeness API to a human-readable
// label key and an icon.  doc_* entries cover required document types.
const FIELD_META = {
  first_name:       { icon: '👤', key: 'profile.missing_first_name' },
  last_name:        { icon: '👤', key: 'profile.missing_last_name' },
  phone:            { icon: '📞', key: 'profile.missing_phone' },
  vehicle_make:     { icon: '🚗', key: 'profile.missing_vehicle_make' },
  vehicle_model:    { icon: '🚗', key: 'profile.missing_vehicle_model' },
  vehicle_year:     { icon: '📅', key: 'profile.missing_vehicle_year' },
  vehicle_color:    { icon: '🎨', key: 'profile.missing_vehicle_color' },
  license_plate:    { icon: '🪪', key: 'profile.missing_license_plate' },
  home_address:     { icon: '🏠', key: 'profile.missing_home_address' },
  doc_license:      { icon: '📄', key: 'profile.missing_doc_license' },
  doc_insurance:    { icon: '📄', key: 'profile.missing_doc_insurance' },
  doc_registration: { icon: '📄', key: 'profile.missing_doc_registration' },
};

// Which missing fields should direct the driver to the Documents page.
const DOC_FIELDS = new Set(['doc_license', 'doc_insurance', 'doc_registration']);

export default function ProfileCompletenessModal({ missing, onClose }) {
  const { t } = useTranslation();

  // Determine whether to show the "Go to Documents" link at all.
  const hasDocItems    = missing.some(f => DOC_FIELDS.has(f));
  const hasProfileItems = missing.some(f => !DOC_FIELDS.has(f));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-gray-100 dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50">
              {t('profile.completeness_modal_title')}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t('profile.completeness_modal_subtitle')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl ml-4 px-1 flex-shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Missing items list */}
        <ul className="px-6 py-4 space-y-2 max-h-64 overflow-y-auto">
          {missing.map(field => {
            const meta = FIELD_META[field];
            if (!meta) return null;
            return (
              <li key={field} className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-200">
                <span className="text-base w-6 text-center flex-shrink-0">{meta.icon}</span>
                <span className="text-red-600 font-medium mr-1">*</span>
                {t(meta.key)}
              </li>
            );
          })}
        </ul>

        {/* Action buttons */}
        <div className="px-6 pb-6 pt-2 flex flex-col gap-2">
          {hasProfileItems && (
            <Link
              to="/driver/profile"
              onClick={onClose}
              className="btn-primary text-center text-sm"
            >
              {t('profile.go_to_profile')}
            </Link>
          )}
          {hasDocItems && (
            <Link
              to="/driver/documents"
              onClick={onClose}
              className="btn-secondary text-center text-sm"
            >
              {t('profile.go_to_documents')}
            </Link>
          )}
          <button
            onClick={onClose}
            className="text-xs text-gray-400 hover:text-gray-600 text-center py-1"
          >
            {t('common.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
