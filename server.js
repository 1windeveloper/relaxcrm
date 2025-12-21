require("dotenv").config();
const express = require("express");
const path = require("path");

const { db, initDb, normPhone } = require("./db.js");

initDb();

const app = express();
app.use(express.json());
const session = require("express-session");
const bcrypt = require("bcryptjs");

// ===== AUTH CONFIG =====
// Один логин на всех родителей (пароль хранится ХЭШЕМ)
const ADMIN_USER = process.env.ADMIN_USER || "parents";

// Сгенерируй хэш один раз (ниже дам как) и вставь в .env
// пример: $2a$10$...
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || "";

// Секрет сессии обязательно в .env
const SESSION_SECRET = process.env.SESSION_SECRET || "change_me_please";

// cookies + session
app.set("trust proxy", 1); // важно на хостингах (Render/railway)
app.use(
  session({
    name: "rbcrm.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production", // https
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 дней
    },
  })
);

// helper
function isAuthed(req) {
  return req.session && req.session.user === "admin";
}

// middleware: закрываем всё, кроме login и статики
function requireAuth(req, res, next) {
  // разрешаем открыть страницу логина и отправить логин
  if (req.path === "/login.html") return next();
  if (req.path === "/api/auth/login") return next();

  // статика (css/js/images)
  if (req.path.startsWith("/assets") || req.path.startsWith("/css") || req.path.startsWith("/js")) return next();
  if (req.path.startsWith("/public")) return next();

  // разрешим файлы из public (style.css, app.js и т.д.)
  const isStaticFile =
    req.method === "GET" &&
    (req.path.endsWith(".css") ||
      req.path.endsWith(".js") ||
      req.path.endsWith(".png") ||
      req.path.endsWith(".jpg") ||
      req.path.endsWith(".svg") ||
      req.path.endsWith(".ico"));

  if (isStaticFile) return next();

  // если не авторизован — на /login.html
  if (!isAuthed(req)) {
    // для API возвращаем 401 JSON
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
    return res.redirect("/login.html");
  }

  next();
}

app.use(requireAuth);

// ===== AUTH ROUTES =====
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username = "", password = "" } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });

    if (!ADMIN_PASS_HASH) {
      return res.status(500).json({ error: "ADMIN_PASS_HASH is not configured" });
    }

    if (String(username) !== String(ADMIN_USER)) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const ok = await bcrypt.compare(String(password), String(ADMIN_PASS_HASH));
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    req.session.user = "admin";
    res.json({ ok: true });
  } catch (e) {
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
app.use(express.static(path.join(__dirname, "public")));

// ------------------------
// Helpers
// ------------------------

// пересечение есть, если (new_check_in < old_check_out) AND (new_check_out > old_check_in)
// excludeId — чтобы при редактировании не сравнивать с самой собой
function checkOverlap(check_in, check_out, excludeId = null) {
  return new Promise((resolve, reject) => {
    const params = [check_in, check_out];
    let extra = "";

    if (excludeId) {
      extra = "AND id <> ?";
      params.push(Number(excludeId));
    }

    db.all(
      `
      SELECT id, check_in, check_out
      FROM bookings
      WHERE booking_status IN ('REQUEST','CONFIRMED')
        AND (? < check_out)
        AND (? > check_in)
        ${extra}
      `,
      params,
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

function pickDefined(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) {
      out[k] = obj[k];
    }
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
  return normalizeText(q)
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
}

// ------------------------
// API: Guests (list + search)
// q: ищем по ФИО/IG/телефону (и phone_norm по цифрам)
// Улучшение: если ввели "иванов иван" — найдёт по словам
// ------------------------
app.get("/api/guests", (req, res) => {
  const qRaw = String(req.query.q || "").trim();

  if (!qRaw) {
    db.all(`SELECT * FROM guests ORDER BY id DESC`, (err, rows) => {
      if (err) return res.status(500).json({ error: "db error" });
      res.json(rows);
    });
    return;
  }

  const qText = normalizeText(qRaw);
  const tokens = splitTokens(qText);

  const qDigits = normPhone(qRaw);
  const likeDigits = `%${qDigits}%`;

  // full_name: AND по всем токенам
  const nameConds = tokens.length
    ? tokens.map(() => `lower(full_name) LIKE ?`).join(" AND ")
    : "1=1";
  const nameParams = tokens.map((t) => `%${t}%`);

  // общий LIKE для instagram/phone (текст)
  const likeText = `%${qText}%`;

  const sql = `
    SELECT *
    FROM guests
    WHERE
      (
        (${nameConds})
        OR lower(instagram) LIKE ?
        OR lower(phone) LIKE ?
      )
      OR (? != '' AND phone_norm LIKE ?)
    ORDER BY id DESC
  `;

  const params = [
    ...nameParams,
    likeText,
    likeText,
    qDigits,
    likeDigits
  ];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "db error" });
    res.json(rows);
  });
});

