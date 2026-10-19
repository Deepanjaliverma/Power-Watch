/* ═══════════════════════════════════════════════════
   app.js  —  PowerWatch Frontend (single-page app)

   Combines what used to be dashboard.js + history.js
   + the inline admin/login scripts into one file,
   now that all views live in one index.html.

   DSA USED:
   1. Circular Buffer  →  stores last N sensor readings
   2. Sliding Window    →  z-score on last WINDOW values
   3. Max-Heap          →  priority queue for alerts
   4. Hash Map          →  O(1) sensor config lookup
   ═══════════════════════════════════════════════════ */

"use strict";

/* ════════════════════════════════════
   VIEW ROUTER
   Swaps which <section class="view"> is visible
   and lazy-inits each view the first time it's shown
════════════════════════════════════ */
const initedViews = { dashboard: false, history: false, admin: false, login: false };

function showView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view-' + view);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll(`.nav-links a[data-view="${view}"]`).forEach(a => a.classList.add('active'));

  if (!initedViews[view]) {
    initedViews[view] = true;
    if (view === 'dashboard') initDashboard();
    if (view === 'history')   initHistory();
    if (view === 'admin')     initAdmin();
  }
}

function routeFromHash() {
  const view = (location.hash || '#dashboard').replace('#', '');
  showView(['dashboard', 'history', 'admin', 'login'].includes(view) ? view : 'dashboard');
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('a[data-view]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = a.dataset.view;
    });
  });
  window.addEventListener('hashchange', routeFromHash);
  routeFromHash();
  updateClock();
  setInterval(updateClock, 1000);
});

function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

/* ═══════════════════════════════════════════════════
   ═══  DASHBOARD VIEW  ═══
═══════════════════════════════════════════════════ */

// ── DSA #1: Circular Buffer ──
class CircularBuffer {
  constructor(size) {
    this.size   = size;
    this.buffer = new Array(size).fill(0);
    this.head   = 0;
    this.count  = 0;
  }
  push(val) {
    this.buffer[this.head] = val;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  toArray() {
    if (this.count < this.size) return this.buffer.slice(0, this.count);
    const arr = [];
    for (let k = 0; k < this.size; k++) arr.push(this.buffer[(this.head + k) % this.size]);
    return arr;
  }
  get length() { return this.count; }
}

// ── DSA #2: Sliding-window z-score ──
function computeZScore(newVal, history) {
  const arr = history.toArray();
  if (arr.length < 5) return 0;
  const mean = arr.reduce((sum, v) => sum + v, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return Math.abs((newVal - mean) / std);
}

// ── DSA #3: Max-Heap (priority queue for alerts) ──
class MaxHeap {
  constructor() { this.heap = []; }
  push(item) { this.heap.push(item); this._bubbleUp(this.heap.length - 1); }
  pop() {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) { this.heap[0] = last; this._sinkDown(0); }
    return top;
  }
  _bubbleUp(i) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].priority >= this.heap[i].priority) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }
  _sinkDown(i) {
    const n = this.heap.length;
    while (true) {
      let largest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.heap[l].priority > this.heap[largest].priority) largest = l;
      if (r < n && this.heap[r].priority > this.heap[largest].priority) largest = r;
      if (largest === i) break;
      [this.heap[i], this.heap[largest]] = [this.heap[largest], this.heap[i]];
      i = largest;
    }
  }
  size() { return this.heap.length; }
}

// ── DSA #4: Hash Map (sensor config) ──
const SensorMap = new Map([
  ['volt', { label: 'Voltage_A',  unit: 'V',  base: 230, noise: 4,  faultMult: 1.28 }],
  ['curr', { label: 'Current_A',  unit: 'A',  base: 45,  noise: 3,  faultMult: 1.55 }],
  ['freq', { label: 'Freq_A',     unit: 'Hz', base: 50,  noise: 0.2,faultMult: 0.96 }],
  ['temp', { label: 'Temp_B',     unit: '°C', base: 72,  noise: 2,  faultMult: 1.22 }],
]);

const BUFFER_SIZE = 50;
const MAX_POINTS  = 30;

const histories = {
  volt: new CircularBuffer(BUFFER_SIZE),
  curr: new CircularBuffer(BUFFER_SIZE),
  freq: new CircularBuffer(BUFFER_SIZE),
  temp: new CircularBuffer(BUFFER_SIZE),
};

const alertHeap = new MaxHeap();
let totalFaults = 0;
let critFaults  = 0;
let bannerTimer = null;
let statusTimer = null;
let dashboardTickHandle = null;
let charts = {};

