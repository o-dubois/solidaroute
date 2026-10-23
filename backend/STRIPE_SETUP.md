# Stripe Setup

## 1. Install the Stripe npm package
cd /opt/solidaroute/backend
npm install stripe

## 2. Add to your .env file
STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE

## 3. Run the DB migrations
psql -U postgres -d solidaroute -f backend/src/db/migrations/005_stripe_payments.sql
psql -U postgres -d solidaroute -f backend/src/db/migrations/006_stripe_config.sql

## 4. Restart the backend
pm2 restart solidaroute-backend

## Security note
Never put the secret key (sk_...) in the database or frontend code.
Only the publishable key (pk_...) is stored in the configuration table.
