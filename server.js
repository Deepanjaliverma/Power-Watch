/* ═══════════════════════════════════════════════════
   server.js — PowerWatch Backend (consolidated)

   Combines what used to be db.js, anomaly.js,
   simulator.js, routes/sensors.js, routes/anomalies.js,
   and routes/auth.js into one file, since this is a
   small demo backend and splitting them added files
   without adding real separation of concern.

   HOW TO RUN:
   1. npm install
   2. Create DB 'powerwatch' in pgAdmin
   3. Run database/schema.sql in pgAdmin Query Tool
   4. Update the pool config below with your password
   5. node server.js  (or: npx nodemon server.js)
   ═══════════════════════════════════════════════════ */

"use strict";

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const bcrypt    = require('bcrypt');
const { Pool }  = require('pg');

const app    = express();
const server = http.createServer(app);
const PORT   = 3000;

/* ═══════════════════════════════════════
   DATABASE  (was db.js)
═══════════════════════════════════════ */
const pool = new Pool({
  host:     'localhost',
  port:     5432,
  database: 'powerwatch',   // create this DB in pgAdmin first
  user:     'postgres',     // your pgAdmin username
  password: '@deep0909', // your pgAdmin password
  max:      10,
  idleTimeoutMillis: 30000,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    console.log('   Make sure PostgreSQL is running and credentials are correct');
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});

async function query(sql, params = []) {
  return pool.query(sql, params);
}

/* ═══════════════════════════════════════
   ANOMALY DETECTION  (was anomaly.js)
   DSA: Circular Buffer + Sliding Window z-score
═══════════════════════════════════════ */
const WINDOW_SIZE        = 50;
const WARN_THRESHOLD     = 2.0;
const CRITICAL_THRESHOLD = 3.0;

const sensorBuffers = new Map(); // sensorId -> CircularBuffer

