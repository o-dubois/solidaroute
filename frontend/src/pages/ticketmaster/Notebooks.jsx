/**
 * @file pages/ticketmaster/Notebooks.jsx
 * @description Ticket Master — notebook list + create notebook form.
 *
 * The create form is an inline panel (not a modal) that appears when
 * the "Create notebook" button is clicked.
 */
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import api, { ticketService } from '../../services/api';
import { PhoneDisplay } from '../../components/common';

// ── CSV export ───────────────────────────────────────────────────────────────

/**
 * exportCSV — builds a CSV from the loaded notebooks list and triggers a
 * browser download. No server call needed — data is already in state.
 * Uses semicolon separator + UTF-8 BOM for Excel/LibreOffice compatibility.
 */
function exportCSV(notebooks, t, lang) {
  const SEP = ';';
  const BOM = '\uFEFF';

  const escape = val => {
    const s = String(val ?? '');
    return s.includes(SEP) || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const fmtDate = iso => {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(
      lang === 'fr' ? 'fr-CA' : 'en-CA',
      { year: 'numeric', month: 'short', day: 'numeric' }
    );
  };

  const headers = [
    t('tickets.notebook_col_number',   { defaultValue: 'Notebook #' }),
    t('tickets.owner_type'),
    t('tickets.col_owner',             { defaultValue: 'Owner' }),
    t('tickets.col_ticket_range',      { defaultValue: 'Ticket range' }),
    t('tickets.available'),
    t('tickets.reserved'),
    t('tickets.used'),
    t('tickets.voided',                { defaultValue: 'Voided' }),
    t('tickets.col_total',             { defaultValue: 'Total' }),
    t('tickets.col_facial_value',      { defaultValue: 'Facial value' }),
    t('tickets.col_currency',          { defaultValue: 'Currency' }),
    t('tickets.col_created',           { defaultValue: 'Created' }),
    t('tickets.paid_by_label',         { defaultValue: 'Paid by' }),
    t('tickets.paid_at_label',         { defaultValue: 'Payment date' }),
    t('tickets.notes_label'),
  ];

  const rows = notebooks.map(nb => {
    const ticketStart = nb.ticket_start ?? '';
    const ticketEnd   = ticketStart !== '' ? parseInt(ticketStart) + 9 : '';
    const owner = nb.owner_type === 'client'
      ? `${nb.owner_first_name || ''} ${nb.owner_last_name || ''}`.trim()
      : (nb.org_name || '');
    return [
      `N-${String(nb.notebook_number).padStart(4, '0')}`,
      nb.owner_type,
      owner,
      ticketStart && ticketEnd ? `${ticketStart}–${ticketEnd}` : '',
      nb.available_tickets ?? '',
      nb.reserved_tickets  ?? '',
      nb.used_tickets      ?? '',
      nb.voided_tickets    ?? '',
      nb.total_tickets     ?? '',
      nb.facial_value      ?? '',
      nb.currency          ?? '',
      fmtDate(nb.created_at),
      nb.paid_by  ?? '',
      fmtDate(nb.paid_at),
      nb.notes    ?? '',
    ].map(escape).join(SEP);
  });

  const csv  = BOM + [headers.map(escape).join(SEP), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `mobility-tickets-${new Date().toISOString().slice(0, 10)}.csv`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Status bar for a notebook — shows ratio of available/reserved/used/voided tickets
function NotebookStatusBar({ nb }) {
  const available = parseInt(nb.available_tickets || 0);
  const reserved  = parseInt(nb.reserved_tickets  || 0);
  const used      = parseInt(nb.used_tickets       || 0);
  const voided    = parseInt(nb.voided_tickets     || 0);
  const total     = parseInt(nb.total_tickets      || 10);

  return (
    <div className="flex rounded-full overflow-hidden h-1.5 w-full bg-gray-100 dark:bg-gray-700">
      {available > 0 && <div style={{ width: `${(available/total)*100}%` }} className="bg-green-400" />}
      {reserved  > 0 && <div style={{ width: `${(reserved /total)*100}%` }} className="bg-blue-400"  />}
      {used      > 0 && <div style={{ width: `${(used     /total)*100}%` }} className="bg-gray-300"  />}
      {voided    > 0 && <div style={{ width: `${(voided   /total)*100}%` }} className="bg-red-300"   />}
    </div>
  );
}

export default function Notebooks() {
  const { t, i18n } = useTranslation(); // i18n.language used for date formatting and template locale

  const [loading,    setLoading]    = useState(true);
  const [notebooks,  setNotebooks]  = useState([]);
  const [showCreate, setShowCreate] = useState(false);

  // Search / filter state
  const [search,          setSearch]          = useState('');
  const [notebookSearch,  setNotebookSearch]  = useState(''); // N-xxxx or just digits
  const [ticketSearch,    setTicketSearch]    = useState(''); // ticket number or prefix
  const [dateFilter,      setDateFilter]      = useState('');

  // Create form state
  const [ownerType,      setOwnerType]      = useState('client');
  const [clientSearch,   setClientSearch]   = useState('');
  const [clients,        setClients]        = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [orgName,        setOrgName]        = useState('');
  const [quantity,       setQuantity]       = useState(1);
  const [notes,          setNotes]          = useState('');
  const [paid,           setPaid]           = useState(false);
  const [paidAt,         setPaidAt]         = useState('');
  const [paidBy,         setPaidBy]         = useState('');
  const [creating,       setCreating]       = useState(false);

  // Fetch notebooks
  const loadNotebooks = () => {
    setLoading(true);
    ticketService.notebooks()
      .then(({ data }) => setNotebooks(data.notebooks || []))
      .catch(err => toast.error(err.response?.data?.error || t('common.error')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadNotebooks();
  }, []);

  // Client search autocomplete
  useEffect(() => {
    if (ownerType !== 'client' || clientSearch.length < 2) {
      setClients([]);
      return;
    }
    const timer = setTimeout(() => {
      api.get('/tickets/clients', { params: { q: clientSearch, limit: 8 } })
        .then(({ data }) => setClients(data.users || []))
        .catch(() => setClients([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [clientSearch, ownerType]);

  async function handleCreate(e) {
    e.preventDefault();
    if (ownerType === 'client' && !selectedClient) {
      toast.error(t('tickets.error_select_client'));
      return;
    }
    setCreating(true);
    try {
      const { data } = await ticketService.createNotebook({
        owner_type:      ownerType,
        owner_client_id: ownerType === 'client' ? selectedClient.id : undefined,
        org_name:        ownerType === 'organization' ? orgName.trim() : undefined,
        quantity,
        notes:   notes.trim() || undefined,
        ...(ownerType === 'organization' ? { paid: true, paid_at: paidAt, paid_by: paidBy.trim() } : {}),
      });
      const count = data.notebooks?.length || 1;
      toast.success(t('tickets.notebooks_created', { count }));
      setShowCreate(false);
      setOwnerType('client'); setClientSearch(''); setSelectedClient(null);
      setOrgName(''); setQuantity(1); setNotes('');
      setPaid(false); setPaidAt(''); setPaidBy('');
      loadNotebooks();
    } catch (err) {
      toast.error(err.response?.data?.error || t('common.error'));
    } finally {
      setCreating(false);
    }
  }

  // ── Client-side filtering ────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notebooks.filter(nb => {
      // Text search: client name or org name
      if (q) {
        const clientName = `${nb.owner_first_name || ''} ${nb.owner_last_name || ''}`.toLowerCase();
        const org        = (nb.org_name || '').toLowerCase();
        if (!clientName.includes(q) && !org.includes(q)) return false;
      }
      // Notebook number search: strip optional "N-" prefix, then prefix-match the padded number
      if (notebookSearch.trim()) {
        const ns     = notebookSearch.trim().replace(/^N-?/i, '');
        const padded = String(nb.notebook_number).padStart(4, '0');
        if (!padded.startsWith(ns) && !String(nb.notebook_number).startsWith(ns)) return false;
      }
      // Ticket number search: if numeric, check if it falls in [ticket_start, ticket_start+9];
      // otherwise do a prefix match on ticket_start string.
      if (ticketSearch.trim()) {
        const ts    = ticketSearch.trim();
        const start = parseInt(nb.ticket_start);
        const num   = parseInt(ts);
        if (!isNaN(num) && ts.length >= 7) {
          if (num < start || num > start + 9) return false;
        } else {
          if (!String(nb.ticket_start).startsWith(ts)) return false;
        }
      }
      // Date filter: prefix match on ISO date — supports YYYY, YYYY-MM, YYYY-MM-DD
      if (dateFilter.trim()) {
        const nbDate = nb.created_at?.slice(0, 10) ?? '';
        if (!nbDate.startsWith(dateFilter.trim())) return false;
      }
      return true;
    });
  }, [notebooks, search, notebookSearch, ticketSearch, dateFilter]);

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(
      i18n.language === 'fr' ? 'fr-CA' : 'en-CA',
      { year: 'numeric', month: 'short', day: 'numeric' }
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1>{t('tickets.notebooks_title')}</h1>
        <div className="flex gap-2">
          {notebooks.length > 0 && (
            <button
              onClick={() => exportCSV(notebooks, t, i18n.language)}
              className="btn-secondary text-sm flex items-center gap-1.5"
            >
              📄 {t('tickets.export_csv')}
            </button>
          )}
          <button
            onClick={() => setShowCreate(v => !v)}
            className="btn-primary text-sm"
          >
            {showCreate ? t('common.cancel') : `+ ${t('tickets.create_notebook')}`}
          </button>
        </div>
      </div>

      {/* ── Create form ─────────────────────────────────────────── */}
      {showCreate && (
        <div className="card space-y-4 border-teal-200">
          <h2 className="text-sm font-semibold">{t('tickets.create_notebook')}</h2>
          <form onSubmit={handleCreate} className="space-y-4">

            {/* Owner type */}
            <div className="space-y-2">
              <label className="label">{t('tickets.owner_type')}</label>
              <div className="flex gap-4">
                {['client', 'organization'].map(ot => (
                  <label key={ot} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="ownerType"
                      value={ot}
                      checked={ownerType === ot}
                      onChange={() => { setOwnerType(ot); setSelectedClient(null); setOrgName(''); }}
                      className="w-4 h-4 text-teal-600 dark:text-teal-400"
                    />
                    <span className="text-sm">{t(`tickets.owner_${ot}`)}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Client selector */}
            {ownerType === 'client' && (
              <div>
                <label className="label">{t('tickets.client_label')}</label>
                {selectedClient ? (
                  <div className="flex items-center justify-between p-2 rounded-lg bg-teal-50 dark:bg-teal-900/30 border border-teal-200">
                    <span className="text-sm font-medium text-teal-800 dark:text-teal-200">
                      ✓ {selectedClient.first_name} {selectedClient.last_name}
                      <span className="text-teal-500 font-normal ml-1 text-xs">({selectedClient.email})</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => { setSelectedClient(null); setClientSearch(''); }}
                      className="text-xs text-teal-500 hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      type="text"
                      value={clientSearch}
                      onChange={e => setClientSearch(e.target.value)}
                      placeholder={t('tickets.client_search_placeholder')}
                      className="input"
                    />
                    {clients.length > 0 && (
                      <div className="absolute top-full left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                                      rounded-lg shadow-md z-20 mt-1">
                        {clients.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            onMouseDown={() => { setSelectedClient(c); setClientSearch(''); setClients([]); }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-teal-50 border-b
                                       border-gray-50 last:border-0"
                          >
                            {c.first_name} {c.last_name}
                            <span className="text-gray-400 text-xs ml-2">{c.email}</span>
                            {c.phone && <span className="text-gray-400 text-xs ml-2"><PhoneDisplay phone={c.phone} /></span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Organization name (informational) */}
            {ownerType === 'organization' && (
              <div>
                <label className="label">
                  {t('tickets.org_name_label')}
                  <span className="text-gray-400 font-normal ml-1">({t('common.optional')})</span>
                </label>
                <input
                  type="text"
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder={t('tickets.org_name_placeholder')}
                  className="input"
                />
                <p className="text-xs text-gray-400 mt-1">{t('tickets.org_name_hint')}</p>
              </div>
            )}

            {/* Quantity */}
            <div>
              <label className="label">{t('tickets.quantity_label')}</label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setQuantity(q => Math.max(1, q - 1))}
                  className="w-9 h-9 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 font-bold text-lg flex items-center justify-center"
                >−</button>
                <span className="text-xl font-bold text-teal-700 dark:text-teal-300 w-8 text-center">{quantity}</span>
                <button
                  type="button"
                  onClick={() => setQuantity(q => Math.min(10, q + 1))}
                  className="w-9 h-9 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 font-bold text-lg flex items-center justify-center"
                >+</button>
                <span className="text-xs text-gray-400">{t('tickets.quantity_hint')}</span>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="label">
                {t('tickets.notes_label')}
                <span className="text-gray-400 font-normal ml-1">({t('common.optional')})</span>
              </label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                className="input"
                placeholder={t('tickets.notes_placeholder')}
              />
            </div>

            {/* ── Payment confirmation — organisation notebooks only ── */}
            {ownerType === 'organization' && <div className="border-t border-gray-100 dark:border-gray-700 pt-4 space-y-4">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-300 uppercase tracking-wide">
                {t('tickets.payment_confirmation_section', { defaultValue: 'Payment confirmation' })}
              </p>

              {/* Paid checkbox */}
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={paid}
                  onChange={e => setPaid(e.target.checked)}
                  required
                  className="w-4 h-4 text-teal-600 dark:text-teal-400 rounded"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {t('tickets.paid_label', { defaultValue: 'Payment received' })}
                  <span className="text-red-500 ml-1">*</span>
                </span>
              </label>
              {!paid && (
                <p className="text-xs text-amber-600 -mt-2">
                  {t('tickets.paid_required_hint', { defaultValue: 'You must confirm payment before creating a notebook.' })}
                </p>
              )}

              {/* Payment date */}
              <div>
                <label className="label">
                  {t('tickets.paid_at_label', { defaultValue: 'Payment date' })}
                  <span className="text-red-500 ml-1">*</span>
                </label>
                <input
                  type="date"
                  value={paidAt}
                  onChange={e => setPaidAt(e.target.value)}
                  required
                  min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); })()}
                  max={new Date().toISOString().slice(0, 10)}
                  className="input"
                />
              </div>

              {/* Paid by */}
              <div>
                <label className="label">
                  {t('tickets.paid_by_label', { defaultValue: 'Paid by' })}
                  <span className="text-red-500 ml-1">*</span>
                </label>
                <input
                  type="text"
                  value={paidBy}
                  onChange={e => setPaidBy(e.target.value)}
                  required
                  placeholder={t('tickets.paid_by_placeholder', { defaultValue: 'e.g. Jean Tremblay — cheque #1042' })}
                  className="input"
                />
                <p className="text-xs text-gray-400 mt-1">
                  {t('tickets.paid_by_hint', { defaultValue: 'Name and/or payment reference of the person who paid.' })}
                </p>
              </div>
            </div>}

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary flex-1">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={creating} className="btn-primary flex-1">
                {creating ? t('common.loading') : t('tickets.create_notebook')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Search / filter bar ──────────────────────────────────── */}
      {!loading && notebooks.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          {/* Name / org search */}
          <div className="relative flex-1 min-w-[9rem]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('tickets.search_notebooks_placeholder', { defaultValue: 'Client or org…' })}
              className="input pl-8 text-sm w-full"
            />
          </div>

          {/* Notebook number search */}
          <div className="relative flex-1 min-w-[9rem]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">📒</span>
            <input
              type="text"
              value={notebookSearch}
              onChange={e => setNotebookSearch(e.target.value)}
              placeholder={t('tickets.search_notebook_number_placeholder', { defaultValue: 'N-xxxx' })}
              className="input pl-8 text-sm w-full font-mono"
            />
          </div>

          {/* Ticket number search */}
          <div className="relative flex-1 min-w-[9rem]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🎫</span>
            <input
              type="text"
              value={ticketSearch}
              onChange={e => setTicketSearch(e.target.value)}
              placeholder={t('tickets.search_ticket_number_placeholder', { defaultValue: 'Ticket #…' })}
              className="input pl-8 text-sm w-full font-mono"
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

          {(search || notebookSearch || ticketSearch || dateFilter) && (
            <button
              type="button"
              onClick={() => { setSearch(''); setNotebookSearch(''); setTicketSearch(''); setDateFilter(''); }}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
            >
              ✕ {t('common.clear', { defaultValue: 'Clear' })}
            </button>
          )}
        </div>
      )}

      {/* ── Notebook list ─────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm py-8 justify-center">
          <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : notebooks.length === 0 ? (
        <div className="card text-center py-10 text-gray-400">
          <p className="text-4xl mb-3">📒</p>
          <p className="text-sm">{t('tickets.no_notebooks')}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-10 text-gray-400">
          <p className="text-3xl mb-3">🔍</p>
          <p className="text-sm">{t('common.no_results', { defaultValue: 'No notebooks match your search.' })}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(nb => (
            <Link
              key={nb.id}
              to={`/ticket-master/notebooks/${nb.id}`}
              className="card flex items-center gap-4 hover:border-teal-200 transition-colors cursor-pointer"
            >
              {/* Notebook number badge */}
              <div className="flex-shrink-0 w-16 text-center">
                <span className="font-mono text-xs font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded px-2 py-1">
                  N-{String(nb.notebook_number).padStart(4, '0')}
                </span>
              </div>

              {/* Owner info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                  {nb.owner_type === 'client'
                    ? `${nb.owner_first_name} ${nb.owner_last_name}`
                    : `🏢 ${nb.org_name || t('tickets.owner_organization')}`}
                </p>
                <p className="text-xs text-gray-400">
                  {nb.facial_value} {nb.currency} / {t('tickets.ticket')}
                  {' · '}{formatDate(nb.created_at)}
                  {nb.notes && <span className="ml-2 italic">· {nb.notes.slice(0, 40)}</span>}
                </p>
                {nb.paid_by && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    💰 {nb.paid_by}
                    {nb.paid_at && <span className="ml-1">· {formatDate(nb.paid_at)}</span>}
                  </p>
                )}
                <div className="mt-1.5">
                  <NotebookStatusBar nb={nb} />
                </div>
              </div>

              {/* Ticket counts */}
              <div className="text-right flex-shrink-0 text-xs space-y-0.5">
                <p className="text-green-600 font-medium">{nb.available_tickets} {t('tickets.available')}</p>
                {parseInt(nb.reserved_tickets) > 0 && (
                  <p className="text-blue-500">{nb.reserved_tickets} {t('tickets.reserved')}</p>
                )}
                <p className="text-gray-400">{nb.used_tickets}/{nb.total_tickets} {t('tickets.used')}</p>
              </div>

              <span className="text-gray-300 text-xs flex-shrink-0">›</span>
            </Link>
          ))}
          {filtered.length < notebooks.length && (
            <p className="text-xs text-gray-400 text-center pt-1">
              {t('common.showing_of', {
                shown: filtered.length,
                total: notebooks.length,
                defaultValue: `Showing ${filtered.length} of ${notebooks.length}`,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
