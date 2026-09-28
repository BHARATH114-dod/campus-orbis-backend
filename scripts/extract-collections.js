const fs = require('fs');
const path = require('path');

const serverCode = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const regex = /db\.collection\(['"]([^'"]+)['"]\)/g;
const collections = new Set();
let m;
while ((m = regex.exec(serverCode)) !== null) {
  collections.add(m[1]);
}

// Also check GridFS buckets
const gridfsRegex = /new\s+GridFSBucket\([^,]+,\s*\{\s*bucketName:\s*['"]([^'"]+)['"]/g;
const buckets = new Set();
while ((m = gridfsRegex.exec(serverCode)) !== null) {
  buckets.add(m[1]);
}

console.log('Collections count:', collections.size);
console.log('Collections:', JSON.stringify([...collections].sort(), null, 2));
console.log('Buckets:', JSON.stringify([...buckets].sort(), null, 2));
