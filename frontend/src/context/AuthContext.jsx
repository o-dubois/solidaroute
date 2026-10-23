/**
 * Authentication Context
 *
 * Provides global authentication state to the entire application.
 * Wraps the App in AuthProvider; components consume state via useAuth().
 *
 * State:
 *   user    — The authenticated user object (null if not logged in)
 *   loading — true during the initial token validation on app load
 *
 * Methods:
 *   login(email, password)  — Calls POST /api/auth/login, stores token + user
 *   logout()                — Clears localStorage and resets state
 *   refreshUser()           — Re-fetches user from GET /api/auth/me
 *
 * Session timeout:
 *   Reads session_timeout_minutes from GET /api/admin/configuration/public.
 *   A timer resets on any user activity (mousemove, keydown, click, scroll,
 *   touchstart). When the timeout expires, the user is logged out automatically.
 *   Setting session_timeout_minutes to 0 disables automatic logout.
 *
 * Persistence:
 *   Token stored in localStorage as 'sr_token'
 *   User object stored as 'sr_user' (for instant UI on page reload,
 *   refreshed from the server in the background)
 */
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { authService, detectApiUrl } from '../services/api';
import toast from 'react-hot-toast';

const AuthContext = createContext(null);

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes fallback

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);
  const timeoutRef            = useRef(null);
  const timeoutMsRef          = useRef(DEFAULT_TIMEOUT_MS);

  // ── Logout ──────────────────────────────────────────────────
  const logout = useCallback((expired = false) => {
    clearTimeout(timeoutRef.current);
    localStorage.removeItem('sr_token');
    localStorage.removeItem('sr_user');
    setUser(null);
    if (expired) {
      // Small delay so the toast appears on the login page
      setTimeout(() => toast.error(
        localStorage.getItem('sr_lang_expired_msg') || 'Session expirée. Veuillez vous reconnecter.'
      ), 100);
    }
  }, []);

  // ── Reset inactivity timer ───────────────────────────────────
  const resetTimer = useCallback(() => {
    if (!localStorage.getItem('sr_token')) return;
    const ms = timeoutMsRef.current;
    if (ms === 0) return; // timeout disabled
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => logout(true), ms);
  }, [logout]);

  // ── Load timeout value from public config ────────────────────
  useEffect(() => {
    fetch(`${detectApiUrl()}/admin/configuration/public`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const cfg = data?.configuration || [];
        const val = cfg.find(c => c.key === 'session_timeout_minutes')?.value;
        const minutes = parseInt(val ?? '30', 10);
        timeoutMsRef.current = isNaN(minutes) || minutes <= 0 ? 0 : minutes * 60 * 1000;
      })
      .catch(() => {}); // keep default
  }, []);

  // ── Register activity listeners ──────────────────────────────
  useEffect(() => {
    ACTIVITY_EVENTS.forEach(ev => window.addEventListener(ev, resetTimer, { passive: true }));
    return () => {
      ACTIVITY_EVENTS.forEach(ev => window.removeEventListener(ev, resetTimer));
      clearTimeout(timeoutRef.current);
    };
  }, [resetTimer]);

  // ── Initial auth check ───────────────────────────────────────
  useEffect(() => {
    const stored = localStorage.getItem('sr_user');
    const token  = localStorage.getItem('sr_token');
    if (stored && token) {
      setUser(JSON.parse(stored));
      authService.me()
        .then(({ data }) => {
          setUser(data.user);
          localStorage.setItem('sr_user', JSON.stringify(data.user));
          resetTimer(); // start the inactivity timer once authenticated
        })
        .catch(() => logout())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [logout, resetTimer]);

  // ── Login ────────────────────────────────────────────────────
  async function login(email, password) {
    const { data } = await authService.login({ email, password });
    localStorage.setItem('sr_token', data.token);
    localStorage.setItem('sr_user', JSON.stringify(data.user));
    setUser(data.user);
    resetTimer(); // start timer on login
    return data.user;
  }

  async function refreshUser() {
    const { data } = await authService.me();
    setUser(data.user);
    localStorage.setItem('sr_user', JSON.stringify(data.user));
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout: () => logout(false), refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
