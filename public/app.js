/* public/app.js */
/* Non-breaking: всё обёрнуто проверками, если страницы/элемента нет — просто пропускаем */

// =================== API WRAPPERS ===================
async function api(url, options = {}) {
  const r = await fetch(url, { credentials: "include", ...options });

  // если сессии нет/умерла — на логин
  if (r.status === 401) {
    location.replace("/login.html");
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }

  return r;
}

async function apiGet(url) {
  const r = await api(url, { method: "GET" });

  if (!r.ok) {
    throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
  }

  return r.json();
}

async function apiSend(url, method, body) {
  const r = await api(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw Object.assign(new Error(data?.error || ("HTTP " + r.status)), {
      data,
      status: r.status,
    });
  }

  return data;
}

// =================== HELPERS ===================
function $(id){ return document.getElementById(id); }

function digitsOnly(s){
  return String(s || "").replace(/\D+/g,"");
}

/* Маска телефона (KZ): +7 (777) 123-45-67  */
function formatKzPhone(raw){
  const d = digitsOnly(raw);
  if(!d) return "";
  let x = d;
  if(x[0] === "8") x = "7" + x.slice(1);
  if(x.length === 1) return "+" + x;

  const cc = x.slice(0,1);
  const a = x.slice(1,4);
  const b = x.slice(4,7);
  const c = x.slice(7,9);
  const e = x.slice(9,11);

  let out = "+" + cc;
  if(a) out += " (" + a;
  if(a.length === 3) out += ")";
  if(b) out += " " + b;
  if(c) out += "-" + c;
  if(e) out += "-" + e;
  return out;
}

function attachPhoneMask(input){
  if(!input) return;
  input.addEventListener("input", () => {
    input.value = formatKzPhone(input.value);
  });
}