const CHART_COLORS = {
  volt: { border: '#f97316', fill: 'rgba(249,115,22,0.08)' },
  curr: { border: '#facc15', fill: 'rgba(250,204,21,0.08)' },
  freq: { border: '#22c55e', fill: 'rgba(34,197,94,0.08)' },
  temp: { border: '#f87171', fill: 'rgba(248,113,113,0.08)' },
};

const chartConfig = (id) => {
  const c = CHART_COLORS[id];
  return {
    type: 'line',
    data: {
      labels: Array(MAX_POINTS).fill(''),
      datasets: [{
        data: Array(MAX_POINTS).fill(null),
        borderColor: c.border,
        backgroundColor: c.fill,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          grid: { color: 'rgba(61,53,51,0.35)' },
          ticks: { color: '#78716c', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 4 }
        }
      }
    }
  };
};

function initDashboard() {
  charts = {
    volt: new Chart(document.getElementById('chartVolt'), chartConfig('volt')),
    curr: new Chart(document.getElementById('chartCurr'), chartConfig('curr')),
    freq: new Chart(document.getElementById('chartFreq'), chartConfig('freq')),
    temp: new Chart(document.getElementById('chartTemp'), chartConfig('temp')),
  };
  dashboardTickHandle = setInterval(tick, 1200);
}

function pushChart(key, val, isAnomaly) {
  const ds = charts[key].data.datasets[0];
  ds.data.push(val);
  if (ds.data.length > MAX_POINTS) ds.data.shift();
  ds.pointRadius = ds.data.map((_, i) => i === ds.data.length - 1 && isAnomaly ? 5 : 0);
  ds.pointBackgroundColor = ds.data.map((_, i) => i === ds.data.length - 1 && isAnomaly ? '#ef4444' : 'transparent');
  charts[key].update('none');
}

function updateStatCard(key, value, z) {
  const cfg  = SensorMap.get(key);
  const card = document.getElementById('sc-' + key);
  const val  = document.getElementById('sv-' + key);
  const badge= document.getElementById('sb-' + key);

  val.innerHTML = value + '<span class="stat-unit">' + cfg.unit + '</span>';
  card.className = 'stat-card';
  if (z > 3) {
    card.classList.add('crit');
    badge.className  = 'stat-badge badge-crit';
    badge.textContent = '● CRITICAL';
  } else if (z > 2) {
    card.classList.add('warn');
    badge.className  = 'stat-badge badge-warn';
    badge.textContent = '● WARNING';
  } else {
    badge.className  = 'stat-badge badge-ok';
    badge.textContent = '● NORMAL';
  }
}

function showBanner(msg) {
  const b = document.getElementById('anomalyBanner');
  document.getElementById('bannerMsg').textContent = msg;
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), 5000);
}

function updateSystemStatus(severity) {
  const pill = document.getElementById('sysPill');
  const txt  = document.getElementById('sysText');
  pill.className = 'status-pill ' + severity;
  txt.textContent = severity === 'critical' ? 'FAULT DETECTED'
                  : severity === 'warning'  ? 'WARNING'
                  : 'ALL NORMAL';
  clearTimeout(statusTimer);
  if (severity !== '') statusTimer = setTimeout(() => updateSystemStatus(''), 6000);
}

function addAlertItem(label, val, unit, z, severity) {
  const feed = document.getElementById('alertFeed');
  const now  = new Date().toLocaleTimeString();
  const el   = document.createElement('div');
  el.className = 'alert-item ' + (severity === 'CRITICAL' ? 'crit' : severity === 'WARNING' ? 'warn' : 'ok');
  el.innerHTML = `
    <div class="alert-time">${now}</div>
    <div class="alert-msg">${severity === 'CRITICAL' ? '🔴' : '🟡'} ${label}</div>
    <div class="alert-val">${val} ${unit} &nbsp;·&nbsp; z=${z.toFixed(2)}</div>
  `;
  feed.insertBefore(el, feed.firstChild);
  while (feed.children.length > 8) feed.removeChild(feed.lastChild);
}

function generateReading(key, injectFault) {
  const cfg = SensorMap.get(key);
  let val = cfg.base + (Math.random() - 0.5) * cfg.noise * 2;
  if (injectFault) val *= (cfg.faultMult + (Math.random() - 0.5) * 0.05);
  return parseFloat(val.toFixed(2));
}

