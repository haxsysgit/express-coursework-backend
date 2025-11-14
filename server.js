// --- Core dependencies (think: Flask + tooling in Python) ---
// Express → like Flask: defines routes and middleware.
const express = require('express');
// CORS → like Flask-CORS: controls which origins can call the API.
const cors = require('cors');
// Path → Node's pathlib equivalent for safe path joins.
const path = require('path');
// Helmet → similar to Flask-Talisman for security headers.
const helmet = require('helmet');
// Crypto → used here like Python's uuid module for request IDs.
const crypto = require('crypto');
// Compression → comparable to using Flask-Compress.
const compression = require('compression');
// express-rate-limit → akin to Flask-Limiter for throttling.
const rateLimit = require('express-rate-limit');
// MongoDB driver → Python analogue would be pymongo.
const { MongoClient, ObjectId } = require('mongodb');
// Dotenv → like python-dotenv to load .env files.
const dotenv = require('dotenv');

// Load env vars from Backend/.env (URI, DB name, CORS origins) just like load_dotenv()
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
// Trust proxy like Flask's ProxyFix to keep req.ip accurate behind reverse proxies.
app.set('trust proxy', 1);

// --- Global middleware (rough Python equivalents in comments) ---
// Helmet ≈ Flask-Talisman: security headers
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// Fast JSON parser with payload cap (Flask's request.get_json + max content-length)
app.use(express.json({ limit: '100kb' }));
// Compression ≈ Flask-Compress
app.use(compression());
// Simple request ID middleware (Flask alternative: before_request generating g.request_id)
app.use((req, res, next) => {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', id);
  req.requestId = id;
  next();
});

// --- CORS allowlist (like configuring Flask-CORS with origins=...) ---
const normalizeOrigin = (value) => {
  if (!value) return '';
  return value.replace(/\/$/, '').toLowerCase();
};
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).map(normalizeOrigin);
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = normalizeOrigin(origin);
    const pass = !allowedOrigins.length || allowedOrigins.some(allowed => allowed === normalized || allowed.startsWith(normalized + '/'));
    if (pass) return callback(null, true);
    console.warn(`[cors] Blocked origin ${origin}`);
    return callback(null, false);
  },
  methods: ['GET','POST','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Request-Id'],
  credentials: false
}));

// Request logger similar to Flask's after_request hooks printing method/status/duration
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(new Date().toISOString(), req.requestId, req.ip, req.method, req.originalUrl, res.statusCode, ms + 'ms');
  });
  next();
});

// Global + route-specific throttling (Flask-Limiter style)
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/search', searchLimiter);
const ordersLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
app.use('/orders', ordersLimiter);

// Static file serving; imagine Flask's send_from_directory for /imgs
const imgsDir = path.join(__dirname, 'imgs');
app.use('/imgs', express.static(imgsDir, { maxAge: '1d', immutable: true }));
app.use('/imgs', (req, res) => {
  res.status(404).json({ error: 'Image not found' });
});

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'coursework-backend';
let client;
let database;

// Lazy connection helper similar to creating a pymongo MongoClient once per process
async function getDb() {
  if (database) return database;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  await client.connect();
  database = client.db(dbName);
  return database;
}

// ObjectId casting helper (Python equivalent: bson.ObjectId)
function toObjectIdSafe(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

// Escape user regex input (Python analogue: re.escape)
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Normalise incoming order payloads; similar to validating request.json in Flask
function buildOrderDoc(body) {
  const { name, phone, lessonIDs, space, items } = body || {};
  const nameOk = typeof name === 'string' && /^[A-Za-z ]+$/.test(name);
  const phoneOk = typeof phone === 'string' && /^[0-9]+$/.test(phone);
  if (!nameOk || !phoneOk) return { error: 'Invalid name or phone' };

  if (Array.isArray(items) && items.length) {
    for (const it of items) {
      const n = Number(it.space);
      if (!Number.isFinite(n) || n <= 0) return { error: 'Each item.space must be a positive number' };
    }
    const normalized = items.map(it => {
      const id = it.lessonId || it.lessonID || it.id;
      const oid = toObjectIdSafe(id);
      return { lessonId: oid ? oid : String(id), space: Number(it.space) };
    });
    return { doc: { name, phone, items: normalized, createdAt: new Date() } };
  }

  if (Array.isArray(lessonIDs) && lessonIDs.length && typeof space !== 'undefined') {
    const s = Number(space);
    if (!Number.isFinite(s) || s <= 0) return { error: 'space must be a positive number' };
    const ids = lessonIDs.map(id => toObjectIdSafe(id) || String(id));
    return { doc: { name, phone, lessonIDs: ids, space: s, createdAt: new Date() } };
  }

  return { error: 'Provide items[] or lessonIDs[] with space' };
}

// Express route ≈ @app.route('/lessons') in Flask
app.get('/lessons', async (req, res) => {
  try {
    const db = await getDb();
    const q = {};
    let { limit, skip, sort, order } = req.query;
    let lim = Math.min(100, Math.max(1, Number(limit) || 50));
    let sk = Math.max(0, Number(skip) || 0);
    const sortable = { topic: 1, location: 1, price: 1, space: 1, _id: 1 };
    let sortKey = Object.prototype.hasOwnProperty.call(sortable, sort) ? sort : '_id';
    let sortDir = String(order).toLowerCase() === 'desc' ? -1 : 1;
    const cursor = db.collection('lesson').find(q).sort({ [sortKey]: sortDir }).skip(sk).limit(lim);
    const lessons = await cursor.toArray();
    res.json(lessons);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch lessons' });
  }
});

// Search endpoint behaving like a Flask view using pymongo find()
app.get('/search', async (req, res) => {
  try {
    const termRaw = (req.query.term || '').toString();
    const term = termRaw.trim();
    if (!term) return res.json([]);
    const re = new RegExp(escapeRegex(term), 'i');
    const reStr = escapeRegex(term);
    const db = await getDb();
    const results = await db.collection('lesson').find({
      $or: [
        { topic: { $regex: re } },
        { location: { $regex: re } },
        { $expr: { $regexMatch: { input: { $toString: '$price' }, regex: reStr, options: 'i' } } },
        { $expr: { $regexMatch: { input: { $toString: '$space' }, regex: reStr, options: 'i' } } }
      ]
    }).toArray();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'Failed to search lessons' });
  }
});

