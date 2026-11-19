import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, getDocs, writeBatch, serverTimestamp, Bytes
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig, PROPERTY, UNITS, LANDLORD_UID, TENANTS } from "./config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const D0 = new Date(); D0.setHours(0, 0, 0, 0);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plus = n => { const d = new Date(D0); d.setDate(d.getDate() + n); return iso(d); };
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const nice = s => parse(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const TODAY = iso(D0);
const SLOTS = ["Morning", "Afternoon", "Evening"];
const HOURS = { Morning: "8am–12pm", Afternoon: "12–4pm", Evening: "4–7pm" };
const ROOMS = ["Kitchen", "Bathroom", "Bedroom", "Living room", "Other"];
const CHUNK = 900000;                 // bytes per stored piece (Firestore docs max out near 1 MB)
const MAX_VIDEO = 40 * 1024 * 1024;   // 40 MB per video
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cls = s => s === "Open" ? "s-open" : s === "Done" ? "s-done" : "s-progress";
const pill = s => `<span class="pill ${cls(s)}">${s}</span>`;
const initials = n => String(n).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
function rel(ms) {
  if (!ms) return "Just now";
  const diff = Date.now() - ms, min = Math.round(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = new Date(ms), y = new Date(D0); y.setDate(y.getDate() - 1);
  if (d >= y) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const CAL_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
const WRENCH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/></svg>';
const PHOTO_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5L7 19"/></svg>';
const VIDEO_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3z"/></svg>';
const PLAY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';

/* ---------- state ---------- */
const S = {
  uid: null, role: null, unit: null,
  tickets: [], techs: [], media: [],
  view: null, from: "lHome", filter: "Active", unitSel: "All",
  room: "Kitchen", urgency: "Soon", newDay: plus(1), newSlot: "Morning", files: [],
  currentId: null, pick: { id: null, day: null, slot: "Morning" },
  calY: D0.getFullYear(), calM: D0.getMonth(), selDay: TODAY,
  addingTech: false, confirmDel: false, sending: false
};
let unsubs = [];
const isLandlord = () => S.role === "landlord";
const byId = id => S.tickets.find(t => t.id === id);
const current = () => byId(S.currentId);

let toastTimer;
function toast(msg, kind = "ok") {
  const el = $("toast");
  el.textContent = msg; el.className = `toast ${kind}`; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 5000);
}
async function guard(fn) {
  try { await fn(); }
  catch (e) {
    console.error(e);
    toast(e && e.userMessage ? e.userMessage : "That didn't save. Check your connection and try again.", "bad");
  }
}

/* ---------- auth ---------- */
onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = [];
  S.tickets = []; S.techs = []; S.media = [];
  $("boot").hidden = true;
  if (!user) {
    S.uid = S.role = S.unit = null;
    $("who").hidden = true; $("themeRow").hidden = true;
    showOnly("login");
    return;
  }
  S.uid = user.uid;
  if (user.uid === LANDLORD_UID) { S.role = "landlord"; S.unit = null; }
  else if (TENANTS[user.uid]) { S.role = "tenant"; S.unit = TENANTS[user.uid].unit; }
  else { S.role = null; }
  $("who").hidden = false;
  $("whoName").textContent = S.role === "landlord" ? "Landlord" : (S.unit || "");
  if (!S.role) { showOnly("noRole"); return; }
  $("themeRow").hidden = false;
  subscribe();
  show(isLandlord() ? "lHome" : "tHome");
});

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("email").value.trim(), pw = $("password").value;
  const err = $("loginErr");
  if (!email || !pw) { err.textContent = "Enter your email and password."; err.hidden = false; return; }
  $("loginBtn").disabled = true; $("loginBtn").textContent = "Signing in…"; err.hidden = true;
  try { await signInWithEmailAndPassword(auth, email, pw); $("password").value = ""; }
  catch (ex) {
    const c = ex && ex.code || "";
    err.textContent = c.includes("invalid") || c.includes("wrong-password") || c.includes("user-not-found")
      ? "That email and password don't match. Try again or reset your password."
      : c.includes("too-many") ? "Too many tries. Wait a few minutes, then try again."
      : "Couldn't sign in. Check your connection and try again.";
    err.hidden = false;
  }
  $("loginBtn").disabled = false; $("loginBtn").textContent = "Sign in";
});
$("forgot").addEventListener("click", async () => {
  const email = $("email").value.trim(), err = $("loginErr");
  if (!email) { err.textContent = "Type your email above first, then tap Forgot your password."; err.hidden = false; return; }
  try { await sendPasswordResetEmail(auth, email); err.hidden = true; toast(`If ${email} has an account, a reset link is on its way.`); }
  catch { err.textContent = "Couldn't send the reset email. Check the address and try again."; err.hidden = false; }
});
$("signOut").addEventListener("click", () => signOut(auth));

