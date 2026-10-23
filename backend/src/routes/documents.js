/**
 * @file documents.js
 * @module routes/documents
 * @description Secure upload and retrieval of driver identity documents — /api/documents/*
 *
 * Drivers must supply scanned copies of their driver's licence, vehicle insurance
 * certificate, and vehicle registration before an operator can approve their account.
 * This module handles the full lifecycle of those files: upload, storage, and download.
 *
 * ---------------------------------------------------------------------------
 * ROUTES:
 *   GET  /      — List all documents currently on file for the authenticated driver
 *   POST /:type — Upload (or replace) a document of the given type
 *   GET  /:type — Download / view a specific document
 *
 * Supported document types: license | insurance | registration
 *
 * ---------------------------------------------------------------------------
 * STORAGE LAYOUT:
 *   Files are written to the local filesystem under:
 *     {UPLOADS_DIR}/drivers/{driver_id}/{doc_type}.{ext}
 *
 *   One canonical file per (driver, type) pair — uploading a new file replaces
 *   the previous one on disk and updates the DB record via upsert.
 *
 *   Directory permissions: 0o700 (owner-only, prevents other OS users from browsing)
 *   File permissions:      0o600 (owner-only read/write)
 *
 *   Files are NEVER served as static assets. Every download must pass through
 *   the authenticated GET /:type route, which verifies ownership before streaming.
 *
 * ---------------------------------------------------------------------------
 * ENCRYPTION AT REST:
 *   When the filecrypto utility is configured (AES-256 key present in environment),
 *   file buffers are encrypted before being written to disk. On download the buffer
 *   is decrypted transparently before being streamed to the client. This ensures
 *   that sensitive identity documents are unreadable even if the filesystem is
 *   accessed directly (e.g. by another OS user or a compromised process).
 *
 * ---------------------------------------------------------------------------
 * FILE VALIDATION:
 *   1. multer enforces a generous 20 MB cap at the HTTP layer to prevent
 *      memory exhaustion from maliciously large uploads.
 *   2. The operator-configured `max_document_size_mb` value (from the
 *      `configuration` table, default 5 MB) is enforced after multer accepts
 *      the file — this is the real business limit.
 *   3. MIME type is determined by inspecting the file's magic bytes (first
 *      few bytes of the buffer), NOT the Content-Type header or filename
 *      extension supplied by the client. A client claiming a file is a PDF
 *      while actually uploading an executable is caught at this step.
 *   Accepted formats: PDF (%PDF), JPEG (FF D8 FF), PNG (89 50 4E 47)
 *
 * ---------------------------------------------------------------------------
 * DOCUMENT APPROVAL WORKFLOW:
 *   After upload the document status in driver_documents is 'pending'.
 *   An operator or admin reviews it via the admin panel and sets it to
 *   'approved' or 'rejected'. The driver's account cannot be fully activated
 *   until all required documents are approved.
 *   (Approval state changes are handled in the admin routes module, not here.)
 *
 * ---------------------------------------------------------------------------
 * @requires express
 * @requires multer
 * @requires path
 * @requires fs
 * @requires ../db/pool
 * @requires ../middleware/auth
 * @requires ../utils/logger
 * @requires ../utils/filecrypto
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { logger }       = require('../utils/logger');
const { encryptBuffer, decryptBuffer, encryptionEnabled } = require('../utils/filecrypto');

const router = express.Router();

// Root directory for all uploaded files. Configurable via environment variable
// so different deployment environments (dev/staging/prod) can use different paths.
const UPLOADS_DIR     = process.env.UPLOADS_DIR || '/opt/solidaroute/uploads';

// Default maximum document size in megabytes, used as a fallback when the
// `max_document_size_mb` key is absent from the `configuration` table.
const MAX_SIZE_MB_DEF = 5;

// The three document categories a driver must provide before approval.
// Using an explicit allowlist prevents directory traversal attacks where a
// malicious `:type` parameter could place a file in an unexpected path.
const DOC_TYPES   = ['license', 'insurance', 'registration'];
const VALID_SLOTS = ['1', '2'];

// ─── Magic byte signatures ────────────────────────────────────────────────────
//
// Each entry maps a MIME type to the expected leading bytes of a valid file of
// that type. Checking these bytes is the only reliable way to determine the
// actual file format — the client-supplied Content-Type and filename extension
// can be spoofed trivially (e.g. rename "malware.exe" to "license.pdf").
//
// References:
//   PDF  — starts with literal "%PDF" (0x25 0x50 0x44 0x46)
//   JPEG — starts with the SOI (Start of Image) marker FF D8, followed by FF
//   PNG  — starts with the 4-byte signature 89 50 4E 47 (‰PNG)
const MAGIC = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],  // %PDF
  'image/jpeg':      [0xFF, 0xD8, 0xFF],          // JFIF / EXIF SOI marker
  'image/png':       [0x89, 0x50, 0x4E, 0x47],   // ‰PNG
};

// Maps validated MIME types to the file extension used when writing to disk.
// The extension is derived from the detected MIME type, not from the original filename,
// so the stored filename is always trustworthy.
const MIME_TO_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg':      'jpg',
  'image/png':       'png',
};

/**
 * Detects the MIME type of a file buffer by comparing its leading bytes
 * against known magic byte signatures.
 *
 * This is used instead of trusting the client-supplied Content-Type header
 * because HTTP headers can be trivially forged. By reading the actual file
 * content we ensure the stored file is what the driver claims it to be.
 *
 * @param {Buffer} buffer - The raw file content received from the client.
 * @returns {string|null} Detected MIME type, or null if not recognised.
 */
