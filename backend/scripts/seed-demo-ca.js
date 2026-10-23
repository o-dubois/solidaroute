/**
 * @file scripts/seed-demo.js
 * @description Demo data seed script for SolidaRoute.
 *
 * Creates a realistic set of Quebec City–area demo data:
 *   - Configuration (pricing, trips, security, language)
 *   - 2 operators, 1 ticket master
 *   - 5 clients with profiles
 *   - 5 drivers with profiles and vehicle info (4 approved, 1 pending)
 *   - 12 trips in various states (pending, assigned, completed, cancelled)
 *   - Payments and driver earnings for completed trips
 *
 * Email format: role+number@drivers4u.online
 *   operator1@, operator2@, ticketmaster1@,
 *   client1@ … client5@, driver1@ … driver5@
 *
 * All accounts use password: Demo2026!
 *
 * Preserved across runs (never overwritten):
 *   - The superadmin user (admin@drivers4u.online)
 *   - The stripe_publishable_key configuration value
 *
 * Usage (run from /opt/solidaroute/backend):
 *   node scripts/seed-demo.js
 */

'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'solidaroute',
  user:     process.env.DB_USER     || 'solidaroute',
  password: process.env.DB_PASSWORD,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** PostGIS geography point — note ST_MakePoint takes (lon, lat) */
const pt = (lat, lon) =>
  `ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography`;

/** Future timestamp relative to now */
const future = (days, hours = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hours, 0, 0, 0);
  return d.toISOString();
};

