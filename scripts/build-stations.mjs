// Converts raw Open Charge Map data into the compact stations.json the web app loads.
// Usage: node scripts/build-stations.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('data/in_stations_raw.json', 'utf8'));
const ref = JSON.parse(readFileSync('data/ocm_reference.json', 'utf8'));

const operators = new Map(ref.Operators.map((o) => [o.ID, o.Title]));
const connTitles = new Map(ref.ConnectionTypes.map((c) => [c.ID, c.Title.trim()]));
const PLUG = { 33: 'CCS2', 1036: 'Type 2', 25: 'Type 2', 2: 'CHAdeMO', 1040: 'GB/T DC', 34: 'IEC 60309', 0: 'Unknown' };
const MAX_PER_CONNECTION = 6;

const cleanOperator = (id) => {
  const t = operators.get(id);
  if (!t || t.startsWith('(')) return '';
  return t.replace(/\s*\((IN|India)\)\s*$/i, '').trim();
};

const parseCost = (s) => {
  const m = /([\d.]+)\s*\/\s*kwh/i.exec(s || '');
  return m ? Number(m[1]) : null;
};

const stations = [];
for (const s of raw) {
  const a = s.AddressInfo || {};
  if (typeof a.Latitude !== 'number' || typeof a.Longitude !== 'number') continue;
  const chargers = [];
  for (const c of s.Connections || []) {
    const plug = PLUG[c.ConnectionTypeID] ?? connTitles.get(c.ConnectionTypeID) ?? 'Unknown';
    const qty = Math.min(Math.max(c.Quantity || 1, 1), MAX_PER_CONNECTION);
    for (let i = 0; i < qty; i++) {
      chargers.push({ id: `c${chargers.length + 1}`, plug, kw: c.PowerKW || null });
    }
  }
  if (!chargers.length) continue;
  stations.push({
    id: `ocm${s.ID}`,
    name: (a.Title || 'Charging station').trim(),
    address: [a.AddressLine1, a.AddressLine2, a.Town, a.Postcode].filter(Boolean).map((x) => x.trim()).join(', '),
    lat: Number(a.Latitude.toFixed(6)),
    lng: Number(a.Longitude.toFixed(6)),
    operator: cleanOperator(s.OperatorID),
    pricePerKwh: parseCost(s.UsageCost),
    operational: s.StatusTypeID !== 100 && s.StatusTypeID !== 150 && s.StatusTypeID !== 200,
    verified: (s.DateLastVerified || '').slice(0, 10),
    chargers,
  });
}

writeFileSync('docs/stations.json', JSON.stringify(stations));
const total = stations.reduce((n, s) => n + s.chargers.length, 0);
console.log(`${stations.length} stations, ${total} chargers -> docs/stations.json`);
