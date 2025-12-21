/* public/app.js */
/* Non-breaking: всё обёрнуто проверками, если страницы/элемента нет — просто пропускаем */
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

/* Активная вкладка nav */
function setActiveNav(){
  const path = location.pathname;
  let key = "";
  if(path.includes("bookings")) key = "bookings";
  else if(path.includes("calendar")) key = "calendar";
  else if(path.includes("finance")) key = "finance";
  else if(path.includes("expenses")) key = "expenses";
  else if(path.includes("guests")) key = "guests";

  document.querySelectorAll(".navItem[data-nav]").forEach(a=>{
    if(a.getAttribute("data-nav") === key) a.classList.add("active");
    else a.classList.remove("active");
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

/* ------------ BOOKINGS PAGE ------------ */
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

/* ------------ GUESTS PAGE ------------ */
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

/* ------------ CALENDAR PAGE ------------ */
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
    if (!bookingActiveForCalendar(b)) return false;

    const checkIn  = new Date(b.check_in  + "T00:00:00");
    const checkOut = new Date(b.check_out + "T00:00:00");

    // ✅ день занят, если:
    // checkIn <= day < checkOut
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
            return `${nm} • ${stRu} • ${b.check_in}→${b.check_out}`;
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

    if(modalBody){
      if(!dayBookings.length){
        modalBody.innerHTML = `<div class="notice">На этот день броней нет ✅</div>`;
      }else{
        modalBody.innerHTML = dayBookings.map(b=>{
          const st = String(b.booking_status || "");
          const stBadge = (st==="CONFIRMED"||st==="COMPLETED") ? "ok" : "wait";
          return `
            <div class="card" style="margin-bottom:10px;">
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                <b>${escapeHtml(b.full_name || "")}</b>
                <span class="badge ${stBadge}">${escapeHtml(uiBookingStatus(st))}</span>
              </div>
              <div class="small">${escapeHtml(b.check_in)} → ${escapeHtml(b.check_out)} • гостей: <b>${Number(b.guests_count||1)}</b></div>
              <div class="small">Сумма: <b>${Number(b.price_total||0).toLocaleString("ru-RU")}</b> ₸</div>
            </div>
          `;
        }).join("");
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

/* ------------ FINANCE PAGE ------------ */
function drawBarChart(canvas, labels, values){
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0,0,W,H);

  const padL = 46, padR = 12, padT = 12, padB = 34;
  const w = W - padL - padR;
  const h = H - padT - padB;

  const maxV = Math.max(1, ...values);
  const barW = w / values.length;

  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + h);
  ctx.lineTo(padL + w, padT + h);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.stroke();

  for(let i=0;i<values.length;i++){
    const v = values[i];
    const bh = (v / maxV) * (h - 8);
    const x = padL + i * barW + 6;
    const y = padT + h - bh;

    ctx.fillStyle = "rgba(59,127,106,.75)";
    ctx.fillRect(x, y, Math.max(2, barW - 12), bh);

    ctx.fillStyle = "#64748b";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(labels[i], x + (barW-12)/2, padT + h + 18);
  }
}

async function initFinancePage(){
  const yearPick = $("yearPick");
  const monthPick = $("monthPick");
  const btn = $("btnLoadStats");
  if(!yearPick || !monthPick || !btn) return;

  const allTime = $("allTime");
  const revEl = $("rev");
  const expEl = $("exp");
  const netEl = $("net");
  const msgEl = $("statsMsg");

  const metricSel = $("chartMetric");
  const yearTotal = $("yearTotal");
  const yearAvg = $("yearAvg");
  const chart = $("revChart");

  function fillYearMonth(){
    const now = new Date();
    const y = now.getFullYear();
    yearPick.innerHTML = Array.from({length: 6}, (_,i)=> y - 3 + i)
      .map(v=>`<option value="${v}">${v}</option>`).join("");
    yearPick.value = String(y);

    const monthsRu = ["01 — Январь","02 — Февраль","03 — Март","04 — Апрель","05 — Май","06 — Июнь","07 — Июль","08 — Август","09 — Сентябрь","10 — Октябрь","11 — Ноябрь","12 — Декабрь"];
    monthPick.innerHTML = `<option value="">— не выбирать —</option>` + monthsRu.map((t,i)=>{
      const mm = String(i+1).padStart(2,"0");
      return `<option value="${mm}">${t}</option>`;
    }).join("");
    monthPick.value = "";
  }

  async function loadStats(){
    if(msgEl) msgEl.textContent = "";

    const y = yearPick.value;
    const m = monthPick.value;
    const month = (!allTime?.checked && m) ? `${y}-${m}` : null;

    try{
      const data = await apiGet(`/api/stats${month ? ("?month="+encodeURIComponent(month)) : ""}`);
      if(revEl) revEl.textContent = Number(data.revenue||0).toLocaleString("ru-RU");
      if(expEl) expEl.textContent = Number(data.expenses||0).toLocaleString("ru-RU");
      if(netEl) {
        const v = Number(data.net||0);
        netEl.textContent = v.toLocaleString("ru-RU");
        netEl.className = v >= 0 ? "pos" : "neg";
      }
      if(msgEl) msgEl.textContent = "✅ Готово";
    }catch(e){
      if(msgEl) msgEl.textContent = "❌ " + (e.message || "ошибка");
    }
  }

  async function loadChart(){
    if(!chart) return;

    const y = Number(yearPick.value);
    try{
      const data = await apiGet(`/api/profit-by-month?year=${encodeURIComponent(y)}`);
      const months = data.months || [];
      const labels = months.map(x=>x.month);

      let values = months.map(x=>Number(x.revenue||0));
      const metric = metricSel?.value || "revenue";
      if(metric === "expenses") values = months.map(x=>Number(x.expenses||0));
      if(metric === "net") values = months.map(x=>Number(x.net||0));

      const sum = values.reduce((s,v)=>s+Number(v||0), 0);
      const avg = Math.round(sum / 12);
      if(yearTotal) yearTotal.textContent = sum.toLocaleString("ru-RU") + " ₸";
      if(yearAvg) yearAvg.textContent = avg.toLocaleString("ru-RU") + " ₸";

      drawBarChart(chart, labels, values);
    }catch(e){
      // ignore
    }
  }

  $("btnExport")?.addEventListener("click", ()=>{
    const y = yearPick.value;
    const a = document.createElement("a");
    a.href = `/api/export/year.csv?year=${encodeURIComponent(y)}`;
    a.click();
  });

  btn.addEventListener("click", loadStats);
  yearPick.addEventListener("change", loadChart);
  metricSel?.addEventListener("change", loadChart);

  allTime?.addEventListener("change", ()=>{
    if(allTime.checked) monthPick.value = "";
  });

  fillYearMonth();
  await loadStats();
  await loadChart();
}

/* ------------ EXPENSES PAGE ------------ */
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

/* ===== Pretty Select (turn native <select> into custom dropdown) ===== */
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
    const opt = selectEl.options[selectEl.selectedIndex];
    return opt ? opt.textContent : "— выбрать —";
  }

  function rebuild(){
    const cur = String(selectEl.value);
    btn.querySelector(".txt").textContent = currentLabel();

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

  selectEl.dataset.prettyDone = "1";
  rebuild();
}

function enhancePrettySelects(){
  // Finance
  enhanceSelect(document.getElementById("yearPick"));
  enhanceSelect(document.getElementById("monthPick"));
  enhanceSelect(document.getElementById("chartMetric"));

  // Calendar
  enhanceSelect(document.getElementById("monthSel"));
  enhanceSelect(document.getElementById("yearSel"));
}

/* init */
document.addEventListener("DOMContentLoaded", async () => {
  setActiveNav();
  enhancePrettySelects();

  try { await initBookingsPage(); } catch (e) {}
  try { await initGuestsPage(); } catch (e) {}
  try { await initCalendarPage(); } catch (e) {}
  try { await initFinancePage(); } catch (e) {}
  try { await initExpensesPage(); } catch (e) {}

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      if (!confirm("Выйти из системы?")) return;

      try {
        await apiSend("/api/auth/logout", "POST");
      } catch (e) {}

      location.replace("/login.html");
    });
  }
});