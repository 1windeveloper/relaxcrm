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
         WHERE booking_status <> 'CANCELLED' AND TO_CHAR(check_in, 'YYYY-MM') = $1`
      : `SELECT COALESCE(SUM(price_total),0) AS revenue
         FROM bookings
         WHERE booking_status <> 'CANCELLED'`;

    const eSql = month
      ? `SELECT COALESCE(SUM(amount),0) AS expenses
         FROM expenses
         WHERE TO_CHAR(exp_date, 'YYYY-MM') = $1`
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
      SELECT substring(check_in,6,2) AS m,
             SUM(price_total) AS revenue
      FROM bookings
      WHERE booking_status IN ('CONFIRMED','COMPLETED')
        AND substring(check_in,1,4) = $1
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
        SELECT substring(check_in,6,2) AS m,
               SUM(price_total) AS revenue
        FROM bookings
        WHERE booking_status IN ('CONFIRMED','COMPLETED')
          AND substring(check_in,1,4) = $1
        GROUP BY m
      ),
      exp AS (
        SELECT substring(exp_date,6,2) AS m,
               SUM(amount) AS expenses
        FROM expenses
        WHERE substring(exp_date,1,4) = $1
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
        AND substring(check_in,1,4) = $1
      `,
      [y]
    );

    const r2 = await db.query(
      `
      SELECT COALESCE(SUM(amount),0) AS expenses
      FROM expenses
      WHERE substring(exp_date,1,4) = $1
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
        SELECT substring(check_in,6,2) AS m,
               SUM(price_total) AS v
        FROM bookings
        WHERE booking_status IN ('CONFIRMED','COMPLETED')
          AND substring(check_in,1,4) = $1
        GROUP BY m
      ),
      exp AS (
        SELECT substring(exp_date,6,2) AS m,
               SUM(amount) AS v
        FROM expenses
        WHERE substring(exp_date,1,4) = $1
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
        SELECT substring(check_in,6,2) AS m, SUM(price_total) AS revenue
        FROM bookings WHERE booking_status IN ('CONFIRMED','COMPLETED','REQUEST') AND substring(check_in,1,4)=$1
        GROUP BY m
      ), exp AS (
        SELECT substring(exp_date,6,2) AS m, SUM(amount) AS expenses
        FROM expenses WHERE substring(exp_date,1,4)=$1 GROUP BY m
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
       FROM bookings b JOIN guests g ON g.id=b.guest_id
       WHERE ${where} ORDER BY b.check_in DESC`,
      params
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "Relax Borovoe CRM";
    const ws = wb.addWorksheet("Брони");
    ws.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "Гость", key: "full_name", width: 28 },
      { header: "Телефон", key: "phone", width: 18 },
      { header: "Instagram", key: "instagram", width: 18 },
      { header: "Заезд", key: "check_in", width: 14 },
      { header: "Выезд", key: "check_out", width: 14 },
      { header: "Гостей", key: "guests_count", width: 10 },
      { header: "Сумма (₸)", key: "price_total", width: 16 },
      { header: "Предоплата (₸)", key: "prepayment", width: 18 },
      { header: "Статус оплаты", key: "payment_status", width: 18 },
      { header: "Статус брони", key: "booking_status", width: 18 },
      { header: "Источник", key: "source", width: 18 },
      { header: "Заметки", key: "notes", width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7F6F2" } };

    const payL = { UNPAID: "Не оплачено", PARTIAL: "Предоплата", PAID: "Оплачено" };
    const stL = { REQUEST: "Запрос", CONFIRMED: "Подтверждено", COMPLETED: "Завершено", CANCELLED: "Отменено" };

    for (const r of rows) {
      ws.addRow({
        id: r.id, full_name: r.full_name || "", phone: r.phone || "",
        instagram: r.instagram || "", check_in: r.check_in || "", check_out: r.check_out || "",
        guests_count: Number(r.guests_count || 1), price_total: Number(r.price_total || 0),
        prepayment: Number(r.prepayment || 0),
        payment_status: payL[r.payment_status] || r.payment_status,
        booking_status: stL[r.booking_status] || r.booking_status,
        source: r.source || "", notes: r.notes || "",
      });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="bookings_${new Date().toISOString().slice(0,10)}.xlsx"`);
    await wb.xlsx.write(res);
  } catch (err) {
    console.error("❌ Excel bookings error:", err);
    res.status(500).send("Export error");
  }
});

// ========================
// Excel Export: Guests
// ========================
app.get("/api/export/guests.xlsx", async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const { rows } = await db.query(`SELECT * FROM guests ORDER BY id DESC`);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Relax Borovoe CRM";
    const ws = wb.addWorksheet("Гости");
    ws.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "ФИО", key: "full_name", width: 30 },
      { header: "Телефон", key: "phone", width: 20 },
      { header: "Instagram", key: "instagram", width: 22 },
      { header: "Заметки", key: "note", width: 40 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7F6F2" } };

    for (const r of rows) {
      ws.addRow({ id: r.id, full_name: r.full_name || "", phone: r.phone || "", instagram: r.instagram || "", note: r.note || "" });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="guests_${new Date().toISOString().slice(0,10)}.xlsx"`);
    await wb.xlsx.write(res);
  } catch (err) {
    console.error("❌ Excel guests error:", err);
    res.status(500).send("Export error");
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
    ws.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "Дата", key: "exp_date", width: 14 },
      { header: "Категория", key: "category", width: 28 },
      { header: "Сумма (₸)", key: "amount", width: 16 },
      { header: "Комментарий", key: "note", width: 40 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF9C3" } };

    for (const r of rows) {
      ws.addRow({ id: r.id, exp_date: r.exp_date || "", category: r.category || "", amount: Number(r.amount || 0), note: r.note || "" });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="expenses_${new Date().toISOString().slice(0,10)}.xlsx"`);
    await wb.xlsx.write(res);
  } catch (err) {
    console.error("❌ Excel expenses error:", err);
    res.status(500).send("Export error");
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
          SELECT substring(check_in,6,2) AS m, SUM(price_total) AS revenue
          FROM bookings WHERE booking_status IN ('CONFIRMED','COMPLETED','REQUEST') AND substring(check_in,1,4)=$1 GROUP BY m
        ), exp AS (
          SELECT substring(exp_date,6,2) AS m, SUM(amount) AS expenses
          FROM expenses WHERE substring(exp_date,1,4)=$1 GROUP BY m
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

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="analytics_${year}.xlsx"`);
    await wb.xlsx.write(res);
  } catch (err) {
    console.error("❌ Excel analytics error:", err);
    res.status(500).send("Export error");
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