/* безопасный HTML + highlight */
function escapeHtml(s){
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function highlight(text, q){
  const t = String(text || "");
  const query = String(q || "").trim();
  if(!query) return escapeHtml(t);

  const lowT = t.toLowerCase();
  const lowQ = query.toLowerCase();
  const idx = lowT.indexOf(lowQ);
  if(idx < 0) return escapeHtml(t);

  const a = escapeHtml(t.slice(0, idx));
  const b = escapeHtml(t.slice(idx, idx + query.length));
  const c = escapeHtml(t.slice(idx + query.length));
  return a + `<mark class="hl">${b}</mark>` + c;
}

/* Активная вкладка nav (ФИКС: работает и без data-nav) */
function setActiveNav(){
  const path = location.pathname;

  // 1) если есть data-nav — работаем по нему
  const navWithData = document.querySelectorAll(".navItem[data-nav]");
  if (navWithData.length) {
    let key = "";
    if(path.includes("bookings")) key = "bookings";
    else if(path.includes("calendar")) key = "calendar";
    else if(path.includes("finance")) key = "finance";
    else if(path.includes("expenses")) key = "expenses";
    else if(path.includes("guests")) key = "guests";

    navWithData.forEach(a=>{
      if(a.getAttribute("data-nav") === key) a.classList.add("active");
      else a.classList.remove("active");
    });
    return;
  }

  // 2) если data-nav нет — подсвечиваем по href
  document.querySelectorAll(".navItem").forEach(a=>{
    const href = a.getAttribute("href") || "";
    const isActive =
      (href === "/index.html" && (path === "/" || path.endsWith("/index.html"))) ||
      (href !== "/index.html" && href && path.endsWith(href));

    a.classList.toggle("active", !!isActive);
  });
}

/* ===== Русские подписи статусов (UI), значения в базе НЕ меняем ===== */
function uiBookingStatus(code){
  const c = String(code || "");
  if(c === "REQUEST") return "Запрос";
  if(c === "CONFIRMED") return "Подтверждено";
  if(c === "COMPLETED") return "Завершено";
  if(c === "CANCELLED") return "Отменено";
  return c;
}

function uiPaymentStatus(code){
  const c = String(code || "");
  if(c === "UNPAID") return "Не оплачено";
  if(c === "PARTIAL") return "Предоплата";
  if(c === "PAID") return "Оплачено";
  return c;
}

// =================== BOOKINGS PAGE ===================
async function initBookingsPage(){
  const listEl = $("bookingsList");
  if(!listEl) return;

  const filterEl = $("filter");
  const foundEl = $("bookingsFound");
  const hintEl = $("bookingsHint");
  const clearBtn = $("bookingsClear");

  attachPhoneMask($("g_phone"));

  let allBookings = [];
  let allGuests = [];

  async function loadGuestsToSelects(){
    try{
      allGuests = await apiGet("/api/guests");
      const sel = $("guestSelect");
      const selEdit = $("edit_guest");

      const options = `<option value="">— выбрать —</option>` + allGuests.map(g => (
        `<option value="${g.id}">${escapeHtml(g.full_name)}${g.phone ? " • " + escapeHtml(g.phone) : ""}</option>`
      )).join("");

      if(sel) sel.innerHTML = options;
      if(selEdit) selEdit.innerHTML = options;
    }catch(e){
      // ignore
    }
  }

  function badgeBooking(s){
    const code = String(s || "REQUEST");
    if(code === "CONFIRMED") return `<span class="badge ok">${escapeHtml(uiBookingStatus(code))}</span>`;
    if(code === "COMPLETED") return `<span class="badge ok">${escapeHtml(uiBookingStatus(code))}</span>`;
    if(code === "CANCELLED") return `<span class="badge no">${escapeHtml(uiBookingStatus(code))}</span>`;
    return `<span class="badge wait">${escapeHtml(uiBookingStatus("REQUEST"))}</span>`;
  }

  function badgePay(s){
    const code = String(s || "UNPAID");
    if(code === "PAID") return `<span class="badge ok">${escapeHtml(uiPaymentStatus(code))}</span>`;
    if(code === "PARTIAL") return `<span class="badge wait">${escapeHtml(uiPaymentStatus(code))}</span>`;
    return `<span class="badge">${escapeHtml(uiPaymentStatus("UNPAID"))}</span>`;
  }

  function renderBookings(){
    const q = String(filterEl?.value || "").trim();
    const qDigits = digitsOnly(q);

    let rows = allBookings.slice();

    if(q){
      rows = rows.filter(b=>{
        const name = String(b.full_name || "").toLowerCase();
        const phone = String(b.phone || "").toLowerCase();
        const raw = q.toLowerCase();
        if(name.includes(raw)) return true;
        if(phone.includes(raw)) return true;
        if(qDigits && digitsOnly(phone).includes(qDigits)) return true;
        return false;
      });
    }

    if(foundEl) foundEl.textContent = String(rows.length);
    if(hintEl){
      if(!q) hintEl.textContent = "Введите имя или телефон";
      else hintEl.textContent = rows.length ? "Есть совпадения" : "Ничего не найдено";
    }
    if(clearBtn){
      clearBtn.style.display = q ? "inline-flex" : "none";
    }

    listEl.innerHTML = rows.map(b=>{
      const isCancelled = b.booking_status === "CANCELLED";

      const left =
        `<div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <b>${highlight(b.full_name, q)}</b>
            ${badgeBooking(b.booking_status)}
            ${badgePay(b.payment_status)}
          </div>
          <div class="small">
            ${escapeHtml(b.check_in)} → ${escapeHtml(b.check_out)} • гостей: <b>${Number(b.guests_count||1)}</b>
          </div>
          <div class="small">
            Тел: ${highlight(b.phone || "—", q)}
          </div>
          <div style="height:6px"></div>
          <div class="small">
            Сумма: <b>${Number(b.price_total||0).toLocaleString("ru-RU")}</b> ₸ •
            Предоплата: <b>${Number(b.prepayment||0).toLocaleString("ru-RU")}</b> ₸
          </div>
          ${isCancelled ? `<div class="hint">Отменено — редактирование и оплата отключены</div>` : ``}
        </div>`;

      const right =
        `<div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
          <button class="secondary" data-edit="${b.id}" style="width:auto;" ${isCancelled ? "disabled" : ""}>✎ Редактировать</button>
        </div>`;

      return `<div class="card item ${isCancelled ? "isCancelled" : ""}">${left}${right}</div>`;
    }).join("");

    listEl.querySelectorAll("button[data-edit]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const id = Number(btn.getAttribute("data-edit"));
        openEditModal(id);
      });
    });
  }

  async function loadBookings(){
    allBookings = await apiGet("/api/bookings");
    renderBookings();
  }

  async function addGuest(){
    const full_name = $("g_name")?.value?.trim();
    const phone = $("g_phone")?.value || "";
    const instagram = $("g_ig")?.value || "";
    const msg = $("guestMsg");
    if(msg) msg.textContent = "";

    try{
      const r = await apiSend("/api/guests", "POST", { full_name, phone, instagram });
      if(msg) msg.textContent = "✅ Гость добавлен (id: " + r.id + ")";
      $("g_name").value = "";
      $("g_phone").value = "";
      $("g_ig").value = "";
      await loadGuestsToSelects();
    }catch(e){
      if(msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  async function addBooking(){
    const msg = $("bookingMsg");
    if(msg) msg.textContent = "";

    const guest_id = Number($("guestSelect")?.value || 0);
    const check_in = $("check_in")?.value;
    const check_out = $("check_out")?.value;
    const guests_count = Number($("guests_count")?.value || 1);
    const price_total = Number($("price_total")?.value || 0);
    const prepayment = Number($("prepayment")?.value || 0);
    const booking_status = $("booking_status")?.value || "REQUEST";
    const payment_status = $("payment_status")?.value || "UNPAID";
    const source = $("source")?.value || "";
    const notes = $("notes")?.value || "";

    try{
      await apiSend("/api/bookings", "POST", {
        guest_id, check_in, check_out,
        guests_count, price_total, prepayment,
        booking_status, payment_status, source, notes
      });
      if(msg) msg.textContent = "✅ Бронь сохранена";
      await loadBookings();
    }catch(e){
      if(msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  function getBookingById(id){
    return allBookings.find(x=>Number(x.id)===Number(id));
  }

  function showModal(show){
    const m = $("editModal");
    if(!m) return;
    m.classList.toggle("hidden", !show);
  }

  function fillEditForm(b){
    $("edit_id").value = b.id;
    $("edit_guest").value = String(b.guest_id);
    $("edit_in").value = b.check_in;
    $("edit_out").value = b.check_out;
    $("edit_guests").value = b.guests_count;
    $("edit_total").value = b.price_total;
    $("edit_prepay").value = b.prepayment;
    $("edit_pay").value = b.payment_status;
    $("edit_status").value = b.booking_status;
    $("edit_source").value = b.source || "";
    $("edit_notes").value = b.notes || "";
    const em = $("editMsg");
    if(em) em.textContent = "";
  }

  async function openEditModal(id){
    const b = getBookingById(id);
    if(!b) return;
    if(String(b.booking_status) === "CANCELLED") return; // UI защита
    await loadGuestsToSelects();
    fillEditForm(b);
    showModal(true);
  }

  async function saveEdit(){
    const id = Number($("edit_id")?.value || 0);
    const em = $("editMsg");
    if(em) em.textContent = "";

    const body = {
      guest_id: Number($("edit_guest")?.value || 0),
      check_in: $("edit_in")?.value,
      check_out: $("edit_out")?.value,
      guests_count: Number($("edit_guests")?.value || 1),
      price_total: Number($("edit_total")?.value || 0),
      prepayment: Number($("edit_prepay")?.value || 0),
      payment_status: $("edit_pay")?.value || "UNPAID",
      booking_status: $("edit_status")?.value || "REQUEST",
      source: $("edit_source")?.value || "",
      notes: $("edit_notes")?.value || ""
    };

    try{
      await apiSend("/api/bookings/" + id, "PUT", body);
      if(em) em.textContent = "✅ Сохранено";
      await loadBookings();
      showModal(false);
    }catch(e){
      if(em) em.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  async function cancelBooking(){
    const id = Number($("edit_id")?.value || 0);
    const em = $("editMsg");
    if(em) em.textContent = "";

    try{
      await apiSend("/api/bookings/" + id + "/cancel", "PATCH", {});
      if(em) em.textContent = "✅ Отменено (сумма обнулена)";
      await loadBookings();
      showModal(false);
    }catch(e){
      if(em) em.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  $("btnAddGuest")?.addEventListener("click", addGuest);
  $("btnAddBooking")?.addEventListener("click", addBooking);
  $("btnReload")?.addEventListener("click", loadBookings);

  $("editClose")?.addEventListener("click", ()=>showModal(false));
  $("btnSaveEdit")?.addEventListener("click", saveEdit);
  $("btnCancelBooking")?.addEventListener("click", cancelBooking);

  filterEl?.addEventListener("input", renderBookings);
  clearBtn?.addEventListener("click", ()=>{
    filterEl.value = "";
    filterEl.focus();
    renderBookings();
  });

  await loadGuestsToSelects();
  await loadBookings();
}

// =================== GUESTS PAGE ===================
async function initGuestsPage(){
  const listEl = $("guestsList");
  if(!listEl) return;

  attachPhoneMask($("g_phone"));

  const searchEl = $("guestSearch");
  const foundEl = $("guestsFound");
  const clearBtn = $("guestsClear");
  const hintEl = $("guestsHint");

  let guests = [];

  async function loadGuests(){
    guests = await apiGet("/api/guests");
    renderGuests();
  }

  function renderGuests(){
    const q = String(searchEl?.value || "").trim();
    const qDigits = digitsOnly(q);

    let rows = guests.slice();
    if(q){
      rows = rows.filter(g=>{
        const name = String(g.full_name||"").toLowerCase();
        const ig = String(g.instagram||"").toLowerCase();
        const phone = String(g.phone||"").toLowerCase();
        const raw = q.toLowerCase();
        if(name.includes(raw)) return true;
        if(ig.includes(raw)) return true;
        if(phone.includes(raw)) return true;
        if(qDigits && digitsOnly(phone).includes(qDigits)) return true;
        return false;
      });
    }

    if(foundEl) foundEl.textContent = String(rows.length);
    if(clearBtn) clearBtn.style.display = q ? "inline-flex" : "none";
    if(hintEl){
      if(!q) hintEl.textContent = "Введите имя / телефон / Instagram";
      else hintEl.textContent = rows.length ? "Есть совпадения" : "Ничего не найдено";
    }

    listEl.innerHTML = rows.map(g=>{
      return `
        <div class="card item">
          <div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              <b>${highlight(g.full_name, q)}</b>
              <span class="badge">ID: ${g.id}</span>
            </div>
            <div class="small">Тел: ${highlight(g.phone || "—", q)}</div>
            <div class="small">IG: ${highlight(g.instagram || "—", q)}</div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
            <button class="secondary" data-history="${g.id}" style="width:auto;">История</button>
          </div>
        </div>
      `;
    }).join("");

    listEl.querySelectorAll("button[data-history]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const id = Number(btn.getAttribute("data-history"));
        openGuestHistory(id);
      });
    });
  }

  async function addGuest(){
    const full_name = $("g_name")?.value?.trim();
    const phone = $("g_phone")?.value || "";
    const instagram = $("g_ig")?.value || "";
    const msg = $("guestMsg");
    if(msg) msg.textContent = "";

    try{
      const r = await apiSend("/api/guests", "POST", { full_name, phone, instagram });
      if(msg) msg.textContent = "✅ Гость добавлен (id: " + r.id + ")";
      $("g_name").value = "";
      $("g_phone").value = "";
      $("g_ig").value = "";
      await loadGuests();
    }catch(e){
      if(msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  function showGuestModal(show){
    const m = $("guestHistoryModal");
    if(!m) return;
    m.classList.toggle("hidden", !show);
  }

  async function openGuestHistory(id){
    const mTitle = $("ghTitle");
    const mSub = $("ghSub");
    const countEl = $("ghCount");
    const totalEl = $("ghTotal");
    const preEl = $("ghPrepay");
    const list = $("ghList");

    try{
      const data = await apiGet(`/api/guests/${id}/bookings`);
      const guest = data.guest || {};
      const bookings = data.bookings || [];

      if(mTitle) mTitle.textContent = guest.full_name || "История гостя";
      if(mSub) mSub.textContent =
        (guest.phone ? ("Тел: " + guest.phone) : "") +
        (guest.instagram ? (" • IG: " + guest.instagram) : "");

      const active = bookings.filter(b => b.booking_status !== "CANCELLED");
      const total = active.reduce((s,b)=> s + Number(b.price_total||0), 0);
      const pre = active.reduce((s,b)=> s + Number(b.prepayment||0), 0);

      if(countEl) countEl.textContent = String(bookings.length);
      if(totalEl) totalEl.textContent = total.toLocaleString("ru-RU");
      if(preEl) preEl.textContent = pre.toLocaleString("ru-RU");

      if(list){
        list.innerHTML = bookings.map(b=>{
          const isCancelled = b.booking_status === "CANCELLED";
          const st = String(b.booking_status || "");
          const badgeClass =
            isCancelled ? "no" : ((st==="CONFIRMED"||st==="COMPLETED") ? "ok" : "wait");

          return `
            <div class="card ${isCancelled ? "isCancelled" : ""}">
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                <b>${escapeHtml(b.check_in)} → ${escapeHtml(b.check_out)}</b>
                <span class="badge ${badgeClass}">${escapeHtml(uiBookingStatus(st))}</span>
              </div>
              <div class="small">
                Сумма: <b>${Number(b.price_total||0).toLocaleString("ru-RU")}</b> ₸ •
                Предоплата: <b>${Number(b.prepayment||0).toLocaleString("ru-RU")}</b> ₸
              </div>
              ${b.notes ? `<div class="small">Заметки: ${escapeHtml(b.notes)}</div>` : ""}
              ${isCancelled ? `<div class="hint">Отменённые брони не учитываются в итогах.</div>` : ``}
            </div>
          `;
        }).join("");
      }

      showGuestModal(true);
    }catch(e){
      // ignore
    }
  }

  $("btnAddGuest")?.addEventListener("click", addGuest);
  $("btnReloadGuests")?.addEventListener("click", loadGuests);

  searchEl?.addEventListener("input", renderGuests);
  clearBtn?.addEventListener("click", ()=>{
    searchEl.value = "";
    searchEl.focus();
    renderGuests();
  });

  $("ghClose")?.addEventListener("click", ()=>showGuestModal(false));

  await loadGuests();
}

// =================== CALENDAR PAGE ===================
async function initCalendarPage(){
  const grid = $("calGrid");
  if(!grid) return;

  const dow = $("calDow");
  const monthSel = $("monthSel");
  const yearSel = $("yearSel");
  const hint = $("calHint");
  const showReqEl = $("calShowRequest");

  const modal = $("bookingModal");
  const modalBody = $("modalBody");
  const modalTitle = $("modalTitle");

  function showModal(show){
    if(!modal) return;
    modal.classList.toggle("hidden", !show);
  }
  $("modalClose")?.addEventListener("click", ()=>showModal(false));
  $("modalOk")?.addEventListener("click", ()=>showModal(false));

  const monthsRu = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  const dowRu = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];

  if(dow){
    dow.innerHTML = dowRu.map(x=>`<div class="calDow">${x}</div>`).join("");
  }

  // ✅ у тебя иногда прилетает ISO: 2025-12-05T00:00:00.000Z
  function dateOnly(s){
    return String(s || "").slice(0, 10); // YYYY-MM-DD
  }

  const now = new Date();
  let curYear = now.getFullYear();
  let curMonth = now.getMonth(); // 0..11

  function fillSelects(){
    if(monthSel){
      monthSel.innerHTML = monthsRu.map((m,i)=>`<option value="${i}">${m}</option>`).join("");
      monthSel.value = String(curMonth);
    }
    if(yearSel){
      const ys = [];
      for(let y=curYear-3; y<=curYear+3; y++) ys.push(y);
      yearSel.innerHTML = ys.map(y=>`<option value="${y}">${y}</option>`).join("");
      yearSel.value = String(curYear);
    }
  }

  function ymd(d){
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const day = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  }

  let bookings = [];
  async function loadBookings(){
    bookings = await apiGet("/api/bookings");
  }

  function bookingActiveForCalendar(b){
    const st = String(b.booking_status || "");
    if(st === "CANCELLED") return false;
    if(st === "CONFIRMED" || st === "COMPLETED") return true;
    if(st === "REQUEST") return !!showReqEl?.checked;
    return false;
  }

  function bookingsByDay(dateStr){
    const day = new Date(dateStr + "T00:00:00");

    return bookings.filter(b=>{
      if(!bookingActiveForCalendar(b)) return false;

      const inStr  = dateOnly(b.check_in);
      const outStr = dateOnly(b.check_out);

      const checkIn  = new Date(inStr  + "T00:00:00");
      const checkOut = new Date(outStr + "T00:00:00");

      if(isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) return false;

      return day >= checkIn && day < checkOut;
    });
  }

  function initials(name){
    const parts = String(name||"").trim().split(/\s+/).filter(Boolean);
    if(!parts.length) return "RB";
    const a = parts[0][0] || "";
    const b = (parts[1]?.[0] || "");
    return (a + b).toUpperCase();
  }

  function render(){
    const first = new Date(curYear, curMonth, 1);
    const last = new Date(curYear, curMonth+1, 0);

    let startOffset = first.getDay() - 1; // Mon-based
    if(startOffset < 0) startOffset = 6;

    const totalCells = startOffset + last.getDate();
    const weeks = Math.ceil(totalCells / 7);
    const cells = weeks * 7;

    const todayStr = ymd(new Date());

    let html = "";
    for(let i=0; i<cells; i++){
      const dayNum = i - startOffset + 1;
      if(dayNum < 1 || dayNum > last.getDate()){
        html += `<div class="calDay" style="opacity:.35; cursor:default;"></div>`;
        continue;
      }

      const d = new Date(curYear, curMonth, dayNum);
      const ds = ymd(d);
      const dayBookings = bookingsByDay(ds);

      const occ = dayBookings.length > 0;
      const isToday = ds === todayStr;

      const tip = occ
        ? dayBookings.slice(0,4).map(b=>{
            const nm = b.full_name || "";
            const stRu = uiBookingStatus(b.booking_status);
            return `${nm} • ${stRu} • ${dateOnly(b.check_in)}→${dateOnly(b.check_out)}`;
          }).join("\n") + (dayBookings.length>4 ? `\n+ ещё ${dayBookings.length-4}` : "")
        : "";

      const mini = occ
        ? (dayBookings.length === 1
            ? `<span class="miniTag busy">${initials(dayBookings[0].full_name)}</span>`
            : `<span class="miniTag busy">${dayBookings.length} брони</span>`
          )
        : "";

      html += `
        <div class="calDay ${occ ? "occupied":""} ${isToday ? "today":""}"
             data-date="${ds}" ${tip ? `data-tip="${escapeHtml(tip)}"` : ""}>
          <div class="n">${dayNum}</div>
          <div class="mini">${mini}</div>
        </div>
      `;
    }

    grid.innerHTML = html;

    grid.querySelectorAll(".calDay[data-date]").forEach(cell=>{
      cell.addEventListener("click", ()=>{
        const ds = cell.getAttribute("data-date");
        openDayModal(ds);
      });
    });

    if(hint){
      if(!!showReqEl?.checked){
        hint.textContent = "Показываю: Подтверждено/Завершено + Запрос. Отменённые скрыты.";
      }else{
        hint.textContent = "Показываю: только Подтверждено/Завершено. Запрос и Отменено скрыты.";
      }
    }
  }

  function openDayModal(ds){
  const dayBookings = bookingsByDay(ds);

  if(modalTitle) modalTitle.textContent = "Брони на " + ds;

  // helpers
  const money = (v) => Number(v||0).toLocaleString("ru-RU") + " ₸";
  const line = (label, value) => `
    <div class="small" style="display:flex;gap:8px;flex-wrap:wrap;">
      <span style="color:#64748b;min-width:110px;">${escapeHtml(label)}</span>
      <b>${escapeHtml(value)}</b>
    </div>
  `;

  // итоги по дню (только не отменённые)
  const active = dayBookings.filter(b => String(b.booking_status||"") !== "CANCELLED");
  const sumTotal = active.reduce((s,b)=> s + Number(b.price_total||0), 0);
  const sumPre   = active.reduce((s,b)=> s + Number(b.prepayment||0), 0);
  const sumDebt  = Math.max(0, sumTotal - sumPre);

  if(modalBody){
    if(!dayBookings.length){
      modalBody.innerHTML = `<div class="notice">На этот день броней нет ✅</div>`;
    }else{
      const cards = dayBookings.map(b=>{
        const st = String(b.booking_status || "");
        const stBadge = (st==="CONFIRMED"||st==="COMPLETED") ? "ok" : (st==="CANCELLED" ? "no" : "wait");

        const paySt = String(b.payment_status || "");
        const payBadge = (paySt==="PAID") ? "ok" : (paySt==="PARTIAL" ? "wait" : "");

        const phone = b.phone || "—";
        const ig = b.instagram || "—";
        const src = b.source || "—";
        const notes = b.notes || "";

        const total = Number(b.price_total||0);
        const pre = Number(b.prepayment||0);
        const debt = Math.max(0, total - pre);

        return `
          <div class="card ${st==="CANCELLED" ? "isCancelled" : ""}" style="margin-bottom:12px;">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              <b style="font-size:18px;">${escapeHtml(b.full_name || "")}</b>
              <span class="badge ${stBadge}">${escapeHtml(uiBookingStatus(st))}</span>
              <span class="badge ${payBadge}">${escapeHtml(uiPaymentStatus(paySt))}</span>
            </div>

            <div style="height:8px"></div>

            ${line("Заезд", dateOnly(b.check_in))}
            ${line("Выезд", dateOnly(b.check_out))}
            ${line("Гостей", String(Number(b.guests_count||1)))}
            ${line("Телефон", phone)}
            ${line("Instagram", ig)}
            ${line("Источник", src)}

            <div style="height:8px"></div>

            ${line("Сумма", money(total))}
            ${line("Предоплата", money(pre))}
            ${line("Остаток", money(debt))}

            ${notes ? `<div style="height:8px"></div>${line("Заметки", notes)}` : ""}

            ${st==="CANCELLED" ? `<div class="hint">Отменено — в итогах дня не учитывается.</div>` : ``}
          </div>
        `;
      }).join("");

      const summary = `
        <div class="card" style="margin-top:12px; border:2px solid #e5e7eb;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
            <b>Итоги дня (без отменённых)</b>
            <span class="badge">Броней: ${active.length}</span>
          </div>
          <div style="height:8px"></div>
          ${line("Общая сумма", money(sumTotal))}
          ${line("Предоплата", money(sumPre))}
          ${line("Остаток", money(sumDebt))}
        </div>
      `;

      modalBody.innerHTML = cards + summary;
    }
  }

  showModal(true);
}

  $("prevMonth")?.addEventListener("click", ()=>{
    curMonth--;
    if(curMonth < 0){ curMonth = 11; curYear--; }
    fillSelects();
    render();
  });

  $("nextMonth")?.addEventListener("click", ()=>{
    curMonth++;
    if(curMonth > 11){ curMonth = 0; curYear++; }
    fillSelects();
    render();
  });

  $("todayBtn")?.addEventListener("click", ()=>{
    curYear = now.getFullYear();
    curMonth = now.getMonth();
    fillSelects();
    render();
  });

  monthSel?.addEventListener("change", ()=>{
    curMonth = Number(monthSel.value);
    render();
  });
  yearSel?.addEventListener("change", ()=>{
    curYear = Number(yearSel.value);
    render();
  });

  showReqEl?.addEventListener("change", ()=>{
    render();
  });

  fillSelects();
  await loadBookings();
  render();
}

// =================== FINANCE HELPERS (Canvas chart with DPR fix) ===================
function drawBarChart(canvas, labels, values){
  const ctx = canvas.getContext("2d");
  if(!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 980;
  const cssH = canvas.clientHeight || 280;

  const needResize =
    canvas.width !== Math.floor(cssW * dpr) ||
    canvas.height !== Math.floor(cssH * dpr);

  if(needResize){
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = cssH;

  ctx.clearRect(0,0,W,H);

  const padL = 46, padR = 12, padT = 12, padB = 34;
  const w = W - padL - padR;
  const h = H - padT - padB;

  const nums = values.map(v=>Number(v||0));
  const maxV = Math.max(1, ...nums);
  const barW = w / Math.max(1, nums.length);

  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + h);
  ctx.lineTo(padL + w, padT + h);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.stroke();

  for(let i=0;i<nums.length;i++){
    const v = nums[i];
    const bh = (v / maxV) * (h - 8);
    const x = padL + i * barW + 6;
    const y = padT + h - bh;

    ctx.fillStyle = "rgba(59,127,106,.75)";
    ctx.fillRect(x, y, Math.max(2, barW - 12), bh);

    ctx.fillStyle = "#64748b";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(labels[i] ?? "", x + (barW-12)/2, padT + h + 18);
  }
}

// =================== FINANCE PAGE (FIXED) ===================
async function initFinancePage(){
  const getAny = (...ids) => ids.map(id => document.getElementById(id)).find(Boolean);

  const yearPick  = getAny("yearPick", "financeYear", "year");
  const monthPick = getAny("monthPick", "financeMonth", "month");
  const btn       = getAny("btnLoadStats", "btnLoad", "loadStatsBtn", "btnStats");

  if(!yearPick || !monthPick || !btn) return;

  const allTime = getAny("allTime", "showAllTime");
  const revEl   = getAny("rev", "revenue");
  const expEl   = getAny("exp", "expenses");
  const netEl   = getAny("net");
  const msgEl   = getAny("statsMsg");

  const metricSel = getAny("chartMetric", "metricSel");
  const yearTotal = getAny("yearTotal");
  const yearAvg   = getAny("yearAvg");
  const chart     = getAny("revChart", "profitChart");

  function fillYearMonth(){
    const now = new Date();
    const y = now.getFullYear();

    yearPick.innerHTML = Array.from({length: 6}, (_,i)=> y - 3 + i)
      .map(v=>`<option value="${v}">${v}</option>`).join("");
    yearPick.value = String(y);

    const monthsRu = [
      "01 — Январь","02 — Февраль","03 — Март","04 — Апрель","05 — Май","06 — Июнь",
      "07 — Июль","08 — Август","09 — Сентябрь","10 — Октябрь","11 — Ноябрь","12 — Декабрь"
    ];

    monthPick.innerHTML =
      `<option value="">— не выбирать —</option>` +
      monthsRu.map((t,i)=>{
        const mm = String(i+1).padStart(2,"0");
        return `<option value="${mm}">${t}</option>`;
      }).join("");

    monthPick.value = "";
  }

  // ✅ FIX: проверка месяца перед запросом + понятный месседж про 500
  async function loadStats(){
    if(msgEl) msgEl.textContent = "";

    const y = String(yearPick.value || "").trim();
    const m = String(monthPick.value || "").trim();

    // если "за всё время" — месяц не нужен
    if(allTime?.checked){
      try{
        const data = await apiGet(`/api/stats`);
        if(revEl) revEl.textContent = Number(data.revenue||0).toLocaleString("ru-RU");
        if(expEl) expEl.textContent = Number(data.expenses||0).toLocaleString("ru-RU");
        if(netEl) {
          const v = Number(data.net||0);
          netEl.textContent = v.toLocaleString("ru-RU");
          netEl.className = v >= 0 ? "pos" : "neg";
        }
        if(msgEl) msgEl.textContent = "✅ Готово";
      }catch(e){
        if(msgEl) msgEl.textContent = "❌ " + (e?.message || "ошибка");
      }
      return;
    }

    // если НЕ allTime, но месяц не выбран — не шлём кривой запрос
    if(!m){
      if(msgEl) msgEl.textContent = "⚠️ Выбери месяц или включи «за всё время»";
      return;
    }

    // строгая проверка формата YYYY-MM
    const month = `${y}-${m}`;
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)){
      if(msgEl) msgEl.textContent = "⚠️ Неверный формат месяца: " + month;
      return;
    }

    try{
      const data = await apiGet(`/api/stats?month=${encodeURIComponent(month)}`);
      if(revEl) revEl.textContent = Number(data.revenue||0).toLocaleString("ru-RU");
      if(expEl) expEl.textContent = Number(data.expenses||0).toLocaleString("ru-RU");
      if(netEl) {
        const v = Number(data.net||0);
        netEl.textContent = v.toLocaleString("ru-RU");
        netEl.className = v >= 0 ? "pos" : "neg";
      }
      if(msgEl) msgEl.textContent = "✅ Готово";
    }catch(e){
      // если 500 — объясняем как человек
     // ✅ НОВЫЙ КОД:
      if(e?.status === 500){
        if(msgEl) msgEl.textContent =
          "❌ Ошибка сервера (HTTP 500). Проверьте подключение к базе данных или обратитесь к администратору.";
      }else{
        if(msgEl) msgEl.textContent = "❌ " + (e?.message || "ошибка");
      }
    }
  }

  async function loadChart(){
    if(!chart) return;

    const y = Number(yearPick.value);
    if(!y) return;

    try{
      const data = await apiGet(`/api/profit-by-month?year=${encodeURIComponent(y)}`);
      const months = data.months || [];
      const labels = months.map(x=>x.month);

      let values = months.map(x=>Number(x.revenue||0));
      const metric = metricSel?.value || "revenue";
      if(metric === "expenses") values = months.map(x=>Number(x.expenses||0));
      if(metric === "net")      values = months.map(x=>Number(x.net||0));

      const sum = values.reduce((s,v)=>s+Number(v||0), 0);
      const avg = Math.round(sum / 12);
      if(yearTotal) yearTotal.textContent = sum.toLocaleString("ru-RU") + " ₸";
      if(yearAvg) yearAvg.textContent = avg.toLocaleString("ru-RU") + " ₸";

      drawBarChart(chart, labels, values);
    }catch(e){
      // ignore
    }
  }

  document.getElementById("btnExport")?.addEventListener("click", ()=>{
    const y = yearPick.value;
    const a = document.createElement("a");
    a.href = `/api/export/year.csv?year=${encodeURIComponent(y)}`;
    a.click();
  });

  document.getElementById("btnExportXlsx")?.addEventListener("click", ()=>{
    const y = yearPick.value;
    const a = document.createElement("a");
    a.href = `/api/export/analytics.xlsx?year=${encodeURIComponent(y)}`;
    a.click();
    showToast("Скачивается Excel отчёт за " + y + "…", "ok");
  });

  fillYearMonth();
  enhanceSelect(yearPick);
  enhanceSelect(monthPick);
  if(metricSel) enhanceSelect(metricSel);

  btn.addEventListener("click", loadStats);
  yearPick.addEventListener("change", loadChart);
  metricSel?.addEventListener("change", loadChart);

  allTime?.addEventListener("change", ()=>{
    if(allTime.checked) monthPick.value = "";
  });

  await loadStats();
  await loadChart();
}

// =================== EXPENSES PAGE ===================
async function initExpensesPage(){
  const listEl = $("expList");
  if(!listEl) return;

  async function load(){
    const rows = await apiGet("/api/expenses");
    listEl.innerHTML = rows.map(r=>`
      <div class="card item">
        <div>
          <b>${escapeHtml(r.exp_date)}</b>
          <div class="small">${escapeHtml(r.category)}${r.note ? (" • " + escapeHtml(r.note)) : ""}</div>
        </div>
        <div style="text-align:right;">
          <b>${Number(r.amount||0).toLocaleString("ru-RU")} ₸</b>
          <div style="height:8px"></div>
          <button class="secondary danger" data-del="${r.id}" style="width:auto;">Удалить</button>
        </div>
      </div>
    `).join("");

    listEl.querySelectorAll("button[data-del]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const id = Number(btn.getAttribute("data-del"));
        try{
          await apiSend("/api/expenses/" + id, "DELETE");
          await load();
        }catch(e){}
      });
    });
  }

  $("btnAddExpense")?.addEventListener("click", async ()=>{
    const msg = $("expMsg");
    if(msg) msg.textContent = "";

    const exp_date = $("exp_date")?.value;
    const category = $("exp_cat")?.value || "";
    const amount = Number($("exp_amount")?.value || 0);
    const note = $("exp_note")?.value || "";

    try{
      await apiSend("/api/expenses", "POST", { exp_date, category, amount, note });
      if(msg) msg.textContent = "✅ Сохранено";
      await load();
    }catch(e){
      if(msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  });

  $("btnReloadExp")?.addEventListener("click", load);
  await load();
}

// =================== Pretty Select (FIXED) ===================
function enhanceSelect(selectEl){
  if(!selectEl || selectEl.dataset.prettyDone === "1") return;

  const wrap = document.createElement("div");
  wrap.className = "pSelect";
  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pSelectBtn";
  btn.innerHTML = `<span class="txt"></span><span class="pSelectChevron">▾</span>`;
  wrap.appendChild(btn);

  const menu = document.createElement("div");
  menu.className = "pSelectMenu";
  wrap.appendChild(menu);

  function currentLabel(){
    const idx = selectEl.selectedIndex;
    const opt = idx >= 0 ? selectEl.options[idx] : null;
    return opt ? opt.textContent : "— выбрать —";
  }

  function rebuild(){
    btn.querySelector(".txt").textContent = currentLabel();

    const cur = String(selectEl.value ?? "");
    menu.innerHTML = "";

    Array.from(selectEl.options).forEach((opt) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pSelectItem" + (String(opt.value) === cur ? " active" : "");
      item.textContent = opt.textContent;

      item.addEventListener("click", () => {
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        close();
      });

      menu.appendChild(item);
    });
  }

  function open(){
    document.querySelectorAll(".pSelect.open").forEach(x=>x.classList.remove("open"));
    wrap.classList.add("open");
    rebuild();
  }
  function close(){
    wrap.classList.remove("open");
  }

  btn.addEventListener("click", () => {
    if(wrap.classList.contains("open")) close();
    else open();
  });

  document.addEventListener("click", (e) => {
    if(!wrap.contains(e.target)) close();
  });

  selectEl.addEventListener("change", rebuild);

  const mo = new MutationObserver(() => rebuild());
  mo.observe(selectEl, { childList: true, subtree: true });

  selectEl.dataset.prettyDone = "1";
  rebuild();
}

function enhancePrettySelects(){
  enhanceSelect(document.getElementById("yearPick"));
  enhanceSelect(document.getElementById("monthPick"));
  enhanceSelect(document.getElementById("chartMetric"));

  enhanceSelect(document.getElementById("monthSel"));
  enhanceSelect(document.getElementById("yearSel"));
}

// =================== INIT ===================
document.addEventListener("DOMContentLoaded", async () => {
  setActiveNav();
  enhancePrettySelects();

  // V2 pages (improved tables + pagination)
  if (document.getElementById("bookingsList")) {
    try { await initBookingsPageV2(); } catch (e) { console.error("bookings init:", e); }
  }
  if (document.getElementById("guestsList")) {
    try { await initGuestsPageV2(); } catch (e) { console.error("guests init:", e); }
  }
  if (document.getElementById("expList")) {
    try { await initExpensesPageV2(); } catch (e) { console.error("expenses init:", e); }
  }

  // Unchanged pages
  try { await initCalendarPage(); } catch (e) {}
  try { await initFinancePage(); } catch (e) {}

  // New pages
  try { await initAnalyticsPage(); } catch (e) { console.error("analytics init:", e); }
  try { await initIndexPage(); } catch (e) {}

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      if (!confirm("Выйти из системы?")) return;
      try { await apiSend("/api/auth/logout", "POST"); } catch (e) {}
      location.replace("/login.html");
    });
  }
});
// =================== TOAST NOTIFICATIONS ===================
function showToast(msg, type = "ok", duration = 3500) {
  let wrap = document.getElementById("toastWrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toastWrap";
    document.body.appendChild(wrap);
  }
  const t = document.createElement("div");
  t.className = `toast toast--${type}`;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .3s";
    setTimeout(() => t.remove(), 320);
  }, duration);
}

