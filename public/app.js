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

  const modal = $("bookingModal");
  const modalBody = $("modalBody");
  const modalTitle = $("modalTitle");

  function showModal(show){
    if(!modal) return;
    modal.classList.toggle("hidden", !show);
  }
  $("modalClose")?.addEventListener("click", ()=>showModal(false));

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

  let calFilter = "all"; // "all" | "active" | "request" | "cancelled"

  function bookingActiveForCalendar(b){
    const st = String(b.booking_status || "");
    if(calFilter === "all")       return st !== "CANCELLED";
    if(calFilter === "active")    return st === "CONFIRMED" || st === "COMPLETED";
    if(calFilter === "request")   return st === "REQUEST";
    if(calFilter === "cancelled") return st === "CANCELLED";
    return false;
  }

  function bookingsByDay(dateStr){
    return bookings.filter(b=>{
      if(!bookingActiveForCalendar(b)) return false;
      const inStr  = dateOnly(b.check_in);
      const outStr = dateOnly(b.check_out);
      if(!inStr || !outStr) return false;
      return dateStr >= inStr && dateStr < outStr;
    });
  }

  function addDaysCal(dateStr, n){
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function render(){
    const first = new Date(curYear, curMonth, 1);
    const last  = new Date(curYear, curMonth + 1, 0);
    let startOffset = first.getDay() - 1;
    if(startOffset < 0) startOffset = 6;

    const todayStr  = ymd(new Date());
    const totalDays = last.getDate();

    // Build week arrays
    const allWeeks = [];
    let wk = [];
    for(let i = 0; i < startOffset; i++) wk.push(null);
    for(let day = 1; day <= totalDays; day++){
      wk.push(day);
      if(wk.length === 7){ allWeeks.push(wk); wk = []; }
    }
    if(wk.length){ while(wk.length < 7) wk.push(null); allWeeks.push(wk); }

    const visible = bookings.filter(b => bookingActiveForCalendar(b)).sort((a,b)=>{
      const ai = dateOnly(a.check_in), bi = dateOnly(b.check_in);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });

    let html = "";
    allWeeks.forEach((week, weekIdx) => {
      const slotDates = week.map(d => d ? ymd(new Date(curYear, curMonth, d)) : null);

      html += `<div class="calWeek"><div class="calDayRow">`;

      // Build day cells with bookings INSIDE
      week.forEach((day, dayIdx) => {
        if(!day){ html += `<div class="calDay calDay--empty"></div>`; return; }

        const ds = slotDates[dayIdx];
        const isToday = ds === todayStr;
        const dayBkgs = bookingsByDay(ds);
        const occ = dayBkgs.length > 0;

        html += `<div class="calDay${isToday?" today":""}${occ?" occupied":""}" data-date="${ds}">`;
        html += `<div class="n">${day}</div>`;

        // Render bookings for this day inside the cell
        if(dayBkgs.length){
          dayBkgs.forEach((b, bkgIdx) => {
            const inStr = dateOnly(b.check_in);
            const outStr = dateOnly(b.check_out);
            const isFirstDay = ds === inStr;
            const isLastDay = addDaysCal(ds, 1) === outStr;
            const st = String(b.booking_status || "");

            let cls = "calBooking";
            if(st === "CONFIRMED") cls += " calBooking--confirmed";
            else if(st === "COMPLETED") cls += " calBooking--completed";
            else if(st === "REQUEST") cls += " calBooking--request";
            else if(st === "CANCELLED") cls += " calBooking--cancelled";

            if(isFirstDay && isLastDay) cls += " calBooking--both";
            else if(isFirstDay) cls += " calBooking--start";
            else if(isLastDay) cls += " calBooking--end";
            else cls += " calBooking--middle";

            // For 1-day bookings show initials, for multi-day show first name
            const fullName = b.full_name || "";
            let displayName;
            if(isFirstDay && isLastDay){
              // 1-day booking: show initials
              displayName = fullName.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2) || "?";
            } else {
              // Multi-day booking: show first name
              displayName = fullName.split(" ")[0] || "?";
            }

            html += `<div class="${cls}" data-bid="${b.id}" data-rdate="${ds}">`;
            if(isFirstDay) html += `<span class="calBooking__arrow">→</span>`;
            html += `<span class="calBooking__name">${escapeHtml(displayName)}</span>`;
            if(isLastDay) html += `<span class="calBooking__arrow">←</span>`;
            html += `</div>`;
          });
        }

        html += `</div>`;
      });

      html += `</div></div>`;
    });

    grid.innerHTML = html;

    grid.querySelectorAll(".calDay[data-date]").forEach(cell=>{
      cell.addEventListener("click", ()=> openDayModal(cell.getAttribute("data-date")));
    });
    grid.querySelectorAll(".calBooking[data-rdate]").forEach(el=>{
      el.addEventListener("click", e=>{ e.stopPropagation(); openDayModal(el.getAttribute("data-rdate")); });
    });

    const labels = {all:"Все брони (кроме отменённых)", active:"Только активные (подтв. + завершено)", request:"Только запросы", cancelled:"Только отменённые"};
    if(hint) hint.textContent = labels[calFilter] || "";
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
      modalBody.innerHTML = `
        <div class="emptyState" style="padding:24px 16px;">
          <div class="emptyState__icon">🏠</div>
          <div class="emptyState__title">Свободно</div>
          <div class="emptyState__sub">На ${escapeHtml(ds)} броней нет</div>
          <a href="/bookings.html?date=${encodeURIComponent(ds)}" class="btnPrimary"
             style="margin-top:16px;display:inline-flex;text-decoration:none;font-size:14px;padding:10px 20px;border-radius:12px;">
            + Создать бронь
          </a>
        </div>
      `;
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

  // Filter tab buttons
  document.querySelectorAll(".calFilterBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      calFilter = btn.getAttribute("data-calfilter") || "all";
      document.querySelectorAll(".calFilterBtn").forEach(b => b.classList.toggle("calFilterBtn--active", b === btn));
      render();
    });
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
    try { await initBookingsWizard(); } catch (e) { console.error("wizard init:", e); }
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

  // Finance tabs (finance.html only)
  try { initFinanceTabs(); } catch (e) {}

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

  // Populate year selector
  const anYearEl = $("anYear");
  if (anYearEl) {
    const curYear = new Date().getFullYear();
    for (let y = curYear; y >= 2022; y--) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      anYearEl.appendChild(opt);
    }
    anYearEl.value = String(curYear);
  }

  // Set default "month" preset dates
  const _now = new Date();
  const _pad = n => String(n).padStart(2, "0");
  const _df = $("anDateFrom");
  const _dt = $("anDateTo");
  if (_df && !_df.value) _df.value = `${_now.getFullYear()}-${_pad(_now.getMonth()+1)}-01`;
  if (_dt && !_dt.value) _dt.value = `${_now.getFullYear()}-${_pad(_now.getMonth()+1)}-${_pad(_now.getDate())}`;

  function fmt(v) { return Number(v || 0).toLocaleString("ru-RU"); }

  function buildQuery() {
    const df = $("anDateFrom")?.value || "";
    const dt = $("anDateTo")?.value || "";
    const st = $("anStatus")?.value || "";
    const year = $("anYear")?.value || String(new Date().getFullYear());
    const params = new URLSearchParams();
    if (df) params.set("date_from", df);
    if (dt) params.set("date_to", dt);
    if (st) params.set("status", st);
    params.set("year", year);
    return params.toString();
  }

  // Period preset handlers
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function setPreset(preset) {
    const today = new Date();
    const df = $("anDateFrom");
    const dt = $("anDateTo");
    if (!df || !dt) return;
    const pad2 = n => String(n).padStart(2, "0");
    const fmt2 = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;

    if (preset === "today") {
      const t = todayStr();
      df.value = t; dt.value = t;
    } else if (preset === "week") {
      const wDay = today.getDay();
      const diff = wDay === 0 ? -6 : 1 - wDay;
      const start = new Date(today); start.setDate(today.getDate() + diff);
      df.value = fmt2(start); dt.value = todayStr();
    } else if (preset === "month") {
      df.value = `${today.getFullYear()}-${pad2(today.getMonth()+1)}-01`;
      dt.value = todayStr();
    } else if (preset === "year") {
      df.value = `${today.getFullYear()}-01-01`;
      dt.value = todayStr();
    } else if (preset === "all") {
      df.value = ""; dt.value = "";
    } else if (preset === "custom") {
      // just reveal the fields, don't change values
    }

    // Show/hide custom date range
    const customRange = $("anCustomRange");
    if (customRange) customRange.style.display = preset === "custom" ? "flex" : "none";

    // Mark active pill
    document.querySelectorAll(".an-pill").forEach(b => b.classList.remove("an-pill--active"));
    const activeBtn = document.querySelector(`.an-pill[data-preset="${preset}"]`);
    if (activeBtn) activeBtn.classList.add("an-pill--active");

    if (preset !== "custom") load();
  }

  document.querySelectorAll(".an-pill").forEach(btn => {
    btn.addEventListener("click", () => setPreset(btn.dataset.preset));
  });

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
      const chartYear = $("anYear")?.value || new Date().getFullYear();
      if (chartRangeHint) chartRangeHint.textContent = `По месяцам — ${chartYear}`;
    }
  }

  function renderYearlyTable(monthly, year) {
    const el = $("yearlyTable");
    const yearLabel = $("yearlyTableYear");
    if (yearLabel) yearLabel.textContent = year || $("anYear")?.value || new Date().getFullYear();
    if (!el) return;

    const hasData = monthly && monthly.some(r => Number(r.revenue) > 0 || Number(r.expenses) > 0);
    if (!monthly || !monthly.length || !hasData) {
      el.innerHTML = `<div class="emptyState" style="padding:20px 0;"><div class="emptyState__sub">Нет данных за выбранный год</div></div>`;
      return;
    }

    const monthNames = ["", "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
    let totalRev = 0, totalExp = 0, totalNet = 0;
    const rows = monthly.map(r => {
      const rev = Number(r.revenue || 0);
      const exp = Number(r.expenses || 0);
      const net = Number(r.net || 0);
      totalRev += rev; totalExp += exp; totalNet += net;
      const netCls = net >= 0 ? "an-ytable__pos" : "an-ytable__neg";
      const isEmpty = rev === 0 && exp === 0;
      return `<tr class="${isEmpty ? 'an-ytable__empty-row' : ''}">
        <td>${monthNames[Number(r.month)] || r.month}</td>
        <td>${rev > 0 ? fmt(rev) : '—'}</td>
        <td>${exp > 0 ? fmt(exp) : '—'}</td>
        <td class="${netCls}" style="font-weight:700;">${isEmpty ? '—' : fmt(net)}</td>
      </tr>`;
    }).join("");

    const netTotCls = totalNet >= 0 ? "an-ytable__pos" : "an-ytable__neg";
    el.innerHTML = `<div class="an-ytable-wrap">
      <table class="an-ytable">
        <thead>
          <tr>
            <th>Месяц</th>
            <th>Выручка (₸)</th>
            <th>Расходы (₸)</th>
            <th>Прибыль (₸)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td>ИТОГО</td>
            <td>${fmt(totalRev)}</td>
            <td>${fmt(totalExp)}</td>
            <td class="${netTotCls}">${fmt(totalNet)}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
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
        kpNet.className = "an-kpi-card__value" + (net < 0 ? " neg" : "");
      }

      renderChart(data);
      renderStatusBreakdown(data.status_breakdown || {});
      renderYearlyTable(data.chart.monthly, $("anYear")?.value);
    } catch (e) {
      showToast("Ошибка загрузки аналитики: " + (e?.message || "нет данных"), "error");
      const z = "—";
      if (kqToday)    kqToday.textContent    = z;
      if (kqWeek)     kqWeek.textContent     = z;
      if (kqMonth)    kqMonth.textContent    = z;
      if (kqAll)      kqAll.textContent      = z;
      if (kpRevenue)  kpRevenue.textContent  = z;
      if (kpExpenses) kpExpenses.textContent = z;
      if (kpNet)      kpNet.textContent      = z;
      if (kpCount)    kpCount.textContent    = z;
      if (kpAvg)      kpAvg.textContent      = z;
      if (canvas)     canvas.style.display   = "none";
      if (chartEmpty) chartEmpty.style.display = "flex";
    }
  }

  // Chart toggle
  $("btnChartDaily")?.addEventListener("click", () => {
    chartMode = "daily";
    $("btnChartDaily")?.classList.add("an-toggle--active");
    $("btnChartMonthly")?.classList.remove("an-toggle--active");
    if (lastData) renderChart(lastData);
  });
  $("btnChartMonthly")?.addEventListener("click", () => {
    chartMode = "monthly";
    $("btnChartMonthly")?.classList.add("an-toggle--active");
    $("btnChartDaily")?.classList.remove("an-toggle--active");
    if (lastData) renderChart(lastData);
  });

  $("btnApplyFilter")?.addEventListener("click", load);
  $("btnResetFilter")?.addEventListener("click", () => {
    const df = $("anDateFrom"); if (df) df.value = "";
    const dt = $("anDateTo");   if (dt) dt.value = "";
    const st = $("anStatus");   if (st) st.value = "";
    document.querySelectorAll(".an-pill").forEach(b => b.classList.remove("an-pill--active"));
    const m = document.querySelector('.an-pill[data-preset="month"]');
    if (m) { m.classList.add("an-pill--active"); setPreset("month"); } else load();
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
    const year = $("anYear")?.value || String(new Date().getFullYear());
    const params = new URLSearchParams();
    if (df) params.set("date_from", df);
    if (dt) params.set("date_to", dt);
    params.set("year", year);
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

  // "Месяц" is pre-marked active in HTML; custom range hidden by default — nothing extra needed

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

  // Refresh list when wizard creates a booking
  window.addEventListener("booking:created", loadBookings);
}

// =================== BOOKING WIZARD ===================
async function initBookingsWizard() {
  if(!$("bookingWizard")) return;

  let currentStep = 1;
  let selectedGuestId = null;
  let selectedGuestName = "";
  let creatingNewGuest = false;
  let guestCache = [];

  attachPhoneMask($("wg_phone"));

  async function loadGuestCache() {
    try { guestCache = await apiGet("/api/guests"); } catch {}
  }

  function updateSteps() {
    document.querySelectorAll(".wizStep").forEach(el => {
      const s = Number(el.getAttribute("data-wstep"));
      el.classList.toggle("wizStep--active", s === currentStep);
      el.classList.toggle("wizStep--done", s < currentStep);
      const numEl = el.querySelector(".wizStep__num");
      if(numEl) numEl.textContent = s < currentStep ? "✓" : String(s);
    });
  }

  function showPanel(step) {
    for(let i = 1; i <= 4; i++){
      const p = $("wP" + i);
      if(p) p.hidden = (i !== step);
    }
    const prev = $("wBtnPrev");
    const next = $("wBtnNext");
    const nav  = $("wizNavBar");
    if(prev) prev.style.display = step > 1 ? "" : "none";
    if(next) next.style.display = step < 4 ? "" : "none";
    if(nav)  nav.style.display  = step === 4 ? "none" : "";
    updateSteps();
  }

  function fmt(v) { return Number(v||0).toLocaleString("ru-RU"); }

  function updateSummary() {
    const ci = $("w_check_in")?.value || "";
    const co = $("w_check_out")?.value || "";
    const total = Number($("w_price_total")?.value || 0);
    const pre   = Number($("w_prepayment")?.value || 0);
    const guests = Number($("w_guests_count")?.value || 1);
    let nights = 0;
    if(ci && co){ nights = Math.round((new Date(co) - new Date(ci)) / 86400000); }
    const remaining = Math.max(0, total - pre);

    const s = id => $(id);
    if(s("ws_guest"))  s("ws_guest").textContent  = selectedGuestName || "—";
    if(s("ws_in"))     s("ws_in").textContent     = ci || "—";
    if(s("ws_out"))    s("ws_out").textContent    = co || "—";
    if(s("ws_nights")) s("ws_nights").textContent = nights > 0 ? String(nights) : "—";
    if(s("ws_guests")) s("ws_guests").textContent = String(guests);
    if(s("ws_total"))  s("ws_total").textContent  = fmt(total) + " ₸";
    if(s("ws_pre"))    s("ws_pre").textContent    = fmt(pre) + " ₸";
    if(s("ws_debt"))   s("ws_debt").textContent   = fmt(remaining) + " ₸";
    const debtRow = s("wsDebtRow");
    if(debtRow) debtRow.classList.toggle("wizSumRow--debt", remaining > 0);
  }

  function renderGuestResults(q) {
    const listEl = $("wGuestResults");
    if(!listEl) return;
    const lq = q.toLowerCase();
    const results = !q ? guestCache.slice(0, 12) : guestCache.filter(g => {
      return (g.full_name||"").toLowerCase().includes(lq) ||
             (g.phone||"").toLowerCase().includes(lq) ||
             digitsOnly(g.phone).includes(digitsOnly(q));
    });
    if(!results.length){
      listEl.innerHTML = `<div class="hint" style="padding:8px;">Ничего не найдено — создайте нового гостя</div>`;
      return;
    }
    listEl.innerHTML = results.map(g => `
      <div class="wizGuestItem${selectedGuestId===g.id?" wizGuestItem--selected":""}" data-gid="${g.id}" data-gname="${escapeHtml(g.full_name||"")}">
        <b>${highlight(g.full_name||"", q)}</b>
        <span class="small">${highlight(g.phone||"—", q)}</span>
      </div>
    `).join("");
    listEl.querySelectorAll(".wizGuestItem").forEach(item => {
      item.addEventListener("click", () => {
        selectedGuestId   = Number(item.getAttribute("data-gid"));
        selectedGuestName = item.getAttribute("data-gname");
        creatingNewGuest  = false;
        const sel = $("wGuestSelected");
        if(sel){ sel.textContent = "✓ Выбран: " + selectedGuestName; sel.style.display = ""; }
        renderGuestResults($("wGuestQ")?.value || "");
        updateSummary();
      });
    });
  }

  function nightsText(n) {
    if(n <= 0) return "⚠ Дата выезда раньше заезда";
    if(n === 1) return "1 ночь";
    if(n < 5)   return n + " ночи";
    return n + " ночей";
  }

  function updateNights() {
    const ci = $("w_check_in")?.value;
    const co = $("w_check_out")?.value;
    const el = $("wNightCount");
    if(!el) return;
    if(ci && co){
      const n = Math.round((new Date(co) - new Date(ci)) / 86400000);
      el.textContent = nightsText(n);
      el.style.color = n > 0 ? "var(--brand)" : "var(--danger)";
    } else {
      el.textContent = "";
    }
    updateSummary();
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function addD(s, n) {
    const d = new Date(s + "T00:00:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function validateStep(step) {
    if(step === 1){
      if(creatingNewGuest){
        if(!$("wg_name")?.value?.trim()){ showToast("Введите ФИО гостя", "warn"); return false; }
      } else {
        if(!selectedGuestId){ showToast("Выберите гостя из списка или создайте нового", "warn"); return false; }
      }
    }
    if(step === 2){
      const ci = $("w_check_in")?.value, co = $("w_check_out")?.value;
      if(!ci || !co){ showToast("Укажите даты заезда и выезда", "warn"); return false; }
      if(new Date(ci) >= new Date(co)){ showToast("Дата выезда должна быть позже даты заезда", "warn"); return false; }
    }
    return true;
  }

  async function goNext() {
    if(!validateStep(currentStep)) return;
    if(currentStep === 1 && creatingNewGuest){
      try {
        const r = await apiSend("/api/guests", "POST", {
          full_name: $("wg_name")?.value?.trim(),
          phone: $("wg_phone")?.value || "",
          instagram: $("wg_ig")?.value || "",
        });
        selectedGuestId   = r.id;
        selectedGuestName = $("wg_name")?.value?.trim() || "";
        showToast("Гость создан (ID: " + r.id + ")", "ok");
        await loadGuestCache();
      } catch(e) {
        showToast("Ошибка создания гостя: " + (e?.data?.error || e.message), "error");
        return;
      }
    }
    currentStep++;
    showPanel(currentStep);
    updateSummary();
  }

  function resetWizard() {
    currentStep = 1;
    selectedGuestId = null;
    selectedGuestName = "";
    creatingNewGuest = false;
    // Clear fields
    ["wGuestQ","wg_name","wg_phone","wg_ig","w_source","w_notes"].forEach(id => {
      const el = $(id); if(el) el.value = "";
    });
    if($("w_check_in"))  $("w_check_in").value  = "";
    if($("w_check_out")) $("w_check_out").value  = "";
    if($("w_guests_count")) $("w_guests_count").value = "2";
    if($("w_price_total"))  $("w_price_total").value  = "0";
    if($("w_prepayment"))   $("w_prepayment").value   = "50000";
    if($("w_payment_status")) $("w_payment_status").value = "UNPAID";
    if($("w_booking_status")) $("w_booking_status").value = "REQUEST";
    const wGSel = $("wGuestSelected"); if(wGSel){ wGSel.textContent=""; wGSel.style.display="none"; }
    const wMsg = $("wMsg"); if(wMsg) wMsg.textContent = "";
    if($("wNightCount")) $("wNightCount").textContent = "";
    document.querySelectorAll(".wizSourceBtn").forEach(b => b.classList.remove("wizSourceBtn--active"));
    // Switch back to search mode
    creatingNewGuest = false;
    const gs = $("wGuestSearch"); if(gs) gs.hidden = false;
    const gc = $("wGuestCreate"); if(gc) gc.hidden = true;
    $("wModeSearch")?.classList.add("wizModeBtn--active");
    $("wModeNew")?.classList.remove("wizModeBtn--active");
    showPanel(1);
    renderGuestResults("");
    updateSummary();
  }

  async function submitBooking() {
    const msg = $("wMsg"); if(msg) msg.textContent = "";
    const btn = $("wBtnSubmit"); if(btn) btn.disabled = true;
    try {
      await apiSend("/api/bookings", "POST", {
        guest_id: selectedGuestId,
        check_in: $("w_check_in")?.value,
        check_out: $("w_check_out")?.value,
        guests_count: Number($("w_guests_count")?.value || 1),
        price_total: Number($("w_price_total")?.value || 0),
        prepayment:  Number($("w_prepayment")?.value || 0),
        booking_status: $("w_booking_status")?.value || "REQUEST",
        payment_status: $("w_payment_status")?.value || "UNPAID",
        source: $("w_source")?.value || "",
        notes:  $("w_notes")?.value || "",
      });
      showToast("Бронь создана! ✅", "ok");
      window.dispatchEvent(new CustomEvent("booking:created"));
      resetWizard();
    } catch(e) {
      if(msg) msg.textContent = "❌ " + (e?.data?.error || e.message);
    } finally {
      if(btn) btn.disabled = false;
    }
  }

  // Guest mode toggle
  $("wModeSearch")?.addEventListener("click", () => {
    creatingNewGuest = false;
    const gs = $("wGuestSearch"); if(gs) gs.hidden = false;
    const gc = $("wGuestCreate"); if(gc) gc.hidden = true;
    $("wModeSearch")?.classList.add("wizModeBtn--active");
    $("wModeNew")?.classList.remove("wizModeBtn--active");
  });
  $("wModeNew")?.addEventListener("click", () => {
    creatingNewGuest = true;
    const gs = $("wGuestSearch"); if(gs) gs.hidden = true;
    const gc = $("wGuestCreate"); if(gc) gc.hidden = false;
    selectedGuestId = null; selectedGuestName = "";
    $("wModeNew")?.classList.add("wizModeBtn--active");
    $("wModeSearch")?.classList.remove("wizModeBtn--active");
    updateSummary();
  });

  $("wGuestQ")?.addEventListener("input", () => renderGuestResults($("wGuestQ").value));
  $("wBtnNext")?.addEventListener("click", goNext);
  $("wBtnPrev")?.addEventListener("click", () => { currentStep--; showPanel(currentStep); updateSummary(); });
  $("wBtnSubmit")?.addEventListener("click", submitBooking);

  $("w_check_in")?.addEventListener("change", updateNights);
  $("w_check_out")?.addEventListener("change", updateNights);
  $("w_price_total")?.addEventListener("input", updateSummary);
  $("w_prepayment")?.addEventListener("input", updateSummary);
  $("w_guests_count")?.addEventListener("input", updateSummary);

  // Quick date actions
  $("wQToday")?.addEventListener("click", () => {
    const t = todayISO();
    if($("w_check_in"))  $("w_check_in").value  = t;
    if($("w_check_out")) $("w_check_out").value = addD(t, 1);
    updateNights();
  });
  $("wQTomorrow")?.addEventListener("click", () => {
    const t = addD(todayISO(), 1);
    if($("w_check_in"))  $("w_check_in").value  = t;
    if($("w_check_out")) $("w_check_out").value = addD(t, 1);
    updateNights();
  });
  $("wQWeekend")?.addEventListener("click", () => {
    const d = new Date();
    const daysToSat = (6 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysToSat);
    const sat = d.toISOString().slice(0, 10);
    if($("w_check_in"))  $("w_check_in").value  = sat;
    if($("w_check_out")) $("w_check_out").value = addD(sat, 2);
    updateNights();
  });

  // Source buttons
  document.querySelectorAll(".wizSourceBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const src = btn.getAttribute("data-src");
      const inp = $("w_source"); if(inp) inp.value = src;
      document.querySelectorAll(".wizSourceBtn").forEach(b => b.classList.remove("wizSourceBtn--active"));
      btn.classList.add("wizSourceBtn--active");
    });
  });

  // Pre-fill date from calendar link (?date=YYYY-MM-DD) and jump to step 2
  const urlDate = new URLSearchParams(location.search).get("date");
  if(urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)){
    if($("w_check_in"))  $("w_check_in").value  = urlDate;
    if($("w_check_out")) $("w_check_out").value = addD(urlDate, 1);
    updateNights();
  }

  await loadGuestCache();
  showPanel(1);
  renderGuestResults("");
  updateSummary();
}

// =================== FINANCE PAGE TABS ===================
function initFinanceTabs() {
  const tabs = document.querySelectorAll(".finTab");
  if (!tabs.length) return;

  function switchTab(name) {
    tabs.forEach(t => t.classList.toggle("finTab--active", t.dataset.tab === name));
    document.querySelectorAll(".finTabContent").forEach(c => {
      c.style.display = (c.id === "tab-" + name) ? "" : "none";
    });
    if (name === "summary") loadSummaryTab();
  }

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      switchTab(name);
      history.replaceState(null, "", "#" + name);
    });
  });

  // Activate tab from URL hash (e.g. /finance.html#expenses)
  const hash = location.hash.slice(1);
  if (hash && document.getElementById("tab-" + hash)) {
    switchTab(hash);
  }
}

// =================== FINANCE SUMMARY TAB ===================
let _summaryLoaded = false;
async function loadSummaryTab() {
  if (_summaryLoaded) return;
  _summaryLoaded = true;

  const fmt = v => Number(v || 0).toLocaleString("ru-RU");
  const year = new Date().getFullYear();
  const sumYearEl = $("sumYear");
  if (sumYearEl) sumYearEl.textContent = String(year);

  try {
    const [statsAll, monthly] = await Promise.all([
      apiGet("/api/stats"),
      apiGet("/api/profit-by-month?year=" + year),
    ]);

    const sumRevAll   = $("sumRevAll");
    const sumExpAll   = $("sumExpAll");
    const sumNetAll   = $("sumNetAll");
    const sumBookCount = $("sumBookCount");

    if (sumRevAll) sumRevAll.textContent = fmt(statsAll.revenue) + " ₸";
    if (sumExpAll) sumExpAll.textContent = fmt(statsAll.expenses) + " ₸";
    if (sumNetAll) {
      const net = Number(statsAll.net || 0);
      sumNetAll.textContent = fmt(net) + " ₸";
      sumNetAll.className = "kpiCard__value " + (net >= 0 ? "kpiCard__value--green" : "kpiCard__value--red");
    }

    // Booking count from analytics
    try {
      const anData = await apiGet("/api/analytics");
      if (sumBookCount) sumBookCount.textContent = String(anData.kpi?.bookings_count || 0);
    } catch {
      if (sumBookCount) sumBookCount.textContent = "—";
    }

    // Monthly table
    const monthNames = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
    const months = monthly.months || [];
    const tableEl = $("summaryTable");
    if (!tableEl) return;

    const totalRev = months.reduce((s, m) => s + Number(m.revenue || 0), 0);
    const totalExp = months.reduce((s, m) => s + Number(m.expenses || 0), 0);
    const totalNet = months.reduce((s, m) => s + Number(m.net || 0), 0);

    tableEl.innerHTML = `
      <div class="tableWrap">
        <table class="dataTable">
          <thead>
            <tr>
              <th>Месяц</th>
              <th class="tdRight">Выручка (₸)</th>
              <th class="tdRight">Расходы (₸)</th>
              <th class="tdRight">Прибыль (₸)</th>
            </tr>
          </thead>
          <tbody>
            ${months.map((m, i) => {
              const net = Number(m.net || 0);
              const hasData = m.revenue > 0 || m.expenses > 0;
              return `<tr style="${!hasData ? "opacity:.45;" : ""}">
                <td>${monthNames[i] || m.month}</td>
                <td class="tdRight">${hasData ? fmt(m.revenue) : "—"}</td>
                <td class="tdRight">${hasData ? fmt(m.expenses) : "—"}</td>
                <td class="tdRight ${net >= 0 ? "pos" : "neg"}">${hasData ? fmt(net) : "—"}</td>
              </tr>`;
            }).join("")}
          </tbody>
          <tfoot>
            <tr style="font-weight:900;background:#f8fafc;border-top:2px solid var(--border);">
              <td><b>Итого</b></td>
              <td class="tdRight"><b>${fmt(totalRev)}</b></td>
              <td class="tdRight"><b>${fmt(totalExp)}</b></td>
              <td class="tdRight ${totalNet >= 0 ? "pos" : "neg"}"><b>${fmt(totalNet)}</b></td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  } catch (e) {
    showToast("Ошибка загрузки итогов: " + (e?.message || ""), "error");
    ["sumRevAll","sumExpAll","sumNetAll","sumBookCount"].forEach(id => {
      const el = $(id);
      if (el) el.textContent = "—";
    });
    const tableEl = $("summaryTable");
    if (tableEl) tableEl.innerHTML = `<div class="emptyState"><div class="emptyState__icon">⚠️</div><div class="emptyState__sub">Не удалось загрузить данные</div></div>`;
  }
}
