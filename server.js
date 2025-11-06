// CST3144 Backend server
// Sets up Express, connects to MongoDB (native driver), and exposes API routes.
const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

// Load environment variables from Backend/.env (contains MONGODB_URI, etc.)
dotenv.config({ path: path.join(__dirname, '.env') });

// Create the Express application
const app = express();

// Parse JSON request bodies so POST/PUT can read req.body
app.use(express.json());

// CORS allowlist: set CORS_ORIGINS in .env as comma-separated URLs (Pages + localhost)
const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (!origins.length || origins.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
}));

// Logger middleware: prints time, method, URL, status, and duration for every request
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(new Date().toISOString(), req.method, req.originalUrl, res.statusCode, ms + 'ms');
  });
  next();
});

// Serve local images from Backend/imgs as /imgs/...
const imgsDir = path.join(__dirname, 'imgs');
app.use('/imgs', express.static(imgsDir));
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
    const normalized = items.map(it => {
      const id = it.lessonId || it.lessonID || it.id;
      const oid = toObjectIdSafe(id);
      return { lessonId: oid ? oid : String(id), space: Number(it.space) };
    });
    return { doc: { name, phone, items: normalized, createdAt: new Date() } };
  }

  if (Array.isArray(lessonIDs) && typeof space !== 'undefined') {
    const ids = lessonIDs.map(id => toObjectIdSafe(id) || String(id));
    return { doc: { name, phone, lessonIDs: ids, space: Number(space), createdAt: new Date() } };
  }

  return { error: 'Provide items[] or lessonIDs[] with space' };
}

// GET /lessons → returns all lessons as JSON
app.get('/lessons', async (req, res) => {
  try {
    const db = await getDb();
    const lessons = await db.collection('lesson').find({}).toArray();
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

// Start the server on PORT (Render sets process.env.PORT automatically)
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