/* ---------- live data ---------- */
function mapTicket(d) {
  const x = d.data({ serverTimestamps: "estimate" });
  return {
    id: d.id, unit: x.unit, room: x.room, title: x.title, note: x.note || "", urg: x.urg, status: x.status,
    createdAt: x.createdAt ? x.createdAt.toMillis() : Date.now(),
    appt: x.appt || null, tech: x.tech || null,
    q: x.q || `${(x.room || "").toLowerCase()} ${(x.title || "").toLowerCase()} repair`
  };
}
function subscribe() {
  const onErr = e => { console.error(e); toast("Couldn't load the latest tickets. Pull down to refresh, or sign in again.", "bad"); };
  const tq = isLandlord() ? collection(db, "tickets") : query(collection(db, "tickets"), where("unit", "==", S.unit));
  unsubs.push(onSnapshot(tq, snap => {
    S.tickets = snap.docs.map(mapTicket).sort((a, b) => b.createdAt - a.createdAt);
    render();
  }, onErr));
  if (isLandlord()) {
    unsubs.push(onSnapshot(collection(db, "techs"), snap => {
      S.techs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
      render();
    }, onErr));
    unsubs.push(onSnapshot(collection(db, "media"), snap => {
      S.media = snap.docs.map(d => { const x = d.data({ serverTimestamps: "estimate" }); return { id: d.id, ...x, createdAt: x.createdAt ? x.createdAt.toMillis() : Date.now() }; })
        .sort((a, b) => b.createdAt - a.createdAt);
      render();
    }, onErr));
  }
}

/* ---------- views ---------- */
const VIEWS = ["login", "noRole", "tHome", "tNew", "lHome", "lCal", "lDetail"];
function showOnly(id) { VIEWS.forEach(v => $(v).hidden = v !== id); }
function show(id) {
  showOnly(id);
  if (id !== "lDetail" && id[0] === "l") S.from = id;
  if (id !== S.view) window.scrollTo(0, 0);
  S.view = id; S.pick.id = null; S.addingTech = false; S.confirmDel = false;
  render();
}

function techLine(tc, prefix) {
  return `<div class="tech"><span class="av" aria-hidden="true">${esc(initials(tc.name))}</span><span><small>${prefix}</small><b>${esc(tc.name)}</b> · ${esc(tc.trade)}${tc.phone ? ` · ${esc(tc.phone)}` : ""}</span></div>`;
}
function visitText(t, who) {
  const a = t.appt; if (!a) return "";
  let tag;
  if (a.state === "Approved") tag = '<span class="vs v-ok">Confirmed</span>';
  else if (a.state === "Pending") tag = `<span class="vs v-wait">${who === "landlord" ? "Needs your approval" : "Waiting for landlord"}</span>`;
  else tag = `<span class="vs v-wait">${who === "landlord" ? "Sent to tenant" : "New time suggested"}</span>`;
  return `<p class="visit">${CAL_ICON}${nice(a.d)} · ${a.slot} ${tag}</p>`;
}
function dayChips(sel, act) {
  let h = "";
  for (let i = 1; i <= 14; i++) {
    const s = plus(i), d = parse(s);
    h += `<button class="day" data-act="${act}" data-val="${s}" aria-pressed="${s === sel}" aria-label="${nice(s)}"><small>${d.toLocaleDateString("en-US", { weekday: "short" })}</small><b>${d.getDate()}</b></button>`;
  }
  return h;
}
const slotSeg = (sel, act) => SLOTS.map(s => `<button data-act="${act}" data-val="${s}" aria-pressed="${s === sel}">${s}</button>`).join("");
function picker(t) {
  if (S.pick.id !== t.id) return "";
  const label = !isLandlord() ? "Request this time" : (t.appt ? "Suggest this time" : "Schedule visit");
  return `<div class="picker"><p class="f">Pick a day and time</p><div class="days">${dayChips(S.pick.day, "pickDay")}</div><div class="seg">${slotSeg(S.pick.slot, "pickSlot")}</div><p class="sub" style="font-size:13px">${HOURS[S.pick.slot]}</p><div class="btns"><button class="btn-sec" data-act="cancelPick">Cancel</button><button class="btn-pri" data-act="sendPick" data-id="${t.id}">${label}</button></div></div>`;
}
function tile(m) {
  const inner = m.thumb ? `<img src="${esc(m.thumb)}" alt="">` : `${m.type === "video" ? VIDEO_ICON : PHOTO_ICON}<span class="cap">${esc(m.label)}</span>`;
  const badge = m.type === "video" ? `<span class="vbadge">${PLAY}</span>` : "";
  return `<button class="tile" data-act="viewMedia" data-id="${m.id}" aria-label="${m.type === "video" ? "Video" : "Photo"}: ${esc(m.label)}">${inner}${badge}</button>`;
}
const tenantName = u => (Object.values(TENANTS).find(x => x.unit === u) || {}).name || "No tenant linked";

