/**
 * AuthContext — global authentication state for the mobile app.
 *
 * Same logic as the web AuthContext, adapted for React Native:
 *   - Token stored in expo-secure-store (instead of localStorage)
 *   - In-memory token cache kept in sync via setMemoryToken()
 *   - No session inactivity timer (mobile OS handles background/foreground)
 */
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authService }               from '../services/api';
import { setMemoryToken, clearMemoryToken } from '../services/api';
import { storage }                   from '../services/storage';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  // ── Logout ───────────────────────────────────────────────────
  const logout = useCallback(async () => {
    clearMemoryToken();
    await storage.clearAll();
    setUser(null);
  }, []);

  // ── Restore session on app start ────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [token, cachedUser] = await Promise.all([
          storage.getToken(),
          storage.getUser(),
        ]);
        if (token && cachedUser) {
          setMemoryToken(token);
          setUser(cachedUser);
          // Re-validate token in background; silent logout on 401
          authService.me()
            .then(({ data }) => {
              setUser(data.user);
              storage.setUser(data.user);
            })
            .catch(() => logout());
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [logout]);

  // ── Login ────────────────────────────────────────────────────
  async function login(email, password) {
    const { data } = await authService.login({ email, password });
    setMemoryToken(data.token);
    await storage.setToken(data.token);
    await storage.setUser(data.user);
    setUser(data.user);
    // Fetch full profile in background (login response omits driver profile fields
    // like approval_status; me() returns the complete user object)
    authService.me()
      .then(({ data: meData }) => {
        setUser(meData.user);
        storage.setUser(meData.user);
      })
      .catch(() => {});
    return data.user;
  }

  async function refreshUser() {
    const { data } = await authService.me();
    setUser(data.user);
    await storage.setUser(data.user);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
