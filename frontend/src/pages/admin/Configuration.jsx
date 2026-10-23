/**
 * Configuration Page  —  /admin/configuration
 *
 * Superadmin-only panel for managing all application-wide settings stored
 * in the `configuration` database table. Each row in that table is a
 * key/value pair; this page renders them grouped by category and provides
 * inline editing controls appropriate for each data type.
 *
 * Groups (rendered in the order defined by GROUP_ORDER):
 *   General   — app name, contact email, session timeout, phone country, timezone, retention
 *   Language  — frontend_language (fr | en | both)
 *   Pricing   — base fare, per-km rate, extra passenger fee, driver share, currency
 *   Trips     — lead time, max advance days, return delay, safeguard hours,
 *               driver radius, driver selection required, geocoding region
 *   Drivers   — required document toggles, max upload size
 *   Security  — password policy (min length, uppercase, lowercase, number, special)
 *
 * Control types (auto-selected based on the META object's `type` field):
 *   'bool'     — Toggle switch with Enabled/Disabled label + confirm button
 *   'number'   — Numeric input with unit label, min/max constraints from META
 *   'language' — Dropdown with the three language options (fr / en / both)
 *   'timezone' — Grouped dropdown of IANA timezone identifiers
 *   'country'  — Full country picker using react-phone-number-input's country list
 *   'currency' — Dropdown of supported currencies
 *   'region'   — Dropdown of geocoding regions used by the address lookup service
 *   'text'     — Plain text input (fallback for any unrecognised type)
 *
 * Edit model:
 *   All settings use an optimistic "edit in place" pattern.
 *   Clicking "Modify" copies the current DB value into the `editing` map
 *   keyed by the config key. The control then reads from `editing` while in
 *   edit mode. Saving calls adminService.updateConfig, which PATCHes the
 *   row server-side. On success the local `config` array is updated in-place.
 *   On failure the `editing` entry is discarded so the UI reverts to the
 *   last confirmed DB value.
 *
 * Side-effects on save:
 *   - frontend_language  → calls refreshConfig() so the LanguageContext
 *     propagates the new locale without a full page reload.
 *   - default_phone_country → also calls refreshConfig() so phone inputs
 *     across the app pick up the new default flag immediately.
 *   - password_* keys → server-side password.js service cache is
 *     invalidated automatically when any password_ key is updated.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminService } from '../../services/api';
import { LoadingPage } from '../../components/common';
import { useLanguage } from '../../context/LanguageContext';
import toast from 'react-hot-toast';
import { getCountries } from 'react-phone-number-input';
import countryNames from 'react-phone-number-input/locale/en.json';

/**
 * META — display metadata for every known configuration key.
 *
 * Each entry maps a config key (as stored in the DB) to:
 *   group  — which section of the UI it belongs to
 *   type   — which control component to render (see file-level JSDoc)
 *   icon   — emoji shown to the left of the label row
 *   unit   — optional unit suffix shown alongside numeric values (e.g. 'km', 'min')
 *   min    — minimum allowed value for number controls (null = no constraint)
 *   max    — maximum allowed value for number controls (null = no constraint)
 *
 * Keys not present in META will still render (grouped as 'other') but will
 * fall through to the TextCtrl default control.
 */
