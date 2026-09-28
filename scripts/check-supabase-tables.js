const { Client } = require('pg');

async function checkTables() {
  const c = new Client({
    connectionString: 'postgresql://postgres:Campus%40orbis26@db.xsonxewcelxexlgwkrrr.supabase.co:5432/postgres',
    ssl: { rejectUnauthorized: false }
  });
  await c.connect();
  const res = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;");
  console.log(`Found ${res.rows.length} tables in Supabase:`);
  console.log(res.rows.map(r => r.table_name));
  await c.end();
}

checkTables().catch(console.error);
