const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

// ------------------------
// Helpers
// ------------------------
function normPhone(p) {
  return String(p || "").replace(/\D/g, "");
}

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const dbPath = path.join(dataDir, "crm.sqlite");
const db = new sqlite3.Database(dbPath);

// маленький helper: выполнить sql и не падать
function runSafe(sql, params = []) {
  return new Promise((resolve) => {
    db.run(sql, params, (err) => resolve(err || null));
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// Добавить колонку, если её нет
async function ensureColumn(table, column, ddl) {
  try {
    const cols = await allAsync(`PRAGMA table_info(${table})`);
    const has = cols.some((c) => String(c.name) === column);
    if (!has) {
      await runSafe(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  } catch (_) {
    // тихо
  }
}

// Нормализовать существующие телефоны в phone_norm
async function backfillPhoneNorm() {
  try {
    const rows = await allAsync(`SELECT id, phone, phone_norm FROM guests ORDER BY id ASC`);
    for (const r of rows) {
      const norm = normPhone(r.phone);
      const cur = String(r.phone_norm || "");
      const next = norm || null;
      if (cur !== String(next || "")) {
        await runSafe(`UPDATE guests SET phone_norm = ? WHERE id = ?`, [next, r.id]);
      }
    }
  } catch (_) {
    // тихо
  }
}

// Если дубли мешают создать уникальный индекс — оставим phone_norm только у первого, остальным null
async function fixDuplicatePhoneNorm() {
  try {
    const dups = await allAsync(
      `
      SELECT phone_norm, COUNT(*) AS c
      FROM guests
      WHERE phone_norm IS NOT NULL AND phone_norm <> ''
      GROUP BY phone_norm
      HAVING c > 1
      `
    );

    for (const d of dups) {
      const pn = d.phone_norm;
      const ids = await allAsync(
        `SELECT id FROM guests WHERE phone_norm = ? ORDER BY id ASC`,
        [pn]
      );
      // оставляем самый первый id, остальные обнуляем
      for (let i = 1; i < ids.length; i++) {
        await runSafe(`UPDATE guests SET phone_norm = NULL WHERE id = ?`, [ids[i].id]);
      }
    }
  } catch (_) {
    // тихо
  }
}

async function ensureUniquePhoneIndex() {
  // частичный уникальный индекс: уникальность только для не-null и не-пустых
  const sql = `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_phone_norm_unique
    ON guests(phone_norm)
    WHERE phone_norm IS NOT NULL AND phone_norm <> ''
  `;

  let err = await runSafe(sql);
  if (!err) return;

  // если упало из-за дублей — чиним и пробуем снова
  const msg = String(err.message || "");
  if (msg.includes("UNIQUE") || msg.includes("constraint")) {
    await fixDuplicatePhoneNorm();
    err = await runSafe(sql);
    if (err) {
      console.log("Create unique index error:", err);
    }
  } else {
    console.log("Create unique index error:", err);
  }
}

function initDb() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        phone TEXT,
        instagram TEXT,
        note TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_id INTEGER NOT NULL,
        check_in DATE NOT NULL,
        check_out DATE NOT NULL,
        guests_count INTEGER DEFAULT 1,
        price_total REAL NOT NULL DEFAULT 0,
        prepayment REAL NOT NULL DEFAULT 50000,
        payment_status TEXT NOT NULL DEFAULT 'PARTIAL',
        booking_status TEXT NOT NULL DEFAULT 'REQUEST',
        source TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (guest_id) REFERENCES guests(id),
        CHECK (check_in < check_out)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exp_date DATE NOT NULL,
        category TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        note TEXT
      )
    `);

    // ---- миграции после создания
    (async () => {
      // 1) колонка phone_norm
      await ensureColumn("guests", "phone_norm", "phone_norm TEXT");

      // 2) backfill
      await backfillPhoneNorm();

      // 3) индекс уникальности
      await ensureUniquePhoneIndex();
    })().catch(() => {});
  });
}

module.exports = {
  db,
  initDb,
  normPhone
};