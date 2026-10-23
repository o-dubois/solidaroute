/**
 * @file app.js
 * @description SolidaRoute Express application — middleware and routes only.
 *
 * This file exports the configured Express app WITHOUT starting the HTTP server
 * and WITHOUT loading .env. Those concerns belong to index.js (production entry
 * point) and to Jest's setupFiles (test entry point).
 *
 * Keeping app creation separate from server startup lets Supertest import this
 * module directly and fire requests without binding to a port.
 */

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { logger } = require('./utils/logger');

// ── Route modules ─────────────────────────────────────────────
const authRoutes          = require('./routes/auth');
const profileRoutes       = require('./routes/profile');
const tripsRoutes         = require('./routes/trips');
const driversRoutes       = require('./routes/drivers');
const paymentsRoutes      = require('./routes/payments');
const notificationsRoutes = require('./routes/notifications');
const adminRoutes         = require('./routes/admin');
const documentRoutes      = require('./routes/documents');
const ticketsRoutes       = require('./routes/tickets');
const messagesRoutes      = require('./routes/messages');
const reviewsRoutes       = require('./routes/reviews');
const versionRoutes       = require('./routes/version');

const app = express();

// ── Trust the first reverse proxy (Nginx) ─────────────────────
// Required so that express-rate-limit and req.ip see the real
// client IP from X-Forwarded-For instead of 127.0.0.1 (Nginx).
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ].filter(Boolean);
    if (allowed.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    callback(new Error('CORS not allowed: ' + origin));
  },
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Please try again later.' },
}));

// ── Body parsing ──────────────────────────────────────────────
// 16 kb is generous for every API endpoint; prevents memory exhaustion
// from oversized payloads before validators even run.
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ limit: '16kb', extended: true }));

// ── Request logging ───────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ── Route mounting ────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/trips',         tripsRoutes);
app.use('/api/drivers',       driversRoutes);
app.use('/api/payments',      paymentsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/documents',    documentRoutes);
app.use('/api/tickets',      ticketsRoutes);
app.use('/api/messages',     messagesRoutes);
app.use('/api/reviews',      reviewsRoutes);
app.use('/api/version',      versionRoutes);

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '5.0.0', timestamp: new Date().toISOString() });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === '23505') {
    const constraint = err.constraint || '';
    if (constraint.includes('phone')) {
      return res.status(409).json({
        error: 'This phone number is already associated with another account.',
        code: 'PHONE_IN_USE',
      });
    }
    if (constraint.includes('email')) {
      return res.status(409).json({
        error: 'This email address is already in use.',
        code: 'EMAIL_IN_USE',
      });
    }
    return res.status(409).json({
      error: 'A duplicate value was detected. Please try again.',
      code: 'DUPLICATE_VALUE',
    });
  }

  logger.error('Unhandled error: ' + err.message, { stack: err.stack });
  res.status(err.statusCode || 500).json({
    error: (err.statusCode || 500) === 500
      ? 'Internal server error'
      : err.message,
  });
});

module.exports = app;
