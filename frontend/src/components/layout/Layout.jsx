/**
 * Application Layout  —  components/layout/Layout.jsx
 *
 * The main shell rendered for all authenticated pages.
 * Uses React Router's <Outlet /> so child route components render in the
 * main content area without this component needing to know about them.
 *
 * Structure:
 *   <div.flex>
 *     <aside>  — fixed-width sidebar (256 px)
 *     <main>   — scrollable content area (fills remaining width)
 *
 * Sidebar sections (top to bottom):
 *   1. Logo / brand mark
 *   2. Role-specific navigation links
 *   3. Language selector (only when admin set frontend_language = 'both')
 *   4. User avatar + name + email (click to go to profile)
 *   5. Logout button
 *
 * Navigation active state:
 *   Uses NavLink's isActive prop. The `end` prop is set to true for top-level
 *   routes (depth ≤ 2 segments like "/driver") to avoid the parent path matching
 *   all child routes as "active" simultaneously.
 *
 * Language selector:
 *   Hidden when the admin has locked the language to a single option.
 *   Visible when langConfig = 'both', allowing users to toggle FR/EN.
 *   The `locked` flag from LanguageContext handles edge cases where the config
 *   value is 'both' but the user's language was set programmatically and should
 *   not be changed via the UI.
 */
import { useEffect, useState } from 'react';
import { Outlet, NavLink, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAppConfig } from '../../context/AppConfigContext';
import { messageService, reviewService, versionService } from '../../services/api';

/**
 * Role-specific navigation item definitions.
 * Each entry has:
 *   to    — the route path
 *   label — i18n key for the link text
 *   icon  — emoji icon displayed to the left of the label
 *
 * Roles:
 *   client     — dashboard, my trips, new trip
 *   driver     — dashboard, available trips, my trips, earnings, documents
 *   operator   — dashboard, users, drivers, operators, all trips, phone intake
 *   superadmin — everything operator has + user management + configuration
 */
const NAV = {
  client: [
    { to: '/client',            label: 'nav.dashboard',       icon: '🏠' },
    { to: '/client/trips',      label: 'nav.my_trips',        icon: '🗺️' },
    { to: '/client/trips/new',  label: 'nav.new_trip',        icon: '➕' },
    { to: '/client/payments',   label: 'nav.payment_history', icon: '💳' },
    { to: '/messages',          label: 'nav.messages',        icon: '💬', badge: 'messages' },
    { to: '/client/reviews',    label: 'nav.reviews',         icon: '⭐' },
  ],
  driver: [
    { to: '/driver',            label: 'nav.dashboard',      icon: '🏠' },
    { to: '/driver/available',  label: 'nav.available_trips',icon: '📍' },
    { to: '/driver/my-trips',   label: 'nav.my_trips',       icon: '🗺️' },
    { to: '/driver/earnings',   label: 'nav.earnings',       icon: '💰' },
    { to: '/driver/documents',  label: 'nav.documents',      icon: '📄' },
    { to: '/messages',          label: 'nav.messages',       icon: '💬', badge: 'messages' },
    { to: '/driver/reviews',    label: 'nav.reviews',        icon: '⭐' },
  ],
  operator: [
    { to: '/admin',               label: 'nav.dashboard',   icon: '🏠' },
    { to: '/admin/users',         label: 'nav.users',       icon: '👥' },
    { to: '/admin/drivers',       label: 'nav.drivers',     icon: '🚗' },
    { to: '/admin/operators',     label: 'nav.operators',   icon: '🎧' },
    { to: '/admin/trips',         label: 'nav.all_trips',   icon: '🗺️' },
    { to: '/admin/phone-intake',  label: 'nav.phone_intake',icon: '📞' },
    { to: '/admin/reviews',       label: 'nav.reviews',     icon: '⭐', badge: 'reviews' },
  ],
  superadmin: [
    { to: '/admin',                   label: 'nav.dashboard',      icon: '🏠' },
    { to: '/admin/users',             label: 'nav.users',          icon: '👥' },
    { to: '/admin/drivers',           label: 'nav.drivers',        icon: '🚗' },
    { to: '/admin/operators',         label: 'nav.operators',      icon: '🎧' },
    { to: '/admin/trips',             label: 'nav.all_trips',      icon: '🗺️' },
    { to: '/admin/phone-intake',      label: 'nav.phone_intake',   icon: '📞' },
    { to: '/admin/reviews',           label: 'nav.reviews',        icon: '⭐', badge: 'reviews' },
    { to: '/admin/user-management',   label: 'nav.user_management',icon: '🔧' },
    { to: '/admin/configuration',     label: 'nav.configuration',  icon: '⚙️' },
    { to: '/ticket-master/config',    label: 'nav.tickets_config', icon: '⚙️' },
  ],
  ticket_master: [
    { to: '/ticket-master',           label: 'nav.dashboard',        icon: '🏠' },
    { to: '/ticket-master/notebooks', label: 'nav.tickets',          icon: '📒' },
    { to: '/ticket-master/trips',     label: 'nav.tickets_trips',    icon: '🗺️' },
    { to: '/ticket-master/reports',   label: 'nav.tickets_reports',  icon: '📊' },
    { to: '/ticket-master/config',    label: 'nav.tickets_config',   icon: '⚙️' },
  ],
};

