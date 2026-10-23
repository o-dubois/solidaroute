/**
 * @file pool.js
 * @description PostgreSQL connection pool for SolidaRoute.
 *
 * Uses the `pg` library's built-in Pool class for efficient connection reuse.
 * All database interactions throughout the application (routes, services, middleware)
 * import and use this module rather than creating individual connections.
 *
 * Configuration is read from environment variables (set via PM2 ecosystem.config.js
 * in production, or a .env file in development):
 *   DB_HOST     — PostgreSQL host (default: localhost)
 *   DB_PORT     — PostgreSQL port (default: 5432)
 *   DB_NAME     — Database name  (default: solidaroute)
 *   DB_USER     — Database user  (default: solidaroute)
 *   DB_PASSWORD — Database password (default: empty string)
 *
 * Pool settings explained:
 *   max: 10
 *     Maximum concurrent connections. Requests that arrive when all 10 are busy
 *     will queue and wait up to connectionTimeoutMillis before failing.
 *     Increase this value if query throughput grows significantly.
 *
 *   idleTimeoutMillis: 30000 (30 seconds)
 *     A connection that has been idle (no queries) for 30 seconds is closed and
 *     removed from the pool. This releases DB-side resources during quiet periods.
 *
 *   connectionTimeoutMillis: 2000 (2 seconds)
 *     If a free connection cannot be acquired from the pool within 2 seconds,
 *     the query fails immediately. This prevents request pile-up during DB overload.
 *
 * Exports:
 *   pool            — the raw pg.Pool instance for direct query() calls
 *   testConnection  — startup connectivity check; throws on failure
 *   withTransaction — helper that wraps a callback in BEGIN/COMMIT/ROLLBACK
 */

const { Pool } = require('pg');
const { logger } = require('../utils/logger');

/**
 * The shared connection pool instance.
 * Created once at module load time and reused for the lifetime of the process.
 */
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'solidaroute',
  user:     process.env.DB_USER     || 'solidaroute',
  password: process.env.DB_PASSWORD || '',
  max:      10,                  // Maximum simultaneous connections to PostgreSQL
  idleTimeoutMillis:       30000, // Release idle connections after 30 seconds
  connectionTimeoutMillis: 2000,  // Fail fast if no connection is available within 2 seconds
});

/**
 * Verifies database connectivity at server startup.
 *
 * Runs a cheap query (SELECT NOW()) to confirm the DB is reachable and credentials
 * are correct. Called by index.js before app.listen() — if this throws, the server
 * process exits immediately rather than starting in a broken state.
 *
 * A dedicated client is acquired (and released) rather than using pool.query()
 * so we can confirm that the pool's connect() mechanism itself works correctly.
 *
 * @returns {Promise<void>}
 * @throws {Error} if the connection cannot be established
 */
async function testConnection() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT NOW() AS now, version() AS version');
    logger.info('Database connected', { now: rows[0].now });
  } finally {
    // Always release back to the pool, even if the query threw
    client.release();
  }
}

/**
 * Executes a callback function inside a PostgreSQL transaction.
 *
 * Automatically issues BEGIN before calling the callback, COMMIT on success,
 * and ROLLBACK if the callback throws any error. The connection is always
 * returned to the pool in the finally block.
 *
 * Why use this instead of individual pool.query() calls?
 *   Multiple related writes (e.g., creating a trip + recording a notification)
 *   must succeed or fail together. Without a transaction, a crash between the
 *   two writes would leave the database in a partially-updated state.
 *
 * @param {function(import('pg').PoolClient): Promise<any>} callback
 *   Receives a pg PoolClient. All queries inside must use this client,
 *   not the module-level pool, to participate in the same transaction.
 * @returns {Promise<any>} The value returned by the callback on success
 * @throws {Error}         Re-throws any error from the callback after rolling back
 *
 * @example
 * const result = await withTransaction(async (client) => {
 *   await client.query('INSERT INTO trips (...) VALUES (...)', [...]);
 *   await client.query('INSERT INTO notifications (...) VALUES (...)', [...]);
 *   return { success: true };
 * });
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Roll back all changes made within this transaction before re-throwing
    await client.query('ROLLBACK');
    throw err;
  } finally {
    // Return the connection to the pool whether the transaction succeeded or failed
    client.release();
  }
}

module.exports = { pool, testConnection, withTransaction };
