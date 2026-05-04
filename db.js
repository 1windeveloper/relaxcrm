// db.js
const { Pool } = require("pg");

function normPhone(s) {
  return String(s || "").replace(/\D/g, "");
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ DATABASE_URL is not configured (Railway Variables -> relaxcrm)");
  throw new Error("DATABASE_URL is not configured");
}

// Обычно railway.internal работает БЕЗ ssl
// Если вдруг используешь public proxy URL, можно поставить PGSSL=true
const useSSL = String(process.env.PGSSL || "").toLowerCase() === "true";

const db = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// Wait until Postgres is ready before doing anything else.
// Retries up to maxAttempts times with a delay between each try.
async function waitForDb(maxAttempts = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.query("SELECT 1"); // simple ping
      console.log(`✅ Database ready (attempt ${attempt})`);
      return; // success — exit the loop
    } catch (err) {
      console.log(`⏳ DB not ready yet (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      if (attempt === maxAttempts) {
        throw new Error("Could not connect to database after " + maxAttempts + " attempts");
      }
      // wait before the next try
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function initDb() {
  // Connection is already confirmed by waitForDb — skip the extra ping

  await db.query(`
    CREATE TABLE IF NOT EXISTS guests (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT,
      phone_norm TEXT UNIQUE,
      instagram TEXT,
      note TEXT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      check_in TEXT NOT NULL,   -- YYYY-MM-DD
      check_out TEXT NOT NULL,  -- YYYY-MM-DD
      guests_count INTEGER DEFAULT 1,
      price_total NUMERIC DEFAULT 0,
      prepayment NUMERIC DEFAULT 0,
      payment_status TEXT DEFAULT 'UNPAID',
      booking_status TEXT DEFAULT 'REQUEST',
      source TEXT,
      notes TEXT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      exp_date TEXT NOT NULL,   -- YYYY-MM-DD
      category TEXT NOT NULL,
      amount NUMERIC DEFAULT 0,
      note TEXT
    );
  `);

  // Safe performance indexes — idempotent, never drop/alter existing data
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bookings_check_in  ON bookings(check_in)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bookings_check_out ON bookings(check_out)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bookings_status    ON bookings(booking_status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bookings_guest     ON bookings(guest_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_expenses_date      ON expenses(exp_date)`);

  console.log("✅ Postgres connected + tables + indexes ensured");
}

module.exports = { db, initDb, waitForDb, normPhone };