class CircularBuffer {
  constructor(size) {
    this.size  = size;
    this.data  = new Array(size).fill(0);
    this.head  = 0;
    this.count = 0;
  }
  push(val) {
    this.data[this.head] = val;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  toArray() {
    if (this.count < this.size) return this.data.slice(0, this.count);
    const arr = [];
    for (let k = 0; k < this.size; k++) arr.push(this.data[(this.head + k) % this.size]);
    return arr;
  }
  get length() { return this.count; }
}

function getBuffer(sensorId) {
  if (!sensorBuffers.has(sensorId)) sensorBuffers.set(sensorId, new CircularBuffer(WINDOW_SIZE));
  return sensorBuffers.get(sensorId);
}

function computeZScore(newVal, buffer) {
  const arr = buffer.toArray();
  if (arr.length < 5) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / arr.length;
  const std = Math.sqrt(variance);
  if (std < 0.0001) return 0;
  return Math.abs((newVal - mean) / std);
}

function detectAnomaly(sensorId, newValue) {
  const buffer = getBuffer(sensorId);
  const zScore = computeZScore(newValue, buffer);
  buffer.push(newValue);

  let severity = 'NORMAL';
  if      (zScore >= CRITICAL_THRESHOLD) severity = 'CRITICAL';
  else if (zScore >= WARN_THRESHOLD)     severity = 'WARNING';

  return { isAnomaly: severity !== 'NORMAL', severity, zScore: parseFloat(zScore.toFixed(4)) };
}

function resetBuffer(sensorId) { sensorBuffers.delete(sensorId); }

/* ═══════════════════════════════════════
   SIMULATOR  (was simulator.js)
═══════════════════════════════════════ */
const SENSORS = [
  { id: 1, name: 'Voltage_A',   zone: 'Zone A', unit: 'V',  base: 230, noise: 3,   faultMult: 1.28 },
  { id: 2, name: 'Current_A',   zone: 'Zone A', unit: 'A',  base: 45,  noise: 2.5, faultMult: 1.60 },
  { id: 3, name: 'Frequency_A', zone: 'Zone A', unit: 'Hz', base: 50,  noise: 0.15,faultMult: 0.95 },
  { id: 4, name: 'Temp_B',      zone: 'Zone B', unit: '°C', base: 72,  noise: 2,   faultMult: 1.25 },
  { id: 5, name: 'Voltage_B',   zone: 'Zone B', unit: 'V',  base: 230, noise: 3,   faultMult: 1.28 },
  { id: 6, name: 'Current_C',   zone: 'Zone C', unit: 'A',  base: 45,  noise: 2.5, faultMult: 1.55 },
];

const FAULT_PROBABILITY = 0.06;

function generateReading(sensor, injectFault = false) {
  const noise = (Math.random() - 0.5) * sensor.noise * 2;
  let value = sensor.base + noise;
  if (injectFault) {
    const direction = Math.random() > 0.5 ? 1 : -1;
    value = sensor.base * (sensor.faultMult + direction * Math.random() * 0.05);
  }
  return parseFloat(value.toFixed(3));
}

function generateTick() {
  const faultIdx = Math.random() < FAULT_PROBABILITY
    ? Math.floor(Math.random() * SENSORS.length)
    : -1;

  return SENSORS.map((sensor, i) => ({
    sensorId:   sensor.id,
    sensorName: sensor.name,
    zone:       sensor.zone,
    unit:       sensor.unit,
    value:      generateReading(sensor, i === faultIdx),
    timestamp:  new Date().toISOString(),
  }));
}

function startSimulator(intervalMs, onTick) {
  console.log(`🔄 Simulator started — tick every ${intervalMs}ms`);
  return setInterval(() => onTick(generateTick()), intervalMs);
}

/* ═══════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════ */
app.use(cors());
app.use(express.json());
app.use(express.static('../frontend'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/* ═══════════════════════════════════════
   ROUTES: SENSORS  (was routes/sensors.js)
═══════════════════════════════════════ */
const sensorsRouter = express.Router();

sensorsRouter.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM sensors ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

sensorsRouter.get('/readings/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM sensor_readings WHERE sensor_id = $1
       ORDER BY recorded_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

sensorsRouter.post('/', async (req, res) => {
  const { name, zone, unit, base_value, threshold_min, threshold_max } = req.body;
  if (!name || !zone || !unit) return res.status(400).json({ error: 'name, zone, unit are required' });
  try {
    const result = await query(
      `INSERT INTO sensors (name, zone, unit, base_value, threshold_min, threshold_max)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, zone, unit, base_value ?? 0, threshold_min ?? 0, threshold_max ?? 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

sensorsRouter.put('/:id', async (req, res) => {
  const { threshold_min, threshold_max, is_active } = req.body;
  try {
    const result = await query(
      `UPDATE sensors SET
         threshold_min = COALESCE($1, threshold_min),
         threshold_max = COALESCE($2, threshold_max),
         is_active     = COALESCE($3, is_active)
       WHERE id = $4 RETURNING *`,
      [threshold_min, threshold_max, is_active, req.params.id]
    );
    if (result.rows.length === 0) { resetBuffer(parseInt(req.params.id)); return res.status(404).json({ error: 'Sensor not found' }); }
    resetBuffer(parseInt(req.params.id));
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/sensors', sensorsRouter);

/* ═══════════════════════════════════════
   ROUTES: ANOMALIES  (was routes/anomalies.js)
═══════════════════════════════════════ */
const anomaliesRouter = express.Router();

anomaliesRouter.get('/', async (req, res) => {
  const { from, to, zone, severity } = req.query;
  let sql = `
    SELECT a.id, a.value, a.z_score, a.severity,
           a.message, a.detected_at,
           s.name AS sensor, s.zone, s.unit
    FROM anomalies a
    JOIN sensors s ON s.id = a.sensor_id
    WHERE 1=1
  `;
  const params = [];
  let p = 1;

  if (from)     { sql += ` AND a.detected_at >= $${p++}`; params.push(from); }
  if (to)       { sql += ` AND a.detected_at <= $${p++}`; params.push(to + 'T23:59:59'); }
  if (zone)     { sql += ` AND s.zone = $${p++}`;         params.push(zone); }
  if (severity) { sql += ` AND a.severity = $${p++}`;     params.push(severity); }

  sql += ' ORDER BY a.detected_at DESC LIMIT 500';

  try {
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

anomaliesRouter.get('/stats', async (req, res) => {
  try {
    const today    = await query(`SELECT COUNT(*) as count FROM anomalies WHERE DATE(detected_at) = CURRENT_DATE`);
    const week     = await query(`SELECT COUNT(*) as count FROM anomalies WHERE detected_at > NOW() - INTERVAL '7 days'`);
    const critical = await query(`SELECT COUNT(*) as count FROM anomalies WHERE severity = 'CRITICAL' AND DATE(detected_at) = CURRENT_DATE`);
    const avgZ     = await query(`SELECT ROUND(AVG(z_score)::numeric, 2) as avg FROM anomalies WHERE detected_at > NOW() - INTERVAL '24 hours'`);

    res.json({
      today:     parseInt(today.rows[0].count),
      week:      parseInt(week.rows[0].count),
      critical:  parseInt(critical.rows[0].count),
      avgZScore: parseFloat(avgZ.rows[0].avg) || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/anomalies', anomaliesRouter);

/* ═══════════════════════════════════════
   ROUTES: AUTH  (was routes/auth.js)
═══════════════════════════════════════ */
const authRouter = express.Router();

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const result = await query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user  = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // In production: use JWT or express-session
    res.json({ success: true, username: user.username, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: hash a password (used once to seed the admin user)
authRouter.post('/hash', async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  res.json({ hash });
});

app.use('/api/auth', authRouter);

/* ═══════════════════════════════════════
   WEBSOCKET SERVER — broadcasts live data
═══════════════════════════════════════ */
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`🔌 Client connected (${clients.size} total)`);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`🔌 Client disconnected (${clients.size} total)`);
  });

  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'PowerWatch live stream started' }));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

/* ═══════════════════════════════════════
   SIMULATOR → DETECTION → DB → BROADCAST
   Core pipeline
═══════════════════════════════════════ */
startSimulator(1200, async (readings) => {
  for (const reading of readings) {
    try {
      const { isAnomaly, severity, zScore } = detectAnomaly(reading.sensorId, reading.value);

      await query(
        `INSERT INTO sensor_readings (sensor_id, value, is_anomaly) VALUES ($1, $2, $3)`,
        [reading.sensorId, reading.value, isAnomaly]
      );

      if (isAnomaly) {
        const message = `${severity} on ${reading.sensorName} — ${reading.value} ${reading.unit}`;
        await query(
          `INSERT INTO anomalies (sensor_id, value, z_score, severity, message) VALUES ($1, $2, $3, $4, $5)`,
          [reading.sensorId, reading.value, zScore, severity, message]
        );
        console.log(`⚠  [${severity}] ${reading.sensorName}: ${reading.value} ${reading.unit} (z=${zScore})`);
      }

      broadcast({
        type:      isAnomaly ? 'ANOMALY' : 'READING',
        key:       reading.sensorName.toLowerCase().split('_')[0],
        sensorId:  reading.sensorId,
        label:     reading.sensorName,
        zone:      reading.zone,
        unit:      reading.unit,
        value:     reading.value,
        zScore,
        severity,
        isAnomaly,
        timestamp: reading.timestamp,
      });
    } catch (err) {
      console.error('❌ Error processing reading:', err.message);
    }
  }
});

/* ═══════════════════════════════════════
   START SERVER
═══════════════════════════════════════ */
server.listen(PORT, () => {
  console.log('');
  console.log('⚡ PowerWatch Server running!');
  console.log(`   API:       http://localhost:${PORT}/api`);
  console.log(`   Frontend:  http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log('');
});