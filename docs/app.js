import { firebaseConfig, ADMIN_EMAILS } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, getDocs,
  onSnapshot, query, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { getAnalytics, logEvent, isSupported } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Anonymous usage statistics (Google Analytics). Never blocks the app if unavailable.
let analytics = null;
isSupported().then((ok) => { if (ok && firebaseConfig.measurementId) analytics = getAnalytics(app); }).catch(() => {});
const track = (name, params = {}) => { try { if (analytics) logEvent(analytics, name, params); } catch (e) { /* ignore */ } };
document.addEventListener('click', (e) => { if (e.target.closest('a[href*="google.com/maps/dir"]')) track('navigate_tap'); });

const BLR = [12.9716, 77.5946];
const SLOT_MIN = 30;
const MAX_SLOTS = 4;
const MAX_UPCOMING = 2;
const DAYS_AHEAD = 7;
const STATUS_LABEL = { available: 'Available', in_use: 'In use', busy: 'Busy', offline: 'Offline', unknown: 'Status unknown' };
const STATUS_COLOR = { available: '#12a150', busy: '#d93025', offline: '#5f6368', unknown: '#5b7bb5' };

const state = {
  stations: [], byId: new Map(), partners: new Map(),
  user: null, profile: null, pos: null,
  filters: { plug: '', fast: false, bookable: false },
  radius: 1, browse: false,
  markers: new Map(), unsubSlots: null, miniMap: null,
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const myEmail = () => (state.user?.email || '').toLowerCase();
const isAdmin = () => !!state.user && ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(myEmail());
const prettyDate = (s) => new Date(`${s}T00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const partnerOf = (s) => state.partners.get(s.id);
const chargerStatus = (s, c) => partnerOf(s)?.chargers?.[c.id]?.status || 'unknown';
const priceOf = (s) => partnerOf(s)?.pricePerKwh ?? s.pricePerKwh;
const maxKw = (s) => Math.max(0, ...s.chargers.map((c) => c.kw || 0));
const isBookable = (s) => !!partnerOf(s)?.bookable;

function stationStatus(s) {
  const p = partnerOf(s);
  if (!p) return 'unknown';
  const st = s.chargers.map((c) => chargerStatus(s, c));
  if (st.includes('available')) return 'available';
  if (st.includes('in_use')) return 'busy';
  if (st.every((x) => x === 'offline')) return 'offline';
  return 'unknown';
}

// ---------- map ----------
const RADII = [1, 3, 5, 10, 25];
const LABEL_LIMIT = 60;
const map = L.map('map', { zoomControl: false }).setView(BLR, 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
let meMarker = null, radiusCircle = null;

// Chargers are shown around an origin: the person's location, or the map centre once they drag the map.
const origin = () => (state.browse || !state.pos ? [map.getCenter().lat, map.getCenter().lng] : state.pos);
const originLabel = () => (state.browse || !state.pos ? 'the map centre' : 'you');
const pinName = (s) => s.operator || s.name;

function fitRadius(centre) {
  map.fitBounds(L.latLng(centre).toBounds(state.radius * 2000 * 1.2), { animate: false });
}

function locate() {
  if (!navigator.geolocation) { refresh(); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    state.pos = [p.coords.latitude, p.coords.longitude];
    state.browse = false;
    if (meMarker) meMarker.setLatLng(state.pos);
    else meMarker = L.circleMarker(state.pos, { radius: 7, color: '#fff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
    fitRadius(state.pos);
    refresh();
  }, () => { toast('Location not available. Drag the map to your area to see chargers there.', 5000); refresh(); },
  { enableHighAccuracy: true, timeout: 8000 });
}
$('btn-locate').onclick = locate;
map.on('dragend', () => { state.browse = true; refresh(); });

function passesFilters(s) {
  const f = state.filters;
  if (f.plug && !s.chargers.some((c) => c.plug === f.plug)) return false;
  if (f.fast && maxKw(s) < 25) return false;
  if (f.bookable && !isBookable(s)) return false;
  return true;
}

// Stations that pass the filters, with distance from the origin, nearest first.
function ranked() {
  const o = origin();
  return state.stations.filter(passesFilters)
    .map((s) => ({ s, d: km(o, [s.lat, s.lng]) }))
    .sort((a, b) => a.d - b.d);
}

function refresh() {
  const all = ranked();
  const near = all.filter((r) => r.d <= state.radius);
  renderMarkers(near);
  renderList(near, all[0]);
  const o = origin();
  if (radiusCircle) radiusCircle.setLatLng(o).setRadius(state.radius * 1000);
  else radiusCircle = L.circle(o, { radius: state.radius * 1000, color: '#0b7a4b', weight: 1, fillOpacity: 0.05, interactive: false }).addTo(map);
}

function renderMarkers(near) {
  const keep = new Set(near.map((r) => r.s.id));
  for (const [id, m] of state.markers) if (!keep.has(id)) { m.remove(); state.markers.delete(id); }
  const labels = near.length <= LABEL_LIMIT;
  for (const { s } of near) {
    const name = pinName(s);
    const icon = L.divIcon({
      className: 'pin-wrap', iconSize: [16, 16], iconAnchor: [8, 8],
      html: `<div class="pin ${stationStatus(s)} ${isBookable(s) ? 'bookable' : ''}"><i></i>${labels ? `<span>${esc(name.length > 24 ? `${name.slice(0, 23)}…` : name)}</span>` : ''}</div>`,
    });
    const m = state.markers.get(s.id);
    if (m) m.setIcon(icon);
    else state.markers.set(s.id, L.marker([s.lat, s.lng], { icon, title: name }).on('click', () => openStation(s.id)).addTo(map));
  }
}

function renderFilters() {
  const f = state.filters;
  const plugs = ['CCS2', 'Type 2', 'CHAdeMO', 'GB/T DC'];
  $('filters').innerHTML =
    RADII.map((r) => `<button class="chip ${state.radius === r ? 'on' : ''}" data-radius="${r}">${r} km</button>`).join('') +
    '<span class="chip-gap"></span>' +
    `<button class="chip ${f.bookable ? 'on' : ''}" data-f="bookable">Bookable</button>` +
    `<button class="chip ${f.fast ? 'on' : ''}" data-f="fast">Fast (25 kW+)</button>` +
    plugs.map((p) => `<button class="chip ${f.plug === p ? 'on' : ''}" data-plug="${esc(p)}">${esc(p)}</button>`).join('');
}
function setRadius(r) {
  state.radius = r;
  track('radius_changed', { km: r });
  renderFilters(); fitRadius(origin()); refresh();
}
$('filters').onclick = (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  if (b.dataset.radius) return setRadius(Number(b.dataset.radius));
  if (b.dataset.f) state.filters[b.dataset.f] = !state.filters[b.dataset.f];
  if (b.dataset.plug) state.filters.plug = state.filters.plug === b.dataset.plug ? '' : b.dataset.plug;
  track('filter_used', { filter: b.dataset.f || b.dataset.plug });
  renderFilters(); refresh();
};

function renderList(near, nearest) {
  const who = originLabel();
  const head = `<p class="list-head"><strong>${near.length}</strong> charging station${near.length === 1 ? '' : 's'} within ${state.radius} km of ${who}</p>`;
  if (near.length) {
    $('station-list').innerHTML = head + near.slice(0, 100).map(({ s, d }) => {
      const st = stationStatus(s), price = priceOf(s), kw = maxKw(s);
      return `<button class="card" data-station="${esc(s.id)}">
        <div class="row"><span class="title">${esc(pinName(s))}</span><span class="badge ${st}">${STATUS_LABEL[st]}</span></div>
        ${s.operator ? `<div class="small-text">${esc(s.name)}</div>` : ''}
        <div class="muted small-text">${d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`}${kw ? ` · up to ${kw} kW` : ''}${price ? ` · ₹${price}/kWh` : ''}</div>
        ${isBookable(s) ? '<span class="badge neutral">Book a slot</span>' : ''}
      </button>`;
    }).join('') + '<div class="actions" style="justify-content:center"><button class="btn small ghost" data-missing>Know a charger that is missing? Tell us</button></div>';
    return;
  }
  const wider = nearest ? RADII.find((r) => r > state.radius && r >= nearest.d) : null;
  $('station-list').innerHTML = head + `<div class="empty">
    ${nearest ? `<p>The nearest one we know of is <strong>${nearest.d.toFixed(1)} km</strong> away (${esc(pinName(nearest.s))}).</p>` : '<p>No stations match these filters.</p>'}
    <div class="actions" style="justify-content:center">
      ${wider ? `<button class="btn" data-widen="${wider}">Show within ${wider} km</button>` : (nearest ? `<button class="btn" data-goto="${esc(nearest.s.id)}">Show the nearest charger</button>` : '')}
      <button class="btn ghost" data-missing>Know a charger that is missing? Tell us</button>
    </div></div>`;
}
$('station-list').onclick = (e) => {
  const c = e.target.closest('[data-station]'); if (c) return openStation(c.dataset.station);
  const w = e.target.closest('[data-widen]'); if (w) return setRadius(Number(w.dataset.widen));
  const g = e.target.closest('[data-goto]');
  if (g) { const s = state.byId.get(g.dataset.goto); state.browse = true; map.setView([s.lat, s.lng], 14); refresh(); return openStation(s.id); }
  if (e.target.closest('[data-missing]')) openMissingCharger();
};