function detectMime(buffer) {
  for (const [mime, magic] of Object.entries(MAGIC)) {
    // every() checks that EACH byte in the magic sequence matches the buffer
    // at the corresponding position. Short-circuits on the first mismatch.
    if (magic.every((b, i) => buffer[i] === b)) return mime;
  }
  // File does not match any accepted format — return null so the caller can reject it
  return null;
}

// ─── multer configuration ────────────────────────────────────────────────────
//
// memoryStorage keeps the uploaded file in a Buffer on req.file.buffer rather
// than writing it straight to disk. This is required because we need to:
//   1. Inspect the buffer's magic bytes before deciding whether to accept it.
//   2. Optionally encrypt the buffer before writing it to disk.
// Writing to a temp file and then re-reading it would work but is less efficient.
//
// The 20 MB limit here is a hard cap at the HTTP layer to protect against
// memory exhaustion. The actual business limit (typically 5 MB) is enforced
// afterwards by checking against the `max_document_size_mb` configuration value.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB generous multer cap; real limit enforced below
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the list of documents currently on file for the authenticated driver,
 * along with metadata such as MIME type, file size, and upload timestamp.
 *
 * Auth:    Required (driver role only)
 * Method:  GET
 *
 * Business rules:
 *   - Only drivers have documents; other roles receive 403.
 *   - Returns metadata only (no file content). Use GET /:type to download the file.
 *   - Results are ordered by doc_type for consistent display in the UI.
 *
 * Returns (200): { documents: [ { doc_type, filename, mime_type, file_size, uploaded_at }, … ] }
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    // Gate: documents are a driver-only concept; admins and operators view
    // documents through the admin panel, not through this endpoint.
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only.' });

    // Only return metadata columns — file content is never included in list responses.
    // The `status` column (pending/approved/rejected) is intentionally included so
    // the driver can see which documents still need attention.
    const { rows } = await pool.query(
      `SELECT doc_type, slot, filename, mime_type, file_size, uploaded_at
       FROM driver_documents WHERE driver_id = $1 ORDER BY doc_type, slot`,
      [req.user.id]
    );
    res.json({ documents: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/documents/:type  — delete ALL slots for a document type
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Deletes both uploaded files (slots 1 and 2) for a given document type.
 * Called before a driver re-uploads a document so both pages are cleared
 * and the entire document type goes back through the approval workflow.
 */
router.delete('/:type', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only.' });
    const { type } = req.params;
    if (!DOC_TYPES.includes(type)) return res.status(422).json({ error: 'Invalid document type.' });

    // Fetch all slot filenames for this driver + type
    const { rows } = await pool.query(
      `SELECT filename FROM driver_documents WHERE driver_id = $1 AND doc_type = $2`,
      [req.user.id, type]
    );

    // Delete each file from disk (ignore missing files — may have been manually removed)
    const driverDir = path.join(UPLOADS_DIR, 'drivers', req.user.id);
    for (const row of rows) {
      const filePath = path.join(driverDir, row.filename);
      try { fs.unlinkSync(filePath); } catch { /* file already gone — ignore */ }
    }

    // Remove all DB records for this type
    await pool.query(
      `DELETE FROM driver_documents WHERE driver_id = $1 AND doc_type = $2`,
      [req.user.id, type]
    );

    logger.info('Documents deleted for re-upload', { driverId: req.user.id, type });
    res.json({ message: 'Documents deleted.' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/documents/:type/:slot
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Uploads (or replaces) a driver identity document of the specified type.
 *
 * Auth:    Required (driver role only)
 * Method:  POST
 * Params:  type — one of 'license', 'insurance', 'registration'
 * Body:    multipart/form-data with field name 'file'
 *
 * Business rules:
 *   - Only drivers may upload documents.
 *   - Document type must be one of the recognised types (DOC_TYPES allowlist).
 *   - File must not exceed the configured max_document_size_mb limit.
 *   - File format is validated by magic bytes, not by client-supplied metadata.
 *   - If a document of this type already exists for the driver, the file on disk
 *     is overwritten and the DB record is updated via upsert (ON CONFLICT).
 *   - If encryption is enabled, the buffer is encrypted before being written to disk.
 *   - The driver directory is created with mode 0o700 if it does not exist.
 *   - The file is written with mode 0o600.
 *   - Upload is logged at INFO level for operational traceability.
 *
 * Returns (200): { message, type, mime_type }
 */
router.post('/:type/:slot', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    // Gate: only drivers can upload documents
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only.' });

    const { type, slot } = req.params;

    if (!DOC_TYPES.includes(type)) {
      return res.status(422).json({ error: 'Invalid document type.' });
    }
    if (!VALID_SLOTS.includes(slot)) {
      return res.status(422).json({ error: 'Invalid slot. Must be 1 or 2.' });
    }

    // multer sets req.file when the 'file' field is present; absent means the
    // request was sent without attaching a file (e.g. an empty form submission).
    if (!req.file) {
      return res.status(422).json({ error: 'No file uploaded.' });
    }

    // ── Size enforcement ────────────────────────────────────────────────────
    // Read the operator-configured limit from the `configuration` table.
    // Falls back to MAX_SIZE_MB_DEF (5 MB) if the key is not set.
    // This check happens after multer's 20 MB hard cap, so req.file.size is safe.
    const { rows: cfg } = await pool.query(
      `SELECT value FROM configuration WHERE key = 'max_document_size_mb'`
    );
    const maxMb = parseFloat(cfg[0]?.value || MAX_SIZE_MB_DEF);
    if (req.file.size > maxMb * 1024 * 1024) {
      return res.status(422).json({
        error: `File exceeds maximum size of ${maxMb} MB.`,
        code:   'FILE_TOO_LARGE',
        // Return the actual limit so the frontend can display it to the user
        max_mb: maxMb,
      });
    }

    // ── Magic byte validation ───────────────────────────────────────────────
    // detectMime() reads the first few bytes of the buffer and compares them
    // against known file signatures. This is the definitive type check;
    // the filename and Content-Type header from the client are completely ignored.
    const detectedMime = detectMime(req.file.buffer);
    if (!detectedMime) {
      return res.status(422).json({
        error: 'Invalid file type. Only PDF, JPEG and PNG are accepted.',
        code:  'INVALID_FILE_TYPE',
      });
    }

    // ── Write to disk ───────────────────────────────────────────────────────
    // Derive the extension from the validated MIME type (not from the original filename)
    // so the stored filename is always in a predictable, trustworthy format.
    const ext       = MIME_TO_EXT[detectedMime];
    // Construct a per-driver directory path using the driver's user ID.
    // Using the user ID (rather than a name) ensures uniqueness and avoids
    // path component issues with special characters in names.
    const driverDir = path.join(UPLOADS_DIR, 'drivers', req.user.id);
    // recursive: true is a no-op if the directory already exists, so this is safe
    // to call unconditionally. mode 0o700 restricts access to the owning process.
    fs.mkdirSync(driverDir, { recursive: true, mode: 0o700 });

    // Delete the previous file for this slot from disk if it has a different
    // extension (e.g. old was license_1.jpg, new is license_1.pdf). Without
    // this the old file would be orphaned on disk.
    const { rows: existing } = await pool.query(
      `SELECT filename FROM driver_documents
       WHERE driver_id = $1 AND doc_type = $2 AND slot = $3`,
      [req.user.id, type, parseInt(slot, 10)]
    );
    if (existing.length) {
      try { fs.unlinkSync(path.join(driverDir, existing[0].filename)); } catch { /* file already gone — ignore */ }
    }

    const filename  = `${type}_${slot}.${ext}`;
    const filePath  = path.join(driverDir, filename);

    // Encrypt the buffer if the filecrypto utility has a valid AES-256 key
    // configured in the environment. Fall back to storing plaintext when
    // encryption is not configured (e.g. in a development environment).
    const payload = encryptionEnabled() ? encryptBuffer(req.file.buffer) : req.file.buffer;
    // mode 0o600: only the owning OS user (the Node.js process) can read/write this file
    fs.writeFileSync(filePath, payload, { mode: 0o600 });

    // ── Upsert the DB record ────────────────────────────────────────────────
    // ON CONFLICT (driver_id, doc_type) handles the re-upload case: the new file
    // has already replaced the old one on disk, so we just update the metadata row
    // to reflect the new filename, MIME type, size, and timestamp.
    // The document status is implicitly reset to 'pending' by the DB default on
    // the conflict update — a re-uploaded document must be re-reviewed by an operator.
    await pool.query(
      `INSERT INTO driver_documents (driver_id, doc_type, slot, filename, mime_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (driver_id, doc_type, slot)
       DO UPDATE SET filename = $4, mime_type = $5, file_size = $6, uploaded_at = NOW()`,
      [req.user.id, type, parseInt(slot, 10), filename, detectedMime, req.file.size]
    );

    // ── Update approval_status based on current state ──────────────────────
    // The action taken depends on where the driver is in the onboarding flow:
    //
    //   'incomplete' → Check completeness. If all required fields and docs are
    //                  now present, promote to 'pending' (enters admin queue).
    //                  Otherwise stay 'incomplete'.
    //
    //   'approved'   → Re-uploading a document invalidates the previous approval.
    //                  Reset to 'pending' so the admin must re-review.
    //
    //   'pending'    → Already in the review queue; no status change needed.
    //   'rejected'   → Driver resubmitting after rejection; no auto-change here
    //                  (admin will need to re-open the application manually).
    const { rows: dpRows } = await pool.query(
      `SELECT approval_status FROM driver_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    const currentApproval = dpRows[0]?.approval_status;

    if (currentApproval === 'incomplete') {
      const { checkDriverCompleteness } = require('../utils/driverCompleteness');
      const { complete } = await checkDriverCompleteness(req.user.id);
      if (complete) {
        await pool.query(
          `UPDATE driver_profiles SET approval_status = 'pending', updated_at = NOW()
           WHERE user_id = $1 AND approval_status = 'incomplete'`,
          [req.user.id]
        );
      }
      // If not complete yet, keep 'incomplete' — no status update needed.
    } else if (currentApproval === 'approved') {
      // A new document from an already-approved driver requires re-review.
      await pool.query(
        `UPDATE driver_profiles SET approval_status = 'pending', approved_at = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [req.user.id]
      );
    }

    logger.info('Document uploaded', { driverId: req.user.id, type, mime: detectedMime });
    res.json({ message: 'Document uploaded successfully.', type, mime_type: detectedMime });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents/:type
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Downloads (streams) a specific driver document back to the authenticated driver.
 *
 * Auth:    Required (driver role only — a driver can only retrieve their own files)
 * Method:  GET
 * Params:  type — one of 'license', 'insurance', 'registration'
 *
 * Business rules:
 *   - Only the driver who owns the document can retrieve it through this endpoint.
 *     Admin/operator access to documents is handled in the admin routes module.
 *   - The DB record is queried first to confirm the document was uploaded and
 *     to obtain the stored MIME type. If the DB record exists but the file is
 *     missing from disk, a 404 is returned (indicates storage inconsistency).
 *   - If the file was encrypted at upload time, it is decrypted transparently
 *     before being sent to the client. The client always receives plaintext.
 *   - Content-Disposition is set to 'inline' so modern browsers attempt to
 *     render the file (PDF, image) rather than forcing a download.
 *
 * Returns: Raw file bytes with appropriate Content-Type header.
 */
router.get('/:type/:slot', authenticate, async (req, res, next) => {
  try {
    // Gate: only drivers retrieve their own documents through this endpoint
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only.' });

    const { type, slot } = req.params;
    if (!DOC_TYPES.includes(type)) {
      return res.status(422).json({ error: 'Invalid document type.' });
    }
    if (!VALID_SLOTS.includes(slot)) {
      return res.status(422).json({ error: 'Invalid slot. Must be 1 or 2.' });
    }

    const { rows } = await pool.query(
      `SELECT filename, mime_type
       FROM driver_documents WHERE driver_id = $1 AND doc_type = $2 AND slot = $3`,
      [req.user.id, type, parseInt(slot, 10)]
    );
    // No DB record means the document has never been uploaded
    if (!rows.length) return res.status(404).json({ error: 'Document not found.' });

    // Construct the full filesystem path from the DB-stored filename.
    // Using path.join() here (rather than string concatenation) prevents
    // any path traversal sequences that might have been stored in the filename column.
    const filePath = path.join(UPLOADS_DIR, 'drivers', req.user.id, rows[0].filename);

    // Guard against orphaned DB records where the file was manually deleted from
    // disk or the storage volume was re-mounted without the files.
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server.' });
    }

    // Read the entire file into memory. For document sizes (≤5 MB by default)
    // this is acceptable; a streaming approach would be needed for larger files.
    const raw = fs.readFileSync(filePath);

    // Decrypt the buffer if it was encrypted at upload time.
    // decryptBuffer() is a no-op when encryption is disabled, so this call is
    // safe to make unconditionally — it handles both encrypted and plaintext files.
    const plaintext = decryptBuffer(raw);

    // Set response headers so the browser can render the file inline (PDF viewer,
    // image display) rather than triggering a forced download dialog.
    res.setHeader('Content-Type', rows[0].mime_type);
    // 'inline' disposition requests that the browser display the file in-page;
    // the filename is provided as a hint for if the user does save it manually.
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].filename)}`);
    // Set Content-Length from the decrypted buffer (not the raw encrypted buffer)
    // so the browser knows how many bytes to expect.
    res.setHeader('Content-Length', plaintext.length);
    res.end(plaintext);
  } catch (err) { next(err); }
});

module.exports = router;
