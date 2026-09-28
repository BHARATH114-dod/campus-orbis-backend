const { Client } = require('pg');

async function testConnection() {
  const connectionStrings = [
    'postgresql://postgres:Campus%40orbis26@db.xsonxewcelxexlgwkrrr.supabase.co:5432/postgres',
    'postgresql://postgres.xsonxewcelxexlgwkrrr:Campus%40orbis26@db.xsonxewcelxexlgwkrrr.supabase.co:5432/postgres',
    'postgresql://postgres.xsonxewcelxexlgwkrrr:Campus%40orbis26@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    'postgresql://postgres.xsonxewcelxexlgwkrrr:Campus%40orbis26@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
    'postgresql://postgres.xsonxewcelxexlgwkrrr:Campus%40orbis26@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
  ];

  for (const cs of connectionStrings) {
    const masked = cs.replace(/:Campus%40orbis26@/, ':****@');
    console.log(`Trying: ${masked}`);
    const client = new Client({
      connectionString: cs,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000
    });

    try {
      await client.connect();
      const res = await client.query('SELECT current_database(), current_user, version();');
      console.log('SUCCESS! Connected with:', masked);
      console.log('DB Info:', res.rows[0]);
      await client.end();
      return cs;
    } catch (err) {
      console.log(`Failed: ${err.message}`);
      try { await client.end(); } catch (e) {}
    }
  }

  throw new Error('All connection attempts failed');
}

testConnection().catch(err => {
  console.error(err.message);
  process.exit(1);
});
