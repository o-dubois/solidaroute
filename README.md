# SolidaRoute

Community transportation platform connecting vulnerable individuals with volunteer drivers.
Bilingual (FR/EN) web application + Android mobile app.


---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20, Express, PostgreSQL 16 + PostGIS 3 |
| Frontend | React 18, Vite, Tailwind CSS |
| Mobile | React Native (Expo bare workflow), Android |
| Process manager | PM2 |
| Reverse proxy | Nginx + Let's Encrypt (HTTPS) |
| Routing engine | OSRM (self-hosted via Docker) |

---

## External service dependencies

| Service | Purpose | Notes |
|---|---|---|
| **Brevo** | Transactional email (SMTP) | Free tier: 300 emails/day. SMTP credentials go in `backend/.env` |
| **Stripe** | Card payments (SetupIntent + off-session charge) | Test mode supported. Requires both a secret key (`.env`) and a publishable key (configuration panel) |
| **Nominatim** | Address geocoding — Canada/Quebec region | Public API, no key required |
| **Addok** | Address geocoding — France region | Self-hosted, requires the full BAN dataset. Needs ≥ 4 GB RAM server |
| **OSRM** | Road distance and duration calculation | Self-hosted via Docker. Quebec province `.osm.pbf` map file required |
| **EAS Build** | Android APK/AAB cloud builds | Expo account required (`olidel001`). USB debug also works via `npx expo run:android` |
| **Google Play** | Android app distribution | Internal Testing track. Package: `org.solidaroute.app` |

---

## Server requirements

- Ubuntu 24.04 LTS (minimum 2 GB RAM, 50 GB NVMe)
- 6 GB swap file (required for OSRM map preprocessing)
- Node.js 20
- PostgreSQL 16 with PostGIS 3 extension
- Docker (for OSRM)
- PM2 (`npm install -g pm2`)
- Nginx + Certbot

---

## Setup

```bash
# 1. Clone
git clone https://github.com/o-dubois/solidaroute.git
cd solidaroute

# 2. Install backend and frontend dependencies
cd backend && npm install
cd ../frontend && npm install

# 3. Configure environment
cp backend/.env.production.example backend/.env
# Edit backend/.env — fill in DB credentials, JWT secret,
# Stripe secret key, Brevo SMTP credentials, and FILE_ENCRYPTION_KEY

# 4. Create the database
sudo -u postgres psql -c "CREATE USER solidaroute WITH PASSWORD 'yourpassword';"
sudo -u postgres psql -c "CREATE DATABASE solidaroute OWNER solidaroute;"
psql -U solidaroute -d solidaroute -c "CREATE EXTENSION postgis;"
psql -U solidaroute -d solidaroute -f backend/schema.sql

# 5. Create the superadmin account
node backend/scripts/create-superadmin.js admin@yourdomain.com YourPassword123!

# 6. Build the frontend
cd frontend && npm run build

# 7. Start all processes via PM2
pm2 start ecosystem.config.js
pm2 save
```

---

## Demo data

After setup, seed a realistic dataset (Quebec City area):

```bash
node backend/scripts/seed-demo-ca.js
```

Demo accounts (password: `Demo2026!`):

| Role | Email |
|---|---|
| Superadmin | admin@drivers4u.online |
| Operator | operator1@drivers4u.online |
| Client | client1@drivers4u.online |
| Driver (approved) | driver1@drivers4u.online |

---

## Environment variables

See `backend/.env.production.example` for the full list of required variables.
See `ecosystem.config.js` for the PM2 process configuration (5 processes: API, frontend, safeguard, payments, ticket lifecycle).
