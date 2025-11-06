// CST3144 Backend server
// Sets up Express, connects to MongoDB (native driver), and exposes API routes.
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const crypto = require('crypto');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

// Load environment variables from Backend/.env (contains MONGODB_URI, etc.)
dotenv.config({ path: path.join(__dirname, '.env') });

// Create the Express application
const app = express();
// Trust proxy (Render and similar platforms) so req.ip is correct
app.set('trust proxy', 1);

// Security headers (allow cross-origin resource policy for images to be used by frontend)
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Parse JSON request bodies so POST/PUT can read req.body
app.use(express.json({ limit: '100kb' }));

// Compression
app.use(compression());

app.use((req, res, next) => {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', id);
  req.requestId = id;
  next();
});

// CORS allowlist: set CORS_ORIGINS in .env as comma-separated URLs (Pages + localhost)
const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (!origins.length || origins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET','POST','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Request-Id'],
  credentials: false
}));

// Logger middleware: prints time, method, URL, status, and duration for every request
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(new Date().toISOString(), req.requestId, req.ip, req.method, req.originalUrl, res.statusCode, ms + 'ms');
  });
  next();
});

// Rate limiting (global + specific routes)
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/search', searchLimiter);
const ordersLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
app.use('/orders', ordersLimiter);

// Serve local images from Backend/imgs as /imgs/...
const imgsDir = path.join(__dirname, 'imgs');
app.use('/imgs', express.static(imgsDir, { maxAge: '1d', immutable: true }));
app.use('/imgs', (req, res) => {
  res.status(404).json({ error: 'Image not found' });
});

// MongoDB connection details (native driver). DB created in Atlas.
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'coursework-backend';
let client;
let database;

// Lazily connect to MongoDB and reuse the connection across requests
async function getDb() {
  if (database) return database;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  await client.connect();
  database = client.db(dbName);
  return database;
}

// Helpers: ID conversion and order document builder
function toObjectIdSafe(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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

// GET /lessons → returns all lessons as JSON
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

// POST /orders → creates a new order (Name letters-only, Phone numbers-only)
// Accepts either: { name, phone, lessonIDs: [id], space } OR { name, phone, items: [{ lessonId, space }] }
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

// PUT /lessons/:id → updates any lesson attribute (e.g., space after checkout)
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

// Health check root route → handy to verify server is alive
app.get('/', (req, res) => {
  res.json({ ok: true });
});

// DB health: pings MongoDB
app.get('/health/db', async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.command({ ping: 1 });
    res.json({ ok: 1, ping: r && r.ok === 1 ? 'ok' : 'unknown' });
  } catch (e) {
    res.status(500).json({ error: 'DB not reachable' });
  }
});

// Runtime status (uptime, memory)
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

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', requestId: req.requestId });
});

app.use((err, req, res, next) => {
  console.error(new Date().toISOString(), 'ERROR', req.requestId, err && err.message);
  res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

// Start the server on PORT (Render sets process.env.PORT automatically)
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const shutdown = async () => {
  try { if (client) await client.close(); } catch (e) {}
  server.close(() => { process.exit(0); });
  setTimeout(() => process.exit(0), 5000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
