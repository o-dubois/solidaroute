/**
 * Axios API Client  —  services/api.js
 *
 * Central HTTP service layer for all SolidaRoute API calls.
 * All components import their service objects from here rather than calling
 * Axios directly, keeping API endpoint strings in one place.
 *
 * Base URL auto-detection:
 *   Port 3000/3001 (Vite dev / serve) → backend on port 4000 (same host)
 *   Port 80/443 (Nginx production)    → proxied at /api on the same origin
 *   This removes the need for .env.production files and works with any hostname.
 *
 * Request interceptor:
 *   Injects the JWT Bearer token from localStorage ('sr_token') into every
 *   outgoing request. If no token is present, the header is simply omitted.
 *
 * Response interceptor:
 *   401 — Clears stored credentials and redirects to /login, BUT only when
 *          the current page is not a public route (login/register/verify-email).
 *          This prevents redirect loops when submitting the login form itself.
 *   422 — Validation errors are intentionally NOT toasted here; components
 *          handle them themselves to show field-level messages.
 *   Other errors — A global toast is shown with the server's error message.
 *
 * Service groups:
 *   authService         — login, register, verify email, password rules
 *   profileService      — get/update profile, change password, delete account
 *   tripService         — stats, CRUD, accept/decline/complete
 *   driverService       — availability toggle, earnings, nearby/search
 *   paymentService      — list and detail
 *   notificationService — list, mark read
 *   documentService     — list, upload (multipart), view (blob)
 *   adminService        — full admin panel operations
 */
import axios from 'axios';
import toast from 'react-hot-toast';

/**
 * detectApiUrl — determine the correct backend base URL at runtime.
 *
 * In development (Vite on :3000 or :3001) the backend runs on :4000.
 * In production the Nginx server proxies /api to the backend, so a relative
 * URL is used. This function is also exported so non-Axios callers (like
 * AddressAutocomplete's fetch call) can use the same URL detection logic.
 */
export function detectApiUrl() {
  const { protocol, host } = window.location;
  const port = window.location.port;
  if (port === '3000' || port === '3001') {
    // Dev: rewrite the port from 3000/3001 to 4000, keep the same hostname
    return `${protocol}//${host.replace(':3000', ':4000').replace(':3001', ':4000')}/api`;
  }
  // Production: use Nginx proxy at /api on the same origin
  return '/api';
}

/**
 * The shared Axios instance used by all service objects below.
 * timeout: 15 s — generous enough for file uploads, strict enough to surface hangs.
 */
