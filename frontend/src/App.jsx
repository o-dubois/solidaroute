/**
 * Application Router
 *
 * Defines the route tree and access control for all pages.
 * Wrapped in AuthProvider (global auth state) and LanguageProvider (i18n).
 *
 * Route structure:
 *   /login, /register, /verify-email  — Public, no auth required
 *   /client/*                          — Protected, role: 'client'
 *   /driver/*                          — Protected, role: 'driver'
 *   /admin/*                           — Protected, role: 'operator' | 'superadmin'
 *   /                                  — Redirects to the correct dashboard by role
 *   *                                  — Fallback redirect to /
 *
 * ProtectedRoute checks:
 *   1. If loading → show a spinner (prevents flash of redirect)
 *   2. If not authenticated → redirect to /login
 *   3. If wrong role → redirect to /
 */
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { AppConfigProvider } from './context/AppConfigContext';
import Layout from './components/layout/Layout';

// Public pages
import Login            from './pages/Login';
import Register         from './pages/Register';
import VerifyEmail      from './pages/VerifyEmail';
import ForgotPassword   from './pages/ForgotPassword';
import ResetPassword    from './pages/ResetPassword';
import PrivacyPolicy    from './pages/PrivacyPolicy';
import TermsOfService   from './pages/TermsOfService';
import DriverTripAction from './pages/DriverTripAction';

// Shared
import MyProfile        from './pages/MyProfile';

// Client pages
import ClientDashboard  from './pages/client/Dashboard';
import MyTrips          from './pages/client/MyTrips';
import NewTrip          from './pages/client/NewTrip';
import TripDetail       from './pages/client/TripDetail';
import PaymentHistory   from './pages/client/PaymentHistory';

// Driver pages
import DriverDashboard  from './pages/driver/Dashboard';
import AvailableTrips   from './pages/driver/AvailableTrips';
import DriverMyTrips    from './pages/driver/MyTrips';
import Earnings         from './pages/driver/Earnings';
import DriverDocumentsPage from './pages/driver/Documents';

// Admin pages
import AdminDashboard      from './pages/admin/Dashboard';
import UserManagement      from './pages/admin/UserManagement';
import DriverManagement    from './pages/admin/DriverManagement';
import OperatorManagement  from './pages/admin/OperatorManagement';
import AllTrips            from './pages/admin/AllTrips';
import PhoneIntake         from './pages/admin/PhoneIntake';
import Configuration       from './pages/admin/Configuration';
import DriverDocuments     from './pages/admin/DriverDocuments';
import AdminUserManagement from './pages/admin/AdminUserManagement';

// Messages pages (shared: client + driver)
import MessagesList from './pages/messages/MessagesList';
import TripChat     from './pages/messages/TripChat';

// Reviews
import MyReviews         from './pages/reviews/MyReviews';
import ReviewModeration  from './pages/admin/ReviewModeration';

// Ticket Master pages
import TicketMasterDashboard from './pages/ticketmaster/Dashboard';
import Notebooks             from './pages/ticketmaster/Notebooks';
import NotebookDetail        from './pages/ticketmaster/NotebookDetail';
import TicketTrips           from './pages/ticketmaster/TicketTrips';
import TicketConfig          from './pages/ticketmaster/TicketConfig';
import TicketReport          from './pages/ticketmaster/TicketReport';

function ProtectedRoute({ roles, children }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="flex items-center justify-center h-screen text-gray-400">
      Loading…
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function HomeRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'client')        return <Navigate to="/client"        replace />;
  if (user.role === 'driver')        return <Navigate to="/driver"        replace />;
  if (user.role === 'ticket_master') return <Navigate to="/ticket-master" replace />;
  return <Navigate to="/admin" replace />;
}