// =================== GROUPED BAR CHART (Analytics) ===================
function formatShort(v) {
  const n = Math.abs(v);
  if (n >= 1000000) return (v / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (v / 1000).toFixed(0) + "K";
  return String(v);
}

function drawGroupedChart(canvas, labels, datasets) {
  // datasets = [{label, color, values: []}]
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 280;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW, H = cssH;
  ctx.clearRect(0, 0, W, H);

  const padL = 56, padR = 16, padT = 20, padB = 44;
  const cW = W - padL - padR;
  const cH = H - padT - padB;

  const allNums = datasets.flatMap(d => d.values.map(v => Number(v || 0)));
  const maxV = Math.max(1, ...allNums.map(Math.abs));

  const n = labels.length;
  const groupW = cW / Math.max(1, n);
  const bCount = datasets.length;
  const bW = Math.max(2, (groupW - 10) / bCount);

  // Grid lines
  ctx.setLineDash([3, 4]);
  const gridN = 4;
  for (let i = 1; i <= gridN; i++) {
    const y = padT + cH - (i / gridN) * cH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + cW, y);
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(formatShort(maxV * i / gridN), padL - 5, y + 4);
  }
  ctx.setLineDash([]);

  // Axes
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + cH);
  ctx.lineTo(padL + cW, padT + cH);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Bars
  for (let i = 0; i < n; i++) {
    for (let di = 0; di < bCount; di++) {
      const v = Number(datasets[di].values[i] || 0);
      if (v === 0) continue;
      const bh = (Math.abs(v) / maxV) * (cH - 4);
      const x = padL + i * groupW + 4 + di * bW;
      const y = v >= 0 ? padT + cH - bh : padT + cH;
      ctx.globalAlpha = 0.88;
      ctx.fillStyle = datasets[di].color;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, Math.max(1, bW - 2), bh, [3, 3, 0, 0]) : ctx.rect(x, y, Math.max(1, bW - 2), bh);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // X labels — skip some if too many
    const step = n > 60 ? Math.ceil(n / 20) : n > 30 ? 3 : n > 15 ? 2 : 1;
    if (i % step === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "10px system-ui";
      ctx.textAlign = "center";
      const lbl = String(labels[i] || "");
      ctx.fillText(lbl.length > 8 ? lbl.slice(5) : lbl, padL + i * groupW + groupW / 2, padT + cH + 16);
    }
  }
}