const api = axios.create({
  baseURL: detectApiUrl(),
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Request interceptor — inject JWT token.
 * Reads 'sr_token' from localStorage on every request so that token changes
 * (e.g. after refresh) are picked up automatically without recreating the instance.
 */
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('sr_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * Public routes that should never trigger a redirect on 401.
 * These pages make API calls while the user is not logged in, so a 401 is
 * expected and should not bounce the user to /login in a loop.
 */
const PUBLIC_PATHS = ['/login', '/register', '/verify-email'];

/**
 * Response interceptor — global error handling.
 *
 * 401: clear credentials + redirect to /login (protected pages only)
 * 422: pass through silently — components handle field validation errors
 * Other: show a toast with the server's error message
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = error.response?.data?.error || 'Server connection error.';
    if (error.response?.status === 401) {
      const currentPath = window.location.pathname;
      const isPublicPage = PUBLIC_PATHS.some(p => currentPath.startsWith(p));
      if (!isPublicPage) {
        // Only redirect to login when on a protected page
        localStorage.removeItem('sr_token');
        localStorage.removeItem('sr_user');
        window.location.href = '/login';
      }
    } else if (error.response?.status !== 422) {
      // 422 errors are handled per-component; all other errors get a global toast
      toast.error(message);
    }
    return Promise.reject(error);
  }
);

// ── Auth ──────────────────────────────────────────────────────

/**
 * authService — authentication and account management endpoints.
 *   login              — POST /auth/login      → { token, user }
 *   register           — POST /auth/register   → triggers verification email
 *   me                 — GET  /auth/me         → current user object (token refresh)
 *   passwordRules      — GET  /auth/password-rules → rule config for PasswordStrength
 *   resendVerification — POST /auth/resend-verification → sends a new email link
 */
export const authService = {
  login:              (data) => api.post('/auth/login', data),
  register:           (data) => api.post('/auth/register', data),
  me:                 ()     => api.get('/auth/me'),
  passwordRules:      ()     => api.get('/auth/password-rules'),
  resendVerification: (data) => api.post('/auth/resend-verification', data),
};

// ── Profile ───────────────────────────────────────────────────

/**
 * profileService — authenticated user's own profile management.
 *   get            — GET    /profile
 *   update         — PUT    /profile          → first name, last name, phone
 *   updateClient   — PUT    /profile/client   → client-specific fields
 *   updateDriver   — PUT    /profile/driver   → driver vehicle + address fields
 *   changePassword — PUT    /profile/password → requires current_password
 *   checkDeletion  — GET    /profile/check-deletion → { anonymize_only, reason }
 *   deleteAccount  — DELETE /profile          → hard delete or anonymize
 */
export const profileService = {
  get:             ()     => api.get('/profile'),
  update:          (data) => api.put('/profile', data),
  updateClient:    (data) => api.put('/profile/client', data),
  updateDriver:    (data) => api.put('/profile/driver', data),
  changePassword:  (data) => api.put('/profile/password', data),
  checkDeletion:   ()     => api.get('/profile/check-deletion'),
  deleteAccount:   (data) => api.delete('/profile', { data }),
};

// ── Trips ─────────────────────────────────────────────────────

/**
 * tripService — trip lifecycle operations.
 *   stats     — GET   /trips/stats          → dashboard counters + profile
 *   estimate  — POST  /trips/estimate       → cost/duration estimate before booking
 *   create    — POST  /trips                → book a new trip
 *   myTrips   — GET   /trips/my-trips       → trips for the logged-in user (filtered by status)
 *   available — GET   /trips/available      → pending trips within a radius band (drivers)
 *   accept    — PATCH /trips/:id/accept     → driver claims a trip
 *   decline   — PATCH /trips/:id/decline    → driver passes on a trip
 *   complete  — PATCH /trips/:id/complete   → driver marks a trip as completed
 *   cancel    — PATCH /trips/:id/cancel     → cancel a trip (with optional reason)
 *   detail    — GET   /trips/:id            → full trip object
 */
export const tripService = {
  stats:        ()         => api.get('/trips/stats'),
  estimate:     (data)     => api.post('/trips/estimate', data),
  create:       (data)     => api.post('/trips', data),
  myTrips:      (params)   => api.get('/trips/my-trips', { params }),
  available:    (params)   => api.get('/trips/available', { params }),
  accept:       (id, data = {}) => api.patch(`/trips/${id}/accept`, data),
  decline:      (id)       => api.patch(`/trips/${id}/decline`),
  complete:     (id)       => api.patch(`/trips/${id}/complete`),
  cancel:       (id, data) => api.patch(`/trips/${id}/cancel`, data),
  detail:       (id)       => api.get(`/trips/${id}`),
};

// ── Drivers ───────────────────────────────────────────────────

/**
 * driverService — driver-specific endpoints.
 *   setAvailability — PATCH /drivers/availability → toggle is_available flag
 *   earnings        — GET   /drivers/earnings     → completed trips with earned amounts
 *   nearby          — GET   /drivers/nearby       → drivers within a radius (operator use)
 *   search          — GET   /drivers/search       → search drivers by name/location
 */
export const driverService = {
  setAvailability: (data)   => api.patch('/drivers/availability', data),
  earnings:        ()       => api.get('/drivers/earnings'),
  nearby:              (params)       => api.get('/drivers/nearby', { params }),
  search:              (q, lat, lon)  => api.get('/drivers/search', { params: { q, lat, lon } }),
  checkAvailability:   (id, params)   => api.get(`/drivers/${id}/availability-check`, { params }),
};

// ── Payments ──────────────────────────────────────────────────

/**
 * paymentService — payment management endpoints.
 *
 * Read endpoints:
 *   list        — GET  /payments           → all payments for the current user
 *   detail      — GET  /payments/:id       → single payment record
 *
 * Stripe SetupIntent flow (off-session charge after trip completion):
 *   setupIntent — POST /payments/setup-intent        → creates a Stripe SetupIntent;
 *                 returns { client_secret, payment_id }
 *   confirm     — POST /payments/confirm             → records the saved PaymentMethod
 *                 against the trip after stripe.confirmCardSetup succeeds on the client
 *
 * Manual payment flow (operator cash/cheque intake):
 *   manual      — POST /payments/manual              → records a manual payment reference
 *
 * Post-trip charge / refund (operator actions):
 *   charge      — POST /payments/charge/:tripId      → triggers the off-session charge
 *   refund      — POST /payments/refund/:tripId      → issues a full refund via Stripe
 */
export const paymentService = {
  list:        (params = {})                     => api.get('/payments', { params }),
  detail:      (id)                             => api.get(`/payments/${id}`),
  setupIntent: (tripId)                         => api.post('/payments/setup-intent', { trip_id: tripId }),
  confirm:     (paymentId, setupIntentId, pmId) => api.post('/payments/confirm', {
    payment_id:        paymentId,
    setup_intent_id:   setupIntentId,
    payment_method_id: pmId,
  }),
  manual:      (tripId, reference, note)        => api.post('/payments/manual', {
    trip_id:           tripId,
    payment_reference: reference,
    operator_note:     note,
  }),
  charge:      (tripId)                         => api.post(`/payments/charge/${tripId}`),
  refund:      (tripId)                         => api.post(`/payments/refund/${tripId}`),
};

// ── Notifications ─────────────────────────────────────────────

/**
 * notificationService — in-app notification management.
 *   list       — GET   /notifications            → unread + recent notifications
 *   markRead   — PATCH /notifications/:id/read   → mark one as read
 *   markAllRead — PATCH /notifications/read-all  → clear all unread
 */
export const notificationService = {
  list:      ()    => api.get('/notifications'),
  markRead:  (id)  => api.patch(`/notifications/${id}/read`),
  markAllRead: ()  => api.patch('/notifications/read-all'),
};

// ── Documents ─────────────────────────────────────────────────

/**
 * documentService — driver document upload and retrieval.
 *   list   — GET  /documents          → all uploaded documents for the driver
 *   upload — POST /documents/:type    → multipart upload; type = license|insurance|registration
 *   view   — GET  /documents/:type    → returns the decrypted file as a binary blob
 *
 * upload: sets Content-Type to multipart/form-data so the backend receives
 * the file correctly. The Axios instance default is JSON, so we override it here.
 */
export const documentService = {
  list:        ()                  => api.get('/documents'),
  deleteType:  (type)              => api.delete(`/documents/${type}`),
  upload:      (type, slot, file)  => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/documents/${type}/${slot}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  // responseType: 'blob' tells Axios to treat the response body as binary data
  view:     (type, slot)        => api.get(`/documents/${type}/${slot}`, { responseType: 'blob' }),
};

// ── Admin ─────────────────────────────────────────────────────

/**
 * adminService — operator and superadmin panel operations.
 *
 * User management:
 *   dashboard      — GET    /admin/dashboard           → aggregate stats
 *   users          — GET    /admin/users               → paginated user list
 *   userDetail     — GET    /admin/users/:id
 *   updateStatus   — PATCH  /admin/users/:id/status    → activate/suspend/delete
 *   changePassword — PATCH  /admin/users/:id/password  → admin password reset
 *   deleteUser     — DELETE /admin/users/:id
 *
 * Driver management:
 *   drivers        — GET    /admin/drivers             → all drivers with stats
 *   driverDetail   — GET    /admin/drivers/:id
 *   approveDriver  — PATCH  /admin/drivers/:id/approve → approve or reject with note
 *
 * Trip management:
 *   trips          — GET    /admin/trips               → all trips (filterable)
 *   assignDriver   — PATCH  /admin/trips/:id/assign    → manually assign a driver
 *
 * Configuration:
 *   getConfig      — GET    /admin/configuration       → all config key-value pairs
 *   updateConfig   — PUT    /admin/configuration/:key  → update a single config value
 *
 * Document review:
 *   driverDocuments — GET   /admin/drivers/:id/documents
 *   driverDocView   — GET   /admin/drivers/:id/documents/:type  (blob)
 *
 * Operator management:
 *   createOperator — POST   /admin/operators
 *   updateOperator — PATCH  /admin/operators/:id
 *   deleteOperator — DELETE /admin/operators/:id
 */
export const adminService = {
  dashboard:       ()         => api.get('/admin/dashboard'),
  users:           (params)   => api.get('/admin/users', { params }),
  userDetail:      (id)       => api.get(`/admin/users/${id}`),
  updateStatus:    (id, data) => api.patch(`/admin/users/${id}/status`, data),
  changePassword:  (id, data) => api.patch(`/admin/users/${id}/password`, data),
  deleteUser:      (id)       => api.delete(`/admin/users/${id}`),
  drivers:         ()         => api.get('/admin/drivers'),
  driverDetail:    (id)       => api.get(`/admin/drivers/${id}`),
  approveDriver:        (id, data) => api.patch(`/admin/drivers/${id}/approve`, data),
  approveDriverOverride:(id)       => api.patch(`/admin/drivers/${id}/approve-override`),
  trips:           (params)   => api.get('/admin/trips', { params }),
  assignDriver:    (id, data) => api.patch(`/admin/trips/${id}/assign`, data),
  cancelCompleted: (id)       => api.patch(`/admin/trips/${id}/cancel-completed`),
  getConfig:           ()         => api.get('/admin/configuration'),
  updateConfig:        (key, val) => api.put(`/admin/configuration/${key}`, { value: val }),
  driverDocuments:     (id)            => api.get(`/admin/drivers/${id}/documents`),
  driverDocView:       (id, type, slot) => api.get(`/admin/drivers/${id}/documents/${type}/${slot}`, { responseType: 'blob' }),
  createOperator:      (data)     => api.post('/admin/operators', data),
  updateOperator:      (id, data) => api.patch(`/admin/operators/${id}`, data),
  deleteOperator:      (id)       => api.delete(`/admin/operators/${id}`),
};

// ── Tickets ───────────────────────────────────────────────────

/**
 * ticketService — mobility ticket inventory management.
 *
 * Ticket Master operations:
 *   notebooks      — GET   /tickets/notebooks         → all notebooks with ticket counts
 *   createNotebook — POST  /tickets/notebooks         → create notebook of 10 tickets
 *   notebook       — GET   /tickets/notebooks/:id     → notebook detail + tickets
 *   voidTicket     — PATCH /tickets/:number/void      → void a ticket
 *   trips          — GET   /tickets/trips             → trips paid by mobility tickets
 *
 * Client operations:
 *   myTickets    — GET  /tickets/my-tickets             → client's available tickets
 *   forTrip      — GET  /tickets/for-trip/:tripId       → required count + available tickets
 *   reserve      — POST /tickets/reserve                → reserve tickets for a trip
 *   release      — POST /tickets/release/:tripId        → release reserved tickets
 */
export const ticketService = {
  notebooks:      ()           => api.get('/tickets/notebooks'),
  createNotebook: (data)       => api.post('/tickets/notebooks', data),
  notebook:       (id)         => api.get(`/tickets/notebooks/${id}`),
  voidTicket:     (number)     => api.patch(`/tickets/${number}/void`),
  trips:          (params)     => api.get('/tickets/trips', { params }),
  usedReport:     (from, to)  => api.get('/tickets/reports/used', { params: { from, to } }),
  myTickets:      ()           => api.get('/tickets/my-tickets'),
  forTrip:        (tripId)     => api.get(`/tickets/for-trip/${tripId}`),
  reserve:        (data)       => api.post('/tickets/reserve', data),
  release:        (tripId)     => api.post(`/tickets/release/${tripId}`),
};

// ── Messages ──────────────────────────────────────────────────

/**
 * messageService — in-app trip messaging between driver and client.
 *   conversations — GET /messages              → all conversations for the current user
 *   thread        — GET /messages/trip/:id     → full thread + marks incoming as read
 *   send          — POST /messages/trip/:id    → send a message (body ≤ 500 chars)
 *   unreadCount   — GET /messages/unread-count → total unread for nav badge
 */
export const messageService = {
  conversations: ()              => api.get('/messages'),
  thread:        (tripId)        => api.get(`/messages/trip/${tripId}`),
  send:          (tripId, body)  => api.post(`/messages/trip/${tripId}`, { body }),
  unreadCount:   ()              => api.get('/messages/unread-count'),
};

/**
 * reviewService — post-trip reviews with moderation.
 *   submit       — POST /reviews                  → submit a review (pending)
 *   forTrip      — GET  /reviews/trip/:id         → approved reviews + my review for a trip
 *   mine         — GET  /reviews/mine             → given + received reviews
 *   pending      — GET  /reviews/pending          → moderation queue (admin)
 *   pendingCount — GET  /reviews/pending-count    → count for nav badge (admin)
 *   approve      — PATCH /reviews/:id/approve     → approve a review
 *   reject       — PATCH /reviews/:id/reject      → reject a review
 */
export const reviewService = {
  submit:       (data)  => api.post('/reviews', data),
  forTrip:      (tripId) => api.get(`/reviews/trip/${tripId}`),
  mine:         ()      => api.get('/reviews/mine'),
  pending:      ()      => api.get('/reviews/pending'),
  pendingCount: ()      => api.get('/reviews/pending-count'),
  approve:      (id)    => api.patch(`/reviews/${id}/approve`),
  reject:       (id)    => api.patch(`/reviews/${id}/reject`),
};

// ── Version ───────────────────────────────────────────────────
export const versionService = {
  get: () => api.get('/version'),
};

export default api;
