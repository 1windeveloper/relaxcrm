require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const { db, initDb, normPhone } = require("./db.js");

const app = express();
app.use(express.json());

// ===== AUTH CONFIG =====
const ADMIN_USER = process.env.ADMIN_USER || "parents";
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "change_me_please";

// cookies + session
app.set("trust proxy", 1);
app.use(
  session({
    name: "rbcrm.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  })
);

function isAuthed(req) {
  return req.session && req.session.user === "admin";
}

function requireAuth(req, res, next) {
  if (req.path === "/login.html") return next();
  if (req.path === "/api/auth/login") return next();

  const isStaticFile =
    req.method === "GET" &&
    (req.path.endsWith(".css") ||
      req.path.endsWith(".js") ||
      req.path.endsWith(".png") ||
      req.path.endsWith(".jpg") ||
      req.path.endsWith(".svg") ||
      req.path.endsWith(".ico"));

  if (isStaticFile) return next();

  if (!isAuthed(req)) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
    return res.redirect("/login.html");
  }

  next();
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

// если заходят на корень сайта — решаем куда
app.get("/", (req, res) => {
  if (!isAuthed(req)) return res.redirect("/login.html");
  return res.redirect("/index.html");
});

// ===== AUTH ROUTES =====
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username = "", password = "" } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });

    if (!ADMIN_PASS_HASH) return res.status(500).json({ error: "ADMIN_PASS_HASH is not configured" });

    if (String(username) !== String(ADMIN_USER)) return res.status(401).json({ error: "invalid credentials" });

    const ok = await bcrypt.compare(String(password), String(ADMIN_PASS_HASH));
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    req.session.user = "admin";
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("rbcrm.sid");
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ ok: true, authed: isAuthed(req) });
});

