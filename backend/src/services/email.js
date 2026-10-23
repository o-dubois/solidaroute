'use strict';
/**
 * @file email.js
 * @description Transactional email service for SolidaRoute.
 *
 * Responsible for all outbound email communication in the platform:
 *   - Email address verification for new accounts
 *   - Driver notifications when a trip needs a volunteer (preferred + broadcast)
 *   - Client confirmations when a driver accepts, declines, or when no driver is found
 *
 * Architecture decisions:
 *   - HTML templates are stored in backend/src/templates/ as plain .html files.
 *     This keeps design changes separate from business logic — a designer can
 *     edit the template without touching JavaScript.
 *   - Each {{VARIABLE}} placeholder in a template is replaced at render time using
 *     a simple string substitution approach (no template engine dependency needed).
 *   - Every template is wrapped in layout.html (shared header/footer) via wrapLayout().
 *   - A plain-text fallback is always included alongside the HTML body so that
 *     email clients that don't render HTML still show a readable message.
 *   - If SMTP is not configured, emails are simulated by printing to the logger
 *     (useful during local development and testing without a mail server).
 *
 * Available HTML templates (in backend/src/templates/):
 *   layout.html                    — shared header/footer wrapper
 *   driver-preferred.html          — notifies the client's preferred driver
 *   driver-broadcast.html          — notifies all eligible drivers in the area
 *   trip-accepted.html             — tells the client their ride is confirmed
 *   trip-declined-preferred.html   — tells the client their preferred driver declined
 *   trip-cancelled.html            — tells the client no driver was found (trip cancelled)
 *   verify-email.html              — account email verification link
 *
 * Environment variables used:
 *   SMTP_HOST            — mail server hostname (required for real sending)
 *   SMTP_PORT            — mail server port (default 25)
 *   SMTP_SECURE          — 'true' for TLS (port 465), 'false' for STARTTLS/plain
 *   SMTP_USER            — SMTP login (optional — some servers allow unauthenticated relay)
 *   SMTP_PASS            — SMTP password (optional)
 *   SMTP_FROM            — "From" address (default: SolidaRoute <noreply@solidaroute.ca>)
 *   SMTP_REJECT_UNAUTHORIZED — set to 'false' to allow self-signed TLS certs (dev only)
 *   FRONTEND_URL         — base URL used to build action links in emails
 */

const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const { logger } = require('../utils/logger');

// ── Template engine ───────────────────────────────────────────

/** Absolute path to the HTML templates directory. */
const TEMPLATES_DIR = path.join(__dirname, '../templates');

/**
 * Loads an HTML template file from disk and substitutes all {{KEY}} placeholders
 * with the matching values from the `vars` object.
 *
 * Design choice: synchronous file reads are used intentionally here because
 * templates are tiny files and the simplicity outweighs the minimal blocking cost.
 * If templates grow large or are read on every request at scale, consider caching.
 *
 * @param {string} filename  - Template filename, e.g. 'trip-accepted.html'
 * @param {object} vars      - Key/value map of placeholder substitutions
 * @returns {string}         - Fully rendered HTML string
 */
function renderTemplate(filename, vars = {}) {
  const filePath = path.join(TEMPLATES_DIR, filename);
  let html = fs.readFileSync(filePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    // Replace ALL occurrences of {{KEY}} throughout the file (global replaceAll).
    // Null/undefined values are coerced to empty string to avoid "null" appearing
    // in rendered emails.
    html = html.replaceAll(`{{${key}}}`, value ?? '');
  }
  return html;
}

/**
 * Injects a rendered body block into the shared layout template.
 * The layout provides consistent branding (logo, header, footer) across all emails.
 *
 * The body HTML is passed as the {{BODY}} variable to layout.html.
 *
 * @param {string} body  - Rendered inner HTML from a content template
 * @param {object} vars  - Additional layout variables (SUBJECT, APP_NAME, YEAR, etc.)
 * @returns {string}     - Complete email HTML including layout wrapper
 */
function wrapLayout(body, vars = {}) {
  return renderTemplate('layout.html', { ...vars, BODY: body });
}

// ── Transport ─────────────────────────────────────────────────

/**
 * Creates and returns a nodemailer transport configured from environment variables.
 *
 * Returns null if SMTP_HOST is not set, which causes sendEmail() to fall back
 * to simulation mode (log to console instead of actually sending).
 *
 * Auth is only added to the config when BOTH username and password are present.
 * This supports open relay mail servers used in some corporate/hosted environments
 * that don't require credentials.
 *
 * SMTP_REJECT_UNAUTHORIZED can be set to 'false' to accept self-signed certificates —
 * useful for internal mail servers in development, but should be 'true' in production.
 *
 * @returns {nodemailer.Transporter | null}
 */
function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) {
    logger.warn('SMTP not configured — emails will be simulated in console logs');
    return null;
  }
  // Only enable authentication if both username AND password are non-empty.
  // Some relay servers (e.g., internal corporate SMTP) accept connections without auth.
  const hasAuth = SMTP_USER && SMTP_USER.trim() !== '' && SMTP_PASS && SMTP_PASS.trim() !== '';
  // Default to rejecting unauthorized TLS certs (secure). Allow override for dev/internal.
  const rejectUnauthorized = process.env.SMTP_REJECT_UNAUTHORIZED !== 'false';
  const config = {
    host:   SMTP_HOST.trim(),
    port:   parseInt(SMTP_PORT || '25', 10),
    secure: SMTP_SECURE === 'true', // true = TLS on connect (port 465); false = STARTTLS
    tls:    { rejectUnauthorized },
  };
  if (hasAuth) {
    config.auth = { user: SMTP_USER, pass: SMTP_PASS };
  }
  return nodemailer.createTransport(config);
}

/**
 * Core email sending function. All public functions in this module funnel through here.
 *
 * If no SMTP transport is available, the email is "sent" by logging it to the console
 * (simulation mode), allowing the rest of the application to work normally in development.
 *
 * Both `html` and `text` should be provided. Mail clients that don't render HTML
 * (e.g. some accessibility tools, plain-text-only clients) will display the `text` version.
 *
 * @param {object} param0
 * @param {string} param0.to      - Recipient email address
 * @param {string} param0.subject - Email subject line
 * @param {string} param0.html    - HTML body
 * @param {string} [param0.text]  - Plain-text fallback body
 * @returns {Promise<object>}     - nodemailer sendMail result, or { simulated: true }
 */
