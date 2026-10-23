/**
 * @file routes/tickets/helpers.js
 * @description Shared helper functions for all tickets sub-routers.
 *
 * Exports:
 *   generateNotebookKey(db)   — unique 6-char alphanumeric notebook key
 *   generateNotebookStart(db) — non-overlapping random ticket start number
 *   getMobilityConfig(db)     — read facial_value + currency from configuration
 */

// Uppercase alphanumeric alphabet used for notebook keys
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generate a unique 6-character uppercase alphanumeric notebook key.
 * Keys are permanent and never reused — the UNIQUE constraint on notebook_key
 * guarantees this at the DB level; we also pre-check to avoid constraint errors.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @returns {Promise<string>}
 */
async function generateNotebookKey(db) {
  for (let attempt = 0; attempt < 200; attempt++) {
    let key = '';
    for (let i = 0; i < 6; i++) {
      key += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
    }
    const { rows } = await db.query(
      'SELECT id FROM ticket_notebooks WHERE notebook_key = $1',
      [key]
    );
    if (!rows.length) return key;
  }
  throw Object.assign(
    new Error('Could not generate a unique notebook key. Please try again.'),
    { statusCode: 503 }
  );
}

/**
 * Generate a non-overlapping random notebook start number.
 * Picks a random integer in [3 000 000, 9 999 990], then checks it doesn't
 * overlap any existing notebook (each notebook covers start … start+9).
 * Retries up to 200 times (collision probability is very low in practice).
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @returns {Promise<number>}
 */
async function generateNotebookStart(db) {
  // Ticket ranges are always aligned to multiples of 10 (ticket_start % 10 === 0).
  // This ensures every decade [X0 … X9] is fully owned by a single notebook,
  // leaving no gaps or split ranges in the [3 000 000 – 9 999 999] space.
  const MIN_UNIT = 300000;  // 3 000 000 / 10
  const MAX_UNIT = 999999;  // 9 999 990 / 10  (last ticket = 9 999 999)

  const { rows } = await db.query('SELECT ticket_start FROM ticket_notebooks');
  // Convert existing starts to their decade unit for fast overlap check
  const existingUnits = new Set(rows.map(r => Math.floor(parseInt(r.ticket_start, 10) / 10)));

  for (let attempt = 0; attempt < 200; attempt++) {
    const unit      = MIN_UNIT + Math.floor(Math.random() * (MAX_UNIT - MIN_UNIT + 1));
    const candidate = unit * 10; // always divisible by 10
    if (!existingUnits.has(unit)) return candidate;
  }

  const err = new Error('Could not allocate unique ticket numbers. Please try again.');
  err.statusCode = 503;
  throw err;
}

/**
 * Read mobility ticket config values from the configuration table.
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @returns {Promise<{ facialValue: number, currency: string }>}
 */
async function getMobilityConfig(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM configuration
     WHERE key = ANY($1)`,
    [['mobility_ticket_facial_value', 'payment_currency']]
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    facialValue: parseFloat(cfg.mobility_ticket_facial_value ?? 1.25),
    currency:    cfg.payment_currency ?? 'CAD',
  };
}

module.exports = { generateNotebookKey, generateNotebookStart, getMobilityConfig };
