/**
 * @file pages/messages/TripChat.jsx
 * @description Full message thread for a single trip.
 *
 * Messages displayed newest → oldest.
 * Send form at the top.
 * Shows a closed banner when the reply window has expired.
 * Character counter on the input (max 500).
 */
import { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { messageService } from '../../services/api';
import toast from 'react-hot-toast';

// Client-side copy of backend namePrivacy.maskName.
// clients and drivers see "FirstName L."; operators/admins see the full name.
// Keep this in sync with backend/src/utils/namePrivacy.js.
function maskName(first, last, viewerRole) {
  if (!first && !last) return '';
  const privateRoles = new Set(['client', 'driver']);
  if (privateRoles.has(viewerRole) && last) return `${first} ${last[0].toUpperCase()}.`;
  return `${first} ${last}`.trim();
}

export default function TripChat() {
  const { id }             = useParams();
  const { t, i18n }        = useTranslation();
  const { user }           = useAuth();
  const [loading, setLoading]       = useState(true);
  const [trip,    setTrip]          = useState(null);
  const [messages, setMessages]     = useState([]);
  const [windowOpen, setWindowOpen] = useState(true);
  const [windowDays, setWindowDays] = useState(30);
  const [body,    setBody]          = useState('');
  const [sending, setSending]       = useState(false);
  const textareaRef                 = useRef(null);

  function loadThread() {
    return messageService.thread(id)
      .then(({ data }) => {
        setTrip(data.trip);
        setMessages(data.messages || []);
        setWindowOpen(data.window_open);
        setWindowDays(data.window_days ?? 30);
        // Signal Layout to refresh the unread badge immediately
        window.dispatchEvent(new Event('messages-read'));
      })
      .catch(() => {});
  }

  useEffect(() => {
    setLoading(true);
    loadThread().finally(() => setLoading(false));
  }, [id]);

  async function handleSend(e) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    if (trimmed.length > 500) {
      toast.error(t('messages.error_too_long'));
      return;
    }
    setSending(true);
    try {
      await messageService.send(id, trimmed);
      setBody('');
      await loadThread();
      textareaRef.current?.focus();
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'WINDOW_CLOSED') toast.error(t('messages.error_window_closed'));
      // Other errors handled by global interceptor
    } finally {
      setSending(false);
    }
  }

  function formatMsgDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(
      i18n.language === 'fr' ? 'fr-CA' : 'en-CA',
      { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    );
  }

  const remaining = 500 - body.length;

  // Name of the other party in the conversation
  const otherName = trip
    ? user?.id === trip.client_id
      ? (trip.driver_first ? maskName(trip.driver_first, trip.driver_last, user?.role) : t('messages.no_driver'))
      : maskName(trip.client_first, trip.client_last, user?.role)
    : '';

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-400 text-sm py-16 justify-center">
        <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="card text-center py-14 text-gray-400">
        <p className="text-4xl mb-3">💬</p>
        <p className="text-sm">{t('common.error')}</p>
        <Link to="/messages" className="text-teal-600 dark:text-teal-400 text-sm mt-4 inline-block">
          ← {t('messages.back_to_list')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl">
      {/* ── Header ────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Link to="/messages" className="text-gray-400 hover:text-gray-600 text-sm">
          ←
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-bold text-white bg-gray-500 px-2 py-0.5 rounded">
              T-{trip.trip_number}
            </span>
            <h1 className="text-base font-semibold text-gray-900 dark:text-gray-50 truncate">
              {otherName}
            </h1>
          </div>
          <p className="text-xs text-gray-400 truncate">
            {trip.pickup_address} → {trip.dropoff_address}
          </p>
        </div>
      </div>

      {/* ── Reply window closed banner ─────────────────────────── */}
      {!windowOpen && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-200 px-4 py-3">
          <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">
            🔒 {t('messages.window_closed', { days: windowDays })}
          </p>
        </div>
      )}

      {/* ── Send form (top, only if window open) ──────────────── */}
      {windowOpen && (
        <form onSubmit={handleSend} className="card space-y-3">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder={t('messages.send_placeholder')}
            className="input resize-none text-sm w-full"
            disabled={sending}
          />
          <div className="flex items-center justify-between">
            <span className={`text-xs ${remaining < 50 ? 'text-amber-500 font-medium' : 'text-gray-400'}`}>
              {t('messages.characters_remaining', { count: remaining })}
            </span>
            <button
              type="submit"
              disabled={sending || !body.trim()}
              className="btn-primary text-sm px-5"
            >
              {sending ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  {t('common.loading')}
                </span>
              ) : t('messages.send_button')}
            </button>
          </div>
        </form>
      )}

      {/* ── Message thread (newest → oldest) ──────────────────── */}
      {messages.length === 0 ? (
        <div className="card text-center py-10 text-gray-400">
          <p className="text-3xl mb-2">💬</p>
          <p className="text-sm">{t('messages.no_messages')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map(msg => {
            const isMine = msg.sender_id === user?.id;
            return (
              <div
                key={msg.id}
                className={`flex gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}
              >
                {/* Avatar */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center
                                 text-xs font-bold flex-shrink-0 self-end
                                 ${isMine ? 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                  {(msg.first_name?.[0] || '?').toUpperCase()}
                </div>

                {/* Bubble */}
                <div className={`max-w-[75%] space-y-1 ${isMine ? 'items-end' : 'items-start'} flex flex-col`}>
                  {/* Sender name + time */}
                  <div className={`flex items-center gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                      {isMine ? t('messages.you') : maskName(msg.first_name, msg.last_name, user?.role)}
                    </span>
                    <span className="text-xs text-gray-400">{formatMsgDate(msg.created_at)}</span>
                  </div>
                  {/* Text bubble */}
                  <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words
                    ${isMine
                      ? 'bg-teal-600 text-white rounded-tr-sm'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-100 rounded-tl-sm'
                    }`}
                  >
                    {msg.body}
                  </div>
                  {/* Read receipt for own messages */}
                  {isMine && msg.read_at && (
                    <span className="text-xs text-gray-400">✓✓</span>
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