// POST handler ≈ Flask @app.post('/orders')
app.post('/orders', async (req, res) => {
  try {
    const { doc, error } = buildOrderDoc(req.body);
    if (error) return res.status(400).json({ error });
    const db = await getDb();
    const result = await db.collection('order').insertOne(doc);
    res.status(201).json({ insertedId: result.insertedId, ...doc });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// PUT handler ≈ Flask @app.put('/lessons/<id>')
app.put('/lessons/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let oid;
    try { oid = new ObjectId(String(id)); } catch { return res.status(400).json({ error: 'Invalid id' }); }
    const update = Object.assign({}, req.body);
    if ('_id' in update) delete update._id;
    if (update.space != null) {
      const n = Number(update.space);
      if (!Number.isFinite(n)) return res.status(400).json({ error: 'space must be a number' });
      update.space = n;
    }

    const db = await getDb();
    const result = await db.collection('lesson').updateOne({ _id: oid }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Lesson not found' });
    const doc = await db.collection('lesson').findOne({ _id: oid });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: 'Failed to update lesson' });
  }
});

// Root route returning API metadata; mirrors a Flask view returning jsonify({...})
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'CST3144 Coursework API',
    description: 'Express backend for coursework project, serving lessons data and order management.',
    version: require('./package.json').version,
    uptimeSeconds: Math.round(process.uptime()),
    endpoints: {
      listLessons: 'GET /lessons',
      searchLessons: 'GET /search?term=keyword',
      lessonDetails: 'GET /lessons/:id',
      createOrder: 'POST /orders',
      updateLesson: 'PUT /lessons/:id',
      healthCheck: 'GET /health/db',
      status: 'GET /status',
      version: 'GET /version'
    }
  });
});

// Health check similar to Flask endpoint hitting db.command('ping') via pymongo
app.get('/health/db', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.command({ ping: 1 });
    res.json({ ok: 1, ping: r && r.ok === 1 ? 'ok' : 'unknown' });
  } catch (e) {
    res.status(500).json({ error: 'DB not reachable' });
  }
});

// Runtime stats endpoint; compare with Flask using psutil/process info
app.get('/status', (req, res) => {
  const { rss, heapTotal, heapUsed, external } = process.memoryUsage();
  res.json({
    uptime: Math.round(process.uptime()),
    memory: { rss, heapTotal, heapUsed, external },
    version: require('./package.json').version
  });
});

app.get('/version', (req, res) => {
  res.json({
    version: require('./package.json').version,
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || null
  });
});

// Detail fetch route similar to Flask @app.get('/lessons/<id>')
app.get('/lessons/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let oid;
    try { oid = new ObjectId(String(id)); } catch { return res.status(400).json({ error: 'Invalid id' }); }
    const db = await getDb();
    const doc = await db.collection('lesson').findOne({ _id: oid });
    if (!doc) return res.status(404).json({ error: 'Lesson not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch lesson' });
  }
});

// 404 handler ≈ Flask's errorhandler(404)
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', requestId: req.requestId });
});

// 500 handler with logging; think Flask @app.errorhandler(500)
app.use((err, req, res, next) => {
  console.error(new Date().toISOString(), 'ERROR', req.requestId, err && err.message);
  res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// Graceful shutdown hook; similar to catching SIGINT in a Python app and closing resources.
const shutdown = async () => {
  try { if (client) await client.close(); } catch (e) {}
  server.close(() => { process.exit(0); });
  setTimeout(() => process.exit(0), 5000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