// ------------------------
// API: Guests create
// ✅ phone_norm UNIQUE => один номер = один аккаунт
// ------------------------
app.post("/api/guests", (req, res) => {
  const { full_name, phone = "", instagram = "", note = "" } = req.body || {};
  if (!full_name) return res.status(400).json({ error: "full_name is required" });

  const phoneRaw = String(phone || "").trim();
  const phoneNorm = normPhone(phoneRaw) || null;

  db.run(
    `INSERT INTO guests(full_name, phone, phone_norm, instagram, note) VALUES (?,?,?,?,?)`,
    [
      String(full_name).trim(),
      phoneRaw,
      phoneNorm,
      String(instagram || "").trim(),
      String(note || "").trim()
    ],
    function (err) {
      if (err) {
        const m = String(err.message || "").toLowerCase();
        if (m.includes("unique") || m.includes("constraint")) {
          if (phoneNorm) {
            db.get(
              `SELECT id, full_name, phone FROM guests WHERE phone_norm = ? LIMIT 1`,
              [phoneNorm],
              (e2, row) => {
                if (e2) return res.status(409).json({ error: "phone duplicate" });
                if (row) {
                  return res.status(409).json({
                    error: "phone duplicate",
                    existing: { id: row.id, full_name: row.full_name, phone: row.phone }
                  });
                }
                return res.status(409).json({ error: "phone duplicate" });
              }
            );
            return;
          }
          return res.status(409).json({ error: "phone duplicate" });
        }

        return res.status(500).json({ error: "db error" });
      }

      res.json({ ok: true, id: this.lastID });
    }
  );
});

// ------------------------
// API: Guest bookings (history + totals)
// Требование: CANCELLED показываем, но суммы по нему = 0 в итогах
// ------------------------
app.get("/api/guests/:id/bookings", (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id is required" });

  db.get(
    `SELECT id, full_name, phone, phone_norm, instagram, note FROM guests WHERE id = ?`,
    [id],
    (err1, guest) => {
      if (err1) return res.status(500).json({ error: "db error" });
      if (!guest) return res.status(404).json({ error: "guest not found" });

      db.all(
        `
        SELECT b.*, g.full_name, g.phone
        FROM bookings b
        JOIN guests g ON g.id = b.guest_id
        WHERE b.guest_id = ?
        ORDER BY b.check_in DESC
        `,
        [id],
        (err2, rows) => {
          if (err2) return res.status(500).json({ error: "db error" });

          // ✅ totals исключают CANCELLED
          const activeRows = rows.filter(r => String(r.booking_status) !== "CANCELLED");
          const total = activeRows.reduce((s, r) => s + Number(r.price_total || 0), 0);
          const prepay = activeRows.reduce((s, r) => s + Number(r.prepayment || 0), 0);

          res.json({
            guest,
            guest_id: id,
            count: rows.length, // показываем все (включая отмены)
            total,
            prepayment: prepay,
            bookings: rows
          });
        }
      );
    }
  );
});