const META = {
  app_name:                     { group: 'general',  type: 'text',   icon: '🏷️',  unit: null,    min: null, max: null },
  contact_email:                { group: 'general',  type: 'text',   icon: '📧',  unit: null,    min: null, max: null },
  admin_deletion_retention_days:{ group: 'general',  type: 'number', icon: '🗑️',  unit: 'days',  min: 0,    max: 365  },
  app_timezone:                 { group: 'general',  type: 'timezone', icon: '🕐', unit: null,    min: null, max: null },
  session_timeout_minutes:      { group: 'general',  type: 'number', icon: '⏰', unit: 'min',   min: 0,    max: 480  },
  default_phone_country:        { group: 'general',  type: 'country',icon: '📱', unit: null,    min: null, max: null },
  frontend_language:            { group: 'language', type: 'language',icon: '🌐', unit: null,    min: null, max: null },
  max_return_delay_minutes:     { group: 'trips',    type: 'number', icon: '⏱️',  unit: 'min',   min: 30,   max: 1440 },
  safeguard_delay_hours:        { group: 'trips',    type: 'number', icon: '🛡️',  unit: 'h',     min: 1,    max: 168  },
  preferred_driver_response_hours: { group: 'trips', type: 'number', icon: '⏳',  unit: 'h',     min: 1,    max: 48   },
  broadcast_cutoff_hours:          { group: 'trips', type: 'number', icon: '🔔',  unit: 'h',     min: 6,    max: 168  },
  reminder_hours_before:           { group: 'trips', type: 'number', icon: '⏰',  unit: 'h',     min: 0,    max: 48   },
  min_trip_lead_hours:          { group: 'trips',    type: 'number', icon: '📆',  unit: 'h',     min: 0,    max: 168  },
  max_trip_advance_days:        { group: 'trips',    type: 'number', icon: '📅',  unit: 'days',  min: 1,    max: 365  },
  driver_suggestion_radius_km:  { group: 'trips',    type: 'number', icon: '🔍',  unit: 'km',    min: 1,    max: 100  },
  driver_selection_required:    { group: 'trips',    type: 'bool',   icon: '🚗',  unit: null,    min: null, max: null },
  geocoding_region:             { group: 'trips',    type: 'region', icon: '🗺️',  unit: null,    min: null, max: null },
  trip_overlap_buffer_minutes:  { group: 'trips',    type: 'number', icon: '⚠️',  unit: 'min',   min: 30,   max: 1440 },
  require_driver_license_doc:              { group: 'drivers', type: 'bool',   icon: '🪪',  unit: null,  min: null, max: null },
  require_driver_insurance_doc:            { group: 'drivers', type: 'bool',   icon: '📋',  unit: null,  min: null, max: null },
  require_driver_vehicle_registration_doc: { group: 'drivers', type: 'bool',   icon: '🚘',  unit: null,  min: null, max: null },
  max_document_size_mb:                    { group: 'drivers', type: 'number', icon: '📦',  unit: 'MB',  min: 1,    max: 20   },
  max_login_attempts:           { group: 'security', type: 'number', icon: '🔒',  unit: null,    min: 1,    max: 20   },
  password_min_length:          { group: 'security', type: 'number', icon: '📏',  unit: 'chars', min: 6,    max: 128  },
  password_require_uppercase:   { group: 'security', type: 'bool',   icon: 'Aa',  unit: null,    min: null, max: null },
  password_require_lowercase:   { group: 'security', type: 'bool',   icon: 'aa',  unit: null,    min: null, max: null },
  password_require_number:      { group: 'security', type: 'bool',   icon: '🔢',  unit: null,    min: null, max: null },
  password_require_special:     { group: 'security', type: 'bool',   icon: '✳️',  unit: null,    min: null, max: null },
  base_fare:                    { group: 'pricing',  type: 'number', icon: '💵',  unit: null,    min: 0,    max: 50   },
  price_per_km:                 { group: 'pricing',  type: 'number', icon: '🛣️',  unit: null,    min: 0,    max: 10   },
  extra_passenger_fee:          { group: 'pricing',  type: 'number', icon: '👥',  unit: null,    min: 0,    max: 10   },
  driver_share_percent:         { group: 'pricing',  type: 'number', icon: '🤝',  unit: '%',     min: 0,    max: 100  },
  payment_currency:             { group: 'pricing',  type: 'currency',icon: '💱', unit: null,    min: null, max: null },
  payment_provider:             { group: 'pricing',  type: 'select', icon: '💳', unit: null,    min: null, max: null, options: ['stripe', 'manual', 'mobility', 'paypal'] },
  stripe_publishable_key:       { group: 'pricing',  type: 'text',   icon: '🔑', unit: null,    min: null, max: null },
  payment_max_retries:          { group: 'pricing',  type: 'number', icon: '🔄', unit: null,    min: 0,    max: 10   },
  card_charge_delay_days:        { group: 'pricing',  type: 'number', icon: '⏳', unit: 'days',  min: 0,    max: 90   },
  ticket_use_delay_days:        { group: 'tickets',  type: 'number', icon: '⏳', unit: 'days',  min: 0,    max: 90   },
  ticket_payout_delay_days:     { group: 'tickets',  type: 'number', icon: '💸', unit: 'days',  min: 0,    max: 365  },
};

/**
 * GROUP_ORDER defines the visual rendering order of the setting groups.
 * Any group not listed here will be appended at the end in arbitrary order,
 * so add new groups here to control their position in the UI.
 */
