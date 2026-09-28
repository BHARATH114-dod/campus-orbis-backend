const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campusync';
const OUTPUT_DIR = path.join(__dirname, '..', 'backup_mongo_data');

async function exportMongoDB() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB:', MONGODB_URI);
  const db = client.db();

  const collections = await db.listCollections().toArray();
  const summary = {};

  for (const col of collections) {
    const name = col.name;
    // Skip chunks if files are exported separately or export all
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.json`), JSON.stringify(docs, null, 2));
    summary[name] = docs.length;
    console.log(`Exported ${name}: ${docs.length} records`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, '_summary.json'), JSON.stringify(summary, null, 2));
  console.log('Export completed to:', OUTPUT_DIR);
  await client.close();
}

exportMongoDB().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