// ------------------------
// API: Bookings list
// ------------------------
app.get("/api/bookings", (req, res) => {
  db.all(
    `
    SELECT b.*, g.full_name, g.phone
    FROM bookings b
    JOIN guests g ON g.id = b.guest_id
    ORDER BY b.check_in ASC
    `,
    (err, rows) => {
      if (err) return res.status(500).json({ error: "db error" });
      res.json(rows);
    }
  );
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
      notes = ""
    } = req.body || {};

    if (!guest_id) return res.status(400).json({ error: "guest_id is required" });
    if (!check_in || !check_out) return res.status(400).json({ error: "check_in and check_out are required" });
    if (check_in >= check_out) return res.status(400).json({ error: "check_in must be < check_out" });

    const overlaps = await checkOverlap(check_in, check_out);
    if (overlaps.length) return res.status(409).json({ error: "dates overlap", overlaps });

    db.run(
      `INSERT INTO bookings(
        guest_id, check_in, check_out, guests_count,
        price_total, prepayment, payment_status, booking_status, source, notes
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
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
        String(notes || "").trim()
      ],
      function (err) {
        if (err) return res.status(500).json({ error: "db error" });
        res.json({ ok: true, id: this.lastID });
      }
    );
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// ------------------------
// API: Booking status patch
// ------------------------
app.patch("/api/bookings/:id/status", (req, res) => {
  const id = Number(req.params.id);
  const { booking_status } = req.body || {};
  const allowed = ["REQUEST", "CONFIRMED", "CANCELLED", "COMPLETED"];
  if (!allowed.includes(booking_status)) return res.status(400).json({ error: "invalid booking_status" });

  db.run(`UPDATE bookings SET booking_status = ? WHERE id = ?`, [booking_status, id], (err) => {
    if (err) return res.status(500).json({ error: "db error" });
    res.json({ ok: true });
  });
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

    db.run(
      `
      UPDATE bookings SET
        guest_id = ?,
        check_in = ?,
        check_out = ?,
        guests_count = ?,
        price_total = ?,
        prepayment = ?,
        payment_status = ?,
        booking_status = ?,
        source = ?,
        notes = ?
      WHERE id = ?
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
        id
      ],
      function (err) {
        if (err) return res.status(500).json({ error: "db error" });
        res.json({ ok: true });
      }
    );
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// ------------------------
// API: Booking partial update
// ------------------------
app.patch("/api/bookings/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id is required" });

  const body = req.body || {};
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
    "notes"
  ];

  const patch = pickDefined(body, allowedFields);
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

  const needDatesCheck = patch.check_in !== undefined || patch.check_out !== undefined;

  function runUpdate(finalPatch) {
    const cols = Object.keys(finalPatch);
    const setSql = cols.map(c => `${c} = ?`).join(", ");
    const params = cols.map(c => finalPatch[c]).concat([id]);

    db.run(`UPDATE bookings SET ${setSql} WHERE id = ?`, params, (err) => {
      if (err) return res.status(500).json({ error: "db error" });
      res.json({ ok: true });
    });
  }

  if (!needDatesCheck) {
    return runUpdate(patch);
  }

  db.get(`SELECT check_in, check_out FROM bookings WHERE id = ?`, [id], async (err, row) => {
    if (err) return res.status(500).json({ error: "db error" });
    if (!row) return res.status(404).json({ error: "booking not found" });

    const nextCheckIn = patch.check_in !== undefined ? patch.check_in : row.check_in;
    const nextCheckOut = patch.check_out !== undefined ? patch.check_out : row.check_out;

    if (!nextCheckIn || !nextCheckOut) return res.status(400).json({ error: "check_in/check_out required" });
    if (nextCheckIn >= nextCheckOut) return res.status(400).json({ error: "check_out must be after check_in" });

    try {
      const overlaps = await checkOverlap(nextCheckIn, nextCheckOut, id);
      if (overlaps.length) return res.status(409).json({ error: "dates overlap", overlaps });

      runUpdate({ ...patch, check_in: nextCheckIn, check_out: nextCheckOut });
    } catch (e) {
      res.status(500).json({ error: "server error" });
    }
  });
});