const GROUP_ORDER = ['general', 'language', 'pricing', 'trips', 'drivers', 'security', 'tickets'];

/**
 * Configuration
 *
 * Main page component. Fetches all rows from the `configuration` table on
 * mount, then groups them by their META entry and renders each group as a
 * labelled section. Within each section, every setting row renders the
 * appropriate inline control (bool toggle, number input, dropdown, etc.).
 *
 * State:
 *   config  — flat array of { key, value } objects fetched from the API
 *   loading — true while the initial fetch is in flight
 *   error   — true if the fetch fails (superadmin guard on the server will
 *              return 403 for non-superadmin roles, which lands here)
 *   editing — map of { configKey: pendingValue } for settings currently
 *              being edited; absence from this map means "view mode"
 *   saving  — the key currently being persisted to the API, or null;
 *              used to disable the save button and show a spinner
 */
export default function Configuration() {
  const { t } = useTranslation();
  const { refreshConfig } = useLanguage();
  const [config, setConfig]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(false);
  // editing holds in-progress values keyed by config key; only keys
  // currently being modified are present (view-mode keys are absent)
  const [editing, setEditing]   = useState({});
  // saving holds the single config key whose PUT request is in flight
  const [saving, setSaving]     = useState(null);

  // Fetch all configuration rows once on mount
  useEffect(() => {
    adminService.getConfig()
      .then(({ data }) => setConfig(data.configuration))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  /**
   * save — persist a single setting to the server.
   *
   * All config values are stored as strings in the DB, so the pending value
   * is coerced via String() before sending. On success the local config
   * array is updated in-place (no full refetch needed). On failure the
   * editing entry is removed so the UI snaps back to the last known DB value.
   *
   * Language and phone-country changes additionally trigger a refreshConfig()
   * so other parts of the UI update immediately without a page reload.
   *
   * @param {string} key - the configuration key to save
   */
  async function save(key) {
    setSaving(key);
    try {
      const { data } = await adminService.updateConfig(key, String(editing[key]));
      // Replace just this entry in the config array with the server's response
      setConfig(prev => prev.map(c => c.key === key ? data.setting : c));
      // Exit edit mode for this key
      setEditing(prev => { const n = { ...prev }; delete n[key]; return n; });
      // Propagate locale/phone-country changes to the rest of the app immediately
      if (key === 'default_phone_country' || key === 'frontend_language') refreshConfig();
      toast.success(t('common.success'));
    } catch (err) {
      const msg = err.response?.data?.error || t('common.error');
      toast.error(msg);
      // Revert displayed value to what's actually in the DB
      setEditing(prev => { const n = { ...prev }; delete n[key]; return n; });
    } finally { setSaving(null); }
  }

  /**
   * cancel — discard the pending edit for a setting and return to view mode.
   * @param {string} key - the configuration key to cancel editing
   */
  function cancel(key) {
    setEditing(prev => { const n = { ...prev }; delete n[key]; return n; });
  }

  // Show full-page spinner while the initial config load is in progress
  if (loading) return <LoadingPage />;

  // Show an access-denied placeholder if the fetch fails.
  // This typically means the user lacks superadmin privileges — the server
  // returns a 403 which the service layer converts into a rejected promise.
  if (error) return (
    <div className="card text-center py-12 text-gray-400">
      <div className="text-4xl mb-3">🔒</div>
      <p className="text-sm font-medium text-gray-600 dark:text-gray-300">{t('admin.config_title')}</p>
      <p className="text-xs mt-1">{t('admin.config_subtitle')}</p>
    </div>
  );

  // ── Group the flat config array by the META group field ──────────────────
  // Keys not in META fall into a catch-all 'other' group rendered at the end.
  // Keys in HIDDEN_KEYS are managed elsewhere and must not appear here.
  const HIDDEN_KEYS = new Set(['mobility_ticket_facial_value', 'mobility_ticket_currency']);
  const groups = {};
  config.forEach(p => {
    if (HIDDEN_KEYS.has(p.key)) return;
    const g = META[p.key]?.group ?? 'other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(p);
  });
  // Render groups in the defined order, then append any unknown groups
  const orderedGroups = [
    ...GROUP_ORDER.filter(g => groups[g]),
    ...Object.keys(groups).filter(g => !GROUP_ORDER.includes(g)),
  ];

  // Translated section headers — keyed by group name
  const groupLabels = {
    general:  t('admin.config_group_general'),
    language: t('admin.config_group_language'),
    pricing:  t('admin.config_group_pricing'),
    trips:    t('admin.config_group_trips'),
    drivers:  t('admin.config_group_drivers'),
    security: t('admin.config_group_security'),
    tickets:  t('admin.config_group_tickets'),
  };

  return (
    <div>
      <div className="mb-6">
        <h1>{t('admin.config_title')}</h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">{t('admin.config_subtitle')}</p>
      </div>

      {/* Warning banner — reminds admins that changes take effect immediately */}
      <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-100 dark:border-amber-800 rounded-lg p-4 mb-6 text-sm text-amber-800 dark:text-amber-200">
        {t('admin.config_warning')}
      </div>

      <div className="space-y-8">
        {orderedGroups.map(groupKey => (
          <div key={groupKey}>
            {/* Group heading — uppercase, small caps style */}
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
              {groupLabels[groupKey] ?? groupKey}
            </h2>
            <div className="space-y-2">
              {groups[groupKey].map(param => {
                const meta     = META[param.key];
                // inEdit is true when this key has a pending value in the editing map
                const inEdit   = editing[param.key] !== undefined;
                // Show the pending edit value while editing, otherwise the DB value
                const curVal   = inEdit ? editing[param.key] : param.value;
                // Fall back to the raw key if no i18n translation exists
                const label    = t(`config_keys.${param.key}`, { defaultValue: param.key });

                return (
                  <div key={param.key} className="card flex items-center justify-between gap-4 py-3">
                    {/* Left side: icon + label + optional description */}
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      {meta?.icon && (
                        <span className="text-lg flex-shrink-0 w-7 text-center">{meta.icon}</span>
                      )}
                      <div className="min-w-0">
                        <div className="font-medium text-sm text-gray-800 dark:text-gray-100">{label}</div>
                        {t(`config_desc.${param.key}`, { defaultValue: '' }) && (
                          <p className="text-xs text-gray-400 mt-0.5 truncate">
                            {t(`config_desc.${param.key}`, { defaultValue: '' })}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Right side: the appropriate inline control based on META type */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {meta?.type === 'bool' ? (
                        // Boolean settings render a toggle switch; clicking the toggle
                        // immediately enters edit mode and flips the value, then the
                        // operator must click the confirm (✓) button to persist.
                        <BoolToggle
                          value={inEdit ? curVal : param.value}
                          inEdit={inEdit}
                          saving={saving === param.key}
                          onChange={v => setEditing(p => ({ ...p, [param.key]: v }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      ) : meta?.type === 'language' ? (
                        // Language selector — three-option dropdown (fr / en / both)
                        <LangSelect
                          value={curVal}
                          inEdit={inEdit}
                          saving={saving === param.key}
                          onChange={v => inEdit
                            ? setEditing(p => ({ ...p, [param.key]: v }))
                            : setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onEdit={() => setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      ) : meta?.type === 'number' ? (
                        // Numeric input with unit label and optional min/max bounds
                        <NumberCtrl
                          value={curVal} unit={meta.unit} min={meta.min} max={meta.max}
                          inEdit={inEdit} saving={saving === param.key}
                          onChange={v => inEdit
                            ? setEditing(p => ({ ...p, [param.key]: v }))
                            : setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onEdit={() => setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      ) : meta?.type === 'country' ? (
                        // Country picker — full sorted list from react-phone-number-input
                        <CountryPicker
                          value={curVal}
                          inEdit={inEdit}
                          saving={saving === param.key}
                          onChange={v => inEdit
                            ? setEditing(p => ({ ...p, [param.key]: v }))
                            : setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onEdit={() => setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      ) : meta?.type === 'timezone' ? (
                        // Timezone selector — grouped by continent/region
                        <TimezoneSelect
                          value={curVal}
                          inEdit={inEdit}
                          saving={saving === param.key}
                          onChange={v => inEdit
                            ? setEditing(p => ({ ...p, [param.key]: v }))
                            : setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onEdit={() => setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      ) : meta?.type === 'currency' ? (
                        // Currency selector — curated list of supported currencies
                        <CurrencySelect
                          value={curVal}
                          inEdit={inEdit}
                          saving={saving === param.key}
                          onChange={v => setEditing(p => ({ ...p, [param.key]: v }))}
                          onEdit={() => setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      ) : meta?.type === 'region' ? (
                        // Region selector — controls which geographic region the
                        // server-side geocoding service biases results toward
                        <RegionSelect
                          value={curVal}
                          inEdit={inEdit}
                          saving={saving === param.key}
                          onChange={v => setEditing(p => ({ ...p, [param.key]: v }))}
                          onEdit={() => setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      ) : meta?.type === 'select' ? (
                        // Generic select dropdown — options list comes from META
                        <SelectCtrl
                          value={curVal}
                          options={meta.options || []}
                          inEdit={inEdit}
                          saving={saving === param.key}
                          onChange={v => inEdit
                            ? setEditing(p => ({ ...p, [param.key]: v }))
                            : setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onEdit={() => setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      ) : (
                        // Fallback plain text input for any unrecognised type
                        <TextCtrl
                          value={curVal} inEdit={inEdit} saving={saving === param.key}
                          onChange={v => inEdit
                            ? setEditing(p => ({ ...p, [param.key]: v }))
                            : setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onEdit={() => setEditing(p => ({ ...p, [param.key]: param.value }))}
                          onSave={() => save(param.key)}
                          onCancel={() => cancel(param.key)}
                          t={t}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * TIMEZONES — curated list of IANA timezone identifiers grouped by continent.
 *
 * This list intentionally covers the primary deployment regions (Canada,
 * Western Europe) rather than providing all ~600 IANA zones. Each entry uses
 * a human-readable label that includes the UTC offset so operators can
 * identify the correct zone at a glance without memorising IANA names.
 *
 * To add a new timezone: insert a { value, label } object in the appropriate
 * group array, or create a new group object with a `group` string and `zones`.
 */
const TIMEZONES = [
  { group: '🌎 Amériques', zones: [
    { value: 'America/St_Johns',  label: 'Terre-Neuve (UTC−3:30)'              },
    { value: 'America/Halifax',   label: 'Atlantique (UTC−4)'                  },
    { value: 'America/Toronto',   label: 'Est — Québec, Ontario (UTC−5)'       },
    { value: 'America/Winnipeg',  label: 'Centre — Manitoba (UTC−6)'           },
    { value: 'America/Edmonton',  label: 'Rocheuses — Alberta (UTC−7)'         },
    { value: 'America/Vancouver', label: 'Pacifique — C.-B. (UTC−8)'           },
  ]},
  { group: '🌍 Europe', zones: [
    { value: 'Atlantic/Azores',   label: 'Açores (UTC−1)'                      },
    { value: 'Europe/Lisbon',     label: 'Lisbonne — WET (UTC+0)'              },
    { value: 'Europe/London',     label: 'Londres — GMT/BST (UTC+0/+1)'        },
    { value: 'Europe/Paris',      label: 'Paris, Bruxelles, Genève — CET (UTC+1)' },
    { value: 'Europe/Berlin',     label: 'Berlin, Amsterdam, Rome — CET (UTC+1)'  },
    { value: 'Europe/Madrid',     label: 'Madrid — CET (UTC+1)'                },
    { value: 'Europe/Helsinki',   label: 'Helsinki, Riga — EET (UTC+2)'        },
    { value: 'Europe/Moscow',     label: 'Moscou — MSK (UTC+3)'                },
  ]},
];

/**
 * TimezoneSelect
 *
 * Renders either a read-only label badge + Modify button (view mode) or a
 * grouped <select> dropdown + Save/Cancel buttons (edit mode).
 *
 * The flat zone list is derived once by flattening TIMEZONES so we can look
 * up the human label for the currently stored IANA value.
 */
function TimezoneSelect({ value, inEdit, saving, onChange, onEdit, onSave, onCancel, t }) {
  // Flatten the grouped list to quickly find the label for the stored IANA key
  const allZones   = TIMEZONES.flatMap(g => g.zones);
  const currentLabel = allZones.find(z => z.value === value)?.label ?? value;
  if (!inEdit) return (
    <>
      <span className="text-sm font-semibold bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded-lg max-w-[220px] truncate"
        title={currentLabel}>
        🕐 {currentLabel}
      </span>
      <button onClick={onEdit} className="btn-secondary text-xs py-1.5 px-3">{t('admin.modify')}</button>
    </>
  );
  return (
    <>
      <select className="input text-sm w-64" value={value}
        onChange={e => onChange(e.target.value)} autoFocus>
        {TIMEZONES.map(group => (
          // Use <optgroup> so the dropdown clearly separates continents
          <optgroup key={group.group} label={group.group}>
            {group.zones.map(z => (
              <option key={z.value} value={z.value}>{z.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1.5 px-3">{saving ? '…' : t('admin.save')}</button>
      <button onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('admin.cancel')}</button>
    </>
  );
}


/**
 * BoolToggle
 *
 * A toggle switch control for boolean configuration settings.
 *
 * Unlike other controls, BoolToggle does NOT have a separate "Modify" button.
 * Clicking the toggle itself immediately flips the value AND enters edit mode
 * in one action. The confirm (✓) and cancel (✕) buttons then appear inline,
 * giving the operator a chance to review before committing.
 *
 * The value prop may arrive as the string 'true'/'false' (from the DB) or
 * as a real boolean — both are handled by the `active` check below.
 */
function BoolToggle({ value, inEdit, saving, onChange, onSave, onCancel, t }) {
  // DB stores booleans as the string 'true' or 'false'; handle both cases
  const active = value === 'true' || value === true;
  return (
    <div className="flex items-center gap-2">
      {/* Pill-shaped toggle button — teal when active, gray when disabled */}
      <button onClick={() => onChange(active ? 'false' : 'true')}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${active ? 'bg-teal-500' : 'bg-gray-300'}`}
        role="switch" aria-checked={active}>
        {/* Sliding knob — shifts right when active via translate-x-6 */}
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-800 shadow transition-transform ${active ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
      <span className={`text-xs font-medium w-16 ${active ? 'text-teal-700 dark:text-teal-300' : 'text-gray-400'}`}>
        {active ? t('admin.enabled') : t('admin.disabled')}
      </span>
      {/* Confirm/cancel only visible after the toggle has been clicked (inEdit) */}
      {inEdit && (
        <>
          <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1 px-2.5">{saving ? '…' : '✓'}</button>
          <button onClick={onCancel} className="btn-secondary text-xs py-1 px-2.5">✕</button>
        </>
      )}
    </div>
  );
}

/**
 * LangSelect
 *
 * Dropdown for the `frontend_language` configuration key.
 * Only three values are valid: 'fr', 'en', and 'both'.
 * 'both' enables the language switcher in the client-facing UI, while
 * 'fr' or 'en' locks the entire app to a single language.
 */
function LangSelect({ value, inEdit, saving, onChange, onEdit, onSave, onCancel, t }) {
  const labels = { fr: '🇫🇷 Français seulement', en: '🇬🇧 English only', both: '🇫🇷🇬🇧 Both / Les deux' };
  if (!inEdit) return (
    <>
      <span className="text-sm font-semibold bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded-lg">{labels[value] ?? value}</span>
      <button onClick={onEdit} className="btn-secondary text-xs py-1.5 px-3">{t('admin.modify')}</button>
    </>
  );
  return (
    <>
      <select className="input text-sm w-52" value={value}
        onChange={e => onChange(e.target.value)} autoFocus>
        <option value="fr">🇫🇷 Français seulement</option>
        <option value="en">🇬🇧 English only</option>
        <option value="both">🇫🇷🇬🇧 Both / Les deux</option>
      </select>
      <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1.5 px-3">{saving ? '…' : t('admin.save')}</button>
      <button onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('admin.cancel')}</button>
    </>
  );
}

/**
 * NumberCtrl
 *
 * Inline numeric input with optional unit suffix and min/max attributes.
 * Min/max are applied to the HTML input element as hints, but server-side
 * validation is the authoritative constraint.
 */
function NumberCtrl({ value, unit, min, max, inEdit, saving, onChange, onEdit, onSave, onCancel, t }) {
  if (!inEdit) return (
    <>
      <span className="text-sm font-semibold bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded-lg">
        {value} <span className="text-gray-400 font-normal text-xs">{unit}</span>
      </span>
      <button onClick={onEdit} className="btn-secondary text-xs py-1.5 px-3">{t('admin.modify')}</button>
    </>
  );
  return (
    <>
      <div className="flex items-center gap-1">
        <input className="input w-20 text-sm text-center" type="number" min={min} max={max}
          value={value} onChange={e => onChange(e.target.value)} autoFocus />
        <span className="text-xs text-gray-400">{unit}</span>
      </div>
      <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1.5 px-3">{saving ? '…' : t('admin.save')}</button>
      <button onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('admin.cancel')}</button>
    </>
  );
}

/**
 * ALL_COUNTRIES — full sorted list of ISO 3166-1 alpha-2 country codes with
 * English names, sourced from react-phone-number-input's locale data.
 * Sorted alphabetically by display name so operators can scroll predictably.
 */
const ALL_COUNTRIES = getCountries()
  .map(code => ({ code, label: countryNames[code] || code }))
  .sort((a, b) => a.label.localeCompare(b.label));

/**
 * countryFlag — converts a 2-letter ISO country code into a Unicode flag emoji.
 *
 * Uses the Regional Indicator Symbol Letters (U+1F1E6–U+1F1FF). Each letter
 * is mapped by offsetting from 'A' (0x41) to the base code point (0x1F1E6).
 * The two resulting code points form a flag emoji in supporting environments.
 *
 * @param {string} code - ISO 3166-1 alpha-2 country code (e.g. 'CA')
 * @returns {string} flag emoji string, or empty string if code is invalid
 */
function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  return code.split('').map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}

/**
 * CURRENCIES — curated list of currency codes used as options for the
 * `payment_currency` setting. Kept short intentionally; add more entries
 * here as new deployment regions are supported.
 */
const CURRENCIES = [
  { code: 'CAD', label: 'Dollar canadien (CAD)' },
  { code: 'EUR', label: 'Euro (EUR)' },
  { code: 'USD', label: 'Dollar américain (USD)' },
  { code: 'GBP', label: 'Livre sterling (GBP)' },
  { code: 'CHF', label: 'Franc suisse (CHF)' },
];

/**
 * CurrencySelect
 *
 * Dropdown for the `payment_currency` configuration key.
 * The value is stored and compared in uppercase (e.g. 'CAD') to guard
 * against case inconsistencies that could arise from manual DB edits.
 */
function CurrencySelect({ value, inEdit, saving, onChange, onEdit, onSave, onCancel, t }) {
  const label = CURRENCIES.find(c => c.code === value?.toUpperCase())?.label || value || '—';
  if (!inEdit) return (
    <>
      <span className="text-sm font-semibold bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded-lg">{label}</span>
      <button onClick={onEdit} className="btn-secondary text-xs py-1.5 px-3">{t('admin.modify')}</button>
    </>
  );
  return (
    <>
      {/* Normalise value to uppercase so the <select> controlled binding works
          regardless of what case the DB currently holds */}
      <select className="input text-sm w-56" value={value?.toUpperCase() || ''} onChange={e => onChange(e.target.value)} autoFocus>
        {CURRENCIES.map(({ code, label }) => (
          <option key={code} value={code}>{label}</option>
        ))}
      </select>
      <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1.5 px-3">{saving ? '…' : t('admin.save')}</button>
      <button onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('admin.cancel')}</button>
    </>
  );
}

/**
 * CountryPicker
 *
 * Full country dropdown for the `default_phone_country` setting.
 * Uses the ALL_COUNTRIES list derived from react-phone-number-input and
 * renders a Unicode flag emoji alongside each country name for quick visual
 * identification. The value is stored as an uppercase ISO alpha-2 code.
 */
function CountryPicker({ value, inEdit, saving, onChange, onEdit, onSave, onCancel, t }) {
  const label = value ? (countryNames[value.toUpperCase()] || value) : '—';
  const flag  = value ? countryFlag(value.toUpperCase()) : '';
  if (!inEdit) return (
    <>
      <span className="text-sm font-semibold bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded-lg">
        {flag} {label}
      </span>
      <button onClick={onEdit} className="btn-secondary text-xs py-1.5 px-3">{t('admin.modify')}</button>
    </>
  );
  return (
    <>
      <select className="input text-sm w-56" value={value?.toUpperCase() || ''} onChange={e => onChange(e.target.value)} autoFocus>
        {ALL_COUNTRIES.map(({ code, label }) => (
          <option key={code} value={code}>{countryFlag(code)} {label} ({code})</option>
        ))}
      </select>
      <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1.5 px-3">{saving ? '…' : t('admin.save')}</button>
      <button onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('admin.cancel')}</button>
    </>
  );
}

/**
 * GEOCODING_REGIONS — available region codes for the `geocoding_region`
 * setting. This value is passed as a bias hint to the server-side geocoding
 * service (e.g. Google Places or Nominatim) so that address autocomplete
 * results are prioritised within the correct country or sub-region.
 * 'QC' (Québec) is the primary deployment target.
 */
const GEOCODING_REGIONS = [
  { code: 'QC', label: '🇨🇦 Québec (Canada)' },
  { code: 'CA', label: '🇨🇦 Canada (complet)' },
  { code: 'FR', label: '🇫🇷 France' },
  { code: 'BE', label: '🇧🇪 Belgique' },
  { code: 'CH', label: '🇨🇭 Suisse' },
];

/**
 * RegionSelect
 *
 * Dropdown for the `geocoding_region` setting. The stored code is
 * normalised to uppercase before display and comparison to handle any
 * casing inconsistency in the DB.
 */
function RegionSelect({ value, inEdit, saving, onChange, onEdit, onSave, onCancel, t }) {
  const label = GEOCODING_REGIONS.find(r => r.code === (value || '').toUpperCase())?.label || value || '—';
  if (!inEdit) return (
    <>
      <span className="text-sm font-semibold bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded-lg">{label}</span>
      <button onClick={onEdit} className="btn-secondary text-xs py-1.5 px-3">{t('admin.modify')}</button>
    </>
  );
  return (
    <>
      <select className="input text-sm w-52" value={(value || '').toUpperCase()}
        onChange={e => onChange(e.target.value)} autoFocus>
        {GEOCODING_REGIONS.map(({ code, label }) => (
          <option key={code} value={code}>{label}</option>
        ))}
      </select>
      <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1.5 px-3">{saving ? '…' : t('admin.save')}</button>
      <button onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('admin.cancel')}</button>
    </>
  );
}

/**
 * SelectCtrl
 *
 * Generic dropdown control for configuration keys with a fixed set of allowed
 * values (type: 'select' in META). The available options are passed via the
 * `options` prop (a string array) so this component can be reused for any
 * select-type key without per-key customisation.
 *
 * Used for:
 *   payment_provider — one of 'stripe' | 'manual' | 'mobility' | 'paypal'
 *
 * Props:
 *   value   {string}   — current stored value
 *   options {string[]} — allowed values for the dropdown
 *   inEdit  {boolean}  — whether the field is in edit mode
 *   saving  {boolean}  — true while the PUT request is in-flight
 *   onChange, onEdit, onSave, onCancel, t — standard control callback props
 */
function SelectCtrl({ value, options = [], inEdit, saving, onChange, onEdit, onSave, onCancel, t }) {
  if (!inEdit) return (
    <>
      <span className="text-sm font-semibold bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded-lg max-w-[180px] truncate">
        {value || '—'}
      </span>
      <button onClick={onEdit} className="btn-secondary text-xs py-1.5 px-3">{t('admin.modify')}</button>
    </>
  );
  return (
    <>
      <select
        className="input text-sm w-44"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        autoFocus
      >
        {options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
      <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1.5 px-3">
        {saving ? '…' : t('admin.save')}
      </button>
      <button onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('admin.cancel')}</button>
    </>
  );
}

/**
 * TextCtrl
 *
 * Generic plain-text input control. Used as the fallback for any config key
 * whose META type is 'text' or is absent from the META object entirely.
 * The displayed value is truncated with a title tooltip when in view mode
 * to avoid overflowing narrow screens.
 */
function TextCtrl({ value, inEdit, saving, onChange, onEdit, onSave, onCancel, t }) {
  if (!inEdit) return (
    <>
      <span className="text-sm font-semibold bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded-lg max-w-[180px] truncate">{value}</span>
      <button onClick={onEdit} className="btn-secondary text-xs py-1.5 px-3">{t('admin.modify')}</button>
    </>
  );
  return (
    <>
      <input className="input w-44 text-sm" value={value} onChange={e => onChange(e.target.value)} autoFocus />
      <button onClick={onSave} disabled={saving} className="btn-primary text-xs py-1.5 px-3">{saving ? '…' : t('admin.save')}</button>
      <button onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('admin.cancel')}</button>
    </>
  );
}