// ------------------------
// Helpers
// ------------------------
function pickDefined(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function splitTokens(q) {
  return normalizeText(q).split(" ").filter(Boolean).slice(0, 6);
}

// пересечение есть, если (new_check_in < old_check_out) AND (new_check_out > old_check_in)
async function checkOverlap(check_in, check_out, excludeId = null) {
  const params = [check_in, check_out];
  let extra = "";

  if (excludeId) {
    extra = "AND id <> $3";
    params.push(Number(excludeId));
  }

  const { rows } = await db.query(
    `
    SELECT id, check_in, check_out
    FROM bookings
    WHERE booking_status IN ('REQUEST','CONFIRMED')
      AND ($1 < check_out)
      AND ($2 > check_in)
      ${extra}
    `,
    params
  );

  return rows;
}

// ------------------------
// API: Guests (list + search)
// ------------------------
app.get("/api/guests", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();

    if (!qRaw) {
      const { rows } = await db.query(`SELECT * FROM guests ORDER BY id DESC`);
      return res.json(rows);
    }

    const qText = normalizeText(qRaw);
    const tokens = splitTokens(qText);

    const qDigits = normPhone(qRaw);
    const likeDigits = `%${qDigits}%`;
    const likeText = `%${qText}%`;

    const whereParts = [];
    const params = [];
    let idx = 1;

    // AND по токенам в full_name
    if (tokens.length) {
      for (const t of tokens) {
        whereParts.push(`lower(full_name) LIKE $${idx++}`);
        params.push(`%${t}%`);
      }
    } else {
      whereParts.push("1=1");
    }

    // ig/phone текст
    const igParam = `$${idx++}`;
    const phoneParam = `$${idx++}`;
    params.push(likeText, likeText);

    // digits
    const digitsCheck = qDigits ? `OR phone_norm LIKE $${idx++}` : "";
    if (qDigits) params.push(likeDigits);

    const sql = `
      SELECT *
      FROM guests
      WHERE
        ((${whereParts.join(" AND ")})
          OR lower(instagram) LIKE ${igParam}
          OR lower(phone) LIKE ${phoneParam}
        )
        ${digitsCheck}
      ORDER BY id DESC
    `;

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// API: Guests create (phone_norm UNIQUE)
// ------------------------
app.post("/api/guests", async (req, res) => {
  try {
    const { full_name, phone = "", instagram = "", note = "" } = req.body || {};
    if (!full_name) return res.status(400).json({ error: "full_name is required" });

    const phoneRaw = String(phone || "").trim();
    const phoneNorm = normPhone(phoneRaw) || null;

    const q = `
      INSERT INTO guests(full_name, phone, phone_norm, instagram, note)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id
    `;
    const params = [
      String(full_name).trim(),
      phoneRaw,
      phoneNorm,
      String(instagram || "").trim(),
      String(note || "").trim(),
    ];

    const r = await db.query(q, params);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    // уникальный конфликт
    if (e && e.code === "23505") {
      const phoneNorm = normPhone(req.body?.phone || "") || null;
      if (phoneNorm) {
        const ex = await db.query(`SELECT id, full_name, phone FROM guests WHERE phone_norm=$1 LIMIT 1`, [phoneNorm]);
        if (ex.rows[0]) {
          return res.status(409).json({
            error: "phone duplicate",
            existing: { id: ex.rows[0].id, full_name: ex.rows[0].full_name, phone: ex.rows[0].phone },
          });
        }
      }
      return res.status(409).json({ error: "phone duplicate" });
    }

    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// API: Guest bookings (history + totals)
// ------------------------
app.get("/api/guests/:id/bookings", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id is required" });

    const g = await db.query(
      `SELECT id, full_name, phone, phone_norm, instagram, note FROM guests WHERE id=$1`,
      [id]
    );
    const guest = g.rows[0];
    if (!guest) return res.status(404).json({ error: "guest not found" });

    const b = await db.query(
      `
      SELECT b.*, g.full_name, g.phone
      FROM bookings b
      JOIN guests g ON g.id = b.guest_id
      WHERE b.guest_id = $1
      ORDER BY b.check_in DESC
      `,
      [id]
    );

    const rows = b.rows;

    const activeRows = rows.filter((r) => String(r.booking_status) !== "CANCELLED");
    const total = activeRows.reduce((s, r) => s + Number(r.price_total || 0), 0);
    const prepay = activeRows.reduce((s, r) => s + Number(r.prepayment || 0), 0);

    res.json({
      guest,
      guest_id: id,
      count: rows.length,
      total,
      prepayment: prepay,
      bookings: rows,
    });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// API: Bookings list
// ------------------------
app.get("/api/bookings", async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT b.*, g.full_name, g.phone
      FROM bookings b
      JOIN guests g ON g.id = b.guest_id
      ORDER BY b.check_in ASC
      `
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// API: Bookings create
// ------------------------
app.post("/api/bookings", async (req, res) => {
  try {
    const {
      guest_id,
      check_in,
      check_out,
      guests_count = 1,
      price_total = 0,
      prepayment = 50000,
      payment_status = "PARTIAL",
      booking_status = "REQUEST",
      source = "",
      notes = "",
    } = req.body || {};

    if (!guest_id) return res.status(400).json({ error: "guest_id is required" });
    if (!check_in || !check_out) return res.status(400).json({ error: "check_in and check_out are required" });
    if (check_in >= check_out) return res.status(400).json({ error: "check_in must be < check_out" });

    const overlaps = await checkOverlap(check_in, check_out);
    if (overlaps.length) return res.status(409).json({ error: "dates overlap", overlaps });

    const r = await db.query(
      `
      INSERT INTO bookings(
        guest_id, check_in, check_out, guests_count,
        price_total, prepayment, payment_status, booking_status, source, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
      `,
      [
        Number(guest_id),
        check_in,
        check_out,
        Number(guests_count || 1),
        Number(price_total || 0),
        Number(prepayment || 0),
        String(payment_status || "UNPAID"),
        String(booking_status || "REQUEST"),
        String(source || "").trim(),
        String(notes || "").trim(),
      ]
    );

    res.json({ ok: true, id: r.rows[0].id });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ------------------------
// API: Booking status patch
// ------------------------
app.patch("/api/bookings/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { booking_status } = req.body || {};
    const allowed = ["REQUEST", "CONFIRMED", "CANCELLED", "COMPLETED"];
    if (!allowed.includes(booking_status)) return res.status(400).json({ error: "invalid booking_status" });

    await db.query(`UPDATE bookings SET booking_status=$1 WHERE id=$2`, [booking_status, id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// API: Booking full update
// ------------------------
app.put("/api/bookings/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    if (!id) return res.status(400).json({ error: "id is required" });
    if (!b.guest_id) return res.status(400).json({ error: "guest_id is required" });
    if (!b.check_in || !b.check_out) return res.status(400).json({ error: "check_in/check_out required" });
    if (b.check_in >= b.check_out) return res.status(400).json({ error: "check_out must be after check_in" });

    const allowedBooking = ["REQUEST", "CONFIRMED", "CANCELLED", "COMPLETED"];
    const allowedPay = ["UNPAID", "PARTIAL", "PAID"];

    const booking_status = String(b.booking_status || "REQUEST");
    const payment_status = String(b.payment_status || "UNPAID");

    if (!allowedBooking.includes(booking_status)) return res.status(400).json({ error: "invalid booking_status" });
    if (!allowedPay.includes(payment_status)) return res.status(400).json({ error: "invalid payment_status" });

    const overlaps = await checkOverlap(b.check_in, b.check_out, id);
    if (overlaps.length) return res.status(409).json({ error: "dates overlap", overlaps });

    await db.query(
      `
      UPDATE bookings SET
        guest_id=$1,
        check_in=$2,
        check_out=$3,
        guests_count=$4,
        price_total=$5,
        prepayment=$6,
        payment_status=$7,
        booking_status=$8,
        source=$9,
        notes=$10
      WHERE id=$11
      `,
      [
        Number(b.guest_id),
        b.check_in,
        b.check_out,
        Number(b.guests_count || 1),
        Number(b.price_total || 0),
        Number(b.prepayment || 0),
        payment_status,
        booking_status,
        String(b.source || "").trim(),
        String(b.notes || "").trim(),
        id,
      ]
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ------------------------
// API: Booking partial update
// ------------------------
app.patch("/api/bookings/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id is required" });

    const allowedFields = [
      "guest_id",
      "check_in",
      "check_out",
      "guests_count",
      "price_total",
      "prepayment",
      "payment_status",
      "booking_status",
      "source",
      "notes",
    ];

    const patch = pickDefined(req.body || {}, allowedFields);
    const keys = Object.keys(patch);
    if (!keys.length) return res.status(400).json({ error: "no fields to update" });

    const allowedBooking = ["REQUEST", "CONFIRMED", "CANCELLED", "COMPLETED"];
    const allowedPay = ["UNPAID", "PARTIAL", "PAID"];

    if (patch.booking_status && !allowedBooking.includes(String(patch.booking_status))) {
      return res.status(400).json({ error: "invalid booking_status" });
    }
    if (patch.payment_status && !allowedPay.includes(String(patch.payment_status))) {
      return res.status(400).json({ error: "invalid payment_status" });
    }

    // если меняем даты — проверим пересечения
    const needDatesCheck = patch.check_in !== undefined || patch.check_out !== undefined;

    if (needDatesCheck) {
      const cur = await db.query(`SELECT check_in, check_out FROM bookings WHERE id=$1`, [id]);
      const row = cur.rows[0];
      if (!row) return res.status(404).json({ error: "booking not found" });

      const nextCheckIn = patch.check_in !== undefined ? patch.check_in : row.check_in;
      const nextCheckOut = patch.check_out !== undefined ? patch.check_out : row.check_out;

      if (!nextCheckIn || !nextCheckOut) return res.status(400).json({ error: "check_in/check_out required" });
      if (nextCheckIn >= nextCheckOut) return res.status(400).json({ error: "check_out must be after check_in" });

      const overlaps = await checkOverlap(nextCheckIn, nextCheckOut, id);
      if (overlaps.length) return res.status(409).json({ error: "dates overlap", overlaps });

      patch.check_in = nextCheckIn;
      patch.check_out = nextCheckOut;
    }

    // строим UPDATE динамически
    const cols = Object.keys(patch);
    const setSql = cols.map((c, i) => `${c}=$${i + 1}`).join(", ");
    const params = cols.map((c) => patch[c]);
    params.push(id);

    await db.query(`UPDATE bookings SET ${setSql} WHERE id=$${params.length}`, params);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// API: Booking cancel
// ------------------------
app.patch("/api/bookings/:id/cancel", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id is required" });

    await db.query(
      `
      UPDATE bookings
      SET booking_status='CANCELLED',
          price_total=0,
          prepayment=0,
          payment_status='UNPAID'
      WHERE id=$1
      `,
      [id]
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// API: Expenses
// ------------------------
app.get("/api/expenses", async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM expenses ORDER BY exp_date DESC, id DESC`);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

app.post("/api/expenses", async (req, res) => {
  try {
    const { exp_date, category, amount = 0, note = "" } = req.body || {};
    if (!exp_date) return res.status(400).json({ error: "exp_date is required" });
    if (!category) return res.status(400).json({ error: "category is required" });

    const r = await db.query(
      `INSERT INTO expenses(exp_date, category, amount, note) VALUES ($1,$2,$3,$4) RETURNING id`,
      [exp_date, String(category).trim(), Number(amount || 0), String(note || "").trim()]
    );

    res.json({ ok: true, id: r.rows[0].id });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

app.delete("/api/expenses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.query(`DELETE FROM expenses WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// API: Stats (revenue/expenses/net)
// month: YYYY-MM (фильтр по первым 7 символам)
// ------------------------
app.get("/api/stats", async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();

    const bSql = month
      ? `SELECT COALESCE(SUM(price_total),0) AS revenue
         FROM bookings
         WHERE booking_status <> 'CANCELLED' AND TO_CHAR(check_in::date, 'YYYY-MM') = $1`
      : `SELECT COALESCE(SUM(price_total),0) AS revenue
         FROM bookings
         WHERE booking_status <> 'CANCELLED'`;

    const eSql = month
      ? `SELECT COALESCE(SUM(amount),0) AS expenses
         FROM expenses
         WHERE TO_CHAR(exp_date::date, 'YYYY-MM') = $1`
      : `SELECT COALESCE(SUM(amount),0) AS expenses
         FROM expenses`;

    const b = month ? await db.query(bSql, [month]) : await db.query(bSql);
    const e = month ? await db.query(eSql, [month]) : await db.query(eSql);

    const revenue = Number(b?.rows?.[0]?.revenue ?? 0);
    const expenses = Number(e?.rows?.[0]?.expenses ?? 0);

    res.json({ month: month || null, revenue, expenses, net: revenue - expenses });
  } catch (err) {
    console.error("❌ /api/stats error:", err);
    res.status(500).json({ error: "db error" });
  }
});
// ------------------------
// Finance: revenue-by-month (по году)
// ------------------------
app.get("/api/revenue-by-month", async (req, res) => {
  try {
    const year = Number(req.query.year);
    if (!year || year < 2000 || year > 2100) return res.status(400).json({ error: "year is required" });

    const y = String(year);

    const { rows } = await db.query(
      `
      SELECT to_char(check_in::date, 'MM') AS m,
             SUM(price_total) AS revenue
      FROM bookings
      WHERE booking_status IN ('CONFIRMED','COMPLETED')
        AND to_char(check_in::date, 'YYYY') = $1
      GROUP BY m
      ORDER BY m
      `,
      [y]
    );

    const out = Array.from({ length: 12 }, (_, i) => ({
      month: String(i + 1).padStart(2, "0"),
      revenue: 0,
    }));

    for (const r of rows) {
      const idx = Number(r.m) - 1;
      if (idx >= 0 && idx < 12) out[idx].revenue = Number(r.revenue || 0);
    }

    res.json({ year, months: out });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// Finance: profit-by-month (revenue/expenses/net)
// ------------------------
app.get("/api/profit-by-month", async (req, res) => {
  try {
    const year = Number(req.query.year);
    if (!year || year < 2000 || year > 2100) return res.status(400).json({ error: "year is required" });

    const y = String(year);

    const { rows } = await db.query(
      `
      WITH rev AS (
        SELECT to_char(check_in::date, 'MM') AS m,
               SUM(price_total) AS revenue
        FROM bookings
        WHERE booking_status IN ('CONFIRMED','COMPLETED')
          AND to_char(check_in::date, 'YYYY') = $1
        GROUP BY m
      ),
      exp AS (
        SELECT to_char(exp_date::date, 'MM') AS m,
               SUM(amount) AS expenses
        FROM expenses
        WHERE to_char(exp_date::date, 'YYYY') = $1
        GROUP BY m
      )
      SELECT
        to_char(gs.n, 'FM00') AS month,
        COALESCE(rev.revenue, 0) AS revenue,
        COALESCE(exp.expenses, 0) AS expenses,
        (COALESCE(rev.revenue, 0) - COALESCE(exp.expenses, 0)) AS net
      FROM generate_series(1,12) AS gs(n)
      LEFT JOIN rev ON rev.m = to_char(gs.n, 'FM00')
      LEFT JOIN exp ON exp.m = to_char(gs.n, 'FM00')
      ORDER BY gs.n
      `,
      [y]
    );

    res.json({
      year,
      months: rows.map((r) => ({
        month: r.month,
        revenue: Number(r.revenue || 0),
        expenses: Number(r.expenses || 0),
        net: Number(r.net || 0),
      })),
    });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ------------------------
// CSV export by year
// ------------------------
app.get("/api/export/year.csv", async (req, res) => {
  try {
    const year = Number(req.query.year);
    if (!year || year < 2000 || year > 2100) return res.status(400).send("year is required");

    const y = String(year);

    const r1 = await db.query(
      `
      SELECT COALESCE(SUM(price_total),0) AS revenue
      FROM bookings
      WHERE booking_status IN ('CONFIRMED','COMPLETED')
        AND to_char(check_in::date, 'YYYY') = $1
      `,
      [y]
    );

    const r2 = await db.query(
      `
      SELECT COALESCE(SUM(amount),0) AS expenses
      FROM expenses
      WHERE to_char(exp_date::date, 'YYYY') = $1
      `,
      [y]
    );

// ✅ НОВЫЙ КОД:
    // Безопасное извлечение данных с проверкой на undefined/null
    const revenue = Number(r1?.rows?.[0]?.revenue ?? 0);
    const expenses = Number(r2?.rows?.[0]?.expenses ?? 0);
    const net = revenue - expenses;
    const byMonth = await db.query(
      `
      WITH rev AS (
        SELECT to_char(check_in::date, 'MM') AS m,
               SUM(price_total) AS v
        FROM bookings
        WHERE booking_status IN ('CONFIRMED','COMPLETED')
          AND to_char(check_in::date, 'YYYY') = $1
        GROUP BY m
      ),
      exp AS (
        SELECT to_char(exp_date::date, 'MM') AS m,
               SUM(amount) AS v
        FROM expenses
        WHERE to_char(exp_date::date, 'YYYY') = $1
        GROUP BY m
      )
      SELECT
        to_char(gs.n, 'FM00') AS month,
        COALESCE(rev.v, 0) AS revenue,
        COALESCE(exp.v, 0) AS expenses,
        (COALESCE(rev.v,0) - COALESCE(exp.v,0)) AS net
      FROM generate_series(1,12) AS gs(n)
      LEFT JOIN rev ON rev.m = to_char(gs.n, 'FM00')
      LEFT JOIN exp ON exp.m = to_char(gs.n, 'FM00')
      ORDER BY gs.n
      `,
      [y]
    );

    const header = "year,month,revenue,expenses,net\n";
    const lines = byMonth.rows.map(
      (r) => `${year},${r.month},${Number(r.revenue)},${Number(r.expenses)},${Number(r.net)}`
    );
    lines.push(`${year},TOTAL,${revenue},${expenses},${net}`);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="relax_${year}.csv"`);
    res.send(header + lines.join("\n"));
  } catch {
    res.status(500).send("db error");
  }
});

// ========================
// API: Analytics (comprehensive)
// ========================
app.get("/api/analytics", async (req, res) => {
  try {
    const dfRaw = String(req.query.date_from || "").trim();
    const dtRaw = String(req.query.date_to || "").trim();
    const statusRaw = String(req.query.status || "").trim();
    const yearRaw = parseInt(req.query.year || new Date().getFullYear(), 10);

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const df = dateRe.test(dfRaw) ? dfRaw : null;
    const dt = dateRe.test(dtRaw) ? dtRaw : null;

    const validStatuses = ["REQUEST", "CONFIRMED", "COMPLETED", "CANCELLED"];
    const allActive = ["CONFIRMED", "COMPLETED", "REQUEST"];
    const useStatuses = validStatuses.includes(statusRaw) ? [statusRaw] : allActive;

    const todayDate = new Date();
    const today = todayDate.toISOString().slice(0, 10);
    const wDay = todayDate.getDay();
    const wDiff = wDay === 0 ? -6 : 1 - wDay;
    const weekStartDate = new Date(todayDate);
    weekStartDate.setDate(todayDate.getDate() + wDiff);
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + "-01";

    function buildSC(statuses, startIdx) {
      return `booking_status IN (${statuses.map((_, i) => `$${startIdx + i}`).join(", ")})`;
    }

    async function getRevCount(fromDate, toDate, statuses) {
      const params = [...statuses];
      let idx = statuses.length + 1;
      let dc = "";
      if (fromDate) { dc += ` AND check_in >= $${idx++}`; params.push(fromDate); }
      if (toDate) { dc += ` AND check_in <= $${idx++}`; params.push(toDate); }
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(price_total),0) AS v, COUNT(*) AS cnt FROM bookings WHERE ${buildSC(statuses, 1)}${dc}`,
        params
      );
      return { revenue: Number(rows[0]?.v || 0), count: Number(rows[0]?.cnt || 0) };
    }

    async function getExpAmt(fromDate, toDate) {
      const params = [];
      let idx = 1;
      let dc = "";
      if (fromDate) { dc += ` AND exp_date >= $${idx++}`; params.push(fromDate); }
      if (toDate) { dc += ` AND exp_date <= $${idx++}`; params.push(toDate); }
      const { rows } = await db.query(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE 1=1${dc}`, params);
      return Number(rows[0]?.v || 0);
    }

    const [todayStats, weekStats, monthStats, allStats] = await Promise.all([
      getRevCount(today, today, allActive),
      getRevCount(weekStart, today, allActive),
      getRevCount(monthStart, today, allActive),
      getRevCount(null, null, allActive),
    ]);

    const periodStats = await getRevCount(df, dt, useStatuses);
    const periodExpenses = await getExpAmt(df, dt);
    const avgCheck = periodStats.count > 0 ? Math.round(periodStats.revenue / periodStats.count) : 0;

    const { rows: bRows } = await db.query(`SELECT booking_status, COUNT(*) AS cnt FROM bookings GROUP BY booking_status`);
    const statusBreakdown = {};
    for (const r of bRows) statusBreakdown[r.booking_status] = Number(r.cnt);

    const chartFrom = df || monthStart;
    const chartTo = dt || today;

    const [dRevRows, dExpRows] = await Promise.all([
      db.query(
        `SELECT check_in AS date, SUM(price_total) AS revenue
         FROM bookings
         WHERE booking_status IN ('CONFIRMED','COMPLETED','REQUEST') AND check_in >= $1 AND check_in <= $2
         GROUP BY check_in ORDER BY check_in`,
        [chartFrom, chartTo]
      ),
      db.query(
        `SELECT exp_date AS date, SUM(amount) AS expenses
         FROM expenses WHERE exp_date >= $1 AND exp_date <= $2
         GROUP BY exp_date ORDER BY exp_date`,
        [chartFrom, chartTo]
      ),
    ]);

    const revByDay = {};
    for (const r of dRevRows.rows) revByDay[String(r.date).slice(0, 10)] = Number(r.revenue || 0);
    const expByDay = {};
    for (const r of dExpRows.rows) expByDay[String(r.date).slice(0, 10)] = Number(r.expenses || 0);

    const daily = [];
    const startD = new Date(chartFrom + "T00:00:00");
    const endD = new Date(chartTo + "T00:00:00");
    let cnt = 0;
    for (let d = new Date(startD); d <= endD && cnt < 180; d.setDate(d.getDate() + 1), cnt++) {
      const ds = d.toISOString().slice(0, 10);
      daily.push({ date: ds, revenue: revByDay[ds] || 0, expenses: expByDay[ds] || 0 });
    }

    const year = yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : new Date().getFullYear();
    const { rows: mRows } = await db.query(
      `WITH rev AS (
        SELECT to_char(check_in::date, 'MM') AS m, SUM(price_total) AS revenue
        FROM bookings WHERE booking_status IN ('CONFIRMED','COMPLETED','REQUEST') AND to_char(check_in::date, 'YYYY')=$1
        GROUP BY m
      ), exp AS (
        SELECT to_char(exp_date::date, 'MM') AS m, SUM(amount) AS expenses
        FROM expenses WHERE to_char(exp_date::date, 'YYYY')=$1 GROUP BY m
      )
      SELECT to_char(gs.n,'FM00') AS month,
             COALESCE(rev.revenue,0) AS revenue, COALESCE(exp.expenses,0) AS expenses,
             (COALESCE(rev.revenue,0)-COALESCE(exp.expenses,0)) AS net
      FROM generate_series(1,12) AS gs(n)
      LEFT JOIN rev ON rev.m=to_char(gs.n,'FM00')
      LEFT JOIN exp ON exp.m=to_char(gs.n,'FM00')
      ORDER BY gs.n`,
      [String(year)]
    );

    res.json({
      kpi: {
        today: todayStats.revenue,
        week: weekStats.revenue,
        month: monthStats.revenue,
        all_time: allStats.revenue,
        period: periodStats.revenue,
        bookings_count: periodStats.count,
        avg_check: avgCheck,
        expenses: periodExpenses,
        net_profit: periodStats.revenue - periodExpenses,
      },
      chart: {
        daily,
        monthly: mRows.map((r) => ({
          month: r.month,
          revenue: Number(r.revenue || 0),
          expenses: Number(r.expenses || 0),
          net: Number(r.net || 0),
        })),
      },
      status_breakdown: statusBreakdown,
    });
  } catch (err) {
    console.error("❌ /api/analytics error:", err);
    res.status(500).json({ error: "db error" });
  }
});

// ========================
// DELETE /api/bookings/:id  (hard delete)
// ========================
app.delete("/api/bookings/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id is required" });
    await db.query("DELETE FROM bookings WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ========================
// PUT /api/guests/:id  (update)
// ========================
app.put("/api/guests/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id is required" });
    const { full_name, phone = "", instagram = "", note = "" } = req.body || {};
    if (!full_name) return res.status(400).json({ error: "full_name is required" });
    const phoneRaw = String(phone || "").trim();
    const phoneNorm = normPhone(phoneRaw) || null;
    await db.query(
      `UPDATE guests SET full_name=$1, phone=$2, phone_norm=$3, instagram=$4, note=$5 WHERE id=$6`,
      [String(full_name).trim(), phoneRaw, phoneNorm, String(instagram || "").trim(), String(note || "").trim(), id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === "23505") return res.status(409).json({ error: "phone duplicate" });
    res.status(500).json({ error: "db error" });
  }
});

// ========================
// DELETE /api/guests/:id  (cascades to bookings)
// ========================
app.delete("/api/guests/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id is required" });
    await db.query("DELETE FROM guests WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ========================
// PUT /api/expenses/:id  (update)
// ========================
app.put("/api/expenses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id is required" });
    const { exp_date, category, amount = 0, note = "" } = req.body || {};
    if (!exp_date) return res.status(400).json({ error: "exp_date is required" });
    if (!category) return res.status(400).json({ error: "category is required" });
    await db.query(
      `UPDATE expenses SET exp_date=$1, category=$2, amount=$3, note=$4 WHERE id=$5`,
      [exp_date, String(category).trim(), Number(amount || 0), String(note || "").trim(), id]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "db error" });
  }
});

// ========================
// Excel Export: Bookings
// ========================
app.get("/api/export/bookings.xlsx", async (req, res) => {
  try {
    console.error("ALL BOOKINGS EXPORT STARTED");
    const ExcelJS = require("exceljs");
    const dfRaw = String(req.query.date_from || "").trim();
    const dtRaw = String(req.query.date_to || "").trim();
    const statusRaw = String(req.query.status || "").trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const df = dateRe.test(dfRaw) ? dfRaw : null;
    const dt = dateRe.test(dtRaw) ? dtRaw : null;
    const validSt = ["REQUEST", "CONFIRMED", "COMPLETED", "CANCELLED"];
    const useSt = validSt.includes(statusRaw) ? statusRaw : null;

    const params = [];
    let where = "1=1";
    let idx = 1;
    if (df) { where += ` AND b.check_in >= $${idx++}`; params.push(df); }
    if (dt) { where += ` AND b.check_in <= $${idx++}`; params.push(dt); }
    if (useSt) { where += ` AND b.booking_status = $${idx++}`; params.push(useSt); }

    const { rows } = await db.query(
      `SELECT b.id, g.full_name, g.phone, g.instagram,
              b.check_in, b.check_out, b.guests_count,
              b.price_total, b.prepayment, b.payment_status, b.booking_status, b.source, b.notes
       FROM bookings b LEFT JOIN guests g ON g.id=b.guest_id
       WHERE ${where} ORDER BY b.check_in DESC`,
      params
    );
    console.error("Export query result:", rows?.length);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Relax Borovoe CRM";
    const ws = wb.addWorksheet("Брони");

    ws.columns = [
      { width: 8 },
      { width: 25 },
      { width: 16 },
      { width: 18 },
      { width: 12 },
      { width: 12 },
      { width: 10 },
      { width: 14 },
      { width: 16 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 30 },
    ];

    ws.mergeCells("A1:N1");
    const titleRow = ws.getRow(1);
    titleRow.values = ["Экспорт броней — Relax Borovoe CRM"];
    titleRow.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    titleRow.alignment = { horizontal: "left" };
    titleRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E7C66" } };

    ws.getRow(2).values = [`Выгружено: ${new Date().toLocaleString("ru-RU")}`];
    ws.getRow(2).font = { italic: true, size: 10 };

    if (df || dt) {
      ws.getRow(3).values = [`Период: ${df || "..."} — ${dt || "..."}`];
      ws.getRow(3).font = { italic: true, size: 10 };
    }

    ws.getRow(5).values = [
      "ID", "Гость", "Телефон", "Instagram",
      "Заезд", "Выезд", "Гостей", "Сумма (₸)", "Предоплата (₸)",
      "Остаток (₸)", "Оплата", "Статус", "Источник", "Заметки"
    ];
    ws.getRow(5).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E7C66" } };

    const payL = { UNPAID: "Не оплачено", PARTIAL: "Предоплата", PAID: "Оплачено" };
    const stL = { REQUEST: "Запрос", CONFIRMED: "Подтверждено", COMPLETED: "Завершено", CANCELLED: "Отменено" };

    let totalSum = 0, totalPre = 0, totalDue = 0;
    let activeCount = 0;
    let dataRowCount = 0;

    for (const r of rows) {
      const total = Number(r.price_total || 0);
      const prepay = Number(r.prepayment || 0);
      const remaining = total - prepay;

      totalSum += total;
      totalPre += prepay;
      totalDue += remaining;

      if (r.booking_status !== "CANCELLED") activeCount++;

      const dataRow = ws.addRow([
        r.id ?? "",
        r.full_name ?? "",
        r.phone ?? "",
        r.instagram ?? "",
        r.check_in ?? "",
        r.check_out ?? "",
        Number(r.guests_count || 1),
        total,
        prepay,
        remaining,
        payL[r.payment_status] || r.payment_status || "",
        stL[r.booking_status] || r.booking_status || "",
        r.source ?? "",
        r.notes ?? ""
      ]);

      dataRowCount++;

      if (r.booking_status === "CANCELLED") {
        dataRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFCFCF" } };
      }

      dataRow.getCell(8).numFmt = '#,##0';
      dataRow.getCell(9).numFmt = '#,##0';
      dataRow.getCell(10).numFmt = '#,##0';
    }

    if (rows.length > 0) {
      ws.addRow([]);
      const summaryRow = ws.addRow([
        "", "", "", "",
        "ИТОГО:", `(${activeCount} броней)`, "",
        totalSum, totalPre, totalDue,
        "", "", "", ""
      ]);
      summaryRow.font = { bold: true, size: 11 };
      summaryRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7F6F2" } };
      summaryRow.getCell(8).numFmt = '#,##0';
      summaryRow.getCell(9).numFmt = '#,##0';
      summaryRow.getCell(10).numFmt = '#,##0';

      // Fix: assign autoFilter as a string — ws.autoFilter is null by default in ExcelJS 4.x
      ws.autoFilter = `A5:N${5 + dataRowCount}`;
    }

    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 5 }];

    // Use buffer approach to avoid stream-end conflicts with Express 5
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="bookings_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("ALL BOOKINGS EXPORT ERROR:", err);
    if (!res.headersSent) {
      res.status(500).send("Export error");
    }
  }
});

// ========================
// Excel Export: Guests
app.get("/api/export/guests.xlsx", async (req, res) => {
  try {
    console.error("GUESTS EXPORT STARTED");
    const ExcelJS = require("exceljs");
    const { rows } = await db.query(`SELECT * FROM guests ORDER BY full_name ASC`);
    console.error("Guests export rows:", rows?.length);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Relax Borovoe CRM";
    const ws = wb.addWorksheet("Гости");

    ws.columns = [
      { width: 8 },
      { width: 30 },
      { width: 20 },
      { width: 22 },
      { width: 40 },
    ];

    ws.mergeCells("A1:E1");
    const titleRow = ws.getRow(1);
    titleRow.values = ["Экспорт гостей — Relax Borovoe CRM"];
    titleRow.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    titleRow.alignment = { horizontal: "left" };
    titleRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E7C66" } };

    ws.getRow(2).values = [`Выгружено: ${new Date().toLocaleString("ru-RU")} • Всего гостей: ${rows.length}`];
    ws.getRow(2).font = { italic: true, size: 10 };

    ws.getRow(4).values = ["ID", "ФИО", "Телефон", "Instagram", "Заметки"];
    ws.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E7C66" } };

    for (const r of rows) {
      ws.addRow([r.id ?? "", r.full_name ?? "", r.phone ?? "", r.instagram ?? "", r.note ?? ""]);
    }

    if (rows.length > 0) {
      ws.autoFilter = `A4:E${4 + rows.length}`;
    }
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="guests_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("GUESTS EXPORT ERROR:", err);
    if (!res.headersSent) res.status(500).send("Export error");
  }
});

// ========================
// Excel Export: Expenses
// ========================
app.get("/api/export/expenses.xlsx", async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const dfRaw = String(req.query.date_from || "").trim();
    const dtRaw = String(req.query.date_to || "").trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const df = dateRe.test(dfRaw) ? dfRaw : null;
    const dt = dateRe.test(dtRaw) ? dtRaw : null;

    const params = [];
    let where = "1=1";
    let idx = 1;
    if (df) { where += ` AND exp_date >= $${idx++}`; params.push(df); }
    if (dt) { where += ` AND exp_date <= $${idx++}`; params.push(dt); }

    const { rows } = await db.query(
      `SELECT * FROM expenses WHERE ${where} ORDER BY exp_date DESC, id DESC`, params
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "Relax Borovoe CRM";
    const ws = wb.addWorksheet("Расходы");

    // Set column widths FIRST
    ws.columns = [
      { width: 8 },   // ID
      { width: 14 },  // Дата
      { width: 25 },  // Категория
      { width: 16 },  // Сумма
      { width: 35 },  // Комментарий
    ];

    // Add title and export info
    ws.mergeCells("A1:E1");
    const titleRow = ws.getRow(1);
    titleRow.values = ["Экспорт расходов — Relax Borovoe CRM"];
    titleRow.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    titleRow.alignment = { horizontal: "left" };
    titleRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDC6803" } };

    ws.getRow(2).values = [`Выгружено: ${new Date().toLocaleString("ru-RU")}`];
    ws.getRow(2).font = { italic: true, size: 10 };

    if(df || dt) {
      const periodStr = `Период: ${df || "..."} — ${dt || "..."}`;
      ws.getRow(3).values = [periodStr];
      ws.getRow(3).font = { italic: true, size: 10 };
    }

    ws.getRow(5).values = ["ID", "Дата", "Категория", "Сумма (₸)", "Комментарий"];
    ws.getRow(5).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDC6803" } };

    let totalAmount = 0;
    let dataRowCount = 0;

    for (const r of rows) {
      const amount = Number(r.amount || 0);
      totalAmount += amount;

      const dataRow = ws.addRow([
        r.id,
        r.exp_date || "",
        r.category || "",
        amount,
        r.note || ""
      ]);

      dataRowCount++;

      // Format currency column (column 4)
      dataRow.getCell(4).numFmt = '#,##0';
    }

    // Add summary row
    if(rows.length > 0) {
      ws.addRow([]); // Empty row
      const summaryRow = ws.addRow([
        "", "", "ИТОГО:", totalAmount, ""
      ]);
      summaryRow.font = { bold: true, size: 11 };
      summaryRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF9C3" } };
      summaryRow.getCell(4).numFmt = '#,##0';
    }

    // Freeze top rows (rows 1-5)
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 5 }];

    if (rows.length > 0) {
      ws.autoFilter = `A5:E${5 + dataRowCount}`;
    }

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="expenses_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("EXPENSES EXPORT ERROR:", err);
    if (!res.headersSent) res.status(500).send("Export error");
  }
});

// ========================
// Excel Export: Analytics Report
// ========================
app.get("/api/export/analytics.xlsx", async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const dfRaw = String(req.query.date_from || "").trim();
    const dtRaw = String(req.query.date_to || "").trim();
    const yearRaw = parseInt(req.query.year || new Date().getFullYear(), 10);
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const df = dateRe.test(dfRaw) ? dfRaw : null;
    const dt = dateRe.test(dtRaw) ? dtRaw : null;

    const today = new Date().toISOString().slice(0, 10);
    const chartFrom = df || (today.slice(0, 7) + "-01");
    const chartTo = dt || today;
    const year = yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : new Date().getFullYear();

    const [dRevRows, dExpRows, mRows] = await Promise.all([
      db.query(
        `SELECT check_in AS date, SUM(price_total) AS revenue
         FROM bookings WHERE booking_status IN ('CONFIRMED','COMPLETED','REQUEST') AND check_in >= $1 AND check_in <= $2
         GROUP BY check_in ORDER BY check_in`,
        [chartFrom, chartTo]
      ),
      db.query(
        `SELECT exp_date AS date, SUM(amount) AS expenses FROM expenses WHERE exp_date >= $1 AND exp_date <= $2
         GROUP BY exp_date ORDER BY exp_date`,
        [chartFrom, chartTo]
      ),
      db.query(
        `WITH rev AS (
          SELECT to_char(check_in::date, 'MM') AS m, SUM(price_total) AS revenue
          FROM bookings WHERE booking_status IN ('CONFIRMED','COMPLETED','REQUEST') AND to_char(check_in::date, 'YYYY')=$1 GROUP BY m
        ), exp AS (
          SELECT to_char(exp_date::date, 'MM') AS m, SUM(amount) AS expenses
          FROM expenses WHERE to_char(exp_date::date, 'YYYY')=$1 GROUP BY m
        )
        SELECT to_char(gs.n,'FM00') AS month,
               COALESCE(rev.revenue,0) AS revenue, COALESCE(exp.expenses,0) AS expenses,
               (COALESCE(rev.revenue,0)-COALESCE(exp.expenses,0)) AS net
        FROM generate_series(1,12) AS gs(n)
        LEFT JOIN rev ON rev.m=to_char(gs.n,'FM00')
        LEFT JOIN exp ON exp.m=to_char(gs.n,'FM00')
        ORDER BY gs.n`,
        [String(year)]
      ),
    ]);

    const revByDay = {};
    for (const r of dRevRows.rows) revByDay[String(r.date).slice(0, 10)] = Number(r.revenue || 0);
    const expByDay = {};
    for (const r of dExpRows.rows) expByDay[String(r.date).slice(0, 10)] = Number(r.expenses || 0);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Relax Borovoe CRM";

    // Sheet 1: Monthly
    const wsM = wb.addWorksheet(`По месяцам ${year}`);
    wsM.columns = [
      { header: "Месяц", key: "month", width: 10 },
      { header: "Выручка (₸)", key: "revenue", width: 18 },
      { header: "Расходы (₸)", key: "expenses", width: 18 },
      { header: "Чистая прибыль (₸)", key: "net", width: 22 },
    ];
    wsM.getRow(1).font = { bold: true };
    wsM.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7F6F2" } };
    const monthNames = ["", "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
    for (const r of mRows.rows) {
      wsM.addRow({ month: monthNames[Number(r.month)] || r.month, revenue: Number(r.revenue || 0), expenses: Number(r.expenses || 0), net: Number(r.net || 0) });
    }

    // Sheet 2: Daily
    const wsD = wb.addWorksheet(`По дням ${chartFrom} — ${chartTo}`);
    wsD.columns = [
      { header: "Дата", key: "date", width: 14 },
      { header: "Выручка (₸)", key: "revenue", width: 18 },
      { header: "Расходы (₸)", key: "expenses", width: 18 },
      { header: "Чистая прибыль (₸)", key: "net", width: 22 },
    ];
    wsD.getRow(1).font = { bold: true };
    wsD.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7F6F2" } };
    const startD = new Date(chartFrom + "T00:00:00");
    const endD = new Date(chartTo + "T00:00:00");
    let dayCnt = 0;
    for (let d = new Date(startD); d <= endD && dayCnt < 180; d.setDate(d.getDate() + 1), dayCnt++) {
      const ds = d.toISOString().slice(0, 10);
      const rev = revByDay[ds] || 0;
      const exp = expByDay[ds] || 0;
      wsD.addRow({ date: ds, revenue: rev, expenses: exp, net: rev - exp });
    }

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="analytics_${year}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("ANALYTICS EXPORT ERROR:", err);
    if (!res.headersSent) res.status(500).send("Export error");
  }
});

// ====================================================
// ANALYTICS EXTENDED — /api/analytics/extended
// Returns occupancy, payment breakdown, returning guests, prepayment
// ====================================================
app.get("/api/analytics/extended", async (req, res) => {
  try {
    const dfRaw = String(req.query.date_from || "").trim();
    const dtRaw = String(req.query.date_to || "").trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const df = dateRe.test(dfRaw) ? dfRaw : null;
    const dt = dateRe.test(dtRaw) ? dtRaw : null;

    // Date range for queries
    const today = new Date().toISOString().slice(0, 10);
    const periodFrom = df || "2020-01-01";
    const periodTo   = dt || today;

    // Active statuses (non-cancelled) for revenue
    const activeStatuses = ["CONFIRMED", "COMPLETED"];

    // 1. Revenue / prepayment / remaining / booking counts for period
    const { rows: kpiRows } = await db.query(
      `SELECT
        COALESCE(SUM(CASE WHEN booking_status IN ('CONFIRMED','COMPLETED') THEN price_total ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN booking_status IN ('CONFIRMED','COMPLETED') THEN prepayment ELSE 0 END), 0) AS prepayment,
        COALESCE(SUM(CASE WHEN booking_status IN ('CONFIRMED','COMPLETED') THEN price_total - prepayment ELSE 0 END), 0) AS remaining,
        COUNT(*) FILTER (WHERE booking_status = 'CONFIRMED') AS confirmed_count,
        COUNT(*) FILTER (WHERE booking_status = 'COMPLETED') AS completed_count,
        COUNT(*) FILTER (WHERE booking_status = 'REQUEST')   AS request_count,
        COUNT(*) FILTER (WHERE booking_status = 'CANCELLED') AS cancelled_count,
        COUNT(*) FILTER (WHERE booking_status IN ('CONFIRMED','COMPLETED')) AS active_count,
        COALESCE(AVG(CASE WHEN booking_status IN ('CONFIRMED','COMPLETED') THEN
          (check_out::date - check_in::date) END), 0) AS avg_nights,
        COUNT(DISTINCT guest_id) FILTER (WHERE booking_status IN ('CONFIRMED','COMPLETED','REQUEST')) AS unique_guests,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN 1 ELSE 0 END), 0) AS fully_paid,
        COALESCE(SUM(CASE WHEN payment_status = 'PARTIAL' THEN 1 ELSE 0 END), 0) AS partial_paid,
        COALESCE(SUM(CASE WHEN payment_status = 'UNPAID' THEN 1 ELSE 0 END), 0) AS unpaid
       FROM bookings
       WHERE check_in >= $1 AND check_in <= $2`,
      [periodFrom, periodTo]
    );
    const kpi = kpiRows[0] || {};

    // 2. Returning guests (>1 active booking all-time, visible in period)
    const { rows: retRows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM (
        SELECT guest_id FROM bookings
        WHERE booking_status IN ('CONFIRMED','COMPLETED')
          AND check_in >= $1 AND check_in <= $2
          AND guest_id IN (
            SELECT guest_id FROM bookings
            WHERE booking_status IN ('CONFIRMED','COMPLETED')
            GROUP BY guest_id HAVING COUNT(*) > 1
          )
        GROUP BY guest_id
       ) sub`,
      [periodFrom, periodTo]
    );
    const returningGuests = Number(retRows[0]?.cnt || 0);

    // 3. Occupancy: sum of booked nights within period / total days in period
    const { rows: occRows } = await db.query(
      `SELECT COALESCE(SUM(
          LEAST(check_out::date, $2::date + 1) - GREATEST(check_in::date, $1::date)
        ), 0) AS occupied_nights
       FROM bookings
       WHERE booking_status IN ('CONFIRMED','COMPLETED')
         AND check_out > $1 AND check_in < $2::date + 1`,
      [periodFrom, periodTo]
    );
    const occupiedNights = Math.max(0, Number(occRows[0]?.occupied_nights || 0));
    const periodDays = Math.max(1,
      Math.round((new Date(periodTo) - new Date(periodFrom)) / 86400000) + 1
    );
    const occupancyRate = Math.min(100, Math.round((occupiedNights / periodDays) * 100));

    // 4. Best and worst months (by revenue, for selected year or all time)
    const yearRaw = parseInt(req.query.year || new Date().getFullYear(), 10);
    const year = yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : new Date().getFullYear();
    const { rows: monthlyRows } = await db.query(
      `WITH rev AS (
        SELECT to_char(check_in::date,'MM') AS m, SUM(price_total) AS revenue, COUNT(*) AS cnt
        FROM bookings WHERE booking_status IN ('CONFIRMED','COMPLETED')
          AND to_char(check_in::date,'YYYY') = $1 GROUP BY m
      ), exp AS (
        SELECT to_char(exp_date::date,'MM') AS m, SUM(amount) AS expenses
        FROM expenses WHERE to_char(exp_date::date,'YYYY') = $1 GROUP BY m
      )
      SELECT to_char(gs.n,'FM00') AS month,
             COALESCE(rev.revenue,0) AS revenue, COALESCE(exp.expenses,0) AS expenses,
             COALESCE(rev.cnt,0) AS bookings_count,
             (COALESCE(rev.revenue,0)-COALESCE(exp.expenses,0)) AS net
      FROM generate_series(1,12) AS gs(n)
      LEFT JOIN rev ON rev.m=to_char(gs.n,'FM00')
      LEFT JOIN exp ON exp.m=to_char(gs.n,'FM00')
      ORDER BY gs.n`,
      [String(year)]
    );

    res.json({
      revenue: Number(kpi.revenue || 0),
      prepayment: Number(kpi.prepayment || 0),
      remaining: Number(kpi.remaining || 0),
      confirmed_count: Number(kpi.confirmed_count || 0),
      completed_count: Number(kpi.completed_count || 0),
      request_count: Number(kpi.request_count || 0),
      cancelled_count: Number(kpi.cancelled_count || 0),
      active_count: Number(kpi.active_count || 0),
      avg_nights: Math.round(Number(kpi.avg_nights || 0) * 10) / 10,
      unique_guests: Number(kpi.unique_guests || 0),
      returning_guests: returningGuests,
      fully_paid: Number(kpi.fully_paid || 0),
      partial_paid: Number(kpi.partial_paid || 0),
      unpaid: Number(kpi.unpaid || 0),
      occupied_nights: occupiedNights,
      period_days: periodDays,
      occupancy_rate: occupancyRate,
      monthly: monthlyRows.map(r => ({
        month: r.month,
        revenue: Number(r.revenue || 0),
        expenses: Number(r.expenses || 0),
        net: Number(r.net || 0),
        bookings_count: Number(r.bookings_count || 0),
      })),
    });
  } catch (err) {
    console.error("❌ /api/analytics/extended error:", err);
    res.status(500).json({ error: "db error" });
  }
});

// ====================================================
// ANALYTICS GUESTS — /api/analytics/guests
// Top guests by spend and bookings
// ====================================================
app.get("/api/analytics/guests", async (req, res) => {
  try {
    const dfRaw = String(req.query.date_from || "").trim();
    const dtRaw = String(req.query.date_to || "").trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const df = dateRe.test(dfRaw) ? dfRaw : null;
    const dt = dateRe.test(dtRaw) ? dtRaw : null;
    const today = new Date().toISOString().slice(0, 10);
    const pFrom = df || "2020-01-01";
    const pTo   = dt || today;

    // Top guests: all bookings in period, aggregate by guest
    const { rows } = await db.query(
      `SELECT
        g.id,
        g.full_name,
        g.phone,
        COUNT(b.id) AS bookings_count,
        COALESCE(SUM(CASE WHEN b.booking_status IN ('CONFIRMED','COMPLETED') THEN b.price_total ELSE 0 END), 0) AS total_spent,
        MAX(b.check_in) AS last_visit,
        COUNT(b.id) FILTER (WHERE b.booking_status = 'CANCELLED') AS cancelled_count,
        COUNT(b.id) FILTER (WHERE b.booking_status IN ('CONFIRMED','COMPLETED')) AS active_bookings
       FROM guests g
       LEFT JOIN bookings b ON b.guest_id = g.id AND b.check_in >= $1 AND b.check_in <= $2
       GROUP BY g.id, g.full_name, g.phone
       HAVING COUNT(b.id) > 0
       ORDER BY total_spent DESC, bookings_count DESC
       LIMIT 50`,
      [pFrom, pTo]
    );

    // All-time booking counts (to detect returning guests)
    const { rows: allTimeRows } = await db.query(
      `SELECT guest_id, COUNT(*) AS total_all_time
       FROM bookings WHERE booking_status IN ('CONFIRMED','COMPLETED')
       GROUP BY guest_id`
    );
    const allTimeMap = {};
    for (const r of allTimeRows) allTimeMap[r.guest_id] = Number(r.total_all_time);

    const guests = rows.map(r => ({
      id: r.id,
      full_name: r.full_name,
      phone: r.phone || "",
      bookings_count: Number(r.bookings_count || 0),
      total_spent: Number(r.total_spent || 0),
      last_visit: r.last_visit ? String(r.last_visit).slice(0, 10) : null,
      cancelled_count: Number(r.cancelled_count || 0),
      active_bookings: Number(r.active_bookings || 0),
      is_returning: (allTimeMap[r.id] || 0) > 1,
    }));

    res.json({ guests });
  } catch (err) {
    console.error("❌ /api/analytics/guests error:", err);
    res.status(500).json({ error: "db error" });
  }
});

// ====================================================
// ANALYTICS OCCUPANCY — /api/analytics/occupancy
// Monthly occupancy for selected year
// ====================================================
app.get("/api/analytics/occupancy", async (req, res) => {
  try {
    const yearRaw = parseInt(req.query.year || new Date().getFullYear(), 10);
    const year = yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : new Date().getFullYear();
    const y = String(year);

    const { rows } = await db.query(
      `SELECT
        m,
        days_in_month,
        COALESCE(occ, 0) AS occupied_nights
       FROM (
         SELECT gs.n AS m,
                EXTRACT(DAY FROM (date_trunc('month', make_date($1::int, gs.n::int, 1)) + INTERVAL '1 month - 1 day'))::int AS days_in_month
         FROM generate_series(1, 12) AS gs(n)
       ) months
       LEFT JOIN (
         SELECT
           EXTRACT(MONTH FROM gs.d)::int AS m,
           COUNT(*) AS occ
         FROM generate_series(
           make_date($1::int, 1, 1),
           make_date($1::int, 12, 31),
           '1 day'::interval
         ) AS gs(d)
         JOIN bookings b
           ON b.booking_status IN ('CONFIRMED','COMPLETED')
           AND b.check_in::date <= gs.d
           AND b.check_out::date > gs.d
           AND EXTRACT(YEAR FROM gs.d) = $1::int
         GROUP BY EXTRACT(MONTH FROM gs.d)::int
       ) occ_data USING (m)
       ORDER BY m`,
      [year]
    );

    const monthly = rows.map(r => ({
      month: String(r.m).padStart(2, "0"),
      days_in_month: Number(r.days_in_month),
      occupied_nights: Number(r.occupied_nights || 0),
      occupancy_pct: Math.min(100, Math.round((Number(r.occupied_nights || 0) / Number(r.days_in_month)) * 100)),
    }));

    res.json({ year, monthly });
  } catch (err) {
    console.error("❌ /api/analytics/occupancy error:", err);
    res.status(500).json({ error: "db error" });
  }
});

// ====================================================
// ANALYTICS EXPENSES BREAKDOWN — /api/analytics/expenses-breakdown
// Expenses by category and by month
// ====================================================
app.get("/api/analytics/expenses-breakdown", async (req, res) => {
  try {
    const dfRaw = String(req.query.date_from || "").trim();
    const dtRaw = String(req.query.date_to || "").trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const df = dateRe.test(dfRaw) ? dfRaw : null;
    const dt = dateRe.test(dtRaw) ? dtRaw : null;
    const today = new Date().toISOString().slice(0, 10);
    const pFrom = df || "2020-01-01";
    const pTo   = dt || today;

    const [catRows, monthRows, biggestRow] = await Promise.all([
      db.query(
        `SELECT category, SUM(amount) AS total, COUNT(*) AS cnt
         FROM expenses WHERE exp_date >= $1 AND exp_date <= $2
         GROUP BY category ORDER BY total DESC LIMIT 20`,
        [pFrom, pTo]
      ),
      db.query(
        `SELECT to_char(exp_date::date,'YYYY-MM') AS ym, SUM(amount) AS total, COUNT(*) AS cnt
         FROM expenses WHERE exp_date >= $1 AND exp_date <= $2
         GROUP BY ym ORDER BY ym`,
        [pFrom, pTo]
      ),
      db.query(
        `SELECT exp_date, category, amount, note
         FROM expenses WHERE exp_date >= $1 AND exp_date <= $2
         ORDER BY amount DESC LIMIT 1`,
        [pFrom, pTo]
      ),
    ]);

    res.json({
      by_category: catRows.rows.map(r => ({
        category: r.category || "Прочее",
        total: Number(r.total || 0),
        count: Number(r.cnt || 0),
      })),
      by_month: monthRows.rows.map(r => ({
        ym: r.ym,
        total: Number(r.total || 0),
        count: Number(r.cnt || 0),
      })),
      biggest: biggestRow.rows[0] ? {
        date: String(biggestRow.rows[0].exp_date).slice(0, 10),
        category: biggestRow.rows[0].category,
        amount: Number(biggestRow.rows[0].amount),
        note: biggestRow.rows[0].note || "",
      } : null,
    });
  } catch (err) {
    console.error("❌ /api/analytics/expenses-breakdown error:", err);
    res.status(500).json({ error: "db error" });
  }
});

// ====================================================
// ANALYTICS FULL EXCEL EXPORT — /api/export/analytics-full.xlsx
// ====================================================
app.get("/api/export/analytics-full.xlsx", async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const dfRaw = String(req.query.date_from || "").trim();
    const dtRaw = String(req.query.date_to || "").trim();
    const yearRaw = parseInt(req.query.year || new Date().getFullYear(), 10);
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const df = dateRe.test(dfRaw) ? dfRaw : null;
    const dt = dateRe.test(dtRaw) ? dtRaw : null;
    const today = new Date().toISOString().slice(0, 10);
    const pFrom = df || (today.slice(0, 4) + "-01-01");
    const pTo   = dt || today;
    const year = yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : new Date().getFullYear();
    const fmt  = v => Number(v || 0).toLocaleString("ru-RU");
    const monthNames = ["","Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

    const [mRows, bRows, gRows, eRows] = await Promise.all([
      db.query(
        `WITH rev AS (
          SELECT to_char(check_in::date,'MM') AS m,
                 SUM(price_total) AS revenue, COUNT(*) AS cnt,
                 SUM(check_out::date - check_in::date) AS nights
          FROM bookings WHERE booking_status IN ('CONFIRMED','COMPLETED')
            AND to_char(check_in::date,'YYYY')=$1 GROUP BY m
        ), exp AS (
          SELECT to_char(exp_date::date,'MM') AS m, SUM(amount) AS expenses
          FROM expenses WHERE to_char(exp_date::date,'YYYY')=$1 GROUP BY m
        )
        SELECT to_char(gs.n,'FM00') AS month,
               COALESCE(rev.revenue,0) AS revenue, COALESCE(exp.expenses,0) AS expenses,
               COALESCE(rev.cnt,0) AS bookings_count, COALESCE(rev.nights,0) AS nights,
               (COALESCE(rev.revenue,0)-COALESCE(exp.expenses,0)) AS net,
               CASE WHEN COALESCE(rev.cnt,0)>0 THEN COALESCE(rev.revenue,0)/rev.cnt ELSE 0 END AS avg_check
        FROM generate_series(1,12) AS gs(n)
        LEFT JOIN rev ON rev.m=to_char(gs.n,'FM00')
        LEFT JOIN exp ON exp.m=to_char(gs.n,'FM00')
        ORDER BY gs.n`,
        [String(year)]
      ),
      db.query(
        `SELECT b.id, g.full_name, b.check_in, b.check_out,
                (b.check_out::date - b.check_in::date) AS nights,
                b.booking_status, b.price_total, b.prepayment,
                (b.price_total - b.prepayment) AS remaining, b.payment_status
         FROM bookings b JOIN guests g ON g.id = b.guest_id
         WHERE b.check_in >= $1 AND b.check_in <= $2
         ORDER BY b.check_in DESC LIMIT 500`,
        [pFrom, pTo]
      ),
      db.query(
        `SELECT g.full_name, g.phone,
                COUNT(b.id) AS bookings_count,
                COALESCE(SUM(CASE WHEN b.booking_status IN ('CONFIRMED','COMPLETED') THEN b.price_total ELSE 0 END),0) AS total_spent,
                MAX(b.check_in) AS last_visit
         FROM guests g
         LEFT JOIN bookings b ON b.guest_id = g.id AND b.check_in >= $1 AND b.check_in <= $2
         GROUP BY g.id, g.full_name, g.phone
         HAVING COUNT(b.id) > 0
         ORDER BY total_spent DESC LIMIT 100`,
        [pFrom, pTo]
      ),
      db.query(
        `SELECT exp_date, category, amount, note
         FROM expenses WHERE exp_date >= $1 AND exp_date <= $2
         ORDER BY exp_date DESC LIMIT 500`,
        [pFrom, pTo]
      ),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Relax Borovoe CRM";

    const brandFill = { type:"pattern", pattern:"solid", fgColor:{argb:"FF0E7C66"} };
    const hdrFont   = { bold:true, color:{argb:"FFFFFFFF"} };
    const altFill   = { type:"pattern", pattern:"solid", fgColor:{argb:"FFF0FDF4"} };

    function styleHeader(ws) {
      ws.getRow(1).eachCell(c => {
        c.fill = brandFill;
        c.font = hdrFont;
        c.alignment = { vertical:"middle", horizontal:"center" };
      });
      ws.getRow(1).height = 22;
    }

    // Sheet 1 — Monthly
    const wsM = wb.addWorksheet(`По месяцам ${year}`);
    wsM.columns = [
      {header:"Месяц",key:"month",width:14},
      {header:"Выручка (₸)",key:"revenue",width:18},
      {header:"Расходы (₸)",key:"expenses",width:18},
      {header:"Прибыль (₸)",key:"net",width:18},
      {header:"Броней",key:"cnt",width:10},
      {header:"Ночей",key:"nights",width:10},
      {header:"Средний чек (₸)",key:"avg",width:18},
    ];
    styleHeader(wsM);
    let totRev=0,totExp=0,totNet=0,totCnt=0,totNights=0;
    mRows.rows.forEach((r,i) => {
      const rev=Number(r.revenue||0), exp=Number(r.expenses||0), net=Number(r.net||0), cnt=Number(r.bookings_count||0), nights=Number(r.nights||0);
      totRev+=rev; totExp+=exp; totNet+=net; totCnt+=cnt; totNights+=nights;
      const row = wsM.addRow({month:monthNames[Number(r.month)]||r.month, revenue:rev, expenses:exp, net, cnt, nights, avg:Number(r.avg_check||0)});
      if(i%2===1) row.eachCell(c=>{ c.fill=altFill; });
    });
    const totRow = wsM.addRow({month:"ИТОГО",revenue:totRev,expenses:totExp,net:totNet,cnt:totCnt,nights:totNights,avg:totCnt>0?Math.round(totRev/totCnt):0});
    totRow.font={bold:true}; totRow.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFE7F6F2"}};

    // Sheet 2 — Bookings
    const wsB = wb.addWorksheet(`Брони ${pFrom}—${pTo}`);
    wsB.columns = [
      {header:"Гость",key:"guest",width:24},{header:"Заезд",key:"ci",width:12},{header:"Выезд",key:"co",width:12},
      {header:"Ночей",key:"nights",width:8},{header:"Статус",key:"status",width:14},
      {header:"Сумма (₸)",key:"total",width:16},{header:"Предоплата (₸)",key:"pre",width:16},
      {header:"Остаток (₸)",key:"rem",width:14},{header:"Оплата",key:"pay",width:14},
    ];
    styleHeader(wsB);
    const statusRu = {CONFIRMED:"Подтверждено",COMPLETED:"Завершено",REQUEST:"Запрос",CANCELLED:"Отменено"};
    const payRu    = {PAID:"Оплачено",PARTIAL:"Частично",UNPAID:"Не оплачено"};
    bRows.rows.forEach((r,i) => {
      const row = wsB.addRow({guest:r.full_name,ci:String(r.check_in).slice(0,10),co:String(r.check_out).slice(0,10),
        nights:Number(r.nights||0),status:statusRu[r.booking_status]||r.booking_status,
        total:Number(r.price_total||0),pre:Number(r.prepayment||0),rem:Number(r.remaining||0),
        pay:payRu[r.payment_status]||r.payment_status});
      if(i%2===1) row.eachCell(c=>{ c.fill=altFill; });
    });

    // Sheet 3 — Guests
    const wsG = wb.addWorksheet(`Гости ${pFrom}—${pTo}`);
    wsG.columns = [
      {header:"Гость",key:"name",width:24},{header:"Телефон",key:"phone",width:16},
      {header:"Броней",key:"cnt",width:10},{header:"Всего потрачено (₸)",key:"spent",width:22},
      {header:"Последний визит",key:"last",width:16},
    ];
    styleHeader(wsG);
    gRows.rows.forEach((r,i) => {
      const row = wsG.addRow({name:r.full_name,phone:r.phone||"",cnt:Number(r.bookings_count||0),
        spent:Number(r.total_spent||0),last:r.last_visit?String(r.last_visit).slice(0,10):"—"});
      if(i%2===1) row.eachCell(c=>{ c.fill=altFill; });
    });

    // Sheet 4 — Expenses
    const wsE = wb.addWorksheet(`Расходы ${pFrom}—${pTo}`);
    wsE.columns = [
      {header:"Дата",key:"date",width:12},{header:"Категория",key:"cat",width:22},
      {header:"Сумма (₸)",key:"amount",width:16},{header:"Комментарий",key:"note",width:30},
    ];
    styleHeader(wsE);
    eRows.rows.forEach((r,i) => {
      const row = wsE.addRow({date:String(r.exp_date).slice(0,10),cat:r.category||"",amount:Number(r.amount||0),note:r.note||""});
      if(i%2===1) row.eachCell(c=>{ c.fill=altFill; });
    });

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename="analytics_full_${year}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("ANALYTICS FULL EXPORT ERROR:", err);
    if (!res.headersSent) res.status(500).send("Export error");
  }
});

// ------------------------
// Health check (Railway uses this to verify the app is alive)
// ------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// ------------------------
// Start (важно: initDb ДО listen)
// ------------------------
const PORT = Number(process.env.PORT || 3000);

// Catch uncaught exceptions so Railway logs show the real error
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
  process.exit(1);
});

(async () => {
  try {
    await initDb();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Relax Borovoe CRM running on port ${PORT}`);
    }).on("error", (err) => {
      console.error("❌ Failed to bind port:", err);
      process.exit(1);
    });
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
})();