# Power-Watch
PowerWatch — Smart Grid Anomaly Detection System
PowerWatch is a real-time dashboard that watches electrical sensor readings
(voltage, current, frequency, temperature) and automatically flags unusual
readings as warnings or critical faults using statistics — no manual
thresholds needed.
1. What this project does
Shows live sensor readings on a Dashboard with animated charts
Automatically detects abnormal readings using a method called z-score
Logs every detected fault in a searchable History page
Lets an Admin manage sensors and system settings
Has a Login page to protect the Admin panel
Project Structure
PowerWatch/
├── frontend/
│   ├── index.html      → the single page containing all 4 views (Dashboard, History, Admin, Login)
│   ├── style.css        → all visual styling
│   └── app.js            → all frontend logic (charts, z-score, tables, login)
├── backend/
│   ├── server.js         → the Node.js server (API + WebSocket + database + anomaly detection)
│   └── package.json      → list of backend dependencies
└── schema.sql             → database table definitions (run this in pgAdmin)
Rule to remember: frontend/ runs in your browser. backend/ runs in your terminal as a separate process. They talk to each other over the network (http://localhost:3000), never through a <script> tag.
3. How the anomaly detection works (z-score)
Every sensor keeps its last 50 readings in memory (a "circular buffer").
For every new reading, PowerWatch calculates:
mean = average of the last 50 readings
std  = how spread out those readings normally are
z    = |new reading − mean| / std
z > 3 → 🔴 CRITICAL fault
z > 2 → 🟡 WARNING
z ≤ 2 → 🟢 NORMAL
This adapts automatically to each sensor's own normal range, instead of using one fixed number for every sensor type.
4. Step-by-step setup
Step 1 — Install Node.js
Download and install from nodejs.org if you haven't already.
Step 2 — Install PostgreSQL + pgAdmin
Download from postgresql.org. pgAdmin usually comes bundled with it.
Step 3 — Create the database
Open pgAdmin
Right-click Databases → Create → Database
Name it powerwatch → Save
Click on powerwatch → open Query Tool
Paste the contents of schema.sql → click ▶️ Run
This creates 4 tables: sensors, sensor_readings, anomalies, users.
Step 4 — Set up the backend
Open a terminal inside the backend folder:
cd PowerWatch/backend
npm install
This downloads all required packages (express, pg, ws, bcrypt, cors) — requires internet the first time only.
Step 5 — Connect your database password
Open server.js, find this part near the top, and replace the password:
const pool = new Pool({
  host:     'localhost',
  port:     5432,
  database: 'powerwatch',
  user:     'postgres',
  password: 'your_password',  // ← put your real PostgreSQL password here
});
Step 6 — Generate a real admin password hash
The default schema.sql has a placeholder password hash. Generate a real one:
node -e "const b=require('bcrypt');b.hash('admin123',10).then(h=>console.log(h))"
Copy the output, then run this in pgAdmin's Query Tool:
UPDATE users SET password_hash = 'PASTE_HASH_HERE' WHERE username = 'admin';
Step 7 — Start the backend
npm run dev
You should see:
✅ Database connected successfully
⚡ PowerWatch Server running!
   API:       http://localhost:3000/api
   Frontend:  http://localhost:3000
   WebSocket: ws://localhost:3000
Step 8 — Open the app
In your browser, go to:
http://localhost:3000
This is the correct way to open it — not by double-clicking index.html directly, since that skips the backend connection.
5. Logging in
Default admin credentials (unless you changed the hash in Step 6):
Username: admin
Password: admin123
⚠️ Note: the Admin panel's "Save Settings" button is currently just a visual placeholder — it shows a confirmation message but doesn't actually save to the database yet. Real login protection also needs a server-side check (see Section 7 below) — right now the login screen can be bypassed by directly clicking "Admin" in the nav, since nothing blocks that yet.
6. WebSocket (live data) — optional
By default, the Dashboard generates simulated data inside the browser
(setInterval(tick, 1200) in app.js), so it works even without the backend running.
To switch to real live data pushed from the backend:
Open frontend/js/app.js
Find the commented-out WebSocket block near the bottom and uncomment it
Remove or comment out dashboardTickHandle = setInterval(tick, 1200); inside initDashboard()
Now readings come from the server's simulator → anomaly detector → PostgreSQL → broadcast to your browser in real time.
7. Known limitations (good to know if presenting this project)
Admin login isn't actually enforced yet — clicking "Admin" in the nav shows the panel even without logging in. The Login page exists but nothing currently blocks access without it.
Login only accepts the hardcoded admin / admin123 — typing a different username/password in the Admin Settings form doesn't change what's accepted, since that form isn't wired to the database yet.
Dashboard data is simulated by default — enable WebSocket (Section 6) for real backend-driven data.
These are natural "next steps" to extend the project — not bugs, just features not yet wired end-to-end.
8. Tech Stack
Layer
Technology
Frontend
HTML5, CSS3, JavaScript, Chart.js
Backend
Node.js, Express.js
Real-time
WebSocket (ws library)
Database
PostgreSQL
Auth
bcrypt password hashing
9. API Endpoints
GET  /api/sensors              → list all sensors
GET  /api/sensors/readings/:id → last 100 readings for a sensor
POST /api/sensors               → add a new sensor
PUT  /api/sensors/:id           → update a sensor's thresholds
GET  /api/anomalies             → all logged anomalies (filterable)
GET  /api/anomalies/stats       → summary counts
POST /api/auth/login            → admin login check
WS   ws://localhost:3000        → live data stream
