/**
 * @file pages/ticketmaster/NotebookDetail.jsx
 * @description Ticket Master — full detail view for a single mobility ticket notebook.
 *              Route: /ticket-master/notebooks/:id
 *
 * Shows all metadata for one notebook (owner, creation date, current value, etc.)
 * and a grid of all 10 individual tickets within it, each with its lifecycle status:
 *   available — can be reserved for an upcoming trip
 *   reserved  — linked to a specific trip (not yet completed)
 *   used      — consumed by a completed trip (permanent, cannot be restored)
 *   voided    — cancelled by an admin action (permanent)
 *
 * The only write action available on this page is voiding an 'available' ticket.
 * Voiding is permanent — a confirmation modal is shown before the API call.
 * Reserved and used tickets cannot be voided; a reason badge explains why.
 *
 * STATUS_STYLE and STATUS_ICON are module-level maps so all 10 ticket cells
 * use the same visual language without repeating the style definitions inline.
 */
import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ticketService } from '../../services/api';

const STATUS_STYLE = {
  available: 'bg-green-50 dark:bg-green-900/30  text-green-700 dark:text-green-300  border-green-200',
  reserved:  'bg-blue-50 dark:bg-blue-900/30   text-blue-700 dark:text-blue-300   border-blue-200',
  used:      'bg-gray-100 dark:bg-gray-700  text-gray-500 dark:text-gray-400   border-gray-200 dark:border-gray-700',
  voided:    'bg-red-50 dark:bg-red-900/30    text-red-400    border-red-200  opacity-60',
};

const STATUS_ICON = {
  available: '✅',
  reserved:  '🔒',
  used:      '✓',
  voided:    '🚫',
};