/**
 * Layout — main authenticated app shell.
 *
 * Reads the current user from AuthContext to:
 *   - Determine which NAV entries to render
 *   - Build the profile link path (role-prefixed, e.g. /driver/profile)
 *   - Display initials in the avatar circle
 */
export default function Layout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { langConfig, locked, currentLang, switchLanguage } = useLanguage();
  const { appName } = useAppConfig();
  const navigate = useNavigate();

  // Unread message count — polled every 30 s for client and driver roles only
  const [unreadMessages, setUnreadMessages] = useState(0);
  useEffect(() => {
    if (!['client', 'driver'].includes(user?.role)) return;
    const fetchCount = () => {
      messageService.unreadCount()
        .then(({ data }) => setUnreadMessages(data.count || 0))
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30000);
    window.addEventListener('messages-read', fetchCount);
    return () => {
      clearInterval(interval);
      window.removeEventListener('messages-read', fetchCount);
    };
  }, [user?.role]);

  // App version — fetched once on mount from the public /api/version endpoint
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    versionService.get()
      .then(({ data }) => setAppVersion(data.app ?? ''))
      .catch(() => {});
  }, []);

  // Pending review count — polled every 60 s for operator and superadmin only
  const [pendingReviews, setPendingReviews] = useState(0);
  useEffect(() => {
    if (!['operator', 'superadmin'].includes(user?.role)) return;
    const fetchCount = () => {
      reviewService.pendingCount()
        .then(({ data }) => setPendingReviews(data.count || 0))
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 60000);
    return () => clearInterval(interval);
  }, [user?.role]);

  // Look up the nav items for the current user's role (empty array for unknown roles)
  const navItems = NAV[user?.role] || [];

  // Profile path differs by role
  const profilePath = user?.role === 'client'       ? '/client/profile'
                    : user?.role === 'driver'        ? '/driver/profile'
                    : user?.role === 'ticket_master' ? '/ticket-master/profile'
                    : '/admin/profile';

  // Two-letter avatar initials from the user's first and last name
  const initials = user ? `${user.first_name[0]}${user.last_name[0]}`.toUpperCase() : '??';

  /** Log out and navigate to the login page. */
  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      {/* ── Sidebar ──────────────────────────────────────── */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col flex-shrink-0 dark:bg-gray-800 dark:border-gray-700">

        {/* Logo — clock icon + "SolidaRoute" wordmark */}
        <div className="h-14 flex items-center px-4 border-b border-gray-100 dark:border-gray-700">
          <div className="w-7 h-7 bg-teal-600 rounded-lg flex items-center justify-center mr-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
          </div>
          <span className="font-bold text-gray-900 text-sm dark:text-gray-100">{appName}</span>
        </div>

        {/* Nav links — role-specific list from the NAV map above */}
        <nav className="flex-1 py-3 overflow-y-auto">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              // `end` is true for shallow routes (e.g. /driver) so the parent path
              // doesn't stay "active" when the user is on /driver/available
              end={item.to.split('/').length <= 2}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                  isActive
                    ? 'text-teal-700 bg-teal-50 font-medium dark:text-teal-300 dark:bg-teal-900/30'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700/50'
                }`
              }>
              <span className="text-base">{item.icon}</span>
              <span className="flex-1">{t(item.label)}</span>
              {/* Unread messages badge */}
              {item.badge === 'messages' && unreadMessages > 0 && (
                <span className="w-5 h-5 rounded-full bg-teal-600 text-white text-xs
                                 font-bold flex items-center justify-center flex-shrink-0">
                  {unreadMessages > 9 ? '9+' : unreadMessages}
                </span>
              )}
              {/* Pending reviews badge */}
              {item.badge === 'reviews' && pendingReviews > 0 && (
                <span className="w-5 h-5 rounded-full bg-amber-500 text-white text-xs
                                 font-bold flex items-center justify-center flex-shrink-0">
                  {pendingReviews > 9 ? '9+' : pendingReviews}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Language selector — only visible when admin configured 'both' and not locked */}
        {langConfig === 'both' && !locked && (
          <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-700 flex gap-2">
            <button
              onClick={() => switchLanguage('fr')}
              className={`flex-1 text-xs py-1 rounded-lg transition-colors font-medium ${
                currentLang === 'fr'
                  ? 'bg-teal-600 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600'
              }`}>
              FR
            </button>
            <button
              onClick={() => switchLanguage('en')}
              className={`flex-1 text-xs py-1 rounded-lg transition-colors font-medium ${
                currentLang === 'en'
                  ? 'bg-teal-600 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600'
              }`}>
              EN
            </button>
          </div>
        )}

        {/* User footer — avatar + name + role + email, clicking goes to profile */}
        <div className="border-t border-gray-100 dark:border-gray-700 p-3">
          <button
            onClick={() => navigate(profilePath)}
            className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors group text-left">
            {/* Avatar circle with initials — same teal style as the logo */}
            <div className="w-7 h-7 rounded-full bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center
                            text-teal-700 dark:text-teal-300 font-semibold text-xs flex-shrink-0">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              {/* Name highlights teal on hover to signal the button is clickable */}
              <div className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate group-hover:text-teal-700 dark:group-hover:text-teal-300">
                {user?.first_name} {user?.last_name}
              </div>
              {/* Role label — superadmin shown as "Administrator" for a cleaner look */}
              <div className="text-xs text-teal-600 dark:text-teal-400 font-medium truncate">
                {user?.role === 'superadmin'
                  ? t('roles.administrator')
                  : t(`roles.${user?.role}`, { defaultValue: user?.role })}
              </div>
              <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{user?.email}</div>
            </div>
            {/* Pencil icon affordance — signals the button leads to profile edit */}
            <span className="text-gray-300 group-hover:text-teal-400 text-xs">✏️</span>
          </button>
          {/* Logout button — separate from the profile button to avoid accidental clicks */}
          <button
            onClick={handleLogout}
            className="w-full text-left text-xs text-gray-400 hover:text-red-500 px-2 py-1 mt-1 transition-colors">
            {t('nav.logout')}
          </button>
        </div>

        {/* Legal footer — copyright + version + Privacy Policy + Terms of Service */}
        <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-300 dark:text-gray-600 mb-1">
            © {new Date().getFullYear()} {appName}
            {appVersion && <span className="ml-1 text-gray-200 dark:text-gray-700">v{appVersion}</span>}
          </p>
          <div className="flex gap-2">
            <Link to="/privacy" target="_blank"
              className="text-xs text-gray-300 dark:text-gray-600 hover:text-teal-500 transition-colors">
              {t('footer.privacy')}
            </Link>
            <span className="text-xs text-gray-200 dark:text-gray-700">·</span>
            <Link to="/terms" target="_blank"
              className="text-xs text-gray-300 dark:text-gray-600 hover:text-teal-500 transition-colors">
              {t('footer.terms')}
            </Link>
          </div>
        </div>
      </aside>

      {/* ── Main content area ─────────────────────────────── */}
      {/* overflow-y-auto: only this panel scrolls, not the sidebar */}
      <main className="flex-1 overflow-y-auto p-6">
        {/* <Outlet /> renders the matched child route component here */}
        <Outlet />
      </main>
    </div>
  );
}
