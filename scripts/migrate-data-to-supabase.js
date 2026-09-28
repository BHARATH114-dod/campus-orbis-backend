const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const BACKUP_DIR = path.join(__dirname, '..', 'backup_mongo_data');
const CONNECTION_STRING = 'postgresql://postgres:Campus%40orbis26@db.xsonxewcelxexlgwkrrr.supabase.co:5432/postgres';

async function migrate() {
  const pool = new Pool({
    connectionString: CONNECTION_STRING,
    ssl: { rejectUnauthorized: false }
  });

  console.log('Connecting to Supabase...');
  const client = await pool.connect();
  console.log('Connected!');

  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  let totalMigrated = 0;

  for (const file of files) {
    let table = file.replace('.json', '');
    if (table.includes('.')) continue; // chunks or files handled separately

    const jsonPath = path.join(BACKUP_DIR, file);
    const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!records || records.length === 0) continue;

    console.log(`Migrating ${records.length} records into table: ${table}...`);
    let count = 0;

    for (const rec of records) {
      const id = rec.id || (rec._id ? (typeof rec._id === 'object' ? rec._id.$oid || String(rec._id) : String(rec._id)) : null);
      if (!id) continue;

      const cleanDoc = JSON.parse(JSON.stringify(rec, (key, value) => {
        if (value && typeof value === 'object' && value.$oid) return value.$oid;
        return value;
      }));

      await client.query(
        `INSERT INTO ${table} (id, doc) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc;`,
        [id, JSON.stringify(cleanDoc)]
      );
      count++;
    }

    console.log(`✓ ${table}: ${count} records inserted.`);
    totalMigrated += count;
  }

  // Migrate storage files (GridFS)
  const logoFilesPath = path.join(BACKUP_DIR, 'college_logos.files.json');
  const logoChunksPath = path.join(BACKUP_DIR, 'college_logos.chunks.json');
  if (fs.existsSync(logoFilesPath) && fs.existsSync(logoChunksPath)) {
    const logoFiles = JSON.parse(fs.readFileSync(logoFilesPath, 'utf8'));
    const logoChunks = JSON.parse(fs.readFileSync(logoChunksPath, 'utf8'));
    for (const file of logoFiles) {
      const fileId = file._id ? (file._id.$oid || String(file._id)) : file.id;
      const chunks = logoChunks.filter(c => {
        const cId = c.files_id ? (c.files_id.$oid || String(c.files_id)) : null;
        return cId === fileId;
      }).sort((a,b) => a.n - b.n);
      
      let base64 = '';
      for (const chunk of chunks) {
        if (chunk.data && chunk.data.$binary && chunk.data.$binary.base64) {
          base64 += chunk.data.$binary.base64;
        }
      }
      
      await client.query(
        `INSERT INTO storage_files (id, bucket, filename, content_type, length, data, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data;`,
        [
          fileId,
          'college_logos',
          file.filename || 'logo.png',
          file.contentType || 'image/png',
          file.length || 0,
          base64,
          JSON.stringify(file.metadata || {})
        ]
      );
      console.log(`✓ Migrated storage file: ${file.filename || fileId}`);
    }
  }

  client.release();
  await pool.end();
  console.log(`\n🎉 Data Migration COMPLETE! Total ${totalMigrated} records migrated into Supabase.`);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