export default function NotebookDetail() {
  const { id } = useParams();
  const { t }  = useTranslation();

  const [loading,    setLoading]    = useState(true);
  const [notebook,   setNotebook]   = useState(null);
  const [tickets,    setTickets]    = useState([]);
  const [voidingNum, setVoidingNum] = useState(null); // ticket number being voided

  const load = () => {
    setLoading(true);
    ticketService.notebook(id)
      .then(({ data }) => {
        setNotebook(data.notebook);
        setTickets(data.tickets || []);
      })
      .catch(() => toast.error(t('common.error')))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  async function handleVoid(ticketNumber) {
    if (!window.confirm(t('tickets.void_confirm', { number: ticketNumber }))) return;
    setVoidingNum(ticketNumber);
    try {
      await ticketService.voidTicket(ticketNumber);
      toast.success(t('tickets.void_success', { number: ticketNumber }));
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || t('common.error'));
    } finally {
      setVoidingNum(null);
    }
  }

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 text-sm py-12 justify-center">
      <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
      {t('common.loading')}
    </div>
  );

  if (!notebook) return (
    <div className="card text-center py-12 text-gray-400">
      <p>{t('tickets.notebook_not_found')}</p>
    </div>
  );

  const availableCount = tickets.filter(t => t.status === 'available').length;
  const usedCount      = tickets.filter(t => t.status === 'used').length;

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link to="/ticket-master/notebooks" className="hover:text-teal-600 transition-colors">
          {t('tickets.notebooks_title')}
        </Link>
        <span>›</span>
        <span className="text-gray-700 dark:text-gray-200 font-medium">
          N-{String(notebook.notebook_number).padStart(4, '0')}
        </span>
      </div>

      {/* Notebook header */}
      <div className="card space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <span className="font-mono text-xs font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded px-2 py-1 mr-2">
              N-{String(notebook.notebook_number).padStart(4, '0')}
            </span>
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              {notebook.owner_type === 'client'
                ? `${notebook.owner_first_name} ${notebook.owner_last_name}`
                : `🏢 ${notebook.org_name || t('tickets.owner_organization')}`}
            </span>
          </div>
          <div className="text-right text-xs text-gray-400">
            <p>{availableCount}/{tickets.length} {t('tickets.available')}</p>
            <p>{usedCount} {t('tickets.used')}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-xs text-gray-400">{t('tickets.owner_type')}</span>
            <p className="font-medium">
              {notebook.owner_type === 'client'
                ? t('tickets.owner_client')
                : t('tickets.owner_organization')}
            </p>
          </div>
          {notebook.owner_type === 'organization' && notebook.org_name && (
            <div>
              <span className="text-xs text-gray-400">{t('tickets.org_name_label')}</span>
              <p className="font-medium">{notebook.org_name}</p>
            </div>
          )}
          {/* Access key — shown for org notebooks (ticket_master must share this with the org) */}
          {notebook.owner_type === 'organization' && (
            <div className="col-span-2 bg-teal-50 dark:bg-teal-900/30 border border-teal-200 rounded-xl p-3">
              <span className="text-xs text-teal-600 dark:text-teal-400 font-medium block mb-1">
                🔑 {t('tickets.notebook_key_label')}
              </span>
              <span className="font-mono text-2xl font-bold text-teal-800 dark:text-teal-200 tracking-widest">
                {notebook.notebook_key}
              </span>
              <p className="text-xs text-teal-500 mt-1">{t('tickets.notebook_key_share_hint')}</p>
            </div>
          )}
          {notebook.owner_type === 'client' && (
            <div>
              <span className="text-xs text-gray-400">{t('tickets.client_email')}</span>
              <p className="font-medium text-xs">{notebook.owner_email}</p>
            </div>
          )}
          <div>
            <span className="text-xs text-gray-400">{t('tickets.facial_value')}</span>
            <p className="font-medium">{notebook.facial_value} {notebook.currency}</p>
          </div>
          <div>
            <span className="text-xs text-gray-400">{t('tickets.created_by')}</span>
            <p className="font-medium">{notebook.creator_first_name} {notebook.creator_last_name}</p>
          </div>
          <div>
            <span className="text-xs text-gray-400">{t('tickets.created_at')}</span>
            <p className="font-medium">{new Date(notebook.created_at).toLocaleDateString()}</p>
          </div>
          {notebook.paid_by && (
            <div className="col-span-2 bg-green-50 dark:bg-green-900/30 border border-green-200 rounded-xl p-3">
              <span className="text-xs text-green-600 font-medium block mb-1">
                💰 {t('tickets.paid_by_label', { defaultValue: 'Paid by' })}
              </span>
              <p className="text-sm font-semibold text-green-800 dark:text-green-200">{notebook.paid_by}</p>
              {notebook.paid_at && (
                <p className="text-xs text-green-600 mt-0.5">
                  {t('tickets.paid_at_label', { defaultValue: 'Payment date' })}: {new Date(notebook.paid_at).toLocaleDateString()}
                </p>
              )}
            </div>
          )}
        </div>

        {notebook.notes && (
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-sm text-gray-600 dark:text-gray-300 italic">
            {notebook.notes}
          </div>
        )}
      </div>

      {/* Ticket grid */}
      <div>
        <h2 className="text-sm font-semibold mb-3">{t('tickets.tickets_in_notebook')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {tickets.map(ticket => (
            <div
              key={ticket.id}
              className={`rounded-xl border p-3 ${STATUS_STYLE[ticket.status] || ''}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span>{STATUS_ICON[ticket.status]}</span>
                  <span className="font-mono font-bold text-sm">{ticket.ticket_number}</span>
                </div>
                <span className="text-xs capitalize">{t(`tickets.status_${ticket.status}`)}</span>
              </div>

              {/* Trip info when used */}
              {(ticket.status === 'used' || ticket.status === 'reserved') && ticket.trip_id && (
                <div className="mt-2 text-xs space-y-0.5 border-t border-current/10 pt-2">
                  {ticket.trip_number && (
                    <p>
                      <span className="opacity-70">{t('tickets.trip')}: </span>
                      <span className="font-mono font-bold">T-{ticket.trip_number}</span>
                    </p>
                  )}
                  {ticket.driver_first_name && (
                    <p>
                      <span className="opacity-70">{t('tickets.driver')}: </span>
                      {ticket.driver_first_name} {ticket.driver_last_name}
                    </p>
                  )}
                  {ticket.used_at && (
                    <p className="opacity-70">
                      {new Date(ticket.used_at).toLocaleDateString()}
                    </p>
                  )}
                  {ticket.reserved_at && !ticket.used_at && (
                    <p className="opacity-70">
                      {t('tickets.reserved_at')}: {new Date(ticket.reserved_at).toLocaleDateString()}
                    </p>
                  )}
                </div>
              )}

              {/* Void action for available tickets */}
              {ticket.status === 'available' && (
                <div className="mt-2 flex justify-end">
                  <button
                    onClick={() => handleVoid(ticket.ticket_number)}
                    disabled={voidingNum === ticket.ticket_number}
                    className="text-xs text-red-400 hover:text-red-600 transition-colors"
                  >
                    {voidingNum === ticket.ticket_number ? t('common.loading') : t('tickets.void')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
