module.exports = {
  apps: [
    // ── Main API server ──────────────────────────────────────────────────────
    {
      name:   'solidaroute-api',
      script: '/opt/solidaroute/backend/src/index.js',
      cwd:    '/opt/solidaroute/backend',
      // Environment variables are loaded from backend/.env via dotenv.
      // Do NOT add secrets here — set them in .env on the server.
    },

    // ── Frontend static server (always running on port 3000) ─────────────────
    // Nginx proxies / to this process; --single enables SPA fallback routing.
    {
      name:        'solidaroute-frontend',
      script:      'npx',
      args:        'serve dist -l 3000 --single',
      cwd:         '/opt/solidaroute/frontend',
      autorestart: true,
      watch:       false,
    },

    // ── Safeguard job (every hour) ───────────────────────────────────────────
    // Handles preferred-driver timeouts, broadcast repeats/cancellations,
    // auto-completion of overdue trips, message/token cleanup, and deferred
    // card/mobility-ticket charges.
    {
      name:          'solidaroute-safeguard',
      script:        '/opt/solidaroute/backend/safeguard.js',
      cwd:           '/opt/solidaroute/backend',
      cron_restart:  '0 * * * *',
      autorestart:   false,       // run-and-exit — do not loop on errors
      watch:         false,
    },

    // ── Payment job (every 15 minutes) ───────────────────────────────────────
    // Charges Stripe-authorized payments, retries failed ones, and creates
    // manual payment records for operator-booked trips that have no payment row.
    {
      name:          'solidaroute-payments',
      script:        '/opt/solidaroute/backend/scripts/payment-job.js',
      cwd:           '/opt/solidaroute/backend',
      cron_restart:  '*/15 * * * *',
      autorestart:   false,
      watch:         false,
    },

    // ── Ticket lifecycle job (daily at 02:00) ────────────────────────────────
    // Advances mobility tickets: reserved → used (after ticket_use_delay_days),
    // then used → paid_out (after ticket_payout_delay_days).
    {
      name:          'solidaroute-tkt-lifecycle',
      script:        '/opt/solidaroute/backend/scripts/ticket-lifecycle-job.js',
      cwd:           '/opt/solidaroute/backend',
      cron_restart:  '0 2 * * *',
      autorestart:   false,
      watch:         false,
    },
  ],
}

