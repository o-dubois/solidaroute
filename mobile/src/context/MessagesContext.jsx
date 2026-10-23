/**
 * MessagesContext — provides the global unread message count.
 *
 * Polls GET /messages/unread-count every 30 s so the tab badge
 * stays up-to-date without manual refreshes. Any screen can call
 * `refreshUnread()` to force an immediate update (e.g. after sending
 * a message or opening a thread).
 */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { messageService } from '../services/api';

const MessagesContext = createContext({ unreadCount: 0, refreshUnread: () => {} });

export function MessagesProvider({ children }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const intervalRef = useRef(null);

  const refreshUnread = useCallback(() => {
    messageService.unreadCount()
      .then(({ data }) => setUnreadCount(data.count ?? 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshUnread();
    intervalRef.current = setInterval(refreshUnread, 30000);
    return () => clearInterval(intervalRef.current);
  }, [refreshUnread]);

  return (
    <MessagesContext.Provider value={{ unreadCount, refreshUnread }}>
      {children}
    </MessagesContext.Provider>
  );
}

export function useMessages() {
  return useContext(MessagesContext);
}