function tick() {
  const faultKey = Math.random() < 0.07
    ? [...SensorMap.keys()][Math.floor(Math.random() * 4)]
    : null;

  for (const [key] of SensorMap) {
    const isFault = key === faultKey;
    const val     = generateReading(key, isFault);
    const cfg     = SensorMap.get(key);

    histories[key].push(val);
    const z = computeZScore(val, histories[key]);
    const isAnomaly = z > 2;

    updateStatCard(key, val, z);
    pushChart(key, val, isAnomaly);

    if (isAnomaly) {
      const severity = z > 3 ? 'CRITICAL' : 'WARNING';
      alertHeap.push({ priority: z, key, val, severity, unit: cfg.unit, label: cfg.label });

      totalFaults++;
      if (severity === 'CRITICAL') critFaults++;
      document.getElementById('totalFaults').textContent = totalFaults;
      document.getElementById('critCount').textContent   = critFaults;

      const heapSizeEl = document.getElementById('heapSize');
      if (heapSizeEl) heapSizeEl.textContent = alertHeap.size() + ' items';

      addAlertItem(cfg.label, val, cfg.unit, z, severity);
      showBanner(`${cfg.label} · ${val} ${cfg.unit} · z=${z.toFixed(2)}`);
      updateSystemStatus(severity === 'CRITICAL' ? 'critical' : 'warning');
    }
  }
}

/* ═══════════════════════════════════════════════════
   ═══  HISTORY VIEW  ═══
═══════════════════════════════════════════════════ */

const API = 'http://localhost:3000/api';
const PAGE_SIZE = 10;

let allData     = [];
let filtered    = [];
let currentPage = 1;

function initHistory() { loadData(); }

async function loadData() {
  try {
    const res = await fetch(`${API}/anomalies`);
    allData   = await res.json();
  } catch {
    allData = generateDemoData(80);
  }
  filtered = [...allData];
  updateSummary();
  renderTable();
  renderPagination();
}