/** Past timestamp relative to now */
const past = (days, hours = 14) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hours, 0, 0, 0);
  return d.toISOString();
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function seed() {
  const client = await pool.connect();
  try {
    console.log('Hashing passwords...');
    const hash = await bcrypt.hash('Demo2026!', 12);

    await client.query('BEGIN');

    // ── 0. Preserve superadmin and stripe key before clearing ──────────────
    console.log('Saving superadmin and Stripe key...');

    const { rows: adminRows } = await client.query(
      `SELECT id, email, password_hash, first_name, last_name, phone,
              status, email_verified, is_protected, created_at
       FROM users WHERE role = 'superadmin' LIMIT 1`
    );
    const savedAdmin = adminRows[0] || null;

    const { rows: stripeRows } = await client.query(
      `SELECT value FROM configuration WHERE key = 'stripe_publishable_key' LIMIT 1`
    );
    const savedStripeKey = stripeRows[0]?.value || null;

    if (savedAdmin) {
      console.log(`  ✓ Superadmin preserved: ${savedAdmin.email}`);
    } else {
      console.log('  ⚠ No superadmin found — skipping restore');
    }
    if (savedStripeKey) {
      console.log(`  ✓ Stripe key preserved: ${savedStripeKey.substring(0, 12)}...`);
    }

    // ── 1. Clear all user data (CASCADE handles all FK-linked tables) ──────
    console.log('Clearing database...');
    await client.query(`TRUNCATE users CASCADE`);
    await client.query(`TRUNCATE configuration`);
    await client.query(`SELECT setval('users_member_number_seq', 1, false)`);

    // ── 2. Restore superadmin ──────────────────────────────────────────────
    if (savedAdmin) {
      await client.query(
        `INSERT INTO users
           (id, email, password_hash, first_name, last_name, phone,
            role, status, email_verified, is_protected, created_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 'superadmin', $7, $8, $9, $10)`,
        [
          savedAdmin.id,
          savedAdmin.email,
          savedAdmin.password_hash,
          savedAdmin.first_name,
          savedAdmin.last_name,
          savedAdmin.phone,
          savedAdmin.status,
          savedAdmin.email_verified,
          savedAdmin.is_protected,
          savedAdmin.created_at,
        ]
      );
      console.log('  ✓ Superadmin restored');
    }

    // ── 3. Configuration ───────────────────────────────────────────────────
    console.log('Seeding configuration...');
    const config = [
      // General
      ['app_name',                               'Drivers4U'],
      ['contact_email',                          'contact@drivers4u.online'],
      ['app_timezone',                           'America/Toronto'],
      ['default_phone_country',                  'CA'],
      ['session_timeout_minutes',                '60'],
      ['admin_deletion_retention_days',          '30'],
      ['frontend_language',                      'fr'],
      // Pricing
      ['payment_provider',                       'stripe'],
      ['payment_currency',                       'CAD'],
      ['base_fare',                              '3.00'],
      ['price_per_km',                           '0.90'],
      ['extra_passenger_fee',                    '0.75'],
      ['driver_share_percent',                   '75'],
      ['payment_max_retries',                    '3'],
      ['card_charge_delay_days',                 '2'],
      // Stripe — use saved key if available, otherwise placeholder
      ['stripe_publishable_key',                 savedStripeKey || 'pk_test_REPLACE_ME'],
      // Trips
      ['min_trip_lead_hours',                    '2'],
      ['max_trip_advance_days',                  '60'],
      ['max_return_delay_minutes',               '150'],
      ['safeguard_delay_hours',                  '4'],
      ['preferred_driver_response_hours',        '24'],
      ['broadcast_cutoff_hours',                 '48'],
      ['driver_suggestion_radius_km',            '15'],
      ['driver_selection_required',              'false'],
      ['geocoding_region',                       'CA'],
      ['trip_overlap_buffer_minutes',            '60'],
      ['reminder_hours_before',                  '2'],
      // Drivers
      ['require_driver_license_doc',             'true'],
      ['require_driver_insurance_doc',           'true'],
      ['require_driver_vehicle_registration_doc','true'],
      ['max_document_size_mb',                   '5'],
      // Security
      ['max_login_attempts',                     '5'],
      ['password_min_length',                    '8'],
      ['password_require_uppercase',             'true'],
      ['password_require_lowercase',             'true'],
      ['password_require_number',                'true'],
      ['password_require_special',               'false'],
      // Messaging
      ['message_reply_window_days',              '7'],
      ['message_retention_days',                 '90'],
      // Tickets
      ['ticket_use_delay_days',                  '1'],
      ['ticket_payout_delay_days',               '30'],
      ['mobility_ticket_facial_value',           '10.00'],
      ['mobility_ticket_currency',               'CAD'],
    ];
    for (const [key, value] of config) {
      await client.query(
        `INSERT INTO configuration (key, value) VALUES ($1, $2)`,
        [key, value]
      );
    }

    // ── 4. Operators ───────────────────────────────────────────────────────
    console.log('Seeding operators...');
    const { rows: [op1] } = await client.query(
      `INSERT INTO users
         (email, password_hash, first_name, last_name, phone, role, status, email_verified)
       VALUES ('operator1@drivers4u.online', $1, 'Marie', 'Dubois', '+14185550101',
               'operator', 'active', true)
       RETURNING id`, [hash]
    );
    const { rows: [op2] } = await client.query(
      `INSERT INTO users
         (email, password_hash, first_name, last_name, phone, role, status, email_verified)
       VALUES ('operator2@drivers4u.online', $1, 'Jean', 'Tremblay', '+14185550102',
               'operator', 'active', true)
       RETURNING id`, [hash]
    );
    void op2; // op2 created but not needed as trip creator

    // ── 5. Ticket master ───────────────────────────────────────────────────
    console.log('Seeding ticket master...');
    await client.query(
      `INSERT INTO users
         (email, password_hash, first_name, last_name, phone, role, status, email_verified)
       VALUES ('ticketmaster1@drivers4u.online', $1, 'Sophie', 'Lavoie', '+14185550103',
               'ticket_master', 'active', true)`, [hash]
    );

    // ── 6. Clients ─────────────────────────────────────────────────────────
    console.log('Seeding clients...');
    const clientsData = [
      ['client1@drivers4u.online', 'Alice',   'Bergeron',  '+14185550201'],
      ['client2@drivers4u.online', 'Robert',  'Ouellet',   '+14185550202'],
      ['client3@drivers4u.online', 'Diane',   'Pelletier', '+14185550203'],
      ['client4@drivers4u.online', 'Michel',  'Fortin',    '+14185550204'],
      ['client5@drivers4u.online', 'Suzanne', 'Leblanc',   '+14185550205'],
    ];
    const clientIds = [];
    for (const [email, first, last, phone] of clientsData) {
      const { rows: [u] } = await client.query(
        `INSERT INTO users
           (email, password_hash, first_name, last_name, phone, role, status, email_verified)
         VALUES ($1, $2, $3, $4, $5, 'client', 'active', true)
         RETURNING id`,
        [email, hash, first, last, phone]
      );
      clientIds.push(u.id);
      await client.query(
        `INSERT INTO client_profiles (user_id, preferred_language)
         VALUES ($1, 'fr')`,
        [u.id]
      );
    }

    // ── 7. Drivers ─────────────────────────────────────────────────────────
    console.log('Seeding drivers...');
    // [email, first, last, phone, approval_status,
    //  vehicle_make, vehicle_model, year, color, plate, seats,
    //  home_lat, home_lon, home_address]
    const driversData = [
      ['driver1@drivers4u.online', 'Pierre',    'Martin',   '+14185550301',
       'approved', 'Toyota',   'Sienna',       2022, 'Blanc',  'ABC-123', 5,
       46.8139, -71.2082, '100 Grande Allée, Québec, QC'],
      ['driver2@drivers4u.online', 'Luc',       'Gagnon',   '+14185550302',
       'approved', 'Honda',    'Odyssey',      2021, 'Argent', 'DEF-456', 5,
       46.7767, -71.2851, '500 Route de l\'Église, Sainte-Foy, QC'],
      ['driver3@drivers4u.online', 'François',  'Bouchard', '+14185550303',
       'approved', 'Dodge',    'Grand Caravan',2020, 'Bleu',   'GHI-789', 6,
       46.8607, -71.2494, '200 Rue Clemenceau, Charlesbourg, QC'],
      ['driver4@drivers4u.online', 'Mathieu',   'Roy',      '+14185550304',
       'pending',  'Ford',     'Transit',      2023, 'Noir',   'JKL-012', 7,
       46.8722, -71.1741, '150 Rue Seigneuriale, Beauport, QC'],
      ['driver5@drivers4u.online', 'Alain',     'Côté',     '+14185550305',
       'approved', 'Chrysler', 'Pacifica',     2021, 'Gris',   'MNO-345', 6,
       46.7180, -71.1756, '300 Rue Saint-Georges, Lévis, QC'],
    ];
    const driverIds = [];
    for (const [
      email, first, last, phone, approval,
      make, model, year, color, plate, seats,
      lat, lon, homeAddr
    ] of driversData) {
      const { rows: [u] } = await client.query(
        `INSERT INTO users
           (email, password_hash, first_name, last_name, phone, role, status, email_verified)
         VALUES ($1, $2, $3, $4, $5, 'driver', 'active', true)
         RETURNING id`,
        [email, hash, first, last, phone]
      );
      driverIds.push(u.id);
      await client.query(
        `INSERT INTO driver_profiles
           (user_id, approval_status, approved_at,
            vehicle_make, vehicle_model, vehicle_year, vehicle_color,
            license_plate, seat_count, is_available,
            home_address, home_point, service_radius_km,
            average_rating, review_count)
         VALUES ($1, $2, ${approval === 'approved' ? 'NOW()' : 'NULL'},
                 $3, $4, $5, $6, $7, $8,
                 ${approval === 'approved' ? 'true' : 'false'},
                 $9, ${pt(lat, lon)}, 20, 4.7, 0)`,
        [u.id, approval, make, model, year, color, plate, seats, homeAddr]
      );
    }

    // ── 8. Trips ───────────────────────────────────────────────────────────
    console.log('Seeding trips...');

    // Quebec City area locations: [label, address, lat, lon]
    const locs = {
      hopital:   ['Hôpital de l\'Enfant-Jésus',    '1401 18e Rue, Québec, QC',              46.8388, -71.2155],
      clsc:      ['CLSC Haute-Ville',               '55 Ch Sainte-Foy, Québec, QC',          46.8082, -71.2307],
      pharmacie: ['Pharmacie Jean Coutu Sainte-Foy','3166 Ch Sainte-Foy, Sainte-Foy, QC',    46.7837, -71.2973],
      metro:     ['Station de métro Laurier',       '2345 Ch Sainte-Foy, Québec, QC',        46.7980, -71.2710],
      epicerie:  ['IGA Extra Charlesbourg',         '8500 Blvd Henri-Bourassa, Québec, QC',  46.8712, -71.2631],
      residence: ['Résidence des Bâtisseurs',       '2600 Blvd Laurier, Sainte-Foy, QC',     46.7740, -71.2888],
      gare:      ['Gare du Palais',                 '450 Rue de la Gare-du-Palais, Québec',  46.8139, -71.2048],
      centre:    ['Centre commercial Laurier',      '2700 Blvd Laurier, Sainte-Foy, QC',     46.7751, -71.2840],
    };

    const mktrip = async ({
      client_id, driver_id = null, status,
      pickup, dropoff,
      departure_at, return_at = null,
      passengers = 1, distance_km = 8.5,
      completed_at = null,
    }) => {
      const [, pickupAddr, pLat, pLon] = locs[pickup];
      const [, dropoffAddr, dLat, dLon] = locs[dropoff];
      const cost = parseFloat((3.00 + distance_km * 0.90).toFixed(2));
      const { rows: [t] } = await client.query(
        `INSERT INTO trips
           (client_id, driver_id, status,
            pickup_address,  pickup_point,
            dropoff_address, dropoff_point,
            departure_at, return_at,
            passenger_count, distance_km, estimated_cost,
            created_by_admin, assigned_at, completed_at, updated_at)
         VALUES
           ($1, $2, $3,
            $4, ${pt(pLat, pLon)},
            $5, ${pt(dLat, dLon)},
            $6, $7, $8, $9, $10, $11,
            ${driver_id && status !== 'pending' ? 'NOW()' : 'NULL'},
            ${completed_at ? `'${completed_at}'` : 'NULL'},
            NOW())
         RETURNING id, trip_number`,
        [client_id, driver_id, status,
         pickupAddr, dropoffAddr,
         departure_at, return_at,
         passengers, distance_km, cost,
         op1.id]
      );
      return t;
    };

    // 3 pending trips
    await mktrip({ client_id: clientIds[0], status: 'pending',
      pickup: 'residence', dropoff: 'hopital',
      departure_at: future(2, 9), passengers: 1, distance_km: 7.2 });

    await mktrip({ client_id: clientIds[1], status: 'pending',
      pickup: 'clsc', dropoff: 'pharmacie',
      departure_at: future(3, 14), passengers: 2, distance_km: 5.8 });

    await mktrip({ client_id: clientIds[2], status: 'pending',
      pickup: 'gare', dropoff: 'centre',
      departure_at: future(5, 10), return_at: future(5, 16),
      passengers: 1, distance_km: 6.4 });

    // 3 assigned trips
    await mktrip({ client_id: clientIds[3], driver_id: driverIds[0],
      status: 'assigned', pickup: 'hopital', dropoff: 'residence',
      departure_at: future(1, 11), passengers: 1, distance_km: 7.2 });

    await mktrip({ client_id: clientIds[4], driver_id: driverIds[1],
      status: 'assigned', pickup: 'metro', dropoff: 'epicerie',
      departure_at: future(2, 15), passengers: 3, distance_km: 9.1 });

    await mktrip({ client_id: clientIds[0], driver_id: driverIds[2],
      status: 'assigned', pickup: 'centre', dropoff: 'clsc',
      departure_at: future(4, 9), return_at: future(4, 12),
      passengers: 2, distance_km: 5.3 });

    // 4 completed trips with payments
    const completedTrips = [
      { client_id: clientIds[1], driver_id: driverIds[0],
        pickup: 'hopital',    dropoff: 'pharmacie',
        departure_at: past(5,  10), distance_km:  8.2, completed_at: past(5,  11) },
      { client_id: clientIds[2], driver_id: driverIds[1],
        pickup: 'gare',       dropoff: 'residence',
        departure_at: past(8,  14), distance_km: 11.5, completed_at: past(8,  15) },
      { client_id: clientIds[3], driver_id: driverIds[2],
        pickup: 'centre',     dropoff: 'hopital',
        departure_at: past(12,  9), distance_km:  7.8, completed_at: past(12, 10) },
      { client_id: clientIds[4], driver_id: driverIds[4],
        pickup: 'clsc',       dropoff: 'epicerie',
        departure_at: past(15, 16), distance_km:  6.3, completed_at: past(15, 17) },
    ];

    for (const td of completedTrips) {
      const t            = await mktrip({ ...td, status: 'completed', passengers: 1 });
      const cost         = parseFloat((3.00 + td.distance_km * 0.90).toFixed(2));
      const driver_share = parseFloat((cost * 0.75).toFixed(2));
      const platform_fee = parseFloat((cost - driver_share).toFixed(2));
      await client.query(
        `INSERT INTO payments
           (trip_id, status, payment_method, amount, currency,
            driver_share, platform_fee, paid_at, payment_reference)
         VALUES ($1, 'paid', 'manual', $2, 'CAD', $3, $4, NOW(), $5)`,
        [t.id, cost, driver_share, platform_fee, `REF-${t.trip_number}`]
      );
      await client.query(
        `INSERT INTO driver_earnings (driver_id, trip_id, amount, status, paid_out_at)
         VALUES ($1, $2, $3, 'paid_out', NOW())`,
        [td.driver_id, t.id, driver_share]
      );
    }

    // 2 cancelled trips
    await mktrip({ client_id: clientIds[0], status: 'cancelled',
      pickup: 'gare',      dropoff: 'hopital',
      departure_at: past(3, 9),  distance_km: 6.1 });

    await mktrip({ client_id: clientIds[2], status: 'cancelled',
      pickup: 'pharmacie', dropoff: 'metro',
      departure_at: past(7, 13), distance_km: 4.4 });

    // Set realistic review stats on active drivers
    for (const dId of [driverIds[0], driverIds[1], driverIds[2], driverIds[4]]) {
      await client.query(
        `UPDATE driver_profiles SET review_count = 3, average_rating = 4.7 WHERE user_id = $1`,
        [dId]
      );
    }

    await client.query('COMMIT');

    // ── Summary ────────────────────────────────────────────────────────────
    console.log('');
    console.log('✓ Demo data seeded successfully.');
    console.log('');
    console.log('Accounts (password: Demo2026!):');
    if (savedAdmin) {
      console.log(`  Superadmin    : ${savedAdmin.email}  ← password unchanged`);
    }
    console.log('  Operators     : operator1@drivers4u.online     (Marie Dubois)');
    console.log('                  operator2@drivers4u.online     (Jean Tremblay)');
    console.log('  Ticket master : ticketmaster1@drivers4u.online (Sophie Lavoie)');
    console.log('  Clients       : client1@drivers4u.online       (Alice Bergeron)');
    console.log('                  client2@drivers4u.online       (Robert Ouellet)');
    console.log('                  client3@drivers4u.online       (Diane Pelletier)');
    console.log('                  client4@drivers4u.online       (Michel Fortin)');
    console.log('                  client5@drivers4u.online       (Suzanne Leblanc)');
    console.log('  Drivers       : driver1@drivers4u.online       (Pierre Martin   — approved)');
    console.log('                  driver2@drivers4u.online       (Luc Gagnon      — approved)');
    console.log('                  driver3@drivers4u.online       (François Bouchard— approved)');
    console.log('                  driver4@drivers4u.online       (Mathieu Roy     — pending)');
    console.log('                  driver5@drivers4u.online       (Alain Côté      — approved)');
    console.log('');
    console.log('Trips: 3 pending, 3 assigned, 4 completed, 2 cancelled');
    if (savedStripeKey) {
      console.log(`Stripe key    : restored (${savedStripeKey.substring(0, 12)}...)`);
    } else {
      console.log('Stripe key    : ⚠ set stripe_publishable_key in the configuration panel');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