// ---------- sheet ----------
function dropMiniMap() { if (state.miniMap) { state.miniMap.remove(); state.miniMap = null; } }
function openSheet(html) { dropMiniMap(); $('sheet-body').innerHTML = html; $('sheet').hidden = false; }
function closeSheet() {
  dropMiniMap();
  $('sheet').hidden = true;
  if (state.unsubSlots) { state.unsubSlots(); state.unsubSlots = null; }
}
$('sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

// ---------- station details ----------
function openStation(id) {
  const s = state.byId.get(id); if (!s) return;
  track('station_view', { station_id: s.id, bookable: isBookable(s) });
  if (state.unsubSlots) { state.unsubSlots(); state.unsubSlots = null; }
  const p = partnerOf(s), st = stationStatus(s), price = priceOf(s);
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
  const chargers = s.chargers.map((c, i) => {
    const cs = chargerStatus(s, c);
    const canBook = isBookable(s) && cs !== 'offline';
    return `<div class="charger">
      <div><strong>Charger ${i + 1}</strong> · ${esc(c.plug)}${c.kw ? ` · ${c.kw} kW` : ''}<br>
        <span class="badge ${cs}">${STATUS_LABEL[cs]}</span></div>
      ${canBook ? `<button class="btn small" data-book="${esc(c.id)}">Book</button>` : ''}
    </div>`;
  }).join('');
  openSheet(`
    <h2>${esc(s.name)}</h2>
    <p class="muted">${esc(s.address)}</p>
    <p><span class="badge ${st}">${STATUS_LABEL[st]}</span>
      ${p ? '<span class="badge neutral">Partner station</span>' : ''}</p>
    <p class="small-text muted">${s.operator ? `Operator: ${esc(s.operator)} · ` : ''}${price ? `₹${price}/kWh · ` : ''}${p ? `Open ${esc(p.openTime)}–${esc(p.closeTime)}` : (s.verified ? `Info last verified ${esc(s.verified)}` : '')}</p>
    ${p ? '' : '<div class="note">We do not have live status for this station yet, so it cannot be booked here. You can still navigate to it.<br><button class="btn small ghost" data-want style="margin-top:8px">I would like to book this station</button></div>'}
    <div class="actions">
      <a class="btn" href="${nav}" target="_blank" rel="noopener">Navigate</a>
      <button class="btn ghost" data-report>Report a problem</button>
    </div>
    <h3>Chargers (${s.chargers.length})</h3>
    ${chargers}
    ${isAdmin() ? adminPartnerForm(s) : ''}
  `);
  const body = $('sheet-body');
  body.querySelectorAll('[data-book]').forEach((b) => { b.onclick = () => openSlots(s, b.dataset.book); });
  body.querySelector('[data-report]').onclick = () => openReport(s);
  const want = body.querySelector('[data-want]');
  if (want) want.onclick = () => wantBooking(s, want);
  if (isAdmin()) wireAdminForm(s);
  map.setView([s.lat, s.lng], Math.max(map.getZoom(), 14));
}

// ---------- slots and booking ----------
function openSlots(s, chargerId, date = dateStr(new Date())) {
  if (!state.user) { toast('Please sign in to book a slot.'); return signIn(); }
  const p = partnerOf(s); if (!p) return;
  track('book_start', { station_id: s.id });
  const c = s.chargers.find((x) => x.id === chargerId);
  const idx = s.chargers.indexOf(c);
  const chargerKey = `${s.id}_${c.id}`;
  let picked = [];
  let taken = new Set();

  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return dateStr(d); });
  const allSlots = () => {
    const out = [], now = new Date(), today = dateStr(now), nowMin = now.getHours() * 60 + now.getMinutes();
    for (let m = toMin(p.openTime); m + SLOT_MIN <= toMin(p.closeTime); m += SLOT_MIN) {
      if (date === today && m <= nowMin) continue;
      out.push(fromMin(m));
    }
    return out;
  };

  const draw = () => {
    const slots = allSlots();
    picked = picked.filter((t) => !taken.has(t));
    const hours = (picked.length * SLOT_MIN) / 60, price = priceOf(s);
    const est = price && c.kw ? Math.round(Math.min(c.kw * hours, 60) * price) : null;
    openSheetKeep(`
      <button class="btn small ghost" data-back>← Back</button>
      <h2 style="margin-top:10px">${esc(s.name)}</h2>
      <p class="muted">Charger ${idx + 1} · ${esc(c.plug)}${c.kw ? ` · ${c.kw} kW` : ''}</p>
      <div class="dates">${days.map((d) => `<button class="chip ${d === date ? 'on' : ''}" data-date="${d}">${esc(prettyDate(d))}</button>`).join('')}</div>
      <p class="small-text muted">Pick up to ${MAX_SLOTS} slots in a row (${SLOT_MIN} minutes each).</p>
      <div class="slots">${slots.length ? slots.map((t) => `<button class="slot ${taken.has(t) ? 'taken' : ''} ${picked.includes(t) ? 'picked' : ''}" data-slot="${t}" ${taken.has(t) ? 'disabled' : ''}>${t}</button>`).join('') : '<p class="muted">No slots left on this day.</p>'}</div>
      ${picked.length ? `<div class="summary"><strong>${esc(prettyDate(date))}, ${picked[0]}–${fromMin(toMin(picked[picked.length - 1]) + SLOT_MIN)}</strong><br>
        <span class="small-text">${est ? `Estimated up to ₹${est}. ` : ''}Booking is free. Pay for charging at the station.</span></div>
        <button class="btn block" data-confirm>Confirm booking</button>` : ''}
    `);
    const body = $('sheet-body');
    body.querySelector('[data-back]').onclick = () => openStation(s.id);
    body.querySelectorAll('[data-date]').forEach((b) => { b.onclick = () => openSlots(s, chargerId, b.dataset.date); });
    body.querySelectorAll('[data-slot]').forEach((b) => { b.onclick = () => { pick(b.dataset.slot); draw(); }; });
    const cf = body.querySelector('[data-confirm]');
    if (cf) cf.onclick = () => confirmBooking(s, c, idx, date, picked, cf);
  };

  const pick = (t) => {
    const m = toMin(t);
    if (!picked.length) { picked = [t]; return; }
    const first = toMin(picked[0]), last = toMin(picked[picked.length - 1]);
    if (picked.includes(t)) picked = [];
    else if (m === last + SLOT_MIN && picked.length < MAX_SLOTS) picked.push(t);
    else if (m === first - SLOT_MIN && picked.length < MAX_SLOTS) picked.unshift(t);
    else picked = [t];
  };

  if (state.unsubSlots) state.unsubSlots();
  draw();
  state.unsubSlots = onSnapshot(
    query(collection(db, 'slotLocks'), where('chargerKey', '==', chargerKey), where('date', '==', date)),
    (snap) => { taken = new Set(snap.docs.map((d) => d.data().time)); draw(); },
    (err) => console.error(err),
  );
}
// Re-render the sheet without tearing down the live slot listener.
function openSheetKeep(html) { $('sheet-body').innerHTML = html; $('sheet').hidden = false; }

