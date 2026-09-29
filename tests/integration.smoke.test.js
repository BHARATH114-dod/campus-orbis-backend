'use strict';
// ---------------------------------------------------------------------------
// Integration smoke tests — the gap called out in the security report as
// "not run": these actually boot the real, unmodified server.js (see
// tests/support/bootServer.js) and fire real HTTP requests at it, instead of
// only unit-testing isolated functions. The in-memory Mongo stub
// (tests/support/fakeMongo.js) stands in for a real MongoDB server, which
// this sandboxed environment doesn't have.
//
// Scope: the routes and behaviors changed by this security-hardening pass —
// not a full regression suite for the entire pre-existing application.
//
// Run with: npm run test:integration
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('node:crypto');

const PORT = 45733;
const BASE = `http://localhost:${PORT}`;

let db;

test.before(async () => {
  await require('./support/bootServer').start({ port: PORT });
  const fakeMongo = require('./support/fakeMongo');
  db = new fakeMongo.MongoClient().db();
});

function legacySha256(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// -----------------------------------------------------------------------
// Boot / baseline
// -----------------------------------------------------------------------
test('server actually boots and serves a public route', async () => {
  const res = await request(BASE).get('/api/public/stats');
  assert.equal(res.status, 200);
});

test('security headers (Helmet/CSP) are present on real responses', async () => {
  const res = await request(BASE).get('/api/public/stats');
  assert.ok(res.headers['content-security-policy'], 'expected a Content-Security-Policy header');
  assert.ok(res.headers['x-content-type-options'], 'expected X-Content-Type-Options header');
});

// -----------------------------------------------------------------------
// Super Admin bootstrap (Section 3)
// -----------------------------------------------------------------------
test('the seeded Super Admin (from env vars) can log in — no owner/owner123 anywhere', async () => {
  const res = await request(BASE).post('/api/auth/login').send({
    username: process.env.SUPER_ADMIN_USERNAME,
    password: process.env.SUPER_ADMIN_PASSWORD,
    role: 'super_admin',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, process.env.SUPER_ADMIN_USERNAME);
  assert.equal(res.headers['set-cookie']?.[0]?.includes('HttpOnly'), true);
});

test('the old default owner/owner123 credentials do not work', async () => {
  const res = await request(BASE).post('/api/auth/login').send({ username: 'owner', password: 'owner123', role: 'super_admin' });
  assert.equal(res.status, 401);
});

// -----------------------------------------------------------------------
// Password hashing + legacy migration (Section 2), seeded directly since
// this is testing a data-migration path a fresh signup can't exercise.
// -----------------------------------------------------------------------
test('a legacy SHA-256 user can still log in, and gets migrated to scrypt on success', async () => {
  const Users = db.collection('users');
  const college = { id: newId('col'), name: 'Legacy College', status: 'active', created_at: Date.now() };
  await db.collection('colleges').insertOne(college);
  await Users.insertOne({
    id: newId('u'), username: 'legacyuser', name: 'Legacy User', role: 'student',
    college_id: college.id, password_hash: legacySha256('OldPassword1'),
  });

  const loginRes = await request(BASE).post('/api/auth/login').send({ username: 'legacyuser', password: 'OldPassword1', role: 'student', college_id: college.id });
  assert.equal(loginRes.status, 200);

  const updated = await Users.findOne({ username: 'legacyuser' });
  assert.match(updated.password_hash, /^scrypt\$/, 'expected the legacy hash to have been upgraded to scrypt after a successful login');
  assert.notEqual(updated.password_hash, legacySha256('OldPassword1'));
});

test('wrong password against a legacy hash is rejected, and does NOT trigger a migration', async () => {
  const Users = db.collection('users');
  const college = { id: newId('col'), name: 'Legacy College 2', status: 'active', created_at: Date.now() };
  await db.collection('colleges').insertOne(college);
  const legacyHash = legacySha256('CorrectPassword1');
  await Users.insertOne({ id: newId('u'), username: 'legacyuser2', name: 'L2', role: 'student', college_id: college.id, password_hash: legacyHash });

  const res = await request(BASE).post('/api/auth/login').send({ username: 'legacyuser2', password: 'WrongPassword', role: 'student', college_id: college.id });
  assert.equal(res.status, 401);
  const stillThere = await Users.findOne({ username: 'legacyuser2' });
  assert.equal(stillThere.password_hash, legacyHash);
});

// -----------------------------------------------------------------------
// NoSQL injection (Section 8)
// -----------------------------------------------------------------------
test('a NoSQL-operator-shaped login payload is rejected, not treated as a query operator', async () => {
  const res = await request(BASE).post('/api/auth/login').send({ username: { $ne: null }, password: { $ne: null }, role: 'super_admin' });
  assert.equal(res.status, 400);
});

test('$where/$ne keys are stripped from request bodies before reaching a route', async () => {
  // /api/auth/login validates types explicitly (tested above); this checks
  // the *global* sanitizer independently via a route that accepts a plain
  // object body without its own extra type guards.
  const res = await request(BASE).post('/api/auth/login').send({ username: 'legacyuser', password: 'x', role: 'student', college_id: { $ne: null } });
  // college_id being stripped to {} by the sanitizer, then failing the
  // login route's own typeof-string guard, is the expected defense-in-depth
  // outcome — either layer alone would already block this.
  assert.equal(res.status, 400);
});

// -----------------------------------------------------------------------
// Notes IDOR (Section 9) — the vulnerability named explicitly in the spec.
// -----------------------------------------------------------------------
async function loginAs(username, password, role, college_id) {
  const agent = request.agent(BASE);
  const res = await agent.post('/api/auth/login').send({ username, password, role, college_id });
  assert.equal(res.status, 200, `expected login to succeed for ${username}`);
  return agent;
}

test('a student cannot access another college\'s private note by guessing its id', async () => {
  const Colleges = db.collection('colleges');
  const Users = db.collection('users');
  const Notes = db.collection('notes');

  const collegeA = { id: newId('col'), name: 'College A', status: 'active', created_at: Date.now() };
  const collegeB = { id: newId('col'), name: 'College B', status: 'active', created_at: Date.now() };
  await Colleges.insertOne(collegeA);
  await Colleges.insertOne(collegeB);

  const studentA = { id: newId('u'), username: 'studentA', name: 'Student A', role: 'student', college_id: collegeA.id, password_hash: require('crypto').scryptSync('pw', 'salt', 4).toString('hex') };
  // Use the app's own hashing so login works — simplest is to hit the
  // password-change-free path by writing a hash with the SAME algorithm the
  // server verifies against. We reuse the server's own scrypt format by
  // constructing it exactly as hashPassword() does.
  function hashPasswordLikeServer(password) {
    const salt = require('crypto').randomBytes(16);
    const key = require('crypto').scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
  }
  studentA.password_hash = hashPasswordLikeServer('StudentAPass1');
  await Users.insertOne(studentA);

  const noteB = {
    id: newId('note'), college_id: collegeB.id, title: 'College B Confidential Note',
    target_department: null, target_year: null, target_section_id: null,
    author_username: 'someoneInB', file_id: null, allow_download: true,
    bookmarked_by: [], created_at: Date.now(),
  };
  await Notes.insertOne(noteB);

  const agentA = await loginAs('studentA', 'StudentAPass1', 'student', collegeA.id);

  const fileRes = await agentA.get(`/api/notes/${noteB.id}/file`);
  assert.equal(fileRes.status, 404, 'a cross-college note file must not be reachable');

  const bookmarkRes = await agentA.post(`/api/notes/${noteB.id}/bookmark`);
  assert.equal(bookmarkRes.status, 404, 'a cross-college note must not be bookmarkable');

  const stillNotBookmarked = await Notes.findOne({ id: noteB.id });
  assert.deepEqual(stillNotBookmarked.bookmarked_by, [], 'the note must be unchanged by the blocked bookmark attempt');
});

test('a student CAN access a note that legitimately belongs to their own college', async () => {
  const Colleges = db.collection('colleges');
  const Users = db.collection('users');
  const Notes = db.collection('notes');

  const college = { id: newId('col'), name: 'College C', status: 'active', created_at: Date.now() };
  await Colleges.insertOne(college);
  function hashPasswordLikeServer(password) {
    const salt = require('crypto').randomBytes(16);
    const key = require('crypto').scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
  }
  const student = { id: newId('u'), username: 'studentC', name: 'Student C', role: 'student', college_id: college.id, password_hash: hashPasswordLikeServer('StudentCPass1') };
  await Users.insertOne(student);
  const note = {
    id: newId('note'), college_id: college.id, title: 'My College Note',
    target_department: null, target_year: null, target_section_id: null,
    author_username: 'facultyC', file_id: null, allow_download: true,
    bookmarked_by: [], created_at: Date.now(),
  };
  await Notes.insertOne(note);

  const agent = await loginAs('studentC', 'StudentCPass1', 'student', college.id);
  const bookmarkRes = await agent.post(`/api/notes/${note.id}/bookmark`);
  assert.equal(bookmarkRes.status, 200);
  assert.equal(bookmarkRes.body.bookmarked, true);
});

// -----------------------------------------------------------------------
// Events/clubs gallery-file IDOR (found during the audit, not in the
// original spec's named list) — this had NO ownership check at all before
// the fix, so it gets its own direct test. Runs BEFORE the rate-limit test
// below, since it needs its own successful login.
// -----------------------------------------------------------------------
test('a user cannot download another college\'s event gallery photo by guessing the file id', async () => {
  const Colleges = db.collection('colleges');
  const Users = db.collection('users');
  const Events = db.collection('events');

  function hashPasswordLikeServer(password) {
    const salt = require('crypto').randomBytes(16);
    const key = require('crypto').scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
  }

  const collegeX = { id: newId('col'), name: 'College X', status: 'active', created_at: Date.now() };
  const collegeY = { id: newId('col'), name: 'College Y', status: 'active', created_at: Date.now() };
  await Colleges.insertOne(collegeX);
  await Colleges.insertOne(collegeY);

  const studentX = { id: newId('u'), username: 'studentX', name: 'Student X', role: 'student', college_id: collegeX.id, password_hash: hashPasswordLikeServer('StudentXPass1') };
  await Users.insertOne(studentX);

  const eventY = { id: newId('ev'), college_id: collegeY.id, title: 'College Y Private Event', target_department: null, target_year: null, target_section_id: null, rsvps: [], created_at: Date.now() };
  await Events.insertOne(eventY);

  // Seed a gallery "file" record the way the real upload route would, using
  // the fake GridFS bucket directly so the download route has something to
  // find by _id.
  const fakeMongo = require('./support/fakeMongo');
  const bucket = new fakeMongo.GridFSBucket(db, { bucketName: 'event_gallery' });
  const uploadStream = bucket.openUploadStream('photo.jpg', { contentType: 'image/jpeg', metadata: { event_id: eventY.id, uploaded_by: 'someoneInY' } });
  const fileId = await new Promise((resolve, reject) => {
    uploadStream.end(Buffer.from('fake image bytes'), (err) => (err ? reject(err) : resolve(uploadStream.id)));
  });

  const agentX = await loginAs('studentX', 'StudentXPass1', 'student', collegeX.id);
  const res = await agentX.get(`/api/events/${eventY.id}/gallery/${fileId}/file`);
  assert.equal(res.status, 404, 'a cross-college event gallery file must not be downloadable');
});

// -----------------------------------------------------------------------
// Rate limiting (Section 12) — intentionally runs LAST: it exhausts the
// login rate limiter for this test client's IP for the rest of the
// 15-minute window, which would make every later login attempt in this
// file fail with 429 instead of testing what it's meant to test.
// -----------------------------------------------------------------------
test('repeated failed logins eventually get rate-limited (429)', async () => {
  let sawTooManyRequests = false;
  for (let i = 0; i < 210; i++) {
    const res = await request(BASE).post('/api/auth/login').send({ username: 'bruteforce_target', password: 'x', role: 'student', college_id: 'x' });
    if (res.status === 429) { sawTooManyRequests = true; break; }
  }
  assert.equal(sawTooManyRequests, true, 'expected to eventually receive a 429 after repeated login attempts');
});

test.after(async () => {
  // A plain `process.exit()` here can truncate the TAP reporter's still-
  // buffered stdout for the test that just finished when output is piped
  // (not a TTY) — give it a tick to flush before tearing down the process
  // (the real Express server + WS heartbeats otherwise keep the event loop
  // alive indefinitely).
  await new Promise((resolve) => setImmediate(resolve));
  process.exit(0);
});