function generateDemoData(n) {
  const sensors    = ['Voltage_A','Current_A','Freq_A','Temp_B','Voltage_B','Current_C'];
  const zones      = ['Zone A','Zone A','Zone A','Zone B','Zone B','Zone C'];
  const units      = ['V','A','Hz','°C','V','A'];
  const data = [];

  for (let i = 0; i < n; i++) {
    const idx  = Math.floor(Math.random() * sensors.length);
    const z    = (2 + Math.random() * 2.5).toFixed(2);
    const sev  = parseFloat(z) > 3 ? 'CRITICAL' : 'WARNING';
    const base = [230, 45, 50, 72, 230, 45][idx];
    const val  = (base * (1.1 + Math.random() * 0.3)).toFixed(1);
    const d    = new Date(Date.now() - i * 1000 * 60 * (5 + Math.random() * 30));
    data.push({
      id: i + 1,
      sensor: sensors[idx],
      zone:   zones[idx],
      value:  val,
      unit:   units[idx],
      z_score: z,
      severity: sev,
      message: `${sev === 'CRITICAL' ? 'Fault' : 'Anomaly'} on ${sensors[idx]}`,
      timestamp: d.toISOString(),
    });
  }
  return data.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function updateSummary() {
  const today      = new Date().toDateString();
  const todayItems = allData.filter(d => new Date(d.timestamp).toDateString() === today);
  const weekAgo    = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekItems  = allData.filter(d => new Date(d.timestamp) > weekAgo);
  const crits      = allData.filter(d => d.severity === 'CRITICAL');
  const avgZ       = allData.length
    ? (allData.reduce((s, d) => s + parseFloat(d.z_score), 0) / allData.length).toFixed(2)
    : '0.00';

  document.getElementById('s-today').textContent  = todayItems.length;
  document.getElementById('s-week').textContent   = weekItems.length;
  document.getElementById('s-crit').textContent   = crits.length;
  document.getElementById('s-zscore').textContent = avgZ;
}

function renderTable() {
  const tbody = document.getElementById('tableBody');
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = slice.map(row => {
    const t = new Date(row.timestamp).toLocaleTimeString();
    const sevClass = row.severity === 'CRITICAL' ? 'sev-crit' : 'sev-warn';
    const sevIcon  = row.severity === 'CRITICAL' ? '🔴' : '🟡';
    return `
      <tr>
        <td>${t}</td>
        <td>${row.sensor}</td>
        <td>${row.zone}</td>
        <td>${row.value} ${row.unit}</td>
        <td>${parseFloat(row.z_score).toFixed(2)}</td>
        <td><span class="sev ${sevClass}">${sevIcon} ${row.severity}</span></td>
        <td style="color:var(--muted);font-family:var(--sans)">${row.message}</td>
      </tr>
    `;
  }).join('');

  if (slice.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No records found</td></tr>';
  }
}

function renderPagination() {
  const total = Math.ceil(filtered.length / PAGE_SIZE);
  const pg    = document.getElementById('pagination');
  let html    = `<button class="pg-btn" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>← Prev</button>`;

  for (let i = 1; i <= Math.min(total, 5); i++) {
    html += `<button class="pg-btn ${i===currentPage?'active':''}" onclick="goPage(${i})">${i}</button>`;
  }
  html += `<button class="pg-btn" onclick="goPage(${currentPage+1})" ${currentPage===total?'disabled':''}>Next →</button>`;
  pg.innerHTML = html;
}

function goPage(n) {
  const total = Math.ceil(filtered.length / PAGE_SIZE);
  if (n < 1 || n > total) return;
  currentPage = n;
  renderTable();
  renderPagination();
}

function applyFilters() {
  const from   = document.getElementById('fromDate').value;
  const to     = document.getElementById('toDate').value;
  const zone   = document.getElementById('zoneFilter').value;
  const sev    = document.getElementById('sevFilter').value;
  const search = document.getElementById('searchInput').value.toLowerCase();

  filtered = allData.filter(d => {
    const ts = new Date(d.timestamp);
    if (from && ts < new Date(from)) return false;
    if (to   && ts > new Date(to + 'T23:59:59')) return false;
    if (zone && d.zone !== zone)     return false;
    if (sev  && d.severity !== sev)  return false;
    if (search && !d.sensor.toLowerCase().includes(search)) return false;
    return true;
  });

  currentPage = 1;
  renderTable();
  renderPagination();
}

function clearFilters() {
  ['fromDate','toDate','zoneFilter','sevFilter','searchInput'].forEach(id => {
    document.getElementById(id).value = '';
  });
  filtered = [...allData];
  currentPage = 1;
  renderTable();
  renderPagination();
}

function exportCSV() {
  const headers = ['Time','Sensor','Zone','Value','Unit','Z-Score','Severity','Message'];
  const rows    = filtered.map(d => [
    new Date(d.timestamp).toLocaleString(),
    d.sensor, d.zone, d.value, d.unit, d.z_score, d.severity, d.message
  ]);

  const csv  = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `powerwatch_anomalies_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════════
   ═══  ADMIN VIEW  ═══
═══════════════════════════════════════════════════ */

function initAdmin() {
  const heapSizeEl = document.getElementById('heapSize');
  if (heapSizeEl) heapSizeEl.textContent = alertHeap.size() + ' items';
}

function saveSettings() { showToast('✓ Settings saved successfully'); }

function addSensorModal() {
  alert('Add Sensor modal — connect to POST /api/sensors in Node.js backend');
}

/* ═══════════════════════════════════════════════════
   ═══  LOGIN VIEW  ═══
═══════════════════════════════════════════════════ */

function doLogin() {
  const u = document.getElementById('username').value;
  const p = document.getElementById('password').value;

  if (!u || !p) { showToast('Please enter username and password'); return; }

  // In production: POST to /api/auth/login
  if (u === 'admin' && p === 'admin123') {
    showToast('✓ Login successful! Redirecting...');
    setTimeout(() => { location.hash = 'admin'; }, 1200);
  } else {
    showToast('❌ Invalid credentials');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('view-login').classList.contains('active')) {
    doLogin();
  }
});

/* ═══════════════════════════════════════════════════
   WEBSOCKET (production backend) — optional
   Uncomment to replace the dashboard's simulated tick()
   with live data from the Node.js server.
═══════════════════════════════════════════════════ */
/*
const ws = new WebSocket('ws://localhost:3000');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  histories[data.key].push(data.value);
  updateStatCard(data.key, data.value, data.zScore);
  pushChart(data.key, data.value, data.zScore > 2);
  if (data.severity !== 'NORMAL') {
    totalFaults++;
    if (data.severity === 'CRITICAL') critFaults++;
    document.getElementById('totalFaults').textContent = totalFaults;
    document.getElementById('critCount').textContent   = critFaults;
    addAlertItem(data.label, data.value, data.unit, data.zScore, data.severity);
    showBanner(`${data.label} · ${data.value} ${data.unit}`);
    updateSystemStatus(data.severity === 'CRITICAL' ? 'critical' : 'warning');
  }
};
ws.onerror = () => showToast('WebSocket disconnected — using simulation');
if (dashboardTickHandle) clearInterval(dashboardTickHandle);
*/