async function confirmBooking(s, c, idx, date, picked, btn) {
  btn.disabled = true; btn.textContent = 'Booking…';
  try {
    const mine = await getDocs(query(collection(db, 'bookings'), where('uid', '==', state.user.uid)));
    const upcoming = mine.docs.map((d) => d.data()).filter((b) => b.status === 'confirmed' && new Date(`${b.date}T${b.end}`) > new Date());
    if (upcoming.length >= MAX_UPCOMING) {
      toast(`You already have ${MAX_UPCOMING} upcoming bookings. Cancel one to book again.`);
      btn.disabled = false; btn.textContent = 'Confirm booking'; return;
    }
    const p = partnerOf(s);
    const bookingRef = doc(collection(db, 'bookings'));
    const slotIds = picked.map((t) => `${s.id}_${c.id}_${date}_${t.replace(':', '')}`);
    const code = 'EV-' + Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
    const batch = writeBatch(db);
    // Each slot is its own document. The security rules refuse to overwrite an existing
    // lock, so if anyone else holds one of these slots the whole booking fails.
    picked.forEach((t, i) => batch.set(doc(db, 'slotLocks', slotIds[i]), {
      uid: state.user.uid, bookingId: bookingRef.id, stationId: s.id, chargerId: c.id,
      chargerKey: `${s.id}_${c.id}`, date, time: t, createdAt: Date.now(),
    }));
    batch.set(bookingRef, {
      uid: state.user.uid,
      userName: (state.profile?.name || state.user.displayName || 'Driver').split(' ')[0],
      vehicle: state.profile?.vehicle || '',
      stationId: s.id, stationName: s.name, ownerEmail: p.ownerEmail,
      chargerId: c.id, chargerLabel: `Charger ${idx + 1} · ${c.plug}${c.kw ? ` · ${c.kw} kW` : ''}`,
      date, start: picked[0], end: fromMin(toMin(picked[picked.length - 1]) + SLOT_MIN),
      slotIds, status: 'confirmed', code, createdAt: Date.now(),
    });
    await batch.commit();
    track('booking_confirmed', { station_id: s.id, slots: picked.length });
    closeSheet();
    openSheet(`
      <h2>Booking confirmed</h2>
      <p>${esc(s.name)}<br><span class="muted">${esc(prettyDate(date))}, ${picked[0]}–${fromMin(toMin(picked[picked.length - 1]) + SLOT_MIN)}</span></p>
      <div class="summary">Show this code at the station: <span class="code">${code}</span></div>
      <p class="small-text muted">Please arrive within 15 minutes of your start time. Pay for charging at the station.</p>
      <div class="actions">
        <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" rel="noopener">Navigate</a>
        <button class="btn ghost" data-close>Done</button>
      </div>`);
  } catch (err) {
    console.error(err);
    toast(err.code === 'permission-denied' ? 'Sorry, one of those slots was just booked. Please pick again.' : 'Booking failed. Check your internet and try again.');
    if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Confirm booking'; }
  }
}

