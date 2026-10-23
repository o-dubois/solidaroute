/**
 * @file pages/messages/MessagesList.jsx
 * @description Conversations list — shows all trip threads the logged-in user participates in.
 *
 * Ordered newest first (by latest message timestamp).
 * Clicking a row opens the TripChat page for that trip.
 * Unread count badges are shown per conversation.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { messageService } from '../../services/api';

// Client-side copy of backend namePrivacy.maskName.
// clients and drivers see "FirstName L."; operators/admins see the full name.
// Keep this in sync with backend/src/utils/namePrivacy.js.
function maskName(first, last, viewerRole) {
  if (!first && !last) return '';
  const privateRoles = new Set(['client', 'driver']);
  if (privateRoles.has(viewerRole) && last) return `${first} ${last[0].toUpperCase()}.`;
  return `${first} ${last}`.trim();
}

export default function MessagesList() {
  const { t, i18n }        = useTranslation();
  const { user }           = useAuth();
  const [loading, setLoading]             = useState(true);
  const [conversations, setConversations] = useState([]);

  useEffect(() => {
    messageService.conversations()
      .then(({ data }) => setConversations(data.conversations || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString(i18n.language === 'fr' ? 'fr-CA' : 'en-CA',
      { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return i18n.language === 'fr' ? 'Hier' : 'Yesterday';
    if (diffDays < 7)  return d.toLocaleDateString(i18n.language === 'fr' ? 'fr-CA' : 'en-CA',
      { weekday: 'short' });
    return d.toLocaleDateString(i18n.language === 'fr' ? 'fr-CA' : 'en-CA',
      { day: 'numeric', month: 'short' });
  }

  function otherParty(conv) {
    if (user?.role === 'driver') {
      return conv.client_first
        ? maskName(conv.client_first, conv.client_last, user?.role)
        : t('messages.unknown_client', { defaultValue: 'Client' });
    }
    return conv.driver_first
      ? maskName(conv.driver_first, conv.driver_last, user?.role)
      : t('messages.no_driver', { defaultValue: 'No driver assigned' });
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-400 text-sm py-16 justify-center">
        <span className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 rounded-full animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1>{t('messages.title')}</h1>

      {conversations.length === 0 ? (
        <div className="card text-center py-14 text-gray-400">
          <p className="text-4xl mb-3">💬</p>
          <p className="text-sm">{t('messages.no_conversations')}</p>
        </div>
      ) : (
        <div className="card p-0 divide-y divide-gray-100 dark:divide-gray-700">
          {conversations.map(conv => {
            const unread    = parseInt(conv.unread_count || 0);
            const isMine    = conv.last_sender_id === user?.id;
            const chatPath  = `/messages/trip/${conv.trip_id}`;

            return (
              <Link
                key={conv.trip_id}
                to={chatPath}
                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              >
                {/* Avatar / icon */}
                <div className={`w-10 h-10 rounded-full flex items-center justify-center
                                 flex-shrink-0 text-sm font-bold
                                 ${unread > 0 ? 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                  💬
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className={`text-sm truncate ${unread > 0 ? 'font-semibold text-gray-900 dark:text-gray-50' : 'text-gray-700 dark:text-gray-200'}`}>
                      {otherParty(conv)}
                    </p>
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      {formatDate(conv.last_created_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <p className="text-xs text-gray-400 truncate">
                      <span className="font-mono bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded px-1 mr-1">
                        T-{conv.trip_number}
                      </span>
                      {isMine && <span className="mr-1 text-gray-300">✓</span>}
                      {conv.last_body}
                    </p>
                    {unread > 0 && (
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-teal-600 text-white
                                       text-xs font-bold flex items-center justify-center">
                        {unread > 9 ? '9+' : unread}
                      </span>
                    )}
                  </div>
                </div>

                <span className="text-gray-300 text-sm flex-shrink-0">›</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
