/**
 * @file logger.js
 * @description Centralized application logger for SolidaRoute.
 *
 * Wraps the Winston logging library with environment-aware configuration.
 * The same `logger` instance is imported throughout the codebase so all log
 * output is consistent and controlled from one place.
 *
 * Development mode (NODE_ENV !== 'production'):
 *   - Log level: 'debug' — all messages including verbose debug output are shown
 *   - Format: human-readable single-line text
 *     "2026-03-16T10:30:00.000Z [INFO] User registered {"userId":"abc"}"
 *   - Transport: console only (no log files written during local development)
 *
 * Production mode (NODE_ENV === 'production'):
 *   - Log level: 'info' — debug messages are suppressed for performance and log hygiene
 *   - Format: structured JSON (one JSON object per line)
 *     Compatible with log aggregation tools: Loki, Datadog, Elastic, AWS CloudWatch, etc.
 *   - Transports:
 *     console           — for capture by PM2 / systemd / container stdout
 *     logs/error.log    — errors only (level: 'error'), rotated externally via logrotate
 *     logs/combined.log — all levels (info, warn, error), the primary audit log
 *
 * The `errors({ stack: true })` format ensures that Error objects passed as the
 * second argument to logger.error() include their stack trace in the output.
 *
 * Usage throughout the codebase:
 *   const { logger } = require('../utils/logger');
 *   logger.debug('Detailed diagnostic info', { someValue });
 *   logger.info('User registered', { userId: user.id });
 *   logger.warn('SMTP not configured — emails will be simulated');
 *   logger.error('DB query failed', { message: err.message, stack: err.stack });
 */

const winston = require('winston');

/**
 * The shared logger instance.
 * Exported as a named property so importing code stays consistent:
 *   const { logger } = require('../utils/logger');
 */
const logger = winston.createLogger({
  // 'debug' in dev to see all diagnostic output; 'info' in production to reduce noise
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',

  format: winston.format.combine(
    // Adds a `timestamp` field to every log record
    winston.format.timestamp(),
    // Ensures Error objects have their .stack serialized into the log record
    winston.format.errors({ stack: true }),

    // In production: emit compact JSON — one line per log event, easy to parse
    // In development: emit a readable string with structured metadata appended
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.printf(({ timestamp, level, message, ...meta }) => {
          // Only append the metadata object if there are extra fields beyond
          // the standard timestamp/level/message — keeps output uncluttered
          const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [${level.toUpperCase()}] ${message}${extras}`;
        })
  ),

  transports: [
    // Always write to stdout/stderr — captured by PM2 in production, terminal in dev
    new winston.transports.Console(),

    // File transports are only enabled in production to avoid cluttering the dev workspace
    ...(process.env.NODE_ENV === 'production'
      ? [
          // errors-only log — useful for quick error triage without scanning all traffic
          new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
          // combined log — full record of all info/warn/error events for auditing
          new winston.transports.File({ filename: 'logs/combined.log' }),
        ]
      : []),
  ],
});

module.exports = { logger };