// ------------------------
// API: Booking cancel
// ✅ запись остается, статус CANCELLED, но деньги обнуляем
// ------------------------
app.patch("/api/bookings/:id/cancel", (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id is required" });

  db.run(
    `UPDATE bookings
     SET booking_status='CANCELLED',
         price_total=0,
         prepayment=0,
         payment_status='UNPAID'
     WHERE id=?`,
    [id],
    (err) => {
      if (err) return res.status(500).json({ error: "db error" });
      res.json({ ok: true });
    }
  );
});

// ------------------------
// API: Expenses
// ------------------------
app.get("/api/expenses", (req, res) => {
  db.all(`SELECT * FROM expenses ORDER BY exp_date DESC, id DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: "db error" });
    res.json(rows);
  });
});

app.post("/api/expenses", (req, res) => {
  const { exp_date, category, amount = 0, note = "" } = req.body || {};
  if (!exp_date) return res.status(400).json({ error: "exp_date is required" });
  if (!category) return res.status(400).json({ error: "category is required" });

  db.run(
    `INSERT INTO expenses(exp_date, category, amount, note) VALUES (?,?,?,?)`,
    [exp_date, String(category).trim(), Number(amount || 0), String(note || "").trim()],
    function (err) {
      if (err) return res.status(500).json({ error: "db error" });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.delete("/api/expenses/:id", (req, res) => {
  const id = Number(req.params.id);
  db.run(`DELETE FROM expenses WHERE id = ?`, [id], (err) => {
    if (err) return res.status(500).json({ error: "db error" });
    res.json({ ok: true });
  });
});

// ------------------------
// API: Stats (revenue/expenses/net)
// month: YYYY-MM; если нет — всё время
// ------------------------
app.get("/api/stats", (req, res) => {
  const { month } = req.query;

  const monthFilterBookings = month ? `AND substr(check_in,1,7) = ?` : "";
  const monthFilterExpenses = month ? `AND substr(exp_date,1,7) = ?` : "";

  const paramsB = month ? [month] : [];
  const paramsE = month ? [month] : [];

  db.get(
    `SELECT COALESCE(SUM(price_total),0) AS revenue
     FROM bookings
     WHERE booking_status != 'CANCELLED'
     ${monthFilterBookings}`,
    paramsB,
    (err, b) => {
      if (err) return res.status(500).json({ error: "db error" });

      db.get(
        `SELECT COALESCE(SUM(amount),0) AS expenses
         FROM expenses
         WHERE 1=1
         ${monthFilterExpenses}`,
        paramsE,
        (err2, e) => {
          if (err2) return res.status(500).json({ error: "db error" });

          const revenue = Number(b?.revenue || 0);
          const expenses = Number(e?.expenses || 0);

          res.json({
            month: month || null,
            revenue,
            expenses,
            net: revenue - expenses
          });
        }
      );
    }
  );
});

// ------------------------
// Finance: revenue-by-month
// ------------------------
app.get("/api/revenue-by-month", (req, res) => {
  const year = Number(req.query.year);
  if (!year || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "year is required" });
  }

  db.all(
    `
    SELECT strftime('%m', check_in) AS m,
           SUM(price_total) AS revenue
    FROM bookings
    WHERE booking_status IN ('CONFIRMED','COMPLETED')
      AND strftime('%Y', check_in) = ?
    GROUP BY m
    ORDER BY m
    `,
    [String(year)],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "db error" });

      const out = Array.from({ length: 12 }, (_, i) => ({
        month: String(i + 1).padStart(2, "0"),
        revenue: 0
      }));

      for (const r of rows) {
        const idx = Number(r.m) - 1;
        if (idx >= 0 && idx < 12) out[idx].revenue = Number(r.revenue || 0);
      }

      res.json({ year, months: out });
    }
  );
});

// ------------------------
// Finance: profit-by-month (revenue/expenses/net)
// ------------------------
app.get("/api/profit-by-month", (req, res) => {
  const year = Number(req.query.year);
  if (!year || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "year is required" });
  }

  const y = String(year);

  db.all(
    `
    WITH rev AS (
      SELECT strftime('%m', check_in) AS m,
             SUM(price_total) AS revenue
      FROM bookings
      WHERE booking_status IN ('CONFIRMED','COMPLETED')
        AND strftime('%Y', check_in) = ?
      GROUP BY m
    ),
    exp AS (
      SELECT strftime('%m', exp_date) AS m,
             SUM(amount) AS expenses
      FROM expenses
      WHERE strftime('%Y', exp_date) = ?
      GROUP BY m
    )
    SELECT
      printf('%02d', n) AS month,
      COALESCE(rev.revenue, 0) AS revenue,
      COALESCE(exp.expenses, 0) AS expenses,
      (COALESCE(rev.revenue, 0) - COALESCE(exp.expenses, 0)) AS net
    FROM (
      SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
      UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8
      UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
    ) m
    LEFT JOIN rev ON rev.m = printf('%02d', m.n)
    LEFT JOIN exp ON exp.m = printf('%02d', m.n)
    ORDER BY m.n
    `,
    [y, y],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "db error" });

      res.json({
        year,
        months: rows.map(r => ({
          month: r.month,
          revenue: Number(r.revenue || 0),
          expenses: Number(r.expenses || 0),
          net: Number(r.net || 0)
        }))
      });
    }
  );
});

// ------------------------
// CSV export by year
// ------------------------
app.get("/api/export/year.csv", (req, res) => {
  const year = Number(req.query.year);
  if (!year || year < 2000 || year > 2100) {
    return res.status(400).send("year is required");
  }

  const y = String(year);

  db.get(
    `
    SELECT SUM(price_total) AS revenue
    FROM bookings
    WHERE booking_status IN ('CONFIRMED','COMPLETED')
      AND strftime('%Y', check_in) = ?
    `,
    [y],
    (err1, r1) => {
      if (err1) return res.status(500).send("db error");

      db.get(
        `
        SELECT SUM(amount) AS expenses
        FROM expenses
        WHERE strftime('%Y', exp_date) = ?
        `,
        [y],
        (err2, r2) => {
          if (err2) return res.status(500).send("db error");

          const revenue = Number(r1?.revenue || 0);
          const expenses = Number(r2?.expenses || 0);
          const net = revenue - expenses;

          db.all(
            `
            WITH rev AS (
              SELECT strftime('%m', check_in) AS m, SUM(price_total) AS v
              FROM bookings
              WHERE booking_status IN ('CONFIRMED','COMPLETED')
                AND strftime('%Y', check_in) = ?
              GROUP BY m
            ),
            exp AS (
              SELECT strftime('%m', exp_date) AS m, SUM(amount) AS v
              FROM expenses
              WHERE strftime('%Y', exp_date) = ?
              GROUP BY m
            )
            SELECT
              printf('%02d', n) AS month,
              COALESCE(rev.v, 0) AS revenue,
              COALESCE(exp.v, 0) AS expenses,
              (COALESCE(rev.v,0) - COALESCE(exp.v,0)) AS net
            FROM (
              SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
              UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8
              UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
            ) m
            LEFT JOIN rev ON rev.m = printf('%02d', m.n)
            LEFT JOIN exp ON exp.m = printf('%02d', m.n)
            ORDER BY m.n
            `,
            [y, y],
            (err3, rows) => {
              if (err3) return res.status(500).send("db error");

              const header = "year,month,revenue,expenses,net\n";
              const lines = rows.map(r =>
                `${year},${r.month},${Number(r.revenue)},${Number(r.expenses)},${Number(r.net)}`
              );
              lines.push(`${year},TOTAL,${revenue},${expenses},${net}`);

              res.setHeader("Content-Type", "text/csv; charset=utf-8");
              res.setHeader("Content-Disposition", `attachment; filename="relax_${year}.csv"`);
              res.send(header + lines.join("\n"));
            }
          );
        }
      );
    }
  );
});

// ------------------------
// Start
// ------------------------
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Relax Borovoe CRM running: http://localhost:${PORT}`);
});