export default function App() {
  return (
    <AppConfigProvider>
      <AuthProvider>
      <LanguageProvider>
        <Routes>
          {/* Public */}
          <Route path="/login"            element={<Login />} />
          <Route path="/register"         element={<Register />} />
          <Route path="/verify-email"     element={<VerifyEmail />} />
          <Route path="/forgot-password"  element={<ForgotPassword />} />
          <Route path="/reset-password"   element={<ResetPassword />} />
          <Route path="/privacy"          element={<PrivacyPolicy />} />
          <Route path="/terms"            element={<TermsOfService />} />
          <Route path="/driver-action"    element={<DriverTripAction />} />
          <Route path="/"                 element={<HomeRedirect />} />

          {/* Client */}
          <Route path="/client" element={
            <ProtectedRoute roles={['client']}>
              <Layout />
            </ProtectedRoute>
          }>
            <Route index                  element={<ClientDashboard />} />
            <Route path="profile"         element={<MyProfile />} />
            <Route path="trips"           element={<MyTrips />} />
            <Route path="trips/new"       element={<NewTrip />} />
            <Route path="trips/:id"       element={<TripDetail />} />
            <Route path="payments"        element={<PaymentHistory />} />
            <Route path="reviews"         element={<MyReviews />} />
          </Route>

          {/* Driver */}
          <Route path="/driver" element={
            <ProtectedRoute roles={['driver']}>
              <Layout />
            </ProtectedRoute>
          }>
            <Route index                  element={<DriverDashboard />} />
            <Route path="profile"         element={<MyProfile />} />
            <Route path="available"       element={<AvailableTrips />} />
            <Route path="my-trips"        element={<DriverMyTrips />} />
            <Route path="earnings"        element={<Earnings />} />
            <Route path="documents"       element={<DriverDocumentsPage />} />
            <Route path="reviews"         element={<MyReviews />} />
          </Route>

          {/* Admin / Operator */}
          <Route path="/admin" element={
            <ProtectedRoute roles={['operator', 'superadmin']}>
              <Layout />
            </ProtectedRoute>
          }>
            <Route index                  element={<AdminDashboard />} />
            <Route path="profile"         element={<MyProfile />} />
            <Route path="users"           element={<UserManagement />} />
            <Route path="operators"       element={<OperatorManagement />} />
            <Route path="drivers"         element={<DriverManagement />} />
            <Route path="trips"           element={<AllTrips />} />
            <Route path="phone-intake"    element={<PhoneIntake />} />
            <Route path="configuration"         element={<Configuration />} />
            <Route path="user-management"       element={<AdminUserManagement />} />
            <Route path="drivers/:id/documents" element={<DriverDocuments />} />
            <Route path="reviews"               element={<ReviewModeration />} />
          </Route>

          {/* Ticket Master — parent allows ticket_master + superadmin (for config page) */}
          <Route path="/ticket-master" element={
            <ProtectedRoute roles={['ticket_master', 'superadmin']}>
              <Layout />
            </ProtectedRoute>
          }>
            {/* ticket_master only */}
            <Route index element={
              <ProtectedRoute roles={['ticket_master']}><TicketMasterDashboard /></ProtectedRoute>
            } />
            <Route path="profile" element={
              <ProtectedRoute roles={['ticket_master']}><MyProfile /></ProtectedRoute>
            } />
            <Route path="notebooks" element={
              <ProtectedRoute roles={['ticket_master']}><Notebooks /></ProtectedRoute>
            } />
            <Route path="notebooks/:id" element={
              <ProtectedRoute roles={['ticket_master']}><NotebookDetail /></ProtectedRoute>
            } />
            <Route path="trips" element={
              <ProtectedRoute roles={['ticket_master']}><TicketTrips /></ProtectedRoute>
            } />
            <Route path="reports" element={
              <ProtectedRoute roles={['ticket_master']}><TicketReport /></ProtectedRoute>
            } />
            {/* config accessible to ticket_master + operator + superadmin */}
            <Route path="config" element={<TicketConfig />} />
          </Route>

          {/* Messages — shared route accessible by client and driver */}
          <Route path="/messages" element={
            <ProtectedRoute roles={['client', 'driver']}>
              <Layout />
            </ProtectedRoute>
          }>
            <Route index           element={<MessagesList />} />
            <Route path="trip/:id" element={<TripChat />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </LanguageProvider>
      </AuthProvider>
    </AppConfigProvider>
  );
}
