const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guests (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT,
      phone_norm TEXT UNIQUE,
      instagram TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      guests_count INTEGER DEFAULT 1,
      price_total INTEGER DEFAULT 0,
      prepayment INTEGER DEFAULT 0,
      payment_status TEXT DEFAULT 'UNPAID',
      booking_status TEXT DEFAULT 'REQUEST',
      source TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      exp_date DATE NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER DEFAULT 0,
      note TEXT
    );
  `);

  console.log("✅ PostgreSQL DB ready");
}

// нормализация телефона
function normPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

module.exports = {
  db: pool,
  initDb,
  normPhone
};