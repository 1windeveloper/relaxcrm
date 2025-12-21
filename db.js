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

async function initDb() {
  await db.query("SELECT 1");

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

  console.log("✅ Postgres connected + tables ensured");
}

module.exports = { db, initDb, normPhone };