// =================== ANALYTICS PAGE ===================
async function initAnalyticsPage() {
  const canvas = document.getElementById("analyticsChart");
  if (!canvas) return;

  const kqToday = $("kqToday");
  const kqWeek  = $("kqWeek");
  const kqMonth = $("kqMonth");
  const kqAll   = $("kqAll");

  const kpRevenue  = $("kpRevenue");
  const kpExpenses = $("kpExpenses");
  const kpNet      = $("kpNet");
  const kpCount    = $("kpCount");
  const kpAvg      = $("kpAvg");
  const chartEmpty = $("chartEmpty");
  const chartRangeHint = $("chartRangeHint");
  const statusBreakdownEl = $("statusBreakdown");

  let chartMode = "daily"; // "daily" | "monthly"
  let lastData = null;

  function fmt(v) { return Number(v || 0).toLocaleString("ru-RU"); }

  function buildQuery() {
    const df = $("anDateFrom")?.value || "";
    const dt = $("anDateTo")?.value || "";
    const st = $("anStatus")?.value || "";
    const year = new Date().getFullYear();
    const params = new URLSearchParams();
    if (df) params.set("date_from", df);
    if (dt) params.set("date_to", dt);
    if (st) params.set("status", st);
    params.set("year", String(year));
    return params.toString();
  }

  function renderChart(data) {
    const isEmpty = chartMode === "daily"
      ? !data.chart.daily.length || data.chart.daily.every(d => d.revenue === 0 && d.expenses === 0)
      : !data.chart.monthly.length || data.chart.monthly.every(d => d.revenue === 0 && d.expenses === 0);

    if (isEmpty) {
      canvas.style.display = "none";
      if (chartEmpty) chartEmpty.style.display = "flex";
      return;
    }
    canvas.style.display = "";
    if (chartEmpty) chartEmpty.style.display = "none";

    if (chartMode === "daily") {
      const labels = data.chart.daily.map(d => d.date.slice(5)); // MM-DD
      drawGroupedChart(canvas, labels, [
        { label: "Выручка",  color: "rgba(14,124,102,.75)", values: data.chart.daily.map(d => d.revenue) },
        { label: "Расходы",  color: "rgba(220,104,3,.65)",  values: data.chart.daily.map(d => d.expenses) },
      ]);
      const df = $("anDateFrom")?.value || "";
      const dt = $("anDateTo")?.value || "";
      if (chartRangeHint) chartRangeHint.textContent = df && dt ? `Период: ${df} — ${dt}` : "Период: этот месяц";
    } else {
      const monthRu = ["", "Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
      const labels = data.chart.monthly.map(d => monthRu[Number(d.month)] || d.month);
      drawGroupedChart(canvas, labels, [
        { label: "Выручка",        color: "rgba(14,124,102,.75)", values: data.chart.monthly.map(d => d.revenue) },
        { label: "Расходы",        color: "rgba(220,104,3,.65)",  values: data.chart.monthly.map(d => d.expenses) },
        { label: "Чистая прибыль", color: "rgba(37,99,235,.65)",  values: data.chart.monthly.map(d => d.net) },
      ]);
      if (chartRangeHint) chartRangeHint.textContent = `По месяцам — ${new Date().getFullYear()}`;
    }
  }

  function renderStatusBreakdown(breakdown) {
    if (!statusBreakdownEl) return;
    const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
    const items = [
      { key: "CONFIRMED", label: "Подтверждено", color: "#22c55e" },
      { key: "COMPLETED", label: "Завершено",    color: "#0E7C66" },
      { key: "REQUEST",   label: "Запрос",        color: "#f59e0b" },
      { key: "CANCELLED", label: "Отменено",      color: "#ef4444" },
    ];
    if (!total) {
      statusBreakdownEl.innerHTML = `<div class="emptyState" style="padding:20px 0;"><div class="emptyState__icon">🗂️</div><div class="emptyState__sub">Броней пока нет</div></div>`;
      return;
    }
    statusBreakdownEl.innerHTML = `<div class="statusBar">` + items.map(item => {
      const cnt = breakdown[item.key] || 0;
      const pct = total ? Math.round(cnt / total * 100) : 0;
      return `<div class="statusBar__row">
        <div class="statusBar__label">${item.label}</div>
        <div class="statusBar__track"><div class="statusBar__fill" style="width:${pct}%;background:${item.color};"></div></div>
        <div class="statusBar__count">${cnt}</div>
      </div>`;
    }).join("") + `</div>`;
  }

  async function load() {
    try {
      const qs = buildQuery();
      const data = await apiGet(`/api/analytics?${qs}`);
      lastData = data;

      const kpi = data.kpi || {};
      if (kqToday) kqToday.textContent = fmt(kpi.today) + " ₸";
      if (kqWeek)  kqWeek.textContent  = fmt(kpi.week)  + " ₸";
      if (kqMonth) kqMonth.textContent = fmt(kpi.month) + " ₸";
      if (kqAll)   kqAll.textContent   = fmt(kpi.all_time) + " ₸";

      if (kpRevenue)  kpRevenue.textContent  = fmt(kpi.period);
      if (kpExpenses) kpExpenses.textContent = fmt(kpi.expenses);
      if (kpCount)    kpCount.textContent    = String(kpi.bookings_count || 0);
      if (kpAvg)      kpAvg.textContent      = fmt(kpi.avg_check);

      if (kpNet) {
        const net = Number(kpi.net_profit || 0);
        kpNet.textContent = fmt(net);
        kpNet.className = "kpiCard__value " + (net >= 0 ? "kpiCard__value--green" : "kpiCard__value--red");
      }

      renderChart(data);
      renderStatusBreakdown(data.status_breakdown || {});
    } catch (e) {
      showToast("Ошибка загрузки аналитики", "error");
    }
  }

  // Chart toggle
  $("btnChartDaily")?.addEventListener("click", () => {
    chartMode = "daily";
    $("btnChartDaily")?.classList.add("chartToggleBtn--active");
    $("btnChartMonthly")?.classList.remove("chartToggleBtn--active");
    if (lastData) renderChart(lastData);
  });
  $("btnChartMonthly")?.addEventListener("click", () => {
    chartMode = "monthly";
    $("btnChartMonthly")?.classList.add("chartToggleBtn--active");
    $("btnChartDaily")?.classList.remove("chartToggleBtn--active");
    if (lastData) renderChart(lastData);
  });

  $("btnApplyFilter")?.addEventListener("click", load);
  $("btnResetFilter")?.addEventListener("click", () => {
    const df = $("anDateFrom"); if (df) df.value = "";
    const dt = $("anDateTo");   if (dt) dt.value = "";
    const st = $("anStatus");   if (st) st.value = "";
    load();
  });

  // Exports
  function downloadUrl(url) {
    const a = document.createElement("a");
    a.href = url;
    a.click();
  }

  $("btnExportAnalytics")?.addEventListener("click", () => {
    const df = $("anDateFrom")?.value || "";
    const dt = $("anDateTo")?.value || "";
    const year = new Date().getFullYear();
    const params = new URLSearchParams();
    if (df) params.set("date_from", df);
    if (dt) params.set("date_to", dt);
    params.set("year", String(year));
    downloadUrl(`/api/export/analytics.xlsx?${params.toString()}`);
    showToast("Скачивается отчёт аналитики…", "ok");
  });
  $("btnExportBookings")?.addEventListener("click", () => {
    downloadUrl("/api/export/bookings.xlsx");
    showToast("Скачивается список броней…", "ok");
  });
  $("btnExportGuests")?.addEventListener("click", () => {
    downloadUrl("/api/export/guests.xlsx");
    showToast("Скачивается список гостей…", "ok");
  });
  $("btnExportExpenses")?.addEventListener("click", () => {
    downloadUrl("/api/export/expenses.xlsx");
    showToast("Скачивается список расходов…", "ok");
  });

  // Redraw on resize
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (lastData) renderChart(lastData); }, 150);
  });

  await load();
}