async function sendEmail({ to, subject, html, text, appName }) {
  const transport = createTransport();
  const smtpFrom = process.env.SMTP_FROM || 'SolidaRoute <noreply@solidaroute.ca>';
  // Extract bare email address from SMTP_FROM (handles "Name <email>" or plain "email")
  const smtpEmail = /<([^>]+)>/.exec(smtpFrom)?.[1] || smtpFrom;
  const from = appName ? `${appName} <${smtpEmail}>` : smtpFrom;

  // Demo / staging override: when EMAIL_OVERRIDE_TO is set, all outbound emails
  // are redirected to that address regardless of the intended recipient.
  // Set EMAIL_OVERRIDE_TO in .env to test the full email flow without
  // accidentally sending to real users.
  const actualTo = process.env.EMAIL_OVERRIDE_TO || to;
  if (process.env.EMAIL_OVERRIDE_TO) {
    subject = `[to: ${to}] ${subject}`;
  }

  if (!transport) {
    // No SMTP configured — log the email contents instead of throwing.
    // This lets developers see what would have been sent without needing a mail server.
    logger.info('📧 [EMAIL SIMULATED]', { from, to: actualTo, subject, text: text || '(see HTML)' });
    return { simulated: true };
  }
  try {
    const info = await transport.sendMail({ from, to: actualTo, subject, text, html });
    logger.info(`📧 Email sent to ${actualTo}`, { messageId: info.messageId });
    return info;
  } catch (err) {
    // Log and re-throw so the caller can decide how to handle delivery failures
    // (e.g., mark trip as needing retry, alert admin).
    logger.error(`Failed to send email to ${to}`, { message: err.message });
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Formats an ISO date string into a human-friendly, localized date+time string
 * suitable for display in emails.
 *
 * Always renders in the America/Toronto timezone (Eastern Time), which covers
 * the primary service area of Quebec. If the app expands to other timezones,
 * this should become configurable per-organization.
 *
 * @param {string} isoString - ISO 8601 date string (e.g. "2026-04-15T14:30:00Z")
 * @param {string} lang      - 'fr' for French (fr-CA locale), anything else for English (en-CA)
 * @returns {string}         - e.g. "mercredi 15 avril 2026 à 10 h 30"
 */
function formatEmailDate(isoString, lang) {
  return new Date(isoString).toLocaleString(
    lang === 'fr' ? 'fr-CA' : 'en-CA',
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' }
  );
}

/**
 * Builds an optional HTML row showing the return trip time.
 * Returns an empty string if the trip has no return leg (one-way trip).
 *
 * Kept as a separate helper so the trip detail block in templates stays
 * clean — the template simply places {{RETURN_ROW}} and gets either content or nothing.
 *
 * @param {object} trip - Trip database record
 * @param {string} lang - 'fr' or 'en'
 * @returns {string}    - HTML snippet or ''
 */
function returnRow(trip, lang) {
  if (!trip.return_at) return '';
  const time = new Date(trip.return_at).toLocaleTimeString(
    lang === 'fr' ? 'fr-CA' : 'en-CA',
    { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' }
  );
  const label = lang === 'fr' ? 'Retour prévu' : 'Return';
  return `<strong>↩️ ${label} :</strong> ${time}<br>`;
}

/**
 * Builds an optional HTML row showing the passenger count.
 * Returns an empty string for solo trips (count <= 1) to keep emails uncluttered.
 *
 * The extra_passenger_fee in pricing applies when count > 1, so this row is
 * informational for the driver — they know how many seats to have available.
 *
 * @param {object} trip - Trip database record
 * @param {string} lang - 'fr' or 'en'
 * @returns {string}    - HTML snippet or ''
 */
function passengersRow(trip, lang) {
  if (!trip.passenger_count || trip.passenger_count <= 1) return '';
  const label = lang === 'fr' ? 'Passagers' : 'Passengers';
  return `<strong>👥 ${label} :</strong> ${trip.passenger_count}<br>`;
}

/**
 * Assembles the common trip detail variables shared across all trip-related templates.
 * Centralizing these prevents copy-paste errors and ensures consistent field names
 * across the driver notification, acceptance confirmation, and cancellation emails.
 *
 * @param {object} trip - Trip database record (requires pickup_address, dropoff_address,
 *                        departure_at, trip_number; optionally return_at, passenger_count)
 * @param {string} lang - 'fr' or 'en'
 * @returns {object}    - Template variable map
 */
function tripVars(trip, lang) {
  return {
    PICKUP:          trip.pickup_address,
    DROPOFF:         trip.dropoff_address,
    DEPARTURE:       formatEmailDate(trip.departure_at, lang),
    RETURN_ROW:      returnRow(trip, lang),       // Empty string if no return leg
    PASSENGERS_ROW:  passengersRow(trip, lang),   // Empty string if solo passenger
    TRIP_NUMBER:     trip.trip_number || '',
    // Labels are translated per-email so the template HTML itself stays language-neutral
    LABEL_PICKUP:    lang === 'fr' ? 'Départ'        : 'Pickup',
    LABEL_DROPOFF:   lang === 'fr' ? 'Arrivée'       : 'Drop-off',
    LABEL_DEPARTURE: lang === 'fr' ? 'Date et heure' : 'Date and time',
  };
}

/**
 * Assembles the layout-level template variables common to all emails.
 * These populate the shared header/footer in layout.html.
 *
 * @param {string} subject    - Email subject (also displayed as a heading in some clients)
 * @param {string} appName    - Organization/app name (from config, e.g. "SolidaRoute")
 * @param {string} lang       - 'fr' or 'en' (used to set the HTML lang attribute)
 * @param {string} footerText - Short contextual sentence explaining why the email was sent
 * @returns {object}          - Template variable map
 */
// Returns "First L." format — masks last name for privacy in all outbound emails.
// Used for both driver names (in client-facing emails) and client names (in driver-facing emails).
function driverDisplayName(driver) {
  if (!driver) return '';
  const initial = driver.last_name ? `${driver.last_name[0].toUpperCase()}.` : '';
  return initial ? `${driver.first_name} ${initial}` : driver.first_name;
}

function layoutVars(subject, appName, lang, footerText) {
  return {
    SUBJECT:      subject,
    APP_NAME:     appName,
    LANG:         lang,
    YEAR:         new Date().getFullYear(), // Auto-updates in the footer copyright line
    FOOTER_TEXT:  footerText,
  };
}

// ── Template 1: Preferred driver notification ─────────────────

/**
 * Sends a notification to the client's preferred (pre-selected) driver asking them
 * to accept or decline the trip within a time window.
 *
 * When a client creates a trip and has a preferred driver on file, that driver gets
 * first right of refusal before the request is broadcast to other drivers.
 * The email contains Accept and Decline one-click links (token-based, no login required)
 * so the driver can respond quickly from their phone.
 *
 * @param {object} param0
 * @param {object} param0.driver         - Driver record ({ first_name, email })
 * @param {object} param0.client         - Client record (used for context, not included in email)
 * @param {object} param0.trip           - Trip record
 * @param {string} param0.appName        - Organization name (from configuration table)
 * @param {string} param0.lang           - Email language ('fr' or 'en')
 * @param {number} param0.responseHours  - Hours the driver has to respond before broadcast
 * @param {string} param0.acceptLink     - One-click accept URL (contains auth token)
 * @param {string} param0.declineLink    - One-click decline URL (contains auth token)
 * @returns {Promise<object>}
 */
async function sendPreferredDriverNotification({
  driver, client: _client, trip, appName, lang, responseHours, acceptLink, declineLink,
}) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  // General app link shown as a fallback if the one-click buttons don't work
  const appLink     = `${frontendUrl}/driver/available`;

  const isFr = lang === 'fr';
  const subject = isFr
    ? `🚗 ${appName} — Un usager vous a sélectionné pour un transport`
    : `🚗 ${appName} — A rider has selected you for a trip`;

  const body = renderTemplate('driver-preferred.html', {
    ...tripVars(trip, lang),
    DRIVER_FIRST:  driver.first_name,
    RESPONSE_HOURS: responseHours,
    ACCEPT_LINK:   acceptLink,
    DECLINE_LINK:  declineLink,
    APP_LINK:      appLink,
    // All user-visible text is passed as variables so the template stays bilingual-neutral
    MSG_GREETING:  isFr ? 'Bonjour'   : 'Hello',
    MSG_SELECTED:  isFr
      ? 'Un usager vous a sélectionné comme conducteur bénévole pour le trajet suivant :'
      : 'A rider has selected you as their volunteer driver for the following trip:',
    MSG_DEADLINE:  isFr
      ? `Vous avez <strong>${responseHours} heures</strong> pour accepter ou refuser ce trajet.`
      : `You have <strong>${responseHours} hours</strong> to accept or decline this trip.`,
    MSG_FALLBACK:  isFr
      ? 'Si vous ne pouvez pas effectuer ce transport, cliquez sur Refuser. Un autre conducteur sera contacté.'
      : 'If you cannot make this trip, click Decline. Another driver will be contacted.',
    BTN_ACCEPT:    isFr ? '✅ Accepter ce trajet' : '✅ Accept this trip',
    BTN_DECLINE:   isFr ? '✗ Refuser ce trajet'  : '✗ Decline this trip',
    LINK_LABEL:    isFr ? 'Ou connectez-vous à l\'application :' : 'Or log in to the app:',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous êtes conducteur bénévole inscrit sur ${appName}.`
    : `You are receiving this because you are a registered volunteer driver on ${appName}.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  // Plain-text fallback for accessibility and non-HTML email clients
  const text = isFr
    ? `Bonjour ${driver.first_name},\n\nUn usager vous a sélectionné pour un transport.\n\n`
      + `Départ : ${trip.pickup_address}\nArrivée : ${trip.dropoff_address}\n\n`
      + `Vous avez ${responseHours}h pour répondre.\nAccepter : ${acceptLink}\nRefuser : ${declineLink}\n\n— ${appName}`
    : `Hello ${driver.first_name},\n\nA rider has selected you for a trip.\n\n`
      + `From: ${trip.pickup_address}\nTo: ${trip.dropoff_address}\n\n`
      + `You have ${responseHours}h to respond.\nAccept: ${acceptLink}\nDecline: ${declineLink}\n\n— ${appName}`;

  return sendEmail({ to: driver.email, subject, html, text, appName });
}

// ── Template 2: Broadcast to nearby drivers ───────────────────

/**
 * Sends a trip availability notification to one eligible driver in the broadcast pool.
 * This function is called once per driver — the calling service loops over the list.
 *
 * Used in two scenarios:
 *   1. Initial broadcast: preferred driver declined (or no preferred driver was set)
 *   2. Reminder: trip is still unaccepted after a partial broadcast window
 *
 * The `isReminder` flag changes the subject line and adds a visible yellow banner
 * inside the email body so drivers immediately recognize it as a follow-up.
 *
 * Unlike the preferred-driver email, this version does NOT include Accept/Decline links
 * — drivers must log in to the app to claim the trip. This prevents a race condition
 * where multiple drivers click Accept simultaneously.
 *
 * @param {object} param0
 * @param {object} param0.driver         - Driver record ({ first_name, email })
 * @param {object} param0.trip           - Trip record
 * @param {string} param0.appName        - Organization name
 * @param {string} param0.lang           - Email language ('fr' or 'en')
 * @param {number} param0.responseHours  - Hours remaining until the trip is cancelled
 * @param {boolean} [param0.isReminder]  - true if this is a follow-up reminder email
 * @returns {Promise<object>}
 */
async function sendDriverBroadcast({ driver, trip, appName, lang, responseHours, isReminder = false }) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  // Direct link to the available trips list in the driver dashboard
  const appLink     = `${frontendUrl}/driver/available`;
  const isFr        = lang === 'fr';

  const subject = isFr
    ? (isReminder
        ? `⏰ ${appName} — Rappel : trajet T-${trip.trip_number} en attente`
        : `🚗 ${appName} — Un trajet est disponible dans votre secteur`)
    : (isReminder
        ? `⏰ ${appName} — Reminder: trip T-${trip.trip_number} still available`
        : `🚗 ${appName} — A trip is available in your area`);

  // Inline reminder banner injected into the email body for reminder sends.
  // Built here rather than in the template so we don't need a conditional block in HTML.
  const reminderBlock = isReminder
    ? `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;
                   padding:10px 16px;margin-bottom:16px;font-size:13px;color:#92400e;">
         ⏰ ${isFr ? 'Rappel — ce trajet est toujours disponible.' : 'Reminder — this trip is still available.'}
       </div>`
    : '';

  const body = renderTemplate('driver-broadcast.html', {
    ...tripVars(trip, lang),
    DRIVER_FIRST:   driver.first_name,
    RESPONSE_HOURS: responseHours,
    APP_LINK:       appLink,
    MSG_GREETING:   isFr ? 'Bonjour' : 'Hello',
    MSG_REMINDER:   reminderBlock,   // Empty string for initial sends, yellow box for reminders
    MSG_INTRO:      isFr
      ? 'Un trajet bénévole est disponible dans votre secteur et attend un conducteur :'
      : 'A volunteer trip is available in your area and needs a driver:',
    MSG_DEADLINE:   isFr
      ? `Ce trajet sera disponible pendant encore <strong>${responseHours} heures</strong>.`
      : `This trip will be available for another <strong>${responseHours} hours</strong>.`,
    MSG_FALLBACK:   isFr
      ? 'Si vous ne pouvez pas effectuer ce transport, ignorez simplement ce message.'
      : 'If you cannot make this trip, simply ignore this message.',
    BTN_VIEW:       isFr ? '👉 Voir les trajets disponibles' : '👉 View available trips',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous êtes conducteur bénévole inscrit sur ${appName}.`
    : `You are receiving this because you are a registered volunteer driver on ${appName}.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Bonjour ${driver.first_name},\n\nUn trajet est disponible dans votre secteur.\n\n`
      + `Départ : ${trip.pickup_address}\nArrivée : ${trip.dropoff_address}\n\n`
      + `Voir les trajets : ${appLink}\n\n— ${appName}`
    : `Hello ${driver.first_name},\n\nA trip is available in your area.\n\n`
      + `From: ${trip.pickup_address}\nTo: ${trip.dropoff_address}\n\n`
      + `View trips: ${appLink}\n\n— ${appName}`;

  return sendEmail({ to: driver.email, subject, html, text, appName });
}

// ── Template 3: Trip accepted — notify client ─────────────────

/**
 * Sends a confirmation email to the client once a driver has accepted their trip.
 * Includes the driver's name and phone number (if available) so the client can
 * reach out directly if needed.
 *
 * The driver's phone is conditional — some drivers may choose not to share it,
 * in which case the row is simply omitted from the email body.
 *
 * @param {object} param0
 * @param {object} param0.client   - Client record ({ first_name, email })
 * @param {object} param0.driver   - Driver record ({ first_name, last_name, phone })
 * @param {object} param0.trip     - Trip record
 * @param {string} param0.appName  - Organization name
 * @param {string} param0.lang     - Email language ('fr' or 'en')
 * @returns {Promise<object>}
 */
async function sendTripAcceptedToClient({ client, driver, trip, appName, lang }) {
  const isFr    = lang === 'fr';
  const subject = isFr
    ? `✅ ${appName} — Votre transport a été confirmé`
    : `✅ ${appName} — Your ride has been confirmed`;

  // Only show the phone row if the driver has a phone number on their profile
  const driverPhoneRow = driver.phone
    ? `<strong>📞 ${isFr ? 'Téléphone' : 'Phone'} :</strong> ${driver.phone}<br>`
    : '';

  const body = renderTemplate('trip-accepted.html', {
    ...tripVars(trip, lang),
    CLIENT_FIRST:      client.first_name,
    DRIVER_NAME:       driverDisplayName(driver),
    DRIVER_PHONE_ROW:  driverPhoneRow,
    MSG_GREETING:      isFr ? 'Bonne nouvelle'  : 'Great news',
    MSG_INTRO:         isFr
      ? 'Votre demande de transport a été acceptée par un conducteur bénévole.'
      : 'Your transportation request has been accepted by a volunteer driver.',
    MSG_READY:         isFr
      ? 'Soyez prêt(e) à l\'adresse de départ à l\'heure prévue. Bonne route !'
      : 'Please be ready at the pickup address at the scheduled time. Have a safe trip!',
    LABEL_DRIVER:      isFr ? 'Conducteur' : 'Driver',
    LABEL_PHONE:       isFr ? 'Téléphone'  : 'Phone',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous avez fait une demande de transport sur ${appName}.`
    : `You are receiving this because you requested a ride on ${appName}.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Bonne nouvelle, ${client.first_name} !\n\n`
      + `Votre transport a été accepté par ${driverDisplayName(driver)}.\n\n`
      + `Départ : ${trip.pickup_address}\nArrivée : ${trip.dropoff_address}\n\n— ${appName}`
    : `Great news, ${client.first_name}!\n\n`
      + `Your ride has been accepted by ${driverDisplayName(driver)}.\n\n`
      + `From: ${trip.pickup_address}\nTo: ${trip.dropoff_address}\n\n— ${appName}`;

  return sendEmail({ to: client.email, subject, html, text, appName });
}

// ── Template 4: No driver found — trip cancelled ──────────────

/**
 * Sends a cancellation notice to the client when the broadcast window expires
 * and no driver has accepted the trip.
 *
 * Includes a contact email so the client can reach the organization for manual
 * assistance (e.g., if the trip is urgent and needs human intervention).
 *
 * @param {object} param0
 * @param {object} param0.client        - Client record ({ first_name, email })
 * @param {object} param0.trip          - Trip record
 * @param {string} param0.appName       - Organization name
 * @param {string} param0.lang          - Email language ('fr' or 'en')
 * @param {string} param0.contactEmail  - Support/contact email from the configuration table
 * @returns {Promise<object>}
 */
async function sendTripCancelledNoDriver({ client, trip, appName, lang, contactEmail }) {
  const isFr    = lang === 'fr';
  const subject = isFr
    ? `😔 ${appName} — Nous n'avons pas pu trouver de conducteur`
    : `😔 ${appName} — We could not find a driver`;

  const body = renderTemplate('trip-cancelled.html', {
    ...tripVars(trip, lang),
    CLIENT_FIRST:   client.first_name,
    CONTACT_EMAIL:  contactEmail,
    MSG_GREETING:   isFr ? 'Nous sommes désolés'  : 'We\'re sorry',
    MSG_INTRO:      isFr
      ? 'Malheureusement, aucun conducteur bénévole n\'était disponible dans les délais requis pour votre trajet. Votre demande a été annulée.'
      : 'Unfortunately, no volunteer driver was available within the required timeframe for your trip. Your request has been cancelled.',
    MSG_CONTACT:    isFr
      ? 'N\'hésitez pas à soumettre une nouvelle demande ou à nous contacter pour obtenir de l\'aide.'
      : 'Feel free to submit a new request or contact us for assistance.',
    LABEL_CONTACT:  isFr ? 'Contactez-nous' : 'Contact us',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous avez fait une demande de transport sur ${appName}.`
    : `You are receiving this because you requested a ride on ${appName}.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Nous sommes désolés, ${client.first_name}.\n\n`
      + `Aucun conducteur n'était disponible pour votre trajet T-${trip.trip_number}. Demande annulée.\n\n`
      + `Contactez-nous : ${contactEmail}\n\n— ${appName}`
    : `We're sorry, ${client.first_name}.\n\n`
      + `No driver was available for trip T-${trip.trip_number}. Request cancelled.\n\n`
      + `Contact us: ${contactEmail}\n\n— ${appName}`;

  return sendEmail({ to: client.email, subject, html, text, appName });
}

// ── Template 5: Preferred driver declined — notify client ─────

/**
 * Notifies the client that their preferred driver could not take the trip.
 * Reassures them that the request is still active and is being broadcast to
 * other drivers — the client does NOT need to resubmit.
 *
 * This email is sent as part of the fallback flow:
 *   preferred driver notified → preferred driver declines
 *   → this email to client + broadcast to other drivers starts simultaneously
 *
 * @param {object} param0
 * @param {object} param0.client   - Client record ({ first_name, email })
 * @param {object} param0.trip     - Trip record
 * @param {string} param0.appName  - Organization name
 * @param {string} param0.lang     - Email language ('fr' or 'en')
 * @returns {Promise<object>}
 */
async function sendTripDeclinedByPreferredToClient({ client, trip, appName, lang }) {
  const isFr    = lang === 'fr';
  const subject = isFr
    ? `ℹ️ ${appName} — Mise à jour de votre demande de transport`
    : `ℹ️ ${appName} — Update on your transportation request`;

  const body = renderTemplate('trip-declined-preferred.html', {
    ...tripVars(trip, lang),
    CLIENT_FIRST:  client.first_name,
    MSG_GREETING:  isFr ? 'Mise à jour' : 'Update',
    MSG_INTRO:     isFr
      ? 'Le conducteur que vous aviez sélectionné n\'est malheureusement pas disponible pour ce trajet. '
        + 'Votre demande reste active et nous la diffusons maintenant à d\'autres conducteurs bénévoles dans votre secteur.'
      : 'Unfortunately, the driver you selected is not available for this trip. '
        + 'Your request remains active and we are now broadcasting it to other volunteer drivers in your area.',
    MSG_NEXT:      isFr
      ? 'Vous recevrez une confirmation dès qu\'un conducteur accepte votre demande. Merci de votre patience.'
      : 'You will receive a confirmation as soon as a driver accepts your request. Thank you for your patience.',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous avez fait une demande de transport sur ${appName}.`
    : `You are receiving this because you requested a ride on ${appName}.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Mise à jour, ${client.first_name}\n\n`
      + `Le conducteur sélectionné n'est pas disponible. Votre demande reste active.\n\n`
      + `Départ : ${trip.pickup_address}\nArrivée : ${trip.dropoff_address}\n\n— ${appName}`
    : `Update for ${client.first_name}\n\n`
      + `The selected driver is not available. Your request remains active.\n\n`
      + `From: ${trip.pickup_address}\nTo: ${trip.dropoff_address}\n\n— ${appName}`;

  return sendEmail({ to: client.email, subject, html, text, appName });
}

// ── Template 6: Email verification ───────────────────────────

/**
 * Sends a verification email to a newly registered user.
 * The link contains a one-time token that expires in 24 hours.
 *
 * This email is always sent in French regardless of user language preference,
 * because language preference is only set after the account is verified.
 * If multi-language onboarding is needed in the future, pass lang as a parameter.
 *
 * The token is generated by the auth route (/api/auth/register) and stored in
 * the `email_verification_tokens` table until used or expired.
 *
 * @param {object} param0
 * @param {string} param0.firstName - User's first name for personalized greeting
 * @param {string} param0.email     - Destination email address (also shown in footer)
 * @param {string} param0.token     - Verification token (UUID, opaque to the user)
 * @returns {Promise<object>}
 */
async function sendVerificationEmail({ firstName, email, token, appName = 'SolidaRoute' }) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  // The frontend /verify-email route reads the token from the query string
  // and calls POST /api/auth/verify-email to complete verification.
  const link        = `${frontendUrl}/verify-email?token=${token}`;
  const subject     = `✅ Confirmez votre adresse email — ${appName}`;

  const body = renderTemplate('verify-email.html', {
    FIRST_NAME:   firstName,
    VERIFY_LINK:  link,
    MSG_GREETING: 'Bienvenue',
    MSG_INTRO:    `Merci de vous être inscrit sur ${appName} ! Pour activer votre compte, veuillez confirmer votre adresse email.`,
    MSG_EXPIRY:   'Ce lien est valide pendant <strong>24 heures</strong>.',
    MSG_IGNORE:   `Si vous n'avez pas créé de compte sur ${appName}, ignorez simplement ce message.`,
    BTN_VERIFY:   '✅ Confirmer mon adresse email',
  });

  // Show the registered email address in the footer as a reminder to the user
  const footerText = `Inscrit avec l'adresse <strong>${email}</strong>.`;
  const html = wrapLayout(body, layoutVars(subject, appName, 'fr', footerText));

  const text = `Bonjour ${firstName},\n\nConfirmez votre email (valide 24h) :\n${link}\n\n— ${appName}`;

  return sendEmail({ to: email, subject, html, text, appName });
}

// ── Template 7: Payment failed — driver notification ─────────

/**
 * Notifies the driver that the payment for their completed trip could not be
 * processed after all retry attempts have been exhausted.
 *
 * @param {object} param0
 * @param {object} param0.driver       - Driver record ({ first_name, email })
 * @param {object} param0.trip         - Trip record
 * @param {number} param0.amount       - Payment amount in dollars
 * @param {string} param0.currency     - ISO currency code (e.g. 'CAD')
 * @param {string} param0.appName      - Organization name
 * @param {string} param0.lang         - Email language ('fr' or 'en')
 * @param {string} param0.contactEmail - Support email for the driver to reach out
 * @returns {Promise<object>}
 */
async function sendPaymentFailedDriver({ driver, trip, amount, currency, appName, lang, contactEmail }) {
  const isFr    = lang === 'fr';
  const subject = isFr
    ? `⚠️ ${appName} — Paiement non traité pour le trajet T-${trip.trip_number}`
    : `⚠️ ${appName} — Payment could not be processed for trip T-${trip.trip_number}`;

  const body = renderTemplate('payment-failed-driver.html', {
    ...tripVars(trip, lang),
    DRIVER_FIRST:   driver.first_name,
    AMOUNT:         parseFloat(amount).toFixed(2),
    CURRENCY:       currency,
    CONTACT_EMAIL:  contactEmail,
    MSG_GREETING:   isFr ? 'Bonjour' : 'Hello',
    MSG_INTRO:      isFr
      ? `Le paiement du trajet T-${trip.trip_number} n'a pas pu être traité après plusieurs tentatives. Notre équipe a été notifiée et vous contactera pour régulariser la situation.`
      : `The payment for trip T-${trip.trip_number} could not be processed after several attempts. Our team has been notified and will contact you to resolve this.`,
    MSG_CONTACT:    isFr
      ? 'Pour toute question, contactez-nous à '
      : 'For any questions, please contact us at ',
    LABEL_CONTACT:  isFr ? 'Contactez-nous' : 'Contact us',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous êtes conducteur bénévole sur ${appName}.`
    : `You are receiving this because you are a volunteer driver on ${appName}.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Bonjour ${driver.first_name},\n\nLe paiement du trajet T-${trip.trip_number} (${amount} ${currency}) n'a pas pu être traité. Notre équipe vous contactera.\n\n— ${appName}`
    : `Hello ${driver.first_name},\n\nPayment for trip T-${trip.trip_number} (${amount} ${currency}) could not be processed. Our team will contact you.\n\n— ${appName}`;

  return sendEmail({ to: driver.email, subject, html, text, appName });
}

// ── Template 8: Payment failed — admin/operator notification ──

/**
 * Notifies all operators and superadmins that a payment has failed after all
 * retry attempts are exhausted. Sent once per payment (when max retries is reached).
 *
 * @param {object} param0
 * @param {Array}  param0.admins      - Array of admin records ({ email })
 * @param {object} param0.trip        - Trip record
 * @param {object} param0.client      - Client record ({ first_name, last_name })
 * @param {object} param0.driver      - Driver record ({ first_name, last_name })
 * @param {number} param0.amount      - Payment amount in dollars
 * @param {string} param0.currency    - ISO currency code
 * @param {string} param0.appName     - Organization name
 * @param {string} param0.lang        - Email language ('fr' or 'en')
 * @param {number} param0.retryCount  - Number of failed attempts
 * @param {number} param0.maxRetries  - Configured maximum retries
 * @param {string} param0.errorMsg    - Last Stripe error message
 * @returns {Promise<void>}
 */
async function sendPaymentFailedAdmins({ admins, trip, client, driver, amount, currency, appName, lang, retryCount, maxRetries, errorMsg }) {
  const isFr    = lang === 'fr';
  const subject = isFr
    ? `❌ ${appName} — Échec de paiement T-${trip.trip_number} — intervention requise`
    : `❌ ${appName} — Payment failure T-${trip.trip_number} — action required`;

  const body = renderTemplate('payment-failed-admin.html', {
    ...tripVars(trip, lang),
    CLIENT_NAME:    `${client.first_name} ${client.last_name}`,
    DRIVER_NAME:    driver ? `${driver.first_name} ${driver.last_name}` : '—',
    AMOUNT:         parseFloat(amount).toFixed(2),
    CURRENCY:       currency,
    RETRY_COUNT:    retryCount,
    MAX_RETRIES:    maxRetries,
    ERROR_MSG:      errorMsg || '—',
    MSG_INTRO:      isFr
      ? `Échec de paiement pour le trajet T-${trip.trip_number} — toutes les tentatives ont échoué`
      : `Payment failure for trip T-${trip.trip_number} — all retry attempts exhausted`,
  });

  const footerText = isFr
    ? `Notification automatique du système de paiement ${appName}.`
    : `Automated notification from the ${appName} payment system.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Échec de paiement — T-${trip.trip_number}\nMontant : ${amount} ${currency}\nClient : ${client.first_name} ${client.last_name}\nTentatives : ${retryCount}/${maxRetries}\nErreur : ${errorMsg}\n\n— ${appName}`
    : `Payment failure — T-${trip.trip_number}\nAmount: ${amount} ${currency}\nClient: ${client.first_name} ${client.last_name}\nAttempts: ${retryCount}/${maxRetries}\nError: ${errorMsg}\n\n— ${appName}`;

  // Send to each admin individually so failures on one address don't block others
  for (const admin of admins) {
    try {
      await sendEmail({ to: admin.email, subject, html, text, appName });
    } catch (err) {
      logger.error('Failed to send payment failure notification to admin', {
        adminEmail: admin.email,
        error:      err.message,
      });
    }
  }
}

// ── Template 8: Trip message notification ────────────────────

/**
 * Notifies a trip participant (driver or client) that the other party
 * has sent them a new in-app message.
 *
 * Email is fire-and-forget from the route — delivery failures are logged
 * but do not cause the API call to fail.
 *
 * @param {object} param0
 * @param {string} param0.recipientEmail  - Destination email address
 * @param {string} param0.recipientFirst  - Recipient's first name
 * @param {string} param0.senderName      - Full name of the message sender
 * @param {number} param0.tripNumber      - Trip number (shown as T-XXXX)
 * @param {string} param0.pickup          - Trip pickup address
 * @param {string} param0.dropoff         - Trip dropoff address
 * @param {string} param0.body            - The message text (max 500 chars)
 * @param {string} param0.appName         - App/org name from configuration
 * @param {string} param0.lang            - Email language ('fr' or 'en')
 * @returns {Promise<object>}
 */
async function sendTripMessage({
  recipientEmail, recipientFirst, senderName,
  tripNumber, pickup, dropoff, body, appName, lang,
}) {
  const isFr      = lang === 'fr';
  const appLink   = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/messages`;
  const subject   = isFr
    ? `💬 ${appName} — Nouveau message — trajet T-${tripNumber}`
    : `💬 ${appName} — New message — trip T-${tripNumber}`;

  const msgBody = renderTemplate('trip-message.html', {
    RECIPIENT_FIRST: recipientFirst,
    SENDER_NAME:     senderName,
    TRIP_NUMBER:     tripNumber,
    PICKUP:          pickup  || '',
    DROPOFF:         dropoff || '',
    MSG_BODY:        body,
    APP_LINK:        appLink,
    MSG_GREETING:    isFr ? 'Bonjour' : 'Hello',
    MSG_INTRO:       isFr
      ? `<strong>${senderName}</strong> vous a envoyé un message concernant le trajet T-${tripNumber} :`
      : `<strong>${senderName}</strong> sent you a message regarding trip T-${tripNumber}:`,
    BTN_REPLY:       isFr ? '💬 Répondre dans l\'application' : '💬 Reply in the app',
    MSG_FOOTER:      isFr
      ? 'Pour répondre, connectez-vous à l\'application. Ne répondez pas directement à cet email.'
      : 'To reply, please log in to the app. Do not reply directly to this email.',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous participez au trajet T-${tripNumber} sur ${appName}.`
    : `You are receiving this because you are a participant on trip T-${tripNumber} on ${appName}.`;

  const html = wrapLayout(msgBody, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Bonjour ${recipientFirst},\n\n${senderName} vous a envoyé un message pour le trajet T-${tripNumber} :\n\n"${body}"\n\nRépondez dans l'application : ${appLink}\n\n— ${appName}`
    : `Hello ${recipientFirst},\n\n${senderName} sent you a message for trip T-${tripNumber}:\n\n"${body}"\n\nReply in the app: ${appLink}\n\n— ${appName}`;

  return sendEmail({ to: recipientEmail, subject, html, text, appName });
}

// ── Template 10: Trip cancelled manually (by client, driver, or admin) ───────

/**
 * Notifies the OTHER trip participant that the trip has been manually cancelled.
 *
 * Who receives this email:
 *   - Driver:  when the client or an admin cancels an assigned trip
 *   - Client:  when the driver cancels an assigned trip
 *
 * Only sent for assigned trips (driver_id != null).  Pending trips that are
 * cancelled before any driver has accepted require no notification.
 *
 * @param {object} param0
 * @param {object} param0.recipient        - { first_name, email } of the person being notified
 * @param {object} param0.trip             - Trip record
 * @param {string} param0.cancelledByRole  - 'client' | 'driver' | 'operator' | 'superadmin'
 * @param {string} param0.reason           - Mandatory free-text reason supplied by the canceller
 * @param {string} param0.appName          - Organisation name from configuration
 * @param {string} param0.lang             - Email language ('fr' or 'en')
 * @returns {Promise<object>}
 */
async function sendTripCancelledManual({ recipient, trip, cancelledByRole, reason, appName, lang }) {
  const isFr    = lang === 'fr';
  const subject = isFr
    ? `❌ ${appName} — Trajet T-${trip.trip_number} annulé`
    : `❌ ${appName} — Trip T-${trip.trip_number} cancelled`;

  // Map the canceller's role to a human-readable label in the email body.
  const cancellerLabel = isFr
    ? (cancelledByRole === 'driver'    ? 'Le conducteur'
     : cancelledByRole === 'client'    ? 'Le client'
     : 'Un administrateur')
    : (cancelledByRole === 'driver'    ? 'The driver'
     : cancelledByRole === 'client'    ? 'The client'
     : 'An administrator');

  const body = renderTemplate('trip-cancelled-manual.html', {
    ...tripVars(trip, lang),
    RECIPIENT_FIRST:  recipient.first_name,
    MSG_GREETING:     isFr ? 'Trajet annulé' : 'Trip cancelled',
    MSG_INTRO:        isFr
      ? `${cancellerLabel} a annulé le trajet T-${trip.trip_number}.`
      : `${cancellerLabel} has cancelled trip T-${trip.trip_number}.`,
    LABEL_REASON:     isFr ? 'Raison' : 'Reason',
    REASON:           reason,
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous participez à un trajet sur ${appName}.`
    : `You are receiving this because you are a participant on a ${appName} trip.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Trajet annulé — T-${trip.trip_number}\n\n${cancellerLabel} a annulé ce trajet.\nRaison : ${reason}\n\nDépart : ${trip.pickup_address}\nArrivée : ${trip.dropoff_address}\n\n— ${appName}`
    : `Trip cancelled — T-${trip.trip_number}\n\n${cancellerLabel} has cancelled this trip.\nReason: ${reason}\n\nFrom: ${trip.pickup_address}\nTo: ${trip.dropoff_address}\n\n— ${appName}`;

  return sendEmail({ to: recipient.email, subject, html, text, appName });
}

// ── Template 11: Password reset ───────────────────────────────

/**
 * Sends a password-reset link to the user.
 * The link contains a one-time token valid for 1 hour.
 *
 * @param {object} param0
 * @param {string} param0.firstName - User's first name for personalised greeting
 * @param {string} param0.email     - Destination email address
 * @param {string} param0.token     - Reset token (stored in verification_tokens)
 * @param {string} [param0.lang]    - 'fr' or 'en' (defaults to 'fr')
 * @returns {Promise<object>}
 */
async function sendPasswordResetEmail({ firstName, email, token, lang = 'fr', appName = 'SolidaRoute' }) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const link        = `${frontendUrl}/reset-password?token=${token}`;
  const isFr        = lang === 'fr';

  const subject = isFr
    ? `🔐 Réinitialisation de votre mot de passe — ${appName}`
    : `🔐 Reset your password — ${appName}`;

  const body = renderTemplate('password-reset.html', {
    FIRST_NAME:   firstName,
    RESET_LINK:   link,
    MSG_GREETING: isFr ? 'Bonjour'  : 'Hello',
    MSG_INTRO:    isFr
      ? `Vous avez demandé la réinitialisation de votre mot de passe ${appName}. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.`
      : `You requested a password reset for your ${appName} account. Click the button below to choose a new password.`,
    MSG_EXPIRY:   isFr
      ? 'Ce lien est valide pendant <strong>1 heure</strong>.'
      : 'This link is valid for <strong>1 hour</strong>.',
    MSG_IGNORE:   isFr
      ? 'Si vous n\'avez pas demandé cette réinitialisation, ignorez ce message. Votre mot de passe ne changera pas.'
      : 'If you did not request this reset, simply ignore this email. Your password will not change.',
    BTN_RESET:    isFr ? '🔐 Réinitialiser mon mot de passe' : '🔐 Reset my password',
  });

  const footerText = isFr
    ? `Demande envoyée pour l'adresse <strong>${email}</strong>.`
    : `Request sent for <strong>${email}</strong>.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Bonjour ${firstName},\n\nRéinitialisez votre mot de passe (valide 1h) :\n${link}\n\nSi vous n'avez pas fait cette demande, ignorez ce message.\n\n— ${appName}`
    : `Hello ${firstName},\n\nReset your password (valid 1 hour):\n${link}\n\nIf you didn't request this, please ignore this email.\n\n— ${appName}`;

  return sendEmail({ to: email, subject, html, text, appName });
}

// ── Template 12: Departure reminder — client ─────────────────

/**
 * Sends a departure reminder to the client a configurable number of hours
 * before their assigned trip. Includes trip details and the driver's contact info.
 *
 * @param {object} param0
 * @param {object} param0.client       - { first_name, last_name, email, phone }
 * @param {object} param0.driver       - { first_name, last_name, phone }
 * @param {object} param0.trip         - Trip record
 * @param {string} param0.appName      - Organization name
 * @param {string} param0.lang         - 'fr' or 'en'
 * @param {string} param0.contactEmail - Support email address
 */
async function sendTripReminderClient({ client, driver, trip, appName, lang, contactEmail }) {
  const isFr    = lang === 'fr';
  const subject = isFr
    ? `⏰ ${appName} — Rappel : votre trajet T-${trip.trip_number} est bientôt`
    : `⏰ ${appName} — Reminder: your trip T-${trip.trip_number} is coming up`;

  const driverPhone    = driver?.phone || '';
  const driverPhoneRow = driverPhone
    ? `<strong>${isFr ? 'Téléphone' : 'Phone'} :</strong> ${driverPhone}<br>`
    : '';

  const body = renderTemplate('trip-reminder-client.html', {
    ...tripVars(trip, lang),
    CLIENT_FIRST:    client.first_name,
    MSG_TITLE:       isFr ? 'Rappel de trajet' : 'Trip reminder',
    MSG_INTRO:       isFr
      ? `Votre trajet est prévu très prochainement. Voici un rappel des informations.`
      : `Your trip is coming up soon. Here is a summary of the details.`,
    DRIVER_NAME:     driver ? driverDisplayName(driver) : (isFr ? 'Non assigné' : 'Not assigned'),
    DRIVER_PHONE_ROW: driverPhoneRow,
    LABEL_DRIVER:    isFr ? 'Conducteur' : 'Driver',
    LABEL_PHONE:     isFr ? 'Téléphone'  : 'Phone',
    MSG_READY:       isFr
      ? `Soyez prêt(e) à l'heure de départ. Si vous avez besoin d'annuler, contactez-nous dès que possible.`
      : `Please be ready at the departure time. If you need to cancel, contact us as soon as possible.`,
    CONTACT_EMAIL:   contactEmail,
    MSG_CONTACT:     isFr ? 'Pour toute question :' : 'For any questions:',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous avez un trajet confirmé sur ${appName}.`
    : `You are receiving this because you have a confirmed trip on ${appName}.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Rappel — Trajet T-${trip.trip_number}\n\nDépart : ${trip.pickup_address}\nArrivée : ${trip.dropoff_address}\nHeure : ${formatEmailDate(trip.departure_at, lang)}\nConducteur : ${driver ? `${driver.first_name} ${driver.last_name}` : 'Non assigné'}${driverPhone ? `\nTél. conducteur : ${driverPhone}` : ''}\n\nSoyez prêt(e) à l'heure prévue.\n\n— ${appName}`
    : `Reminder — Trip T-${trip.trip_number}\n\nFrom: ${trip.pickup_address}\nTo: ${trip.dropoff_address}\nTime: ${formatEmailDate(trip.departure_at, lang)}\nDriver: ${driver ? `${driver.first_name} ${driver.last_name}` : 'Not assigned'}${driverPhone ? `\nDriver phone: ${driverPhone}` : ''}\n\nPlease be ready at the scheduled time.\n\n— ${appName}`;

  return sendEmail({ to: client.email, subject, html, text, appName });
}

// ── Template 13: Departure reminder — driver ─────────────────

/**
 * Sends a departure reminder to the driver a configurable number of hours
 * before their assigned trip. Includes trip details and the client's contact info.
 *
 * @param {object} param0
 * @param {object} param0.driver       - { first_name, last_name, email }
 * @param {object} param0.client       - { first_name, last_name, phone }
 * @param {object} param0.trip         - Trip record
 * @param {string} param0.appName      - Organization name
 * @param {string} param0.lang         - 'fr' or 'en'
 * @param {string} param0.contactEmail - Support email address
 */
async function sendTripReminderDriver({ driver, client, trip, appName, lang, contactEmail }) {
  const isFr    = lang === 'fr';
  const subject = isFr
    ? `⏰ ${appName} — Rappel : trajet T-${trip.trip_number} bientôt`
    : `⏰ ${appName} — Reminder: trip T-${trip.trip_number} coming up`;

  const clientPhone    = client?.phone || '';
  const clientPhoneRow = clientPhone
    ? `<strong>${isFr ? 'Téléphone' : 'Phone'} :</strong> ${clientPhone}<br>`
    : '';

  const body = renderTemplate('trip-reminder-driver.html', {
    ...tripVars(trip, lang),
    DRIVER_FIRST:    driver.first_name,
    MSG_TITLE:       isFr ? 'Rappel de trajet' : 'Trip reminder',
    MSG_INTRO:       isFr
      ? `Un trajet vous a été assigné et aura lieu très prochainement. Voici un rappel des informations.`
      : `You have an assigned trip coming up soon. Here is a summary of the details.`,
    CLIENT_NAME:     driverDisplayName(client),  // masked "First L." shown to the driver
    CLIENT_PHONE_ROW: clientPhoneRow,
    LABEL_CLIENT:    isFr ? 'Client'     : 'Client',
    LABEL_PHONE:     isFr ? 'Téléphone'  : 'Phone',
    MSG_REMINDER:    isFr
      ? `N'oubliez pas d'être à l'heure au point de départ. Merci pour votre bénévolat !`
      : `Please remember to be on time at the pickup location. Thank you for volunteering!`,
    CONTACT_EMAIL:   contactEmail,
    MSG_CONTACT:     isFr ? 'Pour toute question :' : 'For any questions:',
  });

  const footerText = isFr
    ? `Vous recevez cet email car vous avez un trajet assigné sur ${appName}.`
    : `You are receiving this because you have an assigned trip on ${appName}.`;

  const html = wrapLayout(body, layoutVars(subject, appName, lang, footerText));

  const text = isFr
    ? `Rappel — Trajet T-${trip.trip_number}\n\nDépart : ${trip.pickup_address}\nArrivée : ${trip.dropoff_address}\nHeure : ${formatEmailDate(trip.departure_at, lang)}\nClient : ${driverDisplayName(client)}${clientPhone ? `\nTél. client : ${clientPhone}` : ''}\n\nMerci d'être à l'heure !\n\n— ${appName}`
    : `Reminder — Trip T-${trip.trip_number}\n\nFrom: ${trip.pickup_address}\nTo: ${trip.dropoff_address}\nTime: ${formatEmailDate(trip.departure_at, lang)}\nClient: ${driverDisplayName(client)}${clientPhone ? `\nClient phone: ${clientPhone}` : ''}\n\nPlease be on time!\n\n— ${appName}`;

  return sendEmail({ to: driver.email, subject, html, text, appName });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPreferredDriverNotification,
  sendDriverBroadcast,
  sendTripAcceptedToClient,
  sendTripDeclinedByPreferredToClient,
  sendTripCancelledNoDriver,
  sendPaymentFailedDriver,
  sendPaymentFailedAdmins,
  sendTripMessage,
  sendTripCancelledManual,
  sendTripReminderClient,
  sendTripReminderDriver,
};
