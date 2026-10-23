/**
 * Axios API client for the mobile app.
 *
 * Same REST API as the web frontend — only the base URL detection and
 * token storage differ (SecureStore instead of localStorage).
 *
 * The request interceptor reads the token from SecureStore synchronously
 * via a module-level variable that is kept in sync by AuthContext.
 * (SecureStore is async-only, so we cache the token in memory after login.)
 */
import axios from 'axios';
import { API_URL } from '../config';

// In-memory token cache — set by AuthContext after login/restore.
// Avoids async overhead on every request while staying in sync with SecureStore.
let _token = null;
export function setMemoryToken(t) { _token = t; }
export function clearMemoryToken()  { _token = null; }

const api = axios.create({
  baseURL: API_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Inject JWT on every request
api.interceptors.request.use(config => {
  if (_token) config.headers.Authorization = `Bearer ${_token}`;
  return config;
});

// ── Auth ─────────────────────────────────────────────────────────
export const authService = {
  login:              (data) => api.post('/auth/login', data),
  register:           (data) => api.post('/auth/register', data),
  me:                 ()     => api.get('/auth/me'),
  passwordRules:      ()     => api.get('/auth/password-rules'),
  resendVerification: (data) => api.post('/auth/resend-verification', data),
  forgotPassword:     (data) => api.post('/auth/forgot-password', data),
};

// ── Public config ─────────────────────────────────────────────────
export const configService = {
  public: () => api.get('/admin/configuration/public'),
};

// ── Trips ─────────────────────────────────────────────────────────
export const tripService = {
  stats:     ()         => api.get('/trips/stats'),
  myTrips:   (params)   => api.get('/trips/my-trips', { params }),
  available: (params)   => api.get('/trips/available', { params }),
  detail:    (id)       => api.get(`/trips/${id}`),
  accept:    (id, data) => api.patch(`/trips/${id}/accept`, data ?? {}),
  decline:   (id)       => api.patch(`/trips/${id}/decline`),
  complete:  (id)       => api.patch(`/trips/${id}/complete`),
  cancel:    (id, data) => api.patch(`/trips/${id}/cancel`, data),
  estimate:      (data) => api.post('/trips/estimate', data),
  create:        (data) => api.post('/trips', data),
  addressSearch:    (q) => api.get('/trips/address-search',   { params: { q } }),
  recentAddresses:  ()  => api.get('/trips/recent-addresses'),
};

// ── Driver ────────────────────────────────────────────────────────
export const driverService = {
  setAvailability:   (data)          => api.patch('/drivers/availability', data),
  earnings:          ()              => api.get('/drivers/earnings'),
  nearby:            (lat, lon)      => api.get('/drivers/nearby', { params: { lat, lon } }),
  search:            (q, lat, lon)   => api.get('/drivers/search', {
    params: { q, ...(lat != null && lon != null ? { lat, lon } : {}) },
  }),
  availabilityCheck: (id, params)    => api.get(`/drivers/${id}/availability-check`, { params }),
};

// ── Tickets (mobility) ────────────────────────────────────────────
export const ticketService = {
  myTickets: ()     => api.get('/tickets/my-tickets'),
  forTrip:   (id)   => api.get(`/tickets/for-trip/${id}`),
  reserve:   (data) => api.post('/tickets/reserve', data),
};

// ── Payments ──────────────────────────────────────────────────────
export const paymentService = {
  setupIntent: (data) => api.post('/payments/setup-intent', data),
  confirm:     (data) => api.post('/payments/confirm', data),
};

// ── Messages ──────────────────────────────────────────────────────
export const messageService = {
  conversations: ()             => api.get('/messages'),
  thread:        (tripId)       => api.get(`/messages/trip/${tripId}`),
  send:          (tripId, body) => api.post(`/messages/trip/${tripId}`, { body }),
  unreadCount:   ()             => api.get('/messages/unread-count'),
};

// ── Version ───────────────────────────────────────────────────────
export const versionService = {
  get: () => api.get('/version'),
};

// ── Profile ───────────────────────────────────────────────────────
export const profileService = {
  get:            ()     => api.get('/profile'),
  update:         (data) => api.put('/profile', data),
  changePassword: (data) => api.put('/profile/password', data),
};

export default api;