// =================== INDEX DASHBOARD LIVE STATS ===================
async function initIndexPage() {
  const liveGrid = $("liveStatGrid");
  if (!liveGrid) return;
  try {
    const data = await apiGet("/api/analytics");
    const kpi = data.kpi || {};
    const fmt = v => Number(v || 0).toLocaleString("ru-RU");

    const todayStr = new Date().toISOString().slice(0, 7);
    liveGrid.innerHTML = `
      <div class="liveStat">
        <div class="liveStat__label">Этот месяц — выручка</div>
        <div class="liveStat__value">${fmt(kpi.month)} ₸</div>
        <div class="liveStat__sub">${todayStr}</div>
      </div>
      <div class="liveStat">
        <div class="liveStat__label">Всего броней (активные)</div>
        <div class="liveStat__value">${fmt(kpi.bookings_count)}</div>
        <div class="liveStat__sub">за всё время</div>
      </div>
      <div class="liveStat">
        <div class="liveStat__label">Сегодня — выручка</div>
        <div class="liveStat__value">${fmt(kpi.today)} ₸</div>
        <div class="liveStat__sub">${new Date().toISOString().slice(0, 10)}</div>
      </div>
    `;
  } catch { /* ignore on index */ }
}

// =================== IMPROVED EXPENSES PAGE ===================
async function initExpensesPageV2() {
  const listEl = $("expList");
  if (!listEl) return;

  const PAGE_SIZE = 15;
  let allRows = [];
  let curPage = 1;
  let sortKey = "exp_date";
  let sortDir = -1; // -1 = desc, 1 = asc
  let editingId = null;

  function fmt(v) { return Number(v || 0).toLocaleString("ru-RU"); }

  async function load() {
    allRows = await apiGet("/api/expenses");
    curPage = 1;
    render();
  }

  function getSorted() {
    return [...allRows].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (av < bv) return sortDir;
      if (av > bv) return -sortDir;
      return 0;
    });
  }

  function render() {
    const sorted = getSorted();
    const total = sorted.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (curPage > pages) curPage = pages;
    const slice = sorted.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

    const found = $("expFound");
    if (found) found.textContent = String(total);

    if (!total) {
      listEl.innerHTML = `<div class="emptyState"><div class="emptyState__icon">🧯</div><div class="emptyState__title">Расходов пока нет</div><div class="emptyState__sub">Добавьте первый расход выше</div></div>`;
      renderPager(pages);
      return;
    }

    function thArrow(key) {
      if (sortKey !== key) return `<span class="sortArrow">↕</span>`;
      return sortDir === -1 ? `<span class="sortArrow">↓</span>` : `<span class="sortArrow">↑</span>`;
    }

    listEl.innerHTML = `
      <div class="tableWrap">
        <table class="dataTable">
          <thead>
            <tr>
              <th data-sort="id">ID ${thArrow("id")}</th>
              <th data-sort="exp_date">Дата ${thArrow("exp_date")}</th>
              <th data-sort="category">Категория ${thArrow("category")}</th>
              <th data-sort="amount" class="tdRight">Сумма ${thArrow("amount")}</th>
              <th>Комментарий</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${slice.map(r => `
              <tr>
                <td class="tdMuted">${r.id}</td>
                <td class="tdMono">${escapeHtml(r.exp_date)}</td>
                <td>${escapeHtml(r.category)}</td>
                <td class="tdRight"><b>${fmt(r.amount)}</b> ₸</td>
                <td class="tdMuted">${escapeHtml(r.note || "—")}</td>
                <td>
                  <div style="display:flex;gap:5px;flex-wrap:wrap;">
                    <button class="tblBtn" data-edit-exp="${r.id}">✎</button>
                    <button class="tblBtn tblBtn--danger" data-del-exp="${r.id}">🗑</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    // Sort headers
    listEl.querySelectorAll("th[data-sort]").forEach(th => {
      const key = th.getAttribute("data-sort");
      if (sortKey === key) th.classList.add(sortDir === -1 ? "sortDesc" : "sortAsc");
      th.addEventListener("click", () => {
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = -1; }
        render();
      });
    });

    // Delete
    listEl.querySelectorAll("button[data-del-exp]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-del-exp"));
        if (!confirm("Удалить расход?")) return;
        try {
          await apiSend("/api/expenses/" + id, "DELETE");
          showToast("Расход удалён", "ok");
          await load();
        } catch { showToast("Ошибка удаления", "error"); }
      });
    });

    // Edit
    listEl.querySelectorAll("button[data-edit-exp]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-edit-exp"));
        const row = allRows.find(r => r.id === id);
        if (!row) return;
        openEditExpense(row);
      });
    });

    renderPager(pages);
  }

  function renderPager(pages) {
    let pagerEl = $("expPager");
    if (!pagerEl) {
      pagerEl = document.createElement("div");
      pagerEl.id = "expPager";
      pagerEl.className = "pager";
      listEl.parentNode.insertBefore(pagerEl, listEl.nextSibling);
    }
    if (pages <= 1) { pagerEl.innerHTML = ""; return; }
    pagerEl.innerHTML = `
      <button class="pagerBtn" ${curPage === 1 ? "disabled" : ""} data-pg="${curPage - 1}">‹</button>
      ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
        `<button class="pagerBtn ${p === curPage ? "active" : ""}" data-pg="${p}">${p}</button>`
      ).join("")}
      <button class="pagerBtn" ${curPage === pages ? "disabled" : ""} data-pg="${curPage + 1}">›</button>
    `;
    pagerEl.querySelectorAll("button[data-pg]").forEach(btn => {
      btn.addEventListener("click", () => { curPage = Number(btn.getAttribute("data-pg")); render(); });
    });
  }

  function openEditExpense(row) {
    editingId = row.id;
    const m = $("editExpenseModal");
    if (!m) return;
    $("ee_date").value    = row.exp_date || "";
    $("ee_cat").value     = row.category || "";
    $("ee_amount").value  = row.amount || 0;
    $("ee_note").value    = row.note || "";
    const msg = $("eeMsg"); if (msg) msg.textContent = "";
    m.classList.remove("hidden");
  }

  $("eeClose")?.addEventListener("click", () => $("editExpenseModal")?.classList.add("hidden"));
  $("btnSaveExpense")?.addEventListener("click", async () => {
    if (!editingId) return;
    const msg = $("eeMsg");
    try {
      await apiSend("/api/expenses/" + editingId, "PUT", {
        exp_date: $("ee_date")?.value,
        category: $("ee_cat")?.value,
        amount: Number($("ee_amount")?.value || 0),
        note: $("ee_note")?.value || "",
      });
      $("editExpenseModal")?.classList.add("hidden");
      showToast("Расход обновлён", "ok");
      await load();
    } catch (e) {
      if (msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  });

  // Excel export
  $("btnExportExp")?.addEventListener("click", () => {
    const df = $("expFilterFrom")?.value || "";
    const dt = $("expFilterTo")?.value || "";
    const params = new URLSearchParams();
    if (df) params.set("date_from", df);
    if (dt) params.set("date_to", dt);
    const a = document.createElement("a");
    a.href = `/api/export/expenses.xlsx?${params.toString()}`;
    a.click();
    showToast("Скачивается список расходов…", "ok");
  });

  $("btnAddExpense")?.addEventListener("click", async () => {
    const msg = $("expMsg");
    if (msg) msg.textContent = "";
    const exp_date = $("exp_date")?.value;
    const category = $("exp_cat")?.value || "";
    const amount = Number($("exp_amount")?.value || 0);
    const note = $("exp_note")?.value || "";
    try {
      await apiSend("/api/expenses", "POST", { exp_date, category, amount, note });
      if (msg) msg.textContent = "";
      showToast("Расход добавлен ✅", "ok");
      // Clear form
      if ($("exp_date")) $("exp_date").value = "";
      if ($("exp_amount")) $("exp_amount").value = "0";
      if ($("exp_note")) $("exp_note").value = "";
      await load();
    } catch (e) {
      if (msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  });

  $("btnReloadExp")?.addEventListener("click", load);
  await load();
}

// =================== IMPROVED GUESTS PAGE ===================
async function initGuestsPageV2() {
  const listEl = $("guestsList");
  if (!listEl) return;

  attachPhoneMask($("g_phone"));

  const searchEl = $("guestSearch");
  const foundEl  = $("guestsFound");
  const clearBtn = $("guestsClear");
  const hintEl   = $("guestsHint");

  const PAGE_SIZE = 15;
  let allGuests = [];
  let curPage = 1;
  let sortKey = "id";
  let sortDir = -1;
  let editingGuestId = null;

  function fmt(v) { return Number(v || 0).toLocaleString("ru-RU"); }

  async function loadGuests() {
    allGuests = await apiGet("/api/guests");
    curPage = 1;
    renderGuests();
  }

  function getFiltered() {
    const q = String(searchEl?.value || "").trim();
    const qDigits = digitsOnly(q);
    if (!q) return [...allGuests];
    return allGuests.filter(g => {
      const name  = String(g.full_name || "").toLowerCase();
      const ig    = String(g.instagram || "").toLowerCase();
      const phone = String(g.phone || "").toLowerCase();
      const raw   = q.toLowerCase();
      if (name.includes(raw) || ig.includes(raw) || phone.includes(raw)) return true;
      if (qDigits && digitsOnly(phone).includes(qDigits)) return true;
      return false;
    });
  }

  function getSorted(rows) {
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (av < bv) return sortDir;
      if (av > bv) return -sortDir;
      return 0;
    });
  }

  function renderGuests() {
    const filtered = getFiltered();
    const sorted   = getSorted(filtered);
    const q        = String(searchEl?.value || "").trim();
    const total    = sorted.length;
    const pages    = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (curPage > pages) curPage = pages;
    const slice = sorted.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

    if (foundEl) foundEl.textContent = String(total);
    if (clearBtn) clearBtn.style.display = q ? "inline-flex" : "none";
    if (hintEl) hintEl.textContent = !q ? "Введите имя / телефон / Instagram" : (total ? `${total} найдено` : "Ничего не найдено");

    if (!total) {
      listEl.innerHTML = `<div class="emptyState"><div class="emptyState__icon">👤</div><div class="emptyState__title">Гостей не найдено</div><div class="emptyState__sub">${q ? "Измените запрос поиска" : "Добавьте первого гостя выше"}</div></div>`;
      renderGuestsPager(pages);
      return;
    }

    function thArrow(key) {
      if (sortKey !== key) return `<span class="sortArrow">↕</span>`;
      return sortDir === -1 ? `<span class="sortArrow">↓</span>` : `<span class="sortArrow">↑</span>`;
    }

    listEl.innerHTML = `
      <div class="tableWrap">
        <table class="dataTable">
          <thead>
            <tr>
              <th data-gsort="id">ID ${thArrow("id")}</th>
              <th data-gsort="full_name">ФИО ${thArrow("full_name")}</th>
              <th data-gsort="phone">Телефон ${thArrow("phone")}</th>
              <th>Instagram</th>
              <th>Заметки</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${slice.map(g => `
              <tr>
                <td class="tdMuted">${g.id}</td>
                <td><b>${highlight(g.full_name, q)}</b></td>
                <td class="tdMono">${highlight(g.phone || "—", q)}</td>
                <td class="tdMuted">${highlight(g.instagram || "—", q)}</td>
                <td class="tdMuted" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(g.note || "—")}</td>
                <td>
                  <div style="display:flex;gap:5px;flex-wrap:wrap;">
                    <button class="tblBtn" data-ghist="${g.id}" title="История броней">История</button>
                    <button class="tblBtn" data-gedit="${g.id}" title="Редактировать">✎</button>
                    <button class="tblBtn tblBtn--danger" data-gdel="${g.id}" title="Удалить">🗑</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    // Sort
    listEl.querySelectorAll("th[data-gsort]").forEach(th => {
      const key = th.getAttribute("data-gsort");
      if (sortKey === key) th.classList.add(sortDir === -1 ? "sortDesc" : "sortAsc");
      th.addEventListener("click", () => {
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = -1; }
        renderGuests();
      });
    });

    // History
    listEl.querySelectorAll("button[data-ghist]").forEach(btn => {
      btn.addEventListener("click", () => openGuestHistoryV2(Number(btn.getAttribute("data-ghist"))));
    });

    // Edit
    listEl.querySelectorAll("button[data-gedit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-gedit"));
        const g = allGuests.find(x => x.id === id);
        if (!g) return;
        openEditGuest(g);
      });
    });

    // Delete
    listEl.querySelectorAll("button[data-gdel]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-gdel"));
        const g = allGuests.find(x => x.id === id);
        if (!confirm(`Удалить гостя «${g?.full_name || id}»?\nВсе его брони тоже будут удалены!`)) return;
        try {
          await apiSend("/api/guests/" + id, "DELETE");
          showToast("Гость удалён", "ok");
          await loadGuests();
        } catch { showToast("Ошибка удаления", "error"); }
      });
    });

    renderGuestsPager(pages);
  }

  function renderGuestsPager(pages) {
    let pagerEl = $("guestsPager");
    if (!pagerEl) {
      pagerEl = document.createElement("div");
      pagerEl.id = "guestsPager";
      pagerEl.className = "pager";
      listEl.parentNode.insertBefore(pagerEl, listEl.nextSibling);
    }
    if (pages <= 1) { pagerEl.innerHTML = ""; return; }
    pagerEl.innerHTML = `
      <button class="pagerBtn" ${curPage === 1 ? "disabled" : ""} data-gpg="${curPage - 1}">‹</button>
      ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
        `<button class="pagerBtn ${p === curPage ? "active" : ""}" data-gpg="${p}">${p}</button>`
      ).join("")}
      <button class="pagerBtn" ${curPage === pages ? "disabled" : ""} data-gpg="${curPage + 1}">›</button>
    `;
    pagerEl.querySelectorAll("button[data-gpg]").forEach(btn => {
      btn.addEventListener("click", () => { curPage = Number(btn.getAttribute("data-gpg")); renderGuests(); });
    });
  }

  function openEditGuest(g) {
    editingGuestId = g.id;
    const m = $("editGuestModal");
    if (!m) return;
    $("eg_name").value = g.full_name || "";
    $("eg_phone").value = g.phone || "";
    $("eg_ig").value = g.instagram || "";
    $("eg_note").value = g.note || "";
    const msg = $("egMsg"); if (msg) msg.textContent = "";
    m.classList.remove("hidden");
  }

  $("egClose")?.addEventListener("click", () => $("editGuestModal")?.classList.add("hidden"));
  $("btnSaveGuest")?.addEventListener("click", async () => {
    if (!editingGuestId) return;
    const msg = $("egMsg");
    try {
      await apiSend("/api/guests/" + editingGuestId, "PUT", {
        full_name: $("eg_name")?.value?.trim(),
        phone: $("eg_phone")?.value || "",
        instagram: $("eg_ig")?.value || "",
        note: $("eg_note")?.value || "",
      });
      $("editGuestModal")?.classList.add("hidden");
      showToast("Гость обновлён ✅", "ok");
      await loadGuests();
    } catch (e) {
      if (msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  });

  // Excel export
  $("btnExportGuests")?.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = "/api/export/guests.xlsx";
    a.click();
    showToast("Скачивается список гостей…", "ok");
  });

  // History modal (reused existing logic)
  async function openGuestHistoryV2(id) {
    const mTitle = $("ghTitle");
    const mSub   = $("ghSub");
    const countEl = $("ghCount");
    const totalEl = $("ghTotal");
    const preEl   = $("ghPrepay");
    const list    = $("ghList");
    try {
      const data     = await apiGet(`/api/guests/${id}/bookings`);
      const guest    = data.guest || {};
      const bookings = data.bookings || [];
      if (mTitle) mTitle.textContent = guest.full_name || "История гостя";
      if (mSub) mSub.textContent = (guest.phone ? "Тел: " + guest.phone : "") + (guest.instagram ? " • IG: " + guest.instagram : "");
      const active = bookings.filter(b => b.booking_status !== "CANCELLED");
      const total  = active.reduce((s, b) => s + Number(b.price_total || 0), 0);
      const pre    = active.reduce((s, b) => s + Number(b.prepayment  || 0), 0);
      if (countEl) countEl.textContent = String(bookings.length);
      if (totalEl) totalEl.textContent = total.toLocaleString("ru-RU");
      if (preEl)   preEl.textContent   = pre.toLocaleString("ru-RU");
      if (list) {
        if (!bookings.length) {
          list.innerHTML = `<div class="emptyState"><div class="emptyState__icon">🗂️</div><div class="emptyState__sub">Броней нет</div></div>`;
        } else {
          list.innerHTML = bookings.map(b => {
            const isCancelled = b.booking_status === "CANCELLED";
            const st = String(b.booking_status || "");
            const bc = isCancelled ? "no" : ((st === "CONFIRMED" || st === "COMPLETED") ? "ok" : "wait");
            return `<div class="card ${isCancelled ? "isCancelled" : ""}" style="margin-bottom:8px;">
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                <b>${escapeHtml(b.check_in)} → ${escapeHtml(b.check_out)}</b>
                <span class="badge ${bc}">${escapeHtml(uiBookingStatus(st))}</span>
              </div>
              <div class="small">Сумма: <b>${Number(b.price_total || 0).toLocaleString("ru-RU")}</b> ₸ • Предоплата: <b>${Number(b.prepayment || 0).toLocaleString("ru-RU")}</b> ₸</div>
              ${b.notes ? `<div class="small">Заметки: ${escapeHtml(b.notes)}</div>` : ""}
              ${isCancelled ? `<div class="hint">Отменена — в итогах не учитывается.</div>` : ""}
            </div>`;
          }).join("");
        }
      }
      const modal = $("guestHistoryModal");
      if (modal) modal.classList.remove("hidden");
    } catch { showToast("Ошибка загрузки истории", "error"); }
  }

  // Add guest
  async function addGuest() {
    const full_name = $("g_name")?.value?.trim();
    const phone     = $("g_phone")?.value || "";
    const instagram = $("g_ig")?.value || "";
    const msg = $("guestMsg");
    if (msg) msg.textContent = "";
    try {
      const r = await apiSend("/api/guests", "POST", { full_name, phone, instagram });
      showToast("Гость добавлен (ID: " + r.id + ")", "ok");
      if ($("g_name"))  $("g_name").value  = "";
      if ($("g_phone")) $("g_phone").value = "";
      if ($("g_ig"))    $("g_ig").value    = "";
      await loadGuests();
    } catch (e) {
      if (msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  $("btnAddGuest")?.addEventListener("click", addGuest);
  $("btnReloadGuests")?.addEventListener("click", loadGuests);
  $("ghClose")?.addEventListener("click", () => $("guestHistoryModal")?.classList.add("hidden"));
  searchEl?.addEventListener("input", () => { curPage = 1; renderGuests(); });
  clearBtn?.addEventListener("click", () => { searchEl.value = ""; searchEl.focus(); curPage = 1; renderGuests(); });

  await loadGuests();
}

// =================== IMPROVED BOOKINGS PAGE ===================
async function initBookingsPageV2() {
  const listEl = $("bookingsList");
  if (!listEl) return;

  attachPhoneMask($("g_phone"));

  const filterEl   = $("filter");
  const foundEl    = $("bookingsFound");
  const hintEl     = $("bookingsHint");
  const clearBtn   = $("bookingsClear");
  const statusFilt = $("bookingStatusFilter");

  const PAGE_SIZE = 15;
  let allBookings = [];
  let allGuests   = [];
  let curPage     = 1;
  let sortKey     = "check_in";
  let sortDir     = -1;

  async function loadGuestsToSelects() {
    try {
      allGuests = await apiGet("/api/guests");
      const options = `<option value="">— выбрать —</option>` + allGuests.map(g =>
        `<option value="${g.id}">${escapeHtml(g.full_name)}${g.phone ? " • " + escapeHtml(g.phone) : ""}</option>`
      ).join("");
      const sel     = $("guestSelect");
      const selEdit = $("edit_guest");
      if (sel) sel.innerHTML = options;
      if (selEdit) selEdit.innerHTML = options;
    } catch {}
  }

  function badgeBooking(s) {
    const code = String(s || "REQUEST");
    if (code === "CONFIRMED" || code === "COMPLETED") return `<span class="badge ok">${escapeHtml(uiBookingStatus(code))}</span>`;
    if (code === "CANCELLED") return `<span class="badge no">${escapeHtml(uiBookingStatus(code))}</span>`;
    return `<span class="badge wait">${escapeHtml(uiBookingStatus("REQUEST"))}</span>`;
  }
  function badgePay(s) {
    const code = String(s || "UNPAID");
    if (code === "PAID")    return `<span class="badge ok">${escapeHtml(uiPaymentStatus(code))}</span>`;
    if (code === "PARTIAL") return `<span class="badge wait">${escapeHtml(uiPaymentStatus(code))}</span>`;
    return `<span class="badge">${escapeHtml(uiPaymentStatus("UNPAID"))}</span>`;
  }

  function getFiltered() {
    const q = String(filterEl?.value || "").trim();
    const qDigits = digitsOnly(q);
    const stFilter = statusFilt?.value || "";
    return allBookings.filter(b => {
      if (stFilter && b.booking_status !== stFilter) return false;
      if (!q) return true;
      const name  = String(b.full_name || "").toLowerCase();
      const phone = String(b.phone || "").toLowerCase();
      const raw   = q.toLowerCase();
      if (name.includes(raw) || phone.includes(raw)) return true;
      if (qDigits && digitsOnly(phone).includes(qDigits)) return true;
      return false;
    });
  }

  function getSorted(rows) {
    return [...rows].sort((a, b) => {
      let av = a[sortKey] ?? "";
      let bv = b[sortKey] ?? "";
      if (sortKey === "price_total" || sortKey === "prepayment" || sortKey === "guests_count") {
        av = Number(av); bv = Number(bv);
      }
      if (av < bv) return sortDir;
      if (av > bv) return -sortDir;
      return 0;
    });
  }

  function renderBookings() {
    const filtered = getFiltered();
    const sorted   = getSorted(filtered);
    const q        = String(filterEl?.value || "").trim();
    const total    = sorted.length;
    const pages    = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (curPage > pages) curPage = pages;
    const slice = sorted.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

    if (foundEl) foundEl.textContent = String(total);
    if (hintEl)  hintEl.textContent  = !q ? "Введите имя или телефон" : (total ? `${total} найдено` : "Ничего не найдено");
    if (clearBtn) clearBtn.style.display = q ? "inline-flex" : "none";

    if (!total) {
      listEl.innerHTML = `<div class="emptyState"><div class="emptyState__icon">🧾</div><div class="emptyState__title">Броней не найдено</div><div class="emptyState__sub">${q ? "Измените запрос поиска" : "Добавьте первую бронь выше"}</div></div>`;
      renderBookingsPager(pages);
      return;
    }

    function thArrow(key) {
      if (sortKey !== key) return `<span class="sortArrow">↕</span>`;
      return sortDir === -1 ? `<span class="sortArrow">↓</span>` : `<span class="sortArrow">↑</span>`;
    }

    listEl.innerHTML = `
      <div class="tableWrap">
        <table class="dataTable">
          <thead>
            <tr>
              <th data-bsort="id">ID ${thArrow("id")}</th>
              <th data-bsort="full_name">Гость ${thArrow("full_name")}</th>
              <th data-bsort="check_in">Заезд ${thArrow("check_in")}</th>
              <th data-bsort="check_out">Выезд ${thArrow("check_out")}</th>
              <th data-bsort="guests_count" style="text-align:center;">Чел. ${thArrow("guests_count")}</th>
              <th data-bsort="price_total" class="tdRight">Сумма ${thArrow("price_total")}</th>
              <th>Оплата</th>
              <th>Статус</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${slice.map(b => {
              const isCancelled = b.booking_status === "CANCELLED";
              return `
                <tr class="${isCancelled ? "isCancelled" : ""}">
                  <td class="tdMuted">${b.id}</td>
                  <td><b>${highlight(b.full_name, q)}</b><br><span class="tdMuted" style="font-size:12px;">${highlight(b.phone || "—", q)}</span></td>
                  <td class="tdMono">${escapeHtml(b.check_in)}</td>
                  <td class="tdMono">${escapeHtml(b.check_out)}</td>
                  <td style="text-align:center;">${Number(b.guests_count || 1)}</td>
                  <td class="tdRight"><b>${Number(b.price_total || 0).toLocaleString("ru-RU")}</b> ₸<br><span class="tdMuted" style="font-size:11px;">пред: ${Number(b.prepayment || 0).toLocaleString("ru-RU")}</span></td>
                  <td>${badgePay(b.payment_status)}</td>
                  <td>${badgeBooking(b.booking_status)}</td>
                  <td>
                    <div style="display:flex;gap:5px;flex-wrap:wrap;">
                      <button class="tblBtn${isCancelled ? " tblBtn--disabled" : ""}" data-bedit="${b.id}" ${isCancelled ? "disabled" : ""}>✎</button>
                      <button class="tblBtn tblBtn--danger" data-bdel="${b.id}">🗑</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    // Sort
    listEl.querySelectorAll("th[data-bsort]").forEach(th => {
      const key = th.getAttribute("data-bsort");
      if (sortKey === key) th.classList.add(sortDir === -1 ? "sortDesc" : "sortAsc");
      th.addEventListener("click", () => {
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = -1; }
        renderBookings();
      });
    });

    // Edit
    listEl.querySelectorAll("button[data-bedit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-bedit"));
        openEditModal(id);
      });
    });

    // Delete
    listEl.querySelectorAll("button[data-bdel]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-bdel"));
        const b  = allBookings.find(x => Number(x.id) === id);
        if (!confirm(`Удалить бронь #${id} (${b?.full_name || ""})?\nЭто действие необратимо!`)) return;
        try {
          await apiSend("/api/bookings/" + id, "DELETE");
          showToast("Бронь удалена", "ok");
          await loadBookings();
        } catch { showToast("Ошибка удаления", "error"); }
      });
    });

    renderBookingsPager(pages);
  }

  function renderBookingsPager(pages) {
    let pagerEl = $("bookingsPager");
    if (!pagerEl) {
      pagerEl = document.createElement("div");
      pagerEl.id = "bookingsPager";
      pagerEl.className = "pager";
      listEl.parentNode.insertBefore(pagerEl, listEl.nextSibling);
    }
    if (pages <= 1) { pagerEl.innerHTML = ""; return; }
    pagerEl.innerHTML = `
      <button class="pagerBtn" ${curPage === 1 ? "disabled" : ""} data-bpg="${curPage - 1}">‹</button>
      ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
        `<button class="pagerBtn ${p === curPage ? "active" : ""}" data-bpg="${p}">${p}</button>`
      ).join("")}
      <button class="pagerBtn" ${curPage === pages ? "disabled" : ""} data-bpg="${curPage + 1}">›</button>
    `;
    pagerEl.querySelectorAll("button[data-bpg]").forEach(btn => {
      btn.addEventListener("click", () => { curPage = Number(btn.getAttribute("data-bpg")); renderBookings(); });
    });
  }

  async function loadBookings() {
    allBookings = await apiGet("/api/bookings");
    renderBookings();
  }

  // Reuse existing edit modal logic
  function getBookingById(id) { return allBookings.find(x => Number(x.id) === Number(id)); }
  function showModal(show) { const m = $("editModal"); if (m) m.classList.toggle("hidden", !show); }
  function fillEditForm(b) {
    $("edit_id").value = b.id;
    $("edit_guest").value = String(b.guest_id);
    $("edit_in").value = b.check_in;
    $("edit_out").value = b.check_out;
    $("edit_guests").value = b.guests_count;
    $("edit_total").value = b.price_total;
    $("edit_prepay").value = b.prepayment;
    $("edit_pay").value = b.payment_status;
    $("edit_status").value = b.booking_status;
    $("edit_source").value = b.source || "";
    $("edit_notes").value = b.notes || "";
    const em = $("editMsg"); if (em) em.textContent = "";
  }
  async function openEditModal(id) {
    const b = getBookingById(id);
    if (!b || b.booking_status === "CANCELLED") return;
    await loadGuestsToSelects();
    fillEditForm(b);
    showModal(true);
  }
  async function saveEdit() {
    const id = Number($("edit_id")?.value || 0);
    const em = $("editMsg"); if (em) em.textContent = "";
    const body = {
      guest_id: Number($("edit_guest")?.value || 0),
      check_in: $("edit_in")?.value,
      check_out: $("edit_out")?.value,
      guests_count: Number($("edit_guests")?.value || 1),
      price_total: Number($("edit_total")?.value || 0),
      prepayment: Number($("edit_prepay")?.value || 0),
      payment_status: $("edit_pay")?.value || "UNPAID",
      booking_status: $("edit_status")?.value || "REQUEST",
      source: $("edit_source")?.value || "",
      notes: $("edit_notes")?.value || "",
    };
    try {
      await apiSend("/api/bookings/" + id, "PUT", body);
      showToast("Бронь обновлена ✅", "ok");
      await loadBookings();
      showModal(false);
    } catch (e) {
      if (em) em.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }
  async function cancelBooking() {
    const id = Number($("edit_id")?.value || 0);
    const em = $("editMsg"); if (em) em.textContent = "";
    if (!confirm("Отменить бронь? Сумма будет обнулена.")) return;
    try {
      await apiSend("/api/bookings/" + id + "/cancel", "PATCH", {});
      showToast("Бронь отменена", "warn");
      await loadBookings();
      showModal(false);
    } catch (e) {
      if (em) em.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  async function addGuest() {
    const full_name = $("g_name")?.value?.trim();
    const phone = $("g_phone")?.value || "";
    const instagram = $("g_ig")?.value || "";
    const msg = $("guestMsg"); if (msg) msg.textContent = "";
    try {
      const r = await apiSend("/api/guests", "POST", { full_name, phone, instagram });
      if (msg) msg.textContent = "✅ Гость добавлен (id: " + r.id + ")";
      $("g_name").value = ""; $("g_phone").value = ""; $("g_ig").value = "";
      await loadGuestsToSelects();
    } catch (e) {
      if (msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  async function addBooking() {
    const msg = $("bookingMsg"); if (msg) msg.textContent = "";
    const body = {
      guest_id: Number($("guestSelect")?.value || 0),
      check_in: $("check_in")?.value,
      check_out: $("check_out")?.value,
      guests_count: Number($("guests_count")?.value || 1),
      price_total: Number($("price_total")?.value || 0),
      prepayment: Number($("prepayment")?.value || 0),
      booking_status: $("booking_status")?.value || "REQUEST",
      payment_status: $("payment_status")?.value || "UNPAID",
      source: $("source")?.value || "",
      notes: $("notes")?.value || "",
    };
    try {
      await apiSend("/api/bookings", "POST", body);
      showToast("Бронь сохранена ✅", "ok");
      if (msg) msg.textContent = "";
      await loadBookings();
    } catch (e) {
      if (msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    }
  }

  // Excel export
  $("btnExportBookings")?.addEventListener("click", () => {
    const stFilt = statusFilt?.value || "";
    const params = new URLSearchParams();
    if (stFilt) params.set("status", stFilt);
    const a = document.createElement("a");
    a.href = `/api/export/bookings.xlsx?${params.toString()}`;
    a.click();
    showToast("Скачивается список броней…", "ok");
  });

  $("btnAddGuest")?.addEventListener("click", addGuest);
  $("btnAddBooking")?.addEventListener("click", addBooking);
  $("btnReload")?.addEventListener("click", loadBookings);
  $("editClose")?.addEventListener("click", () => showModal(false));
  $("btnSaveEdit")?.addEventListener("click", saveEdit);
  $("btnCancelBooking")?.addEventListener("click", cancelBooking);
  filterEl?.addEventListener("input", () => { curPage = 1; renderBookings(); });
  statusFilt?.addEventListener("change", () => { curPage = 1; renderBookings(); });
  clearBtn?.addEventListener("click", () => { filterEl.value = ""; filterEl.focus(); curPage = 1; renderBookings(); });

  await loadGuestsToSelects();
  await loadBookings();
}