// Keep typed text in forms that get redrawn when new data arrives.
function keepInputs(ids, fn) {
  const saved = {}; let focused = document.activeElement && document.activeElement.id;
  ids.forEach(id => { const el = $(id); if (el) saved[id] = el.value; });
  fn();
  ids.forEach(id => { const el = $(id); if (el && saved[id] != null) el.value = saved[id]; });
  if (focused && ids.includes(focused) && $(focused)) $(focused).focus();
}

function render() {
  if (!S.role) return;
  keepInputs(["tName", "tTrade", "tPhone"], () => {
    const kx = [...document.querySelectorAll(".days,.utabs")].map(el => el.scrollLeft);
    if (isLandlord()) renderLandlord(); else renderTenant();
    document.querySelectorAll(".days,.utabs").forEach((el, i) => { if (kx[i]) el.scrollLeft = kx[i]; });
  });
  const mode = (() => { try { return localStorage.getItem("bnTheme") || "auto"; } catch { return "auto"; } })();
  document.querySelectorAll("[data-theme-set]").forEach(b => b.setAttribute("aria-pressed", b.dataset.themeSet === mode));
}

function renderTenant() {
  $("tUnitLine").textContent = `${S.unit} · ${PROPERTY}`;
  const card = t => {
    const done = t.status === "Done";
    let actions = "";
    if (!done && t.appt && t.appt.state === "Proposed" && S.pick.id !== t.id)
      actions = `<div class="btns"><button class="btn-sec" data-act="suggest" data-id="${t.id}">Pick another time</button><button class="btn-pri" data-act="accept" data-id="${t.id}">Accept</button></div>`;
    else if (!done && !t.appt && S.pick.id !== t.id)
      actions = `<button class="btn-sec" data-act="suggest" data-id="${t.id}">Request a visit time</button>`;
    const tech = t.tech ? techLine(t.tech, done ? "Fixed by" : "Technician") : (done ? "" : '<p class="sub" style="font-size:13px">Technician not assigned yet</p>');
    return `<div class="card"><div class="row"><h2${done ? ' style="color:var(--muted)"' : ""}>${esc(t.title)}</h2>${pill(t.status)}</div><p class="sub">${esc(t.room)} · ${done ? "Updated" : "Submitted"} ${rel(t.createdAt)}</p>${done ? "" : visitText(t, "tenant")}${tech}${actions}${picker(t)}</div>`;
  };
  $("tenantActive").innerHTML = S.tickets.filter(t => t.status !== "Done").map(card).join("") || '<p class="sub">No open requests. Tap New request when something needs fixing.</p>';
  $("tenantDone").innerHTML = S.tickets.filter(t => t.status === "Done").map(card).join("") || '<p class="sub">Nothing completed yet.</p>';
  $("rooms").innerHTML = ROOMS.map(r => `<button class="chip" data-act="room" data-val="${r}" aria-pressed="${r === S.room}">${r}</button>`).join("");
  $("urgency").innerHTML = ["Can wait", "Soon", "Urgent"].map(u => `<button data-act="urg" data-val="${u}" aria-pressed="${u === S.urgency}">${u}</button>`).join("");
  $("newDays").innerHTML = dayChips(S.newDay, "newDay");
  $("newSlot").innerHTML = slotSeg(S.newSlot, "newSlot");
}

