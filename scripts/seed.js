'use strict'

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const root = path.join(__dirname, '..');
  const defaultLocal = path.join(root, 'seed.lessons.local.json');
  const defaultRemote = path.join(root, 'seed.lessons.json');

  const file = args.file || (fs.existsSync(defaultLocal) ? defaultLocal : defaultRemote);
  const dbName = args.db || process.env.DB_NAME || 'coursework-backend';
  const collectionName = args.collection || 'lesson';
  const drop = Boolean(args.drop);

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Add it to Backend/.env');
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error('Seed file not found:', file);
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf8');
  let docs;
  try {
    docs = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse JSON:', e.message);
    process.exit(1);
  }
  if (!Array.isArray(docs)) {
    console.error('Seed file must be a JSON array');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const col = db.collection(collectionName);

    if (drop) {
      try {
        await col.drop();
        console.log(`Dropped collection ${dbName}.${collectionName}`);
      } catch (e) {
        if (e.codeName !== 'NamespaceNotFound') throw e;
      }
    }

    const result = await col.insertMany(docs, { ordered: false });
    console.log(`Inserted ${result.insertedCount ?? Object.keys(result.insertedIds).length} documents into ${dbName}.${collectionName}`);
  } catch (e) {
    console.error('Seeding failed:', e.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
