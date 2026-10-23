'use strict';
/**
 * @file filecrypto.js
 * @description AES-256-GCM file encryption and decryption for SolidaRoute driver documents.
 *
 * Driver documents (e.g., license scans, insurance certificates) are encrypted on disk
 * using AES-256-GCM before being saved and decrypted on demand when served to authorized users.
 * This protects sensitive personal data at rest in the event of unauthorized file-system access.
 *
 * Why AES-256-GCM over the previously common AES-256-CBC?
 *   GCM (Galois/Counter Mode) is an authenticated encryption mode: it produces an authentication
 *   tag that detects any tampering with the ciphertext before decryption proceeds. CBC mode alone
 *   does not provide integrity verification — an attacker could modify the ciphertext undetected.
 *   GCM is the current recommended mode for file encryption.
 *
 * Encrypted file binary format (bytes, in order):
 *   [8  bytes] Magic header  — 0x00 SRENC 0x00 0x01
 *                              Used to detect whether a file is encrypted or a legacy plaintext
 *                              upload. The null bytes at start/end reduce false-positive risk.
 *   [16 bytes] IV            — Random initialization vector, unique per file.
 *                              A fresh IV is generated with crypto.randomBytes on each encryption.
 *                              Reusing an IV with the same key would break GCM security.
 *   [16 bytes] Auth tag      — GCM integrity tag. Verified on decryption — if the ciphertext
 *                              or tag has been modified, decryption throws an error.
 *   [N  bytes] Ciphertext    — The encrypted file content.
 *
 * Key source:
 *   FILE_ENCRYPTION_KEY environment variable — must be exactly 64 hexadecimal characters
 *   (representing 32 bytes / 256 bits). Set in the PM2 ecosystem config, never in a .env file.
 *   Losing this key means encrypted files cannot be decrypted; back it up securely.
 *
 * Legacy file handling:
 *   Files uploaded before encryption was enabled do not have the magic header.
 *   decryptBuffer() detects this and returns them unchanged, allowing graceful migration
 *   without requiring a one-time re-encryption pass of existing files.
 */
const crypto = require('crypto');

/**
 * Magic header bytes prepended to every encrypted file.
 * Spells out "\x00SRENC\x00\x01" — the null bytes ensure this cannot appear
 * accidentally at the start of a common plaintext file format.
 * @type {Buffer}
 */
const MAGIC   = Buffer.from([0x00, 0x53, 0x52, 0x45, 0x4E, 0x43, 0x00, 0x01]); // \x00SRENC\x00\x01

/** Length of the GCM initialization vector in bytes (standard GCM IV size) */
const IV_LEN  = 16;

/** Length of the GCM authentication tag in bytes (standard GCM tag size) */
const TAG_LEN = 16;

/**
 * Reads and validates the encryption key from the environment.
 * Called at the start of both encryptBuffer() and decryptBuffer() so that
 * a missing or malformed key is caught immediately rather than producing
 * a cryptic Node.js crypto error later.
 *
 * @returns {Buffer} 32-byte (256-bit) AES key
 * @throws {Error}   If FILE_ENCRYPTION_KEY is missing or not 64 hex chars
 */
function getKey() {
  const hex = process.env.FILE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('FILE_ENCRYPTION_KEY is missing or not a 64-character hex string.');
  }
  // Convert hex string → raw byte buffer that Node's crypto module expects
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a file buffer using AES-256-GCM and prepends the magic header.
 *
 * A new random IV is generated for every call, meaning two encryptions of the
 * same plaintext produce different ciphertext — this is a required property of
 * secure encryption (IND-CPA security). The IV does not need to be secret and
 * is stored in the output buffer so decryption can recover it.
 *
 * Output buffer layout: [MAGIC | IV | AUTH_TAG | CIPHERTEXT]
 *
 * @param {Buffer} plaintext - Raw file content to encrypt
 * @returns {Buffer}         - Encrypted buffer with magic header, ready to write to disk
 */
function encryptBuffer(plaintext) {
  const key     = getKey();
  const iv      = crypto.randomBytes(IV_LEN); // Fresh random IV per file — never reuse
  const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv);
  // Encrypt in one pass (update + final) — final() flushes any remaining block data
  const enc     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // Retrieve the GCM authentication tag AFTER calling final()
  const tag     = cipher.getAuthTag();
  // Assemble the complete encrypted file: magic + iv + tag + ciphertext
  return Buffer.concat([MAGIC, iv, tag, enc]);
}

/**
 * Decrypts a buffer previously encrypted by encryptBuffer().
 *
 * If the buffer does NOT begin with the magic header (legacy file uploaded before
 * encryption was introduced), it is returned unchanged. This allows the download
 * route to call decryptBuffer() unconditionally without needing to track which
 * files are encrypted and which are not.
 *
 * GCM authentication: if the ciphertext or auth tag has been altered on disk,
 * decipher.final() throws an error ("Unsupported state or unable to authenticate data").
 * The caller should treat this as a file integrity failure and log it as a security event.
 *
 * @param {Buffer} data - Raw buffer read from disk (may be encrypted or legacy plaintext)
 * @returns {Buffer}    - Decrypted plaintext, or the original buffer if it was not encrypted
 * @throws {Error}      - If the GCM auth tag verification fails (file tampered or key wrong)
 */
function decryptBuffer(data) {
  // Check the magic header to determine if this file was encrypted by this module.
  // subarray() avoids copying — we just compare the prefix bytes.
  if (data.length < MAGIC.length || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    return data; // Legacy unencrypted file — return as-is
  }
  const key     = getKey();
  const offset  = MAGIC.length; // Start reading after the 8-byte magic header

  // Slice each component out of the buffer at its known fixed offset
  const iv      = data.subarray(offset, offset + IV_LEN);
  const tag     = data.subarray(offset + IV_LEN, offset + IV_LEN + TAG_LEN);
  const enc     = data.subarray(offset + IV_LEN + TAG_LEN); // Everything after header+iv+tag

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  // Set the auth tag before calling update/final — GCM verifies it during final()
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/**
 * Returns true if the FILE_ENCRYPTION_KEY environment variable is configured.
 * Used by the document upload route to decide whether to encrypt files before saving.
 * If the key is not set, files are stored as plaintext (development/migration mode).
 *
 * @returns {boolean}
 */
function encryptionEnabled() {
  return !!(process.env.FILE_ENCRYPTION_KEY);
}

module.exports = { encryptBuffer, decryptBuffer, encryptionEnabled };