function renderLandlord() {
  const units = `${PROPERTY} · ${UNITS.length} units`;
  $("lUnitsLine").textContent = units; $("lUnitsLine2").textContent = units;
  const all = S.tickets;
  const pendingAll = all.filter(t => t.status !== "Done" && t.appt && t.appt.state === "Pending");
  const nav = cur => ["Tickets", "Calendar"].map(n => `<button data-act="nav" data-to="${n === "Tickets" ? "lHome" : "lCal"}" aria-pressed="${n === cur}">${n}${n === "Calendar" && pendingAll.length ? ` (${pendingAll.length})` : ""}</button>`).join("");
  $("lNav1").innerHTML = nav("Tickets"); $("lNav2").innerHTML = nav("Calendar");

  /* tickets, scoped to unit */
  const scoped = S.unitSel === "All" ? all : all.filter(t => t.unit === S.unitSel);
  const sPend = scoped.filter(t => t.status !== "Done" && t.appt && t.appt.state === "Pending");
  $("lTitle").textContent = S.unitSel === "All" ? "Tickets" : S.unitSel;
  $("unitTabs").innerHTML = ["All", ...UNITS].map(u => {
    const n = (u === "All" ? all : all.filter(t => t.unit === u)).filter(t => t.status !== "Done").length;
    return `<button class="utab" data-act="unit" data-val="${u}" aria-pressed="${u === S.unitSel}"${u === "All" ? ' style="grid-column:1 / -1"' : ""}>${u === "All" ? "All units" : u}${n ? `<span class="n" aria-label="${n} active">${n}</span>` : ""}</button>`;
  }).join("");
  if (S.unitSel === "All") {
    $("unitHead").innerHTML = ""; $("unitExtra").innerHTML = ""; $("unitExtra").hidden = true;
  } else {
    const um = S.media.filter(m => m.unit === S.unitSel);
    $("unitHead").innerHTML = `<div class="card"><p class="label">Tenant</p><h2 style="font-size:17px">${esc(tenantName(S.unitSel))}</h2><p class="sub">${scoped.length} ticket${scoped.length === 1 ? "" : "s"} · ${um.length} ${um.length === 1 ? "photo or video" : "photos and videos"}</p></div>`;
    const up = scoped.filter(t => t.status !== "Done" && t.appt && t.appt.d >= TODAY)
      .sort((a, b) => a.appt.d < b.appt.d ? -1 : a.appt.d > b.appt.d ? 1 : SLOTS.indexOf(a.appt.slot) - SLOTS.indexOf(b.appt.slot));
    const visits = up.map(t => `<button class="card" data-act="open" data-id="${t.id}">${visitText(t, "landlord")}<span class="sub">${esc(t.title)}</span></button>`).join("") || '<p class="sub">No upcoming visits.</p>';
    $("unitExtra").hidden = false;
    $("unitExtra").innerHTML = `<p class="label">Upcoming visits</p><div class="stack">${visits}</div><p class="label">Photos and videos</p>${um.length ? `<div class="gal">${um.map(tile).join("")}</div>` : '<p class="sub">No photos or videos yet.</p>'}<p class="label">Tickets</p>`;
  }
  $("pendBanner").innerHTML = sPend.length ? `<button class="alert" data-act="nav" data-to="lCal"><span>${sPend.length} visit${sPend.length > 1 ? "s" : ""} waiting for your approval</span><span>Review</span></button>` : "";
  $("cOpen").textContent = scoped.filter(t => t.status === "Open").length;
  $("cProg").textContent = scoped.filter(t => t.status === "In progress").length;
  $("cDone").textContent = scoped.filter(t => t.status === "Done").length;
  $("filter").innerHTML = ["Active", "Done", "All"].map(f => `<button data-act="filter" data-val="${f}" aria-pressed="${f === S.filter}">${f}</button>`).join("");
  const list = scoped.filter(t => S.filter === "All" || (S.filter === "Done" ? t.status === "Done" : t.status !== "Done"));
  $("landlordList").innerHTML = list.map(t => `<button class="card" data-act="open" data-id="${t.id}"><span class="row"><span class="label">${esc(t.unit)} · ${esc(t.room)}</span>${t.urg === "Urgent" ? '<span class="urgent">Urgent</span>' : `<span class="sub" style="font-size:13px">${esc(t.urg)}</span>`}</span><h2 style="font-size:17px">${esc(t.title)}</h2>${t.status === "Done" ? "" : visitText(t, "landlord")}<span class="row"><span class="sub">${rel(t.createdAt)} · ${t.tech ? esc(t.tech.name) : (t.status === "Done" ? "No technician" : '<span class="unassigned">Unassigned</span>')}</span>${pill(t.status)}</span></button>`).join("")
    || `<p class="sub">${all.length ? "No tickets here." : "No tickets yet. They'll show up here as soon as a tenant sends one."}</p>`;

  /* calendar */
  $("approvals").innerHTML = pendingAll.length ? `<p class="label">Needs your approval</p>` + pendingAll.map(t => `<div class="card"><div class="row"><span class="label">${esc(t.unit)} · ${esc(t.room)}</span>${t.urg === "Urgent" ? '<span class="urgent">Urgent</span>' : ""}</div><h2 style="font-size:17px">${esc(t.title)}</h2><p class="visit">${CAL_ICON}${nice(t.appt.d)} · ${t.appt.slot} (${HOURS[t.appt.slot]})</p>${S.pick.id === t.id ? picker(t) : `<div class="btns"><button class="btn-sec" data-act="suggest" data-id="${t.id}">Suggest another</button><button class="btn-pri" data-act="approve" data-id="${t.id}">Approve</button></div>`}</div>`).join("") : "";
  const first = new Date(S.calY, S.calM, 1);
  $("monthName").textContent = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  let g = ["S", "M", "T", "W", "T", "F", "S"].map(w => `<span class="wd" aria-hidden="true">${w}</span>`).join("");
  for (let i = 0; i < first.getDay(); i++) g += "<span></span>";
  const nDays = new Date(S.calY, S.calM + 1, 0).getDate();
  for (let d = 1; d <= nDays; d++) {
    const s = iso(new Date(S.calY, S.calM, d));
    const v = all.filter(t => t.appt && t.appt.d === s);
    const dots = v.slice(0, 4).map(t => `<i class="dot ${t.appt.state === "Approved" ? "d-ok" : "d-wait"}"></i>`).join("");
    const c = ["cd"]; if (s === TODAY) c.push("today"); if (s < TODAY) c.push("past");
    g += `<button class="${c.join(" ")}" data-act="calDay" data-val="${s}" aria-pressed="${s === S.selDay}" aria-label="${nice(s)}, ${v.length} visit${v.length === 1 ? "" : "s"}">${d}<span class="dots">${dots}</span></button>`;
  }
  $("calGrid").innerHTML = g;
  $("dayLabel").textContent = S.selDay === TODAY ? `Today · ${nice(S.selDay)}` : nice(S.selDay);
  const onDay = all.filter(t => t.appt && t.appt.d === S.selDay).sort((a, b) => SLOTS.indexOf(a.appt.slot) - SLOTS.indexOf(b.appt.slot));
  $("dayList").innerHTML = onDay.map(t => `<button class="card" data-act="open" data-id="${t.id}"><span class="row"><span class="slot">${t.appt.slot} · ${HOURS[t.appt.slot]}</span><span class="vs ${t.appt.state === "Approved" ? "v-ok" : "v-wait"}">${t.appt.state === "Approved" ? "Confirmed" : t.appt.state === "Pending" ? "Needs approval" : "Sent to tenant"}</span></span><h2 style="font-size:17px">${esc(t.title)}</h2><span class="sub">${esc(t.unit)} · ${esc(t.room)}${t.tech ? ` · ${esc(t.tech.name)}` : ""}</span></button>`).join("") || '<p class="sub">No visits this day.</p>';

  /* detail */
  const t = current();
  if (S.view === "lDetail" && !t) { show(S.from); return; }
  if (!t) return;
  $("backLabel").textContent = S.from === "lCal" ? "Calendar" : (S.unitSel === "All" ? "Tickets" : S.unitSel);
  $("dWhere").textContent = `${t.unit} · ${t.room}`;
  $("dUrg").innerHTML = t.urg === "Urgent" ? '<span class="urgent">Urgent</span>' : `<span class="sub" style="font-size:13px">${esc(t.urg)}</span>`;
  $("dTitle").textContent = t.title;
  $("dWhen").textContent = `Submitted ${rel(t.createdAt)}`;
  $("dNote").textContent = t.note ? `"${t.note}"` : "No extra details.";
  const ms = S.media.filter(m => m.ticketId === t.id);
  $("dMedia").innerHTML = `<p class="f">Photos and videos</p>` + (ms.length ? `<div class="gal">${ms.map(tile).join("")}</div>` : `<p class="sub">The tenant didn't add any.</p>`);
  $("dStatus").innerHTML = ["Open", "In progress", "Done"].map(s => `<button data-act="status" data-val="${s}" aria-pressed="${s === t.status}">${s}</button>`).join("");

  let th = `<div class="row" style="justify-content:flex-start">${WRENCH}<h2>Technician</h2></div>`;
  th += t.tech ? techLine(t.tech, t.status === "Done" ? "Fixed by" : "Assigned to") : '<p class="sub">No one assigned yet. The tenant sees who you pick.</p>';
  const opts = [...S.techs, { id: "self", name: "Landlord", trade: "Handling it myself", phone: "" }];
  th += `<p class="f" style="font-size:13px">${t.tech ? "Change technician" : "Assign a technician"}</p><div class="chips">${opts.map(x => `<button class="chip" data-act="assign" data-val="${x.id}" aria-pressed="${!!t.tech && x.id === t.tech.id}">${esc(x.name)} · ${esc(x.trade)}</button>`).join("")}</div>`;
  if (S.addingTech) {
    th += `<div class="techform"><label class="f" for="tName">Name</label><input id="tName" type="text" placeholder="Mike R." autocomplete="off" maxlength="60"><p id="tErr" class="err" hidden>Add a name first.</p><label class="f" for="tTrade">Trade</label><input id="tTrade" type="text" placeholder="Plumbing" autocomplete="off" maxlength="60"><label class="f" for="tPhone">Phone <span style="font-weight:400;color:var(--muted)">(optional)</span></label><input id="tPhone" type="text" inputmode="tel" placeholder="555-123-4567" autocomplete="off" maxlength="30"><div class="btns"><button class="btn-sec" data-act="techCancel">Cancel</button><button class="btn-pri" data-act="techSave">Save and assign</button></div></div>`;
  } else {
    th += `<div class="btns"><button class="btn-sec" data-act="techAdd">Add a technician</button>${t.tech ? '<button class="btn-sec" data-act="assign" data-val="">Unassign</button>' : ""}</div>`;
  }
  $("dTech").innerHTML = th;

  let v = `<div class="row" style="justify-content:flex-start">${CAL_ICON}<h2>Visit</h2></div>`;
  if (!t.appt) {
    v += `<p class="sub">No visit scheduled yet.</p>`;
    if (S.pick.id !== t.id) v += `<button class="btn-pri" data-act="suggest" data-id="${t.id}">Schedule a visit</button>`;
  } else {
    v += `${visitText(t, "landlord")}<p class="sub" style="font-size:13px">${HOURS[t.appt.slot]}</p>`;
    if (S.pick.id !== t.id) {
      if (t.appt.state === "Pending") v += `<div class="btns"><button class="btn-sec" data-act="suggest" data-id="${t.id}">Suggest another</button><button class="btn-pri" data-act="approve" data-id="${t.id}">Approve</button></div>`;
      else if (t.status !== "Done") v += `<button class="btn-sec" data-act="suggest" data-id="${t.id}">Change time</button>`;
    }
  }
  $("dVisit").innerHTML = v + picker(t);
  $("dDelete").innerHTML = S.confirmDel
    ? `<div class="card"><p class="f">Delete this ticket and its photos and videos?</p><p class="sub">This can't be undone.</p><div class="btns"><button class="btn-sec" data-act="delCancel">Keep it</button><button class="btn-danger" data-act="delYes">Delete</button></div></div>`
    : `<button class="btn-danger" style="width:100%" data-act="delAsk">Delete ticket</button>`;
}

