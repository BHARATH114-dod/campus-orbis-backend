const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function fixLogo() {
  const c = new Client({
    connectionString: 'postgresql://postgres:Campus%40orbis26@db.xsonxewcelxexlgwkrrr.supabase.co:5432/postgres',
    ssl: { rejectUnauthorized: false }
  });
  await c.connect();
  const chunks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backup_mongo_data', 'college_logos.chunks.json'), 'utf8'));
  const base64 = chunks[0].data;
  await c.query('UPDATE storage_files SET data = $1 WHERE bucket = $2;', [base64, 'college_logos']);
  console.log('Successfully updated logo base64 in Supabase! Length:', base64.length);
  await c.end();
}

fixLogo().catch(console.error);