async function cancelBooking(b, id, newStatus = 'cancelled') {
  const batch = writeBatch(db);
  batch.update(doc(db, 'bookings', id), { status: newStatus, updatedAt: Date.now() });
  (b.slotIds || []).forEach((sid) => batch.delete(doc(db, 'slotLocks', sid)));
  await batch.commit();
}

// ---------- my bookings ----------
async function renderBookings() {
  const el = $('bookings');
  if (!state.user) { el.innerHTML = signInPrompt('Sign in to see your bookings.'); wireSignIn(el); return; }
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const snap = await getDocs(query(collection(db, 'bookings'), where('uid', '==', state.user.uid)));
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (`${b.date}${b.start}`).localeCompare(`${a.date}${a.start}`));
    const now = new Date();
    const isUp = (b) => b.status === 'confirmed' && new Date(`${b.date}T${b.end}`) > now;
    const up = all.filter(isUp).reverse(), past = all.filter((b) => !isUp(b));
    const card = (b, upcoming) => `<div class="card">
      <div class="row"><span class="title">${esc(b.stationName)}</span><span class="badge ${b.status === 'confirmed' ? 'available' : 'offline'}">${esc(b.status.replace('_', ' '))}</span></div>
      <div class="muted small-text">${esc(prettyDate(b.date))}, ${esc(b.start)}–${esc(b.end)} · ${esc(b.chargerLabel)}</div>
      <div class="small-text">Code <span class="code">${esc(b.code)}</span></div>
      ${upcoming ? `<div class="actions"><button class="btn small ghost" data-nav="${esc(b.stationId)}">Navigate</button><button class="btn small danger" data-cancel="${esc(b.id)}">Cancel</button></div>` : ''}
    </div>`;
    el.innerHTML = `<h2>My bookings</h2>
      <h3>Upcoming</h3><div class="list" style="padding:0">${up.map((b) => card(b, true)).join('') || '<div class="empty">No upcoming bookings. Find a partner station on the map to book.</div>'}</div>
      <h3>Past</h3><div class="list" style="padding:0">${past.map((b) => card(b, false)).join('') || '<p class="muted">Nothing here yet.</p>'}</div>`;
    el.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Cancel this booking?')) return;
        btn.disabled = true;
        try { await cancelBooking(all.find((x) => x.id === btn.dataset.cancel), btn.dataset.cancel); toast('Booking cancelled.'); }
        catch (e) { console.error(e); toast('Could not cancel. Try again.'); }
        renderBookings();
      };
    });
    el.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.onclick = () => { const s = state.byId.get(btn.dataset.nav); if (s) window.open(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`, '_blank', 'noopener'); };
    });
  } catch (e) { console.error(e); el.innerHTML = '<div class="empty">Could not load bookings. Check your internet.</div>'; }
}

// ---------- owner panel ----------
const myStations = () => state.stations.filter((s) => partnerOf(s)?.ownerEmail === myEmail() && myEmail());

async function renderOwner() {
  const el = $('owner');
  const mine = myStations();
  if (!mine.length) { el.innerHTML = '<div class="empty">No stations are linked to your account.</div>'; return; }
  let bookings = [];
  try {
    const snap = await getDocs(query(collection(db, 'bookings'), where('ownerEmail', '==', myEmail())));
    bookings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { console.error(e); }
  const today = dateStr(new Date());
  el.innerHTML = '<h2>My stations</h2><p class="muted small-text">Keep each charger\'s status up to date so drivers can trust it.</p>' + mine.map((s) => {
    const up = bookings.filter((b) => b.stationId === s.id && b.status === 'confirmed' && b.date >= today)
      .sort((a, b) => (`${a.date}${a.start}`).localeCompare(`${b.date}${b.start}`));
    return `<h3>${esc(s.name)}</h3><div class="card">
      ${s.chargers.map((c, i) => {
        const cs = chargerStatus(s, c);
        return `<div class="charger"><div><strong>Charger ${i + 1}</strong><br><span class="muted small-text">${esc(c.plug)}${c.kw ? ` · ${c.kw} kW` : ''}</span></div>
          <div class="seg">${['available', 'in_use', 'offline'].map((v) => `<button class="${v} ${cs === v ? 'on' : ''}" data-status="${v}" data-s="${esc(s.id)}" data-c="${esc(c.id)}">${STATUS_LABEL[v]}</button>`).join('')}</div></div>`;
      }).join('')}
    </div>
    <h3>Upcoming bookings (${up.length})</h3>
    <div class="list" style="padding:0">${up.map((b) => `<div class="card">
      <div class="row"><span class="title">${esc(prettyDate(b.date))}, ${esc(b.start)}–${esc(b.end)}</span><span class="code">${esc(b.code)}</span></div>
      <div class="muted small-text">${esc(b.chargerLabel)} · ${esc(b.userName)}${b.vehicle ? ` · ${esc(b.vehicle)}` : ''}</div>
      <div class="actions"><button class="btn small" data-done="${esc(b.id)}">Completed</button><button class="btn small danger" data-noshow="${esc(b.id)}">No-show</button></div>
    </div>`).join('') || '<p class="muted">No upcoming bookings.</p>'}</div>`;
  }).join('');

  el.querySelectorAll('[data-status]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await updateDoc(doc(db, 'partners', btn.dataset.s), { [`chargers.${btn.dataset.c}`]: { status: btn.dataset.status, updatedAt: Date.now() } });
      } catch (e) { console.error(e); toast('Could not update status.'); }
    };
  });
  const finish = (attr, status, free) => el.querySelectorAll(`[${attr}]`).forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute(attr), b = bookings.find((x) => x.id === id);
      btn.disabled = true;
      try {
        if (free) await cancelBooking(b, id, status);
        else await updateDoc(doc(db, 'bookings', id), { status, updatedAt: Date.now() });
        toast('Updated.');
      } catch (e) { console.error(e); toast('Could not update.'); }
      renderOwner();
    };
  });
  finish('data-done', 'completed', false);
  finish('data-noshow', 'no_show', true);
}

// ---------- admin: make a station a bookable partner ----------
function adminPartnerForm(s) {
  const p = partnerOf(s);
  return `<h3>Admin: partner settings</h3>
    <div class="card">
      <label>Owner's Google email (they manage status and see bookings)</label>
      <input type="email" id="ad-email" value="${esc(p?.ownerEmail || '')}" placeholder="owner@gmail.com">
      <div style="display:flex;gap:8px">
        <div style="flex:1"><label>Opens</label><input type="time" id="ad-open" value="${esc(p?.openTime || '06:00')}"></div>
        <div style="flex:1"><label>Closes</label><input type="time" id="ad-close" value="${esc(p?.closeTime || '23:00')}"></div>
      </div>
      <label>Price (₹ per kWh)</label>
      <input type="number" id="ad-price" min="0" step="0.5" value="${esc(p?.pricePerKwh ?? s.pricePerKwh ?? '')}">
      <label><input type="checkbox" id="ad-bookable" ${p?.bookable === false ? '' : 'checked'}> Allow slot booking</label>
      <div class="actions">
        <button class="btn small" id="ad-save">${p ? 'Save' : 'Make partner station'}</button>
        ${p ? '<button class="btn small danger" id="ad-remove">Remove partner</button>' : ''}
      </div>
    </div>`;
}
function wireAdminForm(s) {
  $('ad-save').onclick = async () => {
    const email = $('ad-email').value.trim().toLowerCase();
    const open = $('ad-open').value, close = $('ad-close').value;
    if (!email || !email.includes('@')) return toast('Enter the owner\'s email.');
    if (!open || !close || toMin(close) <= toMin(open)) return toast('Closing time must be after opening time.');
    const existing = partnerOf(s);
    const chargers = existing?.chargers || Object.fromEntries(s.chargers.map((c) => [c.id, { status: 'available', updatedAt: Date.now() }]));
    const price = $('ad-price').value === '' ? null : Number($('ad-price').value);
    try {
      await setDoc(doc(db, 'partners', s.id), { ownerEmail: email, openTime: open, closeTime: close, pricePerKwh: price, bookable: $('ad-bookable').checked, chargers, updatedAt: Date.now() });
      toast('Saved.'); closeSheet();
    } catch (e) { console.error(e); toast('Could not save. Are you signed in as admin?'); }
  };
  const rm = $('ad-remove');
  if (rm) rm.onclick = async () => {
    if (!confirm('Remove this station as a partner? Existing bookings stay in the records.')) return;
    try { await deleteDoc(doc(db, 'partners', s.id)); toast('Removed.'); closeSheet(); }
    catch (e) { console.error(e); toast('Could not remove.'); }
  };
}

// ---------- report a problem ----------
function openReport(s) {
  if (!state.user) { toast('Please sign in to report a problem.'); return signIn(); }
  openSheet(`<h2>Report a problem</h2><p class="muted">${esc(s.name)}</p>
    <label>What is wrong?</label>
    <select id="rp-type"><option value="broken">Charger not working</option><option value="wrong_info">Wrong information</option><option value="blocked">Blocked by a parked vehicle</option><option value="closed">Station closed or removed</option><option value="other">Something else</option></select>
    <label>Details (optional)</label><textarea id="rp-note" rows="3" maxlength="500"></textarea>
    <div class="actions"><button class="btn" id="rp-send">Send report</button></div>`);
  $('rp-send').onclick = async () => {
    try {
      await addDoc(collection(db, 'reports'), { stationId: s.id, stationName: s.name, uid: state.user.uid, type: $('rp-type').value, note: $('rp-note').value.slice(0, 500), status: 'new', createdAt: Date.now() });
      toast('Thank you. We will check it.'); closeSheet();
    } catch (e) { console.error(e); toast('Could not send. Try again.'); }
  };
}

// ---------- profile and sign-in ----------
const signInPrompt = (msg) => `<div class="empty"><p>${esc(msg)}</p><button class="btn" data-signin>Sign in with Google</button></div>`;
const wireSignIn = (el) => el.querySelectorAll('[data-signin]').forEach((b) => { b.onclick = signIn; });

async function signIn() {
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); track('login', { method: 'google' }); }
  catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') await signInWithRedirect(auth, provider);
    else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') { console.error(e); toast('Sign-in failed. Try again.'); }
  }
}
$('btn-account').onclick = () => (state.user ? showView('profile') : signIn());

function renderProfile() {
  const el = $('profile');
  if (!state.user) { el.innerHTML = signInPrompt('Sign in to book slots and save your vehicle.'); wireSignIn(el); return; }
  const pr = state.profile || {};
  const plugs = ['', 'CCS2', 'Type 2', 'CHAdeMO', 'GB/T DC', 'Other / not sure'];
  el.innerHTML = `<h2>Profile</h2><p class="muted">${esc(state.user.email)}${isAdmin() ? ' · Admin' : ''}</p>
    <label>Name</label><input type="text" id="pf-name" maxlength="60" value="${esc(pr.name || state.user.displayName || '')}">
    <label>Vehicle (for example, Tata Nexon EV)</label><input type="text" id="pf-vehicle" maxlength="60" value="${esc(pr.vehicle || '')}">
    <label>Plug type</label><select id="pf-plug">${plugs.map((p) => `<option value="${esc(p)}" ${pr.plug === p ? 'selected' : ''}>${esc(p || 'Choose…')}</option>`).join('')}</select>
    <div class="actions"><button class="btn" id="pf-save">Save</button><button class="btn ghost" id="pf-fb">Give feedback</button><button class="btn ghost" id="pf-out">Sign out</button></div>
    ${isAdmin() ? '<div class="note">Admin: open any station on the map and scroll down to turn it into a bookable partner station.</div>' : ''}
    <p class="small-text muted">We store your name, email, vehicle and bookings to run this service. To delete your data, write to the support contact.</p>`;
  $('pf-save').onclick = async () => {
    const data = { name: $('pf-name').value.trim(), vehicle: $('pf-vehicle').value.trim(), plug: $('pf-plug').value, email: myEmail(), updatedAt: Date.now() };
    try { await setDoc(doc(db, 'users', state.user.uid), data, { merge: true }); state.profile = { ...state.profile, ...data }; toast('Saved.'); }
    catch (e) { console.error(e); toast('Could not save.'); }
  };
  $('pf-out').onclick = () => signOut(auth);
  $('pf-fb').onclick = openFeedback;
}

// ---------- feedback ----------
function openFeedback() {
  let rating = 0;
  openSheet(`<h2>Help us improve</h2>
    <p class="muted">Two quick questions. Your answer goes straight to the team.</p>
    <label>How useful is this app for you? (1 = not useful, 5 = very useful)</label>
    <div class="rating" id="fb-rating">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}">${n}</button>`).join('')}</div>
    <label>What should we add or fix? What were you hoping to do here?</label>
    <textarea id="fb-note" rows="4" maxlength="1000" placeholder="For example: I want to book chargers at Phoenix Mall, or show which chargers are working right now"></textarea>
    <label>${state.user ? `<input type="checkbox" id="fb-ok"> You may contact me at ${esc(state.user.email)}` : 'Phone or email, if we may contact you (optional)'}</label>
    ${state.user ? '' : '<input type="text" id="fb-contact" maxlength="100">'}
    <div class="actions"><button class="btn" id="fb-send">Send feedback</button></div>`);
  $('fb-rating').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    rating = Number(b.dataset.n);
    $('fb-rating').querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) === rating));
  };
  $('fb-send').onclick = async () => {
    const note = $('fb-note').value.trim().slice(0, 1000);
    if (!rating && !note) return toast('Please choose a rating or write a line.');
    const contact = state.user ? ($('fb-ok').checked ? myEmail() : '') : $('fb-contact').value.trim().slice(0, 100);
    try {
      await addDoc(collection(db, 'feedback'), { type: 'feedback', rating, note, contact, uid: state.user?.uid || null, stationId: '', stationName: '', createdAt: Date.now() });
      track('feedback_sent', { rating });
      toast('Thank you! We read every message.'); closeSheet();
    } catch (e) { console.error(e); toast('Could not send. Try again.'); }
  };
}
$('btn-feedback').onclick = openFeedback;

async function wantBooking(s, btn) {
  btn.disabled = true;
  try {
    await addDoc(collection(db, 'feedback'), { type: 'want_booking', rating: 0, note: '', contact: '', uid: state.user?.uid || null, stationId: s.id, stationName: s.name, createdAt: Date.now() });
    track('want_booking', { station_id: s.id });
    btn.textContent = 'Noted. We will try to add it.';
  } catch (e) { console.error(e); btn.disabled = false; toast('Could not send. Try again.'); }
}

// ---------- suggest a missing charger ----------
function openMissingCharger() {
  const startAt = state.pos || [map.getCenter().lat, map.getCenter().lng];
  const wheels = new Set();
  openSheet(`<h2>Add a missing charger</h2>
    <p class="muted">Tell us about a charger we do not show. We will check it and add it to the map.</p>
    <label>Charging company or place name</label>
    <input type="text" id="mc-name" maxlength="80" placeholder="For example: Tata Power, Statiq or Hotel Sunrise">
    <label>Where is it? Drag the pin, or tap the map, to mark the exact spot.</label>
    <div id="mc-map" class="mini-map"></div>
    <button class="btn small ghost" id="mc-here" style="margin-top:8px">Use my current location</button>
    <label>Suitable for (choose all that apply)</label>
    <div class="rating" id="mc-wheels">
      <button data-w="2">2-wheeler</button><button data-w="3">3-wheeler</button><button data-w="4">4-wheeler</button>
    </div>
    <label>Power in kW (optional)</label>
    <input type="number" id="mc-kw" min="0" max="500" step="0.1" inputmode="decimal" placeholder="For example: 3.3, 7.4 or 60">
    <div class="actions"><button class="btn" id="mc-send">Send</button></div>`);

  const mini = L.map('mc-map', { attributionControl: false }).setView(startAt, 16);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mini);
  const pin = L.marker(startAt, { draggable: true }).addTo(mini);
  mini.on('click', (e) => pin.setLatLng(e.latlng));
  state.miniMap = mini;
  setTimeout(() => mini.invalidateSize(), 50);

  $('mc-here').onclick = () => {
    if (!navigator.geolocation) return toast('Location is not available on this device.');
    navigator.geolocation.getCurrentPosition((p) => {
      const here = [p.coords.latitude, p.coords.longitude];
      pin.setLatLng(here); mini.setView(here, 17);
    }, () => toast('Could not get your location. Drag the pin instead.'), { enableHighAccuracy: true, timeout: 8000 });
  };
  $('mc-wheels').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const w = Number(b.dataset.w);
    if (wheels.has(w)) wheels.delete(w); else wheels.add(w);
    b.classList.toggle('on', wheels.has(w));
  };
  $('mc-send').onclick = async () => {
    const name = $('mc-name').value.trim().slice(0, 80);
    if (!name) return toast('Please enter the company or place name.');
    if (!wheels.size) return toast('Please choose 2, 3 or 4-wheeler.');
    const kwRaw = $('mc-kw').value.trim();
    const kw = kwRaw === '' ? null : Number(kwRaw);
    if (kw !== null && !(kw > 0 && kw <= 500)) return toast('Power should be a number between 0 and 500 kW, or left empty.');
    const at = pin.getLatLng();
    $('mc-send').disabled = true;
    try {
      await addDoc(collection(db, 'stationSuggestions'), {
        name, lat: Number(at.lat.toFixed(6)), lng: Number(at.lng.toFixed(6)), kw,
        wheels: [...wheels].sort(), uid: state.user?.uid || null, status: 'new', createdAt: Date.now(),
      });
      track('missing_charger_sent', { wheels: [...wheels].sort().join('') });
      toast('Thank you! We will check it and add it.'); closeSheet();
    } catch (e) { console.error(e); toast('Could not send. Try again.'); if ($('mc-send')) $('mc-send').disabled = false; }
  };
}

// ---------- admin dashboard ----------
async function renderAdmin() {
  const el = $('admin');
  if (!isAdmin()) { el.innerHTML = '<div class="empty">Admins only.</div>'; return; }
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const [u, b, f, r, sg] = await Promise.all(['users', 'bookings', 'feedback', 'reports', 'stationSuggestions'].map((c) => getDocs(collection(db, c))));
    const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const users = rows(u), bookings = rows(b), feedback = rows(f), reports = rows(r);
    const suggestions = rows(sg).filter((x) => x.status !== 'done');
    const now = Date.now(), week = now - 7 * 864e5;
    const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    const newest = (list) => [...list].sort((a, c) => (c.createdAt || 0) - (a.createdAt || 0));
    const upcoming = bookings.filter((x) => x.status === 'confirmed' && new Date(`${x.date}T${x.end}`) > new Date());
    const rated = feedback.filter((x) => x.type === 'feedback' && x.rating > 0);
    const avg = rated.length ? (rated.reduce((n, x) => n + x.rating, 0) / rated.length).toFixed(1) : '–';
    const wants = new Map();
    feedback.filter((x) => x.type === 'want_booking').forEach((x) => wants.set(x.stationName, (wants.get(x.stationName) || 0) + 1));
    const topWants = [...wants.entries()].sort((a, c) => c[1] - a[1]).slice(0, 10);
    const openReports = newest(reports).filter((x) => x.status !== 'resolved');
    const tile = (num, lbl) => `<div class="tile"><div class="num">${esc(num)}</div><div class="lbl">${esc(lbl)}</div></div>`;

    el.innerHTML = `<h2>Admin dashboard</h2>
      <p class="muted small-text">Signed-in users and bookings, live from the database. For visitor counts (including people who did not sign in), open
        <a href="https://console.firebase.google.com/project/${esc(firebaseConfig.projectId)}/analytics" target="_blank" rel="noopener">Google Analytics</a>.</p>
      <div class="tiles">
        ${tile(users.length, 'Signed-up users')}
        ${tile(users.filter((x) => (x.createdAt || 0) > week).length, 'New users, last 7 days')}
        ${tile(users.filter((x) => (x.lastSeenAt || x.createdAt || 0) > week).length, 'Active users, last 7 days')}
        ${tile(state.partners.size, 'Partner stations')}
        ${tile(bookings.length, 'Bookings, all time')}
        ${tile(upcoming.length, 'Upcoming bookings')}
        ${tile(bookings.filter((x) => x.status === 'cancelled').length, 'Cancelled')}
        ${tile(bookings.filter((x) => x.status === 'no_show').length, 'No-shows')}
        ${tile(avg, `Average rating (${rated.length} answers)`)}
        ${tile(openReports.length, 'Open problem reports')}
        ${tile(suggestions.length, 'Missing chargers suggested')}
      </div>

      <h3>Stations people want to book (${topWants.length})</h3>
      <div class="rows">${topWants.map(([name, n]) => `<div class="rowline"><strong>${n}×</strong> ${esc(name)}</div>`).join('') || '<p class="muted">No requests yet.</p>'}</div>

      <h3>Missing chargers people suggested (${suggestions.length})</h3>
      <div class="rows">${newest(suggestions).slice(0, 50).map((x) => `<div class="rowline"><strong>${esc(x.name)}</strong>
        · ${esc((x.wheels || []).map((w) => `${w}-wheeler`).join(', '))}${x.kw ? ` · ${esc(x.kw)} kW` : ''}
        <div class="muted small-text">${esc(when(x.createdAt))} · <a href="https://www.google.com/maps?q=${Number(x.lat)},${Number(x.lng)}" target="_blank" rel="noopener">Open location in Google Maps</a></div>
        <button class="btn small ghost" data-sugdone="${esc(x.id)}" style="margin-top:6px">Mark as handled</button></div>`).join('') || '<p class="muted">No suggestions yet.</p>'}</div>

      <h3>Latest feedback</h3>
      <div class="rows">${newest(feedback.filter((x) => x.type === 'feedback')).slice(0, 30).map((x) => `<div class="rowline">
        ${x.rating ? `<span class="badge neutral">${x.rating}/5</span> ` : ''}${esc(x.note || '(no comment)')}
        <div class="muted small-text">${esc(when(x.createdAt))}${x.contact ? ` · contact: ${esc(x.contact)}` : ''}</div></div>`).join('') || '<p class="muted">No feedback yet.</p>'}</div>

      <h3>Open problem reports</h3>
      <div class="rows">${openReports.slice(0, 30).map((x) => `<div class="rowline"><strong>${esc(x.stationName)}</strong> · ${esc((x.type || '').replace('_', ' '))}
        ${x.note ? `<br>${esc(x.note)}` : ''}<div class="muted small-text">${esc(when(x.createdAt))}</div>
        <button class="btn small ghost" data-resolve="${esc(x.id)}" style="margin-top:6px">Mark resolved</button></div>`).join('') || '<p class="muted">Nothing open.</p>'}</div>

      <h3>Latest users</h3>
      <div class="rows">${newest(users).slice(0, 30).map((x) => `<div class="rowline">${esc(x.name || '(no name)')} · ${esc(x.email || '')}
        <div class="muted small-text">${esc([x.vehicle, x.plug].filter(Boolean).join(' · '))}${x.vehicle || x.plug ? ' · ' : ''}joined ${esc(when(x.createdAt))}</div></div>`).join('') || '<p class="muted">No users yet.</p>'}</div>

      <h3>Latest bookings</h3>
      <div class="rows">${newest(bookings).slice(0, 30).map((x) => `<div class="rowline"><strong>${esc(x.stationName)}</strong> · ${esc(prettyDate(x.date))}, ${esc(x.start)}–${esc(x.end)}
        <div class="muted small-text">${esc(x.userName)}${x.vehicle ? ` · ${esc(x.vehicle)}` : ''} · ${esc((x.status || '').replace('_', ' '))} · booked ${esc(when(x.createdAt))}</div></div>`).join('') || '<p class="muted">No bookings yet.</p>'}</div>`;

    el.querySelectorAll('[data-sugdone]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try { await updateDoc(doc(db, 'stationSuggestions', btn.dataset.sugdone), { status: 'done', updatedAt: Date.now() }); }
        catch (e) { console.error(e); toast('Could not update.'); }
        renderAdmin();
      };
    });
    el.querySelectorAll('[data-resolve]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try { await updateDoc(doc(db, 'reports', btn.dataset.resolve), { status: 'resolved', updatedAt: Date.now() }); }
        catch (e) { console.error(e); toast('Could not update.'); }
        renderAdmin();
      };
    });
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="empty">Could not load the dashboard. Check that the latest database rules are published.</div>';
  }
}

// ---------- navigation ----------
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'map') setTimeout(() => map.invalidateSize(), 0);
  if (name === 'bookings') renderBookings();
  if (name === 'owner') renderOwner();
  if (name === 'profile') renderProfile();
  if (name === 'admin') renderAdmin();
}
document.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); };
const activeView = () => document.querySelector('.view.active').id.replace('view-', '');

function refreshOwnerTab() {
  const has = myStations().length > 0;
  $('tab-owner').hidden = !has;
  if (!has && activeView() === 'owner') showView('map');
  $('tab-admin').hidden = !isAdmin();
  if (!isAdmin() && activeView() === 'admin') showView('map');
}

// ---------- start ----------
onAuthStateChanged(auth, async (user) => {
  state.user = user; state.profile = null;
  $('btn-account').textContent = user ? (user.displayName || 'Account').split(' ')[0] : 'Sign in';
  if (user) {
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) { state.profile = snap.data(); updateDoc(doc(db, 'users', user.uid), { lastSeenAt: Date.now() }).catch(() => {}); }
      else {
        state.profile = { name: user.displayName || '', email: myEmail(), vehicle: '', plug: '', createdAt: Date.now(), lastSeenAt: Date.now() };
        await setDoc(doc(db, 'users', user.uid), state.profile);
      }
      if (state.profile.plug && !state.filters.plug && ['CCS2', 'Type 2', 'CHAdeMO', 'GB/T DC'].includes(state.profile.plug)) {
        state.filters.plug = state.profile.plug; renderFilters(); refresh();
      }
    } catch (e) { console.error(e); }
  }
  refreshOwnerTab();
  showView(activeView());
});

async function start() {
  renderFilters();
  try {
    state.stations = await (await fetch('stations.json')).json();
  } catch (e) { console.error(e); toast('Could not load stations. Check your internet.'); return; }
  state.byId = new Map(state.stations.map((s) => [s.id, s]));
  refresh();
  locate();
  // Links ending in #feedback or #add-charger open that form directly.
  if (location.hash === '#feedback') openFeedback();
  if (location.hash === '#add-charger') openMissingCharger();
  onSnapshot(collection(db, 'partners'), (snap) => {
    state.partners = new Map(snap.docs.map((d) => [d.id, d.data()]));
    refresh(); refreshOwnerTab();
    if (activeView() === 'owner') renderOwner();
  }, (err) => console.error(err));
}
start();