function links() {
  const q = encodeURIComponent($("query").value.trim());
  $("qGoogle").href = `https://www.google.com/search?q=${q}`;
  $("qHD").href = `https://www.homedepot.com/s/${q}`;
  $("qLowes").href = `https://www.lowes.com/search?searchTerm=${q}`;
  $("qYT").href = `https://www.youtube.com/results?search_query=${q}`;
}
$("query").addEventListener("input", links);

/* ---------- writes ---------- */
const tRef = id => doc(db, "tickets", id);
const stamp = () => ({ updatedAt: serverTimestamp() });

async function deleteTicket(id) {
  const mq = query(collection(db, "media"), where("ticketId", "==", id));
  const mediaDocs = (await getDocs(mq)).docs;
  let batch = writeBatch(db), n = 0;
  const flush = async () => { if (n) { await batch.commit(); batch = writeBatch(db); n = 0; } };
  for (const m of mediaDocs) {
    const cs = await getDocs(query(collection(db, "chunks"), where("mediaId", "==", m.id)));
    for (const c of cs.docs) { batch.delete(c.ref); if (++n >= 400) await flush(); }
    batch.delete(m.ref); if (++n >= 400) await flush();
  }
  batch.delete(tRef(id)); n++;
  await flush();
}

/* photos: shrink before saving; videos: saved in pieces */
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => res({ img, url }); img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("image")); };
    img.src = url;
  });
}
function drawScaled(img, max) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}
async function preparePhoto(file) {
  const { img, url } = await loadImage(file);
  const big = drawScaled(img, 1600);
  const blob = await new Promise(r => big.toBlob(r, "image/jpeg", 0.8));
  const thumb = drawScaled(img, 360).toDataURL("image/jpeg", 0.6);
  URL.revokeObjectURL(url);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg", thumb };
}
function videoThumb(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file), v = document.createElement("video");
    let done = false;
    const finish = val => { if (done) return; done = true; URL.revokeObjectURL(url); res(val); };
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.onloadeddata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch { finish(""); } };
    v.onseeked = () => {
      try {
        const s = Math.min(1, 360 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement("canvas"); c.width = Math.round(v.videoWidth * s) || 1; c.height = Math.round(v.videoHeight * s) || 1;
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL("image/jpeg", 0.6));
      } catch { finish(""); }
    };
    v.onerror = () => finish("");
    setTimeout(() => finish(""), 5000);
    v.src = url;
  });
}
async function uploadFile(file, ticketId, unit, onPiece) {
  const isVideo = (file.type || "").startsWith("video");
  let bytes, mime, thumb = "";
  if (isVideo) {
    bytes = new Uint8Array(await file.arrayBuffer()); mime = file.type || "video/mp4";
    thumb = await videoThumb(file);
  } else {
    ({ bytes, mime, thumb } = await preparePhoto(file));
  }
  const mRef = doc(collection(db, "media"));
  const n = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let i = 0; i < n; i++) {
    await setDoc(doc(db, "chunks", `${mRef.id}_${i}`), {
      mediaId: mRef.id, i, unit, by: S.uid, d: Bytes.fromUint8Array(bytes.subarray(i * CHUNK, (i + 1) * CHUNK))
    });
    onPiece && onPiece();
  }
  await setDoc(mRef, {
    ticketId, unit, by: S.uid, type: isVideo ? "video" : "photo", label: file.name || (isVideo ? "Video" : "Photo"),
    mime, size: bytes.length, chunks: n, thumb, createdAt: serverTimestamp()
  });
}

