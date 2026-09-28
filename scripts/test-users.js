const { Client } = require('pg');
const http = require('http');

async function testUsers() {
  const c = new Client({
    connectionString: 'postgresql://postgres:Campus%40orbis26@db.xsonxewcelxexlgwkrrr.supabase.co:5432/postgres',
    ssl: { rejectUnauthorized: false }
  });
  await c.connect();
  const res = await c.query("SELECT id, doc->>'username' as username, doc->>'role' as role, doc->>'name' as name FROM users WHERE doc->>'role' != 'student' LIMIT 5;");
  console.log('Admin & Staff users in Supabase:');
  console.log(res.rows);
  await c.end();
}

testUsers().catch(console.error);