/* viewer */
let viewerUrl = null;
async function openMedia(id) {
  const m = S.media.find(x => x.id === id); if (!m) return;
  $("vLabel").textContent = m.label;
  $("vBody").textContent = "Loading…";
  $("vFoot").innerHTML = S.view !== "lDetail" ? `<button data-act="openFromViewer" data-id="${m.ticketId}">Open ticket</button>` : "";
  $("viewer").hidden = false;
  try {
    const cs = await getDocs(query(collection(db, "chunks"), where("mediaId", "==", id)));
    const parts = cs.docs.map(d => d.data()).sort((a, b) => a.i - b.i).map(x => x.d.toUint8Array());
    if (parts.length < m.chunks) throw new Error("incomplete");
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(new Blob(parts, { type: m.mime }));
    $("vBody").innerHTML = m.type === "video"
      ? `<video src="${viewerUrl}" controls playsinline autoplay></video>`
      : `<img src="${viewerUrl}" alt="${esc(m.label)}">`;
  } catch (e) { console.error(e); $("vBody").textContent = "Couldn't load this file. Try again in a moment."; }
}
function closeViewer() {
  $("viewer").hidden = true; $("vBody").innerHTML = "";
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
}
$("vClose").addEventListener("click", closeViewer);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("viewer").hidden) closeViewer(); });

/* ---------- clicks ---------- */
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, val = b.dataset.val, t = b.dataset.id ? byId(b.dataset.id) : null;
  switch (act) {
    case "nav": show(b.dataset.to); return;
    case "back": show(S.from); return;
    case "open": S.currentId = b.dataset.id; $("query").value = t ? t.q : ""; links(); show("lDetail"); return;
    case "openFromViewer": closeViewer(); S.currentId = b.dataset.id; { const tt = byId(b.dataset.id); $("query").value = tt ? tt.q : ""; } links(); show("lDetail"); return;
    case "viewMedia": openMedia(b.dataset.id); return;
    case "room": S.room = val; break;
    case "urg": S.urgency = val; break;
    case "newDay": S.newDay = val; break;
    case "newSlot": S.newSlot = val; break;
    case "filter": S.filter = val; break;
    case "unit": S.unitSel = val; break;
    case "month": S.calM += Number(val); if (S.calM < 0) { S.calM = 11; S.calY--; } if (S.calM > 11) { S.calM = 0; S.calY++; } break;
    case "calDay": S.selDay = val; break;
    case "suggest": S.pick = { id: t.id, day: t.appt && t.appt.d > TODAY ? t.appt.d : plus(1), slot: t.appt ? t.appt.slot : "Morning" }; break;
    case "pickDay": S.pick.day = val; break;
    case "pickSlot": S.pick.slot = val; break;
    case "cancelPick": S.pick.id = null; break;
    case "techAdd": S.addingTech = true; render(); $("tName") && $("tName").focus(); return;
    case "techCancel": S.addingTech = false; break;
    case "delAsk": S.confirmDel = true; break;
    case "delCancel": S.confirmDel = false; break;

    case "approve":
    case "accept":
      guard(() => updateDoc(tRef(t.id), { "appt.state": "Approved", ...stamp() }));
      return;
    case "sendPick": {
      const state = !isLandlord() ? "Pending" : (t.appt ? "Proposed" : "Approved");
      const appt = { d: S.pick.day, slot: S.pick.slot, state };
      S.pick.id = null;
      guard(() => updateDoc(tRef(t.id), { appt, ...stamp() }));
      break;
    }
    case "status": {
      const c = current(); if (!c) return;
      guard(() => updateDoc(tRef(c.id), { status: val, ...stamp() }));
      return;
    }
    case "assign": {
      const c = current(); if (!c) return;
      let tech = null;
      if (val === "self") tech = { id: "self", name: "Landlord", trade: "Handling it myself", phone: "" };
      else if (val) { const x = S.techs.find(y => y.id === val); if (x) tech = { id: x.id, name: x.name, trade: x.trade, phone: x.phone || "" }; }
      const upd = { tech, ...stamp() };
      if (tech && c.status === "Open") upd.status = "In progress";
      guard(() => updateDoc(tRef(c.id), upd));
      return;
    }
    case "techSave": {
      const c = current(); if (!c) return;
      const name = $("tName").value.trim();
      if (!name) { $("tErr").hidden = false; $("tName").focus(); return; }
      const x = { name, trade: $("tTrade").value.trim() || "General repairs", phone: $("tPhone").value.trim() };
      S.addingTech = false;
      guard(async () => {
        const ref = await addDoc(collection(db, "techs"), { ...x, createdAt: serverTimestamp() });
        const upd = { tech: { id: ref.id, ...x }, ...stamp() };
        if (c.status === "Open") upd.status = "In progress";
        await updateDoc(tRef(c.id), upd);
        toast(`${name} added and assigned.`);
      });
      break;
    }
    case "delYes": {
      const c = current(); if (!c) return;
      S.confirmDel = false;
      guard(async () => { await deleteTicket(c.id); toast("Ticket deleted."); show(S.from); });
      return;
    }
    default: return;
  }
  render();
});

/* ---------- new request ---------- */
$("issue").addEventListener("input", () => $("issueErr").hidden = true);
$("photo").addEventListener("change", e => {
  const files = [...e.target.files];
  const tooBig = files.filter(f => (f.type || "").startsWith("video") && f.size > MAX_VIDEO);
  S.files = files.filter(f => !tooBig.includes(f));
  const err = $("fileErr");
  if (tooBig.length) { err.textContent = `${tooBig.length === 1 ? "One video is" : `${tooBig.length} videos are`} over 40 MB and won't be sent. Try a shorter clip.`; err.hidden = false; }
  else err.hidden = true;
  const n = S.files.length;
  $("photoLabel").textContent = n ? `${n} file${n === 1 ? "" : "s"} added · tap to change` : "Add photos or videos";
});
$("send").addEventListener("click", async () => {
  if (S.sending) return;
  const title = $("issue").value.trim();
  if (!title) { $("issueErr").hidden = false; $("issue").focus(); return; }
  S.sending = true; $("sendErr").hidden = true;
  const btn = $("send"); btn.disabled = true; btn.textContent = "Sending…";
  try {
    const ref = doc(collection(db, "tickets"));
    await setDoc(ref, {
      unit: S.unit, room: S.room, title, note: $("details").value.trim(), urg: S.urgency, status: "Open",
      createdBy: S.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      appt: { d: S.newDay, slot: S.newSlot, state: "Pending" }, tech: null,
      q: `${S.room.toLowerCase()} ${title.toLowerCase()} repair`
    });
    const files = S.files; let failed = 0;
    for (let i = 0; i < files.length; i++) {
      btn.textContent = `Uploading ${i + 1} of ${files.length}…`;
      try { await uploadFile(files[i], ref.id, S.unit); } catch (e) { console.error(e); failed++; }
    }
    $("issue").value = ""; $("details").value = ""; $("photo").value = ""; S.files = [];
    $("photoLabel").textContent = "Add photos or videos"; $("fileErr").hidden = true;
    S.newDay = plus(1); S.newSlot = "Morning";
    show("tHome");
    toast(failed ? `Sent, but ${failed} file${failed === 1 ? "" : "s"} didn't upload.` : "Sent. Your landlord will confirm the visit time.", failed ? "bad" : "ok");
  } catch (e) {
    console.error(e);
    $("sendErr").textContent = "Your request didn't send. Check your connection and try again."; $("sendErr").hidden = false;
  }
  S.sending = false; btn.disabled = false; btn.textContent = "Send to landlord";
});

/* ---------- appearance ---------- */
function applyTheme(m) {
  const r = document.documentElement;
  if (m === "auto") r.removeAttribute("data-theme"); else r.setAttribute("data-theme", m);
  document.querySelectorAll("[data-theme-set]").forEach(b => b.setAttribute("aria-pressed", b.dataset.themeSet === m));
  try { localStorage.setItem("bnTheme", m); } catch { }
}
document.querySelectorAll("[data-theme-set]").forEach(b => b.addEventListener("click", () => applyTheme(b.dataset.themeSet)));
try { applyTheme(localStorage.getItem("bnTheme") || "auto"); } catch { applyTheme("auto"); }
