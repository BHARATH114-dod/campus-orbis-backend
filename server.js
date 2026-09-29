/**
 * Campus Orbis backend — Express + MongoDB + GridFS.
 *
 * Role hierarchy (matches the flowchart):
 *   super_admin   -> owns the platform, creates colleges + their College Admin
 *   college_admin -> manages one college, creates HODs, messages other College Admins
 *   hod           -> manages one department, creates faculty/students/sections
 *   faculty       -> manages their assigned section(s) only
 *   student       -> belongs to exactly one section
 *
 * There is no public signup — every account is created by the role above it.
 *
 * Run:  npm install   then   npm start
 * Needs a running MongoDB instance — set MONGODB_URI if it's not on
 * localhost. See README.md for setup.
 */
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const http = require('http');

try {
  if (typeof process.loadEnvFile === 'function' && process.env.NODE_ENV !== 'test') {
    process.loadEnvFile();
  }
} catch (e) {}

// child_process/execFile is intentionally NOT imported: no student-submitted
// code is ever run with this process's own privileges (see the code-runner
// section further down, which routes every language through Judge0).
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
// @e965/xlsx is a community-maintained, up-to-date republish of SheetJS's
// own build (the plain "xlsx" npm package stopped receiving security fixes
// after 0.18.5 — SheetJS ships patched releases only via their own CDN,
// which isn't installable through a normal `npm install`). Same library,
// same API, just the versions that actually fix the prototype-pollution and
// ReDoS CVEs that affected the old package.
const XLSX = require('@e965/xlsx');

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
let MongoClient, GridFSBucket, ObjectId;
if (SUPABASE_DB_URL) {
  console.log('[Database] Connecting to Supabase PostgreSQL database...');
  ({ MongoClient, GridFSBucket, ObjectId } = require('./services/supabaseMongoAdapter'));
} else {
  ({ MongoClient, GridFSBucket, ObjectId } = require('mongodb'));
}

const webpush = require('web-push'); // Real Web Push Protocol (RFC 8030) + VAPID — no third-party push provider or account needed
const { WebSocketServer } = require('ws'); // NEW: WebRTC signalling channel for Test Monitoring → View Live
const { COURSE: PY_COURSE, TOTAL_LESSONS: PY_COURSE_TOTAL_LESSONS } = require('./pythonCourseData'); // NEW: Python Full Course content (static data, no DB)
const { LANGUAGES, LANGUAGE_META, COURSES_BY_LANGUAGE, TOTAL_LESSONS_BY_LANGUAGE, isValidLanguage } = require('./coursesData'); // NEW: multi-language Courses (generalizes the Python Full Course to C/C++/Java/JavaScript)
// FIX: rewritten Excel/CSV bulk-import engine (student import with optional
// Section + post-upload section assignment, and NEW multi-club Excel
// creation). Kept as its own module — pure functions, no Express/DB
// wiring — so the parsing/validation rules can be unit tested on their own
// (tests/bulkImport.unit.test.js) without booting the whole server.
const bulkImport = require('./services/bulkImport');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campusync';
const SESSION_COOKIE = 'campusync_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------- Web Push (real OS-level push notifications) ----------
// Uses the standard browser Push API + VAPID — the same mechanism behind
// every "allow notifications" prompt on the web. No external account,
// no third-party push service, and no per-deployment manual setup:
// if VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY aren't supplied via env vars,
// a key pair is generated once on first boot and persisted to
// vapid-keys.json (gitignored) next to this file, and reused on every
// restart after that. Delete that file (or rotate the env vars) to issue
// a new key pair — note that doing so invalidates every subscription
// currently stored in push_subscriptions (browsers will silently stop
// delivering to the old keys; expired ones get pruned automatically the
// next time a push is attempted, see sendPushToUsers below).
const VAPID_KEYS_PATH = process.env.VAPID_KEYS_PATH || path.join(__dirname, 'vapid-keys.json');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@campus-orbis.local';
let vapidReady = false;
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
try {
  let privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (!VAPID_PUBLIC_KEY || !privateKey) {
    if (fs.existsSync(VAPID_KEYS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(VAPID_KEYS_PATH, 'utf8'));
      VAPID_PUBLIC_KEY = saved.publicKey;
      privateKey = saved.privateKey;
    } else {
      const generated = webpush.generateVAPIDKeys();
      VAPID_PUBLIC_KEY = generated.publicKey;
      privateKey = generated.privateKey;
      fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(generated, null, 2));
      console.log('Web Push: generated a new VAPID key pair (saved to vapid-keys.json).');
    }
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, privateKey);
  vapidReady = true;
  console.log('Web Push: enabled.');
} catch (err) {
  console.error('Web Push: failed to initialize, push notifications disabled.', err.message);
}

const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB

const ALLOWED_NOTE_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/msword': 'office',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'office',
  'application/vnd.ms-powerpoint': 'office',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'office',
  'application/vnd.ms-excel': 'office',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'office',
  'text/plain': 'office'
};

const uploadNote = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_BYTES },
  fileFilter(req, file, cb) {
    if (!ALLOWED_NOTE_TYPES[file.mimetype]) {
      return cb(new Error('That file type is not supported. Try a PDF, Word, PowerPoint, Excel, or image file.'));
    }
    cb(null, true);
  }
});
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter(req, file, cb) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Please upload a JPG, PNG, or WEBP image.'));
    }
    cb(null, true);
  }
});

// NEW: bulk student import from Excel/CSV — lets HOD and Faculty add a
// whole class in one go instead of the "Add student" form row by row.
// Same 25MB doc ceiling as notes; memory storage since the file is parsed
// once with SheetJS and never needs to touch disk.
const ALLOWED_SHEET_TYPES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'application/octet-stream' // some browsers send this for .xlsx/.csv — fall back to extension check below
]);
const uploadStudentSheet = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_SHEET_TYPES.has(file.mimetype) && !['.xlsx', '.xls', '.csv'].includes(ext)) {
      return cb(new Error('Please upload an Excel (.xlsx/.xls) or CSV file.'));
    }
    cb(null, true);
  }
});

// NEW: Test Monitoring — a student's browser records itself in short
// rolling camera+mic chunks (MediaRecorder) while a test is in progress
// and uploads each chunk here, replacing the previous one. 15MB is
// generous headroom for an ~8-10s 720p webm chunk.
const MAX_MONITOR_CHUNK_BYTES = 15 * 1024 * 1024;
const uploadMonitorChunk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MONITOR_CHUNK_BYTES },
  fileFilter(req, file, cb) {
    if (!/^video\//.test(file.mimetype)) return cb(new Error('Expected a video recording chunk.'));
    cb(null, true);
  }
});

// ---------------------------------------------------------------------------
// Small helpers (no DB access)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Password hashing (scrypt, salted, with automatic legacy-SHA-256 migration)
// ---------------------------------------------------------------------------
// Node's built-in crypto.scrypt is a memory-hard, production-appropriate KDF
// (Argon2id-class cost) that needs no extra native dependency to install —
// important on hosts where compiling bcrypt/argon2 bindings isn't reliable.
// Stored format: scrypt$N$r$p$saltHex$keyHex — self-describing so the cost
// parameters can be tuned later without invalidating already-stored hashes.
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 }); // ~16MB memory cost per hash
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password == null ? '' : password), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}
// Non-blocking twin of hashPassword(), used only by the bulk Excel import
// (services/bulkImport.js). scryptSync blocks the single Node event loop for
// ~50-100ms per call; a 200-row import with the sync version would freeze
// every other request on the server for 10-20 seconds. crypto.scrypt runs on
// libuv's threadpool instead, so the bulk importer can hash several
// passwords in parallel (see HASH_CONCURRENCY in bulkImport.js) while the
// server keeps serving everyone else. Same params/format, so the resulting
// hash verifies with the existing verifyPassword() unchanged.
function hashPasswordAsync(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password == null ? '' : password), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${key.toString('hex')}`);
    });
  });
}

function isLegacySha256Hash(hash) {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash);
}

function legacySha256(password) {
  return crypto.createHash('sha256').update(String(password == null ? '' : password)).digest('hex');
}

// Constant-time hex comparison — plain !== on the derived hex string would
// leak timing information about how many leading bytes matched.
function timingSafeHexEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  let bufA, bufB;
  try { bufA = Buffer.from(hexA, 'hex'); bufB = Buffer.from(hexB, 'hex'); } catch { return false; }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Verifies a password against whatever is stored — new scrypt format or a
// legacy SHA-256 hash from before this migration. `needsRehash` tells the
// caller (only ever the login route) to immediately overwrite the legacy
// hash with a fresh scrypt one now that the plaintext has been confirmed;
// this is the ONLY place a legacy hash is ever upgraded, and only after a
// successful verification, so accounts never become unusable.
function verifyPassword(password, storedHash) {
  if (!storedHash) return { valid: false, needsRehash: false };
  if (isLegacySha256Hash(storedHash)) {
    const valid = timingSafeHexEqual(legacySha256(password), storedHash);
    return { valid, needsRehash: valid };
  }
  const parts = String(storedHash).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { valid: false, needsRehash: false };
  const N = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'hex');
  const storedKeyHex = parts[5];
  const keyLen = Buffer.from(storedKeyHex, 'hex').length;
  if (!N || !r || !p || !salt.length || !keyLen) return { valid: false, needsRehash: false };
  let derived;
  try { derived = crypto.scryptSync(String(password == null ? '' : password), salt, keyLen, { N, r, p }); }
  catch { return { valid: false, needsRehash: false }; }
  return { valid: timingSafeHexEqual(derived.toString('hex'), storedKeyHex), needsRehash: false };
}
function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}
function stripId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}
function publicUser(u) {
  if (!u) return null;
  const { _id, password_hash, trusted_phones, ...rest } = u;
  // Section 5: the raw phone numbers on the user document must never reach
  // the frontend under any circumstance, including to the Super Admin's own
  // logged-in session — publicUser() is what every login/session/profile
  // response is built from, so masking happens right here, once, rather
  // than trusting every call site to remember to do it.
  if (Array.isArray(trusted_phones)) {
    rest.trusted_phones = trusted_phones.map(p => ({ id: p.id, maskedNumber: maskPhoneForDisplay(p.phone), verified: !!p.verified }));
  }
  return rest;
}
// Local mirror of otpService.maskPhone so publicUser() (defined very early,
// before services are required) doesn't need a require() at module load
// time. Keep in sync with services/otpService.js:maskPhone.
function maskPhoneForDisplay(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6) return '*'.repeat(digits.length);
  const first = digits.slice(0, 2);
  const last = digits.slice(-3);
  const middleStars = '*'.repeat(Math.max(digits.length - 5, 4));
  return `${first}${middleStars}${last}`;
}
function ah(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on the server.' });
    });
  };}

// FIX: Excel/CSV bulk student import and NEW Excel bulk club creation now
// live in services/bulkImport.js (parsing, validation, insertion — see that
// file's header comment for the two-phase preview/import flow). The routes
// below (search "students/import/preview", "students/import", and the
// "/api/clubs/import*" section near the rest of the Clubs API) are the only
// things that changed here; every other student/section/club route in this
// file is untouched.

async function main() {
  // Root-cause fix (504s under concurrent Live Quiz polling): the driver
  // was previously created with no options at all, which meant (a) no
  // explicit connection-pool ceiling to reason about under bursty polling
  // load, and (b) no bound on how long a query can sit waiting for a
  // server/connection before the driver gives up. Without (b), a slow or
  // momentarily-contended MongoDB call would just hang inside the Node
  // process indefinitely — the request never failed, it just never
  // finished, so it sat there until the *reverse proxy's* own timeout
  // fired and returned an opaque 504 to the browser. These bounds make
  // every DB call fail fast with a real error instead, which ah() below
  // turns into an immediate, meaningful JSON error response.
  const client = SUPABASE_DB_URL
    ? new MongoClient(SUPABASE_DB_URL)
    : new MongoClient(MONGODB_URI, {
        maxPoolSize: 50,
        minPoolSize: 5,
        // How long a request will wait for a connection to free up in the
        // pool before giving up, instead of queuing forever behind a storm of
        // concurrent polling requests.
        waitQueueTimeoutMS: 8000,
        // How long to wait to find a usable MongoDB server before failing.
        serverSelectionTimeoutMS: 8000,
        // How long an individual socket operation (a single query) may run
        // before the driver kills it and surfaces an error instead of hanging
        // forever. 30s is generous enough to not risk cutting off legitimately
        // heavier, unrelated operations elsewhere in this app (large
        // analytics/report aggregations, bulk imports) — the Competition
        // routes this bug report is actually about are cheap, fast, small
        // JSON reads/writes with no legitimate reason to ever approach that.
        socketTimeoutMS: 30000,
        connectTimeoutMS: 10000,
      });
  await client.connect();
  const db = client.db();
  const noteBucket = new GridFSBucket(db, { bucketName: 'note_files' });
  const posterBucket = new GridFSBucket(db, { bucketName: 'event_posters' });
  const logoBucket = new GridFSBucket(db, { bucketName: 'college_logos' });
  const galleryBucket = new GridFSBucket(db, { bucketName: 'club_gallery' }); // NEW: club gallery photos
  const eventGalleryBucket = new GridFSBucket(db, { bucketName: 'event_gallery' }); // NEW: previous-years' event photo gallery
  const monitoringBucket = new GridFSBucket(db, { bucketName: 'test_monitoring' }); // NEW: Test Monitoring — live camera/mic chunks

  const Users = db.collection('users');
  const Sessions = db.collection('sessions');
  const Colleges = db.collection('colleges');
  const Sections = db.collection('sections');
  const Announcements = db.collection('announcements');
  const Notes = db.collection('notes');
  const Events = db.collection('events');
  const Posts = db.collection('posts');
  const PostReplies = db.collection('post_replies');
  const Attendance = db.collection('attendance');
  const Marks = db.collection('marks');
  // NEW (timetable-driven attendance): Subjects and Timetable are HOD-managed
  // per department; Semesters give HOD-defined date ranges so attendance can
  // be filtered/reported by semester.
  const Subjects = db.collection('subjects');
  const Timetable = db.collection('timetable');
  const Semesters = db.collection('semesters');
  // NEW (Academic Calendar): department + year scoped calendar of
  // WORKING_DAY / HOLIDAY / SPECIAL_WORKING_DAY dates. Owned by HOD (per
  // their department), read-only for College Admin (across departments),
  // and consumed as an extra validation layer by Attendance (see
  // getCalendarEntryForDate/assertAttendanceDateAllowed below). A row with
  // `year: null` applies to the whole department (every year/section) on
  // that date; a row with a specific `year` overrides the department-wide
  // entry for that year only. `semester_id` is derived automatically from
  // the existing Semesters date ranges (see findSemesterForDate) rather
  // than chosen independently, since a given date already maps to at most
  // one semester in this app's data model.
  const AcademicCalendar = db.collection('academic_calendar');
  // NEW (Placements module): drives are college-wide, created by College
  // Admin; applications are one row per student per drive they applied to.
  const PlacementDrives = db.collection('placement_drives');
  const PlacementApplications = db.collection('placement_applications');
  const CollegeConnections = db.collection('college_connections');
  const CollegeMessages = db.collection('college_messages');
  // Staff Messaging (items 3/4) — HOD<->HOD and HOD<->Faculty conversations.
  // Deliberately separate from CollegeConnections/CollegeMessages above:
  // those are an opt-in connection-request system scoped to college_admins
  // only. Staff Messaging has no request/accept step — eligibility is
  // derived straight from the existing role/department authorization rules
  // (see messagingContactsFor/assertConversationAccess below), the same
  // way every other HOD/Faculty-scoped feature in this file already works.
  const StaffConversations = db.collection('staff_conversations');
  const StaffMessages = db.collection('staff_messages');
  await StaffConversations.createIndex({ id: 1 }, { unique: true });
  await StaffConversations.createIndex({ participant_usernames: 1 });
  await StaffMessages.createIndex({ id: 1 }, { unique: true });
  await StaffMessages.createIndex({ conversation_id: 1, created_at: 1 });
  // NEW collections — Clubs and the Discussion Forum. Leaderboard, analytics,
  // certificates, and bookmarks are computed on the fly from data that
  // already exists above, so they don't need collections of their own.
  const Clubs = db.collection('clubs');
  // Competition module — fast-paced live quiz competitions, ranked club
  // vs club (not scoped to any single club). ClubQuizzes holds the quiz
  // definition (questions, per-question timer, join code, live status/
  // current-question pointer). ClubQuizParticipants holds one row per
  // (quiz, representing club) with that club's running score and its
  // representative's per-question answers — this is what both the live
  // Top 5 and the Final Top 10 are computed from. Kept entirely separate
  // from Tests/TestSubmissions (the academic test system) and from the
  // normal Campus Orbis leaderboard, per spec.
  const ClubQuizzes = db.collection('club_quizzes');
  const ClubQuizParticipants = db.collection('club_quiz_participants');
  // NEW (spec item 2 — Save Quiz as Test): reusable competition-quiz
  // templates. A saved row is a frozen copy of a quiz's questions/settings;
  // conducting it creates a brand-new live ClubQuizzes doc and never
  // touches the saved template itself.
  const SavedClubQuizzes = db.collection('saved_club_quizzes');
  const ForumPosts = db.collection('forum_posts');
  const ForumReplies = db.collection('forum_replies');
  // Sections 4-7: Super Admin trusted-mobile-number + OTP security. Kept in
  // their own collections (never mixed into Users) so an OTP's short life
  // and one-time-use semantics are easy to reason about and index on.
  const SuperAdminOtps = db.collection('super_admin_otps');
  const SuperAdminPasswordChanges = db.collection('super_admin_password_changes');
  const SecurityLogs = db.collection('security_logs');
  await SuperAdminOtps.createIndex({ id: 1 }, { unique: true });
  await SuperAdminOtps.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }); // Mongo TTL — expired OTP docs are reaped automatically
  await SuperAdminPasswordChanges.createIndex({ id: 1 }, { unique: true });
  await SuperAdminPasswordChanges.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  // Security event log (Section 25). Auto-expires after 90 days so this
  // never becomes an unbounded collection. Deliberately narrow fields —
  // never a password, token, OTP, secret, or full mobile number; see the
  // allow-list comment on logSecurityEvent below.
  await SecurityLogs.createIndex({ created_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

  // Records a safe, structured security event. `detail` must only ever
  // contain plain identifiers (usernames, roles, IPs, reasons) — never a
  // password, session token, OTP code/value, API secret, private key, or a
  // full mobile number. Every call site below was written with that in
  // mind; if a new call site is added later, keep the same rule.
  async function logSecurityEvent(event, req, detail = {}) {
    try {
      await SecurityLogs.insertOne({
        event, // e.g. 'login_failed', 'login_success_privileged', 'password_changed', ...
        detail,
        ip: req?.ip,
        path: req?.originalUrl,
        created_at: new Date(),
      });
    } catch (err) {
      console.error('security log write failed', err); // never let logging itself break the request
    }
  }
  // NEW: online tests — faculty-authored, auto-graded, one attempt per student.
  const Tests = db.collection('tests');
  const TestSubmissions = db.collection('test_submissions');
  // NEW: code tests — logs every code run/attempt (pass or fail) with a
  // timestamp, even when the solution is rejected and never becomes a
  // TestSubmissions row. Lets faculty see when a student attempted a
  // problem regardless of whether they ever solved it.
  const CodeAttempts = db.collection('code_test_attempts');
  // NEW: records the first moment each student actually opens a test, so
  // the countdown can be based on real join time (or the test's scheduled
  // start, whichever is later) instead of always handing out the full
  // duration no matter how late the student arrives.
  const TestJoins = db.collection('test_joins');
  // Tab/page-switch monitoring log for tests in progress. The /activity
  // endpoint below logs "student left the tab" observations (blur/hidden)
  // and never itself submits anything. A real tab switch (Page Visibility
  // API reporting the page hidden) additionally triggers an automatic
  // submission from the frontend — see the /submit route's 'tab_switch'
  // reason — which also writes a 'tab_switch_auto_submit' row here so the
  // auto-submission itself is part of this same activity/attempt history.
  const TestActivity = db.collection('test_activity');
  // NEW: Test Monitoring — one row per (test, student), pointing at that
  // student's single most-recent camera+mic recording chunk in
  // `monitoringBucket`. There's only ever one chunk on disk per student
  // per test — each new upload replaces the previous one — so this is a
  // rolling "latest snapshot", not a growing recording archive.
  const TestMonitoringStreams = db.collection('test_monitoring_streams');
  // UPDATED: Saved Tests — reusable question-paper templates a faculty member
  // can "Save Test" from and later "Use Again" to spin up a brand new
  // Conducted Test (a Tests row) without retyping every question. This
  // collection is intentionally independent of Tests: deleting a
  // Conducted Test never touches the SavedTests row it came from (or vice
  // versa), and there is no cascade-delete relationship between the two.
  const SavedTests = db.collection('saved_tests');
  // NEW: in-app notifications — one row per (user, action), driving the bell
  // icon and the "new item" red dot next to each sidebar module.
  const Notifications = db.collection('notifications');
  // NEW: Web Push subscriptions — one row per (user, browser/device). A
  // user can be subscribed on several devices at once (phone browser,
  // laptop browser, …); each gets its own row here, keyed uniquely by
  // `endpoint` (the push service URL the browser handed back, which is
  // inherently unique per browser installation). Dead rows (uninstalled,
  // permission revoked, expired) are pruned automatically by
  // sendPushToUsers() the next time a push to them fails permanently.
  const PushSubscriptions = db.collection('push_subscriptions');
  // NEW: faculty-controlled leaderboard point adjustments — one row per
  // student, storing a cumulative +/- adjustment a faculty member applied
  // on top of the normally-computed score (see buildLeaderboard below). A
  // faculty member may only write a row for a student in one of their own
  // assigned sections (enforced in the route, not here).
  const LeaderboardAdjustments = db.collection('leaderboard_adjustments');
  // NEW (Point Ledger — central, extensible point-transaction system).
  // Every point a student earns from ANY module is recorded here as its
  // own immutable row: { student_username, college_id, source, points,
  // reference_id, description, created_at }. `source` is a short category
  // key (e.g. 'TEST', 'ATTENDANCE', 'COMPETITION', 'ASSIGNMENT', 'OTHER')
  // and `reference_id` ties the row back to whatever produced it (a test
  // submission id, an attendance record id, etc). The unique index on
  // (student_username, source, reference_id) is what makes awardPoints()
  // below idempotent — re-processing the same event twice (a retried
  // request, a duplicate webhook) can never double-award. Because the main
  // leaderboard (buildLeaderboard) sums this ledger grouped by `source`,
  // any future module can start writing rows with a brand-new `source`
  // value and it will automatically show up as its own leaderboard
  // category — no leaderboard code changes required.
  const PointTransactions = db.collection('point_transactions');
  // NEW: one row per (test, student) rejoin request — see the Rejoin
  // Request System.
  const TestRejoinRequests = db.collection('test_rejoin_requests');
  // NEW: Test Session Persistence (item 5/10) — one row per (test,
  // student) holding their in-progress answers + which question they were
  // on, autosaved periodically by the frontend while the test is open.
  // Read back on every GET /api/student/tests/:id so a refresh, an
  // accidental navigation, or a full logout/login mid-test restores
  // exactly where the student left off instead of showing a blank test.
  // Deleted the moment a final submission exists (see /submit above).
  const TestProgress = db.collection('test_progress');
  // NEW: AO (Administrative Officer) Office Fee Management — one row per
  // student, holding every fee type AO has configured for them (Tuition,
  // Hostel, Transport, etc). Deliberately a separate collection from
  // Users: fee records are AO's own domain, offline-entered from college
  // records, and never touched by anything else in the app (no online
  // payment flow writes here — see the AO routes below for why that's a
  // hard rule, not just a UI omission). A student with no row here simply
  // has no fee types configured yet.
  const StudentFees = db.collection('student_fees');
  await StudentFees.createIndex({ student_username: 1 }, { unique: true });
  // NEW: Python Full Course — one row per student, tracking their progress
  // through the static PY_COURSE content (see pythonCourseData.js). This is
  // the only persistent state for the course; the course structure itself
  // (modules/lessons/tests) is static data, not stored per-college/DB, so
  // every student on every college sees the same curriculum today. That
  // keeps this a clean, additive feature: it reuses the existing Users/
  // session auth exactly as-is and shares the existing code-execution
  // engine (runCodeAgainstTestCases / Judge0, defined further down) rather
  // than standing up a second compiler — see the /api/student/python-course
  // routes near the bottom of this file.
  const PythonCourseProgress = db.collection('python_course_progress');
  await PythonCourseProgress.createIndex({ student_username: 1 }, { unique: true });

  // NEW: Face Recognition Attendance — additive second attendance method,
  // layered on top of the existing timetable-driven manual attendance
  // above. Three collections:
  //  - FaceProfiles: one row per student holding their face embedding
  //    (a 128-length descriptor, never a raw image). `status` is
  //    'active' or 'invalidated' — a student never has more than one
  //    active profile, and re-registering is only possible either the
  //    first time ever, or after a faculty-approved update request
  //    invalidates the previous one (see routes below).
  //  - FaceUpdateRequests: a student's request to re-register their face,
  //    routed to the faculty who owns their section, with an
  //    approve/reject decision and a one-time-use `consumed` flag so an
  //    approval only ever grants exactly one new registration.
  //  - FaceAttendanceSessions: a short-lived, per-(section, date, hour)
  //    session a faculty member opens to run live recognition against
  //    the camera before confirming. It never stores embeddings or raw
  //    frames — only which students have been matched present so far.
  //    Once confirmed it writes a normal row into `Attendance` (below)
  //    and is deleted; a cancelled session is deleted with nothing
  //    written. This keeps Face Recognition Attendance from ever being a
  //    second source of truth for attendance — `Attendance` stays the
  //    single ledger for both methods, just tagged by `method`.
  const FaceProfiles = db.collection('face_profiles');
  const FaceUpdateRequests = db.collection('face_update_requests');
  const FaceAttendanceSessions = db.collection('face_attendance_sessions');
  await FaceProfiles.createIndex({ id: 1 }, { unique: true });
  await FaceProfiles.createIndex({ student_username: 1 }, { unique: true });
  await FaceUpdateRequests.createIndex({ id: 1 }, { unique: true });
  await FaceUpdateRequests.createIndex({ student_username: 1, status: 1 });
  await FaceAttendanceSessions.createIndex({ id: 1 }, { unique: true });
  await FaceAttendanceSessions.createIndex({ section_id: 1, date: 1, hour: 1, status: 1 });
  // Euclidean-distance threshold below which two face descriptors are
  // considered the same person. face-api.js (the client-side model this
  // is built against) recommends ~0.6 for its 128-d recognition
  // descriptor; we use a slightly stricter default to reduce false
  // positives, since a false-positive here means the wrong student gets
  // marked present. Configurable via env for tuning against real camera
  // hardware in the field.
  const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD) || 0.5;
  const FACE_DESCRIPTOR_LENGTH = 128;

  // Root-cause fix for slow face-recognition attendance (backend half):
  // /session/:id/detect is polled every ~600ms for the whole time a
  // faculty member is scanning, and before this fix it re-ran a full
  // roster query (Users) + a full descriptor query (FaceProfiles) from
  // the database on EVERY single one of those calls — even though the
  // roster and registered faces for a section cannot change mid-session
  // in the overwhelming common case. That's two avoidable DB round-trips
  // added to the latency of every recognition tick. This cache holds the
  // roster+profiles computed once at session start (where they were
  // already being fetched anyway) and reuses them for the session's
  // lifetime. A short TTL (rather than "forever") is the deliberate
  // safety margin for the one case this DOES need to catch: a student
  // completing face registration WHILE a session is actively running —
  // after the TTL, the next tick transparently refetches and re-caches,
  // so that student becomes recognizable within one refresh window
  // instead of only at the next scan.
  const FACE_SESSION_ROSTER_TTL_MS = 60_000;
  const faceSessionRosterCache = new Map(); // sessionId -> { roster, rosterUsernames, profiles, expiresAt }
  async function getFaceSessionRosterCached(sessionId, collegeId, sectionId) {
    const cached = faceSessionRosterCache.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const roster = await Users.find({ role: 'student', college_id: collegeId, section_id: sectionId }, { projection: { password_hash: 0, _id: 0 } }).toArray();
    const rosterUsernames = roster.map(s => s.username);
    const profiles = rosterUsernames.length ? await FaceProfiles.find({ student_username: { $in: rosterUsernames }, status: 'active' }).toArray() : [];
    const entry = { roster, rosterUsernames, profiles, expiresAt: Date.now() + FACE_SESSION_ROSTER_TTL_MS };
    faceSessionRosterCache.set(sessionId, entry);
    return entry;
  }
  function invalidateFaceSessionRosterCache(sessionId) {
    faceSessionRosterCache.delete(sessionId);
  }

  function isValidDescriptor(d) {
    return Array.isArray(d) && d.length === FACE_DESCRIPTOR_LENGTH && d.every((n) => typeof n === 'number' && Number.isFinite(n));
  }
  function euclideanDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const diff = a[i] - b[i]; sum += diff * diff; }
    return Math.sqrt(sum);
  }
  // Never let a face descriptor (or anything derived only for internal
  // matching) leak into a JSON response or a log line — every response
  // below is built from an explicit allow-list of fields instead of
  // spreading a raw FaceProfiles/session document.
  function publicFaceStatus(profile, pendingRequest) {
    return {
      registered: !!profile && profile.status === 'active',
      registered_at: profile && profile.status === 'active' ? profile.registered_at : null,
      update_request: pendingRequest ? { id: pendingRequest.id, status: pendingRequest.status, requested_at: pendingRequest.requested_at, reason: pendingRequest.reason } : null,
    };
  }

  await Users.createIndex({ username: 1 }, { unique: true });
  await Users.createIndex({ id: 1 }, { unique: true });
  // Root-cause fix: college_id+section_id+role is the exact shape of the
  // roster query hit on every face-attendance session start/detect tick,
  // every normal-attendance roster load, and leaderboard/analytics builds
  // — all previously unindexed, meaning MongoDB collection-scanned Users
  // for every one of those calls.
  await Users.createIndex({ college_id: 1, section_id: 1, role: 1 });
  // Root-cause fix: {section_id, date, hour} is the exact shape of the
  // duplicate-attendance check hit on every attendance submission (normal
  // AND face-recognition) and every face-session start — previously
  // unindexed. Also serves the section_id-only and section_id+date lookups
  // used elsewhere (a compound index's leading fields work as a prefix
  // index) and the leaderboard/analytics section_id-scoped queries above.
  await Attendance.createIndex({ section_id: 1, date: 1, hour: 1 });
  await Marks.createIndex({ section_id: 1 });
  await Sessions.createIndex({ token: 1 }, { unique: true });
  await Colleges.createIndex({ id: 1 }, { unique: true });
  await Sections.createIndex({ id: 1 }, { unique: true });
  await Clubs.createIndex({ id: 1 }, { unique: true });
  await ClubQuizzes.createIndex({ id: 1 }, { unique: true });
  // Root-cause fix (504s on the Live Quiz "Waiting to start" screen):
  // GET /api/competition-quizzes (the quiz list) filters+sorts by
  // {college_id, created_at} and POST /join looks a quiz up by
  // {college_id, quiz_code} — both were previously unindexed, forcing a
  // full collection scan on every call.
  await ClubQuizzes.createIndex({ college_id: 1, created_at: -1 });
  await ClubQuizzes.createIndex({ college_id: 1, quiz_code: 1 });
  await ClubQuizParticipants.createIndex({ id: 1 }, { unique: true });
  try {
    await ClubQuizParticipants.dropIndex('quiz_id_1_club_id_1');
  } catch (e) {}
  await ClubQuizParticipants.createIndex({ quiz_id: 1, username: 1 }, { unique: true });
  // Root-cause fix: {quiz_id, username} is the EXACT shape of the
  // participant lookup that runs on every single poll of the Live Quiz
  // session endpoint (GET .../session), plus .../answer, .../leaderboard
  // and .../participants — i.e. it fires roughly once a second from every
  // connected client for the entire lifetime of a quiz. This was
  // previously unindexed (only {quiz_id, club_id} existed, which doesn't
  // cover a `username` filter), so under any real concurrent load this
  // became an in-memory scan of every participant row per quiz per poll,
  // which is precisely what was driving MongoDB latency up and, with
  // enough concurrent pollers, causing requests to queue behind slow
  // queries long enough for the reverse proxy to give up with a 504.
  await ClubQuizParticipants.createIndex({ quiz_id: 1, username: 1 });
  // Supports the participants-list sort (ORDER BY joined_at) without an
  // in-memory sort, and the leaderboard sort below.
  await ClubQuizParticipants.createIndex({ quiz_id: 1, joined_at: 1 });
  await ClubQuizParticipants.createIndex({ quiz_id: 1, total_score: -1, joined_at: 1 });
  await SavedClubQuizzes.createIndex({ id: 1 }, { unique: true });
  await SavedClubQuizzes.createIndex({ college_id: 1, created_at: -1 });
  await ForumPosts.createIndex({ id: 1 }, { unique: true });
  await ForumReplies.createIndex({ id: 1 }, { unique: true });
  await Tests.createIndex({ id: 1 }, { unique: true });
  await TestActivity.createIndex({ test_id: 1, occurred_at: -1 });
  await TestActivity.createIndex({ test_id: 1, student_username: 1 });
  await TestSubmissions.createIndex({ id: 1 }, { unique: true });
  await TestSubmissions.createIndex({ test_id: 1, student_username: 1 }, { unique: true });
  // Backs the submission-order leaderboard query below (sort by
  // submitted_at within a test) so ranking stays fast and consistent as
  // submissions grow.
  await TestSubmissions.createIndex({ test_id: 1, submitted_at: 1 });
  await CodeAttempts.createIndex({ id: 1 }, { unique: true });
  await TestJoins.createIndex({ id: 1 }, { unique: true });
  await TestJoins.createIndex({ test_id: 1, student_username: 1 }, { unique: true });
  await TestMonitoringStreams.createIndex({ test_id: 1, student_username: 1 }, { unique: true });
  await SavedTests.createIndex({ id: 1 }, { unique: true });
  await SavedTests.createIndex({ faculty_username: 1, created_at: -1 });
  await CodeAttempts.createIndex({ test_id: 1, question_id: 1, student_username: 1, attempted_at: -1 });
  await Notifications.createIndex({ id: 1 }, { unique: true });
  await Notifications.createIndex({ user_username: 1, read: 1, created_at: -1 });
  await PushSubscriptions.createIndex({ id: 1 }, { unique: true });
  await PushSubscriptions.createIndex({ endpoint: 1 }, { unique: true });
  await PushSubscriptions.createIndex({ user_username: 1 });
  await Subjects.createIndex({ id: 1 }, { unique: true });
  await Subjects.createIndex({ college_id: 1, department: 1 });
  await AcademicCalendar.createIndex({ id: 1 }, { unique: true });
  // A given (college, department, year-or-null, date) can only ever have
  // one calendar status — this is what "editing" a date actually is
  // (upsert onto this key), and what stops duplicate rows for the same
  // date from accidentally existing (see item 15 of the spec).
  await AcademicCalendar.createIndex({ college_id: 1, department: 1, year: 1, date: 1 }, { unique: true });
  await AcademicCalendar.createIndex({ college_id: 1, department: 1, date: 1 });
  await LeaderboardAdjustments.createIndex({ student_username: 1 }, { unique: true });
  await PointTransactions.createIndex({ id: 1 }, { unique: true });
  // Idempotency guard — one ledger row per (student, source, reference).
  await PointTransactions.createIndex({ student_username: 1, source: 1, reference_id: 1 }, { unique: true });
  await PointTransactions.createIndex({ college_id: 1, source: 1 });
  await TestRejoinRequests.createIndex({ id: 1 }, { unique: true });
  await TestRejoinRequests.createIndex({ test_id: 1, student_username: 1 });
  await TestProgress.createIndex({ test_id: 1, student_username: 1 }, { unique: true });

  // Seed the one Super Admin account, the very first time the DB is used.
  // No predictable/default credentials are ever created: the very first
  // Super Admin must come from explicit, secure administrator configuration
  // (SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD env vars), never from a
  // hardcoded "owner/owner123"-style default. If those aren't set, no
  // account is created and the server logs instructions — never the
  // password itself — so an operator can supply one and restart. Once a
  // Super Admin exists, this block never runs again and never resets it.
  const superExists = await Users.findOne({ role: 'super_admin' });
  if (!superExists) {
    const initialUsername = String(process.env.SUPER_ADMIN_USERNAME || '').trim();
    const initialPassword = String(process.env.SUPER_ADMIN_PASSWORD || '');
    if (!initialUsername || !initialPassword) {
      console.error(
        'No Super Admin account exists yet. Set SUPER_ADMIN_USERNAME and a ' +
        'strong SUPER_ADMIN_PASSWORD (12+ characters) as environment ' +
        'variables and restart the server to create the initial account. ' +
        'Nothing was created.'
      );
    } else if (initialPassword.length < 12) {
      console.error('SUPER_ADMIN_PASSWORD must be at least 12 characters. Nothing was created — set a stronger password and restart.');
    } else {
      await Users.insertOne({
        id: 'u_owner',
        name: 'Platform Owner',
        username: initialUsername,
        password_hash: hashPassword(initialPassword),
        role: 'super_admin',
        college_id: null,
        trusted_phones: [], // Section 4/5/6/7 — up to 2 OTP-verified numbers, masked on read
        created_at: Date.now()
      });
      console.log(`Super Admin account created for username "${initialUsername}". (Password was not logged.)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Auth / scope helpers
  // ---------------------------------------------------------------------------
  const requireAuth = ah(async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const token = bearerToken || req.headers['x-session-token'] || req.query?.token || req.cookies[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Not signed in.' });
    const session = await Sessions.findOne({ token });
    if (!session) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    const user = await Users.findOne({ username: session.username });
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    if (user.college_id) {
      const college = await Colleges.findOne({ id: user.college_id });
      if (!college || college.status === 'disabled') {
        return res.status(403).json({ error: 'Your college account has been disabled. Contact the platform owner.' });
      }
    }
    req.user = user;
    req.token = token;
    // Staff Messaging (item 3/4) "Online/Offline" status — a lightweight,
    // best-effort presence signal rather than a dedicated heartbeat
    // endpoint: every authenticated request already proves the user is
    // active, so this piggybacks on that instead of adding new traffic.
    // Never awaited — presence accuracy is not worth delaying any request
    // for, and a failed write here is harmless (just a stale "last seen").
    Users.updateOne({ username: user.username }, { $set: { last_active_at: Date.now() } }).catch(() => {});
    next();
  });
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        logSecurityEvent('unauthorized_role_access', req, { username: req.user.username, role: req.user.role, required: roles });
        return res.status(403).json({ error: 'You do not have permission to do that.' });
      }
      next();
    };
  }
  async function startSession(res, username) {
    const token = crypto.randomBytes(24).toString('hex');
    await Sessions.insertOne({ token, username, created_at: Date.now() });
    // secure:true whenever NODE_ENV=production so the cookie is never sent
    // over plain HTTP in production, while still working on plain-HTTP
    // localhost during development.
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_MAX_AGE_MS
    });
    return token;
  }
  // UPDATED: posting is no longer "wherever your role automatically
  // cascades to" — the poster explicitly picks the audience (department /
  // year / section) for Announcements, Notes, and Events, within the
  // bounds their role is allowed to reach. A null target_* value means
  // "everyone at or below that level" (e.g. target_department: null on a
  // College Admin post = whole college; target_section_id: null with a
  // target_year set = every section in that department+year).
  async function buildTarget(user, body) {
    const requestedDept = (body.target_department || '').trim();
    const requestedYear = (body.target_year || '').trim();
    const requestedSectionId = (body.target_section_id || '').trim();

    if (user.role === 'college_admin') {
      let target_department = requestedDept || null;
      let target_year = target_department ? (requestedYear || null) : null;
      let target_section_id = null;
      if (requestedSectionId) {
        const sec = await Sections.findOne({ id: requestedSectionId, college_id: user.college_id });
        if (!sec) return { error: 'That section was not found in your college.' };
        target_department = sec.department;
        target_year = sec.year || null;
        target_section_id = sec.id;
      }
      return { college_id: user.college_id, target_department, target_year, target_section_id };
    }
    if (user.role === 'hod') {
      let target_section_id = null;
      let target_year = requestedYear || null;
      if (requestedSectionId) {
        const sec = await Sections.findOne({ id: requestedSectionId, college_id: user.college_id, department: user.department });
        if (!sec) return { error: 'That section is not in your department.' };
        target_section_id = sec.id;
        target_year = sec.year || null;
      }
      return { college_id: user.college_id, target_department: user.department, target_year, target_section_id };
    }
    if (user.role === 'faculty') {
      const sectionId = requestedSectionId && (user.section_ids || []).includes(requestedSectionId)
        ? requestedSectionId
        : (user.section_ids || [])[0];
      if (!sectionId) return { error: 'You need an assigned section before you can post.' };
      const sec = await Sections.findOne({ id: sectionId });
      return { college_id: user.college_id, target_department: user.department, target_year: sec ? (sec.year || null) : null, target_section_id: sectionId };
    }
    return { error: 'You cannot post this.' }; // super_admin and student cannot post
  }
  // Cascading visibility: an item is visible to a viewer if its target is
  // "wide enough" to include them — college-wide, their whole department,
  // their department+year, or their own specific section.
  async function visibilityFilter(user) {
    if (user.role === 'super_admin') return { college_id: '__none__' }; // super admin has no tenant content
    // College Admin oversees the whole college, so they see everything targeted within it.
    if (user.role === 'college_admin') return { college_id: user.college_id };
    if (user.role === 'hod') {
      return { college_id: user.college_id, $or: [{ target_department: null }, { target_department: user.department }] };
    }
    const mySections = user.role === 'student' ? [user.section_id].filter(Boolean) : (user.section_ids || []);
    const myYears = mySections.length ? (await Sections.find({ id: { $in: mySections } }).toArray()).map(s => s.year).filter(Boolean) : [];
    const or = [{ target_department: null }];
    if (user.department) {
      or.push({ target_department: user.department, target_year: null, target_section_id: null });
      for (const y of new Set(myYears)) or.push({ target_department: user.department, target_year: y, target_section_id: null });
    }
    if (mySections.length) or.push({ target_section_id: { $in: mySections } });
    return { college_id: user.college_id, $or: or };
  }
  function canManageContent(user, row) {
    if (row.author_username === user.username) return true;
    if (user.role === 'college_admin' && row.college_id === user.college_id) return true;
    if (user.role === 'hod' && row.college_id === user.college_id && row.target_department === user.department) return true;
    return false;
  }
  // ---------------------------------------------------------------------------
  // Timetable-driven attendance helpers (NEW).
  // ---------------------------------------------------------------------------
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  function dayOfWeekFromDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return DAY_NAMES[d.getDay()];
  }
  // Shared by every faculty/HOD-attendance route that needs a single
  // timetable slot (section + day + hour + whoever is signed in). Tries the
  // exact match first (the only path that runs for rows created through the
  // current, validated POST /api/hod/timetable). If that finds nothing, it
  // falls back to a case/whitespace-insensitive match so a slot written by
  // an earlier version of this feature (before day_of_week/faculty_username
  // were trimmed+validated on write) still resolves correctly — it never
  // writes anything back to the row itself. Logs when the fallback is what
  // actually found the slot, so a real mismatch is visible in the server
  // logs instead of silently "just working" forever.
  async function findMyTimetableSlot(Timetable, { section_id, day, hour, username }) {
    const exact = await Timetable.findOne({ section_id, day_of_week: day, hour: String(hour), faculty_username: username });
    if (exact) return exact;
    const normUser = username.trim().toLowerCase();
    const candidates = await Timetable.find({ section_id, hour: String(hour), day_of_week: { $regex: `^${day}$`, $options: 'i' } }).toArray();
    const fallback = candidates.find(r => String(r.faculty_username || '').trim().toLowerCase() === normUser);
    if (fallback) {
      console.warn('[timetable] normalized-match fallback used for slot lookup', {
        section_id, hour, day, username,
        sample_stored_faculty_username: fallback.faculty_username,
        sample_stored_day_of_week: fallback.day_of_week,
      });
    }
    return fallback || null;
  }
  async function findSemesterForDate(collegeId, department, dateStr) {
    if (!department) return null;
    return Semesters.findOne({ college_id: collegeId, department, start_date: { $lte: dateStr }, end_date: { $gte: dateStr } });
  }

  // ---------------------------------------------------------------------------
  // Academic Calendar helpers (NEW).
  // ---------------------------------------------------------------------------
  const CALENDAR_STATUSES = ['WORKING_DAY', 'HOLIDAY', 'SPECIAL_WORKING_DAY'];
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // India Standard Time, no DST

  // The app is used in India, and dates are stored as plain 'YYYY-MM-DD'
  // strings everywhere (see date/day_of_week usage above). Deriving
  // "today" from the server's raw UTC clock would flip to the next day at
  // 5:30am IST instead of midnight IST, silently shifting the
  // past/present/future boundary. This always returns the IST calendar
  // date regardless of the server's own timezone.
  function todayISTDateStr() {
    return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  }
  function isFutureDateStr(dateStr) {
    return dateStr > todayISTDateStr();
  }

  // Looks up the calendar status for one exact date, preferring a
  // year-specific entry over a department-wide (year: null) one — e.g. a
  // department-wide holiday can still be selectively overridden for one
  // year via a more specific row, and vice versa (a year can be given an
  // extra holiday without affecting the rest of the department).
  async function getCalendarEntryForDate(collegeId, department, year, dateStr) {
    if (year) {
      const specific = await AcademicCalendar.findOne({ college_id: collegeId, department, year, date: dateStr });
      if (specific) return specific;
    }
    return AcademicCalendar.findOne({ college_id: collegeId, department, year: null, date: dateStr });
  }

  // Single source of truth for Rules A/B/C/D (see spec item 16), called by
  // every attendance-marking path so the backend enforces this the same
  // way no matter which route/frontend button got there. Returns null when
  // attendance is allowed, or an { status, error } to send back otherwise.
  async function assertAttendanceDateAllowed({ collegeId, department, year, dateStr }) {
    if (isFutureDateStr(dateStr)) {
      return { status: 403, error: 'Attendance cannot be taken for a future date.' };
    }
    const entry = await getCalendarEntryForDate(collegeId, department, year, dateStr);
    if (entry && entry.status === 'HOLIDAY') {
      return { status: 403, error: `Attendance is unavailable for this date — it is a holiday${entry.reason ? ` (${entry.reason})` : ''}.` };
    }
    return null;
  }
  // NEW: an HOD can also be assigned as the teacher for a timetable slot
  // (see POST /api/hod/timetable's assignee_role: 'hod'), but an HOD never
  // gets `section_ids` populated the way a Faculty assignment does (see the
  // comment on that route) — HOD section access is derived from the
  // timetable itself instead. This is the single place every attendance
  // route below asks "which sections is this signed-in user actually
  // scheduled to teach", so Faculty and HOD are scoped identically and
  // consistently wherever it's used, without touching any of the existing
  // Faculty-only student-management routes (create/edit/delete students,
  // marks, points) that intentionally remain Faculty-only.
  async function myTeachingSectionIds(user) {
    if (user.role === 'hod') {
      const rows = await Timetable.find({ faculty_username: user.username, assignee_role: 'hod' }, { projection: { section_id: 1, _id: 0 } }).toArray();
      return [...new Set(rows.map(r => r.section_id))];
    }
    return user.section_ids || [];
  }
  // Shared by the HOD report, College Admin report, both CSV exports, and the
  // low-attendance alert route — computes each student's overall percentage
  // (across all subjects/hours) for a given scope, optionally within one semester.
  async function computeAttendanceReport({ college_id, department, semester_id }) {
    const studentFilter = { college_id, role: 'student' };
    if (department) studentFilter.department = department;
    const students = await Users.find(studentFilter, { projection: { password_hash: 0, _id: 0 } }).toArray();
    const sectionIds = [...new Set(students.map(s => s.section_id).filter(Boolean))];
    if (!sectionIds.length) return [];
    const attFilter = { section_id: { $in: sectionIds } };
    if (semester_id) attFilter.semester_id = semester_id;
    const rows = await Attendance.find(attFilter).toArray();
    const bySection = {};
    for (const r of rows) (bySection[r.section_id] = bySection[r.section_id] || []).push(r);
    return students.map(s => {
      let present = 0, total = 0;
      for (const r of (bySection[s.section_id] || [])) {
        const mine = r.records.find(x => x.student_username === s.username);
        if (mine) { total++; if (mine.present) present++; }
      }
      return {
        username: s.username, name: s.name, department: s.department, section_id: s.section_id, roll_number: s.roll_number,
        present_count: present, total_count: total, percentage: total ? Math.round((present / total) * 100) : null
      };
    });
  }
  async function connectionStatus(meUsername, otherUsername) {
    const row = await CollegeConnections.find({
      $or: [
        { from_username: meUsername, to_username: otherUsername },
        { from_username: otherUsername, to_username: meUsername }
      ]
    }).sort({ created_at: -1 }).limit(1).next();
    if (!row) return { state: 'none' };
    if (row.status === 'accepted') return { state: 'connected', requestId: row.id };
    if (row.status === 'declined') return { state: 'none' };
    if (row.from_username === meUsername) return { state: 'pending_sent', requestId: row.id };
    return { state: 'pending_received', requestId: row.id };
  }

  // ---------------------------------------------------------------------------
  // Notifications — every meaningful action in the app writes one row per
  // recipient here. The frontend polls this to (a) drive the bell/notification
  // panel and (b) light up a red "unread" dot next to whichever sidebar module
  // the item belongs to (tab), which fades out once that tab is opened.
  // ---------------------------------------------------------------------------
  // Which page a notification's `tab` should deep-link to — mirrors
  // Frontend/src/pages/Notifications.jsx's TAB_ROUTES exactly, so a click
  // on the OS push notification lands on the same page a click on the
  // in-app bell item would. Tabs with no dedicated route yet (network,
  // forum, announcements, mymarks, ...) fall back to /notifications,
  // which always exists and shows the item.
  const NOTIFICATION_TAB_ROUTES = {
    events: '/events', notes: '/notes', clubs: '/clubs', myattendance: '/attendance',
    placements: '/placements', messages: '/messages', tests: '/tests', board: '/board',
    courses: '/courses',
    // College Admin has no generic /courses page (that's student/faculty
    // only) — their course-access visibility lives at Request Course, so
    // notifications aimed at them use this distinct tab rather than
    // 'courses' above, which would otherwise send them to a page their
    // role can't open.
    course_access: '/college/request-course',
  };
  function notificationUrl(tab) {
    return NOTIFICATION_TAB_ROUTES[tab] || '/notifications';
  }

  async function notifyUsers(usernames, payload) {
    const list = [...new Set((usernames || []).filter(Boolean))];
    if (!list.length) return;
    const now = Date.now();
    const docs = list.map(u => ({
      id: newId('notif'), user_username: u, college_id: payload.college_id || null,
      tab: payload.tab, type: payload.type, title: payload.title, message: payload.message || '',
      related_id: payload.related_id || null, read: false, created_at: now
    }));
    await Notifications.insertMany(docs);
    // Fire the real OS-level push for every recipient above — this is the
    // ONE place all ~30 call sites of notifyUsers() across the app funnel
    // through, so every kind of in-app notification (new messages, HOD↔HOD
    // and HOD↔Faculty messages, test published/updated, results, rejoin
    // decisions, course lock/unlock, announcements, ...) automatically
    // gets a matching device push with zero risk of a call site forgetting
    // to wire it up. Fire-and-forget: a push failure must never break the
    // action that triggered the notification.
    sendPushToUsers(list, {
      title: payload.title,
      body: payload.message || '',
      data: { url: notificationUrl(payload.tab), tab: payload.tab, type: payload.type, related_id: payload.related_id || null }
    }).catch(err => console.error('push send failed', err));
  }

  // ---------------------------------------------------------------------------
  // Real-time layer (item: replace/augment polling with WebSocket push).
  // A lightweight room-based pub/sub, built on the SAME `ws` package already
  // used for Test Monitoring's WebRTC signalling below — not a second
  // dependency, not a parallel system. It runs on its own path (/ws/live)
  // on the same underlying HTTP server, set up alongside the existing
  // /ws/monitoring socket further down this file (search "wssLive").
  //
  // Design choice, stated plainly: broadcasts carry only a room key and an
  // event type — NEVER the actual data (no scores, no names, no answers).
  // A message is purely "something in this room changed, refetch it" — the
  // client then re-calls the same authenticated REST endpoint it already
  // uses for polling. This means the socket layer can never leak data a
  // user isn't independently authorized to fetch, because it never carries
  // any data in the first place; the only thing that needs authorizing is
  // which rooms a socket may join, which subscribeToRoom() below checks
  // against the exact same rules as the matching REST endpoint.
  //
  // Kept intentionally simple (join/leave/broadcast, no fan-out clustering,
  // no message queue) because this app runs as a single Node process — if
  // it's ever horizontally scaled, this in-memory room map would need to
  // move to a shared broker (e.g. Redis pub/sub); noted here rather than
  // building that out speculatively for a single-process deployment.
  const realtimeRooms = new Map(); // room key -> Set<ws>
  function joinRoom(room, ws) {
    if (!realtimeRooms.has(room)) realtimeRooms.set(room, new Set());
    realtimeRooms.get(room).add(ws);
    if (!ws._rooms) ws._rooms = new Set();
    ws._rooms.add(room);
  }
  function leaveAllRooms(ws) {
    for (const room of ws._rooms || []) {
      const set = realtimeRooms.get(room);
      if (set) { set.delete(ws); if (set.size === 0) realtimeRooms.delete(room); }
    }
    ws._rooms = new Set();
  }
  // Fire-and-forget: a broadcast to an empty/nonexistent room (nobody
  // currently watching) is just a no-op, so every call site below can fire
  // these unconditionally without checking who's listening first.
  function broadcastToRoom(room, payload) {
    const set = realtimeRooms.get(room);
    if (!set || !set.size) return;
    const msg = JSON.stringify({ room, ...payload });
    for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(msg); }
  }
  // Re-validates a subscribe request against the SAME authorization rules
  // as the REST endpoint that room's data ultimately comes from, so a
  // socket can never be used to learn about a test/college/user's activity
  // the connecting user couldn't already query for over REST.
  async function canSubscribeToRoom(user, room) {
    const [kind, ...rest] = room.split(':');
    if (kind === 'user') return rest[0] === user.username;
    if (kind === 'leaderboard' && rest[0] === 'college') return rest[1] === user.college_id;
    if (kind === 'test_leaderboard') {
      const test = await Tests.findOne({ id: rest[0] });
      if (!test) return false;
      if (user.role === 'student') return user.section_id === test.section_id;
      if (user.role === 'faculty') return test.created_by === user.username;
      return ['hod', 'college_admin'].includes(user.role) && test.college_id === user.college_id;
    }
    if (kind === 'test_live' || kind === 'test_rejoin') {
      const test = await Tests.findOne({ id: rest[0] });
      if (!test) return false;
      if (user.role === 'faculty') return test.created_by === user.username;
      if (user.role === 'hod') {
        const section = await Sections.findOne({ id: test.section_id });
        return test.college_id === user.college_id && section?.department === user.department;
      }
      return false;
    }
    return false;
  }
  // Sends a real OS-level device push notification (standard Web Push
  // Protocol + VAPID, via the `web-push` package) to every subscribed
  // device belonging to the given usernames, on top of the in-app
  // notification row from notifyUsers() above. A user with several
  // subscribed devices (phone browser, laptop browser, ...) gets pushed
  // on all of them. Silently does nothing if VAPID isn't configured (see
  // vapidReady above) or if none of the given users have a subscription,
  // so it's always safe to call — a missing/denied subscription is never
  // an error, just a no-op for that recipient.
  async function sendPushToUsers(usernames, { title, body, data } = {}) {
    const list = [...new Set((usernames || []).filter(Boolean))];
    if (!vapidReady || !list.length) return;
    const subs = await PushSubscriptions.find({ user_username: { $in: list } }).toArray();
    if (!subs.length) return;
    const payload = JSON.stringify({
      title: title || 'Campus Orbis',
      body: body || '',
      icon: '/logo.png',
      badge: '/logo.png',
      tag: data?.related_id ? `${data.tab || 'notif'}-${data.related_id}` : undefined, // collapses rapid duplicate pushes about the same item into one OS notification instead of stacking spam
      data: data || {},
    });
    // Every device gets its push independently and in parallel — one
    // slow/unreachable push service (or one dead subscription) must never
    // delay or block delivery to the rest.
    const deadEndpoints = [];
    await Promise.allSettled(subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      } catch (err) {
        // 404/410 = the push service itself says this subscription is
        // gone for good (browser uninstalled, permission revoked,
        // subscription expired) — anything else (network blip, 5xx from
        // the push service) is left alone and simply retried next time.
        if (err.statusCode === 404 || err.statusCode === 410) {
          deadEndpoints.push(sub.endpoint);
        } else {
          console.error('Push notification send failed:', sub.endpoint, err.statusCode || '', err.message);
        }
      }
    }));
    if (deadEndpoints.length) await PushSubscriptions.deleteMany({ endpoint: { $in: deadEndpoints } });
  }
  // Given the same college/department/year/section targeting used by
  // Announcements/Notes/Events, resolve which usernames would actually see
  // that item — mirrors visibilityFilter() above, but the other way round
  // (from a target down to a list of users instead of a Mongo filter).
  async function usersForTarget(college_id, target_department, target_year, target_section_id, excludeUsername) {
    const all = await Users.find(
      { college_id, username: { $ne: excludeUsername }, role: { $ne: 'super_admin' } },
      { projection: { username: 1, role: 1, department: 1, section_id: 1, section_ids: 1, _id: 0 } }
    ).toArray();
    const sectionYearCache = new Map();
    async function sectionYear(id) {
      if (!id) return null;
      if (!sectionYearCache.has(id)) {
        const sec = await Sections.findOne({ id });
        sectionYearCache.set(id, sec ? (sec.year || null) : null);
      }
      return sectionYearCache.get(id);
    }
    const result = [];
    for (const u of all) {
      if (u.role === 'college_admin') { result.push(u.username); continue; }
      if (target_department && u.department !== target_department) continue;
      if (u.role === 'hod') { result.push(u.username); continue; }
      const mySections = u.role === 'student' ? [u.section_id].filter(Boolean) : (u.section_ids || []);
      if (target_section_id) { if (mySections.includes(target_section_id)) result.push(u.username); continue; }
      if (target_year) {
        let matches = false;
        for (const sid of mySections) { if ((await sectionYear(sid)) === target_year) { matches = true; break; } }
        if (matches) result.push(u.username);
        continue;
      }
      result.push(u.username);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // App setup
  // ---------------------------------------------------------------------------
  const { buildSecurityHeaders } = require('./middleware/securityHeaders');
  const { loginLimiter, otpLimiter, otpResendLimiter, passwordResetLimiter, codeExecutionLimiter, uploadLimiter, messagingLimiter, generalApiLimiter } = require('./middleware/rateLimiters');
  const mongoSanitize = require('express-mongo-sanitize');

  const app = express();
  app.set('trust proxy', 1); // needed for express-rate-limit / secure cookies to see the real client IP behind a reverse proxy (Render/Heroku/nginx, etc.)
  app.use(buildSecurityHeaders());
  // 1mb comfortably covers every legitimate JSON payload in this app (files
  // go through multer/multipart, never JSON) while blocking oversized-body
  // abuse of the parser itself.
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  // CORS (Section 27): off by default (current same-origin deployment, where
  // Backend/public IS the frontend, needs no CORS headers at all — the
  // secure default is simply not sending any). If a future deployment splits
  // the frontend onto its own origin, set ALLOWED_ORIGINS to a comma-separated
  // allowlist and credentialed requests from exactly those origins will be
  // permitted. This is never allowed to become `origin: '*'` with credentials
  // — that combination is rejected by browsers anyway, and intentionally not
  // supported here even for same-origin-without-credentials cases, since
  // this app has no unauthenticated cross-origin use case.
  const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const isAllowed = allowedOrigins.length === 0 ||
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin) ||
        origin.endsWith('.vercel.app') ||
        origin.includes('localhost');
      if (isAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Session-Token,x-session-token');
        res.setHeader('Vary', 'Origin');
      }
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Session-Token,x-session-token');
      return res.sendStatus(204);
    }
    next();
  });
  // Global NoSQL-injection defense (Section 8): strips any object key that
  // starts with "$" or contains "." from req.body/req.query/req.params
  // before any route handler ever sees it. This is what stops a request
  // like {"username": {"$ne": null}} from ever reaching a Users.findOne()
  // call as a live MongoDB operator — the "$ne" key is removed, leaving an
  // empty object that matches nothing, instead of matching every document.
  // This is a blanket, route-independent backstop; it does not replace the
  // per-route type checks (e.g. the login route's explicit `typeof ===
  // 'string'` guards) which also reject the object/array shape outright.
  app.use(mongoSanitize());
  app.use('/api/', generalApiLimiter);
  // Root-cause fix (repeated 504s, esp. on the Live Quiz "Waiting to
  // start" screen): this is a hard response deadline, NOT a bigger
  // timeout to hide slowness behind. Every /api/ request now gets a firm
  // 20s ceiling — comfortably inside typical reverse-proxy gateway-timeout
  // windows (30-60s on Render/Heroku/nginx defaults) — after which THIS
  // server returns one clear, typed 503 JSON error itself, instead of the
  // request hanging until the proxy in front of it gives up and returns
  // its own opaque, un-catchable 504 HTML page. Combined with the
  // MongoClient timeouts above (which make a stuck DB call fail on its
  // own well before 20s), this guarantees requirement: no async operation
  // on this server can be left pending indefinitely — every request
  // resolves, one way or another, within a bounded time.
  // Root-cause fix (repeated 504s, esp. on the Live Quiz "Waiting to
  // start" screen): a hard response deadline, NOT a bigger timeout to
  // hide slowness behind. Deliberately scoped to ONLY the Competition
  // (Live Quiz) and Saved Club Quizzes routes — the ones actually being
  // hammered by 1-per-second polling from every connected client — rather
  // than applied blanket across /api/. A blanket deadline would be unsafe
  // here: this app also has routes that legitimately run past 20s under
  // real load (large Excel student/club bulk imports, note/poster/gallery
  // uploads, test-monitoring video chunk uploads), and firing a false
  // "taking too long" response on those while the real work keeps running
  // server-side would turn working features into broken ones. Competition
  // routes, by contrast, are small, fast, read-mostly JSON polls with no
  // legitimate reason to ever take anywhere near 20s — so a firm ceiling
  // there is safe and exactly matches the reported symptom.
  //
  // Combined with the MongoClient timeouts above (which make a stuck DB
  // call fail on its own well before 20s), this guarantees: no async
  // operation behind these routes can be left pending indefinitely —
  // every request resolves, one way or another, within a bounded time,
  // as one clear typed 503 JSON error instead of an opaque upstream 504.
  app.use(['/api/competition-quizzes', '/api/saved-club-quizzes'], (req, res, next) => {
    const deadline = setTimeout(() => {
      if (!res.headersSent) {
        res.status(503).json({ error: 'The server is taking too long to respond. Please try again in a moment.', code: 'REQUEST_TIMEOUT' });
      }
    }, 20000);
    res.on('finish', () => clearTimeout(deadline));
    res.on('close', () => clearTimeout(deadline));
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'start.html'));
  });

  // Public — the landing page footer shows how many colleges are on the platform.
  app.get('/api/public/stats', ah(async (req, res) => {
    const collegeCount = await Colleges.countDocuments({ status: 'active' });
    // UPDATED: counts everyone actually using the platform (students,
    // faculty, HODs, College Admins) — excludes the single super_admin
    // account, since that's the platform owner, not a "user" in the sense
    // this stat is meant to convey on the public home page.
    const userCount = await Users.countDocuments({ role: { $ne: 'super_admin' } });
    res.json({ colleges: collegeCount, users: userCount });
  }));

  // UPDATED: Public — powers the mandatory "select your college" screen shown
  // before the login form. No auth required (a visitor hasn't signed in yet),
  // and only active colleges are listed. Logos are served by the existing
  // /api/super/colleges/:id/logo route, which is already public.
  app.get('/api/public/colleges', ah(async (req, res) => {
    const colleges = await Colleges.find(
      { status: 'active' },
      { projection: { id: 1, name: 1, logo_file_id: 1 } }
    ).sort({ name: 1 }).toArray();
    res.json({ colleges: colleges.map(c => ({ id: c.id, name: c.name, has_logo: !!c.logo_file_id })) });
  }));

  // ---------- Auth (no signup — every account is created top-down) ----------
  // UPDATED: every role except Super Admin must now also send the college_id
  // chosen on the mandatory college-select screen, and that college must
  // actually match the account being signed into — this keeps one college's
  // users from being able to log in "under" another college by mistake.
  app.post('/api/auth/login', loginLimiter, ah(async (req, res) => {
    const { username, password, role, college_id } = req.body || {};
    // Reject anything but plain strings before it ever reaches a MongoDB
    // query — otherwise an attacker could send e.g. {"username":{"$ne":null}}
    // and match arbitrary documents instead of a specific account.
    if (typeof username !== 'string' || typeof role !== 'string' ||
        (college_id !== undefined && college_id !== null && typeof college_id !== 'string') ||
        (password !== undefined && typeof password !== 'string')) {
      return res.status(400).json({ error: 'Invalid login request.' });
    }
    if (!role) return res.status(400).json({ error: 'Role is required.' });
    const ALLOWED_ROLES = ['student', 'faculty', 'hod', 'college_admin', 'super_admin', 'ao'];
    if (!ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (role !== 'super_admin' && !college_id) {
      return res.status(400).json({ error: 'Please select your college first.' });
    }
    const cleanUsername = String(username || '').trim();
    const usernameRegex = new RegExp(`^${cleanUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    let user = await Users.findOne({ username: usernameRegex, role });

    if (!user) {
      const otherRoleUser = await Users.findOne({ username: usernameRegex });
      if (otherRoleUser) {
        const correctRoleName = otherRoleUser.role === 'college_admin' ? 'College Admin' : (otherRoleUser.role === 'super_admin' ? 'Super Admin' : otherRoleUser.role.toUpperCase());
        return res.status(400).json({
          error: `"${otherRoleUser.username}" account belongs to "${correctRoleName}", not "${role.replace('_', ' ').toUpperCase()}". Please click the "${correctRoleName}" button above.`
        });
      }
      return res.status(401).json({ error: `No matching ${role.replace('_', ' ')} account with username "${cleanUsername}".` });
    }

    let { valid, needsRehash } = verifyPassword(password || '', user && user.password_hash);
    if (!valid && password) {
      const trimmedPw = String(password).trim();
      if (trimmedPw !== password) {
        ({ valid, needsRehash } = verifyPassword(trimmedPw, user.password_hash));
      }
    }
    if (!valid && password) {
      const upperPw = String(password).trim().toUpperCase();
      if (upperPw === user.username) {
        ({ valid, needsRehash } = verifyPassword(upperPw, user.password_hash));
      }
    }

    if (!valid) {
      await logSecurityEvent('login_failed', req, { attempted_username: cleanUsername, role });
      return res.status(401).json({ error: 'Incorrect password. Please check your password and try again.' });
    }
    if (needsRehash) {
      // Transparent one-time upgrade off the legacy SHA-256 hash now that the
      // plaintext password has just been confirmed correct.
      await Users.updateOne({ username: user.username }, { $set: { password_hash: hashPassword(password) } });
    }
    if (role !== 'super_admin' && user.college_id !== college_id) {
      return res.status(401).json({ error: 'That account does not belong to the college you selected.' });
    }
    if (user.college_id) {
      const college = await Colleges.findOne({ id: user.college_id });
      if (!college || college.status === 'disabled') {
        return res.status(403).json({ error: 'This college account has been disabled.' });
      }
    }
    const token = await startSession(res, user.username);
    if (['super_admin', 'college_admin', 'hod'].includes(user.role)) {
      await logSecurityEvent('login_success_privileged', req, { username: user.username, role: user.role });
    }
    res.json({ user: publicUser(user), token });
  }));

  app.post('/api/auth/logout', requireAuth, ah(async (req, res) => {
    const token = req.token || req.cookies[SESSION_COOKIE];
    if (token) await Sessions.deleteOne({ token });
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  }));

  app.get('/api/me', requireAuth, ah(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }));

  // Global Search (item 16). Role-scoped exactly like every other list
  // endpoint in this file: a query never returns a record its own role
  // couldn't already see via the ordinary list routes. Not available to
  // students (the spec limits this to Faculty/HOD/College Admin/Super
  // Admin), and it's a single case/regex-based scan across the fields
  // requested (name, roll number, username/ID, branch/department,
  // section) rather than a separate search index — fine at this table
  // size, and it means results are always in sync with the live data with
  // no separate index to keep up to date.
  app.get('/api/search', requireAuth, requireRole('faculty', 'hod', 'college_admin', 'super_admin'), ah(async (req, res) => {
    const q = String((req.query || {}).q || '').trim();
    if (!q) return res.json({ students: [], faculty: [], hods: [], colleges: [] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const textMatch = (fields) => ({ $or: fields.map(f => ({ [f]: rx })) });
    const NAME_FIELDS = ['name', 'username', 'roll_number', 'department', 'section_id'];

    let userScope = null; // base filter every role's search is additionally constrained by
    let includeFaculty = false, includeHods = false, includeColleges = false;
    if (req.user.role === 'faculty') {
      userScope = { college_id: req.user.college_id, role: 'student', section_id: { $in: req.user.section_ids || [] } };
    } else if (req.user.role === 'hod') {
      userScope = { college_id: req.user.college_id, role: 'student', department: req.user.department };
      includeFaculty = true;
    } else if (req.user.role === 'college_admin') {
      userScope = { college_id: req.user.college_id, role: 'student' };
      includeFaculty = true; includeHods = true;
    } else if (req.user.role === 'super_admin') {
      userScope = { role: 'student' }; // college-wide isn't scoped further for super admin
      includeFaculty = true; includeHods = true; includeColleges = true;
    }

    const [students, faculty, hods, colleges] = await Promise.all([
      Users.find({ ...userScope, ...textMatch(NAME_FIELDS) }, { projection: { password_hash: 0, _id: 0 } }).limit(50).toArray(),
      includeFaculty
        ? Users.find({ ...(req.user.role === 'hod' ? { college_id: req.user.college_id, department: req.user.department } : { college_id: req.user.college_id }), role: 'faculty', ...textMatch(['name', 'username', 'department']) }, { projection: { password_hash: 0, _id: 0 } }).limit(50).toArray()
        : [],
      includeHods
        ? Users.find({ college_id: req.user.college_id, role: 'hod', ...textMatch(['name', 'username', 'department']) }, { projection: { password_hash: 0, _id: 0 } }).limit(50).toArray()
        : [],
      includeColleges
        ? Colleges.find(textMatch(['name', 'code']), { projection: { _id: 0 } }).limit(50).toArray()
        : []
    ]);
    res.json({ students, faculty, hods, colleges });
  }));

  app.post('/api/account/password', requireAuth, passwordResetLimiter, ah(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return res.status(400).json({ error: 'Fill in both password fields.' });
    if (typeof current_password !== 'string' || typeof new_password !== 'string') return res.status(400).json({ error: 'Invalid request.' });
    if (String(new_password).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    // Section 23: once a Super Admin has 2 verified trusted numbers, this
    // single-factor route is no longer sufficient for THAT account — force
    // the dual-OTP flow below instead. (Other roles, and a Super Admin with
    // fewer than 2 verified numbers, are unaffected.)
    if (req.user.role === 'super_admin' && (req.user.trusted_phones || []).filter(p => p.verified).length >= 2) {
      return res.status(400).json({ error: 'With two verified mobile numbers on file, password changes must go through OTP verification. Use the "Change password" flow on your Security page instead.' });
    }
    if (!verifyPassword(current_password, req.user.password_hash).valid) return res.status(401).json({ error: 'Current password is incorrect.' });
    await Users.updateOne({ username: req.user.username }, { $set: { password_hash: hashPassword(new_password) } });
    await logSecurityEvent('password_changed', req, { username: req.user.username, role: req.user.role });
    const currentToken = req.cookies[SESSION_COOKIE];
    await Sessions.deleteMany({ username: req.user.username, token: { $ne: currentToken } });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------------------
  // Sections 4-7: Super Admin trusted mobile numbers + OTP verification.
  // Everything below is scoped to the Super Admin's OWN account (username
  // comes from req.user, the authenticated session — never from the request
  // body), so there is no route parameter for another user's numbers to
  // manipulate in the first place; only requireRole('super_admin') plus
  // req.user identity is needed for that half of Section 7's requirement.
  // ---------------------------------------------------------------------------
  const otpService = require('./services/otpService');

  function publicPhone(p) {
    return { id: p.id, maskedNumber: otpService.maskPhone(p.phone), verified: !!p.verified };
  }

  // List the Super Admin's own trusted numbers — masked, always. There is no
  // code path anywhere (including this one) that returns a full number to
  // the frontend, even to the Super Admin themselves.
  app.get('/api/super/security/phones', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    res.json({ phones: (req.user.trusted_phones || []).map(publicPhone) });
  }));

  // Step 1 of adding a number: validate + send an OTP. The number is not
  // trusted (not returned by the list route, not usable for OTP challenges)
  // until the code is verified below.
  app.post('/api/super/security/phones', requireAuth, requireRole('super_admin'), otpResendLimiter, ah(async (req, res) => {
    const phone = String((req.body || {}).phone || '').replace(/\D/g, '');
    if (!otpService.isValidPhone(phone)) return res.status(400).json({ error: 'Enter a valid mobile number (digits only, 8-15 digits).' });
    const verifiedCount = (req.user.trusted_phones || []).filter(p => p.verified).length;
    if (verifiedCount >= 2) return res.status(400).json({ error: 'You already have 2 verified numbers. Remove one before adding another.' });
    if ((req.user.trusted_phones || []).some(p => p.verified && p.phone === phone)) {
      return res.status(400).json({ error: 'That number is already verified on your account.' });
    }
    const issued = await otpService.issueOtp(SuperAdminOtps, { purpose: 'add_phone', phone, newId });
    if (!issued.ok) return res.status(502).json({ error: issued.error });
    // Track the pending (unverified) phone directly on the user doc so a
    // browser refresh doesn't lose track of "add this number" state, but it
    // is never surfaced by the list route above and never counted toward
    // the max-2 limit until it's actually verified.
    await Users.updateOne({ username: req.user.username }, { $pull: { trusted_phones: { verified: false } } });
    await Users.updateOne({ username: req.user.username }, { $push: { trusted_phones: { id: newId('phone'), phone, verified: false, created_at: Date.now() } } });
    res.json({ ok: true, otp_id: issued.id });
  }));

  // Step 2: verify the code and flip that pending number to trusted.
  app.post('/api/super/security/phones/verify', requireAuth, requireRole('super_admin'), otpLimiter, ah(async (req, res) => {
    const { otp_id, code } = req.body || {};
    if (typeof otp_id !== 'string' || typeof code !== 'string') return res.status(400).json({ error: 'Invalid request.' });
    const result = await otpService.verifyOtp(SuperAdminOtps, { otpId: otp_id, code });
    if (!result.valid) return res.status(400).json({ error: result.error });
    if (result.purpose !== 'add_phone') return res.status(400).json({ error: 'Invalid code for this action.' });
    const fresh = await Users.findOne({ username: req.user.username });
    const verifiedCount = (fresh.trusted_phones || []).filter(p => p.verified).length;
    if (verifiedCount >= 2) return res.status(400).json({ error: 'You already have 2 verified numbers.' });
    const updateResult = await Users.updateOne(
      { username: req.user.username, 'trusted_phones.phone': result.phone, 'trusted_phones.verified': false },
      { $set: { 'trusted_phones.$.verified': true } }
    );
    if (!updateResult.matchedCount) return res.status(400).json({ error: 'That number is no longer pending verification. Start over.' });
    res.json({ ok: true });
  }));

  // Removing a trusted number is a sensitive security operation (Section 7):
  // requires the current password every time, PLUS an OTP to the *other*
  // trusted number when one exists, so a bare authenticated session can
  // never silently swap out the Super Admin's recovery numbers.
  app.post('/api/super/security/phones/:id/remove/initiate', requireAuth, requireRole('super_admin'), otpResendLimiter, ah(async (req, res) => {
    const { current_password } = req.body || {};
    if (typeof current_password !== 'string' || !verifyPassword(current_password, req.user.password_hash).valid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const target = (req.user.trusted_phones || []).find(p => p.id === req.params.id && p.verified);
    if (!target) return res.status(404).json({ error: 'Number not found.' });
    const other = (req.user.trusted_phones || []).find(p => p.id !== req.params.id && p.verified);
    if (!other) {
      // Only one trusted number on file — nothing left to challenge against.
      // Password re-verification above is the confirmation for this case.
      return res.json({ ok: true, requires_otp: false });
    }
    const issued = await otpService.issueOtp(SuperAdminOtps, { purpose: `remove_phone:${req.params.id}`, phone: other.phone, newId });
    if (!issued.ok) return res.status(502).json({ error: issued.error });
    res.json({ ok: true, requires_otp: true, otp_id: issued.id });
  }));

  app.delete('/api/super/security/phones/:id', requireAuth, requireRole('super_admin'), otpLimiter, ah(async (req, res) => {
    const { otp_id, code, current_password } = req.body || {};
    const target = (req.user.trusted_phones || []).find(p => p.id === req.params.id && p.verified);
    if (!target) return res.status(404).json({ error: 'Number not found.' });
    const other = (req.user.trusted_phones || []).find(p => p.id !== req.params.id && p.verified);
    if (other) {
      if (typeof otp_id !== 'string' || typeof code !== 'string') return res.status(400).json({ error: 'OTP verification is required to remove this number.' });
      const result = await otpService.verifyOtp(SuperAdminOtps, { otpId: otp_id, code });
      if (!result.valid || result.purpose !== `remove_phone:${req.params.id}`) return res.status(400).json({ error: result.error || 'Invalid code for this action.' });
    } else {
      if (typeof current_password !== 'string' || !verifyPassword(current_password, req.user.password_hash).valid) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
    }
    await Users.updateOne({ username: req.user.username }, { $pull: { trusted_phones: { id: req.params.id } } });
    await logSecurityEvent('super_admin_trusted_phone_removed', req, { username: req.user.username, phone_id: req.params.id });
    res.json({ ok: true });
  }));

  // Section 6: Super Admin password change requiring BOTH verified mobile
  // OTPs (only reachable at all once 2 numbers are verified — otherwise the
  // regular /api/account/password route above still applies).
  app.post('/api/super/security/password-change/initiate', requireAuth, requireRole('super_admin'), otpResendLimiter, ah(async (req, res) => {
    const { current_password } = req.body || {};
    if (typeof current_password !== 'string' || !verifyPassword(current_password, req.user.password_hash).valid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const verified = (req.user.trusted_phones || []).filter(p => p.verified);
    if (verified.length < 2) return res.status(400).json({ error: 'Two verified mobile numbers are required for this flow. Use the regular password-change form instead.' });
    const [phone1, phone2] = verified;
    const changeId = newId('pwchange');
    const otp1 = await otpService.issueOtp(SuperAdminOtps, { purpose: `password_change_1:${changeId}`, phone: phone1.phone, newId });
    if (!otp1.ok) return res.status(502).json({ error: otp1.error });
    const otp2 = await otpService.issueOtp(SuperAdminOtps, { purpose: `password_change_2:${changeId}`, phone: phone2.phone, newId });
    if (!otp2.ok) { await SuperAdminOtps.deleteOne({ id: otp1.id }); return res.status(502).json({ error: otp2.error }); }
    await SuperAdminPasswordChanges.insertOne({
      id: changeId, username: req.user.username,
      otp1_id: otp1.id, otp2_id: otp2.id,
      otp1_verified: false, otp2_verified: false,
      created_at: Date.now(), expires_at: new Date(Date.now() + otpService.OTP_TTL_MS),
    });
    res.json({ ok: true, change_id: changeId, otp1_id: otp1.id, otp2_id: otp2.id, masked_1: otpService.maskPhone(phone1.phone), masked_2: otpService.maskPhone(phone2.phone) });
  }));

  app.post('/api/super/security/password-change/verify', requireAuth, requireRole('super_admin'), otpLimiter, ah(async (req, res) => {
    const { change_id, slot, code } = req.body || {};
    if (typeof change_id !== 'string' || (slot !== 1 && slot !== 2) || typeof code !== 'string') {
      return res.status(400).json({ error: 'Invalid request.' });
    }
    const change = await SuperAdminPasswordChanges.findOne({ id: change_id, username: req.user.username });
    if (!change) return res.status(404).json({ error: 'This password-change request was not found or has expired.' });
    const otpId = slot === 1 ? change.otp1_id : change.otp2_id;
    const result = await otpService.verifyOtp(SuperAdminOtps, { otpId, code });
    if (!result.valid) return res.status(400).json({ error: result.error });
    const field = slot === 1 ? 'otp1_verified' : 'otp2_verified';
    await SuperAdminPasswordChanges.updateOne({ id: change_id }, { $set: { [field]: true } });
    const fresh = await SuperAdminPasswordChanges.findOne({ id: change_id });
    res.json({ ok: true, otp1_verified: fresh.otp1_verified, otp2_verified: fresh.otp2_verified, ready: fresh.otp1_verified && fresh.otp2_verified });
  }));

  app.post('/api/super/security/password-change/confirm', requireAuth, requireRole('super_admin'), passwordResetLimiter, ah(async (req, res) => {
    const { change_id, new_password } = req.body || {};
    if (typeof change_id !== 'string' || typeof new_password !== 'string' || new_password.length < 6) {
      return res.status(400).json({ error: 'Invalid request.' });
    }
    const change = await SuperAdminPasswordChanges.findOne({ id: change_id, username: req.user.username });
    if (!change) return res.status(404).json({ error: 'This password-change request was not found or has expired.' });
    if (!change.otp1_verified || !change.otp2_verified) {
      return res.status(400).json({ error: 'Both mobile numbers must be verified before the password can be changed.' });
    }
    await Users.updateOne({ username: req.user.username }, { $set: { password_hash: hashPassword(new_password) } });
    await SuperAdminPasswordChanges.deleteOne({ id: change_id });
    await logSecurityEvent('super_admin_password_changed_dual_otp', req, { username: req.user.username });
    const currentToken = req.cookies[SESSION_COOKIE];
    await Sessions.deleteMany({ username: req.user.username, token: { $ne: currentToken } });
    res.json({ ok: true });
  }));

  // NEW: the profile card (tap the avatar/profile icon on any dashboard) lets
  // a signed-in user update their own display name, plus (spec §4) gender
  // and avatar. Gender is optional here (existing accounts have none set,
  // and nothing breaks if it stays unset) — it's mandatory only on the
  // account-creation forms below. Setting gender auto-assigns a default
  // avatar the first time; the user can then pick a different one from
  // AVATAR_CATALOG without needing to touch gender again.
  const AVATAR_CATALOG = {
    student_male: ['student_male_1', 'student_male_2'],
    student_female: ['student_female_1', 'student_female_2'],
    faculty_male: ['faculty_male_1', 'faculty_male_2'],
    faculty_female: ['faculty_female_1', 'faculty_female_2']
  };
  function defaultAvatarFor(role, gender) {
    const roleKey = role === 'faculty' ? 'faculty' : 'student'; // hod/college_admin/super_admin default to the "faculty" illustration style
    const key = `${roleKey}_${gender === 'female' ? 'female' : 'male'}`;
    return AVATAR_CATALOG[key][0];
  }

  // ---------------------------------------------------------------------
  // Course / Year / Completion (AO Office item 1) — a single source of
  // truth for each course's duration, so "final year -> Completed" logic
  // is never hard-coded per course anywhere else in the file. Used by the
  // AO, HOD, Faculty, and Student sections alike so a student's academic
  // status is computed identically everywhere it's displayed.
  // ---------------------------------------------------------------------
  const COURSE_TYPES = ['btech', 'mtech', 'degree', 'diploma'];
  const COURSE_LABELS = { btech: 'B.Tech', mtech: 'M.Tech', degree: 'Degree', diploma: 'Diploma' };
  const COURSE_DURATIONS = { btech: 4, mtech: 2, degree: 3, diploma: 3 };
  function courseDurationYears(course) { return COURSE_DURATIONS[course] || null; }
  // Derives the full academic picture for a student from the three raw
  // fields stored on the user doc (course, current_year, academic_status).
  // "Completed" is only ever set explicitly by AO (never auto-flipped), but
  // is_final_year tells every UI when that action becomes available.
  function computeAcademicInfo(student) {
    const course = student.course || null;
    const duration = courseDurationYears(course);
    const currentYear = student.current_year != null ? Number(student.current_year) : null;
    const pending = !!course && !currentYear;
    const isFinalYear = !!course && !!currentYear && !!duration && currentYear >= duration;
    const academicStatus = student.academic_status === 'completed' ? 'completed' : (pending ? 'pending' : 'active');
    return {
      course, course_label: course ? (COURSE_LABELS[course] || course) : null,
      course_duration_years: duration, current_year: currentYear,
      is_final_year: isFinalYear, academic_status: academicStatus, pending,
    };
  }
  // Student Account Creation — Course & Year (item 5), shared by every
  // place a student account can be created (AO/HOD/Faculty Add Student).
  // Year is always optional here: Course with no Year is a valid, allowed
  // combination (the student lands on the Pending list, item 6) — it is
  // never silently treated as any particular year.
  function courseYearFieldsForCreate(course, current_year) {
    if (course === undefined || course === null || course === '') return { fields: { course: null, course_duration_years: null, current_year: null } };
    if (!COURSE_TYPES.includes(course)) return { error: 'Invalid course type.' };
    const duration = courseDurationYears(course);
    if (current_year === undefined || current_year === null || current_year === '') {
      return { fields: { course, course_duration_years: duration, current_year: null } };
    }
    if (!(Number(current_year) >= 1) || Number(current_year) > duration) {
      return { error: `Year must be between 1 and ${duration} for ${COURSE_LABELS[course]}.` };
    }
    return { fields: { course, course_duration_years: duration, current_year: Number(current_year) } };
  }

  // ---------------------------------------------------------------------
  // FIX: shared Excel/CSV bulk student import — used by HOD, Faculty and
  // AO import routes below. `scope.department` is fixed for HOD/Faculty
  // (their own department); null for AO, whose sections span every
  // department in the college. `scope.sections` is the set of sections
  // that role is allowed to assign — exactly the same scoping each
  // role's single "Add student" route already enforces.
  //   mode: 'preview' — parse + validate only, nothing is written.
  //   mode: 'import'  — re-parses and re-validates (never trusts the
  //                      client-sent preview), then writes the rows that
  //                      still pass.
  // "Section" is never required in the sheet; the section is chosen on
  // screen after upload (section_id in the request body) and applied to
  // every row. A per-row "Section" column, if present, is only used as a
  // fallback when no section was selected (keeps older sheets working).
  async function handleStudentSheetRequest(req, res, mode, scope) {
    if (!req.file) return res.status(400).json({ error: 'Please attach an Excel (.xlsx/.xls) or CSV file.' });
    const parsed = bulkImport.parseStudentSheet(XLSX, req.file.buffer);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let selectedSection = null;
    const sectionId = (req.body && req.body.section_id) || null;
    if (sectionId) {
      selectedSection = scope.sections.find((s) => s.id === sectionId) || null;
      if (!selectedSection) return res.status(400).json({ error: 'That section was not found.' });
    } else if (mode === 'import' && !parsed.has_section_column) {
      return res.status(400).json({ error: 'Choose a section to assign to these students.' });
    }

    const results = await bulkImport.validateStudentRows({
      Users, rows: parsed.rows, collegeId: scope.collegeId, department: scope.department,
      sections: scope.sections, selectedSection,
      // Section is only required to actually create students — the first
      // preview (before the user has picked one) validates everything
      // else so "Students detected: N" can show real Valid/Invalid status
      // without a section chosen yet (spec PART 5).
      requireSection: mode === 'import' || !!selectedSection,
      courseYearFields: courseYearFieldsForCreate
    });

    if (mode === 'preview') {
      return res.json({
        total: results.length,
        valid_count: results.filter((r) => !r.errors.length).length,
        invalid_count: results.filter((r) => r.errors.length).length,
        has_section_column: parsed.has_section_column,
        students: bulkImport.toStudentPreview(results)
      });
    }

    const insertResult = await bulkImport.insertStudents({
      Users, results, collegeId: scope.collegeId, department: scope.department,
      newId, hashPasswordAsync, extraFields: scope.extraFields
    });
    res.json(bulkImport.buildStudentImportReport(results, insertResult, selectedSection));
  }

  app.post('/api/account/profile', requireAuth, ah(async (req, res) => {
    const { name, gender, avatar } = req.body || {};
    const update = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
      update.name = String(name).trim().slice(0, 120);
    }
    if (gender !== undefined) {
      if (!['male', 'female'].includes(gender)) return res.status(400).json({ error: 'Gender must be male or female.' });
      update.gender = gender;
      // Only auto-assign a default avatar the first time gender is set (or
      // if avatar was never set) — never silently override a choice the
      // user already made.
      if (!req.user.avatar) {
        update.avatar = defaultAvatarFor(req.user.role, gender);
        update.avatar_type = 'generated';
      }
    }
    if (avatar !== undefined) {
      const roleKey = req.user.role === 'faculty' ? 'faculty' : 'student';
      const validAvatars = [...AVATAR_CATALOG[`${roleKey}_male`], ...AVATAR_CATALOG[`${roleKey}_female`]];
      if (!validAvatars.includes(avatar)) return res.status(400).json({ error: 'Unknown avatar.' });
      update.avatar = avatar;
      update.avatar_type = 'generated';
    }
    // Course/Year self-service (item 5) — a student can select or change
    // their own Course + Year from their profile, e.g. to resolve their own
    // Pending status (item 6) without waiting on AO. Only offered to
    // students, and only while their course isn't already marked Completed
    // by AO — a completed course record isn't something the student can
    // reopen on their own.
    if (req.user.role === 'student' && (req.body?.course !== undefined || req.body?.current_year !== undefined)) {
      if (req.user.academic_status === 'completed') return res.status(400).json({ error: 'Your course is marked Completed — contact AO Office to change it.' });
      const { course, current_year } = req.body;
      const effectiveCourse = course !== undefined ? course : req.user.course;
      if (course !== undefined) {
        if (course !== null && !COURSE_TYPES.includes(course)) return res.status(400).json({ error: 'Invalid course type.' });
        update.course = course;
        // Switching course resets the year unless a valid one is also sent
        // in this same request, so a stale year from a different course's
        // duration can never linger.
        if (current_year === undefined) update.current_year = null;
      }
      if (current_year !== undefined) {
        if (current_year === null) {
          update.current_year = null;
        } else {
          if (!effectiveCourse) return res.status(400).json({ error: 'Select a course before choosing a year.' });
          const duration = courseDurationYears(effectiveCourse);
          if (!(Number(current_year) >= 1) || (duration && Number(current_year) > duration)) {
            return res.status(400).json({ error: `Year must be between 1 and ${duration || '—'} for this course.` });
          }
          update.current_year = Number(current_year);
        }
      }
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    await Users.updateOne({ username: req.user.username }, { $set: update });
    const updated = await Users.findOne({ username: req.user.username });
    res.json({ user: publicUser(updated) });
  }));

  app.get('/api/account/avatar-catalog', requireAuth, ah(async (req, res) => {
    const roleKey = req.user.role === 'faculty' ? 'faculty' : 'student';
    res.json({ male: AVATAR_CATALOG[`${roleKey}_male`], female: AVATAR_CATALOG[`${roleKey}_female`] });
  }));

  // ---------------------------------------------------------------------
  // Web Push subscriptions — real OS-level notifications (see
  // "Web Push (real OS-level push notifications)" near the top of this
  // file, and sendPushToUsers()/notifyUsers() above).
  // ---------------------------------------------------------------------

  // Public (but only meaningful once logged in — the frontend only calls
  // this after auth): hands the browser the public VAPID key it needs to
  // call PushManager.subscribe(). Not a secret — VAPID public keys are
  // designed to be shipped to the browser, same as a TLS certificate.
  app.get('/api/push/vapid-public-key', requireAuth, ah(async (req, res) => {
    if (!vapidReady) return res.json({ enabled: false });
    res.json({ enabled: true, publicKey: VAPID_PUBLIC_KEY });
  }));

  // Registers (or re-registers) this browser/device's push subscription
  // against the signed-in user. Upserted by `endpoint`, which the browser
  // guarantees is unique per browser installation — so re-subscribing the
  // same device never creates a duplicate row, and if a subscription
  // somehow got left behind under a previous account on a shared device,
  // subscribing again correctly reassigns it to whoever is signed in now.
  app.post('/api/push/subscribe', requireAuth, ah(async (req, res) => {
    const { subscription } = req.body || {};
    const endpoint = subscription?.endpoint;
    const keys = subscription?.keys;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'A valid push subscription (endpoint + keys) is required.' });
    }
    const now = Date.now();
    await PushSubscriptions.updateOne(
      { endpoint },
      {
        $set: {
          user_username: req.user.username, keys: { p256dh: keys.p256dh, auth: keys.auth },
          user_agent: String(req.headers['user-agent'] || '').slice(0, 300), last_seen_at: now
        },
        $setOnInsert: { id: newId('push'), created_at: now }
      },
      { upsert: true }
    );
    res.json({ ok: true });
  }));

  // Unregisters one device's subscription — called on logout (so a
  // shared/borrowed device stops getting another person's notifications)
  // and when the browser itself reports the subscription is no longer
  // valid. Scoped to the requesting user so nobody can unsubscribe a
  // device that isn't theirs.
  app.post('/api/push/unsubscribe', requireAuth, ah(async (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'An endpoint is required.' });
    await PushSubscriptions.deleteOne({ endpoint, user_username: req.user.username });
    res.json({ ok: true });
  }));

  // =====================================================================
  // NOTIFICATIONS — bell panel + per-module red "unread" dots. Every
  // action that creates something another user cares about (a note, an
  // announcement, a reply, a grade, …) writes rows here via notifyUsers().
  // =====================================================================
  app.get('/api/notifications', requireAuth, ah(async (req, res) => {
    const rows = await Notifications.find({ user_username: req.user.username }).sort({ created_at: -1 }).limit(100).toArray();
    const unread_count = await Notifications.countDocuments({ user_username: req.user.username, read: false });
    res.json({ notifications: rows.map(stripId), unread_count });
  }));

  app.post('/api/notifications/:id/read', requireAuth, ah(async (req, res) => {
    await Notifications.updateOne({ id: req.params.id, user_username: req.user.username }, { $set: { read: true } });
    res.json({ ok: true });
  }));

  // Marks every notification for one sidebar module (tab) read at once —
  // called the moment a user opens that tab, so its red dot can fade out.
  app.post('/api/notifications/read-tab/:tab', requireAuth, ah(async (req, res) => {
    await Notifications.updateMany({ user_username: req.user.username, tab: req.params.tab, read: false }, { $set: { read: true } });
    res.json({ ok: true });
  }));

  app.post('/api/notifications/read-all', requireAuth, ah(async (req, res) => {
    await Notifications.updateMany({ user_username: req.user.username, read: false }, { $set: { read: true } });
    res.json({ ok: true });
  }));

  // Swipe-to-dismiss (one notification) — scoped to the requesting user's
  // own username so nobody can delete another person's notifications by
  // guessing an id. Deleting a row that doesn't exist (already dismissed
  // from another tab, etc.) is treated as a no-op success rather than an
  // error, so a double-swipe or a stale UI never surfaces a toast.
  app.delete('/api/notifications/:id', requireAuth, ah(async (req, res) => {
    await Notifications.deleteOne({ id: req.params.id, user_username: req.user.username });
    res.json({ ok: true });
  }));

  // Clear All — removes every notification belonging to the requesting
  // user only. Scoped the same way as every other notifications route
  // (user_username: req.user.username), so this can never touch another
  // user's rows.
  app.delete('/api/notifications', requireAuth, ah(async (req, res) => {
    await Notifications.deleteMany({ user_username: req.user.username });
    res.json({ ok: true });
  }));

  // =====================================================================
  // SUPER ADMIN — colleges, their College Admin, reports
  // =====================================================================
  app.get('/api/super/colleges', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const colleges = await Colleges.find({}).sort({ created_at: -1 }).toArray();
    const withCounts = await Promise.all(colleges.map(async c => {
      const [admins, hods, faculty, students, sections] = await Promise.all([
        Users.countDocuments({ college_id: c.id, role: 'college_admin' }),
        Users.countDocuments({ college_id: c.id, role: 'hod' }),
        Users.countDocuments({ college_id: c.id, role: 'faculty' }),
        Users.countDocuments({ college_id: c.id, role: 'student' }),
        Sections.countDocuments({ college_id: c.id })
      ]);
      const { _id, ...clean } = c;
      return { ...clean, has_logo: !!c.logo_file_id, counts: { admins, hods, faculty, students, sections } };
    }));
    res.json({ colleges: withCounts });
  }));

  app.post('/api/super/colleges', requireAuth, requireRole('super_admin'), uploadImage.single('logo'), ah(async (req, res) => {
    const { name, admin_name, admin_username, admin_password } = req.body || {};
    if (!name || !admin_name || !admin_username || !admin_password) {
      return res.status(400).json({ error: 'College name and the College Admin\'s name, username, and password are all required.' });
    }
    const existingUser = await Users.findOne({ username: admin_username });
    if (existingUser) return res.status(409).json({ error: 'That admin username is already taken.' });

    let logoId = null;
    if (req.file) {
      const uploadStream = logoBucket.openUploadStream(req.file.originalname, { contentType: req.file.mimetype });
      await new Promise((resolve, reject) => {
        uploadStream.end(req.file.buffer, err => (err ? reject(err) : resolve()));
        uploadStream.on('error', reject);
      });
      logoId = uploadStream.id;
    }

    const college = {
      id: newId('col'),
      name: String(name).trim(),
      logo_file_id: logoId,
      status: 'active',
      created_by: req.user.username,
      created_at: Date.now()
    };
    await Colleges.insertOne(college);

    const admin = {
      id: newId('u'),
      name: String(admin_name).trim(),
      username: String(admin_username).trim(),
      password_hash: hashPassword(admin_password),
      role: 'college_admin',
      college_id: college.id,
      created_at: Date.now()
    };
    await Users.insertOne(admin);

    const { _id, ...cleanCollege } = college;
    res.status(201).json({ college: { ...cleanCollege, has_logo: !!logoId, counts: { admins: 1, hods: 0, faculty: 0, students: 0, sections: 0 } }, admin: publicUser(admin) });
  }));

  app.patch('/api/super/colleges/:id/status', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const { status } = req.body || {};
    if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const college = await Colleges.findOne({ id: req.params.id });
    if (!college) return res.status(404).json({ error: 'Not found.' });
    await Colleges.updateOne({ id: req.params.id }, { $set: { status } });
    res.json({ ok: true });
  }));

  app.delete('/api/super/colleges/:id', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const college = await Colleges.findOne({ id: req.params.id });
    if (!college) return res.status(404).json({ error: 'Not found.' });
    const collegeId = req.params.id;

    if (college.logo_file_id) await logoBucket.delete(new ObjectId(college.logo_file_id)).catch(() => {});
    const notes = await Notes.find({ college_id: collegeId }).toArray();
    for (const n of notes) if (n.file_id) await noteBucket.delete(new ObjectId(n.file_id)).catch(() => {});
    const events = await Events.find({ college_id: collegeId }).toArray();
    for (const e of events) if (e.poster_id) await posterBucket.delete(new ObjectId(e.poster_id)).catch(() => {});
    const eventGalleryFiles = await db.collection('event_gallery.files').find({ 'metadata.event_id': { $in: events.map(e => e.id) } }, { projection: { _id: 1 } }).toArray();
    await Promise.all(eventGalleryFiles.map(f => eventGalleryBucket.delete(f._id).catch(() => {})));

    const usernames = (await Users.find({ college_id: collegeId }, { projection: { username: 1 } }).toArray()).map(u => u.username);
    await Promise.all([
      Users.deleteMany({ college_id: collegeId }),
      Sections.deleteMany({ college_id: collegeId }),
      Announcements.deleteMany({ college_id: collegeId }),
      Notes.deleteMany({ college_id: collegeId }),
      Events.deleteMany({ college_id: collegeId }),
      Posts.deleteMany({ college_id: collegeId }),
      PostReplies.deleteMany({ post_id: { $exists: true } }), // pruned below by post ids if needed
      Attendance.deleteMany({ college_id: collegeId }),
      Marks.deleteMany({ college_id: collegeId }),
      Sessions.deleteMany({ username: { $in: usernames } }),
      Colleges.deleteOne({ id: collegeId })
    ]);
    res.json({ ok: true });
  }));

  // College Admin account management for one college — lets the Super
  // Admin add extra College Admins, rename/re-username/reset-password an
  // existing one, or remove one, all scoped to req.params.id so a Super
  // Admin can never reach into a college_admin belonging to another
  // college by guessing an id.
  app.get('/api/super/colleges/:id/admins', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const college = await Colleges.findOne({ id: req.params.id });
    if (!college) return res.status(404).json({ error: 'Not found.' });
    const rows = await Users.find(
      { college_id: req.params.id, role: 'college_admin' },
      { projection: { password_hash: 0, _id: 0 } }
    ).sort({ created_at: 1 }).toArray();
    res.json({ admins: rows });
  }));

  app.post('/api/super/colleges/:id/admins', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const college = await Colleges.findOne({ id: req.params.id });
    if (!college) return res.status(404).json({ error: 'Not found.' });
    const { name, username, password } = req.body || {};
    if (!name || !username || !password) return res.status(400).json({ error: 'Name, username, and password are all required.' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const existing = await Users.findOne({ username: String(username).trim() });
    if (existing) return res.status(409).json({ error: 'That username is already taken.' });

    const admin = {
      id: newId('u'),
      name: String(name).trim(),
      username: String(username).trim(),
      password_hash: hashPassword(password),
      role: 'college_admin',
      college_id: req.params.id,
      created_at: Date.now()
    };
    await Users.insertOne(admin);
    res.status(201).json({ admin: publicUser(admin) });
  }));

  app.patch('/api/super/colleges/:id/admins/:adminId', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.adminId, college_id: req.params.id, role: 'college_admin' });
    if (!row) return res.status(404).json({ error: 'Not found.' });

    const { name, username, password } = req.body || {};
    const update = {};
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
      update.name = String(name).trim();
    }
    if (username !== undefined) {
      const nextUsername = String(username).trim();
      if (!nextUsername) return res.status(400).json({ error: 'Username cannot be empty.' });
      if (nextUsername !== row.username) {
        const existing = await Users.findOne({ username: nextUsername });
        if (existing) return res.status(409).json({ error: 'That username is already taken.' });
      }
      update.username = nextUsername;
    }
    if (password !== undefined && password !== '') {
      if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      update.password_hash = hashPassword(password);
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    await Users.updateOne({ id: req.params.adminId }, { $set: update });
    // Username or password change invalidates existing sessions for this
    // account, same as the self-service change-password flow does.
    if (update.username || update.password_hash) await Sessions.deleteMany({ username: row.username });
    const updated = await Users.findOne({ id: req.params.adminId });
    res.json({ admin: publicUser(updated) });
  }));

  app.delete('/api/super/colleges/:id/admins/:adminId', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.adminId, college_id: req.params.id, role: 'college_admin' });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const remaining = await Users.countDocuments({ college_id: req.params.id, role: 'college_admin' });
    if (remaining <= 1) return res.status(400).json({ error: 'A college must keep at least one College Admin. Add another before removing this one.' });
    await Users.deleteOne({ id: req.params.adminId });
    await Sessions.deleteMany({ username: row.username });
    res.json({ ok: true });
  }));

  // Bulk removal (item 14) — same "at least one College Admin must
  // remain" rule as the single-delete route above, so a bulk action (or
  // Remove All) can never leave a college with zero admins.
  app.post('/api/super/colleges/:id/admins/bulk-delete', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const { ids, remove_all } = req.body || {};
    const scope = { college_id: req.params.id, role: 'college_admin' };
    const totalAdmins = await Users.countDocuments(scope);
    const targetIds = remove_all ? null : (ids || []).filter(Boolean);
    const targetCount = remove_all ? totalAdmins : targetIds.length;
    if (totalAdmins - targetCount < 1) {
      return res.status(400).json({ error: 'A college must keep at least one College Admin — adjust your selection to leave at least one.' });
    }
    const result = await bulkDeleteUsers(scope, { ids: targetIds, removeAll: !!remove_all && false /* removeAll blocked by the >=1 rule above; always id-scoped */ });
    // The guard above already proved this is safe even when remove_all was
    // requested, but removeAll:true would delete literally everyone
    // (racing the "keep one" check), so when remove_all is set we instead
    // delete everyone except the single most-recently-created admin.
    if (remove_all) {
      const admins = await Users.find(scope, { projection: { id: 1, username: 1, _id: 0 } }).sort({ created_at: -1 }).toArray();
      const keep = admins[0];
      const toRemove = admins.slice(1);
      await Users.deleteMany({ id: { $in: toRemove.map(a => a.id) } });
      await Sessions.deleteMany({ username: { $in: toRemove.map(a => a.username) } });
      return res.json({ ok: true, removed: toRemove.length, usernames: toRemove.map(a => a.username), kept: keep ? keep.username : null });
    }
    res.json({ ok: true, ...result });
  }));


  app.get('/api/super/colleges/:id/logo', ah(async (req, res) => {
    const college = await Colleges.findOne({ id: req.params.id });
    if (!college || !college.logo_file_id) return res.status(404).end();

    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (typeof logoBucket.getFile === 'function') {
      const file = await logoBucket.getFile(college.logo_file_id);
      if (!file || !file.buffer) return res.status(404).end();
      res.setHeader('Content-Type', file.contentType || 'image/jpeg');
      res.setHeader('Content-Length', file.buffer.length);
      return res.end(file.buffer);
    }

    const stream = logoBucket.openDownloadStream(new ObjectId(college.logo_file_id));
    stream.on('file', (file) => {
      if (file && file.contentType) res.setHeader('Content-Type', file.contentType);
    });
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
    stream.pipe(res);
  }));

  app.get('/api/super/reports', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const [colleges, admins, hods, faculty, students, sections, events, notes, posts] = await Promise.all([
      Colleges.countDocuments({}),
      Users.countDocuments({ role: 'college_admin' }),
      Users.countDocuments({ role: 'hod' }),
      Users.countDocuments({ role: 'faculty' }),
      Users.countDocuments({ role: 'student' }),
      Sections.countDocuments({}),
      Events.countDocuments({}),
      Notes.countDocuments({}),
      Posts.countDocuments({})
    ]);
    res.json({ colleges, admins, hods, faculty, students, sections, events, notes, posts });
  }));

  // =====================================================================
  // COLLEGE ADMIN — HODs, and messaging other College Admins
  // =====================================================================
  app.get('/api/college/me', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const college = await Colleges.findOne({ id: req.user.college_id });
    res.json({ college: college ? { ...stripId(college), has_logo: !!college.logo_file_id } : null });
  }));

  app.get('/api/college/hods', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const rows = await Users.find({ college_id: req.user.college_id, role: 'hod' }, { projection: { password_hash: 0, _id: 0 } }).toArray();
    res.json({ hods: rows });
  }));

  app.post('/api/college/hods', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const { name, username, password, department } = req.body || {};
    if (!name || !username || !password || !department) return res.status(400).json({ error: 'Name, username, password, and department are all required.' });
    const existing = await Users.findOne({ username });
    if (existing) return res.status(409).json({ error: 'That username is already taken.' });
    const hod = {
      id: newId('u'), name: String(name).trim(), username: String(username).trim(),
      password_hash: hashPassword(password), role: 'hod',
      college_id: req.user.college_id, department: String(department).trim(),
      created_at: Date.now()
    };
    await Users.insertOne(hod);
    res.status(201).json({ hod: publicUser(hod) });
  }));

  app.delete('/api/college/hods/:id', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, role: 'hod' });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    await Users.deleteOne({ id: req.params.id });
    await Sessions.deleteMany({ username: row.username });
    res.json({ ok: true });
  }));

  // Bulk removal (item 14). College Admin's create/delete authority is
  // deliberately limited to HODs (see the read-only comment on the
  // Faculty/Students oversight routes just below) — bulk mirrors that same
  // boundary rather than adding new delete authority over faculty/students.
  app.post('/api/college/hods/bulk-delete', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const { ids, remove_all } = req.body || {};
    const result = await bulkDeleteUsers({ college_id: req.user.college_id, role: 'hod' }, { ids, removeAll: !!remove_all });
    res.json({ ok: true, ...result });
  }));

  // ---------- College Admin: AO (Administrative Officer / Fee
  // Management) accounts ----------
  // Mirrors the HOD account routes directly above exactly, minus
  // `department` — an AO is college-wide, not scoped to one department
  // (see GET /api/ao/students below), so there's nothing to ask for here.
  app.get('/api/college/aos', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const rows = await Users.find({ college_id: req.user.college_id, role: 'ao' }, { projection: { password_hash: 0, _id: 0 } }).toArray();
    res.json({ aos: rows });
  }));

  app.post('/api/college/aos', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const { name, username, password } = req.body || {};
    if (!name || !username || !password) return res.status(400).json({ error: 'Name, username, and password are all required.' });
    const existing = await Users.findOne({ username });
    if (existing) return res.status(409).json({ error: 'That username is already taken.' });
    const ao = {
      id: newId('u'), name: String(name).trim(), username: String(username).trim(),
      password_hash: hashPassword(password), role: 'ao',
      college_id: req.user.college_id, created_at: Date.now()
    };
    await Users.insertOne(ao);
    res.status(201).json({ ao: publicUser(ao) });
  }));

  app.delete('/api/college/aos/:id', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, role: 'ao' });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    await Users.deleteOne({ id: req.params.id });
    await Sessions.deleteMany({ username: row.username });
    res.json({ ok: true });
  }));

  app.post('/api/college/aos/bulk-delete', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const { ids, remove_all } = req.body || {};
    const result = await bulkDeleteUsers({ college_id: req.user.college_id, role: 'ao' }, { ids, removeAll: !!remove_all });
    res.json({ ok: true, ...result });
  }));

  // NEW: College Admin oversight, read-only, college-wide (every
  // department at once). Deliberately no create/delete routes here —
  // adding faculty and students stays HOD's job within their own
  // department, same as it's always been; this just lets College Admin
  // *see* the full picture for oversight, matching the same "you can see
  // everything in your college, but only ever act within your own layer"
  // pattern already used for Events/Notes/Announcements.
  app.get('/api/college/faculty', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const rows = await Users.find({ college_id: req.user.college_id, role: 'faculty' }, { projection: { password_hash: 0, _id: 0 } }).sort({ department: 1, name: 1 }).toArray();
    res.json({ faculty: rows });
  }));

  app.get('/api/college/students', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const rows = await Users.find({ college_id: req.user.college_id, role: 'student' }, { projection: { password_hash: 0, _id: 0 } }).sort({ department: 1, name: 1 }).toArray();
    res.json({ students: rows });
  }));

  // ---------- Inter-college messaging (College Admins only) ----------
  app.get('/api/network/state', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const others = await Users.find(
      { role: 'college_admin', username: { $ne: req.user.username } },
      { projection: { _id: 0, id: 1, name: 1, username: 1, college_id: 1 } }
    ).toArray();
    const admins = await Promise.all(others.map(async o => {
      const college = await Colleges.findOne({ id: o.college_id }, { projection: { name: 1 } });
      return { ...o, college_name: college ? college.name : 'Unknown college', connection: await connectionStatus(req.user.username, o.username) };
    }));
    const incomingRaw = await CollegeConnections.find({ to_username: req.user.username, status: 'pending' }).sort({ created_at: -1 }).toArray();
    const incoming = await Promise.all(incomingRaw.map(async r => {
      const fromUser = await Users.findOne({ username: r.from_username });
      const college = fromUser ? await Colleges.findOne({ id: fromUser.college_id }, { projection: { name: 1 } }) : null;
      return { id: r.id, created_at: r.created_at, from_name: fromUser ? fromUser.name : r.from_username, from_username: r.from_username, from_college: college ? college.name : null };
    }));
    res.json({ admins, incoming });
  }));

  app.post('/api/network/requests', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const { to_username } = req.body || {};
    if (!to_username || to_username === req.user.username) return res.status(400).json({ error: 'Choose a valid college admin to connect with.' });
    const target = await Users.findOne({ username: to_username, role: 'college_admin' });
    if (!target) return res.status(404).json({ error: 'That admin account was not found.' });
    const status = await connectionStatus(req.user.username, to_username);
    if (status.state === 'connected') return res.status(409).json({ error: 'You are already connected.' });
    if (status.state === 'pending_sent') return res.status(409).json({ error: 'A request is already pending.' });
    if (status.state === 'pending_received') return res.status(409).json({ error: 'This admin already sent you a request — accept it instead.' });
    const row = { id: newId('creq'), from_username: req.user.username, to_username, status: 'pending', created_at: Date.now(), responded_at: null };
    await CollegeConnections.insertOne(row);
    res.status(201).json({ request: stripId(row) });
    notifyUsers([to_username], {
      tab: 'network', type: 'connection_request',
      title: 'Connection request', message: req.user.name + ' wants to connect colleges.', related_id: row.id
    }).catch(err => console.error('notify failed', err));
  }));

  app.post('/api/network/requests/:id/accept', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const row = await CollegeConnections.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (row.to_username !== req.user.username) return res.status(403).json({ error: 'This request was not sent to you.' });
    await CollegeConnections.updateOne({ id: req.params.id }, { $set: { status: 'accepted', responded_at: Date.now() } });
    res.json({ ok: true });
    notifyUsers([row.from_username], {
      tab: 'network', type: 'connection_accepted',
      title: 'Connection accepted', message: req.user.name + ' accepted your connection request.', related_id: row.id
    }).catch(err => console.error('notify failed', err));
  }));

  app.post('/api/network/requests/:id/decline', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const row = await CollegeConnections.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (row.to_username !== req.user.username) return res.status(403).json({ error: 'This request was not sent to you.' });
    await CollegeConnections.updateOne({ id: req.params.id }, { $set: { status: 'declined', responded_at: Date.now() } });
    res.json({ ok: true });
  }));

  app.get('/api/network/messages/:withUsername', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const other = req.params.withUsername;
    const status = await connectionStatus(req.user.username, other);
    if (status.state !== 'connected') return res.status(403).json({ error: 'You can only message connected admins.' });
    const rows = await CollegeMessages.find({ connection_id: status.requestId }).sort({ created_at: 1 }).toArray();
    res.json({ messages: rows.map(stripId) });
  }));

  app.post('/api/network/messages/:withUsername', requireAuth, requireRole('college_admin'), messagingLimiter, ah(async (req, res) => {
    const other = req.params.withUsername;
    const status = await connectionStatus(req.user.username, other);
    if (status.state !== 'connected') return res.status(403).json({ error: 'You can only message connected admins.' });
    const { type, title, body } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: 'Write something before sending.' });
    const row = {
      id: newId('cmsg'), connection_id: status.requestId,
      type: ['message', 'announcement', 'event_invite'].includes(type) ? type : 'message',
      title: (title || '').trim() || null, body: String(body).trim(),
      sender_username: req.user.username, sender_name: req.user.name, created_at: Date.now()
    };
    await CollegeMessages.insertOne(row);
    res.status(201).json({ message: stripId(row) });
    notifyUsers([other], {
      tab: 'network', type: 'network_message',
      title: 'Message from ' + req.user.name, message: row.title || row.body.slice(0, 80), related_id: row.id
    }).catch(err => console.error('notify failed', err));
  }));

  // =====================================================================
  // Staff Messaging (items 3/4) — HOD<->HOD and HOD<->Faculty
  // conversations. No connection-request step (unlike inter-college
  // messaging above): who's allowed to message whom is derived directly
  // from existing role/department/college scoping, checked fresh on every
  // route below so a department transfer or role change takes effect
  // immediately rather than being frozen at some earlier "connected" state.
  // =====================================================================
  const PRESENCE_ONLINE_WINDOW_MS = 2 * 60 * 1000; // "Online" = seen within the last 2 minutes
  function presenceStatus(lastActiveAt) {
    if (!lastActiveAt) return 'offline';
    return (Date.now() - lastActiveAt) <= PRESENCE_ONLINE_WINDOW_MS ? 'online' : 'offline';
  }
  // The single source of truth for "is `me` allowed to message `other`" —
  // used both to build the Contact HOD/Contact Faculty lists and to
  // authorize creating a new conversation. Never exposes a contact the
  // requester isn't authorized to reach (item 3: "Do NOT expose HODs who
  // the logged-in HOD is not authorised to contact").
  function canMessage(me, other) {
    if (!other || other.username === me.username || other.college_id !== me.college_id) return false;
    if (me.role === 'hod') {
      if (other.role === 'hod') return true; // any HOD in the same college
      if (other.role === 'faculty') return other.department === me.department; // only their own department's faculty
      return false;
    }
    if (me.role === 'faculty') {
      return other.role === 'hod' && other.department === me.department; // only their own department's HOD
    }
    return false;
  }
  async function conversationOtherParty(conversation, myUsername) {
    return conversation.participant_usernames.find(u => u !== myUsername);
  }

  // GET /api/messaging/contacts — Contact HOD / Contact Faculty, in one
  // call: `type` narrows to just 'hod' or 'faculty', omitted returns
  // everything the requester is allowed to message. Each contact carries
  // department, college name, and Online/Offline presence, plus a live
  // unread count so a "Messages" badge can be built from this alone.
  app.get('/api/messaging/contacts', requireAuth, requireRole('hod', 'faculty'), ah(async (req, res) => {
    const { type, q } = req.query;
    const roleFilter = req.user.role === 'hod'
      ? (type === 'faculty' ? ['faculty'] : type === 'hod' ? ['hod'] : ['hod', 'faculty'])
      : ['hod']; // faculty can only ever contact their own department's HOD
    const candidates = await Users.find(
      { college_id: req.user.college_id, role: { $in: roleFilter }, username: { $ne: req.user.username } },
      { projection: { password_hash: 0, _id: 0 } }
    ).toArray();
    const college = await Colleges.findOne({ id: req.user.college_id }, { projection: { name: 1 } });
    const eligible = candidates.filter(c => canMessage(req.user, c));
    const usernames = eligible.map(c => c.username);
    const conversations = usernames.length
      ? await StaffConversations.find({ participant_usernames: { $all: [req.user.username], $in: usernames } }).toArray()
      : [];
    // A conversation "contains" both usernames — $all with req.user plus
    // $in against the candidate list isn't quite exact for a 2-person
    // array, so narrow precisely in JS below.
    const convByOther = {};
    for (const c of conversations) {
      const other = c.participant_usernames.find(u => u !== req.user.username && usernames.includes(u));
      if (other) convByOther[other] = c;
    }
    let contacts = eligible.map(c => {
      const conv = convByOther[c.username];
      return {
        username: c.username, name: c.name, role: c.role, department: c.department,
        college_name: college?.name || null,
        status: presenceStatus(c.last_active_at),
        conversation_id: conv ? conv.id : null,
        last_message_preview: conv ? conv.last_message_preview || null : null,
        last_message_at: conv ? conv.last_message_at || null : null,
      };
    });
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      // `|| ''` guards a contact with no department on file (shouldn't
      // happen given HOD/Faculty creation always requires one, but a
      // search box is exactly the kind of path that shouldn't 500 on a
      // stray legacy/edge-case record instead of just not matching it).
      contacts = contacts.filter(c => (c.name || '').toLowerCase().includes(needle) || (c.department || '').toLowerCase().includes(needle));
    }
    contacts.sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0) || a.name.localeCompare(b.name));
    res.json({ contacts });
  }));

  // GET /api/messaging/conversations — every conversation the requester is
  // a participant in (both hod_hod and hod_faculty), each with the other
  // party's info and an unread count computed from read_state.
  app.get('/api/messaging/conversations', requireAuth, requireRole('hod', 'faculty'), ah(async (req, res) => {
    const rows = await StaffConversations.find({ participant_usernames: req.user.username }).sort({ last_message_at: -1 }).toArray();
    if (rows.length === 0) return res.json({ conversations: [] });
    const otherUsernames = rows.map(r => r.participant_usernames.find(u => u !== req.user.username)).filter(Boolean);
    const others = await Users.find({ username: { $in: otherUsernames } }, { projection: { username: 1, name: 1, role: 1, department: 1, last_active_at: 1, _id: 0 } }).toArray();
    const otherByUsername = Object.fromEntries(others.map(u => [u.username, u]));
    const unreadCounts = await Promise.all(rows.map(r => {
      const myReadAt = r.read_state?.[req.user.username] || 0;
      return StaffMessages.countDocuments({ conversation_id: r.id, sender_username: { $ne: req.user.username }, created_at: { $gt: myReadAt } });
    }));
    const conversations = rows.map((r, i) => {
      const otherUsername = r.participant_usernames.find(u => u !== req.user.username);
      const other = otherByUsername[otherUsername] || {};
      return {
        id: r.id, other_username: otherUsername, other_name: other.name || otherUsername,
        other_role: other.role || null, other_department: other.department || null,
        other_status: presenceStatus(other.last_active_at),
        last_message_preview: r.last_message_preview || null, last_message_at: r.last_message_at || null,
        unread_count: unreadCounts[i],
      };
    });
    res.json({ conversations });
  }));

  // POST /api/messaging/conversations — { with_username } → get-or-create.
  // Authorization is re-checked here every time (see canMessage) rather
  // than trusting a conversation's mere existence, so a since-changed
  // department/role can't leave a stale conversation reachable.
  app.post('/api/messaging/conversations', requireAuth, requireRole('hod', 'faculty'), ah(async (req, res) => {
    const { with_username } = req.body || {};
    if (!with_username) return res.status(400).json({ error: 'with_username is required.' });
    const other = await Users.findOne({ username: with_username });
    if (!canMessage(req.user, other)) return res.status(403).json({ error: 'You are not authorised to message this person.' });
    const pair = [req.user.username, with_username].sort();
    const existing = await StaffConversations.findOne({ participant_usernames: { $all: pair, $size: 2 } });
    if (existing) return res.json({ conversation: stripId(existing) });
    const row = {
      id: newId('conv'), college_id: req.user.college_id,
      kind: req.user.role === 'hod' && other.role === 'hod' ? 'hod_hod' : 'hod_faculty',
      participant_usernames: pair, created_at: Date.now(), last_message_at: null, last_message_preview: null,
      read_state: {}
    };
    await StaffConversations.insertOne(row);
    res.status(201).json({ conversation: stripId(row) });
  }));

  // GET /api/messaging/conversations/:id/messages — full history, oldest
  // first. 404 (not 403) for a non-participant, same as every other
  // ownership check in this file — existence isn't leaked either.
  app.get('/api/messaging/conversations/:id/messages', requireAuth, requireRole('hod', 'faculty'), ah(async (req, res) => {
    const conversation = await StaffConversations.findOne({ id: req.params.id, participant_usernames: req.user.username });
    if (!conversation) return res.status(404).json({ error: 'Not found.' });
    const rows = await StaffMessages.find({ conversation_id: req.params.id }).sort({ created_at: 1 }).toArray();
    res.json({ conversation: stripId(conversation), messages: rows.map(stripId) });
  }));

  // POST /api/messaging/conversations/:id/messages — send. Broadcasts a
  // refetch signal to the recipient's existing `user:<username>` realtime
  // room (see "Real-time layer" above) so an open chat screen updates
  // near-instantly, and sends an in-app notification for when it isn't
  // open — the same two mechanisms every other feature in this app
  // already uses, nothing new introduced.
  app.post('/api/messaging/conversations/:id/messages', requireAuth, requireRole('hod', 'faculty'), messagingLimiter, ah(async (req, res) => {
    const conversation = await StaffConversations.findOne({ id: req.params.id, participant_usernames: req.user.username });
    if (!conversation) return res.status(404).json({ error: 'Not found.' });
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Write something before sending.' });
    if (body.length > 4000) return res.status(400).json({ error: 'Message is too long.' });
    const row = {
      id: newId('smsg'), conversation_id: req.params.id,
      sender_username: req.user.username, sender_name: req.user.name,
      body, created_at: Date.now()
    };
    await StaffMessages.insertOne(row);
    const other = await conversationOtherParty(conversation, req.user.username);
    await StaffConversations.updateOne(
      { id: req.params.id },
      { $set: { last_message_at: row.created_at, last_message_preview: body.slice(0, 120), [`read_state.${req.user.username}`]: row.created_at } }
    );
    res.status(201).json({ message: stripId(row) });
    broadcastToRoom(`user:${other}`, { type: 'staff_message', conversation_id: req.params.id });
    notifyUsers([other], {
      tab: 'messages', type: 'staff_message',
      title: 'Message from ' + req.user.name, message: body.slice(0, 80), related_id: req.params.id
    }).catch(err => console.error('notify failed', err));
  }));

  // POST /api/messaging/conversations/:id/read — marks everything up to
  // now as read for the caller, by advancing their side of read_state.
  // Cheap (one field on the conversation doc) and correct regardless of
  // how many messages have piled up since their last read.
  app.post('/api/messaging/conversations/:id/read', requireAuth, requireRole('hod', 'faculty'), ah(async (req, res) => {
    const conversation = await StaffConversations.findOne({ id: req.params.id, participant_usernames: req.user.username });
    if (!conversation) return res.status(404).json({ error: 'Not found.' });
    await StaffConversations.updateOne({ id: req.params.id }, { $set: { [`read_state.${req.user.username}`]: Date.now() } });
    res.json({ ok: true });
  }));


  // =====================================================================
  app.get('/api/hod/sections', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const rows = await Sections.find({ college_id: req.user.college_id, department: req.user.department }).sort({ created_at: 1 }).toArray();
    res.json({ sections: rows.map(stripId) });
  }));

  app.post('/api/hod/sections', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { name, year } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Section name is required.' });
    const row = {
      id: newId('sec'), college_id: req.user.college_id, department: req.user.department,
      name: String(name).trim(), year: (year || '').trim() || null, faculty_username: null, created_by: req.user.username, created_at: Date.now()
    };
    await Sections.insertOne(row);
    res.status(201).json({ section: stripId(row) });
  }));

  // UPDATED: lets a College Admin see every section across every department
  // in their college, so they can target announcements/notes/events by
  // department/year/section instead of only ever posting college-wide.
  app.get('/api/college/sections', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const rows = await Sections.find({ college_id: req.user.college_id }).sort({ department: 1, name: 1 }).toArray();
    res.json({ sections: rows.map(stripId) });
  }));

  // NEW: College Admin's college-wide equivalent of the HOD attendance
  // report/export/alert routes. `department` is optional here (HOD's
  // version is always scoped to their one department) — omit it to see
  // every department at once. Semester filtering only makes sense within
  // a single department (semesters are HOD-defined per department), so
  // `semester_id` is only meaningful when `department` is also given.
  app.get('/api/college/attendance/report', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const report = await computeAttendanceReport({ college_id: req.user.college_id, department: req.query.department || null, semester_id: req.query.semester_id || null });
    res.json({ report });
  }));

  app.get('/api/college/attendance/report.csv', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const report = await computeAttendanceReport({ college_id: req.user.college_id, department: req.query.department || null, semester_id: req.query.semester_id || null });
    const escCsv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['Name,Username,Roll Number,Department,Section,Present,Total,Percentage'];
    for (const r of report) lines.push([escCsv(r.name), escCsv(r.username), escCsv(r.roll_number), escCsv(r.department), escCsv(r.section_id), r.present_count, r.total_count, r.percentage == null ? '' : r.percentage].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-report.csv"');
    res.send(lines.join('\r\n'));
  }));

  app.post('/api/college/attendance/alert-low', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const threshold = Number(req.body?.threshold);
    if (!threshold || threshold <= 0 || threshold > 100) return res.status(400).json({ error: 'Provide a valid threshold percentage (1-100).' });
    const report = await computeAttendanceReport({ college_id: req.user.college_id, department: req.body?.department || null, semester_id: req.body?.semester_id || null });
    const flagged = report.filter(r => r.percentage !== null && r.percentage < threshold);
    await notifyUsers(flagged.map(r => r.username), {
      college_id: req.user.college_id, tab: 'myattendance', type: 'warning',
      title: 'Low attendance warning', message: `Your attendance is below the required ${threshold}%. Please review your attendance record.`
    });
    res.json({ ok: true, flagged_count: flagged.length, flagged });
  }));

  app.patch('/api/hod/sections/:id/assign-faculty', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const section = await Sections.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department });
    if (!section) return res.status(404).json({ error: 'Not found.' });
    const { faculty_username } = req.body || {};
    const faculty = faculty_username ? await Users.findOne({ username: faculty_username, role: 'faculty', college_id: req.user.college_id, department: req.user.department }) : null;
    if (faculty_username && !faculty) return res.status(404).json({ error: 'That faculty member was not found in your department.' });

    if (section.faculty_username) {
      await Users.updateOne({ username: section.faculty_username }, { $pull: { section_ids: section.id } });
    }
    await Sections.updateOne({ id: req.params.id }, { $set: { faculty_username: faculty_username || null } });
    if (faculty) {
      await Users.updateOne({ username: faculty.username }, { $addToSet: { section_ids: section.id } });
    }
    res.json({ ok: true });
  }));

  app.delete('/api/hod/sections/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const section = await Sections.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department });
    if (!section) return res.status(404).json({ error: 'Not found.' });
    const studentCount = await Users.countDocuments({ section_id: req.params.id });
    if (studentCount > 0) return res.status(400).json({ error: 'Move or remove students from this section first.' });
    if (section.faculty_username) await Users.updateOne({ username: section.faculty_username }, { $pull: { section_ids: section.id } });
    await Sections.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // NEW: HOD manages the department's academic semesters (start/end dates),
  // subjects, and the weekly timetable that drives which faculty may take
  // attendance for which section/hour/subject.
  app.get('/api/hod/semesters', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const rows = await Semesters.find({ college_id: req.user.college_id, department: req.user.department }).sort({ start_date: -1 }).toArray();
    res.json({ semesters: rows.map(stripId) });
  }));

  app.post('/api/hod/semesters', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { name, start_date, end_date } = req.body || {};
    if (!name || !start_date || !end_date) return res.status(400).json({ error: 'Name, start date, and end date are required.' });
    if (start_date > end_date) return res.status(400).json({ error: 'Start date must be before end date.' });
    const row = {
      id: newId('sem'), college_id: req.user.college_id, department: req.user.department,
      name: String(name).trim(), start_date, end_date, created_by: req.user.username, created_at: Date.now()
    };
    await Semesters.insertOne(row);
    res.status(201).json({ semester: stripId(row) });
  }));

  app.delete('/api/hod/semesters/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await Semesters.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    await Semesters.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // =====================================================================
  // ACADEMIC CALENDAR (NEW) — owned by HOD (their own department), and
  // read-only for College Admin (any department in their college). One row
  // per (college, department, year-or-null, date); `year: null` applies to
  // the whole department. `semester_id`/`academic_year` are informational,
  // derived from the existing Semesters date ranges, not chosen by HOD.
  // =====================================================================

  // GET /api/hod/academic-calendar?year=&from=&to=
  // Returns every entry for the HOD's department, optionally narrowed to
  // one year (still includes department-wide entries alongside it, tagged
  // via `year: null`, since both apply) and/or a date range.
  app.get('/api/hod/academic-calendar', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { year, from, to } = req.query || {};
    const filter = { college_id: req.user.college_id, department: req.user.department };
    if (year) filter.$or = [{ year }, { year: null }];
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }
    const rows = await AcademicCalendar.find(filter).sort({ date: 1 }).toArray();
    res.json({ calendar: rows.map(stripId) });
  }));

  // POST /api/hod/academic-calendar — add OR edit the entry for one date
  // (upsert on college+department+year+date). This is how an HOD adds a
  // holiday, changes a working day to a holiday mid-semester, or marks a
  // special working day — all the same "set this date's status" action,
  // whether the date is in the past, present, or future (item 2/12/13).
  app.post('/api/hod/academic-calendar', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { date, status, reason, year } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });
    if (!CALENDAR_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${CALENDAR_STATUSES.join(', ')}.` });
    const yearVal = year ? String(year).trim() : null;

    // NEW: do not silently touch historical attendance. Changing a date's
    // status never deletes or edits any Attendance row already recorded
    // for it — it only changes whether *future* attendance submissions for
    // that date are allowed (enforced in assertAttendanceDateAllowed).
    const existing = await AcademicCalendar.findOne({ college_id: req.user.college_id, department: req.user.department, year: yearVal, date });
    const semester = await findSemesterForDate(req.user.college_id, req.user.department, date);
    const now = Date.now();
    if (existing) {
      const update = {
        status, reason: reason ? String(reason).trim() : null, semester_id: semester ? semester.id : null,
        updated_by: req.user.username, updated_at: now,
      };
      await AcademicCalendar.updateOne({ id: existing.id }, { $set: update });
      return res.json({ calendar: stripId({ ...existing, ...update }) });
    }
    const row = {
      id: newId('cal'), college_id: req.user.college_id, department: req.user.department,
      year: yearVal, semester_id: semester ? semester.id : null, date, status,
      reason: reason ? String(reason).trim() : null,
      created_by: req.user.username, updated_by: req.user.username, created_at: now, updated_at: now,
    };
    await AcademicCalendar.insertOne(row);
    res.status(201).json({ calendar: stripId(row) });
  }));

  // PUT /api/hod/academic-calendar/:id — edit an existing entry directly
  // (e.g. correcting the reason, or flipping its status) without needing
  // to know the date/year again.
  app.put('/api/hod/academic-calendar/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await AcademicCalendar.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const { status, reason } = req.body || {};
    if (status && !CALENDAR_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${CALENDAR_STATUSES.join(', ')}.` });
    const update = { updated_by: req.user.username, updated_at: Date.now() };
    if (status) update.status = status;
    if (reason !== undefined) update.reason = reason ? String(reason).trim() : null;
    await AcademicCalendar.updateOne({ id: row.id }, { $set: update });
    res.json({ calendar: stripId({ ...row, ...update }) });
  }));

  // DELETE /api/hod/academic-calendar/:id — remove an incorrectly added
  // holiday/working-day entry. The date simply reverts to whatever the
  // timetable would otherwise allow (i.e. a normal working day).
  app.delete('/api/hod/academic-calendar/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await AcademicCalendar.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    await AcademicCalendar.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // GET /api/college/academic-calendar?department=&year=&from=&to=
  // Read-only for College Admin — HOD remains the sole owner/editor
  // (item 3: "do not accidentally give Admin edit access"). `department`
  // is required since College Admin isn't scoped to one department.
  app.get('/api/college/academic-calendar', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const { department, year, from, to } = req.query || {};
    if (!department) return res.status(400).json({ error: 'A department is required.' });
    const filter = { college_id: req.user.college_id, department };
    if (year) filter.$or = [{ year }, { year: null }];
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }
    const rows = await AcademicCalendar.find(filter).sort({ date: 1 }).toArray();
    res.json({ calendar: rows.map(stripId) });
  }));

  // GET /api/student/academic-calendar?from=&to=  (spec Part 21)
  // Read-only, and scoped automatically — never accepts a department/year
  // from the client. A student always sees exactly their own college +
  // branch's calendar (their `department`), narrowed to their own
  // `current_year` alongside any department-wide entries (year: null),
  // e.g. a B.Tech CSE 3rd-year student never sees an MBA calendar or a
  // different year's entries, and this is enforced here server-side, not
  // just by what the frontend happens to request.
  app.get('/api/student/academic-calendar', requireAuth, requireRole('student'), ah(async (req, res) => {
    const { from, to } = req.query || {};
    if (!req.user.department) return res.json({ calendar: [] });
    const filter = { college_id: req.user.college_id, department: req.user.department };
    const yearVal = req.user.current_year != null ? String(req.user.current_year) : null;
    filter.$or = yearVal ? [{ year: yearVal }, { year: null }] : [{ year: null }];
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }
    const rows = await AcademicCalendar.find(filter).sort({ date: 1 }).toArray();
    res.json({ calendar: rows.map(stripId) });
  }));

  // GET /api/faculty/academic-calendar?from=&to=  (spec Part 21)
  // Same shape as the student route above, scoped to the faculty
  // member's own college + department. Faculty see every year's entries
  // for their department (they aren't tied to one year the way a student
  // is), plus department-wide entries — never another department's
  // calendar.
  app.get('/api/faculty/academic-calendar', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { from, to } = req.query || {};
    if (!req.user.department) return res.json({ calendar: [] });
    const filter = { college_id: req.user.college_id, department: req.user.department };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }
    const rows = await AcademicCalendar.find(filter).sort({ date: 1 }).toArray();
    res.json({ calendar: rows.map(stripId) });
  }));

  // Subjects: managed by HOD (their own department) or College Admin (any
  // department in their college — College Admin isn't tied to a single
  // department the way HOD is, so they must say which department a
  // subject belongs to). Faculty and students never reach these routes at
  // all — requireRole rejects them before the handler runs, so hiding the
  // "Add Subject" button on the frontend is a UX nicety here, not the
  // actual security boundary.
  app.get('/api/hod/subjects', requireAuth, requireRole('hod', 'college_admin'), ah(async (req, res) => {
    const filter = { college_id: req.user.college_id };
    if (req.user.role === 'hod') {
      filter.department = req.user.department;
    } else if (req.query.department) {
      // College Admin may optionally scope the list to one department
      // (e.g. while managing that department's timetable); omitted
      // returns every subject across the whole college.
      filter.department = String(req.query.department);
    }
    const rows = await Subjects.find(filter).sort({ department: 1, name: 1 }).toArray();
    res.json({ subjects: rows.map(stripId) });
  }));

  app.post('/api/hod/subjects', requireAuth, requireRole('hod', 'college_admin'), ah(async (req, res) => {
    const { name, code } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Subject name is required.' });
    let department;
    if (req.user.role === 'hod') {
      department = req.user.department;
    } else {
      department = String(req.body?.department || '').trim();
      if (!department) return res.status(400).json({ error: 'Department is required.' });
      // Guards against a typo'd/nonexistent department name: a College
      // Admin can only add a subject to a department that actually has an
      // HOD in this college, so the subject can never end up somewhere no
      // timetable will ever be scoped to.
      const deptExists = await Users.findOne({ college_id: req.user.college_id, role: 'hod', department });
      if (!deptExists) return res.status(400).json({ error: 'No department with that name exists in your college yet.' });
    }
    const trimmedName = String(name).trim();
    // Prevent unnecessary duplicate subjects — case-insensitive, scoped to
    // the same college + department (the same subject name is fine in two
    // different departments, e.g. "Mathematics" under CSE and under ECE).
    const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dup = await Subjects.findOne({ college_id: req.user.college_id, department, name: { $regex: `^${escaped}$`, $options: 'i' } });
    if (dup) return res.status(409).json({ error: `"${dup.name}" already exists for ${department}.` });
    const row = {
      id: newId('sub'), college_id: req.user.college_id, department,
      name: trimmedName, code: (code || '').trim(), created_by: req.user.username, created_by_role: req.user.role, created_at: Date.now()
    };
    await Subjects.insertOne(row);
    res.status(201).json({ subject: stripId(row) });
  }));

  // ---------------------------------------------------------------------
  // HOD Course Type / Branch (spec items 2-4). Deliberately a separate
  // concept from the student-facing COURSE_TYPES above (which only covers
  // btech/mtech/degree/diploma, since those are the only courses with a
  // fixed year-duration a student progresses through) — an HOD's
  // Course/Department Type also includes MBA and MCA, and each course type
  // has its own catalog of applicable branches/specializations so the
  // frontend only ever offers relevant options (Course Type -> Branch).
  //
  // `department` (the field every other HOD-scoped query in this file
  // already filters on — Sections, Faculty, Students, Subjects, Timetable,
  // messaging's canMessage, etc.) continues to hold the HOD's Branch value
  // unchanged, so none of that existing scoping logic needs to change.
  // `hod_course_type` is new, additive metadata stored alongside it purely
  // for display (Admin sees Course and Branch separately) and for driving
  // the dynamic branch dropdown here and on the HOD's own profile screen.
  // ---------------------------------------------------------------------
  const HOD_COURSE_TYPES = ['btech', 'mtech', 'degree', 'mba', 'mca', 'diploma'];
  const HOD_COURSE_LABELS = { btech: 'B.Tech', mtech: 'M.Tech', degree: 'Degree', mba: 'MBA', mca: 'MCA', diploma: 'Diploma' };
  const HOD_BRANCH_CATALOG = {
    btech: ['CSE', 'ECE', 'EEE', 'Mechanical', 'Civil', 'IT', 'CSE (AI & ML)', 'CSE (Data Science)', 'CSE (Cyber Security)', 'CSE (IoT)', 'Chemical', 'Aeronautical'],
    mtech: ['CSE', 'ECE', 'EEE', 'Mechanical', 'Civil', 'VLSI Design', 'Power Systems', 'Structural Engineering', 'Thermal Engineering', 'Computer Science & Engineering'],
    degree: ['B.Sc Computer Science', 'B.Sc Mathematics', 'B.Sc Physics', 'B.Sc Chemistry', 'B.Com', 'B.A'],
    mba: ['Marketing', 'Finance', 'Human Resources', 'Operations', 'Business Analytics', 'International Business'],
    mca: ['Computer Applications'],
    diploma: ['Mechanical', 'Civil', 'Electrical', 'Electronics & Communication', 'Computer Engineering', 'Automobile'],
  };

  // GET the catalog itself, so the frontend never hardcodes a second copy
  // of these lists that could drift out of sync with what the backend
  // actually accepts on save.
  app.get('/api/hod/branch-catalog', requireAuth, requireRole('hod', 'college_admin', 'super_admin'), ah(async (req, res) => {
    res.json({
      course_types: HOD_COURSE_TYPES.map(value => ({ value, label: HOD_COURSE_LABELS[value] })),
      branches_by_course_type: HOD_BRANCH_CATALOG,
    });
  }));

  // GET/PUT the signed-in HOD's own Course Type + Branch (item 2: "after
  // account creation, open profile and update department/course info").
  app.get('/api/hod/profile', requireAuth, requireRole('hod'), ah(async (req, res) => {
    res.json({
      course_type: req.user.hod_course_type || null,
      course_label: req.user.hod_course_type ? HOD_COURSE_LABELS[req.user.hod_course_type] : null,
      branch: req.user.department || null,
    });
  }));

  app.put('/api/hod/profile', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { course_type, branch } = req.body || {};
    if (!course_type || !HOD_COURSE_TYPES.includes(course_type)) {
      return res.status(400).json({ error: 'Choose a valid Course/Department Type.' });
    }
    const validBranches = HOD_BRANCH_CATALOG[course_type] || [];
    if (!branch || !validBranches.includes(branch)) {
      return res.status(400).json({ error: `Choose a valid branch for ${HOD_COURSE_LABELS[course_type]}.` });
    }
    // `department` drives every other query already scoped to this HOD
    // (Sections/Faculty/Students/Subjects/Timetable/messaging) — updating
    // it here means all of that continues to work against the new branch
    // with no separate migration step, exactly like an HOD's department
    // could already be changed today via other admin tooling.
    await Users.updateOne({ username: req.user.username }, { $set: { hod_course_type: course_type, department: branch } });
    res.json({ course_type, course_label: HOD_COURSE_LABELS[course_type], branch });
  }));

  app.delete('/api/hod/subjects/:id', requireAuth, requireRole('hod', 'college_admin'), ah(async (req, res) => {
    const filter = { id: req.params.id, college_id: req.user.college_id };
    if (req.user.role === 'hod') filter.department = req.user.department; // HOD may only delete their own department's subjects; College Admin may delete any in their college
    const row = await Subjects.findOne(filter);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    await Subjects.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // The weekly timetable for one section: GET returns every cell that's been
  // filled in; POST upserts a single cell (section_id + day_of_week + hour).
  // Assigning a faculty member to a slot also adds that section to their
  // section_ids, so they show up correctly in Notes/Announcements/roster
  // views elsewhere in the app, not just for attendance.
  app.get('/api/hod/timetable/:sectionId', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const section = await Sections.findOne({ id: req.params.sectionId, college_id: req.user.college_id, department: req.user.department });
    if (!section) return res.status(404).json({ error: 'Section not found in your department.' });
    const rows = await Timetable.find({ section_id: req.params.sectionId }).toArray();
    res.json({ timetable: rows.map(r => ({ ...stripId(r), status: r.status || 'draft' })) });
  }));

  app.post('/api/hod/timetable', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { section_id, day_of_week, hour, subject_id } = req.body || {};
    // item 5: the assigned person can be Faculty or HOD. New param names
    // (assignee_username/assignee_role) are preferred; the original
    // faculty_username is still accepted on its own for full backward
    // compatibility with any existing caller that only ever sent that.
    const assigneeUsername = req.body?.assignee_username || req.body?.faculty_username;
    const assigneeRole = req.body?.assignee_role === 'hod' ? 'hod' : 'faculty';
    if (!section_id || !day_of_week || !hour || !subject_id || !assigneeUsername) {
      return res.status(400).json({ error: 'Section, day, hour, subject, and an assigned Faculty/HOD are all required.' });
    }
    if (!DAY_NAMES.includes(day_of_week)) return res.status(400).json({ error: 'Invalid day of week.' });
    const section = await Sections.findOne({ id: section_id, college_id: req.user.college_id, department: req.user.department });
    if (!section) return res.status(404).json({ error: 'Section not found in your department.' });
    const subject = await Subjects.findOne({ id: subject_id, college_id: req.user.college_id, department: req.user.department });
    if (!subject) return res.status(404).json({ error: 'Subject not found in your department.' });
    const assignee = assigneeRole === 'hod'
      ? await Users.findOne({ username: assigneeUsername, role: 'hod', college_id: req.user.college_id })
      : await Users.findOne({ username: assigneeUsername, role: 'faculty', college_id: req.user.college_id, department: req.user.department });
    if (!assignee) return res.status(404).json({ error: assigneeRole === 'hod' ? 'HOD not found in your college.' : 'Faculty member not found in your department.' });

    const existing = await Timetable.findOne({ section_id, day_of_week, hour: String(hour) });
    const row = {
      id: existing ? existing.id : newId('tt'),
      college_id: req.user.college_id, department: req.user.department,
      section_id, day_of_week, hour: String(hour), subject_id,
      // faculty_username is kept as the storage field name for whoever is
      // assigned (Faculty OR HOD) so every existing reader of this field
      // (attendance validation, Faculty's own timetable fetch, roster
      // views) keeps working unmodified — assignee_role is what
      // distinguishes the two now.
      faculty_username: assigneeUsername, assignee_role: assigneeRole,
      // `status` is legacy internal bookkeeping only — nothing reads it
      // any more (there is no student/HOD-facing Time Table view left to
      // gate). Kept only so we don't lose data on rows written before
      // this field existed.
      status: existing ? (existing.status || 'draft') : 'draft',
      published_at: existing ? (existing.published_at || null) : null, published_by: existing ? (existing.published_by || null) : null,
      created_by: req.user.username, created_at: existing ? existing.created_at : Date.now(), updated_at: Date.now()
    };
    await Timetable.updateOne({ section_id, day_of_week, hour: String(hour) }, { $set: row }, { upsert: true });
    // Only a faculty assignment adds the section to section_ids (that field
    // drives Faculty-role features like Notes/roster elsewhere) — an HOD
    // assignee doesn't use section_ids the same way, so this is left
    // exactly as it worked before for the faculty case.
    if (assigneeRole === 'faculty') await Users.updateOne({ username: assigneeUsername }, { $addToSet: { section_ids: section_id } });
    res.status(201).json({ slot: stripId(row) });
  }));

  // NEW (item 11): the pool of HODs a timetable slot can be assigned to —
  // any HOD in the same college, regardless of department, per spec ("HOD B
  // does not necessarily need to belong to CSE... Do not allow HODs from
  // unrelated colleges"). Used only to populate the assignee dropdown in
  // the Timetable tab; the actual assignment is still validated
  // server-side in POST /api/hod/timetable above regardless of what this
  // returns.
  app.get('/api/hod/peer-hods', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const rows = await Users.find(
      { role: 'hod', college_id: req.user.college_id },
      { projection: { name: 1, username: 1, department: 1, _id: 0 } }
    ).sort({ name: 1 }).toArray();
    res.json({ hods: rows });
  }));

  app.delete('/api/hod/timetable/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await Timetable.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    await Timetable.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // Department-wide attendance report + CSV export + low-attendance alert.
  app.get('/api/hod/attendance/report', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const report = await computeAttendanceReport({ college_id: req.user.college_id, department: req.user.department, semester_id: req.query.semester_id || null });
    res.json({ report });
  }));

  app.get('/api/hod/attendance/report.csv', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const report = await computeAttendanceReport({ college_id: req.user.college_id, department: req.user.department, semester_id: req.query.semester_id || null });
    const escCsv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['Name,Username,Roll Number,Section,Present,Total,Percentage'];
    for (const r of report) lines.push([escCsv(r.name), escCsv(r.username), escCsv(r.roll_number), escCsv(r.section_id), r.present_count, r.total_count, r.percentage == null ? '' : r.percentage].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-report.csv"');
    res.send(lines.join('\r\n'));
  }));

  app.post('/api/hod/attendance/alert-low', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const threshold = Number(req.body?.threshold);
    if (!threshold || threshold <= 0 || threshold > 100) return res.status(400).json({ error: 'Provide a valid threshold percentage (1-100).' });
    const report = await computeAttendanceReport({ college_id: req.user.college_id, department: req.user.department, semester_id: req.body?.semester_id || null });
    const flagged = report.filter(r => r.percentage !== null && r.percentage < threshold);
    await notifyUsers(flagged.map(r => r.username), {
      college_id: req.user.college_id, tab: 'myattendance', type: 'warning',
      title: 'Low attendance warning', message: `Your attendance is below the required ${threshold}%. Please review your attendance record.`
    });
    res.json({ ok: true, flagged_count: flagged.length, flagged });
  }));

  app.get('/api/hod/faculty', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const rows = await Users.find({ college_id: req.user.college_id, department: req.user.department, role: 'faculty' }, { projection: { password_hash: 0, _id: 0 } }).toArray();
    res.json({ faculty: rows });
  }));

  app.post('/api/hod/faculty', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { name, username, password } = req.body || {};
    if (!name || !username || !password) return res.status(400).json({ error: 'Name, username, and password are required.' });
    const existing = await Users.findOne({ username });
    if (existing) return res.status(409).json({ error: 'That username is already taken.' });
    const row = {
      id: newId('u'), name: String(name).trim(), username: String(username).trim(),
      password_hash: hashPassword(password), role: 'faculty',
      college_id: req.user.college_id, department: req.user.department, section_ids: [],
      created_at: Date.now()
    };
    await Users.insertOne(row);
    res.status(201).json({ faculty: publicUser(row) });
  }));

  app.delete('/api/hod/faculty/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department, role: 'faculty' });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    await Sections.updateMany({ faculty_username: row.username }, { $set: { faculty_username: null } });
    await Users.deleteOne({ id: req.params.id });
    await Sessions.deleteMany({ username: row.username });
    res.json({ ok: true });
  }));

  // Bulk User Selection / Removal (item 14). `scopeFilter` is the same
  // ownership/scope filter each role's existing single-delete route
  // already enforces (e.g. a faculty member's own section, an HOD's own
  // department) — bulk delete and Remove All both go through this same
  // filter, so a bulk action can never reach a user outside what that
  // role could already delete one at a time.
  async function bulkDeleteUsers(scopeFilter, { ids, removeAll }) {
    const filter = removeAll ? scopeFilter : { ...scopeFilter, id: { $in: (ids || []).filter(Boolean) } };
    if (!removeAll && (!ids || !ids.length)) return { removed: 0, usernames: [] };
    const rows = await Users.find(filter, { projection: { id: 1, username: 1, _id: 0 } }).toArray();
    if (!rows.length) return { removed: 0, usernames: [] };
    const usernames = rows.map(r => r.username);
    await Users.deleteMany({ id: { $in: rows.map(r => r.id) } });
    await Sessions.deleteMany({ username: { $in: usernames } });
    return { removed: rows.length, usernames };
  }

  app.get('/api/hod/students', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const rows = await Users.find({ college_id: req.user.college_id, department: req.user.department, role: 'student' }, { projection: { password_hash: 0, _id: 0 } }).toArray();
    // item 6: HOD, like Faculty, can see which of its own students are
    // still Pending an academic year.
    res.json({ students: rows.map(r => ({ ...r, academic: computeAcademicInfo(r) })) });
  }));

  app.post('/api/hod/students', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { name, username, password, roll_number, section_id, course, current_year } = req.body || {};
    if (!name || !username || !password || !section_id) return res.status(400).json({ error: 'Name, username, password, and section are all required.' });
    const section = await Sections.findOne({ id: section_id, college_id: req.user.college_id, department: req.user.department });
    if (!section) return res.status(404).json({ error: 'That section was not found in your department.' });
    // item 5: Course + Year at account-creation time, Year optional (Course
    // with no Year is valid and lands the student on the Pending list).
    const cy = courseYearFieldsForCreate(course, current_year);
    if (cy.error) return res.status(400).json({ error: cy.error });
    const existing = await Users.findOne({ username });
    if (existing) return res.status(409).json({ error: 'That username is already taken.' });
    const row = {
      id: newId('u'), name: String(name).trim(), username: String(username).trim(),
      password_hash: hashPassword(password), role: 'student',
      college_id: req.user.college_id, department: req.user.department,
      section_id, roll_number: (roll_number || '').trim(),
      ...cy.fields, academic_status: 'active', created_at: Date.now()
    };
    await Users.insertOne(row);
    res.status(201).json({ student: { ...publicUser(row), academic: computeAcademicInfo(row) } });
  }));

  // FIX: bulk-add students from an uploaded Excel/CSV sheet — Section is
  // NOT required in the file; the HOD picks one of their department's
  // sections on screen after upload (section_id) and it is applied to
  // every student. Columns: Name, Username, Password, Roll Number
  // (header names matched loosely). Preview first via the /preview route
  // below, then POST here to actually create the students — this route
  // re-validates from scratch rather than trusting the preview response.
  app.post('/api/hod/students/import/preview', requireAuth, requireRole('hod'), uploadLimiter, uploadStudentSheet.single('file'), ah(async (req, res) => {
    const deptSections = await Sections.find({ college_id: req.user.college_id, department: req.user.department }).toArray();
    await handleStudentSheetRequest(req, res, 'preview', {
      collegeId: req.user.college_id, department: req.user.department, sections: deptSections
    });
  }));
  app.post('/api/hod/students/import', requireAuth, requireRole('hod'), uploadLimiter, uploadStudentSheet.single('file'), ah(async (req, res) => {
    const deptSections = await Sections.find({ college_id: req.user.college_id, department: req.user.department }).toArray();
    await handleStudentSheetRequest(req, res, 'import', {
      collegeId: req.user.college_id, department: req.user.department, sections: deptSections
    });
  }));

  app.delete('/api/hod/students/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department, role: 'student' });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    await Users.deleteOne({ id: req.params.id });
    await Sessions.deleteMany({ username: row.username });
    res.json({ ok: true });
  }));

  // Bulk removal (item 14) — same department scope as the single-delete
  // route above. `remove_all: true` requires the caller to have already
  // shown its own confirmation dialog client-side; the server does not
  // re-confirm, it only enforces scope.
  app.post('/api/hod/students/bulk-delete', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { ids, remove_all } = req.body || {};
    const result = await bulkDeleteUsers(
      { college_id: req.user.college_id, department: req.user.department, role: 'student' },
      { ids, removeAll: !!remove_all }
    );
    res.json({ ok: true, ...result });
  }));

  // Student Profile / Section Management (item 15) — HOD scope: any
  // section within their own department (broader than faculty, who are
  // limited to their own assigned sections).
  app.put('/api/hod/students/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, department: req.user.department, role: 'student' });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const { section_id, roll_number, name } = req.body || {};
    const update = {};
    if (section_id != null && section_id !== row.section_id) {
      const section = await Sections.findOne({ id: section_id, college_id: req.user.college_id, department: req.user.department });
      if (!section) return res.status(404).json({ error: 'That section was not found in your department.' });
      update.section_id = section_id;
    }
    if (roll_number != null) update.roll_number = String(roll_number).trim();
    if (name != null && String(name).trim()) update.name = String(name).trim();
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update.' });
    await Users.updateOne({ id: req.params.id }, { $set: update });
    const updated = await Users.findOne({ id: req.params.id }, { projection: { password_hash: 0, _id: 0 } });
    res.json({ student: updated });
  }));

  app.post('/api/hod/faculty/bulk-delete', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { ids, remove_all } = req.body || {};
    const scope = { college_id: req.user.college_id, department: req.user.department, role: 'faculty' };
    if (remove_all) {
      const rows = await Users.find(scope, { projection: { username: 1, _id: 0 } }).toArray();
      await Sections.updateMany({ faculty_username: { $in: rows.map(r => r.username) } }, { $set: { faculty_username: null } });
    } else if (Array.isArray(ids) && ids.length) {
      const rows = await Users.find({ ...scope, id: { $in: ids } }, { projection: { username: 1, _id: 0 } }).toArray();
      await Sections.updateMany({ faculty_username: { $in: rows.map(r => r.username) } }, { $set: { faculty_username: null } });
    }
    const result = await bulkDeleteUsers(scope, { ids, removeAll: !!remove_all });
    res.json({ ok: true, ...result });
  }));

  // =====================================================================
  // AO (Administrative Officer) — Office Fee Management. College-wide
  // (every department at once, unlike HOD's department scope), and
  // deliberately fee-records-only: no test/marks/attendance/faculty data
  // is exposed anywhere in this section, and there is no online-payment
  // route anywhere in this file for AO to reach — every amount here is
  // typed in by AO staff from offline college records, matching the
  // requirement that this stay a manual, offline record-keeping module.
  // =====================================================================

  // A fee type's status is derived, never stored — so it can never drift
  // out of sync with a total/paid edit; there is exactly one source of
  // truth (the two numbers) and the label always reflects it directly.
  function feeItemStatus(total, paid) {
    const t = Number(total) || 0, p = Number(paid) || 0;
    if (t <= 0) return 'not_applicable';
    if (p <= 0) return 'pending';
    if (p >= t) return 'complete';
    return 'partial';
  }
  function withFeeStatus(item) {
    return { ...item, pending_amount: cleanDecimal(Math.max(0, (Number(item.total_amount) || 0) - (Number(item.paid_amount) || 0))), status: feeItemStatus(item.total_amount, item.paid_amount) };
  }
  function feeSummary(feeItems) {
    const items = (feeItems || []).map(withFeeStatus);
    const total_amount = cleanDecimal(items.reduce((s, i) => s + (Number(i.total_amount) || 0), 0));
    const paid_amount = cleanDecimal(items.reduce((s, i) => s + (Number(i.paid_amount) || 0), 0));
    const pending_amount = cleanDecimal(Math.max(0, total_amount - paid_amount));
    let status = 'not_applicable';
    if (total_amount > 0) status = paid_amount <= 0 ? 'pending' : paid_amount >= total_amount ? 'complete' : 'partial';
    return { fee_items: items, total_amount, paid_amount, pending_amount, status };
  }

  // GET /api/ao/students — the Student List + filters (item 1). College-
  // wide by default ("andaroo students normal list lo kanipinchali"); the
  // department/course/year/section/pending filters and the search box
  // all narrow the SAME list rather than requiring a different view.
  // EAMCET/Management admission categories have been removed entirely
  // (item 2) — there is no `category` filter or field anywhere below.
  app.get('/api/ao/students', requireAuth, requireRole('ao'), ah(async (req, res) => {
    const { department, course, year, section_id, pending, q } = req.query;
    const filter = { college_id: req.user.college_id, role: 'student' };
    if (department) filter.department = department;
    if (section_id) filter.section_id = section_id;
    if (course) filter.course = course;
    if (q && q.trim()) {
      const re = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: re }, { username: re }, { roll_number: re }];
    }
    let students = await Users.find(filter, { projection: { password_hash: 0, _id: 0 } }).sort({ department: 1, name: 1 }).toArray();

    // "Year" lives on the Section (see POST /api/hod/sections), not on the
    // student directly, so it's applied as a second pass once each
    // student's section is known.
    if (year) {
      const sectionIds = [...new Set(students.map(s => s.section_id).filter(Boolean))];
      const sections = sectionIds.length ? await Sections.find({ id: { $in: sectionIds }, year }).toArray() : [];
      const matchingSectionIds = new Set(sections.map(s => s.id));
      students = students.filter(s => matchingSectionIds.has(s.section_id));
    }

    const sectionIds = [...new Set(students.map(s => s.section_id).filter(Boolean))];
    const sections = sectionIds.length ? await Sections.find({ id: { $in: sectionIds } }, { projection: { id: 1, name: 1, year: 1, _id: 0 } }).toArray() : [];
    const sectionById = Object.fromEntries(sections.map(s => [s.id, s]));

    const usernames = students.map(s => s.username);
    const feeRows = usernames.length ? await StudentFees.find({ student_username: { $in: usernames } }).toArray() : [];
    const feeByUsername = Object.fromEntries(feeRows.map(f => [f.student_username, f]));

    let mapped = students.map(s => ({
      ...s,
      section_name: sectionById[s.section_id]?.name || null,
      section_year: sectionById[s.section_id]?.year || null,
      academic: computeAcademicInfo(s),
      fees: feeSummary((feeByUsername[s.username] || {}).fee_items)
    }));
    // Pending Students filter (item 6) — course selected but year missing.
    // Kept as a query param (rather than a separate endpoint) so it narrows
    // the same list everything else in this route already narrows.
    if (pending === 'true' || pending === '1') mapped = mapped.filter(s => s.academic.pending);

    res.json({ students: mapped });
  }));

  // GET /api/ao/sections — college-wide (every department), for the Add
  // Student / filter dropdowns. AO is not department-scoped the way HOD
  // is, so this deliberately has no department filter server-side.
  app.get('/api/ao/sections', requireAuth, requireRole('ao'), ah(async (req, res) => {
    const rows = await Sections.find({ college_id: req.user.college_id }).sort({ department: 1, name: 1 }).toArray();
    res.json({ sections: rows.map(stripId) });
  }));

  // GET /api/ao/students/:id — Student Profile (item 11): basic details +
  // every fee type with total/paid/pending/status.
  app.get('/api/ao/students/:id', requireAuth, requireRole('ao'), ah(async (req, res) => {
    const student = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, role: 'student' }, { projection: { password_hash: 0, _id: 0 } });
    if (!student) return res.status(404).json({ error: 'Not found.' });
    const section = student.section_id ? await Sections.findOne({ id: student.section_id }, { projection: { name: 1, year: 1, department: 1, _id: 0 } }) : null;
    const feeRow = await StudentFees.findOne({ student_username: student.username });
    res.json({
      student: {
        ...student,
        section_name: section?.name || null, section_year: section?.year || null,
        academic: computeAcademicInfo(student),
      },
      fees: feeSummary(feeRow?.fee_items)
    });
  }));

  // PUT /api/ao/students/:id — item 2/3/6: Admission Category, Course, and
  // Course Duration are the fields AO itself owns and can revise later
  // ("AO ki student category ni later edit chesukune permission
  // undaali" / "AO later edit cheyyagaladu"). Roster identity (name,
  // roll number, section) stays HOD's job — AO never touches those here,
  // keeping this module's write authority limited to exactly what items
  // 1/2/6 ask for: Course, Year (current_year), and Completion status.
  // Course duration is never sent by the client — it's always derived from
  // COURSE_DURATIONS (item 1: "Use the course's configured duration",
  // never hard-coded per course), so it can't drift out of sync.
  app.put('/api/ao/students/:id', requireAuth, requireRole('ao'), ah(async (req, res) => {
    const student = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, role: 'student' });
    if (!student) return res.status(404).json({ error: 'Not found.' });
    const { course, current_year, academic_status } = req.body || {};
    const update = {};
    if (course !== undefined) {
      if (course !== null && !COURSE_TYPES.includes(course)) return res.status(400).json({ error: 'Invalid course type.' });
      update.course = course;
      update.course_duration_years = course ? courseDurationYears(course) : null;
      // "When AO selects a course, the 1st Year must automatically be
      // selected by default" (item 1) — applies here too in case the
      // caller changes course without also sending a year: default to
      // Year 1 rather than leaving a stale/mismatched year in place.
      if (current_year === undefined) update.current_year = course ? 1 : null;
      // Switching course invalidates a prior Completed status — completion
      // is always re-earned against the newly selected course's final year.
      if (academic_status === undefined) update.academic_status = 'active';
    }
    const effectiveCourse = course !== undefined ? course : student.course;
    if (current_year !== undefined) {
      if (current_year === null) {
        update.current_year = null;
      } else {
        if (!effectiveCourse) return res.status(400).json({ error: 'Select a course before choosing a year.' });
        const duration = courseDurationYears(effectiveCourse);
        if (!(Number(current_year) >= 1) || (duration && Number(current_year) > duration)) {
          return res.status(400).json({ error: `Year must be between 1 and ${duration} for this course.` });
        }
        update.current_year = Number(current_year);
      }
    }
    if (academic_status !== undefined) {
      if (!['active', 'completed'].includes(academic_status)) return res.status(400).json({ error: 'Invalid academic status.' });
      if (academic_status === 'completed') {
        const effectiveYear = update.current_year !== undefined ? update.current_year : student.current_year;
        const duration = courseDurationYears(effectiveCourse);
        if (!effectiveCourse || !effectiveYear || !duration || Number(effectiveYear) < duration) {
          return res.status(400).json({ error: 'Only a student in their final year can be marked Completed.' });
        }
      }
      update.academic_status = academic_status;
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    update.updated_at = Date.now();
    await Users.updateOne({ id: req.params.id }, { $set: update });
    const updated = await Users.findOne({ id: req.params.id }, { projection: { password_hash: 0, _id: 0 } });
    res.json({ student: { ...updated, academic: computeAcademicInfo(updated) } });
  }));

  // PUT /api/ao/students/:id/fees — item 4/5/6: full replace of this
  // student's fee types in one save, since the Fee Details editor lets AO
  // add/edit/remove several fee types (Tuition/Hostel/Transport/Other) at
  // once and submit together. Every amount here is exactly what AO typed
  // in from offline college records — nothing here is ever written by a
  // payment flow (see the module-level comment above).
  app.put('/api/ao/students/:id/fees', requireAuth, requireRole('ao'), ah(async (req, res) => {
    const student = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, role: 'student' });
    if (!student) return res.status(404).json({ error: 'Not found.' });
    const { fee_items } = req.body || {};
    if (!Array.isArray(fee_items)) return res.status(400).json({ error: 'fee_items must be an array.' });
    for (const item of fee_items) {
      if (!item.fee_type || !String(item.fee_type).trim()) return res.status(400).json({ error: 'Every fee type needs a name.' });
      if (!(Number(item.total_amount) >= 0)) return res.status(400).json({ error: `"${item.fee_type}" needs a valid total amount.` });
      if (!(Number(item.paid_amount) >= 0)) return res.status(400).json({ error: `"${item.fee_type}" needs a valid paid amount.` });
      // item 9: Overpaid/Invalid — Paid can never exceed Total, since this
      // system doesn't support overpayments anywhere else.
      if (Number(item.paid_amount) > Number(item.total_amount)) return res.status(400).json({ error: `"${item.fee_type}" paid amount cannot exceed its total amount.` });
    }
    const cleanItems = fee_items.map(item => ({
      id: item.id && String(item.id).trim() ? item.id : newId('fee'),
      fee_type: String(item.fee_type).trim(),
      total_amount: cleanDecimal(Number(item.total_amount)),
      paid_amount: cleanDecimal(Number(item.paid_amount)),
      updated_at: Date.now(),
    }));
    await StudentFees.updateOne(
      { student_username: student.username },
      { $set: { student_username: student.username, college_id: req.user.college_id, fee_items: cleanItems, updated_at: Date.now() }, $setOnInsert: { id: newId('sfee'), created_at: Date.now() } },
      { upsert: true }
    );
    res.json({ fees: feeSummary(cleanItems) });
  }));

  // POST /api/ao/students — Add Student (item 7), college-wide (AO picks
  // ANY department's section, unlike HOD who's limited to their own
  // department). Duplicate protection (item 9: "Existing student
  // duplicate create kakunda") checks both username AND roll number
  // within the same department, since a faculty/HOD-created student
  // AO hasn't seen yet is far more likely to collide on roll number than
  // on a freshly-chosen username.
  app.post('/api/ao/students', requireAuth, requireRole('ao'), ah(async (req, res) => {
    const { name, username, password, roll_number, section_id, course, current_year } = req.body || {};
    if (!name || !username || !password || !section_id) return res.status(400).json({ error: 'Name, username, password, and section are all required.' });
    const section = await Sections.findOne({ id: section_id, college_id: req.user.college_id });
    if (!section) return res.status(404).json({ error: 'That section was not found in this college.' });
    const cy = courseYearFieldsForCreate(course, current_year);
    if (cy.error) return res.status(400).json({ error: cy.error });
    const existingUsername = await Users.findOne({ username });
    if (existingUsername) return res.status(409).json({ error: 'That username is already taken.' });
    const trimmedRoll = (roll_number || '').trim();
    if (trimmedRoll) {
      const existingRoll = await Users.findOne({ college_id: req.user.college_id, department: section.department, role: 'student', roll_number: { $regex: `^${trimmedRoll.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
      if (existingRoll) return res.status(409).json({ error: `A student with roll number "${trimmedRoll}" already exists in ${section.department} (${existingRoll.name}) — open their profile to edit instead of creating a duplicate.` });
    }
    const row = {
      id: newId('u'), name: String(name).trim(), username: String(username).trim(),
      password_hash: hashPassword(password), role: 'student',
      college_id: req.user.college_id, department: section.department,
      section_id, roll_number: trimmedRoll,
      ...cy.fields, academic_status: 'active',
      created_by_ao: req.user.username, created_at: Date.now()
    };
    await Users.insertOne(row);
    res.status(201).json({ student: { ...publicUser(row), academic: computeAcademicInfo(row) } });
  }));

  // NEW: AO bulk-add students from Excel/CSV — same import engine as HOD
  // and Faculty above, but college-wide (every department's sections are
  // in scope, matching AO's existing college-wide reach on every other AO
  // route). Section is chosen on screen after upload and applied to every
  // row; it is never required in the sheet itself.
  app.post('/api/ao/students/import/preview', requireAuth, requireRole('ao'), uploadLimiter, uploadStudentSheet.single('file'), ah(async (req, res) => {
    const collegeSections = await Sections.find({ college_id: req.user.college_id }).toArray();
    await handleStudentSheetRequest(req, res, 'preview', {
      collegeId: req.user.college_id, department: null, sections: collegeSections
    });
  }));
  app.post('/api/ao/students/import', requireAuth, requireRole('ao'), uploadLimiter, uploadStudentSheet.single('file'), ah(async (req, res) => {
    const collegeSections = await Sections.find({ college_id: req.user.college_id }).toArray();
    await handleStudentSheetRequest(req, res, 'import', {
      collegeId: req.user.college_id, department: null, sections: collegeSections, extraFields: { created_by_ao: req.user.username }
    });
  }));

  // =====================================================================
  // FACULTY — their section's students, attendance, marks
  // =====================================================================
  // NEW: also reachable by an HOD who is assigned as the teacher for a
  // timetable slot (assignee_role: 'hod') — needed so they can see the
  // roster for Normal Attendance on their own taught hours, same as
  // Faculty. Section scope comes from myTeachingSectionIds, which for an
  // HOD is derived strictly from their own timetable assignments — never
  // the whole department — so this stays read-only roster access for
  // attendance, not general student management (create/edit/delete/points
  // below remain Faculty-only, unchanged).
  app.get('/api/faculty/students', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const sectionIds = await myTeachingSectionIds(req.user);
    const rows = sectionIds.length
      ? await Users.find({ college_id: req.user.college_id, role: 'student', section_id: { $in: sectionIds } }, { projection: { password_hash: 0, _id: 0 } }).toArray()
      : [];
    // `leaderboard_adjustment` is ONLY the faculty's own manual +/- nudge
    // (LeaderboardAdjustments), kept for the "Adjust points" / "Reset
    // points" actions on this page — it is not, and was never meant to be,
    // the student's actual leaderboard total. Displaying it standalone as
    // "Leaderboard points" is exactly what let this list show 0 for a
    // student who simply never had a manual adjustment made, while the
    // Main Leaderboard correctly showed their full computed score (test +
    // attendance + marks + events + clubs + this same adjustment).
    const adjustments = rows.length
      ? await LeaderboardAdjustments.find({ student_username: { $in: rows.map(r => r.username) } }).toArray()
      : [];
    const adjustmentByStudent = Object.fromEntries(adjustments.map(a => [a.student_username, a.points]));
    // Authoritative total — reuses buildLeaderboard (the exact function
    // GET /api/leaderboard calls) rather than recomputing points here, so
    // this list can never drift out of sync with the Main Leaderboard for
    // the same student. Unscoped (whole college) because a student's own
    // score doesn't depend on which scope is being viewed — only ranking
    // does.
    const fullLeaderboard = rows.length ? await buildLeaderboard(req.user.college_id, {}) : [];
    const totalByStudent = Object.fromEntries(fullLeaderboard.map(r => [r.username, r.total]));
    // item 6: Faculty must also be able to identify Pending students.
    res.json({ students: rows.map(r => ({
      ...r,
      leaderboard_adjustment: adjustmentByStudent[r.username] || 0,
      // Same field the Main Leaderboard calls `total`/`score` for this
      // student — 0 is a real, current value here (not a fallback), never
      // a stale/previous number.
      leaderboard_points: totalByStudent[r.username] ?? 0,
      academic: computeAcademicInfo(r)
    })) });
  }));

  // NEW (item 16): fee details for students assigned to this faculty member
  // — strictly the students in their own assigned sections (same scope as
  // GET /api/faculty/students above), never any other student in the
  // college. Sourced from the exact same StudentFees collection AO Office
  // writes to and the student's own fee screen reads from, so there is no
  // separate/duplicated fee record to fall out of sync.
  app.get('/api/faculty/students/fees', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const sectionIds = req.user.section_ids || [];
    const students = sectionIds.length
      ? await Users.find({ college_id: req.user.college_id, role: 'student', section_id: { $in: sectionIds } }, { projection: { password_hash: 0, _id: 0 } }).toArray()
      : [];
    if (!students.length) return res.json({ students: [] });
    const usernames = students.map(s => s.username);
    const feeRows = await StudentFees.find({ student_username: { $in: usernames } }).toArray();
    const feeByUsername = Object.fromEntries(feeRows.map(f => [f.student_username, f]));
    const sections = await Sections.find({ id: { $in: sectionIds } }, { projection: { id: 1, name: 1, year: 1, _id: 0 } }).toArray();
    const sectionById = Object.fromEntries(sections.map(s => [s.id, s]));
    res.json({
      students: students.map(s => ({
        id: s.id, name: s.name, username: s.username, roll_number: s.roll_number || '',
        course: s.course || null, course_label: s.course ? (COURSE_LABELS[s.course] || s.course) : null,
        department: s.department, section_id: s.section_id, section_name: sectionById[s.section_id]?.name || null,
        year: sectionById[s.section_id]?.year || null,
        fees: feeSummary(feeByUsername[s.username]?.fee_items),
      }))
    });
  }));

  // NEW: lets a faculty member add a student directly, without going
  // through their HOD — but deliberately narrower than the HOD's own
  // POST /api/hod/students: a faculty member can only add a student to one
  // of their *own* assigned sections (req.user.section_ids), never any
  // section in the department. This mirrors the same hierarchy the rest of
  // the app already enforces (faculty scope = their sections; HOD scope =
  // their whole department).
  app.post('/api/faculty/students', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { name, username, password, roll_number, section_id, course, current_year } = req.body || {};
    if (!name || !username || !password || !section_id) return res.status(400).json({ error: 'Name, username, password, and section are all required.' });
    if (!(req.user.section_ids || []).includes(section_id)) return res.status(403).json({ error: 'You can only add students to your own section.' });
    // item 5: Course + Year at account-creation time, Year optional.
    const cy = courseYearFieldsForCreate(course, current_year);
    if (cy.error) return res.status(400).json({ error: cy.error });
    const existing = await Users.findOne({ username });
    if (existing) return res.status(409).json({ error: 'That username is already taken.' });
    const row = {
      id: newId('u'), name: String(name).trim(), username: String(username).trim(),
      password_hash: hashPassword(password), role: 'student',
      college_id: req.user.college_id, department: req.user.department,
      section_id, roll_number: (roll_number || '').trim(),
      ...cy.fields, academic_status: 'active', created_at: Date.now()
    };
    await Users.insertOne(row);
    res.status(201).json({ student: { ...publicUser(row), academic: computeAcademicInfo(row) } });
  }));

  // FIX: mirrors POST /api/faculty/students' scope exactly, but for bulk
  // Excel/CSV import — the section chosen after upload must be one of this
  // faculty member's own assigned sections (req.user.section_ids), never
  // any other section in the department. Section is not required in the
  // sheet itself. Preview first via /preview, then import.
  app.post('/api/faculty/students/import/preview', requireAuth, requireRole('faculty'), uploadLimiter, uploadStudentSheet.single('file'), ah(async (req, res) => {
    const sectionIds = req.user.section_ids || [];
    const mySections = sectionIds.length ? await Sections.find({ id: { $in: sectionIds } }).toArray() : [];
    await handleStudentSheetRequest(req, res, 'preview', {
      collegeId: req.user.college_id, department: req.user.department, sections: mySections
    });
  }));
  app.post('/api/faculty/students/import', requireAuth, requireRole('faculty'), uploadLimiter, uploadStudentSheet.single('file'), ah(async (req, res) => {
    const sectionIds = req.user.section_ids || [];
    const mySections = sectionIds.length ? await Sections.find({ id: { $in: sectionIds } }).toArray() : [];
    await handleStudentSheetRequest(req, res, 'import', {
      collegeId: req.user.college_id, department: req.user.department, sections: mySections
    });
  }));

  // NEW: mirrors POST /api/faculty/students' scope exactly — a faculty
  // member can only remove a student from one of their *own* assigned
  // sections, never any student in the department (that stays HOD's
  // broader DELETE /api/hod/students/:id).
  app.delete('/api/faculty/students/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, role: 'student' });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!(req.user.section_ids || []).includes(row.section_id)) return res.status(403).json({ error: 'You can only remove students from your own section.' });
    await Users.deleteOne({ id: req.params.id });
    await Sessions.deleteMany({ username: row.username });
    res.json({ ok: true });
  }));

  // Bulk removal (item 14), scoped to the faculty member's own sections.
  app.post('/api/faculty/students/bulk-delete', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { ids, remove_all } = req.body || {};
    const result = await bulkDeleteUsers(
      { college_id: req.user.college_id, role: 'student', section_id: { $in: req.user.section_ids || [] } },
      { ids, removeAll: !!remove_all }
    );
    res.json({ ok: true, ...result });
  }));

  // Student Profile / Section Management (item 15). A faculty member may
  // only move a student between sections they themselves are assigned to
  // (never an arbitrary section id) and only edit students already in one
  // of their own sections.
  app.put('/api/faculty/students/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const row = await Users.findOne({ id: req.params.id, college_id: req.user.college_id, role: 'student' });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!(req.user.section_ids || []).includes(row.section_id)) return res.status(403).json({ error: 'You can only edit students in your own section.' });
    const { section_id, roll_number, name } = req.body || {};
    const update = {};
    if (section_id != null && section_id !== row.section_id) {
      if (!(req.user.section_ids || []).includes(section_id)) return res.status(403).json({ error: 'You can only move a student into one of your own sections.' });
      const section = await Sections.findOne({ id: section_id, college_id: req.user.college_id });
      if (!section) return res.status(404).json({ error: 'Section not found.' });
      update.section_id = section_id;
    }
    if (roll_number != null) update.roll_number = String(roll_number).trim();
    if (name != null && String(name).trim()) update.name = String(name).trim();
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update.' });
    await Users.updateOne({ id: req.params.id }, { $set: update });
    const updated = await Users.findOne({ id: req.params.id }, { projection: { password_hash: 0, _id: 0 } });
    res.json({ student: updated });
  }));

  // NEW: faculty-controlled leaderboard point adjustment (item 6). A faculty
  // member can nudge a student's leaderboard score up or down by an amount
  // they enter — e.g. +5 for a students who missed being credited for extra
  // credit, -5 for a docked participation grade. Adjustments are cumulative
  // (repeated +/- calls add up) and are strictly scoped to students in one
  // of this faculty member's own assigned sections — a faculty member can
  // never touch a student outside their section, even by guessing an id.
  app.post('/api/faculty/students/:id/points', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const student = await Users.findOne({ id: req.params.id, role: 'student', college_id: req.user.college_id });
    if (!student) return res.status(404).json({ error: 'Not found.' });
    if (!(req.user.section_ids || []).includes(student.section_id)) return res.status(403).json({ error: 'You can only adjust points for students in your own section.' });
    const delta = Number(req.body?.delta);
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'Enter a nonzero point adjustment.' });
    const existing = await LeaderboardAdjustments.findOne({ student_username: student.username });
    const newTotal = Math.round((existing ? existing.points : 0) + delta);
    await LeaderboardAdjustments.updateOne(
      { student_username: student.username },
      { $set: {
        student_username: student.username, section_id: student.section_id, college_id: student.college_id,
        points: newTotal, updated_by: req.user.username, updated_at: Date.now()
      } },
      { upsert: true }
    );
    res.json({ ok: true, points: newTotal });
  }));

  // NEW (item 15): reset a student's Points adjustment back to zero. This
  // is deliberately scoped to the same LeaderboardAdjustments ledger the
  // +/- endpoint above writes to — "Points" here means that faculty-set
  // nudge, not the whole computed Main Leaderboard score (which also
  // includes attendance/marks/events/clubs and can't be "zeroed" without
  // erasing that underlying academic data). A reset writes a fresh ledger
  // row (points: 0) rather than deleting the document, so `updated_by`/
  // `updated_at`/`reset_from` on it double as a lightweight history of the
  // action — the same "preserve history" ask the spec makes for any ledger
  // that exists here, without needing a brand-new collection for it.
  // Supports all three spec modes in one endpoint:
  //   { all: true }              -> every student in this faculty's sections
  //   { student_ids: [...] }     -> exactly the selected students
  // A single id is just a one-element student_ids array from the frontend.
  app.post('/api/faculty/students/points/reset', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const sectionIds = req.user.section_ids || [];
    const { all, student_ids } = req.body || {};
    let targets;
    if (all) {
      targets = sectionIds.length ? await Users.find({ role: 'student', section_id: { $in: sectionIds } }, { projection: { username: 1, section_id: 1, college_id: 1, _id: 0 } }).toArray() : [];
    } else {
      if (!Array.isArray(student_ids) || student_ids.length === 0) return res.status(400).json({ error: 'Select at least one student, or choose Reset All.' });
      targets = await Users.find({ id: { $in: student_ids }, role: 'student', college_id: req.user.college_id, section_id: { $in: sectionIds } }, { projection: { username: 1, section_id: 1, college_id: 1, _id: 0 } }).toArray();
      if (targets.length !== student_ids.length) return res.status(403).json({ error: 'One or more selected students are outside your own section.' });
    }
    await Promise.all(targets.map(t => LeaderboardAdjustments.updateOne(
      { student_username: t.username },
      { $set: {
        student_username: t.username, section_id: t.section_id, college_id: t.college_id,
        points: 0, updated_by: req.user.username, updated_at: Date.now(), last_reset_at: Date.now()
      } },
      { upsert: true }
    )));
    res.json({ ok: true, reset_count: targets.length });
  }));

  // Same reset capability for an HOD, department-wide — an HOD is
  // authorized over every student in their own department (see every other
  // HOD-scoped route in this file), not just one faculty member's sections.
  app.post('/api/hod/students/points/reset', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { all, student_ids } = req.body || {};
    let targets;
    if (all) {
      targets = await Users.find({ role: 'student', college_id: req.user.college_id, department: req.user.department }, { projection: { username: 1, section_id: 1, college_id: 1, _id: 0 } }).toArray();
    } else {
      if (!Array.isArray(student_ids) || student_ids.length === 0) return res.status(400).json({ error: 'Select at least one student, or choose Reset All.' });
      targets = await Users.find({ id: { $in: student_ids }, role: 'student', college_id: req.user.college_id, department: req.user.department }, { projection: { username: 1, section_id: 1, college_id: 1, _id: 0 } }).toArray();
      if (targets.length !== student_ids.length) return res.status(403).json({ error: 'One or more selected students are outside your own department.' });
    }
    await Promise.all(targets.map(t => LeaderboardAdjustments.updateOne(
      { student_username: t.username },
      { $set: {
        student_username: t.username, section_id: t.section_id, college_id: t.college_id,
        points: 0, updated_by: req.user.username, updated_at: Date.now(), last_reset_at: Date.now()
      } },
      { upsert: true }
    )));
    res.json({ ok: true, reset_count: targets.length });
  }));

  app.get('/api/faculty/sections', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const sectionIds = req.user.section_ids || [];
    const rows = sectionIds.length ? await Sections.find({ id: { $in: sectionIds } }).toArray() : [];
    res.json({ sections: rows.map(stripId) });
  }));

  // NEW: what is this faculty member scheduled to teach on a given date
  // (defaults to today)? Drives the Attendance page — instead of a free
  // "pick any hour" dropdown, faculty pick from exactly these slots.
  // `already_taken` tells the frontend whether to show the locked/read-only
  // view for a slot without a second round-trip.
  // NEW: also reachable by an HOD assigned as the teacher for a slot — the
  // query already filters strictly by `faculty_username: req.user.username`
  // below, so an HOD only ever sees hours the timetable assigns to them
  // personally, never any other faculty/HOD's schedule.
  app.get('/api/faculty/timetable', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const date = req.query.date || todayISTDateStr();
    const day = dayOfWeekFromDate(date);
    let rows = await Timetable.find({ faculty_username: req.user.username, day_of_week: day }).toArray();

    // Defensive fallback: the exact-match query above is correct for every
    // row created through the current POST /api/hod/timetable (which
    // trims+validates faculty_username/day_of_week on write), but rows
    // written by an earlier version of this feature — before that
    // validation existed — can carry stray casing/whitespace
    // ("Thursday" vs "thursday", a trailing space on the username, etc.).
    // Only runs when the fast path finds nothing, so it costs nothing on
    // the common/working path, and it NEVER writes anything back to the
    // database — existing rows are left exactly as they are.
    if (rows.length === 0) {
      const normUser = req.user.username.trim().toLowerCase();
      const candidates = await Timetable.find({ day_of_week: { $regex: `^${day}$`, $options: 'i' } }).toArray();
      const near = candidates.filter(r => String(r.faculty_username || '').trim().toLowerCase() === normUser);
      if (near.length > 0) {
        console.warn('[faculty/timetable] normalized-match fallback used', {
          date, day, username: req.user.username,
          sample_stored_faculty_username: near[0].faculty_username,
          sample_stored_day_of_week: near[0].day_of_week,
        });
        rows = near;
      } else if (candidates.length > 0) {
        // There ARE slots for this day, just not for this faculty — log
        // enough to tell "wrong day" apart from "wrong identity" without
        // a second round trip.
        console.warn('[faculty/timetable] zero rows for this faculty on a day that has other slots', {
          date, day, username: req.user.username,
          other_faculty_usernames_on_this_day: [...new Set(candidates.map(r => r.faculty_username))],
        });
      } else {
        console.warn('[faculty/timetable] zero rows for this day at all', { date, day, username: req.user.username });
      }
    }

    const sectionIds = [...new Set(rows.map(r => r.section_id))];
    const subjectIds = [...new Set(rows.map(r => r.subject_id))];
    const [sections, subjects, attRows] = await Promise.all([
      sectionIds.length ? Sections.find({ id: { $in: sectionIds } }).toArray() : [],
      subjectIds.length ? Subjects.find({ id: { $in: subjectIds } }).toArray() : [],
      sectionIds.length ? Attendance.find({ section_id: { $in: sectionIds }, date }).toArray() : []
    ]);
    const sectionMap = Object.fromEntries(sections.map(s => [s.id, s]));
    const subjectMap = Object.fromEntries(subjects.map(s => [s.id, s]));
    const takenSet = new Set(attRows.map(r => `${r.section_id}|${r.hour}`));
    // NEW (Academic Calendar): tell the frontend up-front which of today's
    // slots are actually markable, so the UI can lock them without a
    // failed round-trip — the real enforcement still happens in POST
    // /api/faculty/attendance regardless of what this says.
    const isFuture = isFutureDateStr(date);
    const calendarEntryCache = new Map();
    const calendarEntryFor = async (sec) => {
      const key = `${sec?.department || req.user.department}|${sec?.year || ''}`;
      if (!calendarEntryCache.has(key)) {
        calendarEntryCache.set(key, await getCalendarEntryForDate(req.user.college_id, sec?.department || req.user.department, sec?.year || null, date));
      }
      return calendarEntryCache.get(key);
    };
    const slots = [];
    for (const r of rows) {
      const sec = sectionMap[r.section_id];
      const entry = await calendarEntryFor(sec);
      const isHoliday = !!entry && entry.status === 'HOLIDAY';
      slots.push({
        ...stripId(r),
        section_name: sec?.name || r.section_id,
        section_year: sec?.year || null,
        subject_name: subjectMap[r.subject_id]?.name || r.subject_id,
        already_taken: takenSet.has(`${r.section_id}|${r.hour}`),
        is_future: isFuture,
        is_holiday: isHoliday,
        holiday_reason: isHoliday ? (entry.reason || null) : null,
        can_mark_attendance: !isFuture && !isHoliday,
      });
    }
    slots.sort((a, b) => Number(a.hour) - Number(b.hour));
    res.json({ date, day_of_week: day, is_future: isFuture, slots });
  }));

  // NEW (item 13): the COMPLETE weekly timetable for each of this faculty
  // member's assigned sections — not just their own hours (that's what
  // /api/faculty/timetable above is for, scoped to attendance-taking for
  // one day). Every slot in the section is returned; `is_mine` marks the
  // ones assigned to the signed-in faculty member so the frontend can
  // highlight exactly those, per spec, and nothing else. View-only: no
  // create/edit/delete route exists for faculty on this collection at all
  // (see item 9/10) — this endpoint only ever reads.
  app.get('/api/faculty/timetable/full', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const sectionIds = req.user.section_ids || [];
    if (!sectionIds.length) return res.json({ sections: [], slots: [] });
    const [sections, rows] = await Promise.all([
      Sections.find({ id: { $in: sectionIds } }, { projection: { id: 1, name: 1, year: 1, department: 1, _id: 0 } }).toArray(),
      Timetable.find({ section_id: { $in: sectionIds } }).toArray(),
    ]);
    const subjectIds = [...new Set(rows.map(r => r.subject_id))];
    const assigneeUsernames = [...new Set(rows.map(r => r.faculty_username))];
    const [subjects, assignees] = await Promise.all([
      subjectIds.length ? Subjects.find({ id: { $in: subjectIds } }, { projection: { id: 1, name: 1, _id: 0 } }).toArray() : [],
      assigneeUsernames.length ? Users.find({ username: { $in: assigneeUsernames } }, { projection: { username: 1, name: 1, role: 1, _id: 0 } }).toArray() : [],
    ]);
    const subjectMap = Object.fromEntries(subjects.map(s => [s.id, s.name]));
    const assigneeMap = Object.fromEntries(assignees.map(a => [a.username, a]));
    res.json({
      sections: sections.map(s => ({ id: s.id, name: s.name, year: s.year })),
      slots: rows.map(r => ({
        id: r.id, section_id: r.section_id, day_of_week: r.day_of_week, hour: r.hour,
        subject_name: subjectMap[r.subject_id] || r.subject_id,
        assignee_username: r.faculty_username, assignee_role: r.assignee_role || 'faculty',
        assignee_name: assigneeMap[r.faculty_username]?.name || r.faculty_username,
        is_mine: r.faculty_username === req.user.username,
      })),
    });
  }));

  // NEW (item 14): a student's own complete section timetable — scoped
  // strictly to req.user.section_id server-side, so a student can never see
  // another section's schedule (URL/query tampering has nothing to change:
  // there is no section_id parameter accepted here at all).
  app.get('/api/student/timetable', requireAuth, requireRole('student'), ah(async (req, res) => {
    if (!req.user.section_id) return res.json({ section: null, slots: [] });
    const [section, rows] = await Promise.all([
      Sections.findOne({ id: req.user.section_id }, { projection: { id: 1, name: 1, year: 1, _id: 0 } }),
      Timetable.find({ section_id: req.user.section_id }).toArray(),
    ]);
    const subjectIds = [...new Set(rows.map(r => r.subject_id))];
    const assigneeUsernames = [...new Set(rows.map(r => r.faculty_username))];
    const [subjects, assignees] = await Promise.all([
      subjectIds.length ? Subjects.find({ id: { $in: subjectIds } }, { projection: { id: 1, name: 1, _id: 0 } }).toArray() : [],
      assigneeUsernames.length ? Users.find({ username: { $in: assigneeUsernames } }, { projection: { username: 1, name: 1, role: 1, _id: 0 } }).toArray() : [],
    ]);
    const subjectMap = Object.fromEntries(subjects.map(s => [s.id, s.name]));
    const assigneeMap = Object.fromEntries(assignees.map(a => [a.username, a]));
    res.json({
      section: section ? { id: section.id, name: section.name, year: section.year } : null,
      slots: rows.map(r => ({
        id: r.id, day_of_week: r.day_of_week, hour: r.hour,
        subject_name: subjectMap[r.subject_id] || r.subject_id,
        assignee_role: r.assignee_role || 'faculty',
        assignee_name: assigneeMap[r.faculty_username]?.name || r.faculty_username,
      })),
    });
  }));

  // NEW: also reachable by an HOD assigned as the teacher for a slot — the
  // Timetable.findOne lookup below already keys strictly off
  // `faculty_username: req.user.username`, so an HOD can only ever submit
  // attendance for an hour the timetable actually assigns to them.
  app.post('/api/faculty/attendance', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const { section_id, date, hour, subject_id, records } = req.body || {};
    if (!section_id || !date || !hour || !subject_id || !Array.isArray(records)) {
      return res.status(400).json({ error: 'Section, date, hour, subject, and attendance records are required.' });
    }
    // UPDATED: attendance is now driven entirely by the HOD-managed
    // timetable — a faculty member may only take attendance for a section
    // and hour that the timetable actually assigns to them on that day of
    // the week, and only for the subject the timetable says is taught then.
    // This replaces the old "any of my assigned sections, any hour" check.
    const day = dayOfWeekFromDate(date);
    const slot = await findMyTimetableSlot(Timetable, { section_id, day, hour, username: req.user.username });
    if (!slot) return res.status(403).json({ error: 'You are not scheduled to teach this section at this hour, according to the timetable.' });
    if (slot.subject_id !== subject_id) return res.status(400).json({ error: 'That subject does not match the timetable for this hour.' });

    // NEW (Academic Calendar / Rules A & B): a holiday or a future date
    // blocks attendance regardless of what the timetable says. Enforced
    // here — not just hidden/disabled on the frontend — so a direct API
    // call for a holiday or future date is rejected the same way.
    const section = await Sections.findOne({ id: section_id });
    const calendarDenial = await assertAttendanceDateAllowed({
      collegeId: req.user.college_id, department: section?.department || req.user.department, year: section?.year || null, dateStr: date,
    });
    if (calendarDenial) return res.status(calendarDenial.status).json({ error: calendarDenial.error });

    // UPDATED: attendance is per-hour, and once submitted for a given
    // section/date/hour it is locked — it can never be edited or resubmitted.
    const existing = await Attendance.findOne({ section_id, date, hour: String(hour) });
    if (existing) return res.status(409).json({ error: 'Attendance for this hour has already been submitted and cannot be edited.' });

    // Security fix: `records[].student_username` was previously trusted
    // straight from the request body with no check that those usernames
    // actually belong to this section — a crafted request could have
    // submitted attendance for students outside it (or nonexistent ones)
    // entirely client-side. Face-recognition attendance never had this gap
    // (it derives identity server-side from descriptor matches against the
    // roster); this brings Normal Attendance to the same standard: every
    // submitted username is re-checked here against the actual section
    // roster before being written.
    const sectionRoster = await Users.find({ role: 'student', college_id: req.user.college_id, section_id }, { projection: { username: 1, _id: 0 } }).toArray();
    const validUsernames = new Set(sectionRoster.map(s => s.username));
    const invalidRecord = records.find(r => !validUsernames.has(r?.student_username));
    if (invalidRecord) {
      return res.status(400).json({ error: 'One or more students in this submission are not part of this section.' });
    }

    const semester = await findSemesterForDate(req.user.college_id, req.user.department, date);

    const row = {
      section_id, college_id: req.user.college_id, date, hour: String(hour), subject_id,
      semester_id: semester ? semester.id : null,
      records: records.map(r => ({ student_username: r.student_username, present: !!r.present })),
      taken_by: req.user.username, taken_by_name: req.user.name, created_at: Date.now(), locked: true,
      method: 'MANUAL' // NEW: distinguishes this from Face Recognition Attendance rows below; older rows without this field are still treated as manual everywhere they're read
    };
    await Attendance.insertOne(row);
    res.status(201).json({ ok: true });
    const presentUsernames = row.records.map(r => r.student_username);
    notifyUsers(presentUsernames, {
      college_id: row.college_id, tab: 'myattendance', type: 'attendance_marked',
      title: 'Attendance recorded', message: 'Attendance for hour ' + row.hour + ' on ' + row.date + ' has been recorded.', related_id: row.section_id
    }).catch(err => console.error('notify failed', err));
  }));

  // NEW: also reachable by an HOD assigned as the teacher for a slot —
  // scoped via myTeachingSectionIds exactly like the roster route above.
  app.get('/api/faculty/attendance/:sectionId', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const sectionIds = await myTeachingSectionIds(req.user);
    if (!sectionIds.includes(req.params.sectionId)) return res.status(403).json({ error: 'Not your section.' });
    const rows = await Attendance.find({ section_id: req.params.sectionId }).sort({ date: -1, hour: -1 }).toArray();
    const subjectIds = [...new Set(rows.map(r => r.subject_id).filter(Boolean))];
    const subjects = subjectIds.length ? await Subjects.find({ id: { $in: subjectIds } }).toArray() : [];
    const subjectMap = Object.fromEntries(subjects.map(s => [s.id, s.name]));
    res.json({ attendance: rows.map(r => ({ ...stripId(r), subject_name: r.subject_id ? subjectMap[r.subject_id] : null })) });
  }));

  // GET /api/faculty/attendance-calendar/:sectionId?month=YYYY-MM (NEW)
  // The Attendance Calendar + Summary for this faculty member's own hours
  // in one section, for one month (defaults to the current month, IST).
  // Per date: 'completed' (✓ all of this faculty's expected hours that day
  // have attendance), 'pending' (✗ working day, not yet fully marked),
  // 'holiday' (H), 'future' (🔒 locked), or 'no_class' (this faculty has no
  // timetable slot for this section on that weekday at all — not counted
  // either way). The summary only counts eligible *timetable* sessions —
  // never bare calendar dates (item 6) — and never counts a holiday or a
  // future date as pending (Rules E/F).
  app.get('/api/faculty/attendance-calendar/:sectionId', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const sectionIds = await myTeachingSectionIds(req.user);
    if (!sectionIds.includes(req.params.sectionId)) return res.status(403).json({ error: 'Not your section.' });
    const section = await Sections.findOne({ id: req.params.sectionId });
    const today = todayISTDateStr();
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
    const [yearNum, monthNum] = month.split('-').map(Number);
    const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
    const fromDate = `${month}-01`;
    const toDate = `${month}-${String(daysInMonth).padStart(2, '0')}`;

    const mySlots = await Timetable.find({ section_id: req.params.sectionId, faculty_username: req.user.username }).toArray();
    const hoursByDay = {};
    for (const s of mySlots) {
      const d = String(s.day_of_week || '').trim().toLowerCase();
      (hoursByDay[d] = hoursByDay[d] || []).push(String(s.hour));
    }

    const [calendarRows, attRows] = await Promise.all([
      AcademicCalendar.find({
        college_id: req.user.college_id, department: section?.department || req.user.department,
        date: { $gte: fromDate, $lte: toDate }, $or: [{ year: section?.year || null }, { year: null }],
      }).toArray(),
      Attendance.find({ section_id: req.params.sectionId, date: { $gte: fromDate, $lte: toDate } }).toArray(),
    ]);
    // Prefer a year-specific calendar entry over a department-wide one for the same date.
    const calendarByDate = {};
    for (const row of calendarRows) {
      if (!calendarByDate[row.date] || row.year) calendarByDate[row.date] = row;
    }
    const attHoursByDate = {};
    for (const a of attRows) (attHoursByDate[a.date] = attHoursByDate[a.date] || new Set()).add(String(a.hour));

    const days = [];
    let eligible = 0, completed = 0, holidays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const dow = dayOfWeekFromDate(date);
      const expectedHours = hoursByDay[dow] || [];
      const entry = calendarByDate[date];
      const isHoliday = !!entry && entry.status === 'HOLIDAY';
      const isFuture = date > today;
      let status;
      if (expectedHours.length === 0) {
        status = 'no_class';
      } else if (isHoliday) {
        status = 'holiday';
        holidays++;
      } else if (isFuture) {
        status = 'future';
      } else {
        const doneHours = attHoursByDate[date] || new Set();
        const allDone = expectedHours.every((h) => doneHours.has(h));
        eligible++;
        if (allDone) { status = 'completed'; completed++; } else status = 'pending';
      }
      days.push({ date, status, expected_hours: expectedHours.map(Number), reason: entry?.reason || null });
    }

    res.json({
      month, section_id: req.params.sectionId,
      days,
      summary: {
        eligible_working_days: eligible, attendance_completed: completed,
        attendance_pending: eligible - completed, holidays,
      },
    });
  }));

  app.post('/api/faculty/marks', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { section_id, test_name, max_score, records } = req.body || {};
    if (!section_id || !test_name || !max_score || !Array.isArray(records)) return res.status(400).json({ error: 'Section, test name, max score, and records are required.' });
    if (!(req.user.section_ids || []).includes(section_id)) return res.status(403).json({ error: 'You can only record marks for your own section.' });
    const row = {
      id: newId('mk'), section_id, college_id: req.user.college_id, test_name: String(test_name).trim(),
      max_score: Number(max_score), records: records.map(r => ({ student_username: r.student_username, score: Number(r.score) || 0 })),
      taken_by: req.user.username, taken_by_name: req.user.name, created_at: Date.now()
    };
    await Marks.insertOne(row);
    res.status(201).json({ marks: stripId(row) });
    const scoredUsernames = row.records.map(r => r.student_username);
    notifyUsers(scoredUsernames, {
      college_id: row.college_id, tab: 'mymarks', type: 'marks_added',
      title: 'New marks: ' + row.test_name, message: 'Your marks for ' + row.test_name + ' have been posted.', related_id: row.id
    }).catch(err => console.error('notify failed', err));
  }));

  app.get('/api/faculty/marks/:sectionId', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    if (!(req.user.section_ids || []).includes(req.params.sectionId)) return res.status(403).json({ error: 'Not your section.' });
    const rows = await Marks.find({ section_id: req.params.sectionId }).sort({ created_at: -1 }).toArray();
    res.json({ marks: rows.map(stripId) });
  }));

  app.delete('/api/faculty/marks/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const row = await Marks.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (row.taken_by !== req.user.username) return res.status(403).json({ error: 'You can only remove your own records.' });
    await Marks.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // =====================================================================
  // STUDENT — their own attendance & marks
  // =====================================================================
  // GET /api/student/fees — item 7/8: the student's own complete fee
  // picture (total/paid/pending + per-fee-type breakdown), sourced from the
  // exact same StudentFees collection AO Office writes to. There is no
  // separate student-facing fee record anywhere — an AO edit is reflected
  // here immediately on next load, with the same derived pending/status
  // math used everywhere else (feeSummary/feeItemStatus above).
  app.get('/api/student/fees', requireAuth, requireRole('student'), ah(async (req, res) => {
    const feeRow = await StudentFees.findOne({ student_username: req.user.username });
    res.json({ fees: feeSummary(feeRow?.fee_items), academic: computeAcademicInfo(req.user) });
  }));

  app.get('/api/student/attendance', requireAuth, requireRole('student'), ah(async (req, res) => {
    // UPDATED: attendance now carries a subject and (when it falls inside an
    // HOD-defined semester) a semester_id, so students get a subject-wise
    // breakdown and can filter by semester, not just an overall percentage.
    const semesterId = req.query.semester_id || null;
    const filter = { section_id: req.user.section_id };
    if (semesterId) filter.semester_id = semesterId;
    const rows = await Attendance.find(filter).sort({ date: -1, hour: -1 }).toArray();

    const subjectIds = [...new Set(rows.map(r => r.subject_id).filter(Boolean))];
    const subjects = subjectIds.length ? await Subjects.find({ id: { $in: subjectIds } }).toArray() : [];
    const subjectMap = Object.fromEntries(subjects.map(s => [s.id, s.name]));

    let present = 0, total = 0;
    const bySubject = {};
    const history = [];
    for (const r of rows) {
      const mine = r.records.find(x => x.student_username === req.user.username);
      if (!mine) continue;
      total++; if (mine.present) present++;
      history.push({
        date: r.date, hour: r.hour || null, subject_id: r.subject_id || null,
        subject_name: r.subject_id ? subjectMap[r.subject_id] : null, present: mine.present,
        method: r.method || 'MANUAL' // NEW: older rows predate this field and are manual by definition
      });
      if (r.subject_id) {
        bySubject[r.subject_id] = bySubject[r.subject_id] || { subject_id: r.subject_id, subject_name: subjectMap[r.subject_id], present_count: 0, total_count: 0 };
        bySubject[r.subject_id].total_count++;
        if (mine.present) bySubject[r.subject_id].present_count++;
      }
    }
    const by_subject = Object.values(bySubject).map(s => ({ ...s, percentage: s.total_count ? Math.round((s.present_count / s.total_count) * 100) : null }));
    const semesters = await Semesters.find({ college_id: req.user.college_id, department: req.user.department }).sort({ start_date: -1 }).toArray();

    res.json({
      history, present_count: present, total_count: total,
      percentage: total ? Math.round((present / total) * 100) : null,
      by_subject, semesters: semesters.map(stripId)
    });
  }));

  // =====================================================================
  // FACE RECOGNITION ATTENDANCE — additive second attendance method.
  // Does not remove, replace, or change the behaviour of the manual
  // attendance routes above; it writes into the same `Attendance`
  // collection so every existing report/percentage/HOD/admin view keeps
  // working unchanged, just tagged `method: 'FACE_RECOGNITION'`.
  //
  // Every route below re-derives identity from req.user (the session
  // cookie) — nothing about who the student/faculty is, which section
  // they belong to, or whether a face-update request was approved is
  // ever trusted from the request body.
  // =====================================================================

  // ---- Student: face registration -------------------------------------

  app.get('/api/student/face/status', requireAuth, requireRole('student'), ah(async (req, res) => {
    const profile = await FaceProfiles.findOne({ student_username: req.user.username });
    const pending = await FaceUpdateRequests.findOne({ student_username: req.user.username, status: 'pending' });
    res.json(publicFaceStatus(profile, pending));
  }));

  // POST /api/student/face/register
  // Body: { descriptor: number[128] }
  // The descriptor is computed entirely client-side (face-api.js) after
  // the client has already walked the student through the guided
  // capture + blink-liveness check described in the frontend; the raw
  // face image never reaches this server. This endpoint only accepts a
  // FIRST-TIME registration, OR a registration that consumes a faculty-
  // approved, not-yet-consumed update request — never a raw overwrite.
  // Finds another student's ACTIVE face profile whose descriptor matches
  // `descriptor` within FACE_MATCH_THRESHOLD. `excludeUsername` is always
  // the caller's own username — a student's own current/previous
  // descriptor must never trigger their own duplicate check (item 6:
  // "Do NOT compare a student's face against their own existing
  // descriptor and incorrectly reject their legitimate update").
  // Global on purpose (no college_id/section_id filter): the requirement
  // is "across ALL student accounts", not just the caller's college, so
  // the same person cannot register as two different students even
  // across two different colleges in this system.
  async function findConflictingFaceProfile(descriptor, excludeUsername) {
    const candidates = await FaceProfiles.find({ status: 'active', student_username: { $ne: excludeUsername } }).toArray();
    for (const profile of candidates) {
      if (!isValidDescriptor(profile.descriptor)) continue; // defensive: never let a malformed stored row 500 the request
      const dist = euclideanDistance(descriptor, profile.descriptor);
      if (dist <= FACE_MATCH_THRESHOLD) return profile;
    }
    return null;
  }

  app.post('/api/student/face/register', requireAuth, requireRole('student'), ah(async (req, res) => {
    const { descriptor } = req.body || {};
    if (!isValidDescriptor(descriptor)) {
      return res.status(400).json({ error: 'A valid captured face is required. Please retry registration.' });
    }
    const existing = await FaceProfiles.findOne({ student_username: req.user.username });
    if (existing && existing.status === 'active') {
      return res.status(409).json({ error: 'Your face is already registered. Request a face update if you need to change it.' });
    }
    let consumedRequestId = null;
    if (existing && existing.status === 'invalidated') {
      // Re-registration after invalidation is only allowed through an
      // approved, unconsumed request — this is what makes the whole
      // approve → invalidate → re-register flow un-bypassable from the
      // frontend: there is no other path in this route that reaches here.
      const approved = await FaceUpdateRequests.findOne({ student_username: req.user.username, status: 'approved', consumed: false });
      if (!approved) {
        return res.status(403).json({ error: 'You need faculty approval before registering a new face. Request a face update first.' });
      }
      consumedRequestId = approved.id;
    }

    // Item 6: reject if this face descriptor already belongs to a DIFFERENT
    // student's active profile. Enforced here — server-side — regardless
    // of whatever the frontend already checked, per "Backend must enforce
    // this check too. Do NOT rely only on frontend validation."
    const conflict = await findConflictingFaceProfile(descriptor, req.user.username);
    if (conflict) {
      return res.status(409).json({ error: 'This face is already registered to another student.' });
    }

    const now = Date.now();
    await FaceProfiles.updateOne(
      { student_username: req.user.username },
      { $set: {
          id: existing ? existing.id : newId('face'),
          student_username: req.user.username, college_id: req.user.college_id, section_id: req.user.section_id,
          descriptor, status: 'active', registered_at: now, updated_at: now,
        } },
      { upsert: true }
    );

    // Race-condition guard (item 6: "Prevent race-condition duplicates
    // where two students register the same face nearly simultaneously").
    // Two concurrent requests can both pass the pre-write check above
    // before either has written. After our own write commits, re-run the
    // same check; if a genuine conflict now exists, deterministically
    // decide the winner by whichever profile was registered_at earlier —
    // the later writer loses and is rolled back, so at most one active
    // profile for a given face ever survives.
    const postWriteConflict = await findConflictingFaceProfile(descriptor, req.user.username);
    if (postWriteConflict && postWriteConflict.registered_at <= now) {
      if (existing) {
        // Restore exactly what was there before this request (upsert
        // above only ever touched status/descriptor/timestamps).
        await FaceProfiles.updateOne(
          { student_username: req.user.username },
          { $set: { descriptor: existing.descriptor, status: existing.status, registered_at: existing.registered_at, updated_at: existing.updated_at } }
        );
      } else {
        await FaceProfiles.deleteOne({ student_username: req.user.username });
      }
      return res.status(409).json({ error: 'This face is already registered to another student.' });
    }

    if (consumedRequestId) {
      await FaceUpdateRequests.updateOne({ id: consumedRequestId }, { $set: { consumed: true, consumed_at: now } });
    }
    res.status(201).json({ ok: true });
  }));

  // ---- Student: request a face update -----------------------------------

  app.post('/api/student/face/update-request', requireAuth, requireRole('student'), ah(async (req, res) => {
    const { reason } = req.body || {};
    const already = await FaceUpdateRequests.findOne({ student_username: req.user.username, status: 'pending' });
    if (already) return res.status(409).json({ error: 'You already have a pending face update request.' });
    const row = {
      id: newId('fur'), student_username: req.user.username, college_id: req.user.college_id, section_id: req.user.section_id,
      reason: String(reason || '').trim().slice(0, 500), status: 'pending', consumed: false,
      requested_at: Date.now(), decided_by: null, decided_at: null,
    };
    await FaceUpdateRequests.insertOne(row);
    res.status(201).json({ ok: true });
    const section = req.user.section_id ? await Sections.findOne({ id: req.user.section_id }) : null;
    if (section && section.faculty_username) {
      notifyUsers([section.faculty_username], {
        college_id: row.college_id, tab: 'attendance', type: 'face_update_requested',
        title: 'Face update request', message: `${req.user.name} requested to update their registered face.`, related_id: row.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  // ---- Faculty: review face-update requests -----------------------------
  // Scoped to sections the faculty member actually owns (req.user.section_ids),
  // the same scoping every other faculty-facing section route in this file uses.

  app.get('/api/faculty/face/update-requests', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const sectionIds = req.user.section_ids || [];
    const rows = await FaceUpdateRequests.find({ section_id: { $in: sectionIds } }).sort({ requested_at: -1 }).toArray();
    const usernames = [...new Set(rows.map(r => r.student_username))];
    const students = usernames.length ? await Users.find({ username: { $in: usernames } }, { projection: { password_hash: 0, _id: 0 } }).toArray() : [];
    const studentMap = Object.fromEntries(students.map(s => [s.username, s]));
    const sections = await Sections.find({ id: { $in: sectionIds } }).toArray();
    const sectionMap = Object.fromEntries(sections.map(s => [s.id, s]));
    const profiles = usernames.length ? await FaceProfiles.find({ student_username: { $in: usernames } }).toArray() : [];
    const profileMap = Object.fromEntries(profiles.map(p => [p.student_username, p]));
    res.json({
      requests: rows.map(r => {
        const student = studentMap[r.student_username];
        const section = sectionMap[r.section_id];
        const profile = profileMap[r.student_username];
        return {
          id: r.id, status: r.status, reason: r.reason, requested_at: r.requested_at, decided_at: r.decided_at,
          student_name: student ? student.name : r.student_username, student_username: r.student_username,
          roll_number: student ? student.roll_number : null, branch: student ? student.department : null,
          section_name: section ? section.name : null, year: section ? section.year : null,
          current_face_status: profile && profile.status === 'active' ? 'registered' : 'not_registered',
        };
      })
    });
  }));

  app.post('/api/faculty/face/update-requests/:id/approve', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const request = await FaceUpdateRequests.findOne({ id: req.params.id });
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    if (!(req.user.section_ids || []).includes(request.section_id)) return res.status(403).json({ error: 'Not your section.' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request has already been decided.' });
    await FaceUpdateRequests.updateOne({ id: request.id }, { $set: { status: 'approved', decided_by: req.user.username, decided_at: Date.now() } });
    // Invalidate the current face template immediately on approval — the
    // student cannot keep attending on their old face while a new one is
    // pending, and the invalidated row is what /register above requires
    // an approved, unconsumed request to overwrite.
    await FaceProfiles.updateOne({ student_username: request.student_username }, { $set: { status: 'invalidated', updated_at: Date.now() } });
    res.json({ ok: true });
    notifyUsers([request.student_username], {
      college_id: request.college_id, tab: 'attendance', type: 'face_update_decided',
      title: 'Face update approved', message: 'You can now register your new face.', related_id: request.id
    }).catch(err => console.error('notify failed', err));
  }));

  app.post('/api/faculty/face/update-requests/:id/reject', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const request = await FaceUpdateRequests.findOne({ id: req.params.id });
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    if (!(req.user.section_ids || []).includes(request.section_id)) return res.status(403).json({ error: 'Not your section.' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request has already been decided.' });
    await FaceUpdateRequests.updateOne({ id: request.id }, { $set: { status: 'rejected', decided_by: req.user.username, decided_at: Date.now() } });
    res.json({ ok: true });
    notifyUsers([request.student_username], {
      college_id: request.college_id, tab: 'attendance', type: 'face_update_decided',
      title: 'Face update rejected', message: 'Your face update request was rejected.', related_id: request.id
    }).catch(err => console.error('notify failed', err));
  }));

  // ---- Faculty: face recognition attendance sessions ---------------------
  // Mirrors the timetable-slot validation of POST /api/faculty/attendance
  // above exactly, so a face-recognition session can only ever be opened
  // for a slot the faculty member is actually scheduled to teach, and
  // never for an hour that's already locked by a prior submission
  // (manual OR face) for that section/date/hour.

  // NEW: also reachable by an HOD assigned as the teacher for a slot — same
  // timetable-ownership check as POST /api/faculty/attendance above.
  app.post('/api/faculty/attendance/face/session/start', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const { section_id, date, hour, subject_id } = req.body || {};
    if (!section_id || !date || !hour || !subject_id) return res.status(400).json({ error: 'Section, date, hour, and subject are required.' });
    const day = dayOfWeekFromDate(date);
    const slot = await findMyTimetableSlot(Timetable, { section_id, day, hour, username: req.user.username });
    if (!slot) return res.status(403).json({ error: 'You are not scheduled to teach this section at this hour, according to the timetable.' });
    if (slot.subject_id !== subject_id) return res.status(400).json({ error: 'That subject does not match the timetable for this hour.' });
    const existingAttendance = await Attendance.findOne({ section_id, date, hour: String(hour) });
    if (existingAttendance) return res.status(409).json({ error: 'Attendance for this hour has already been submitted and cannot be edited.' });
    const existingSession = await FaceAttendanceSessions.findOne({ section_id, date, hour: String(hour), status: 'active' });
    if (existingSession) return res.json({ session: stripId(existingSession) }); // resume rather than duplicate, e.g. after a page refresh

    // Eligible roster: students in this exact section only (item 9 —
    // "Registered Students Only" / never search the whole college).
    const row = {
      id: newId('fas'), section_id, college_id: req.user.college_id, date, hour: String(hour), subject_id,
      faculty_username: req.user.username, status: 'active', present_usernames: [], unknown_count: 0, created_at: Date.now(),
    };
    await FaceAttendanceSessions.insertOne(row);
    // Warms the /detect cache with the exact same query it would otherwise
    // run itself on the first tick — same data, one fewer round trip.
    const { roster, profiles } = await getFaceSessionRosterCached(row.id, req.user.college_id, section_id);
    const registeredUsernames = new Set(profiles.map(p => p.student_username));
    res.status(201).json({
      session: stripId(row),
      roster: roster.map(s => ({ username: s.username, name: s.name, roll_number: s.roll_number, face_registered: registeredUsernames.has(s.username) })),
    });
  }));

  // POST /api/faculty/attendance/face/session/:id/detect
  // Body: { faces: [{ descriptor: number[128] }], target_username? } — one
  // entry per face the client currently sees in the camera frame, each
  // already computed client-side. Matching happens here, server-side,
  // against this section's registered embeddings only; the embeddings
  // themselves are never sent back to the client, logged, or included in
  // any response — only names the faculty member can already see in their
  // own roster.
  // NEW: also reachable by an HOD — the session lookup below already keys
  // on `faculty_username: req.user.username`, so an HOD can only ever
  // drive detection for a session they themselves started.
  //
  // NEW: optional `target_username` switches this call into single-student
  // verification mode (item 2) — used by the "Verify" action next to one
  // student in the roster table instead of the bulk scan. This never
  // trusts the frontend's choice of target on its own: the target must
  // (a) actually belong to this exact session's section/eligibility set
  // and (b) have an active registered face, both re-checked here against
  // the database on every call, exactly like the bulk path already does
  // for every candidate. A frontend that tries to pass an arbitrary/
  // out-of-session username gets a 403 and nothing is matched or marked.
  app.post('/api/faculty/attendance/face/session/:id/detect', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const session = await FaceAttendanceSessions.findOne({ id: req.params.id, faculty_username: req.user.username });
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (session.status !== 'active') return res.status(409).json({ error: 'This session is no longer active.' });
    const faces = Array.isArray(req.body?.faces) ? req.body.faces : [];
    const validFaces = faces.filter(f => isValidDescriptor(f?.descriptor)).slice(0, 30); // sane per-frame cap
    const targetUsername = req.body?.target_username ? String(req.body.target_username) : null;

    const cached = await getFaceSessionRosterCached(session.id, req.user.college_id, session.section_id);
    const roster = cached.roster;
    const rosterUsernames = cached.rosterUsernames;
    let profiles = cached.profiles;
    const totalRegisteredInSession = profiles.length; // preserved even when narrowed to one target below

    let targetResult = null;
    if (targetUsername) {
      // Eligibility re-derived from the database, never trusted from the
      // request: the target must be in this exact session's roster (same
      // section the session was opened for) and have a registered face.
      if (!rosterUsernames.includes(targetUsername)) {
        return res.status(403).json({ error: 'That student is not part of this attendance session.' });
      }
      const targetProfile = profiles.find(p => p.student_username === targetUsername);
      if (!targetProfile) {
        return res.status(409).json({ error: 'That student does not have a registered face.' });
      }
      // Individual verification only ever compares against the ONE
      // targeted student's descriptor — never against the rest of the
      // roster — so a lookalike classmate in frame can't get the target
      // marked present, and the target's face can't accidentally mark
      // someone else present either.
      profiles = [targetProfile];
    }

    const alreadyPresent = new Set(session.present_usernames || []);
    let unknownThisCall = 0;
    let targetMatchedThisCall = false;
    for (const face of validFaces) {
      let best = null, bestDist = Infinity;
      for (const profile of profiles) {
        const dist = euclideanDistance(face.descriptor, profile.descriptor);
        if (dist < bestDist) { bestDist = dist; best = profile; }
      }
      if (best && bestDist <= FACE_MATCH_THRESHOLD) {
        alreadyPresent.add(best.student_username); // Set — duplicate matches across frames never double-count
        if (targetUsername && best.student_username === targetUsername) targetMatchedThisCall = true;
      } else if (!targetUsername) {
        // Unrecognized-face counting only applies to the bulk scan — in
        // single-student verification mode, a frame that isn't the target
        // is simply "not yet matched", not an "unknown face" event.
        unknownThisCall++;
      }
    }
    const newUnknownCount = (session.unknown_count || 0) + unknownThisCall;
    await FaceAttendanceSessions.updateOne({ id: session.id }, { $set: { present_usernames: [...alreadyPresent], unknown_count: newUnknownCount } });

    if (targetUsername) {
      const student = roster.find(s => s.username === targetUsername);
      targetResult = {
        username: targetUsername,
        name: student ? student.name : targetUsername,
        matched: targetMatchedThisCall || alreadyPresent.has(targetUsername),
      };
    }

    const studentMap = Object.fromEntries(roster.map(s => [s.username, s]));
    res.json({
      detected_this_frame: validFaces.length,
      present_count: alreadyPresent.size,
      unknown_count: newUnknownCount,
      present: [...alreadyPresent].map(u => studentMap[u] ? { username: u, name: studentMap[u].name, roll_number: studentMap[u].roll_number } : { username: u }),
      not_detected_count: Math.max(0, roster.length - alreadyPresent.size),
      total_registered: totalRegisteredInSession,
      total_students: roster.length,
      target_result: targetResult,
    });
  }));

  // NEW: also reachable by an HOD — same session-ownership scoping as /detect above.
  app.post('/api/faculty/attendance/face/session/:id/cancel', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const session = await FaceAttendanceSessions.findOne({ id: req.params.id, faculty_username: req.user.username });
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    await FaceAttendanceSessions.deleteOne({ id: session.id });
    invalidateFaceSessionRosterCache(session.id); // no longer polled — drop it now rather than waiting out the TTL
    res.json({ ok: true });
  }));

  // POST /api/faculty/attendance/face/session/:id/confirm
  // The only point at which a face-recognition session becomes a real,
  // permanent Attendance row — mirrors POST /api/faculty/attendance
  // above exactly (same lock semantics, same semester lookup, same
  // notify-on-marked behaviour), just sourced from the session's matched
  // set instead of a manually-submitted records array.
  // NEW: also reachable by an HOD — same session-ownership scoping as /detect above.
  app.post('/api/faculty/attendance/face/session/:id/confirm', requireAuth, requireRole('faculty', 'hod'), ah(async (req, res) => {
    const session = await FaceAttendanceSessions.findOne({ id: req.params.id, faculty_username: req.user.username });
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (session.status !== 'active') return res.status(409).json({ error: 'This session is no longer active.' });
    const existingAttendance = await Attendance.findOne({ section_id: session.section_id, date: session.date, hour: session.hour });
    if (existingAttendance) {
      await FaceAttendanceSessions.deleteOne({ id: session.id });
      return res.status(409).json({ error: 'Attendance for this hour has already been submitted and cannot be edited.' });
    }
    const roster = await Users.find({ role: 'student', college_id: req.user.college_id, section_id: session.section_id }, { projection: { username: 1, _id: 0 } }).toArray();
    const presentSet = new Set(session.present_usernames || []);
    const semester = await findSemesterForDate(req.user.college_id, req.user.department, session.date);
    const row = {
      section_id: session.section_id, college_id: session.college_id, date: session.date, hour: session.hour, subject_id: session.subject_id,
      semester_id: semester ? semester.id : null,
      records: roster.map(s => ({ student_username: s.username, present: presentSet.has(s.username) })),
      taken_by: req.user.username, taken_by_name: req.user.name, created_at: Date.now(), locked: true,
      method: 'FACE_RECOGNITION',
    };
    await Attendance.insertOne(row);
    await FaceAttendanceSessions.deleteOne({ id: session.id });
    invalidateFaceSessionRosterCache(session.id);
    res.json({ ok: true, present_count: presentSet.size, total_count: roster.length });
    notifyUsers([...presentSet], {
      college_id: row.college_id, tab: 'myattendance', type: 'attendance_marked',
      title: 'Attendance recorded', message: 'Attendance for hour ' + row.hour + ' on ' + row.date + ' has been recorded (face recognition).', related_id: row.section_id
    }).catch(err => console.error('notify failed', err));
  }));

  app.get('/api/student/marks', requireAuth, requireRole('student'), ah(async (req, res) => {
    const rows = await Marks.find({ section_id: req.user.section_id }).sort({ created_at: -1 }).toArray();
    const mine = rows.map(r => {
      const rec = r.records.find(x => x.student_username === req.user.username);
      return { test_name: r.test_name, max_score: r.max_score, score: rec ? rec.score : null, created_at: r.created_at };
    }).filter(r => r.score !== null);
    res.json({ marks: mine });
  }));

  // =====================================================================
  // ONLINE TESTS — a faculty member writes their own questions
  // (multiple-choice AND/OR theory/long-answer AND/OR code) and assigns
  // the test to one of their own sections, with an optional open/close
  // window and a time limit. Every student in that section gets exactly
  // one attempt. MCQ/code answers are auto-graded on submit; theory
  // answers sit "pending" until the faculty member grades them from the
  // results screen.
  //
  // AUTO-SUBMISSION IS TRIGGERED ONLY BY AN ACTUAL BROWSER TAB SWITCH.
  // Full-screen mode is entirely optional for the student — it is never
  // enforced, and entering/exiting it has no effect on the test. The
  // countdown timer reaching zero does not submit anything either; the
  // student stays in the test until they either manually click Submit
  // Exam and confirm, or switch away from the test's browser tab (Page
  // Visibility API — document.hidden), which the frontend submits
  // immediately and silently on. Mouse movement, clicks, scrolling,
  // Enter, Tab-to-indent inside the code editor, running/checking code,
  // compiler errors, resizing, and network blips never submit anything.
  // The /submit route below (both 'manual' and 'tab_switch' reasons) is
  // the only way a test is ever finalized.
  // =====================================================================
  // Generic "how many questions does this test have" for list/summary
  // views where no specific student is in scope (so there's nothing to
  // resolve a set against yet) — every set is expected to have a similar
  // question count, so the first set stands in as a representative count.
  function testQuestionCount(t) {
    return t.sets ? (t.sets[0]?.questions.length || 0) : t.questions.length;
  }
  function validateQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) return 'Add at least one question.';
    for (const q of questions) {
      if (!q || !q.text || !String(q.text).trim()) return 'Every question needs question text.';
      const type = q.type === 'theory' ? 'theory' : q.type === 'code' ? 'code' : 'mcq';
      if (type === 'mcq') {
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => !o || !String(o).trim())) return 'Every multiple-choice question needs at least 2 filled-in options.';
        if (typeof q.correct_index !== 'number' || q.correct_index < 0 || q.correct_index >= q.options.length) return 'Every multiple-choice question needs a valid correct option selected.';
      }
      if (type === 'code') {
        if (!CODE_LANGUAGES.includes(q.language)) return `Every code question needs a supported language (${CODE_LANGUAGES.join(', ')}).`;
        if (!Array.isArray(q.test_cases) || q.test_cases.length === 0) return 'Every code question needs at least one test case.';
        for (const tc of q.test_cases) {
          if (tc == null || tc.expected_output == null || !String(tc.expected_output).trim()) return 'Every test case needs an expected output.';
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Multiple Question Sets + random persistent assignment (items 19-26).
  //
  // A "sets" test stores `sets: [{ id, name, questions, total_marks,
  // has_theory, has_code }]` instead of a single top-level `questions`
  // array. `set_assignments: { [studentUsername]: setId }` is the
  // persisted student -> set mapping. Every other Test document (the
  // overwhelming majority, and every test created before this feature
  // existed) still has a plain `questions` array and no `sets` field at
  // all — resolveTestForStudent below is what the rest of the file's
  // student-facing/grading code calls instead of reading `test.questions`
  // directly, so a non-sets test behaves exactly as before with zero
  // changed behavior, and a sets test transparently gets the one
  // question set that specific student was (or now is) assigned.
  //
  // Fisher-Yates shuffle — genuinely random order, never roll-number/
  // alphabetical/insertion order (item 22).
  function shuffledCopy(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // Balanced round-robin distribution of a shuffled student list across N
  // sets (item 23) — e.g. 10 students / 3 sets -> 4/3/3, not lopsided.
  function assignStudentsToSets(usernames, setIds) {
    const shuffled = shuffledCopy(usernames);
    const assignments = {};
    shuffled.forEach((username, i) => { assignments[username] = setIds[i % setIds.length]; });
    return assignments;
  }
  // Resolves the ONE question set (or the plain `questions` array, for a
  // non-sets test) a specific student should see/be graded against.
  // Late joiners — a student added to the section/assignment list after
  // the test's initial assignment pass — get assigned now, to whichever
  // set currently has the fewest students, and it's persisted immediately
  // so it never changes again (items 24/25). Returns null only if a
  // sets-test somehow has zero sets (defensive; blocked at creation time).
  async function resolveTestForStudent(test, username) {
    if (!test.sets || !test.sets.length) {
      return { questions: test.questions, total_marks: test.total_marks, has_theory: test.has_theory, has_code: test.has_code, set_id: null, set_name: null };
    }
    let setId = test.set_assignments?.[username];
    if (!setId) {
      const counts = Object.fromEntries(test.sets.map(s => [s.id, 0]));
      for (const sid of Object.values(test.set_assignments || {})) if (counts[sid] != null) counts[sid]++;
      setId = test.sets.reduce((best, s) => (counts[s.id] < counts[best] ? s.id : best), test.sets[0].id);
      await Tests.updateOne({ id: test.id }, { $set: { [`set_assignments.${username}`]: setId } });
    }
    const set = test.sets.find(s => s.id === setId) || test.sets[0];
    return { questions: set.questions, total_marks: set.total_marks, has_theory: set.has_theory, has_code: set.has_code, set_id: set.id, set_name: set.name };
  }

  // ---------------------------------------------------------------------------
  // Code test judge — runs student-submitted source code against the test
  // cases the faculty member fixed when they created the question. Each test
  // case's input is piped to the program's stdin; stdout is trimmed and
  // compared to the trimmed expected output. Runs happen in a throwaway temp
  // directory with a hard timeout so one submission can't hang the server.
  //
  // Supports both interpreted languages (javascript, python) and compiled
  // ones (c, cpp, java). Compiled languages are compiled once per submission,
  // then the same binary/class is re-run for every test case.
  // ---------------------------------------------------------------------------
  const CODE_LANGUAGES = ['javascript', 'python', 'c', 'cpp', 'java'];
  const CODE_RUN_TIMEOUT_MS = 5000;
  const CODE_COMPILE_TIMEOUT_MS = 15000;
  const CODE_MAX_OUTPUT_BYTES = 64 * 1024;

  // ---------------------------------------------------------------------------
  // Online compiler (Judge0) — python/c/cpp/java submissions are compiled and
  // run on a remote Judge0 instance instead of a local toolchain. This means
  // the server needs no JDK, no MinGW/gcc, and no Python install of its own —
  // nothing to put on PATH, nothing to download into tools/.
  //
  // Default endpoint is https://ce.judge0.com — Judge0's own free public demo
  // instance, which works with no API key and no signup. It's a shared,
  // rate-limited community instance (fine for a class test module; it can get
  // slow/full under heavy simultaneous load). If that ever becomes a problem,
  // set these environment variables to point at a different Judge0 instance
  // instead of changing any code:
  //   JUDGE0_BASE_URL   e.g. https://judge0-ce.p.rapidapi.com  (a RapidAPI plan)
  //   JUDGE0_API_KEY    RapidAPI key, sent as X-RapidAPI-Key
  //   JUDGE0_API_HOST   RapidAPI host, sent as X-RapidAPI-Host
  //                     (defaults to the JUDGE0_BASE_URL's hostname)
  //   JUDGE0_AUTH_TOKEN Sent as X-Auth-Token, for a self-hosted instance that
  //                     has an auth token configured
  // Any Judge0-compatible server works — nothing here is RapidAPI-specific.
  // ---------------------------------------------------------------------------
  const JUDGE0_BASE_URL = (process.env.JUDGE0_BASE_URL || 'https://ce.judge0.com').replace(/\/+$/, '');
  const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY || '';
  const JUDGE0_API_HOST = process.env.JUDGE0_API_HOST || (JUDGE0_API_KEY ? new URL(JUDGE0_BASE_URL).hostname : '');
  const JUDGE0_AUTH_TOKEN = process.env.JUDGE0_AUTH_TOKEN || '';
  // JavaScript is intentionally routed through Judge0 too (id 63 = Node.js on
  // every Judge0 CE build; override with JUDGE0_JS_LANGUAGE_ID if a specific
  // instance offers a newer Node runtime under a different id). Student
  // JavaScript must NEVER be run with execFile(process.execPath, ...) against
  // the backend's own Node process again — that gave submitted code full
  // filesystem, network, and process.env access on the same host running the
  // application. Judge0 already isolates python/c/cpp/java in a disposable
  // sandboxed container with no access to this server's filesystem, env vars,
  // or MongoDB credentials, so sending JS through the same path closes the
  // hole without inventing a second isolation mechanism to maintain.
  const JUDGE0_LANGUAGE_IDS = {
    python: 71, c: 50, cpp: 54, java: 62,
    javascript: parseInt(process.env.JUDGE0_JS_LANGUAGE_ID, 10) || 63
  };
  // Judge0 status IDs: 1/2 queued/running (shouldn't see these with wait=true),
  // 3 accepted, 5 time limit exceeded, 6 compilation error. Everything else
  // (7-14) is a runtime signal (segfault, abort, internal error, etc).
  const JUDGE0_STATUS = { ACCEPTED: 3, TIME_LIMIT: 5, COMPILE_ERROR: 6 };

  function b64(str) { return Buffer.from(str == null ? '' : String(str), 'utf8').toString('base64'); }
  function unb64(str) { return str == null ? '' : Buffer.from(str, 'base64').toString('utf8'); }

  // Submits one program + one stdin to Judge0 and waits (synchronously, via
  // ?wait=true) for the result. Judge0 compiles the source fresh for every
  // submission — there's no persistent binary to reuse across test cases —
  // so runCodeAgainstTestCases() below short-circuits on a compile error
  // after the first call instead of resubmitting code that can't build.
  async function runOnJudge0(languageId, source, stdin, timeoutMs) {
    const headers = { 'Content-Type': 'application/json' };
    if (JUDGE0_API_KEY) {
      headers['X-RapidAPI-Key'] = JUDGE0_API_KEY;
      headers['X-RapidAPI-Host'] = JUDGE0_API_HOST;
    }
    if (JUDGE0_AUTH_TOKEN) headers['X-Auth-Token'] = JUDGE0_AUTH_TOKEN;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${JUDGE0_BASE_URL}/submissions?base64_encoded=true&wait=true`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          language_id: languageId,
          source_code: b64(source),
          stdin: b64(stdin),
          cpu_time_limit: Math.max(1, Math.round(CODE_RUN_TIMEOUT_MS / 1000)),
          wall_time_limit: Math.max(2, Math.round(timeoutMs / 1000))
        })
      });
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      return {
        error: timedOut
          ? 'Your code took too long to run (timed out).'
          : `Could not reach the online compiler (${JUDGE0_BASE_URL}). Check the server's internet connection, or set JUDGE0_BASE_URL to a reachable Judge0 instance.`
      };
    } finally {
      clearTimeout(abortTimer);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* ignore */ }
      return { error: `Online compiler request failed (HTTP ${res.status}). ${detail}`.trim() };
    }

    let data;
    try { data = await res.json(); } catch { return { error: 'Online compiler returned an unreadable response.' }; }

    const statusId = data.status && data.status.id;
    const compileOutput = unb64(data.compile_output).trim();
    if (statusId === JUDGE0_STATUS.COMPILE_ERROR) {
      return { error: `Compilation error:\n${(compileOutput || 'Unknown compilation error.').slice(0, 4000)}`, isCompileError: true };
    }
    if (statusId === JUDGE0_STATUS.TIME_LIMIT) {
      return { error: 'Your code took too long to run (timed out).' };
    }
    const stdout = unb64(data.stdout);
    if (statusId !== JUDGE0_STATUS.ACCEPTED) {
      const stderrText = unb64(data.stderr).trim();
      const desc = (data.status && data.status.description) || 'Runtime error';
      return { error: (stderrText || `${desc}.`).slice(0, 2000) };
    }
    return { stdout: stdout.slice(0, CODE_MAX_OUTPUT_BYTES) };
  }

  // Judge0 always compiles Java as Main.java, so the submitted source's
  // public class must be named "Main". We rename it (and matching
  // whole-word references, e.g. a constructor call) rather than forcing
  // every faculty member's starter code to hardcode that name.
  function rewriteJavaClassNameForJudge0(source) {
    const original = detectJavaPublicClassName(source);
    if (!original || original === 'Main') return source;
    return source.replace(new RegExp(`\\b${original}\\b`, 'g'), 'Main');
  }

  function detectJavaPublicClassName(source) {
    const publicMatch = source.match(/public\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (publicMatch) return publicMatch[1];
    const anyMatch = source.match(/\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (anyMatch) return anyMatch[1];
    return 'Main';
  }

  // Prepares everything needed to run a submission and returns a `run(input)`
  // function to execute against each test case's stdin. Every supported
  // language — including javascript — is sent to Judge0's isolated,
  // disposable containers (see runOnJudge0 above). No student-submitted code
  // of any language is ever executed with this server's own Node/OS
  // privileges: no host filesystem, no application source, no .env, no
  // MongoDB credentials, no backend environment variables, and no ability to
  // spawn processes on the machine running Campus Orbis.
  function prepareSubmission(language, source, dir) {
    if (language === 'python' || language === 'c' || language === 'cpp' || language === 'java' || language === 'javascript') {
      const languageId = JUDGE0_LANGUAGE_IDS[language];
      const preparedSource = language === 'java' ? rewriteJavaClassNameForJudge0(source) : source;
      return { run: (input) => runOnJudge0(languageId, preparedSource, input, CODE_RUN_TIMEOUT_MS + CODE_COMPILE_TIMEOUT_MS) };
    }

    return { error: 'Unsupported language.' };
  }

  async function runCodeAgainstTestCases(language, source, testCases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-orbis-code-'));
    try {
      const prepared = prepareSubmission(language, source, dir);
      if (prepared.error) {
        const results = testCases.map(tc => ({
          input: tc.input || '', expected_output: String(tc.expected_output || '').trim(),
          actual_output: '', error: prepared.error, passed: false
        }));
        return { results, all_passed: false };
      }
      const results = [];
      if (testCases.length > 0) {
        const firstTc = testCases[0];
        const expected0 = String(firstTc.expected_output || '').trim();
        const res0 = await prepared.run(firstTc.input || '').catch(err => ({ error: err?.message || 'Execution timed out' }));
        const actual0 = (res0.stdout || '').trim();
        const passed0 = !res0.error && actual0 === expected0;
        results.push({ input: firstTc.input || '', expected_output: expected0, actual_output: res0.error ? '' : actual0, error: res0.error || null, passed: passed0 });
        if (res0.isCompileError) {
          for (let i = 1; i < testCases.length; i++) {
            results.push({ input: testCases[i].input || '', expected_output: String(testCases[i].expected_output || '').trim(), actual_output: '', error: res0.error, passed: false });
          }
          return { results, all_passed: false };
        }
        if (testCases.length > 1) {
          const rest = await Promise.all(
            testCases.slice(1).map(async (tc) => {
              const expected = String(tc.expected_output || '').trim();
              const res = await prepared.run(tc.input || '').catch(err => ({ error: err?.message || 'Execution timed out' }));
              const actual = (res.stdout || '').trim();
              const passed = !res.error && actual === expected;
              return { input: tc.input || '', expected_output: expected, actual_output: res.error ? '' : actual, error: res.error || null, passed };
            })
          );
          results.push(...rest);
        }
      }
      return { results, all_passed: results.every(r => r.passed) };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }
  // ---------------------------------------------------------------------------
  // Leaderboard scoring — a student earns 2 points for every question they
  // got right (MCQ/code — "correct" is a pass/fail concept; theory answers
  // are hand-graded on marks separately and don't feed this points formula).
  // Wrong answers are worth 0. This is computed from the stored per-answer
  // `correct` flags every time (rather than trusted purely from a cached
  // field) so it stays correct even for submissions written before this
  // field existed.
  // ---------------------------------------------------------------------------
  function computeSubmissionStats(sub) {
    let correct = 0, wrong = 0;
    for (const a of sub.answers || []) {
      if (a.type === 'mcq' || a.type === 'code') {
        if (a.correct) correct++; else wrong++;
      }
    }
    const points = correct * CORRECT_ANSWER_POINTS;
    return { correct, wrong, points };
  }

  // ---------------------------------------------------------------------------
  // Time-based test scoring (item 1). Points come from three parts:
  //   1. Attempt/join points — a flat JOIN_POINTS for having actually
  //      started the test (a TestJoins row exists).
  //   2. Correct-answer points — CORRECT_ANSWER_POINTS per correct MCQ/code
  //      answer (see computeSubmissionStats above).
  //   3. Remaining-time points — the leftover time on the clock at the
  //      moment of submission, expressed as MM.SS (e.g. 40 minutes 30
  //      seconds left -> 40.30 points), NOT a fraction of a minute. This is
  //      the exact convention from the spec's own examples, so it is kept
  //      even though it isn't standard decimal-minutes.
  // Remaining time is always derived from server timestamps only (the join
  // anchor and the submit time), never trusted from the client, and is
  // floored to whole seconds before splitting into minutes/seconds so a
  // network delay can't be gamed into extra fractional points.
  // `durationSeconds` is the student's own individual duration for this
  // test (test.duration_minutes * 60) — remaining time is capped at 0 and
  // never exceeds that duration.
  // ---------------------------------------------------------------------------
  const JOIN_POINTS = 2;
  const CORRECT_ANSWER_POINTS = 2;

  function remainingTimeBreakdown(durationSeconds, elapsedSeconds) {
    const remainingSeconds = Math.max(0, Math.min(durationSeconds, durationSeconds - Math.max(0, Math.floor(elapsedSeconds))));
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    // MM.SS convention per spec — NOT minutes + seconds/60.
    const points = Math.round((minutes + seconds / 100) * 100) / 100;
    return { remainingSeconds, minutes, seconds, points };
  }

  // Strips trailing zeros for a clean display value (52.30 -> 52.3, 52.00 -> 52).
  function cleanDecimal(n) {
    return Math.round(n * 100) / 100;
  }

  // Full breakdown for one test submission: join points + correct-answer
  // points + remaining-time points, all derived from server-side data only
  // (joinedAt and submittedAt are both server timestamps).
  function computeTestScore({ test, gradedAnswers, joinedAt, submittedAt }) {
    const { correct, wrong, points: correctPoints } = computeSubmissionStats({ answers: gradedAnswers });
    // Remaining-time points are scaled by accuracy: a student only earns the
    // full remaining-time value when every scored (MCQ/code) question is
    // correct. Getting half right earns half the remaining-time points, and
    // so on — Remaining Time Points = Remaining Time x (Correct / Total).
    // Theory answers are hand-graded separately and aren't part of this
    // ratio's denominator. A submission with zero scored questions (e.g. an
    // all-theory test) falls back to 0 accuracy so no remaining-time points
    // are awarded rather than dividing by zero.
    const totalScored = correct + wrong;
    const accuracyRatio = totalScored > 0 ? correct / totalScored : 0;
    const durationSeconds = test.duration_minutes * 60;
    const elapsedSeconds = joinedAt != null ? (submittedAt - joinedAt) / 1000 : durationSeconds;
    const { remainingSeconds, minutes: remMinutes, seconds: remSeconds, points: fullTimePoints } = remainingTimeBreakdown(durationSeconds, elapsedSeconds);
    const timePoints = cleanDecimal(fullTimePoints * accuracyRatio);
    const joinPoints = joinedAt != null ? JOIN_POINTS : 0;
    const finalPoints = cleanDecimal(joinPoints + correctPoints + timePoints);
    return {
      correct, wrong, correct_points: correctPoints, join_points: joinPoints,
      time_taken_seconds: joinedAt != null ? Math.max(0, Math.round((submittedAt - joinedAt) / 1000)) : null,
      remaining_seconds: remainingSeconds, remaining_minutes: remMinutes, remaining_time_extra_seconds: remSeconds,
      time_points: timePoints, final_points: finalPoints
    };
  }

  // ---------------------------------------------------------------------------
  // Central point-ledger writer (item 20). Every module that awards points
  // should go through this instead of writing scores directly, so every
  // award is separately auditable and duplicate-proof. `source` is a short
  // category key ('TEST', 'ATTENDANCE', 'COMPETITION', 'ASSIGNMENT',
  // 'OTHER', or any future module's own key) and `reference_id` identifies
  // the specific event that earned the points (a submission id, an
  // attendance record id, etc). Calling this twice with the same
  // (student_username, source, reference_id) is a safe no-op — the unique
  // index on PointTransactions catches the duplicate and this function
  // swallows that specific error, so retried requests, duplicate
  // auto-submits, or a resumed rejoin can never double-award points.
  // ---------------------------------------------------------------------------
  async function awardPoints({ student_username, college_id, source, points, reference_id, description }) {
    try {
      await PointTransactions.insertOne({
        id: newId('ptx'), student_username, college_id, source, points,
        reference_id, description: description || '', created_at: Date.now()
      });
      return true;
    } catch (e) {
      if (e.code === 11000) return false; // already awarded — idempotent no-op
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Test removal + points decision (Test Removal item). Shared by both the
  // faculty-owned Tests routes and the HOD-owned Tests routes below, so the
  // exact same deletion/points semantics apply no matter who created the
  // test.
  //
  // `removePoints: true`  (Option A — Remove Test + Remove Points)
  //   Deletes the test, every submission/attempt made against it, and every
  //   point-ledger (PointTransactions) row that a submission to this test
  //   ever produced. Because the Main Leaderboard is always computed live
  //   from PointTransactions (see buildLeaderboard above), removing those
  //   rows is all that's needed for totals/ranks to reflect the change on
  //   the very next leaderboard read — there is no separate cached total to
  //   "recalculate".
  //
  // `removePoints: false` (Option B — Remove Test Only + Keep Points)
  //   Deletes the test itself (so it disappears from every test list and
  //   its per-test leaderboard/results screens become inaccessible, since
  //   those all 404 once `Tests.findOne` can't find it), but intentionally
  //   leaves TestSubmissions and PointTransactions untouched — those rows
  //   are what the Main Leaderboard's test-points total is built from, so
  //   leaving them alone is what "keep the points" means. They become
  //   independent historical records (no longer reachable by test id from
  //   the UI, but still summed into the ledger).
  //
  // Either way, all transient/operational rows that only matter while the
  // test is live (joins, in-progress autosave, rejoin requests, monitoring
  // streams/files, and code-run attempts) are always removed — none of
  // those represent "points" and keeping them around after the test is
  // gone would only be clutter, never a leaderboard total.
  //
  // This MongoDB deployment runs as a standalone instance (see
  // MONGODB_URI default), not a replica set, so multi-document ACID
  // transactions (session.withTransaction) aren't available here. Instead,
  // this performs the deletions in a deliberate, safe order: every
  // dependent/transient collection is cleared first, and the Tests
  // document itself is deleted LAST. If anything throws partway through,
  // the test row still exists (so nothing is silently left half-deleted
  // from the user's point of view — the test just didn't disappear yet)
  // and the whole operation can be safely retried, since every step here
  // (deleteMany / deleteOne / GridFS delete) is idempotent.
  async function deleteTestCascade(test, { removePoints }) {
    const testId = test.id;

    // Always-removed: transient/operational data with no bearing on points.
    await TestJoins.deleteMany({ test_id: testId });
    await CodeAttempts.deleteMany({ test_id: testId });
    await TestProgress.deleteMany({ test_id: testId });
    await TestRejoinRequests.deleteMany({ test_id: testId });
    await TestActivity.deleteMany({ test_id: testId });
    const monRows = await TestMonitoringStreams.find({ test_id: testId }).toArray();
    await Promise.all(monRows.map(r => (r.file_id ? monitoringBucket.delete(new ObjectId(r.file_id)).catch(() => {}) : null)));
    await TestMonitoringStreams.deleteMany({ test_id: testId });

    if (removePoints) {
      // Option A — remove the points this test generated, everywhere.
      const subs = await TestSubmissions.find({ test_id: testId }, { projection: { id: 1, _id: 0 } }).toArray();
      const submissionIds = subs.map(s => s.id);
      if (submissionIds.length) {
        // Remove exactly the ledger rows this test's submissions produced
        // (source: 'TEST', reference_id: submission id) — never touches a
        // point transaction from any other test or module.
        await PointTransactions.deleteMany({ source: 'TEST', reference_id: { $in: submissionIds } });
      }
      await TestSubmissions.deleteMany({ test_id: testId });
    }
    // Option B — removePoints === false: TestSubmissions and
    // PointTransactions are deliberately left untouched so existing
    // historical points are never accidentally deleted.

    // The test row itself is always removed last, once every dependent
    // cleanup above has completed successfully.
    await Tests.deleteOne({ id: testId });
  }

  // Formats a millisecond duration as "Hh Mm Ss" (omitting leading zero
  // units), or null-safe "—" when no value is available.
  function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return null;
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts = [];
    if (h) parts.push(h + 'h');
    if (h || m) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
  }

  // Item 8 assignment gating, re-checked at every action endpoint — not
  // just the GET the frontend happens to call first. A specific student
  // selection (assigned_student_usernames) must be enforced everywhere a
  // student could act on a test, or a direct API request (bypassing the
  // UI entirely) could join/submit/run code on a test they were never
  // assigned, using only their own valid section membership.
  function isAssignedToTest(test, username) {
    return !test.assigned_student_usernames || test.assigned_student_usernames.includes(username);
  }

  function testWindowStatus(test) {
    const now = Date.now();
    if (test.start_time && now < new Date(test.start_time).getTime()) return 'upcoming';
    if (test.end_time && now > new Date(test.end_time).getTime()) return 'closed';
    return 'open';
  }

  // UPDATED: Timer adjustment based on actual join time. A student who
  // opens the test late doesn't get the full duration — the clock is
  // anchored to the later of (a) the test's scheduled start_time, or (b)
  // the moment this particular student first opened it, and every
  // subsequent load recomputes "duration minus time elapsed since that
  // anchor" rather than resetting to the full duration. Example: a 4:00–
  // 5:00 PM, 60-minute test opened by a student at 4:20 PM anchors at
  // 4:20 PM and hands them 40 minutes, not 60.
  async function getOrCreateJoinAnchor(test, username) {
    const existing = await TestJoins.findOne({ test_id: test.id, student_username: username });
    if (existing) return existing.joined_at;
    const scheduledStart = test.start_time ? new Date(test.start_time).getTime() : null;
    const now = Date.now();
    // 'range' scheduling (Fixed Date Range + Individual Duration) is the one
    // mode where every student gets their own full duration counted from the
    // moment THEY actually start — never reduced by how much of the
    // availability window has already elapsed. So the anchor is always "now",
    // regardless of the scheduled start. The availability window itself is
    // still enforced separately (test.end_time, checked below and via
    // testWindowStatus), so a student starting late still can't run past the
    // window's ending date/time — see secondsLeftFor.
    if (test.schedule_mode === 'range') {
      const anchor = now;
      try {
        await TestJoins.insertOne({ id: newId('tjoin'), test_id: test.id, student_username: username, joined_at: anchor });
      } catch (e) {
        if (e.code !== 11000) throw e;
        const row = await TestJoins.findOne({ test_id: test.id, student_username: username });
        return row ? row.joined_at : anchor;
      }
      return anchor;
    }
    // If the test has a fixed scheduled start and it has already begun,
    // anchor to that scheduled start (so latecomers lose the minutes that
    // already elapsed). Otherwise anchor to right now, the moment they
    // actually joined.
    const anchor = scheduledStart && scheduledStart <= now ? scheduledStart : now;
    try {
      await TestJoins.insertOne({ id: newId('tjoin'), test_id: test.id, student_username: username, joined_at: anchor });
    } catch (e) {
      if (e.code !== 11000) throw e; // race: someone else inserted it first — fall through and re-read
      const row = await TestJoins.findOne({ test_id: test.id, student_username: username });
      return row ? row.joined_at : anchor;
    }
    return anchor;
  }
  // The student's remaining time is always the SMALLER of (a) their own
  // individual duration counted down from their join anchor, and (b) the
  // time left until the test's overall availability window closes
  // (test.end_time) — so the ending-date boundary always has final say, even
  // for a student who joined with plenty of individual duration left. For
  // the pre-existing 'window'/'duration' modes this cap is a no-op (their
  // join anchor is already pinned to the scheduled start, so both limits
  // land on the same moment); it only changes behavior for 'range' tests,
  // where the join anchor is the student's own actual start time.
  function secondsLeftFor(test, joinedAt) {
    const elapsedSeconds = Math.floor((Date.now() - joinedAt) / 1000);
    const byOwnDuration = test.duration_minutes * 60 - elapsedSeconds;
    const windowEndMs = test.end_time ? new Date(test.end_time).getTime() : null;
    const byWindowEnd = windowEndMs ? Math.floor((windowEndMs - Date.now()) / 1000) : Infinity;
    return Math.max(0, Math.min(byOwnDuration, byWindowEnd));
  }

  app.post('/api/faculty/tests', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { title, subject, section_id, duration_minutes, start_time, end_time, questions, published, assign_mode, assigned_student_usernames } = req.body || {};
    // schedule_mode is metadata only (for display) — every scheduling option
    // resolves to the same start_time/end_time/duration_minutes fields
    // below, so test availability and the /submit and /leaderboard logic
    // elsewhere never need to know which UI the faculty used.
    // 'window'   -> Option A: faculty picked an explicit start + end time.
    // 'duration' -> Option B: faculty picked a date + a duration preset;
    //               the client computes the matching end_time before
    //               sending it here, same as Option A.
    // 'range'    -> Option C: Fixed Date Range + Individual Test Duration.
    //               Faculty picks a starting date/time, an ending date, and
    //               a duration. Unlike A/B, duration here is NOT derived
    //               from the start/end window — the window only controls
    //               when students may start; each student who starts gets
    //               the full configured duration individually, capped by
    //               the window's end (see getOrCreateJoinAnchor/secondsLeftFor).
    const scheduleMode = req.body?.schedule_mode === 'duration' ? 'duration' : req.body?.schedule_mode === 'range' ? 'range' : 'window';
    if (!title || !title.trim() || !section_id) return res.status(400).json({ error: 'Title and section are required.' });
    // Backend enforcement of section-based test assignment (item 5/7):
    // a faculty member may only create — and later manage — tests for a
    // section they are actually assigned to, never any other section.
    if (!(req.user.section_ids || []).includes(section_id)) return res.status(403).json({ error: 'You can only create tests for your own section.' });
    // Multiple Question Sets (items 19-26). `sets` — an array of
    // { name, questions } — is mutually exclusive with the plain
    // `questions` field above: a test is either a normal single-question-
    // list test (existing behavior, completely unchanged) or a sets test.
    const rawSets = Array.isArray(req.body?.sets) ? req.body.sets : null;
    if (rawSets) {
      if (rawSets.length < 2) return res.status(400).json({ error: 'Add at least 2 sets, or remove Sets mode and use a single question list.' });
      for (const s of rawSets) {
        if (!s || !s.name || !String(s.name).trim()) return res.status(400).json({ error: 'Every set needs a name.' });
        const err = validateQuestions(s.questions);
        if (err) return res.status(400).json({ error: `Set "${s.name}": ${err}` });
      }
    } else {
      const qErr = validateQuestions(questions);
      if (qErr) return res.status(400).json({ error: qErr });
    }
    // Student Selection / Test Assignment (item 8). Defaults to "All
    // Students" (assigned_student_usernames: null) — every eligible student
    // in the section sees the test. If specific students are selected,
    // each username is validated to actually belong to this section before
    // being stored, so a faculty member can never assign a test to a
    // student outside their own section by guessing a username.
    let resolvedAssignedUsernames = null;
    if (assign_mode === 'selected' && Array.isArray(assigned_student_usernames) && assigned_student_usernames.length) {
      const candidates = await Users.find(
        { college_id: req.user.college_id, role: 'student', section_id, username: { $in: assigned_student_usernames } },
        { projection: { username: 1, _id: 0 } }
      ).toArray();
      resolvedAssignedUsernames = candidates.map(c => c.username);
      if (!resolvedAssignedUsernames.length) return res.status(400).json({ error: 'None of the selected students belong to this section.' });
    }
    let resolvedDuration = Number(duration_minutes) > 0 ? Number(duration_minutes) : 20;
    if (scheduleMode === 'range') {
      // Availability window (starting date/time -> ending date/time) and the
      // per-student duration are independent here — the window is never used
      // to derive the duration, and the duration is never used to derive
      // the window. Both must be given and the window must be well-formed.
      if (!start_time || !end_time) return res.status(400).json({ error: 'Starting date/time and ending date are required.' });
      const startMs = new Date(start_time).getTime();
      const endMs = new Date(end_time).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return res.status(400).json({ error: 'Invalid start or end date/time.' });
      if (endMs <= startMs) return res.status(400).json({ error: 'Ending date/time must be after the starting date/time.' });
      if (!(Number(duration_minutes) > 0)) return res.status(400).json({ error: 'Choose a test duration.' });
      resolvedDuration = Number(duration_minutes);
    } else if (start_time && end_time) {
      // Duration is derived from the start/end window when both are given —
      // faculty picks a start and end time (e.g. 3:00 PM → 4:00 PM) and the
      // duration (60 minutes) is computed here rather than trusted from the
      // client, so it can never drift out of sync with the window.
      const startMs = new Date(start_time).getTime();
      const endMs = new Date(end_time).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return res.status(400).json({ error: 'Invalid start or end time.' });
      if (endMs <= startMs) return res.status(400).json({ error: 'End time must be after start time.' });
      resolvedDuration = Math.round((endMs - startMs) / 60000);
    }
    // Builds one cleaned question list — used for both the plain-questions
    // path and each individual set, so a set's questions go through
    // exactly the same cleaning/validation shape as before.
    const cleanQuestionList = (qs) => qs.map((q, i) => {
      const type = q.type === 'theory' ? 'theory' : q.type === 'code' ? 'code' : 'mcq';
      const base = { id: newId('q'), order: i, type, text: String(q.text).trim(), marks: Number(q.marks) > 0 ? Number(q.marks) : 1 };
      if (type === 'mcq') return { ...base, options: q.options.map(o => String(o).trim()), correct_index: q.correct_index };
      if (type === 'code') {
        return {
          ...base,
          language: q.language,
          starter_code: (q.starter_code || '').slice(0, 4000),
          test_cases: q.test_cases.map(tc => ({ input: String(tc.input || '').slice(0, 4000), expected_output: String(tc.expected_output).trim().slice(0, 4000) }))
        };
      }
      return base;
    });

    let questionsField = null, setsField = null, setAssignmentsField = null;
    let totalMarksField, hasTheoryField, hasCodeField;

    if (rawSets) {
      const cleanSets = rawSets.map(s => {
        const qs = cleanQuestionList(s.questions);
        return {
          id: newId('set'), name: String(s.name).trim(), questions: qs,
          total_marks: qs.reduce((sum, q) => sum + q.marks, 0),
          has_theory: qs.some(q => q.type === 'theory'), has_code: qs.some(q => q.type === 'code'),
        };
      });
      setsField = cleanSets;
      // Generic display fallback for any place that shows a single
      // total_marks/has_theory/has_code for the test as a whole (e.g. a
      // faculty test list) before any per-student resolution happens —
      // union across sets so nothing under-reports.
      totalMarksField = Math.max(...cleanSets.map(s => s.total_marks));
      hasTheoryField = cleanSets.some(s => s.has_theory);
      hasCodeField = cleanSets.some(s => s.has_code);
      // Random, balanced, persistent assignment (items 21-24) — computed
      // once, right now, over exactly the eligible student list (the
      // specific selection if assign_mode is 'selected', otherwise every
      // student currently in the section). Never roll-number/alphabetical/
      // insertion order (item 22): shuffledCopy uses Fisher-Yates.
      const eligibleUsernames = resolvedAssignedUsernames
        || (await Users.find({ college_id: req.user.college_id, role: 'student', section_id }, { projection: { username: 1, _id: 0 } }).toArray()).map(s => s.username);
      setAssignmentsField = assignStudentsToSets(eligibleUsernames, cleanSets.map(s => s.id));
    } else {
      const cleanQuestions = cleanQuestionList(questions);
      questionsField = cleanQuestions;
      totalMarksField = cleanQuestions.reduce((s, q) => s + q.marks, 0);
      hasTheoryField = cleanQuestions.some(q => q.type === 'theory');
      hasCodeField = cleanQuestions.some(q => q.type === 'code');
    }

    const row = {
      id: newId('test'), title: String(title).trim(), subject: (subject || 'General').trim(),
      section_id, college_id: req.user.college_id, created_by: req.user.username, created_by_name: req.user.name,
      duration_minutes: resolvedDuration, schedule_mode: scheduleMode,
      start_time: start_time || null, end_time: end_time || null,
      // Explicit, stored type label ('normal' | 'set') for display/filtering.
      // Purely descriptive — every actual behavior branch (resolution,
      // scoring, leaderboard, validation) still keys off `sets` presence,
      // exactly as before, so this can never itself cause a mismatch.
      type: rawSets ? 'set' : 'normal',
      questions: questionsField, sets: setsField, set_assignments: setAssignmentsField,
      total_marks: totalMarksField, has_theory: hasTheoryField, has_code: hasCodeField, created_at: Date.now(),
      // Item 6/8: publish state and student assignment. `published`
      // defaults true (this app has always made a created test visible
      // immediately — publishing is opt-in-to-hide, not opt-in-to-show, so
      // no existing test's visibility changes). `assigned_student_usernames`
      // null means "All Students" (the default per item 8).
      published: published !== false, assigned_student_usernames: resolvedAssignedUsernames,
      // Item 7: once any student joins, content becomes locked regardless
      // of clock time (guards a faculty member editing mid-attempt even if
      // start_time was left blank). edited_at tracks the last permitted edit.
      edited_at: null
    };
    await Tests.insertOne(row);
    res.status(201).json({ test: { ...stripId(row), status: testWindowStatus(row), question_count: testQuestionCount(row) } });
    Users.find({ college_id: row.college_id, role: 'student', section_id: row.section_id }, { projection: { username: 1, _id: 0 } }).toArray()
      .then(students => {
        // Only notify students the test is actually assigned to (item 8) —
        // "All Students" (null) notifies everyone in the section, same as
        // before; a specific selection notifies only those students.
        const targetUsernames = row.assigned_student_usernames
          ? students.map(s => s.username).filter(u => row.assigned_student_usernames.includes(u))
          : students.map(s => s.username);
        return notifyUsers(targetUsernames, {
          college_id: row.college_id, tab: 'tests', type: 'test_added',
          title: 'New test: ' + row.title, message: row.created_by_name + ' assigned a new test in ' + row.subject + '.', related_id: row.id
        });
      })
      .catch(err => console.error('notify failed', err));
  }));

  app.get('/api/faculty/tests', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const rows = await Tests.find({ created_by: req.user.username }).sort({ created_at: -1 }).toArray();
    const withCounts = await Promise.all(rows.map(async r => {
      const [submissions, joinCount, rejoinPending] = await Promise.all([
        TestSubmissions.find({ test_id: r.id }).toArray(),
        TestJoins.countDocuments({ test_id: r.id }),
        TestRejoinRequests.countDocuments({ test_id: r.id, status: 'pending' })
      ]);
      const status = testWindowStatus(r);
      // Item 6/7: faculty-facing test metadata — creation time, remaining
      // time before start, whether content/assignment can still be edited
      // (locked the instant anyone has joined, or once the window is no
      // longer 'upcoming' — whichever comes first), and how many students
      // it's assigned to (null = "All Students").
      const secondsToStart = r.start_time ? Math.max(0, Math.round((new Date(r.start_time).getTime() - Date.now()) / 1000)) : null;
      const editable = status === 'upcoming' && joinCount === 0;
      return {
        ...stripId(r), status, question_count: testQuestionCount(r),
        submission_count: submissions.length, pending_grading_count: submissions.filter(s => !s.fully_graded).length,
        seconds_to_start: secondsToStart, joined_count: joinCount, editable, assignment_locked: !editable,
        assigned_count: r.assigned_student_usernames ? r.assigned_student_usernames.length : null,
        pending_rejoin_count: rejoinPending
      };
    }));
    res.json({ tests: withCounts });
  }));

  app.get('/api/faculty/tests/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const submissions = await TestSubmissions.find({ test_id: req.params.id }).sort({ score: -1 }).toArray();
    // Every code run is logged, accepted or not, so faculty can see when a
    // student attempted a code question even if they never solved it.
    const codeAttempts = test.has_code
      ? await CodeAttempts.find({ test_id: req.params.id }).sort({ attempted_at: -1 }).toArray()
      : [];
    // Tab/page-switch monitoring log (item 4) — every recorded event for
    // this test, newest first, plus a per-student occurrence count so
    // faculty can see totals at a glance. This is read-only reporting;
    // recording an event never affected the student's submission.
    const activity = await TestActivity.find({ test_id: req.params.id }).sort({ occurred_at: -1 }).toArray();
    const activityCounts = {};
    for (const a of activity) activityCounts[a.student_username] = (activityCounts[a.student_username] || 0) + 1;
    const joinCount = await TestJoins.countDocuments({ test_id: req.params.id });
    const status = testWindowStatus(test);
    const secondsToStart = test.start_time ? Math.max(0, Math.round((new Date(test.start_time).getTime() - Date.now()) / 1000)) : null;
    const editable = status === 'upcoming' && joinCount === 0;
    // item 26: Faculty Set Assignment View — every eligible student's
    // assigned set (name, not just id), plus their score/roll number if
    // they've submitted, so faculty can verify the automatic distribution
    // at a glance. Only present for a sets test; omitted entirely
    // otherwise so existing test-detail consumers see no shape change.
    let setAssignments = null;
    if (test.sets) {
      const usernames = Object.keys(test.set_assignments || {});
      const students = usernames.length
        ? await Users.find({ username: { $in: usernames } }, { projection: { username: 1, name: 1, roll_number: 1, _id: 0 } }).toArray()
        : [];
      const studentByUsername = Object.fromEntries(students.map(s => [s.username, s]));
      const submissionByUsername = Object.fromEntries(submissions.map(s => [s.student_username, s]));
      const setNameById = Object.fromEntries(test.sets.map(s => [s.id, s.name]));
      setAssignments = usernames.map(username => ({
        username, name: studentByUsername[username]?.name || username, roll_number: studentByUsername[username]?.roll_number || '',
        set_id: test.set_assignments[username], set_name: setNameById[test.set_assignments[username]] || null,
        score: submissionByUsername[username]?.score ?? null, submitted: !!submissionByUsername[username],
      }));
    }
    // Every submission is enriched with the SPECIFIC set (name/marks/
    // questions) that student was assigned — a sets test has no single
    // correct "total_marks" to show next to a score (each set can differ),
    // and `data.test.questions` is null for a sets test, so the frontend's
    // code-attempts lookup (matching a CodeAttempt to its question text)
    // needs each submission's own resolved question list too.
    const enrichedSubmissions = await Promise.all(submissions.map(async (s) => {
      const effective = await resolveTestForStudent(test, s.student_username);
      return { ...stripId(s), total_marks: effective.total_marks, set_name: effective.set_name, questions: effective.questions };
    }));
    // Same reasoning for code attempts: a sets test has no single
    // `data.test.questions` to look a question's text up in, so each
    // attempt gets its own resolved question_text directly.
    const enrichedCodeAttempts = await Promise.all(codeAttempts.map(async (a) => {
      const effective = await resolveTestForStudent(test, a.student_username);
      const q = effective.questions.find(qq => qq.id === a.question_id);
      return { ...stripId(a), question_text: q?.text || 'Code question' };
    }));
    res.json({
      test: { ...stripId(test), status, seconds_to_start: secondsToStart, joined_count: joinCount, editable, assignment_locked: !editable },
      submissions: enrichedSubmissions, code_attempts: enrichedCodeAttempts,
      activity_log: activity.map(stripId), activity_counts: activityCounts, set_assignments: setAssignments
    });
  }));

  // Test Editing Rules (item 7). Editable only while the test is
  // 'upcoming' (hasn't started) AND no student has joined yet — the
  // moment either condition fails, content (questions/duration/start-end)
  // is locked server-side regardless of what the frontend sends. Student
  // assignment follows the same lock (item 8: "Once the test starts...
  // Student selection should also become locked").
  app.put('/api/faculty/tests/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const joinCount = await TestJoins.countDocuments({ test_id: req.params.id });
    const status = testWindowStatus(test);
    if (status !== 'upcoming' || joinCount > 0) {
      return res.status(409).json({ error: 'This test has already started (or a student has joined) — it can no longer be edited.' });
    }
    const { title, subject, duration_minutes, start_time, end_time, questions, published, assign_mode, assigned_student_usernames, section_id } = req.body || {};
    const update = { edited_at: Date.now() };
    // Item 7: "Edit assigned departments/years/sections" — a Section in
    // this app already IS the department+year+section unit, so this is
    // the equivalent of moving the test to a different section this
    // faculty member teaches. Only ever allowed pre-join (guarded above),
    // and only into a section this faculty member actually owns — the
    // exact same rule applied at test creation.
    if (section_id != null && section_id !== test.section_id) {
      if (!(req.user.section_ids || []).includes(section_id)) return res.status(403).json({ error: 'You can only move this test to one of your own sections.' });
      update.section_id = section_id;
      // Moving sections invalidates any specific student selection made
      // against the old section's roster — fall back to "All Students" in
      // the new section rather than silently keeping stale usernames.
      if (assign_mode !== 'selected') update.assigned_student_usernames = null;
    }
    if (title != null) {
      if (!String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
      update.title = String(title).trim();
    }
    if (subject != null) update.subject = String(subject).trim() || 'General';
    if (published != null) update.published = !!published;
    if (Array.isArray(questions)) {
      const qErr = validateQuestions(questions);
      if (qErr) return res.status(400).json({ error: qErr });
      const cleanQuestions = questions.map((q, i) => {
        const type = q.type === 'theory' ? 'theory' : q.type === 'code' ? 'code' : 'mcq';
        const base = { id: newId('q'), order: i, type, text: String(q.text).trim(), marks: Number(q.marks) > 0 ? Number(q.marks) : 1 };
        if (type === 'mcq') return { ...base, options: q.options.map(o => String(o).trim()), correct_index: q.correct_index };
        if (type === 'code') {
          return {
            ...base, language: q.language, starter_code: (q.starter_code || '').slice(0, 4000),
            test_cases: q.test_cases.map(tc => ({ input: String(tc.input || '').slice(0, 4000), expected_output: String(tc.expected_output).trim().slice(0, 4000) }))
          };
        }
        return base;
      });
      update.questions = cleanQuestions;
      update.sets = null; update.set_assignments = null; // switching back to a plain question list drops any prior sets
      update.type = 'normal';
      update.total_marks = cleanQuestions.reduce((s, q) => s + q.marks, 0);
      update.has_theory = cleanQuestions.some(q => q.type === 'theory');
      update.has_code = cleanQuestions.some(q => q.type === 'code');
    } else if (Array.isArray(req.body?.sets)) {
      // items 19/21: editing a test's sets — allowed only pre-join (guarded
      // by the same check at the top of this route), matching "Remove sets
      // before publishing." A change here always recomputes the random
      // assignment from scratch: since no student has joined yet, there is
      // no existing persisted assignment to disturb (the "never regenerate"
      // rule in items 21-25 only starts to matter once assignment could
      // actually be in use, i.e. after a student opens the test).
      const rawSets = req.body.sets;
      if (rawSets.length < 2) return res.status(400).json({ error: 'Add at least 2 sets, or remove Sets mode and use a single question list.' });
      for (const s of rawSets) {
        if (!s || !s.name || !String(s.name).trim()) return res.status(400).json({ error: 'Every set needs a name.' });
        const err = validateQuestions(s.questions);
        if (err) return res.status(400).json({ error: `Set "${s.name}": ${err}` });
      }
      const cleanSets = rawSets.map(s => {
        const qs = s.questions.map((q, i) => {
          const type = q.type === 'theory' ? 'theory' : q.type === 'code' ? 'code' : 'mcq';
          const base = { id: newId('q'), order: i, type, text: String(q.text).trim(), marks: Number(q.marks) > 0 ? Number(q.marks) : 1 };
          if (type === 'mcq') return { ...base, options: q.options.map(o => String(o).trim()), correct_index: q.correct_index };
          if (type === 'code') {
            return {
              ...base, language: q.language, starter_code: (q.starter_code || '').slice(0, 4000),
              test_cases: q.test_cases.map(tc => ({ input: String(tc.input || '').slice(0, 4000), expected_output: String(tc.expected_output).trim().slice(0, 4000) }))
            };
          }
          return base;
        });
        return {
          id: newId('set'), name: String(s.name).trim(), questions: qs,
          total_marks: qs.reduce((sum, q) => sum + q.marks, 0),
          has_theory: qs.some(q => q.type === 'theory'), has_code: qs.some(q => q.type === 'code'),
        };
      });
      update.questions = null;
      update.sets = cleanSets;
      update.type = 'set';
      update.total_marks = Math.max(...cleanSets.map(s => s.total_marks));
      update.has_theory = cleanSets.some(s => s.has_theory);
      update.has_code = cleanSets.some(s => s.has_code);
      const targetSectionId = update.section_id || test.section_id;
      const targetAssigned = assign_mode === 'selected' && Array.isArray(assigned_student_usernames) ? assigned_student_usernames
        : (assign_mode === 'all' ? null : (update.assigned_student_usernames !== undefined ? update.assigned_student_usernames : test.assigned_student_usernames));
      const eligibleUsernames = targetAssigned
        || (await Users.find({ college_id: req.user.college_id, role: 'student', section_id: targetSectionId }, { projection: { username: 1, _id: 0 } }).toArray()).map(s => s.username);
      update.set_assignments = assignStudentsToSets(eligibleUsernames, cleanSets.map(s => s.id));
    }
    if (Number(duration_minutes) > 0) update.duration_minutes = Number(duration_minutes);
    if (start_time !== undefined && end_time !== undefined && start_time && end_time) {
      const startMs = new Date(start_time).getTime();
      const endMs = new Date(end_time).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return res.status(400).json({ error: 'Invalid start or end time.' });
      if (endMs <= startMs) return res.status(400).json({ error: 'End time must be after start time.' });
      update.start_time = start_time;
      update.end_time = end_time;
      if (test.schedule_mode !== 'range' && !(Number(duration_minutes) > 0)) update.duration_minutes = Math.round((endMs - startMs) / 60000);
    }
    if (assign_mode === 'all') {
      update.assigned_student_usernames = null;
    } else if (assign_mode === 'selected' && Array.isArray(assigned_student_usernames)) {
      const targetSectionId = update.section_id || test.section_id;
      const candidates = await Users.find(
        { college_id: req.user.college_id, role: 'student', section_id: targetSectionId, username: { $in: assigned_student_usernames } },
        { projection: { username: 1, _id: 0 } }
      ).toArray();
      update.assigned_student_usernames = candidates.map(c => c.username);
    }
    await Tests.updateOne({ id: req.params.id }, { $set: update });
    const updated = await Tests.findOne({ id: req.params.id });
    res.json({ test: { ...stripId(updated), status: testWindowStatus(updated) } });
  }));

  // Test Removal + Points Decision. The caller MUST explicitly choose
  // between the two options — there is no implicit default — because
  // silently picking one on the faculty member's behalf is exactly the
  // kind of accidental data loss (or accidental point retention) this
  // confirmation step exists to prevent. Body: { remove_points: boolean }.
  app.delete('/api/faculty/tests/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const { remove_points } = req.body || {};
    if (typeof remove_points !== 'boolean') {
      return res.status(400).json({ error: 'Choose whether to also remove points earned from this test (remove_points: true or false).' });
    }
    try {
      await deleteTestCascade(test, { removePoints: remove_points });
    } catch (e) {
      console.error('test deletion failed', e);
      return res.status(500).json({ error: 'Could not delete this test. Nothing was changed — please try again.' });
    }
    res.json({ ok: true, points_removed: remove_points });
  }));

  // Faculty/HOD Test Monitoring (item 13) — live per-student status for
  // one test: currently writing (joined, no submission, within window),
  // submitted, auto-submitted, or not started, plus remaining time and
  // pending rejoin-request counts. Polled by the monitoring screen.
  async function buildTestLiveStatus(test) {
    const [joins, subs, rejoinCounts] = await Promise.all([
      TestJoins.find({ test_id: test.id }).toArray(),
      TestSubmissions.find({ test_id: test.id }).toArray(),
      TestRejoinRequests.find({ test_id: test.id }).toArray()
    ]);
    const subByUser = Object.fromEntries(subs.map(s => [s.student_username, s]));
    const rejoinByUser = {};
    for (const r of rejoinCounts) {
      if (!rejoinByUser[r.student_username]) rejoinByUser[r.student_username] = { total: 0, pending: 0 };
      rejoinByUser[r.student_username].total += 1;
      if (r.status === 'pending') rejoinByUser[r.student_username].pending += 1;
    }
    return joins.map(j => {
      const sub = subByUser[j.student_username];
      const secondsLeft = sub ? 0 : secondsLeftFor(test, j.joined_at);
      return {
        student_username: j.student_username, joined_at: j.joined_at,
        status: sub ? (sub.submission_reason === 'tab_switch' ? 'auto_submitted' : 'submitted') : (secondsLeft > 0 ? 'writing' : 'time_up'),
        seconds_left: secondsLeft, submitted_at: sub ? sub.submitted_at : null,
        rejoin_requests: rejoinByUser[j.student_username] || { total: 0, pending: 0 }
      };
    });
  }
  app.get('/api/faculty/tests/:id/live-status', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    res.json({ students: await buildTestLiveStatus(test) });
  }));
  // HOD gets the same live-status view for any test in their department
  // (their existing GET /api/hod/tests below is already department-scoped).
  app.get('/api/hod/tests/:id/live-status', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    const section = await Sections.findOne({ id: test.section_id });
    if (!section || section.department !== req.user.department) return res.status(403).json({ error: 'Not in your department.' });
    res.json({ students: await buildTestLiveStatus(test) });
  }));

  // Faculty grades any theory (long-answer) questions in one submission.
  // Body: { scores: { [question_id]: number } } — one entry per theory question.
  app.post('/api/faculty/tests/:id/submissions/:subId/grade', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const sub = await TestSubmissions.findOne({ id: req.params.subId, test_id: req.params.id });
    if (!sub) return res.status(404).json({ error: 'Not found.' });
    const { scores } = req.body || {};
    if (!scores || typeof scores !== 'object') return res.status(400).json({ error: 'Provide a score for each theory answer.' });
    const effective = await resolveTestForStudent(test, sub.student_username);
    const qById = Object.fromEntries(effective.questions.map(q => [q.id, q]));
    const updatedAnswers = sub.answers.map(a => {
      if (a.type !== 'theory') return a;
      const q = qById[a.question_id];
      if (!(a.question_id in scores) || !q) return a;
      const clamped = Math.max(0, Math.min(q.marks, Number(scores[a.question_id]) || 0));
      return { ...a, score: clamped };
    });
    const fullyGraded = updatedAnswers.every(a => a.type !== 'theory' || typeof a.score === 'number');
    const totalScore = updatedAnswers.reduce((s, a) => s + (typeof a.score === 'number' ? a.score : 0), 0);
    await TestSubmissions.updateOne({ id: req.params.subId }, { $set: { answers: updatedAnswers, score: totalScore, fully_graded: fullyGraded } });
    res.json({ ok: true, score: totalScore, fully_graded: fullyGraded });
    if (fullyGraded) {
      notifyUsers([sub.student_username], {
        college_id: test.college_id, tab: 'tests', type: 'test_graded',
        title: 'Test graded: ' + test.title, message: 'Your test has been fully graded. Score: ' + totalScore + '/' + effective.total_marks + '.', related_id: test.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  app.get('/api/faculty/tests/:id/results.csv', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const submissions = await TestSubmissions.find({ test_id: req.params.id }).sort({ score: -1 }).toArray();
    const escCsv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    // item 26: Set column, and Total Marks is resolved per-student since a
    // sets test can have a different total per set.
    const header = test.sets ? 'Name,Username,Set,Score,Total Marks,Fully Graded,Submission Reason,Submitted At' : 'Name,Username,Score,Total Marks,Fully Graded,Submission Reason,Submitted At';
    const lines = [header];
    for (const s of submissions) {
      const effective = await resolveTestForStudent(test, s.student_username);
      const row = test.sets
        ? [escCsv(s.student_name), escCsv(s.student_username), escCsv(effective.set_name), escCsv(s.score), escCsv(effective.total_marks)]
        : [escCsv(s.student_name), escCsv(s.student_username), escCsv(s.score), escCsv(effective.total_marks)];
      lines.push([
        ...row,
        escCsv(s.fully_graded ? 'Yes' : 'No'), escCsv(s.submission_reason === 'tab_switch' ? 'Tab Switch' : 'Manual'),
        escCsv(new Date(s.submitted_at).toISOString())
      ].join(','));
    }
    const safeFileName = test.title.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'test';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}-results.csv"`);
    res.send(lines.join('\r\n'));
  }));

  // ---------------------------------------------------------------------------
  // Saved Tests — reusable question-paper templates. Independent of the
  // Conducted Test (Tests) lifecycle: a SavedTests row is never deleted,
  // modified, or otherwise touched as a side effect of anything that
  // happens to a Conducted Test (delete, edit, results, etc.), and vice
  // versa. "Use Again" only ever reads a SavedTests row to prefill a brand
  // new Conducted Test — it never mutates the SavedTests row, and it never
  // copies student attempts/results/monitoring data (those don't exist on
  // a template in the first place).
  // ---------------------------------------------------------------------------
  function cleanSavedQuestions(questions) {
    return questions.map((q, i) => {
      const type = q.type === 'theory' ? 'theory' : q.type === 'code' ? 'code' : 'mcq';
      const base = { id: newId('q'), order: i, type, text: String(q.text).trim(), marks: Number(q.marks) > 0 ? Number(q.marks) : 1 };
      if (type === 'mcq') return { ...base, options: q.options.map(o => String(o).trim()), correct_index: q.correct_index };
      if (type === 'code') {
        return {
          ...base,
          language: q.language,
          starter_code: (q.starter_code || '').slice(0, 4000),
          test_cases: q.test_cases.map(tc => ({ input: String(tc.input || '').slice(0, 4000), expected_output: String(tc.expected_output).trim().slice(0, 4000) }))
        };
      }
      return base;
    });
  }

  function savedTestSummary(row) {
    return {
      ...stripId(row), question_count: testQuestionCount(row),
    };
  }

  // Body is either:
  //   { source_test_id }  — "Save Test" on an already-conducted test: snapshot
  //     its current question paper/settings into a brand new template.
  //   { title, subject, description, duration_minutes, questions }  — "Save
  //     Test" straight out of the create/edit test form, before or after
  //     publishing.
  // Either way this NEVER touches the Tests/TestSubmissions collections —
  // it only ever writes a new, independent SavedTests row.
  // `client_token` is optional: if the same token is sent twice (e.g. a
  // duplicate click before the first request finished), the second call
  // returns the already-created row instead of inserting a second one.
  app.post('/api/faculty/saved-tests', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { source_test_id, title, subject, description, duration_minutes, questions, client_token } = req.body || {};

    if (client_token) {
      const existing = await SavedTests.findOne({ faculty_username: req.user.username, client_token });
      if (existing) return res.status(200).json({ saved_test: savedTestSummary(existing), deduped: true });
    }

    let row;
    if (source_test_id) {
      const test = await Tests.findOne({ id: source_test_id });
      if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Test not found.' });
      row = {
        id: newId('savedtest'), faculty_username: req.user.username, college_id: req.user.college_id,
        title: test.title, subject: test.subject, description: description || '',
        duration_minutes: test.duration_minutes, schedule_mode: test.schedule_mode,
        questions: test.questions, sets: test.sets || null, total_marks: test.total_marks,
        has_theory: test.has_theory, has_code: test.has_code,
        source_test_id: test.id, client_token: client_token || null,
        created_at: Date.now(), updated_at: Date.now(),
      };
    } else {
      if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
      const qErr = validateQuestions(questions);
      if (qErr) return res.status(400).json({ error: qErr });
      const cleanQuestions = cleanSavedQuestions(questions);
      row = {
        id: newId('savedtest'), faculty_username: req.user.username, college_id: req.user.college_id,
        title: String(title).trim(), subject: (subject || 'General').trim(), description: description || '',
        duration_minutes: Number(duration_minutes) > 0 ? Number(duration_minutes) : 20, schedule_mode: 'window',
        questions: cleanQuestions, total_marks: cleanQuestions.reduce((s, q) => s + q.marks, 0),
        has_theory: cleanQuestions.some(q => q.type === 'theory'), has_code: cleanQuestions.some(q => q.type === 'code'),
        source_test_id: null, client_token: client_token || null,
        created_at: Date.now(), updated_at: Date.now(),
      };
    }
    await SavedTests.insertOne(row);
    res.status(201).json({ saved_test: savedTestSummary(row) });
  }));

  app.get('/api/faculty/saved-tests', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const rows = await SavedTests.find({ faculty_username: req.user.username }).sort({ updated_at: -1 }).toArray();
    res.json({ saved_tests: rows.map(savedTestSummary) });
  }));

  // Full detail — used both to open the Edit form and to prefill "Use Again".
  app.get('/api/faculty/saved-tests/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const row = await SavedTests.findOne({ id: req.params.id });
    if (!row || row.faculty_username !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    res.json({ saved_test: savedTestSummary(row) });
  }));

  app.put('/api/faculty/saved-tests/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const row = await SavedTests.findOne({ id: req.params.id });
    if (!row || row.faculty_username !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const { title, subject, description, duration_minutes, questions } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
    // items 19-26: a saved template can itself be a sets test (see
    // saveTestTemplate copying `sets` alongside `questions`), so editing it
    // has to accept either shape, same as the live-test PUT routes.
    const rawSets = Array.isArray(req.body?.sets) ? req.body.sets : null;
    let update;
    if (rawSets) {
      if (rawSets.length < 2) return res.status(400).json({ error: 'Add at least 2 sets, or remove Sets mode and use a single question list.' });
      for (const s of rawSets) {
        if (!s || !s.name || !String(s.name).trim()) return res.status(400).json({ error: 'Every set needs a name.' });
        const err = validateQuestions(s.questions);
        if (err) return res.status(400).json({ error: `Set "${s.name}": ${err}` });
      }
      const cleanSets = rawSets.map(s => {
        const qs = cleanSavedQuestions(s.questions);
        return {
          id: newId('set'), name: String(s.name).trim(), questions: qs,
          total_marks: qs.reduce((sum, q) => sum + q.marks, 0),
          has_theory: qs.some(q => q.type === 'theory'), has_code: qs.some(q => q.type === 'code'),
        };
      });
      update = {
        title: String(title).trim(), subject: (subject || 'General').trim(), description: description || '',
        duration_minutes: Number(duration_minutes) > 0 ? Number(duration_minutes) : row.duration_minutes,
        questions: null, sets: cleanSets,
        total_marks: Math.max(...cleanSets.map(s => s.total_marks)),
        has_theory: cleanSets.some(s => s.has_theory), has_code: cleanSets.some(s => s.has_code),
        updated_at: Date.now(),
      };
    } else {
      const qErr = validateQuestions(questions);
      if (qErr) return res.status(400).json({ error: qErr });
      // Editing a Saved Test only ever rewrites this template row — it never
      // reaches into any Conducted Test that was previously created from it,
      // so tests already run from the old version are completely unaffected.
      const cleanQuestions = cleanSavedQuestions(questions);
      update = {
        title: String(title).trim(), subject: (subject || 'General').trim(), description: description || '',
        duration_minutes: Number(duration_minutes) > 0 ? Number(duration_minutes) : row.duration_minutes,
        questions: cleanQuestions, sets: null,
        total_marks: cleanQuestions.reduce((s, q) => s + q.marks, 0),
        has_theory: cleanQuestions.some(q => q.type === 'theory'), has_code: cleanQuestions.some(q => q.type === 'code'),
        updated_at: Date.now(),
      };
    }
    await SavedTests.updateOne({ id: req.params.id }, { $set: update });
    res.json({ saved_test: savedTestSummary({ ...row, ...update }) });
  }));

  // Deleting a Saved Test only ever removes this template row. It never
  // touches Tests, TestSubmissions, CodeAttempts, or any other Conducted
  // Test data — even a Conducted Test that was originally created via
  // "Use Again" from this exact template keeps its own independent copy of
  // the question paper (Tests.questions), so it's completely unaffected.
  app.delete('/api/faculty/saved-tests/:id', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const row = await SavedTests.findOne({ id: req.params.id });
    if (!row || row.faculty_username !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    await SavedTests.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // ---------- Student side: browse + attempt ----------
  app.get('/api/student/tests', requireAuth, requireRole('student'), ah(async (req, res) => {
    const rows = await Tests.find({ section_id: req.user.section_id, published: { $ne: false } }).sort({ created_at: -1 }).toArray();
    // Item 8: a test with a specific student selection only appears for
    // those students — "All Students" (assigned_student_usernames: null)
    // still appears for everyone in the section, exactly as before.
    const visible = rows.filter(r => !r.assigned_student_usernames || r.assigned_student_usernames.includes(req.user.username));
    const subs = await TestSubmissions.find({ student_username: req.user.username, test_id: { $in: visible.map(r => r.id) } }).toArray();
    const subByTest = Object.fromEntries(subs.map(s => [s.test_id, s]));
    res.json({ tests: visible.map(r => {
      const sub = subByTest[r.id];
      return {
        id: r.id, title: r.title, subject: r.subject, created_by_name: r.created_by_name,
        duration_minutes: r.duration_minutes, start_time: r.start_time, end_time: r.end_time,
        question_count: testQuestionCount(r), total_marks: r.total_marks, has_theory: !!r.has_theory, has_code: !!r.has_code, created_at: r.created_at,
        status: testWindowStatus(r), submitted: !!sub, score: sub ? sub.score : null, fully_graded: sub ? sub.fully_graded : null,
        submission_reason: sub ? (sub.submission_reason || 'manual') : null
      };
    }) });
  }));

  // Serializes a question for the student, omitting answer-key fields
  // (correct_index for MCQ) unless the student has already submitted.
  function serializeQuestionForStudent(q, revealAnswers) {
    const base = { id: q.id, type: q.type, text: q.text, marks: q.marks };
    if (q.type === 'mcq') return { ...base, options: q.options || null, correct_index: revealAnswers ? q.correct_index : null };
    if (q.type === 'code') return { ...base, language: q.language, starter_code: q.starter_code || '', test_cases: q.test_cases || [] };
    return base;
  }

  const MAX_REJOIN_REQUESTS = 20;

  app.get('/api/student/tests/:id', requireAuth, requireRole('student'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id, published: { $ne: false } });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (test.assigned_student_usernames && !test.assigned_student_usernames.includes(req.user.username)) {
      return res.status(403).json({ error: 'This test is not assigned to you.' });
    }
    let sub = await TestSubmissions.findOne({ test_id: req.params.id, student_username: req.user.username });

    // Test Rejoin / Session Resume (items 9/10). If this student's prior
    // submission was superseded by an accepted-but-not-yet-consumed rejoin
    // request, treat them as not-yet-submitted: the old submission and its
    // TEST ledger entry are removed (so nothing double-counts once they
    // submit again) and the rejoin request is marked consumed. This never
    // creates a duplicate fresh attempt — the student's saved answers
    // (TestProgress, below) still carry over.
    if (sub) {
      const acceptedRejoin = await TestRejoinRequests.findOne({
        test_id: req.params.id, student_username: req.user.username, status: 'accepted', resumed: { $ne: true }
      });
      if (acceptedRejoin) {
        await PointTransactions.deleteOne({ student_username: req.user.username, source: 'TEST', reference_id: sub.id });
        await TestSubmissions.deleteOne({ id: sub.id });
        await TestRejoinRequests.updateOne({ id: acceptedRejoin.id }, { $set: { resumed: true, resumed_at: Date.now() } });
        // Fresh anchor for the resumed attempt, capped to whatever time the
        // student had left at the moment they were disconnected/submitted —
        // never more, so a rejoin can't be used to claim extra time.
        const grantSeconds = typeof sub.remaining_seconds === 'number' ? sub.remaining_seconds : test.duration_minutes * 60;
        await TestJoins.deleteOne({ test_id: req.params.id, student_username: req.user.username });
        await TestJoins.insertOne({
          id: newId('tjoin'), test_id: test.id, student_username: req.user.username,
          joined_at: Date.now() - (test.duration_minutes * 60 - grantSeconds) * 1000
        });
        sub = null;
      }
    }

    if (sub) {
      // Already attempted — show questions with correct answers (for MCQ) + the student's own answers for review.
      const effective = await resolveTestForStudent(test, req.user.username);
      return res.json({
        test: { id: test.id, title: test.title, subject: test.subject, total_marks: effective.total_marks,
          questions: effective.questions.map(q => serializeQuestionForStudent(q, true)) },
        submission: stripId(sub)
      });
    }
    const status = testWindowStatus(test);
    if (status !== 'open') return res.status(403).json({ error: status === 'upcoming' ? 'This test has not opened yet.' : 'This test window has closed.' });
    // Not yet attempted, and open — send questions WITHOUT the correct answer.
    // The join anchor is created on first open and reused on every reload,
    // so refreshing the page never grants extra time.
    const hadJoinBefore = !!(await TestJoins.findOne({ test_id: test.id, student_username: req.user.username }));
    const joinedAt = await getOrCreateJoinAnchor(test, req.user.username);
    const secondsLeft = secondsLeftFor(test, joinedAt);
    if (secondsLeft <= 0) return res.status(403).json({ error: 'This test window has closed.' });
    if (!hadJoinBefore) {
      // Only broadcast on the actual first join, not on every page reload
      // once already joined — a faculty monitoring panel doesn't need a
      // "writing" ping every time a student's tab refreshes.
      broadcastToRoom(`test_live:${test.id}`, { type: 'test_status', student_username: req.user.username, status: 'writing' });
    }
    // Test Session Persistence (item 5/10) — restore any autosaved
    // in-progress answers so a refresh, a dropped connection, or a full
    // logout/login mid-test picks back up exactly where the student left
    // off instead of starting blank.
    const progress = await TestProgress.findOne({ test_id: req.params.id, student_username: req.user.username });
    const rejoinCount = await TestRejoinRequests.countDocuments({ test_id: req.params.id, student_username: req.user.username });
    // items 21-25: the student's genuinely-random, balanced, persistent set
    // assignment (or the plain question list, for a non-sets test) is
    // resolved here and only here for a fresh attempt — this is the one
    // place a student's set is ever decided, and it's never re-decided on
    // a later call (resolveTestForStudent reuses/persists the existing
    // assignment). There is no way for the client to request a different
    // set: no set_id parameter is accepted anywhere in this route.
    const effective = await resolveTestForStudent(test, req.user.username);
    res.json({
      test: { id: test.id, title: test.title, subject: test.subject, duration_minutes: test.duration_minutes, total_marks: effective.total_marks,
        questions: effective.questions.map(q => serializeQuestionForStudent(q, false)) },
      submission: null, seconds_left: secondsLeft,
      saved_progress: progress ? { answers: progress.answers, current_question_index: progress.current_question_index } : null,
      rejoin_requests_used: rejoinCount, rejoin_requests_max: MAX_REJOIN_REQUESTS
    });
  }));

  // Test Session Persistence (item 5/10) — periodic autosave of in-progress
  // answers + which question the student is on. Upserted, and only allowed
  // while the student has actually joined and hasn't submitted yet, so it
  // can never be used to tamper with a finished attempt.
  app.put('/api/student/tests/:id/progress', requireAuth, requireRole('student'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (!isAssignedToTest(test, req.user.username)) return res.status(403).json({ error: 'This test is not assigned to you.' });
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (!join) return res.status(403).json({ error: 'You have not started this test.' });
    const already = await TestSubmissions.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (already) return res.status(409).json({ error: 'You have already submitted this test.' });
    const { answers, current_question_index } = req.body || {};
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an array.' });
    const effective = await resolveTestForStudent(test, req.user.username);
    await TestProgress.updateOne(
      { test_id: req.params.id, student_username: req.user.username },
      { $set: {
        test_id: req.params.id, student_username: req.user.username,
        answers: answers.slice(0, effective.questions.length),
        current_question_index: Number.isInteger(current_question_index) ? current_question_index : 0,
        updated_at: Date.now()
      } },
      { upsert: true }
    );
    res.json({ ok: true });
  }));

  // Test Rejoin Request System (item 9). A student who submitted normally,
  // was auto-submitted (tab switch), or otherwise left the test can ask
  // their faculty to let them back in. Capped at MAX_REJOIN_REQUESTS per
  // (test, student); every request — accepted, rejected, or still pending
  // — counts toward that cap. All requests are logged and never deleted.
  app.post('/api/student/tests/:id/rejoin-requests', requireAuth, requireRole('student'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (!isAssignedToTest(test, req.user.username)) return res.status(403).json({ error: 'This test is not assigned to you.' });
    const sub = await TestSubmissions.findOne({ test_id: req.params.id, student_username: req.user.username });
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (!sub && !join) return res.status(400).json({ error: 'You have not attempted this test.' });
    const count = await TestRejoinRequests.countDocuments({ test_id: req.params.id, student_username: req.user.username });
    if (count >= MAX_REJOIN_REQUESTS) {
      return res.status(429).json({ error: `You have reached the maximum of ${MAX_REJOIN_REQUESTS} rejoin requests for this test.` });
    }
    const alreadyPending = await TestRejoinRequests.findOne({ test_id: req.params.id, student_username: req.user.username, status: 'pending' });
    if (alreadyPending) return res.status(409).json({ error: 'You already have a pending rejoin request for this test.' });
    const row = {
      id: newId('rejoin'), test_id: test.id, test_title: test.title, student_username: req.user.username, student_name: req.user.name,
      reason: String((req.body || {}).reason || '').slice(0, 500), status: 'pending', resumed: false,
      requested_at: Date.now(), decided_at: null, decided_by: null
    };
    await TestRejoinRequests.insertOne(row);
    res.status(201).json({ rejoin_request: stripId(row), requests_used: count + 1, requests_max: MAX_REJOIN_REQUESTS });
    broadcastToRoom(`test_rejoin:${test.id}`, { type: 'rejoin_requested', test_id: test.id });
    notifyUsers([test.created_by], {
      college_id: test.college_id, tab: 'tests', type: 'test_rejoin_requested',
      title: 'Rejoin request: ' + test.title,
      message: `${req.user.name} is requesting to rejoin "${test.title}".`,
      related_id: test.id
    }).catch(err => console.error('notify failed', err));
  }));

  // Faculty view of rejoin requests for one of their own tests.
  app.get('/api/faculty/tests/:id/rejoin-requests', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const rows = await TestRejoinRequests.find({ test_id: req.params.id }).sort({ requested_at: -1 }).toArray();
    res.json({ rejoin_requests: rows.map(stripId) });
  }));

  // Faculty accept/reject on a rejoin request. Accepting doesn't touch
  // the student's data itself — it just flips status to 'accepted', which
  // GET /api/student/tests/:id (above) checks on the student's next load
  // to actually perform the resume. This keeps the resume logic in one
  // place and makes it safe even if the student doesn't come back for a
  // while after being accepted.
  app.post('/api/faculty/tests/:id/rejoin-requests/:reqId/decision', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const request = await TestRejoinRequests.findOne({ id: req.params.reqId, test_id: req.params.id });
    if (!request) return res.status(404).json({ error: 'Not found.' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request has already been decided.' });
    const action = (req.body || {}).action === 'accept' ? 'accepted' : (req.body || {}).action === 'reject' ? 'rejected' : null;
    if (!action) return res.status(400).json({ error: "action must be 'accept' or 'reject'." });
    await TestRejoinRequests.updateOne({ id: request.id }, { $set: { status: action, decided_at: Date.now(), decided_by: req.user.username } });
    res.json({ ok: true, status: action });
    broadcastToRoom(`test_rejoin:${test.id}`, { type: 'rejoin_decided', test_id: test.id });
    broadcastToRoom(`user:${request.student_username}`, { type: 'rejoin_decided', test_id: test.id, status: action });
    notifyUsers([request.student_username], {
      college_id: test.college_id, tab: 'tests', type: 'test_rejoin_decided',
      title: (action === 'accepted' ? '✅ Rejoin approved: ' : '❌ Rejoin denied: ') + test.title,
      message: action === 'accepted'
        ? `You may resume "${test.title}" — open it from your Tests tab to continue.`
        : `Your rejoin request for "${test.title}" was denied.`,
      related_id: test.id
    }).catch(err => console.error('notify failed', err));
  }));

  // Lets a student try their code against the faculty-fixed test cases
  // before final submission, without it counting as their attempt. Every
  // run — pass or fail — is logged with a timestamp for the record.
  app.post('/api/student/tests/:id/questions/:qId/run-code', requireAuth, requireRole('student'), codeExecutionLimiter, ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (!isAssignedToTest(test, req.user.username)) return res.status(403).json({ error: 'This test is not assigned to you.' });
    // Check Code stays available for the whole time a student is inside an
    // exam they've already started — including after their countdown hits
    // 00:00, since the exam itself is never auto-closed at that point (see
    // /submit above). Only a student who never opened this test at all is
    // turned away here.
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (!join && testWindowStatus(test) !== 'open') return res.status(403).json({ error: 'This test is not currently open.' });
    const already = await TestSubmissions.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (already) return res.status(409).json({ error: 'You have already submitted this test.' });
    const effective = await resolveTestForStudent(test, req.user.username);
    const q = effective.questions.find(qq => qq.id === req.params.qId && qq.type === 'code');
    if (!q) return res.status(404).json({ error: 'Not found.' });
    const code = String((req.body || {}).code || '');
    if (!code.trim()) return res.status(400).json({ error: 'Write some code first.' });
    const { results, all_passed } = await runCodeAgainstTestCases(q.language, code, q.test_cases);
    const attemptRow = {
      id: newId('catt'), test_id: test.id, question_id: q.id, student_username: req.user.username, student_name: req.user.name,
      language: q.language, code, passed: all_passed, results, attempted_at: Date.now(), final: false
    };
    await CodeAttempts.insertOne(attemptRow);
    res.json({ results, all_passed });
  }));

  // Compiler Input/Output Display (item 12), custom-input mode — like a
  // coding-practice platform's "Run" button: executes the student's code
  // against whatever input THEY type (not the faculty's hidden/sample test
  // cases), and returns exactly what it printed. Never logged as a
  // CodeAttempt (it isn't an attempt at the question, just a scratch run)
  // and never touches test_cases/expected_output, so it can't be used to
  // discover a hidden test case's expected answer.
  app.post('/api/student/tests/:id/questions/:qId/run-custom', requireAuth, requireRole('student'), codeExecutionLimiter, ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (!isAssignedToTest(test, req.user.username)) return res.status(403).json({ error: 'This test is not assigned to you.' });
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (!join && testWindowStatus(test) !== 'open') return res.status(403).json({ error: 'This test is not currently open.' });
    const already = await TestSubmissions.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (already) return res.status(409).json({ error: 'You have already submitted this test.' });
    const effective = await resolveTestForStudent(test, req.user.username);
    const q = effective.questions.find(qq => qq.id === req.params.qId && qq.type === 'code');
    if (!q) return res.status(404).json({ error: 'Not found.' });
    const code = String((req.body || {}).code || '');
    const customInput = String((req.body || {}).input || '').slice(0, 10000);
    if (!code.trim()) return res.status(400).json({ error: 'Write some code first.' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-orbis-code-'));
    try {
      const prepared = prepareSubmission(q.language, code, dir);
      if (prepared.error) return res.json({ input: customInput, output: '', error: prepared.error });
      const { stdout, error } = await prepared.run(customInput);
      res.json({ input: customInput, output: error ? '' : (stdout || ''), error: error || null });
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }));

  // Softer focus-loss monitoring: window_blur / page_hidden observations
  // the frontend may still choose to report for events that are NOT a
  // confirmed tab switch (e.g. a transient blur). This route only logs +
  // alerts faculty and never submits anything itself — the actual
  // tab-switch auto-submission goes through /submit with reason
  // 'tab_switch' (see above), which also writes its own activity row.
  const ACTIVITY_EVENT_TYPES = new Set(['tab_switch', 'window_blur', 'page_hidden']);
  app.post('/api/student/tests/:id/activity', requireAuth, requireRole('student'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    // Only log activity for a test the student has actually started —
    // matches the same "must have a join record, or the window must
    // currently be open" gate used by run-code/submit above.
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (!join && testWindowStatus(test) !== 'open') return res.status(403).json({ error: 'This test is not currently open.' });
    const eventType = ACTIVITY_EVENT_TYPES.has((req.body || {}).event_type) ? req.body.event_type : 'tab_switch';
    const row = {
      id: newId('tact'), test_id: test.id, student_username: req.user.username, student_name: req.user.name,
      event_type: eventType, occurred_at: Date.now()
    };
    await TestActivity.insertOne(row);
    const occurrenceCount = await TestActivity.countDocuments({ test_id: test.id, student_username: req.user.username });
    res.status(201).json({ ok: true, occurrence_count: occurrenceCount });
    // Notify only the faculty responsible for THIS test's section (item 6)
    // — never faculty for other sections/tests.
    notifyUsers([test.created_by], {
      college_id: test.college_id, tab: 'tests', type: 'test_activity_alert',
      title: '⚠️ Student Alert — ' + test.title,
      message: req.user.name + ' switched away from the test page (occurrence #' + occurrenceCount + ').',
      related_id: test.id
    }).catch(err => console.error('notify failed', err));
  }));

  // =====================================================================
  // TEST MONITORING — while a test is in progress, faculty can see every
  // student who has joined it (organized section-wise, then roll-number-
  // wise) and open a live view of that student's camera + microphone.
  //
  // There's no WebRTC/peer-to-peer signaling here: the student's browser
  // (see TestAttempt.jsx) records itself in short rolling chunks via
  // MediaRecorder and uploads each one to replace the previous, so the
  // "latest chunk" sitting in TestMonitoringStreams is always a very
  // recent, near-live recording that's already available the instant
  // faculty clicks View Live — nothing is recorded on demand.
  //
  // Camera/mic permission is requested by the browser BEFORE the student
  // is allowed to open the test at all (StudentTests.jsx calls
  // getUserMedia and only proceeds to fetchTestToAttempt if it's
  // granted) — a student who declines never joins.
  //
  // "Camera On" / "Camera Off" is a SEPARATE, faster signal from the
  // recording pipeline above: the browser sends a lightweight JSON
  // heartbeat every few seconds reporting whether its camera+mic tracks
  // are actually live right now (MediaStreamTrack.readyState), starting
  // the instant permission is granted — not waiting on the first ~8s
  // recording chunk to finish encoding and uploading. Faculty's roster
  // treats a student as "on" if either signal is fresh: a recent
  // heartbeat that didn't explicitly report the camera as dead, OR a
  // recently-landed recording chunk. This keeps the status accurate and
  // near-real-time even if one of the two pipelines has a hiccup.
  //
  // Only the faculty member who owns the test can list monitoring rows
  // or stream a student's video. The stream route always answers with
  // Content-Disposition: inline (never attachment) and no-store caching,
  // so the browser never offers a "Save As" affordance for it — combined
  // with the frontend's plain <video controlsList="nodownload"> player
  // (no separate download link anywhere), faculty can watch it but not
  // save it.
  // =====================================================================
  const MONITOR_LIVE_WINDOW_MS = 20 * 1000;
  // Heartbeats are sent roughly every 4s (see TestAttempt.jsx) — this
  // window tolerates a couple of missed beats (a slow tick, a brief
  // network blip) before treating the status as stale.
  const HEARTBEAT_LIVE_WINDOW_MS = 12 * 1000;

  app.post('/api/student/tests/:id/monitoring/chunk', requireAuth, requireRole('student'), uploadMonitorChunk.single('chunk'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    // Same "actually started, not yet submitted" gate used by
    // run-code/activity/submit above.
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (!join) return res.status(403).json({ error: 'You have not started this test.' });
    const already = await TestSubmissions.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (already) return res.status(409).json({ error: 'This test has already been submitted.' });
    if (!req.file) return res.status(400).json({ error: 'No recording chunk received.' });

    const uploadStream = monitoringBucket.openUploadStream(`${req.params.id}_${req.user.username}`, { contentType: req.file.mimetype });
    await new Promise((resolve, reject) => {
      uploadStream.end(req.file.buffer, err => (err ? reject(err) : resolve()));
      uploadStream.on('error', reject);
    });

    const previous = await TestMonitoringStreams.findOne({ test_id: req.params.id, student_username: req.user.username });
    await TestMonitoringStreams.updateOne(
      { test_id: req.params.id, student_username: req.user.username },
      { $set: {
          test_id: req.params.id, student_username: req.user.username, student_name: req.user.name,
          section_id: req.user.section_id, roll_number: req.user.roll_number || '',
          file_id: uploadStream.id, mime: req.file.mimetype, updated_at: Date.now()
        }
      },
      { upsert: true }
    );
    // Bound storage: only ever one chunk on disk per student per test —
    // the old one is deleted once the new one has landed safely.
    if (previous && previous.file_id) monitoringBucket.delete(new ObjectId(previous.file_id)).catch(() => {});
    res.status(201).json({ ok: true });
  }));

  // Fast camera/mic status signal — decoupled from the (slower, heavier)
  // recording-chunk pipeline above on purpose, so "Camera Live" reflects
  // reality within a few seconds of permission being granted instead of
  // waiting on the first full recording chunk to land. Body is plain
  // JSON reporting what the browser can see about its own tracks right
  // now: { camera_live: boolean, mic_live: boolean, camera_permission?:
  // 'granted' | 'denied' | 'unavailable' }.
  //
  // `camera_permission` is what lets faculty/HOD tell "still connecting"
  // apart from "the student's browser actually reported denied/missing" —
  // it's optional and, when present, is stored as-is (see monitoring
  // roster below for how it's turned into a display status). It is never
  // required and never blocks the test: this route only ever RECORDS a
  // status, it never gates test access.
  app.post('/api/student/tests/:id/monitoring/heartbeat', requireAuth, requireRole('student'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (!join) return res.status(403).json({ error: 'You have not started this test.' });
    const already = await TestSubmissions.findOne({ test_id: req.params.id, student_username: req.user.username });
    if (already) return res.status(409).json({ error: 'This test has already been submitted.' });

    const cameraLive = req.body?.camera_live === true;
    const micLive = req.body?.mic_live === true;
    const permission = ['granted', 'denied', 'unavailable'].includes(req.body?.camera_permission) ? req.body.camera_permission : null;
    // item 11: audio monitoring is independent of camera — its own
    // granted/denied/unavailable status, never inferred from the camera's.
    const micPermission = ['granted', 'denied', 'unavailable'].includes(req.body?.mic_permission) ? req.body.mic_permission : null;
    // $set only touches these fields — it never disturbs file_id/mime/
    // updated_at from the recording-chunk pipeline, so the two signals
    // stay independent and neither one can clobber the other.
    const setFields = {
      test_id: req.params.id, student_username: req.user.username, student_name: req.user.name,
      section_id: req.user.section_id, roll_number: req.user.roll_number || '',
      camera_live: cameraLive, mic_live: micLive, last_heartbeat_at: Date.now()
    };
    if (permission) setFields.camera_permission = permission;
    if (micPermission) setFields.mic_permission = micPermission;
    await TestMonitoringStreams.updateOne(
      { test_id: req.params.id, student_username: req.user.username },
      { $set: setFields },
      { upsert: true }
    );
    res.status(200).json({ ok: true });
  }));

  // Shared by both the faculty and HOD monitoring rosters below: turns
  // the raw heartbeat/chunk signals for one student into the four-state
  // camera status the spec calls for —
  //   🟢 live         — actually watchable right now
  //   🟡 connecting   — joined recently, no signal has arrived yet
  //                     (covers the brief window while the browser's own
  //                     permission prompt is still up, or the very first
  //                     heartbeat hasn't landed yet)
  //   🔴 unavailable  — was live at some point (or never got a "denied"
  //                     report) but isn't live now — hardware/WebRTC/
  //                     device-busy failures all land here, since the
  //                     browser can't tell this server apart from a
  //                     denial once the stream is simply gone
  //   ⚪ denied        — the browser explicitly reported the permission
  //                     prompt was declined (see camera_permission on
  //                     the heartbeat route above)
  // None of this ever affects whether the student can continue the test —
  // it is display-only, for the faculty/HOD monitoring view.
  // item 11: same four-state logic, generalized so it works for either
  // channel — camera or mic — since audio monitoring is now independent
  // of camera monitoring rather than piggybacking on it.
  function computeDeviceStatus({ active, permission, joinedAt, now }) {
    if (active) return 'live';
    if (!permission) return (now - joinedAt) <= HEARTBEAT_LIVE_WINDOW_MS ? 'connecting' : 'unavailable';
    if (permission === 'denied') return 'denied';
    return 'unavailable';
  }
  function computeCameraStatus({ stream, cameraActive, joinedAt, now }) {
    return computeDeviceStatus({ active: cameraActive, permission: stream?.camera_permission, joinedAt, now });
  }
  function computeMicStatus({ stream, micActive, joinedAt, now }) {
    return computeDeviceStatus({ active: micActive, permission: stream?.mic_permission, joinedAt, now });
  }

  // Faculty roster for one test's monitoring view: every student who has
  // joined, section-wise then roll-number-wise, each with a Name +
  // Profile (roll number, section, department) and whether their camera
  // is actually on right now — see the heartbeat/chunk comment above.
  app.get('/api/faculty/tests/:id/monitoring', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const joins = await TestJoins.find({ test_id: req.params.id }).toArray();
    if (joins.length === 0) return res.json({ test: { id: test.id, title: test.title, status: testWindowStatus(test) }, students: [] });
    const usernames = joins.map(j => j.student_username);
    const submittedRows = await TestSubmissions.find({ test_id: req.params.id, student_username: { $in: usernames } }, { projection: { student_username: 1, _id: 0 } }).toArray();
    const submittedSet = new Set(submittedRows.map(s => s.student_username));
    const users = await Users.find({ username: { $in: usernames } }, { projection: { username: 1, name: 1, roll_number: 1, section_id: 1, department: 1, _id: 0 } }).toArray();
    const userByUsername = Object.fromEntries(users.map(u => [u.username, u]));
    const streams = await TestMonitoringStreams.find({ test_id: req.params.id, student_username: { $in: usernames } }).toArray();
    const streamByUsername = Object.fromEntries(streams.map(s => [s.student_username, s]));
    const sectionIds = [...new Set(users.map(u => u.section_id).filter(Boolean))];
    const sections = sectionIds.length ? await Sections.find({ id: { $in: sectionIds } }, { projection: { id: 1, name: 1, _id: 0 } }).toArray() : [];
    const sectionNameById = Object.fromEntries(sections.map(s => [s.id, s.name]));

    const now = Date.now();
    const rows = joins.map(j => {
      const u = userByUsername[j.student_username] || {};
      const stream = streamByUsername[j.student_username];
      // Two independent freshness signals, either one enough to call the
      // camera "on": a recent heartbeat that didn't explicitly report the
      // track as dead, or a recording chunk that landed recently. This is
      // what actually fixes the "granted permission but still shows
      // Camera Off" bug — previously camera_active depended ENTIRELY on a
      // full ~8s recording chunk having already finished encoding and
      // uploading, so status only ever updated on that slower cadence
      // (and got stuck at "off" for the whole test if that pipeline had
      // any hiccup). The heartbeat starts firing the instant permission
      // is granted and lands in well under a second normally.
      const heartbeatFresh = !!stream?.last_heartbeat_at && (now - stream.last_heartbeat_at) <= HEARTBEAT_LIVE_WINDOW_MS;
      const chunkFresh = !!stream?.updated_at && (now - stream.updated_at) <= MONITOR_LIVE_WINDOW_MS;
      const cameraActive = (heartbeatFresh && stream.camera_live !== false) || chunkFresh;
      // item 11: mic activity is tracked the same way, independently of
      // the camera — a student can be camera-off/audio-on or vice versa.
      const micActive = heartbeatFresh && stream?.mic_live === true;
      // NEW: Test Monitoring — View Live / View All. A second, narrower
      // signal for the UI's separate "Recording status" badge: unlike
      // camera_active above (which is "on" if EITHER the fast heartbeat OR
      // the rolling-chunk pipeline is fresh), this is true only when the
      // rolling-chunk recorder itself has landed a chunk recently — i.e.
      // whether this student's session is actually being recorded right
      // now, not just whether their camera hardware is live.
      const recordingActive = chunkFresh;
      const lastSeenAt = stream ? Math.max(stream.last_heartbeat_at || 0, stream.updated_at || 0) || null : null;
      const cameraStatus = computeCameraStatus({ stream, cameraActive, joinedAt: j.joined_at, now });
      const micStatus = computeMicStatus({ stream, micActive, joinedAt: j.joined_at, now });
      return {
        username: j.student_username, name: u.name || j.student_username, roll_number: u.roll_number || '',
        section_id: u.section_id || '', section_name: sectionNameById[u.section_id] || u.section_id || 'Unassigned',
        department: u.department || '', joined_at: j.joined_at, submitted: submittedSet.has(j.student_username),
        camera_active: cameraActive, recording_active: recordingActive, last_seen_at: lastSeenAt, camera_status: cameraStatus,
        mic_active: micActive, mic_status: micStatus
      };
    });
    rows.sort((a, b) =>
      a.section_name.localeCompare(b.section_name) ||
      a.roll_number.localeCompare(b.roll_number, undefined, { numeric: true, sensitivity: 'base' })
    );
    res.json({ test: { id: test.id, title: test.title, status: testWindowStatus(test) }, students: rows });
  }));

  // Faculty-only live view: streams the student's latest recorded chunk,
  // always inline (never as an attachment) so there is nothing to
  // download — only to watch.
  app.get('/api/faculty/tests/:id/monitoring/:username/stream', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.params.username });
    if (!join) return res.status(404).json({ error: 'This student has not joined the test.' });
    const stream = await TestMonitoringStreams.findOne({ test_id: req.params.id, student_username: req.params.username });
    if (!stream || !stream.file_id) return res.status(404).json({ error: 'No live recording available yet.' });
    res.setHeader('Content-Type', stream.mime || 'video/webm');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const dl = monitoringBucket.openDownloadStream(new ObjectId(stream.file_id));
    dl.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'No live recording available yet.' }); });
    dl.pipe(res);
  }));

  // =====================================================================
  // HOD TEST MONITORING & TEST MANAGEMENT — department-wide.
  //
  // Mirrors the faculty routes directly above in every respect except
  // ownership scope: a faculty member can only see tests THEY created;
  // an HOD can see and inspect every test conducted by any faculty member
  // within their own department (never another department, never another
  // college — both are enforced by scoping straight off Sections.
  // department, the same field every other HOD route in this file already
  // scopes by).
  //
  // The live-monitoring GETs below remain read-only over OTHER people's
  // tests, exactly as before. What's new in this block (HOD test
  // management — items 4-8) is a parallel, HOD-owned slice: an HOD can
  // create their own tests (POST /api/hod/tests), edit/delete only the
  // ones they created themselves (PUT/DELETE /api/hod/tests/:id, subject
  // to the exact same pre-start-time and points-decision rules as the
  // faculty routes), and save/clone/reuse any faculty test in their
  // department as a template (the /api/hod/saved-tests routes further
  // below). An HOD can never edit, delete, or otherwise mutate a test a
  // faculty member created — only view it.
  // =====================================================================

  // Resolves every section_id in the HOD's own department once, so the
  // three routes below can each scope straight off `test.section_id`
  // without repeating the Sections lookup.
  async function hodDepartmentSectionIds(user) {
    const sections = await Sections.find({ college_id: user.college_id, department: user.department }, { projection: { id: 1, _id: 0 } }).toArray();
    return sections.map(s => s.id);
  }

  // GET /api/hod/tests — same shape as GET /api/faculty/tests (status,
  // question_count, submission_count, pending_grading_count) but scoped
  // to every test run by any faculty member in the HOD's department,
  // regardless of who created it.
  app.get('/api/hod/tests', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const sectionIds = await hodDepartmentSectionIds(req.user);
    if (sectionIds.length === 0) return res.json({ tests: [] });
    const rows = await Tests.find({ section_id: { $in: sectionIds } }).sort({ created_at: -1 }).toArray();
    const withCounts = await Promise.all(rows.map(async r => {
      const [submissions, joinCount] = await Promise.all([
        TestSubmissions.find({ test_id: r.id }).toArray(),
        TestJoins.countDocuments({ test_id: r.id })
      ]);
      const status = testWindowStatus(r);
      // `editable`/`assignment_locked` only matter for tests the HOD
      // themselves created (see PUT/DELETE /api/hod/tests/:id below) — for
      // a faculty-created test this simply reflects whether IT could still
      // be edited by its own creator, shown here for visibility only.
      const editable = status === 'upcoming' && joinCount === 0;
      return {
        ...stripId(r), status, question_count: testQuestionCount(r),
        submission_count: submissions.length, pending_grading_count: submissions.filter(s => !s.fully_graded).length,
        editable, assignment_locked: !editable, is_own: r.created_by === req.user.username
      };
    }));
    res.json({ tests: withCounts });
  }));

  // GET /api/hod/tests/:id — full single-test detail for the HOD "inspect a
  // faculty-created test" view (title, description, creator, questions,
  // options, correct answers, marks, duration, start/end time, assigned
  // department/year/section, published status, submissions). Scoped to any
  // test taught within the HOD's own department, not just tests the HOD
  // created themselves — the read-only monitoring routes above use the
  // exact same department-scoping check.
  app.get('/api/hod/tests/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    const section = await Sections.findOne({ id: test.section_id });
    if (!section || section.department !== req.user.department) return res.status(403).json({ error: 'Not in your department.' });
    const [submissions, joinCount] = await Promise.all([
      TestSubmissions.find({ test_id: req.params.id }).sort({ score: -1 }).toArray(),
      TestJoins.countDocuments({ test_id: req.params.id })
    ]);
    const status = testWindowStatus(test);
    const editable = test.created_by === req.user.username && status === 'upcoming' && joinCount === 0;
    res.json({
      test: {
        ...stripId(test), status, question_count: testQuestionCount(test), joined_count: joinCount,
        editable, assignment_locked: !editable, is_own: test.created_by === req.user.username,
        section_name: section.name, department: section.department
      },
      submissions: submissions.map(stripId)
    });
  }));

  // POST /api/hod/tests — HOD "Create New Test" (item 7) / the landing
  // point of "Use This Test" after reusing a saved template (item 6). Body
  // shape is identical to POST /api/faculty/tests; the only difference is
  // the section-ownership check, which is scoped to "any section in the
  // HOD's own department" rather than "a section this faculty member is
  // assigned to". A test created here is a completely independent Tests
  // document with a brand-new id — it never shares attempts, leaderboard
  // entries, submissions, or points with whatever saved test (if any) it
  // was created from.
  app.post('/api/hod/tests', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { title, subject, section_id, duration_minutes, start_time, end_time, questions, published, assign_mode, assigned_student_usernames } = req.body || {};
    const scheduleMode = req.body?.schedule_mode === 'duration' ? 'duration' : req.body?.schedule_mode === 'range' ? 'range' : 'window';
    if (!title || !title.trim() || !section_id) return res.status(400).json({ error: 'Title and section are required.' });
    const deptSectionIds = await hodDepartmentSectionIds(req.user);
    if (!deptSectionIds.includes(section_id)) return res.status(403).json({ error: 'You can only create tests for a section in your own department.' });
    // Multiple Question Sets (items 19-26) — same rules as the faculty
    // creation route above: `sets` is mutually exclusive with `questions`.
    const rawSets = Array.isArray(req.body?.sets) ? req.body.sets : null;
    if (rawSets) {
      if (rawSets.length < 2) return res.status(400).json({ error: 'Add at least 2 sets, or remove Sets mode and use a single question list.' });
      for (const s of rawSets) {
        if (!s || !s.name || !String(s.name).trim()) return res.status(400).json({ error: 'Every set needs a name.' });
        const err = validateQuestions(s.questions);
        if (err) return res.status(400).json({ error: `Set "${s.name}": ${err}` });
      }
    } else {
      const qErr = validateQuestions(questions);
      if (qErr) return res.status(400).json({ error: qErr });
    }
    let resolvedAssignedUsernames = null;
    if (assign_mode === 'selected' && Array.isArray(assigned_student_usernames) && assigned_student_usernames.length) {
      const candidates = await Users.find(
        { college_id: req.user.college_id, role: 'student', section_id, username: { $in: assigned_student_usernames } },
        { projection: { username: 1, _id: 0 } }
      ).toArray();
      resolvedAssignedUsernames = candidates.map(c => c.username);
      if (!resolvedAssignedUsernames.length) return res.status(400).json({ error: 'None of the selected students belong to this section.' });
    }
    let resolvedDuration = Number(duration_minutes) > 0 ? Number(duration_minutes) : 20;
    if (scheduleMode === 'range') {
      if (!start_time || !end_time) return res.status(400).json({ error: 'Starting date/time and ending date are required.' });
      const startMs = new Date(start_time).getTime();
      const endMs = new Date(end_time).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return res.status(400).json({ error: 'Invalid start or end date/time.' });
      if (endMs <= startMs) return res.status(400).json({ error: 'Ending date/time must be after the starting date/time.' });
      if (!(Number(duration_minutes) > 0)) return res.status(400).json({ error: 'Choose a test duration.' });
      resolvedDuration = Number(duration_minutes);
    } else if (start_time && end_time) {
      const startMs = new Date(start_time).getTime();
      const endMs = new Date(end_time).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return res.status(400).json({ error: 'Invalid start or end time.' });
      if (endMs <= startMs) return res.status(400).json({ error: 'End time must be after start time.' });
      resolvedDuration = Math.round((endMs - startMs) / 60000);
    }
    const cleanQuestionListHod = (qs) => qs.map((q, i) => {
      const type = q.type === 'theory' ? 'theory' : q.type === 'code' ? 'code' : 'mcq';
      const base = { id: newId('q'), order: i, type, text: String(q.text).trim(), marks: Number(q.marks) > 0 ? Number(q.marks) : 1 };
      if (type === 'mcq') return { ...base, options: q.options.map(o => String(o).trim()), correct_index: q.correct_index };
      if (type === 'code') {
        return {
          ...base, language: q.language, starter_code: (q.starter_code || '').slice(0, 4000),
          test_cases: q.test_cases.map(tc => ({ input: String(tc.input || '').slice(0, 4000), expected_output: String(tc.expected_output).trim().slice(0, 4000) }))
        };
      }
      return base;
    });
    let questionsFieldHod = null, setsFieldHod = null, setAssignmentsFieldHod = null;
    let totalMarksFieldHod, hasTheoryFieldHod, hasCodeFieldHod;
    if (rawSets) {
      const cleanSets = rawSets.map(s => {
        const qs = cleanQuestionListHod(s.questions);
        return {
          id: newId('set'), name: String(s.name).trim(), questions: qs,
          total_marks: qs.reduce((sum, q) => sum + q.marks, 0),
          has_theory: qs.some(q => q.type === 'theory'), has_code: qs.some(q => q.type === 'code'),
        };
      });
      setsFieldHod = cleanSets;
      totalMarksFieldHod = Math.max(...cleanSets.map(s => s.total_marks));
      hasTheoryFieldHod = cleanSets.some(s => s.has_theory);
      hasCodeFieldHod = cleanSets.some(s => s.has_code);
      const eligibleUsernames = resolvedAssignedUsernames
        || (await Users.find({ college_id: req.user.college_id, role: 'student', section_id }, { projection: { username: 1, _id: 0 } }).toArray()).map(s => s.username);
      setAssignmentsFieldHod = assignStudentsToSets(eligibleUsernames, cleanSets.map(s => s.id));
    } else {
      const cleanQuestions = cleanQuestionListHod(questions);
      questionsFieldHod = cleanQuestions;
      totalMarksFieldHod = cleanQuestions.reduce((s, q) => s + q.marks, 0);
      hasTheoryFieldHod = cleanQuestions.some(q => q.type === 'theory');
      hasCodeFieldHod = cleanQuestions.some(q => q.type === 'code');
    }
    const row = {
      id: newId('test'), title: String(title).trim(), subject: (subject || 'General').trim(),
      section_id, college_id: req.user.college_id, created_by: req.user.username, created_by_name: req.user.name,
      created_by_role: 'hod',
      duration_minutes: resolvedDuration, schedule_mode: scheduleMode,
      start_time: start_time || null, end_time: end_time || null,
      type: rawSets ? 'set' : 'normal',
      questions: questionsFieldHod, sets: setsFieldHod, set_assignments: setAssignmentsFieldHod,
      total_marks: totalMarksFieldHod, has_theory: hasTheoryFieldHod, has_code: hasCodeFieldHod, created_at: Date.now(),
      published: published !== false, assigned_student_usernames: resolvedAssignedUsernames,
      edited_at: null
    };
    await Tests.insertOne(row);
    res.status(201).json({ test: { ...stripId(row), status: testWindowStatus(row), question_count: testQuestionCount(row) } });
    Users.find({ college_id: row.college_id, role: 'student', section_id: row.section_id }, { projection: { username: 1, _id: 0 } }).toArray()
      .then(students => {
        const targetUsernames = row.assigned_student_usernames
          ? students.map(s => s.username).filter(u => row.assigned_student_usernames.includes(u))
          : students.map(s => s.username);
        return notifyUsers(targetUsernames, {
          college_id: row.college_id, tab: 'tests', type: 'test_added',
          title: 'New test: ' + row.title, message: row.created_by_name + ' assigned a new test in ' + row.subject + '.', related_id: row.id
        });
      })
      .catch(err => console.error('notify failed', err));
  }));

  // PUT /api/hod/tests/:id — edit a test the HOD themselves created, only
  // while it's still editable (same "upcoming AND nobody has joined" rule
  // as faculty tests — enforced server-side regardless of what the
  // frontend sends). An HOD can never edit a test that a faculty member
  // created; that stays exclusively under that faculty member's own
  // PUT /api/faculty/tests/:id.
  app.put('/api/hod/tests/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const joinCount = await TestJoins.countDocuments({ test_id: req.params.id });
    const status = testWindowStatus(test);
    if (status !== 'upcoming' || joinCount > 0) {
      return res.status(409).json({ error: 'This test has already started (or a student has joined) — it can no longer be edited.' });
    }
    const { title, subject, duration_minutes, start_time, end_time, questions, published, assign_mode, assigned_student_usernames, section_id } = req.body || {};
    const update = { edited_at: Date.now() };
    if (section_id != null && section_id !== test.section_id) {
      const deptSectionIds = await hodDepartmentSectionIds(req.user);
      if (!deptSectionIds.includes(section_id)) return res.status(403).json({ error: 'You can only move this test to a section in your own department.' });
      update.section_id = section_id;
      if (assign_mode !== 'selected') update.assigned_student_usernames = null;
    }
    if (title != null) {
      if (!String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
      update.title = String(title).trim();
    }
    if (subject != null) update.subject = String(subject).trim() || 'General';
    if (published != null) update.published = !!published;
    if (Array.isArray(questions)) {
      const qErr = validateQuestions(questions);
      if (qErr) return res.status(400).json({ error: qErr });
      const cleanQuestions = questions.map((q, i) => {
        const type = q.type === 'theory' ? 'theory' : q.type === 'code' ? 'code' : 'mcq';
        const base = { id: newId('q'), order: i, type, text: String(q.text).trim(), marks: Number(q.marks) > 0 ? Number(q.marks) : 1 };
        if (type === 'mcq') return { ...base, options: q.options.map(o => String(o).trim()), correct_index: q.correct_index };
        if (type === 'code') {
          return {
            ...base, language: q.language, starter_code: (q.starter_code || '').slice(0, 4000),
            test_cases: q.test_cases.map(tc => ({ input: String(tc.input || '').slice(0, 4000), expected_output: String(tc.expected_output).trim().slice(0, 4000) }))
          };
        }
        return base;
      });
      update.questions = cleanQuestions;
      update.sets = null; update.set_assignments = null; // switching back to a plain question list drops any prior sets
      update.type = 'normal';
      update.total_marks = cleanQuestions.reduce((s, q) => s + q.marks, 0);
      update.has_theory = cleanQuestions.some(q => q.type === 'theory');
      update.has_code = cleanQuestions.some(q => q.type === 'code');
    } else if (Array.isArray(req.body?.sets)) {
      // items 19/21: editing a test's sets — allowed only pre-join (guarded
      // by the same check at the top of this route), matching "Remove sets
      // before publishing." A change here always recomputes the random
      // assignment from scratch: since no student has joined yet, there is
      // no existing persisted assignment to disturb (the "never regenerate"
      // rule in items 21-25 only starts to matter once assignment could
      // actually be in use, i.e. after a student opens the test).
      const rawSets = req.body.sets;
      if (rawSets.length < 2) return res.status(400).json({ error: 'Add at least 2 sets, or remove Sets mode and use a single question list.' });
      for (const s of rawSets) {
        if (!s || !s.name || !String(s.name).trim()) return res.status(400).json({ error: 'Every set needs a name.' });
        const err = validateQuestions(s.questions);
        if (err) return res.status(400).json({ error: `Set "${s.name}": ${err}` });
      }
      const cleanSets = rawSets.map(s => {
        const qs = s.questions.map((q, i) => {
          const type = q.type === 'theory' ? 'theory' : q.type === 'code' ? 'code' : 'mcq';
          const base = { id: newId('q'), order: i, type, text: String(q.text).trim(), marks: Number(q.marks) > 0 ? Number(q.marks) : 1 };
          if (type === 'mcq') return { ...base, options: q.options.map(o => String(o).trim()), correct_index: q.correct_index };
          if (type === 'code') {
            return {
              ...base, language: q.language, starter_code: (q.starter_code || '').slice(0, 4000),
              test_cases: q.test_cases.map(tc => ({ input: String(tc.input || '').slice(0, 4000), expected_output: String(tc.expected_output).trim().slice(0, 4000) }))
            };
          }
          return base;
        });
        return {
          id: newId('set'), name: String(s.name).trim(), questions: qs,
          total_marks: qs.reduce((sum, q) => sum + q.marks, 0),
          has_theory: qs.some(q => q.type === 'theory'), has_code: qs.some(q => q.type === 'code'),
        };
      });
      update.questions = null;
      update.sets = cleanSets;
      update.type = 'set';
      update.total_marks = Math.max(...cleanSets.map(s => s.total_marks));
      update.has_theory = cleanSets.some(s => s.has_theory);
      update.has_code = cleanSets.some(s => s.has_code);
      const targetSectionId = update.section_id || test.section_id;
      const targetAssigned = assign_mode === 'selected' && Array.isArray(assigned_student_usernames) ? assigned_student_usernames
        : (assign_mode === 'all' ? null : (update.assigned_student_usernames !== undefined ? update.assigned_student_usernames : test.assigned_student_usernames));
      const eligibleUsernames = targetAssigned
        || (await Users.find({ college_id: req.user.college_id, role: 'student', section_id: targetSectionId }, { projection: { username: 1, _id: 0 } }).toArray()).map(s => s.username);
      update.set_assignments = assignStudentsToSets(eligibleUsernames, cleanSets.map(s => s.id));
    }
    if (Number(duration_minutes) > 0) update.duration_minutes = Number(duration_minutes);
    if (start_time !== undefined && end_time !== undefined && start_time && end_time) {
      const startMs = new Date(start_time).getTime();
      const endMs = new Date(end_time).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return res.status(400).json({ error: 'Invalid start or end time.' });
      if (endMs <= startMs) return res.status(400).json({ error: 'End time must be after start time.' });
      update.start_time = start_time;
      update.end_time = end_time;
      if (test.schedule_mode !== 'range' && !(Number(duration_minutes) > 0)) update.duration_minutes = Math.round((endMs - startMs) / 60000);
    }
    if (assign_mode === 'all') {
      update.assigned_student_usernames = null;
    } else if (assign_mode === 'selected' && Array.isArray(assigned_student_usernames)) {
      const targetSectionId = update.section_id || test.section_id;
      const candidates = await Users.find(
        { college_id: req.user.college_id, role: 'student', section_id: targetSectionId, username: { $in: assigned_student_usernames } },
        { projection: { username: 1, _id: 0 } }
      ).toArray();
      update.assigned_student_usernames = candidates.map(c => c.username);
    }
    await Tests.updateOne({ id: req.params.id }, { $set: update });
    const updated = await Tests.findOne({ id: req.params.id });
    res.json({ test: { ...stripId(updated), status: testWindowStatus(updated) } });
  }));

  // DELETE /api/hod/tests/:id — same Remove Test / Points Decision
  // semantics as the faculty delete route (see deleteTestCascade above),
  // restricted to a test the HOD themselves created.
  app.delete('/api/hod/tests/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test || test.created_by !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const { remove_points } = req.body || {};
    if (typeof remove_points !== 'boolean') {
      return res.status(400).json({ error: 'Choose whether to also remove points earned from this test (remove_points: true or false).' });
    }
    try {
      await deleteTestCascade(test, { removePoints: remove_points });
    } catch (e) {
      console.error('test deletion failed', e);
      return res.status(500).json({ error: 'Could not delete this test. Nothing was changed — please try again.' });
    }
    res.json({ ok: true, points_removed: remove_points });
  }));

  // ---------- HOD: Save/Clone faculty tests as reusable templates ----------
  // Same SavedTests collection and row shape as the faculty templates
  // above (see cleanSavedQuestions/savedTestSummary) — the "owner" field is
  // literally just whichever username created the template, faculty or
  // HOD, so a HOD's saved tests are naturally kept separate from a
  // faculty member's own (each only ever sees rows filtered by their own
  // req.user.username) without needing a second collection or a schema
  // change.
  app.post('/api/hod/saved-tests', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const { source_test_id, title, subject, description, duration_minutes, questions, client_token } = req.body || {};

    if (client_token) {
      const existing = await SavedTests.findOne({ faculty_username: req.user.username, client_token });
      if (existing) return res.status(200).json({ saved_test: savedTestSummary(existing), deduped: true });
    }

    let row;
    if (source_test_id) {
      // A HOD may save/clone ANY test taught within their own department
      // (not only tests they personally created) — that's the whole point
      // of "Save Test / Save as Template" for faculty-created tests.
      const test = await Tests.findOne({ id: source_test_id, college_id: req.user.college_id });
      if (!test) return res.status(404).json({ error: 'Test not found.' });
      const section = await Sections.findOne({ id: test.section_id });
      if (!section || section.department !== req.user.department) return res.status(403).json({ error: 'Not in your department.' });
      // Deliberately copies only the reusable question-paper structure and
      // configuration — never student attempts, never the old leaderboard,
      // never old point-ledger entries (those live in TestSubmissions /
      // PointTransactions, neither of which this touches), and never
      // mutates the original faculty test in any way (read-only lookup
      // above, insert-only below).
      row = {
        id: newId('savedtest'), faculty_username: req.user.username, college_id: req.user.college_id,
        title: test.title, subject: test.subject, description: description || '',
        duration_minutes: test.duration_minutes, schedule_mode: test.schedule_mode,
        questions: test.questions, sets: test.sets || null, total_marks: test.total_marks,
        has_theory: test.has_theory, has_code: test.has_code,
        source_test_id: test.id, client_token: client_token || null,
        created_at: Date.now(), updated_at: Date.now(),
      };
    } else {
      if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
      const qErr = validateQuestions(questions);
      if (qErr) return res.status(400).json({ error: qErr });
      const cleanQuestions = cleanSavedQuestions(questions);
      row = {
        id: newId('savedtest'), faculty_username: req.user.username, college_id: req.user.college_id,
        title: String(title).trim(), subject: (subject || 'General').trim(), description: description || '',
        duration_minutes: Number(duration_minutes) > 0 ? Number(duration_minutes) : 20, schedule_mode: 'window',
        questions: cleanQuestions, total_marks: cleanQuestions.reduce((s, q) => s + q.marks, 0),
        has_theory: cleanQuestions.some(q => q.type === 'theory'), has_code: cleanQuestions.some(q => q.type === 'code'),
        source_test_id: null, client_token: client_token || null,
        created_at: Date.now(), updated_at: Date.now(),
      };
    }
    await SavedTests.insertOne(row);
    res.status(201).json({ saved_test: savedTestSummary(row) });
  }));

  app.get('/api/hod/saved-tests', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const rows = await SavedTests.find({ faculty_username: req.user.username }).sort({ updated_at: -1 }).toArray();
    res.json({ saved_tests: rows.map(savedTestSummary) });
  }));

  // Full detail — used both to open the Edit form and to prefill "Use This
  // Test" (item 6).
  app.get('/api/hod/saved-tests/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await SavedTests.findOne({ id: req.params.id });
    if (!row || row.faculty_username !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    res.json({ saved_test: savedTestSummary(row) });
  }));

  app.put('/api/hod/saved-tests/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await SavedTests.findOne({ id: req.params.id });
    if (!row || row.faculty_username !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    const { title, subject, description, duration_minutes, questions } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
    // items 19-26: same sets-aware handling as the faculty saved-test PUT
    // route above — a saved template can itself be a sets test.
    const rawSets = Array.isArray(req.body?.sets) ? req.body.sets : null;
    let update;
    if (rawSets) {
      if (rawSets.length < 2) return res.status(400).json({ error: 'Add at least 2 sets, or remove Sets mode and use a single question list.' });
      for (const s of rawSets) {
        if (!s || !s.name || !String(s.name).trim()) return res.status(400).json({ error: 'Every set needs a name.' });
        const err = validateQuestions(s.questions);
        if (err) return res.status(400).json({ error: `Set "${s.name}": ${err}` });
      }
      const cleanSets = rawSets.map(s => {
        const qs = cleanSavedQuestions(s.questions);
        return {
          id: newId('set'), name: String(s.name).trim(), questions: qs,
          total_marks: qs.reduce((sum, q) => sum + q.marks, 0),
          has_theory: qs.some(q => q.type === 'theory'), has_code: qs.some(q => q.type === 'code'),
        };
      });
      update = {
        title: String(title).trim(), subject: (subject || 'General').trim(), description: description || '',
        duration_minutes: Number(duration_minutes) > 0 ? Number(duration_minutes) : row.duration_minutes,
        questions: null, sets: cleanSets,
        total_marks: Math.max(...cleanSets.map(s => s.total_marks)),
        has_theory: cleanSets.some(s => s.has_theory), has_code: cleanSets.some(s => s.has_code),
        updated_at: Date.now(),
      };
    } else {
      const qErr = validateQuestions(questions);
      if (qErr) return res.status(400).json({ error: qErr });
      const cleanQuestions = cleanSavedQuestions(questions);
      update = {
        title: String(title).trim(), subject: (subject || 'General').trim(), description: description || '',
        duration_minutes: Number(duration_minutes) > 0 ? Number(duration_minutes) : row.duration_minutes,
        questions: cleanQuestions, sets: null,
        total_marks: cleanQuestions.reduce((s, q) => s + q.marks, 0),
        has_theory: cleanQuestions.some(q => q.type === 'theory'), has_code: cleanQuestions.some(q => q.type === 'code'),
        updated_at: Date.now(),
      };
    }
    await SavedTests.updateOne({ id: req.params.id }, { $set: update });
    res.json({ saved_test: savedTestSummary({ ...row, ...update }) });
  }));

  // Deleting a HOD Saved Test only ever removes this template row — it
  // never touches the original faculty test it may have been cloned from,
  // or any Conducted Test previously created via "Use This Test".
  app.delete('/api/hod/saved-tests/:id', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const row = await SavedTests.findOne({ id: req.params.id });
    if (!row || row.faculty_username !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    await SavedTests.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // GET /api/hod/tests/:id/monitoring — identical roster shape to the
  // faculty monitoring route above (camera_active/recording_active
  // included), the only difference being the authorization check: the
  // test's section must belong to the HOD's own department, not
  // created_by === req.user.username.
  app.get('/api/hod/tests/:id/monitoring', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (test.created_by !== req.user.username) {
      const section = await Sections.findOne({ id: test.section_id, college_id: req.user.college_id, department: req.user.department });
      if (!section) return res.status(404).json({ error: 'Not found.' });
    }
    const joins = await TestJoins.find({ test_id: req.params.id }).toArray();
    if (joins.length === 0) return res.json({ test: { id: test.id, title: test.title, status: testWindowStatus(test) }, students: [] });
    const usernames = joins.map(j => j.student_username);
    const submittedRows = await TestSubmissions.find({ test_id: req.params.id, student_username: { $in: usernames } }, { projection: { student_username: 1, _id: 0 } }).toArray();
    const submittedSet = new Set(submittedRows.map(s => s.student_username));
    const users = await Users.find({ username: { $in: usernames } }, { projection: { username: 1, name: 1, roll_number: 1, section_id: 1, department: 1, _id: 0 } }).toArray();
    const userByUsername = Object.fromEntries(users.map(u => [u.username, u]));
    const streams = await TestMonitoringStreams.find({ test_id: req.params.id, student_username: { $in: usernames } }).toArray();
    const streamByUsername = Object.fromEntries(streams.map(s => [s.student_username, s]));
    const sectionIds = [...new Set(users.map(u => u.section_id).filter(Boolean))];
    const sections = sectionIds.length ? await Sections.find({ id: { $in: sectionIds } }, { projection: { id: 1, name: 1, _id: 0 } }).toArray() : [];
    const sectionNameById = Object.fromEntries(sections.map(s => [s.id, s.name]));

    const now = Date.now();
    const rows = joins.map(j => {
      const u = userByUsername[j.student_username] || {};
      const stream = streamByUsername[j.student_username];
      const heartbeatFresh = !!stream?.last_heartbeat_at && (now - stream.last_heartbeat_at) <= HEARTBEAT_LIVE_WINDOW_MS;
      const chunkFresh = !!stream?.updated_at && (now - stream.updated_at) <= MONITOR_LIVE_WINDOW_MS;
      const cameraActive = (heartbeatFresh && stream.camera_live !== false) || chunkFresh;
      const micActive = heartbeatFresh && stream?.mic_live === true;
      const recordingActive = chunkFresh;
      const lastSeenAt = stream ? Math.max(stream.last_heartbeat_at || 0, stream.updated_at || 0) || null : null;
      const cameraStatus = computeCameraStatus({ stream, cameraActive, joinedAt: j.joined_at, now });
      const micStatus = computeMicStatus({ stream, micActive, joinedAt: j.joined_at, now });
      return {
        username: j.student_username, name: u.name || j.student_username, roll_number: u.roll_number || '',
        section_id: u.section_id || '', section_name: sectionNameById[u.section_id] || u.section_id || 'Unassigned',
        department: u.department || '', joined_at: j.joined_at, submitted: submittedSet.has(j.student_username),
        camera_active: cameraActive, recording_active: recordingActive, last_seen_at: lastSeenAt, camera_status: cameraStatus,
        mic_active: micActive, mic_status: micStatus
      };
    });
    rows.sort((a, b) =>
      a.section_name.localeCompare(b.section_name) ||
      a.roll_number.localeCompare(b.roll_number, undefined, { numeric: true, sensitivity: 'base' })
    );
    res.json({ test: { id: test.id, title: test.title, status: testWindowStatus(test), created_by_name: test.created_by_name }, students: rows });
  }));

  // HOD-only live view — read-only, same as faculty's stream route but
  // scoped to the HOD's own department instead of test ownership. There
  // is deliberately no equivalent POST/grade/delete route in this HOD
  // block anywhere: HOD Test Monitoring can only ever watch, never touch
  // a question or a student's answer.
  app.get('/api/hod/tests/:id/monitoring/:username/stream', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (test.created_by !== req.user.username) {
      const section = await Sections.findOne({ id: test.section_id, college_id: req.user.college_id, department: req.user.department });
      if (!section) return res.status(404).json({ error: 'Not found.' });
    }
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.params.username });
    if (!join) return res.status(404).json({ error: 'This student has not joined the test.' });
    const stream = await TestMonitoringStreams.findOne({ test_id: req.params.id, student_username: req.params.username });
    if (!stream || !stream.file_id) return res.status(404).json({ error: 'No live recording available yet.' });
    res.setHeader('Content-Type', stream.mime || 'video/webm');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const dl = monitoringBucket.openDownloadStream(new ObjectId(stream.file_id));
    dl.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'No live recording available yet.' }); });
    dl.pipe(res);
  }));

  // Submission reasons: 'manual' is the student's own Submit Exam →
  // Confirm click. 'tab_switch' is an automatic submission fired the
  // instant the browser reports the test tab is no longer visible (see
  // the visibilitychange listener in TestAttempt.jsx) — that listener
  // fires ONLY on an actual tab/app switch (Page Visibility API), never
  // on mouse movement, clicks, scrolling, Enter, Tab-inside-the-editor,
  // running code, compiler errors, fullscreen toggling, window resizing,
  // network hiccups, or any other in-page/transient event. Both reasons
  // go through this exact same endpoint and code path — same grading,
  // same leaderboard update, same "already submitted" lock — they only
  // differ in what gets stored/notified below.
  const SUBMISSION_REASONS = new Set(['manual', 'tab_switch']);
  app.post('/api/student/tests/:id/submit', requireAuth, requireRole('student'), ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id, section_id: req.user.section_id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (!isAssignedToTest(test, req.user.username)) return res.status(403).json({ error: 'This test is not assigned to you.' });
    const existing = await TestSubmissions.findOne({ test_id: req.params.id, student_username: req.user.username });
    // A tab-switch auto-submit that loses a race with a manual submit (or
    // arrives twice, e.g. a duplicate visibilitychange) is just a no-op —
    // the attempt is already locked in either way.
    if (existing) return res.status(409).json({ error: 'You have already submitted this test.' });
    // This endpoint is the ONLY way a test can be submitted — either the
    // student explicitly clicking Submit Exam and confirming ('manual'),
    // or the frontend auto-calling it the moment it detects the test tab
    // was switched away from ('tab_switch'). Nothing else ever finalizes
    // an attempt: not the countdown reaching 00:00, not leaving
    // fullscreen, not a network drop. Submission here is gated only on
    // having actually started the test (a join record exists) — never on
    // the countdown, and never on the test's scheduled window having
    // since closed. A student who never opened the test at all (no join
    // record) has nothing to submit.
    const reason = SUBMISSION_REASONS.has((req.body || {}).reason) ? req.body.reason : 'manual';
    const join = await TestJoins.findOne({ test_id: req.params.id, student_username: req.user.username });
    // Fixed (permissions audit): this previously only blocked when BOTH no
    // join existed AND the window was closed — meaning a student who never
    // opened the test at all could still submit purely because the window
    // happened to be open, skipping the timer entirely (join_points and
    // time_points end up 0, but they'd still bank full correct-answer
    // credit for pre-computed answers with zero time pressure). The
    // comment above already documented the intended rule ("gated only on
    // having actually started the test") — the code just didn't match it.
    if (!join) return res.status(403).json({ error: 'You have not started this test — open it first.' });
    // items 21-25: resolve the student's OWN persisted set (or the plain
    // question list, for a non-sets test) — the only source of truth for
    // grading. Nothing below ever reads test.questions directly, so a
    // student can't influence which question set they're graded against
    // by anything in the request body.
    const effective = await resolveTestForStudent(test, req.user.username);
    const { answers } = req.body || {};
    if (!Array.isArray(answers) || answers.length !== effective.questions.length) {
      return res.status(400).json({ error: 'Answer every question before submitting.' });
    }
    const finalAnswers = answers;
    // Question-level time tracking (item 11). The client reports how long
    // it think the student spent on each question (best-effort, from its
    // own per-question timers); we only use it for faculty analytics, so
    // it's simply clamped to a sane range (0..test duration) rather than
    // trusted as authoritative for anything that affects scoring — scoring
    // itself still comes entirely from the server-timestamped join/submit
    // anchors (computeTestScore), never from this per-question figure.
    const durationCapSeconds = test.duration_minutes * 60;
    function clampQuestionSeconds(v) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.min(n, durationCapSeconds);
    }

    let hasTheory = false;
    const gradedAnswers = [];
    for (let i = 0; i < effective.questions.length; i++) {
      const q = effective.questions[i];
      const a = finalAnswers[i] || {};
      const timeSpentSeconds = clampQuestionSeconds(a.time_spent_seconds);
      if (q.type === 'theory') {
        hasTheory = true;
        gradedAnswers.push({ question_id: q.id, type: 'theory', answer_text: String(a.text || '').slice(0, 8000), score: null, max_marks: q.marks, time_spent_seconds: timeSpentSeconds });
        continue;
      }
      if (q.type === 'code') {
        const code = String(a.code || '');
        // Every attempt is logged — pass or fail — so submission time is on
        // record either way.
        const { results, all_passed } = code.trim()
          ? await runCodeAgainstTestCases(q.language, code, q.test_cases)
          : { results: q.test_cases.map(tc => ({ input: tc.input, expected_output: tc.expected_output, actual_output: '', error: 'No code submitted.', passed: false })), all_passed: false };
        await CodeAttempts.insertOne({
          id: newId('catt'), test_id: test.id, question_id: q.id, student_username: req.user.username, student_name: req.user.name,
          language: q.language, code, passed: all_passed, results, attempted_at: Date.now(), final: true
        });
        // Check Code (run-code, above) and Submit Exam are completely
        // separate actions: Submit Exam always finalizes the exam, whatever
        // state the code is in. A solution that doesn't pass every
        // faculty-fixed test case is simply graded wrong (0 marks) here,
        // exactly like an incorrect MCQ answer — it never blocks or rejects
        // the submission.
        gradedAnswers.push({ question_id: q.id, type: 'code', code, language: q.language, results, correct: all_passed, score: all_passed ? q.marks : 0, max_marks: q.marks, time_spent_seconds: timeSpentSeconds });
        continue;
      }
      const selected = typeof a.selected_index === 'number' ? a.selected_index : -1;
      const correct = selected === q.correct_index;
      gradedAnswers.push({ question_id: q.id, type: 'mcq', selected_index: selected, correct, score: correct ? q.marks : 0, max_marks: q.marks, time_spent_seconds: timeSpentSeconds });
    }

    const score = gradedAnswers.reduce((s, a) => s + (typeof a.score === 'number' ? a.score : 0), 0);
    const submittedAt = Date.now();
    // Leaderboard scoring (item 1): join points + 2 pts per correct
    // MCQ/code answer + remaining-time points (MM.SS, not a minutes
    // fraction — see computeTestScore). Both ends of the time calculation
    // (join anchor, submit time) are server timestamps, so a student can't
    // manipulate their score by tampering with the browser clock.
    const joinedAt = join ? join.joined_at : null;
    const testScore = computeTestScore({ test, gradedAnswers, joinedAt, submittedAt });
    const timeTakenMs = joinedAt != null ? Math.max(0, submittedAt - joinedAt) : null;
    const row = {
      id: newId('sub'), test_id: req.params.id, student_username: req.user.username, student_name: req.user.name,
      answers: gradedAnswers, score, fully_graded: !hasTheory,
      correct_count: testScore.correct, wrong_count: testScore.wrong, points: testScore.final_points,
      join_points: testScore.join_points, correct_points: testScore.correct_points, time_points: testScore.time_points,
      remaining_seconds: testScore.remaining_seconds, time_taken_ms: timeTakenMs,
      submission_reason: reason, submitted_at: submittedAt
    };
    try {
      await TestSubmissions.insertOne(row);
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: 'You have already submitted this test.' });
      throw e;
    }
    res.status(201).json({ submission: stripId(row), total_marks: effective.total_marks });

    // Session persistence cleanup (item 5/10) — the in-progress autosave
    // row is no longer needed once a final submission exists; removing it
    // also guarantees a resumed session never resurrects stale answers
    // after this attempt is locked in.
    TestProgress.deleteOne({ test_id: req.params.id, student_username: req.user.username }).catch(err => console.error('progress cleanup failed', err));

    // Real-time push (replaces "wait for the next poll" for these three
    // screens): the leaderboard rooms tell any open Main/Test/All-Tests
    // Leaderboard screen to refetch immediately, and test_live tells any
    // open faculty monitoring panel this student just finished. None of
    // these payloads carry the actual score — just "something changed" —
    // so there's nothing here for an unauthorized listener to leak even if
    // a room somehow matched the wrong socket (it can't, per
    // canSubscribeToRoom, but the payload shape doesn't rely on that
    // alone).
    broadcastToRoom(`leaderboard:college:${test.college_id}`, { type: 'leaderboard_update' });
    broadcastToRoom(`test_leaderboard:${test.id}`, { type: 'leaderboard_update', test_id: test.id });
    broadcastToRoom(`test_live:${test.id}`, { type: 'test_status', student_username: req.user.username, status: reason === 'tab_switch' ? 'auto_submitted' : 'submitted' });

    // Record the ledger entry for this test attempt — one TEST transaction
    // per submission, idempotent on the submission id (reference_id), so a
    // retried request can never double-award points.
    awardPoints({
      student_username: req.user.username, college_id: test.college_id, source: 'TEST',
      points: testScore.final_points, reference_id: row.id,
      description: `${test.title}: ${testScore.join_points} join + ${testScore.correct_points} correct (${testScore.correct}/${effective.questions.length}) + ${cleanDecimal(testScore.time_points)} time`
    }).catch(err => console.error('award test points failed', err));

    // The student is done — their camera/mic feed is no longer "live", so
    // drop the last recorded chunk instead of leaving it sitting around.
    TestMonitoringStreams.findOneAndDelete({ test_id: req.params.id, student_username: req.user.username })
      .then(r => { const doc = r && r.value; if (doc && doc.file_id) monitoringBucket.delete(new ObjectId(doc.file_id)).catch(() => {}); })
      .catch(err => console.error('monitoring cleanup failed', err));

    if (reason === 'tab_switch') {
      // Record this as an activity-log entry too, alongside the ordinary
      // tab_switch observations from /activity, so the auto-submission
      // itself shows up in the test's attempt/activity history for faculty.
      TestActivity.insertOne({
        id: newId('tact'), test_id: test.id, student_username: req.user.username, student_name: req.user.name,
        event_type: 'tab_switch_auto_submit', occurred_at: submittedAt
      }).catch(err => console.error('activity log failed', err));
      const timeLabel = new Date(submittedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      notifyUsers([test.created_by], {
        college_id: test.college_id, tab: 'tests', type: 'test_auto_submitted',
        title: '⚠️ Test Automatically Submitted',
        message: `Student: ${req.user.name}\nTest: ${test.title}\nReason: Browser tab switched\nTime: ${timeLabel}`,
        related_id: test.id
      }).catch(err => console.error('notify failed', err));
    } else {
      notifyUsers([test.created_by], {
        college_id: test.college_id, tab: 'tests', type: 'test_submitted',
        title: 'Test submitted: ' + test.title,
        message: req.user.name + ' submitted "' + test.title + '".',
        related_id: test.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  // All Tests Leaderboard (item 5) — one row per student, aggregating final
  // test points across every test they've taken within the same visibility
  // scope as the per-test leaderboard (a student sees their own section's
  // tests; a faculty member sees their own tests; HOD/college admin see
  // every test in the college).
  //
  // IMPORTANT — route ordering fix: this route MUST be registered before
  // '/api/tests/:id/leaderboard' below. Express matches routes in
  // registration order, and ':id' is a wildcard segment that happily
  // matches the literal string "all" — so when this route was registered
  // AFTER the ':id' route, every request to /api/tests/all/leaderboard was
  // being swallowed by '/api/tests/:id/leaderboard' with id === 'all',
  // which then did `Tests.findOne({ id: 'all' })`, found nothing, and
  // returned 404 "Not Found". That 404 was exactly the bug report ("All
  // Test Leaderboard shows Not Found / infinite loading"). Registering the
  // more specific literal path first resolves it correctly.
  app.get('/api/tests/all/leaderboard', requireAuth, ah(async (req, res) => {
    let testFilter;
    if (req.user.role === 'student') testFilter = { section_id: req.user.section_id };
    else if (req.user.role === 'faculty') testFilter = { created_by: req.user.username };
    else if (['hod', 'college_admin'].includes(req.user.role)) testFilter = { college_id: req.user.college_id };
    else return res.status(403).json({ error: 'Not available for this role.' });
    const tests = await Tests.find(testFilter, { projection: { id: 1, _id: 0 } }).toArray();
    const testIds = tests.map(t => t.id);
    if (!testIds.length) return res.json({ leaderboard: [] });
    const subs = await TestSubmissions.find({ test_id: { $in: testIds } }).toArray();
    const usernames = [...new Set(subs.map(s => s.student_username))];
    const students = usernames.length
      ? await Users.find({ username: { $in: usernames } }, { projection: { username: 1, roll_number: 1, name: 1, _id: 0 } }).toArray()
      : [];
    const studentByUsername = Object.fromEntries(students.map(s => [s.username, s]));
    const byStudent = new Map();
    for (const sub of subs) {
      const hasNewFields = typeof sub.time_points === 'number';
      const stats = computeSubmissionStats(sub);
      const finalPoints = hasNewFields ? sub.points : cleanDecimal((sub.join_points || 0) + stats.points);
      const timePoints = hasNewFields ? sub.time_points : 0;
      if (!byStudent.has(sub.student_username)) {
        byStudent.set(sub.student_username, {
          username: sub.student_username, name: sub.student_name,
          roll_number: (studentByUsername[sub.student_username] || {}).roll_number || '',
          total_test_points: 0, tests_attempted: 0, total_time_points: 0, total_correct_points: 0
        });
      }
      const row = byStudent.get(sub.student_username);
      row.total_test_points = cleanDecimal(row.total_test_points + finalPoints);
      row.tests_attempted += 1;
      row.total_time_points = cleanDecimal(row.total_time_points + timePoints);
      row.total_correct_points = cleanDecimal(row.total_correct_points + stats.points);
    }
    const rows = [...byStudent.values()].map(r => ({ ...r, average_score: cleanDecimal(r.total_test_points / r.tests_attempted) }));
    rows.sort((a, b) => b.total_test_points - a.total_test_points);
    let lastScore = null, lastRank = 0;
    const leaderboard = rows.map((entry, i) => {
      if (entry.total_test_points !== lastScore) { lastRank = i + 1; lastScore = entry.total_test_points; }
      return { rank: lastRank, ...entry };
    });
    res.json({ leaderboard });
  }));

  // Per-test leaderboard (Exam Module only) — item 2. Ranked by Final Test
  // Points descending (join points + correct-answer points + remaining-time
  // points, see computeTestScore). Ties (identical final points) share the
  // same rank number, and the next distinct score continues at its true
  // position (1, 1, 3 — never 1, 1, 2) rather than being artificially split
  // apart, since the scoring formula itself (not an arbitrary tiebreak) is
  // what the spec asks to be the sole ranking driver.
  app.get('/api/tests/:id/leaderboard', requireAuth, ah(async (req, res) => {
    const test = await Tests.findOne({ id: req.params.id });
    if (!test) return res.status(404).json({ error: 'Not found.' });
    if (req.user.role === 'student' && req.user.section_id !== test.section_id) return res.status(403).json({ error: 'Not your test.' });
    if (req.user.role === 'faculty' && test.created_by !== req.user.username) return res.status(403).json({ error: 'Not your test.' });
    const subs = await TestSubmissions.find({ test_id: req.params.id }).toArray();
    const usernames = subs.map(s => s.student_username);
    const students = usernames.length
      ? await Users.find({ username: { $in: usernames } }, { projection: { username: 1, roll_number: 1, _id: 0 } }).toArray()
      : [];
    const rollByUsername = Object.fromEntries(students.map(s => [s.username, s.roll_number || '']));
    const totalStudents = subs.length;
    const withStats = await Promise.all(subs.map(async (sub) => {
      // Recomputed defensively from stored per-answer data for legacy rows
      // that predate the new scoring fields (join_points/correct_points/
      // time_points/remaining_seconds); rows written by the current
      // /submit endpoint already carry these directly.
      const hasNewFields = typeof sub.time_points === 'number';
      const stats = computeSubmissionStats(sub);
      const finalPoints = hasNewFields ? sub.points : cleanDecimal((sub.join_points || 0) + stats.points);
      const timeTakenMs = typeof sub.time_taken_ms === 'number' ? sub.time_taken_ms : null;
      const remainingSeconds = hasNewFields ? sub.remaining_seconds : null;
      // item 26: which set this student was assigned, so faculty can
      // verify the automatic distribution — null for a non-sets test.
      const effective = await resolveTestForStudent(test, sub.student_username);
      return {
        username: sub.student_username, name: sub.student_name, roll_number: rollByUsername[sub.student_username] || '',
        submitted_at: sub.submitted_at, score: sub.score, total_marks: effective.total_marks,
        set_name: effective.set_name,
        correct_count: stats.correct, wrong_count: stats.wrong,
        time_taken_ms: timeTakenMs, time_taken_label: formatDuration(timeTakenMs),
        remaining_seconds: remainingSeconds, remaining_time_label: remainingSeconds != null ? formatDuration(remainingSeconds * 1000) : null,
        test_points: finalPoints, final_score: finalPoints,
        status: sub.fully_graded ? 'graded' : 'submitted'
      };
    }));
    withStats.sort((a, b) => b.final_score - a.final_score || a.submitted_at - b.submitted_at);
    let lastScore = null, lastRank = 0;
    const leaderboard = withStats.map((entry, i) => {
      if (entry.final_score !== lastScore) { lastRank = i + 1; lastScore = entry.final_score; }
      return { rank: lastRank, position: lastRank, ...entry };
    });
    res.json({ leaderboard, total_students: totalStudents });
  }));

  // NOTE: There is intentionally no auto-submission anywhere in this
  // application (see /submit above), so there is no "re-entry" concept
  // either — a test is never force-submitted out from under a student, so
  // there is nothing to request re-entry to. Any old exit/re-entry
  // endpoints have been removed for good.

  // =====================================================================
  // SHARED CONTENT — announcements, notes, events, public board
  // Visible via cascading scope (college / department / section).
  // Postable by college_admin (college-wide), hod (department-wide),
  // faculty (their section only). Super admin and students never post.
  // =====================================================================
  app.get('/api/announcements', requireAuth, ah(async (req, res) => {
    const rows = await Announcements.find(await visibilityFilter(req.user)).sort({ created_at: -1 }).toArray();
    res.json({ announcements: rows.map(stripId) });
  }));

  app.post('/api/announcements', requireAuth, requireRole('college_admin', 'hod', 'faculty'), ah(async (req, res) => {
    const { title, body, priority } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'Title and details are required.' });
    const target = await buildTarget(req.user, req.body || {});
    if (target.error) return res.status(400).json({ error: target.error });
    const row = {
      id: newId('ann'), title: String(title).trim(), body: String(body).trim(),
      priority: priority === 'urgent' ? 'urgent' : 'normal', ...target,
      author_username: req.user.username, author_name: req.user.name, author_role: req.user.role, created_at: Date.now()
    };
    await Announcements.insertOne(row);
    res.status(201).json({ announcement: stripId(row) });
    const audience = await usersForTarget(row.college_id, row.target_department, row.target_year, row.target_section_id, req.user.username);
    // notifyUsers() below writes the in-app row AND fires the real device
    // push (see sendPushToUsers) for the whole audience — the same
    // college-wide/department/section targeting `usersForTarget` already
    // resolved above, no separate push-specific audience needed.
    notifyUsers(audience, {
      college_id: row.college_id, tab: 'announcements', type: 'announcement_added',
      title: 'New announcement: ' + row.title, message: row.author_name + ' posted a new announcement.', related_id: row.id
    }).catch(err => console.error('notify failed', err));
  }));

  app.delete('/api/announcements/:id', requireAuth, ah(async (req, res) => {
    const row = await Announcements.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!canManageContent(req.user, row)) return res.status(403).json({ error: 'You do not have permission to remove this.' });
    await Announcements.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // ---------- Notes / study material ----------
  app.get('/api/notes', requireAuth, ah(async (req, res) => {
    const rows = await Notes.find(await visibilityFilter(req.user)).sort({ created_at: -1 }).toArray();
    res.json({ notes: rows.map(n => {
      const { _id, file_id, bookmarked_by, ...rest } = n;
      return { ...rest, file_id: file_id ? String(file_id) : null, bookmarked: (bookmarked_by || []).includes(req.user.username) };
    }) });
  }));

  // NEW: bookmark / un-bookmark a study material so a student can find it
  // again quickly from "My Bookmarks" without re-searching every subject.
  //
  // IDOR fix: previously looked the note up by :id alone, so any
  // authenticated user (any college, any department) could bookmark a note
  // just by guessing/incrementing its id. Now the same visibilityFilter()
  // used by the list route is folded into the lookup itself, so a note
  // outside the caller's college/department/year/section scope is
  // indistinguishable from one that doesn't exist (404), never a 403 that
  // would confirm its existence to an unauthorized user.
  app.post('/api/notes/:id/bookmark', requireAuth, ah(async (req, res) => {
    const scope = await visibilityFilter(req.user);
    const note = await Notes.findOne({ id: req.params.id, ...scope });
    if (!note) return res.status(404).json({ error: 'Not found.' });
    const already = (note.bookmarked_by || []).includes(req.user.username);
    await Notes.updateOne({ id: req.params.id }, already ? { $pull: { bookmarked_by: req.user.username } } : { $addToSet: { bookmarked_by: req.user.username } });
    res.json({ bookmarked: !already });
  }));

  app.post('/api/notes', requireAuth, requireRole('college_admin', 'hod', 'faculty'), uploadLimiter, uploadNote.single('file'), ah(async (req, res) => {
    const { subject, title, description, allow_download } = req.body || {};
    if (!subject || !title) return res.status(400).json({ error: 'Subject and title are required.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
    const target = await buildTarget(req.user, req.body || {});
    if (target.error) return res.status(400).json({ error: target.error });

    const fileKind = ALLOWED_NOTE_TYPES[req.file.mimetype] || 'office';
    const uploadStream = noteBucket.openUploadStream(req.file.originalname, { contentType: req.file.mimetype });
    await new Promise((resolve, reject) => {
      uploadStream.end(req.file.buffer, err => (err ? reject(err) : resolve()));
      uploadStream.on('error', reject);
    });

    const row = {
      id: newId('note'), subject: String(subject).trim(), title: String(title).trim(),
      description: (description || '').trim(), file_id: uploadStream.id, file_name: req.file.originalname,
      file_size: req.file.size, file_mime: req.file.mimetype, file_kind: fileKind,
      allow_download: allow_download === 'true' || allow_download === true, ...target,
      author_username: req.user.username, author_name: req.user.name, created_at: Date.now()
    };
    await Notes.insertOne(row);
    const { _id, file_id, ...clean } = row;
    res.status(201).json({ note: { ...clean, file_id: String(file_id) } });
    const audience = await usersForTarget(row.college_id, row.target_department, row.target_year, row.target_section_id, req.user.username);
    notifyUsers(audience, {
      college_id: row.college_id, tab: 'notes', type: 'note_added',
      title: 'New note: ' + row.title, message: row.author_name + ' uploaded a note in ' + row.subject + '.', related_id: row.id
    }).catch(err => console.error('notify failed', err));
  }));

  // IDOR fix: same visibilityFilter() scoping as the list route and the
  // bookmark route above — a note's file can only be streamed to a user who
  // could already see that note through GET /api/notes. Without this, a
  // student from College A could download College B's (or another
  // department's) private note file just by knowing/guessing its id.
  app.get('/api/notes/:id/file', requireAuth, ah(async (req, res) => {
    const scope = await visibilityFilter(req.user);
    const note = await Notes.findOne({ id: req.params.id, ...scope });
    if (!note || !note.file_id) return res.status(404).json({ error: 'This file is not available.' });
    res.setHeader('Content-Type', note.file_mime || 'application/octet-stream');
    const disposition = note.allow_download ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${note.file_name || 'note'}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const stream = noteBucket.openDownloadStream(new ObjectId(note.file_id));
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'This file is not available.' }); });
    stream.pipe(res);
  }));

  app.delete('/api/notes/:id', requireAuth, ah(async (req, res) => {
    const row = await Notes.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!canManageContent(req.user, row)) return res.status(403).json({ error: 'You do not have permission to remove this.' });
    if (row.file_id) await noteBucket.delete(new ObjectId(row.file_id)).catch(() => {});
    await Notes.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // ---------- Events (college-wide) ----------
  app.get('/api/events', requireAuth, ah(async (req, res) => {
    const rows = await Events.find(await visibilityFilter(req.user)).sort({ date: 1 }).toArray();
    const withRsvps = rows.map(ev => {
      const { _id, rsvps, poster_id, ...clean } = ev;
      const list = rsvps || [];
      return { ...clean, rsvp_count: list.length, rsvped: list.includes(req.user.username), has_poster: !!poster_id };
    });
    res.json({ events: withRsvps });
  }));

  app.post('/api/events', requireAuth, requireRole('college_admin', 'hod', 'faculty'), uploadLimiter, uploadImage.single('poster'), ah(async (req, res) => {
    const { title, description, date, time, venue } = req.body || {};
    if (!title || !date) return res.status(400).json({ error: 'Title and date are required.' });
    const todayStr = new Date().toISOString().slice(0, 10);
    if (String(date) < todayStr) return res.status(400).json({ error: 'Event date cannot be in the past.' });
    const target = await buildTarget(req.user, req.body || {});
    if (target.error) return res.status(400).json({ error: target.error });
    let posterId = null;
    if (req.file) {
      const uploadStream = posterBucket.openUploadStream(req.file.originalname, { contentType: req.file.mimetype });
      await new Promise((resolve, reject) => {
        uploadStream.end(req.file.buffer, err => (err ? reject(err) : resolve()));
        uploadStream.on('error', reject);
      });
      posterId = uploadStream.id;
    }
    const row = {
      id: newId('ev'), title: String(title).trim(), description: (description || '').trim(), date,
      time: (time || '').trim(), venue: (venue || '').trim(), ...target,
      author_username: req.user.username, author_name: req.user.name, author_role: req.user.role,
      created_at: Date.now(), rsvps: [], poster_id: posterId
    };
    await Events.insertOne(row);
    const { _id, rsvps, poster_id, ...clean } = row;
    res.status(201).json({ event: { ...clean, rsvp_count: 0, rsvped: false, has_poster: !!posterId } });
    const audience = await usersForTarget(row.college_id, row.target_department, row.target_year, row.target_section_id, req.user.username);
    notifyUsers(audience, {
      college_id: row.college_id, tab: 'events', type: 'event_added',
      title: 'New event: ' + row.title, message: row.author_name + ' scheduled a new event.', related_id: row.id
    }).catch(err => console.error('notify failed', err));
  }));

  app.get('/api/events/:id/poster', requireAuth, ah(async (req, res) => {
    const event = await Events.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!event || !event.poster_id) return res.status(404).json({ error: 'No poster for this event.' });
    res.setHeader('Cache-Control', 'private, max-age=600');
    const stream = posterBucket.openDownloadStream(new ObjectId(event.poster_id));
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'No poster for this event.' }); });
    stream.pipe(res);
  }));

  app.delete('/api/events/:id', requireAuth, ah(async (req, res) => {
    const row = await Events.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!canManageContent(req.user, row)) return res.status(403).json({ error: 'You do not have permission to remove this.' });
    if (row.poster_id) await posterBucket.delete(new ObjectId(row.poster_id)).catch(() => {});
    const galleryFiles = await db.collection('event_gallery.files').find({ 'metadata.event_id': req.params.id }, { projection: { _id: 1 } }).toArray();
    await Promise.all(galleryFiles.map(f => eventGalleryBucket.delete(f._id).catch(() => {})));
    await Events.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  app.post('/api/events/:id/rsvp', requireAuth, requireRole('student'), ah(async (req, res) => {
    const event = await Events.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!event) return res.status(404).json({ error: 'Not found.' });
    const todayStr = new Date().toISOString().slice(0, 10);
    if (String(event.date) < todayStr) return res.status(400).json({ error: 'This event has already been completed.' });
    const has = (event.rsvps || []).includes(req.user.username);
    await Events.updateOne({ id: req.params.id }, has ? { $pull: { rsvps: req.user.username } } : { $addToSet: { rsvps: req.user.username } });
    const updated = await Events.findOne({ id: req.params.id });
    res.json({ rsvp_count: (updated.rsvps || []).length, rsvped: !has });
  }));

  app.get('/api/events/:id/rsvps.csv', requireAuth, requireRole('college_admin', 'hod', 'faculty'), ah(async (req, res) => {
    const event = await Events.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!event) return res.status(404).json({ error: 'Not found.' });
    const usernames = event.rsvps || [];
    const students = usernames.length ? await Users.find({ username: { $in: usernames } }, { projection: { _id: 0, name: 1, username: 1, roll_number: 1, department: 1 } }).toArray() : [];
    const escCsv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['Name,Username,Roll Number,Department'];
    for (const s of students) lines.push([escCsv(s.name), escCsv(s.username), escCsv(s.roll_number), escCsv(s.department)].join(','));
    const safeFileName = event.title.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'event';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}-rsvps.csv"`);
    res.send(lines.join('\r\n'));
  }));

  // ---------- Event gallery (photos from this and previous years) ----------
  // Same GridFS-backed pattern as the club gallery: anyone who can see the
  // event can browse its photos; only whoever can manage the event (its
  // author, or the college admin / HOD who could also remove it) can add or
  // remove photos, since this is the official archive for the recurring
  // event, not an open student upload wall.
  app.get('/api/events/:id/gallery', requireAuth, ah(async (req, res) => {
    const event = await Events.findOne({ id: req.params.id });
    if (!event || event.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const files = await db.collection('event_gallery.files').find({ 'metadata.event_id': req.params.id }).sort({ 'metadata.year': -1, uploadDate: -1 }).toArray();
    res.json({
      images: files.map(f => ({
        id: String(f._id), year: f.metadata.year || null, caption: f.metadata.caption || '',
        uploaded_by: f.metadata.uploaded_by, uploaded_by_name: f.metadata.uploaded_by_name, created_at: f.metadata.created_at
      }))
    });
  }));

  app.post('/api/events/:id/gallery', requireAuth, uploadLimiter, uploadImage.single('image'), ah(async (req, res) => {
    const event = await Events.findOne({ id: req.params.id });
    if (!event || event.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!canManageContent(req.user, event)) return res.status(403).json({ error: 'You do not have permission to add photos to this event.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a photo to upload.' });
    const uploadStream = eventGalleryBucket.openUploadStream(req.file.originalname, {
      contentType: req.file.mimetype,
      metadata: {
        event_id: req.params.id, year: (req.body.year || '').trim().slice(0, 9), caption: (req.body.caption || '').trim(),
        uploaded_by: req.user.username, uploaded_by_name: req.user.name, created_at: Date.now()
      }
    });
    await new Promise((resolve, reject) => {
      uploadStream.end(req.file.buffer, err => (err ? reject(err) : resolve()));
      uploadStream.on('error', reject);
    });
    res.status(201).json({ image: { id: String(uploadStream.id), year: (req.body.year || '').trim(), caption: (req.body.caption || '').trim() } });
  }));

  // IDOR fix: this previously streamed any GridFS file by :imgId with zero
  // ownership check — an authenticated user from any college could download
  // any other college's event photo just by guessing/incrementing the id.
  // The file's own metadata.event_id is looked up first so its parent event
  // (and that event's college) can be verified before anything is streamed.
  app.get('/api/events/:id/gallery/:imgId/file', requireAuth, ah(async (req, res) => {
    let fileObjectId;
    try { fileObjectId = new ObjectId(req.params.imgId); } catch { return res.status(404).end(); }
    const file = await db.collection('event_gallery.files').findOne({ _id: fileObjectId });
    if (!file || file.metadata.event_id !== req.params.id) return res.status(404).end();
    const event = await Events.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!event) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=600');
    const stream = eventGalleryBucket.openDownloadStream(fileObjectId);
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
    stream.pipe(res);
  }));

  app.delete('/api/events/:id/gallery/:imgId', requireAuth, ah(async (req, res) => {
    const event = await Events.findOne({ id: req.params.id });
    if (!event) return res.status(404).json({ error: 'Not found.' });
    const file = await db.collection('event_gallery.files').findOne({ _id: new ObjectId(req.params.imgId) });
    if (!file) return res.status(404).json({ error: 'Not found.' });
    if (file.metadata.uploaded_by !== req.user.username && !canManageContent(req.user, event)) return res.status(403).json({ error: 'You do not have permission to remove this photo.' });
    await eventGalleryBucket.delete(new ObjectId(req.params.imgId));
    res.json({ ok: true });
  }));

  // ---------- Public Board (complaints, opinions, lost & found) ----------
  async function serializePost(row, requestingUser) {
    const replyCount = await PostReplies.countDocuments({ post_id: row.id });
    const canSeeRoll = ['college_admin', 'hod', 'faculty'].includes(requestingUser.role) || requestingUser.username === row.author_username;
    return { ...stripId(row), roll_number: canSeeRoll ? row.roll_number : null, reply_count: replyCount };
  }
  function canManagePost(user, row) {
    if (row.author_username === user.username) return true;
    return ['college_admin', 'hod', 'faculty'].includes(user.role) && row.college_id === user.college_id;
  }

  app.get('/api/posts', requireAuth, ah(async (req, res) => {
    const filter = req.user.role === 'super_admin' ? { college_id: '__none__' } : { college_id: req.user.college_id };
    const rows = await Posts.find(filter).sort({ created_at: -1 }).toArray();
    res.json({ posts: await Promise.all(rows.map(r => serializePost(r, req.user))) });
  }));

  app.get('/api/posts/:id', requireAuth, ah(async (req, res) => {
    const row = await Posts.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'This post no longer exists.' });
    const replies = await PostReplies.find({ post_id: req.params.id }).sort({ created_at: 1 }).toArray();
    res.json({ post: await serializePost(row, req.user), replies: replies.map(stripId) });
  }));

  app.post('/api/posts', requireAuth, requireRole('hod', 'faculty', 'student'), ah(async (req, res) => {
    const { type, title, body, roll_number } = req.body || {};
    if (!['complaint', 'opinion', 'lost_found'].includes(type)) return res.status(400).json({ error: 'Choose a valid post type.' });
    if (!title || !body) return res.status(400).json({ error: 'Title and details are required.' });
    let cleanRoll = (roll_number || '').trim();
    if (req.user.role === 'student') {
      cleanRoll = req.user.roll_number || cleanRoll;
      if (!cleanRoll) return res.status(400).json({ error: 'Your account has no roll number on file — contact your HOD.' });
    } else {
      cleanRoll = null;
    }
    const row = {
      id: newId('post'), type, title: String(title).trim(), body: String(body).trim(),
      roll_number: cleanRoll, status: 'open', college_id: req.user.college_id,
      author_username: req.user.username, author_name: req.user.name, author_role: req.user.role, created_at: Date.now()
    };
    await Posts.insertOne(row);
    res.status(201).json({ post: await serializePost(row, req.user) });
  }));

  app.patch('/api/posts/:id/status', requireAuth, ah(async (req, res) => {
    const row = await Posts.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!canManagePost(req.user, row)) return res.status(403).json({ error: 'Only the poster, faculty, HOD, or admin can update this.' });
    const nextStatus = row.status === 'open' ? 'resolved' : 'open';
    await Posts.updateOne({ id: req.params.id }, { $set: { status: nextStatus } });
    const updated = await Posts.findOne({ id: req.params.id });
    res.json({ post: await serializePost(updated, req.user) });
    if (row.author_username !== req.user.username) {
      notifyUsers([row.author_username], {
        college_id: row.college_id, tab: 'board', type: 'post_status',
        title: 'Post ' + nextStatus, message: 'Your post "' + row.title + '" was marked ' + nextStatus + '.', related_id: row.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  app.delete('/api/posts/:id', requireAuth, ah(async (req, res) => {
    const row = await Posts.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!canManagePost(req.user, row)) return res.status(403).json({ error: 'You do not have permission to remove this post.' });
    await Posts.deleteOne({ id: req.params.id });
    await PostReplies.deleteMany({ post_id: req.params.id });
    res.json({ ok: true });
  }));

  app.post('/api/posts/:id/replies', requireAuth, requireRole('hod', 'faculty', 'student'), ah(async (req, res) => {
    const post = await Posts.findOne({ id: req.params.id });
    if (!post) return res.status(404).json({ error: 'This post no longer exists.' });
    const { body } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: 'Write a reply before sending.' });
    const row = {
      id: newId('reply'), post_id: req.params.id, body: String(body).trim(),
      author_username: req.user.username, author_name: req.user.name, author_role: req.user.role, created_at: Date.now()
    };
    await PostReplies.insertOne(row);
    res.status(201).json({ reply: stripId(row) });
    if (post.author_username !== req.user.username) {
      notifyUsers([post.author_username], {
        college_id: post.college_id, tab: 'board', type: 'post_reply',
        title: 'New reply on "' + post.title + '"', message: req.user.name + ' replied to your post.', related_id: post.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  app.delete('/api/posts/:id/replies/:replyId', requireAuth, ah(async (req, res) => {
    const reply = await PostReplies.findOne({ id: req.params.replyId, post_id: req.params.id });
    if (!reply) return res.status(404).json({ error: 'Not found.' });
    if (!canManagePost(req.user, reply)) return res.status(403).json({ error: 'You do not have permission to remove this reply.' });
    await PostReplies.deleteOne({ id: req.params.replyId });
    res.json({ ok: true });
  }));

  // =====================================================================
  // NEW: CLUBS — join/leave, club updates, member list, photo gallery,
  // leader selection, faculty-managed rosters, and inter-club competitions.
  // Any signed-in college member (hod/faculty/student) can browse & join.
  // College Admin, HOD, and Faculty can create clubs. The creator, plus
  // college_admin/hod for that college, can fully manage (edit/delete) a
  // club; faculty in general can additionally add students to any club in
  // their college, matching "faculty add students to existing clubs".
  // =====================================================================
  function canManageClub(user, club) {
    if (club.created_by === user.username) return true;
    return ['college_admin', 'hod'].includes(user.role) && club.college_id === user.college_id;
  }
  // NEW: one club per student (spec item 7). A student can only ever be a
  // member (leader or regular member) of a single club at a time. Returns
  // the club they're already in (excluding excludeClubId, so re-entering
  // the same club's own flow doesn't false-positive), or null.
  async function findStudentsCurrentClub(username, college_id, excludeClubId) {
    const filter = { college_id, member_usernames: username };
    if (excludeClubId) filter.id = { $ne: excludeClubId };
    return Clubs.findOne(filter, { projection: { id: 1, name: 1 } });
  }
  // NEW (spec item 1): a faculty member creating a club may only pick a
  // Club Leader from students assigned to them (req.user.section_ids) —
  // never the whole college roster. HOD/College Admin are not restricted
  // this way — they already oversee more than a single section.
  async function assertEligibleLeaderCandidate(user, leaderUser) {
    if (user.role !== 'faculty') return null;
    const sectionIds = user.section_ids || [];
    if (!leaderUser.section_id || !sectionIds.includes(leaderUser.section_id)) {
      return 'You can only choose a Club Leader from the students assigned to you.';
    }
    return null;
  }
  // Adding members to a roster is a lighter-weight permission than full
  // club management — any faculty in the college can do it (per spec),
  // on top of whoever can already fully manage the club.
  function canAddClubMembers(user, club) {
    if (canManageClub(user, club)) return true;
    return user.role === 'faculty' && club.college_id === user.college_id;
  }
  // NEW: the club join code is a secret. It's visible to whoever can manage
  // the club (the faculty who created it, plus hod/college_admin), and —
  // once the designated leader has actually activated the club by entering
  // it — to the current Club Leader too, so they can hand it on to members.
  // Nobody else, including regular members, ever sees it.
  function canSeeClubCode(user, club) {
    if (canManageClub(user, club)) return true;
    return club.leader_confirmed && club.leader_username === user.username;
  }
  const CLUB_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids mis-typing
  function generateClubCode() {
    let code = '';
    for (let i = 0; i < 8; i++) code += CLUB_CODE_CHARS[crypto.randomInt(CLUB_CODE_CHARS.length)];
    return code;
  }
  async function serializeClub(club, requestingUser) {
    const { _id, member_usernames, posts, join_code, ...rest } = club;
    const members = member_usernames || [];
    const galleryCount = await db.collection('club_gallery.files').countDocuments({ 'metadata.club_id': club.id }).catch(() => 0);
    const canSeeCode = canSeeClubCode(requestingUser, club);
    return {
      ...rest, member_count: members.length, is_member: members.includes(requestingUser.username),
      is_leader: !!club.leader_username && club.leader_confirmed && club.leader_username === requestingUser.username,
      is_full: members.length >= club.max_members,
      can_manage: canManageClub(requestingUser, club), can_add_members: canAddClubMembers(requestingUser, club),
      can_see_code: canSeeCode, join_code: canSeeCode ? join_code : null,
      gallery_count: galleryCount
    };
  }

  app.get('/api/clubs', requireAuth, ah(async (req, res) => {
    if (req.user.role === 'super_admin') return res.json({ clubs: [] });
    const rows = await Clubs.find({ college_id: req.user.college_id }).sort({ created_at: -1 }).toArray();
    res.json({ clubs: await Promise.all(rows.map(c => serializeClub(c, req.user))) });
  }));

  // NEW (spec item 1): who a Club Leader can be picked from, for the
  // create/edit-club form. Faculty see only students assigned to them
  // (their section_ids); HOD/College Admin see the whole college roster.
  // Each row includes name/username and roll number, per spec.
  app.get('/api/clubs/leader-candidates', requireAuth, requireRole('college_admin', 'hod', 'faculty'), ah(async (req, res) => {
    const filter = { college_id: req.user.college_id, role: 'student' };
    if (req.user.role === 'faculty') {
      const sectionIds = req.user.section_ids || [];
      filter.section_id = { $in: sectionIds };
    }
    const rows = await Users.find(filter, { projection: { name: 1, username: 1, roll_number: 1, section_id: 1, department: 1, _id: 0 } })
      .sort({ name: 1 }).toArray();
    res.json({ students: rows });
  }));

  // UPDATED: club creation now requires a Maximum Members count (the Club
  // Leader counts within that limit) and a Club Leader designation. The
  // designated leader is NOT auto-enrolled — per spec, faculty hands them
  // the generated join code offline, and they only become an actual
  // (counted) member once they enter that code (see /api/clubs/join-by-code
  // below). Until then the club sits with leader_confirmed: false and an
  // empty roster.
  app.post('/api/clubs', requireAuth, requireRole('college_admin', 'hod', 'faculty'), ah(async (req, res) => {
    const { name, description, category, leader_username, max_members } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Club name is required.' });
    const maxMembers = Number(max_members);
    if (!Number.isInteger(maxMembers) || maxMembers < 1) {
      return res.status(400).json({ error: 'Maximum number of members must be a whole number of at least 1.' });
    }
    if (!leader_username || !String(leader_username).trim()) {
      return res.status(400).json({ error: 'Choose a student to be the Club Leader.' });
    }
    const leaderUser = await Users.findOne({ username: String(leader_username).trim(), college_id: req.user.college_id, role: 'student' });
    if (!leaderUser) return res.status(400).json({ error: 'Could not find that student for Club Leader.' });
    const leaderRestrictionError = await assertEligibleLeaderCandidate(req.user, leaderUser);
    if (leaderRestrictionError) return res.status(403).json({ error: leaderRestrictionError });
    const existingClub = await findStudentsCurrentClub(leaderUser.username, req.user.college_id);
    if (existingClub) {
      return res.status(400).json({ error: `${leaderUser.name} is already a member of ${existingClub.name}. A student can belong to only one club.` });
    }
    const row = {
      id: newId('club'), name: String(name).trim(), description: (description || '').trim(),
      category: (category || 'General').trim(), college_id: req.user.college_id,
      created_by: req.user.username, created_by_name: req.user.name, created_at: Date.now(),
      max_members: maxMembers,
      leader_username: leaderUser.username, leader_name: leaderUser.name, leader_confirmed: false,
      join_code: generateClubCode(),
      member_usernames: [], posts: []
    };
    await Clubs.insertOne(row);
    res.status(201).json({ club: await serializeClub(row, req.user) });
    notifyUsers([leaderUser.username], {
      college_id: req.user.college_id, tab: 'clubs', type: 'club_leader_designated',
      title: 'You were picked as Club Leader for ' + row.name,
      message: 'Ask ' + req.user.name + ' for your club join code to activate your leadership.', related_id: row.id
    }).catch(err => console.error('notify failed', err));
  }));

  // NEW: multi-club Excel bulk creation (spec PART 6-15). One row per
  // student; rows are grouped by "Club Name" and each group becomes one
  // club. Same permission as manual club creation (college_admin/hod/
  // faculty), and faculty are still restricted to picking a Club Leader
  // from their own assigned sections (assertEligibleLeaderCandidate,
  // defined above) — the Excel path goes through the exact same check as
  // the manual "New club" form.
  //
  // Flow: upload → /import/preview (parse+validate, detect clubs, nothing
  // written) → user enters common details (+ optional per-club overrides)
  // → /import (re-validates from scratch, then creates every club that
  // still passes in one batch; one club's failure never blocks another).
  async function eligibleLeaderCheckFor(user) {
    return async (leaderDoc) => assertEligibleLeaderCandidate(user, leaderDoc);
  }

  app.post('/api/clubs/import/preview', requireAuth, requireRole('college_admin', 'hod', 'faculty'), uploadLimiter, uploadStudentSheet.single('file'), ah(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Please attach an Excel (.xlsx/.xls) or CSV file.' });
    const parsed = bulkImport.parseClubSheet(XLSX, req.file.buffer);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const check = await eligibleLeaderCheckFor(req.user);
    const validation = await bulkImport.validateClubRows({ Users, Clubs, rows: parsed.rows, collegeId: req.user.college_id, eligibleLeaderCheck: check });
    res.json({
      total_clubs: validation.clubs.length,
      valid_count: validation.clubs.filter((c) => c.valid).length,
      invalid_count: validation.clubs.filter((c) => !c.valid).length,
      clubs: validation.clubs.map((c) => ({
        name: c.name, member_count: c.member_count,
        leader: c.leader ? { username: c.leader.username, name: c.leader.name, roll_number: c.leader.roll_number } : null,
        members: c.members.map((m) => ({ row: m.row, roll_number: m.roll_number, name: m.name, is_leader: m.is_leader })),
        valid: c.valid, errors: c.errors
      })),
      row_errors: validation.row_errors
    });
  }));

  // Body (multipart): file, common (JSON string: {description?, category?,
  // max_members}), overrides (optional JSON string keyed by club name, same
  // shape as `common` — only the fields present override the common value
  // for that one club).
  app.post('/api/clubs/import', requireAuth, requireRole('college_admin', 'hod', 'faculty'), uploadLimiter, uploadStudentSheet.single('file'), ah(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Please attach an Excel (.xlsx/.xls) or CSV file.' });
    const parsed = bulkImport.parseClubSheet(XLSX, req.file.buffer);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let common = {};
    let overrides = {};
    try {
      if (req.body.common) common = JSON.parse(req.body.common);
      if (req.body.overrides) overrides = JSON.parse(req.body.overrides);
    } catch (err) {
      return res.status(400).json({ error: 'Could not read the club details submitted with the file.' });
    }

    const check = await eligibleLeaderCheckFor(req.user);
    const result = await bulkImport.createClubsFromImport({
      Users, Clubs, rows: parsed.rows, user: req.user, common, overrides,
      newId, generateClubCode, eligibleLeaderCheck: check
    });

    res.json({
      total_clubs: result.total_clubs, created_count: result.created_count, failed_count: result.failed_count,
      created: result.created.map((c) => ({ id: c.id, name: c.name, member_count: c.member_count })),
      failed: result.failed, row_errors: result.row_errors
    });

    for (const c of result.created) {
      notifyUsers([c.leader_username], {
        college_id: req.user.college_id, tab: 'clubs', type: 'club_leader_designated',
        title: 'You were picked as Club Leader for ' + c.name,
        message: req.user.name + ' created ' + c.name + ' and made you the Club Leader.', related_id: c.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  // NEW: downloadable starter templates (spec PART 17) — student and club
  // sheets, header row only (plus a separate Instructions sheet with a
  // worked example) so a template can never be uploaded with sample rows
  // still in it.
  app.get('/api/students/import/template', requireAuth, requireRole('hod', 'faculty', 'ao'), ah(async (req, res) => {
    const buf = bulkImport.buildStudentTemplate(XLSX);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="student-import-template.xlsx"');
    res.send(buf);
  }));
  app.get('/api/clubs/import/template', requireAuth, requireRole('college_admin', 'hod', 'faculty'), ah(async (req, res) => {
    const buf = bulkImport.buildClubTemplate(XLSX);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="club-import-template.xlsx"');
    res.send(buf);
  }));

  // Edit a club's details, and optionally set/clear its (optional) team
  // leader. Setting a leader auto-enrolls them as a member if needed.
  // NEW (spec item 6): the confirmed Club Leader may rename their own club
  // even though they otherwise can't "manage" it — every other field below
  // stays gated behind canManageClub. Authorization is re-checked here on
  // the backend regardless of anything the client claims about the user.
  function isConfirmedLeaderOfClub(user, club) {
    return !!club.leader_username && club.leader_confirmed && club.leader_username === user.username;
  }
  app.patch('/api/clubs/:id', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const canManage = canManageClub(req.user, club);
    const isLeader = isConfirmedLeaderOfClub(req.user, club);
    if (!canManage && !isLeader) return res.status(403).json({ error: 'You do not have permission to edit this club.' });
    const body = req.body || {};
    // A club leader who isn't otherwise a manager may only ever change the
    // name — reject the request outright if they send anything else,
    // rather than silently ignoring fields they tried to change.
    if (isLeader && !canManage) {
      const allowedKeys = Object.keys(body).filter(k => body[k] !== undefined);
      const disallowed = allowedKeys.filter(k => k !== 'name');
      if (disallowed.length) return res.status(403).json({ error: 'As Club Leader you can only change the club name.' });
    }
    const { name, description, category, leader_username, max_members } = body;
    const update = {};
    if (name !== undefined) {
      // Duplicate-name handling per the club's existing rules: club
      // creation never enforced unique names, so renames don't either —
      // just require a non-empty name, same as before.
      const trimmedName = String(name).trim();
      if (!trimmedName) return res.status(400).json({ error: 'Club name is required.' });
      update.name = trimmedName;
    }
    if (description !== undefined) update.description = String(description).trim();
    if (category !== undefined) update.category = String(category).trim() || 'General';
    if (max_members !== undefined) {
      const maxMembers = Number(max_members);
      if (!Number.isInteger(maxMembers) || maxMembers < 1) return res.status(400).json({ error: 'Maximum number of members must be a whole number of at least 1.' });
      if (maxMembers < (club.member_usernames || []).length) {
        return res.status(400).json({ error: 'This club already has more members than that. Remove members first, or choose a higher limit.' });
      }
      update.max_members = maxMembers;
    }
    // Reassigning who the Club Leader is meant to be is only allowed before
    // the club has been activated — once a leader has confirmed by entering
    // the join code, leadership can only move via /transfer-leader below,
    // which requires the new leader to already be an actual member.
    if (leader_username !== undefined) {
      if (club.leader_confirmed) return res.status(400).json({ error: 'This club already has an active leader — use "Transfer leadership" instead.' });
      const trimmed = String(leader_username || '').trim();
      if (!trimmed) return res.status(400).json({ error: 'Choose a student to be the Club Leader.' });
      const leaderUser = await Users.findOne({ username: trimmed, college_id: req.user.college_id, role: 'student' });
      if (!leaderUser) return res.status(400).json({ error: 'Could not find that student for Club Leader.' });
      const leaderRestrictionError = await assertEligibleLeaderCandidate(req.user, leaderUser);
      if (leaderRestrictionError) return res.status(403).json({ error: leaderRestrictionError });
      const existingClub = await findStudentsCurrentClub(leaderUser.username, req.user.college_id, club.id);
      if (existingClub) {
        return res.status(400).json({ error: `${leaderUser.name} is already a member of ${existingClub.name}. A student can belong to only one club.` });
      }
      update.leader_username = leaderUser.username;
      update.leader_name = leaderUser.name;
    }
    if (Object.keys(update).length) await Clubs.updateOne({ id: req.params.id }, { $set: update });
    const fresh = await Clubs.findOne({ id: req.params.id });
    res.json({ club: await serializeClub(fresh, req.user) });
    if (update.leader_username && update.leader_username !== club.leader_username) {
      notifyUsers([update.leader_username], {
        college_id: club.college_id, tab: 'clubs', type: 'club_leader_designated',
        title: 'You were picked as Club Leader for ' + fresh.name,
        message: 'Ask ' + req.user.name + ' for your club join code to activate your leadership.', related_id: club.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  app.delete('/api/clubs/:id', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club) return res.status(404).json({ error: 'Not found.' });
    if (!canManageClub(req.user, club)) return res.status(403).json({ error: 'You do not have permission to remove this club.' });
    const files = await db.collection('club_gallery.files').find({ 'metadata.club_id': club.id }, { projection: { _id: 1 } }).toArray();
    await Promise.all(files.map(f => galleryBucket.delete(f._id).catch(() => {})));
    await Clubs.deleteOne({ id: req.params.id });
    await ClubQuizParticipants.deleteMany({ club_id: club.id });
    res.json({ ok: true });
  }));

  // NEW (spec item 1): bulk club removal — "Remove Selected" (ids) or
  // "Remove All" (remove_all), mirroring the bulk-delete pattern already
  // used for students/faculty/HOD/AO elsewhere in this file. Scoped to the
  // caller's own college and, per club, to whoever canManageClub already
  // allows — never students or any other unrelated data, and a club this
  // user can't manage is silently skipped rather than failing the batch.
  app.post('/api/clubs/bulk-delete', requireAuth, requireRole('college_admin', 'hod', 'faculty'), ah(async (req, res) => {
    const { ids, remove_all } = req.body || {};
    const filter = { college_id: req.user.college_id };
    if (!remove_all) {
      const idList = Array.isArray(ids) ? ids.filter(Boolean) : [];
      if (!idList.length) return res.status(400).json({ error: 'No clubs selected.' });
      filter.id = { $in: idList };
    }
    const candidates = await Clubs.find(filter).toArray();
    const removable = candidates.filter(c => canManageClub(req.user, c));
    let removed = 0;
    for (const club of removable) {
      const files = await db.collection('club_gallery.files').find({ 'metadata.club_id': club.id }, { projection: { _id: 1 } }).toArray();
      await Promise.all(files.map(f => galleryBucket.delete(f._id).catch(() => {})));
      await Clubs.deleteOne({ id: club.id });
      await ClubQuizParticipants.deleteMany({ club_id: club.id });
      removed++;
    }
    const skipped = candidates.length - removable.length;
    res.json({ ok: true, removed, skipped });
  }));

  app.get('/api/clubs/:id', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const memberUsers = club.member_usernames.length
      ? await Users.find({ username: { $in: club.member_usernames } }, { projection: { name: 1, username: 1, role: 1, _id: 0 } }).toArray()
      : [];
    res.json({ club: await serializeClub(club, req.user), members: memberUsers, posts: (club.posts || []).slice().reverse() });
  }));

  // UPDATED: open self-join without a code is now limited to HOD/Faculty
  // (an oversight/mentor joining a club they can already see everything
  // about). Students must go through the join code, below — the whole
  // point of the code is that students can't just self-serve onto a
  // roster and blow past the Maximum Members limit.
  app.post('/api/clubs/:id/join', requireAuth, requireRole('hod', 'faculty'), ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    // NEW (spec item 4): the faculty member who created a club manages it —
    // they never "join" their own club the way a member would.
    if (club.created_by === req.user.username) {
      return res.status(400).json({ error: 'You created this club — you manage it, you do not join it.' });
    }
    if ((club.member_usernames || []).length >= club.max_members) {
      return res.status(400).json({ error: 'Club is full. Maximum member limit has been reached.' });
    }
    await Clubs.updateOne({ id: req.params.id }, { $addToSet: { member_usernames: req.user.username } });
    res.json({ ok: true });
    if (club.created_by !== req.user.username) {
      notifyUsers([club.created_by], {
        college_id: club.college_id, tab: 'clubs', type: 'club_join',
        title: 'New member in ' + club.name, message: req.user.name + ' joined ' + club.name + '.', related_id: club.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  app.post('/api/clubs/:id/leave', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club) return res.status(404).json({ error: 'Not found.' });
    if (club.leader_confirmed && club.leader_username === req.user.username) {
      return res.status(400).json({ error: 'Transfer leadership to another member before leaving this club.' });
    }
    await Clubs.updateOne({ id: req.params.id }, { $pull: { member_usernames: req.user.username } });
    res.json({ ok: true });
  }));

  // NEW: the code-gated join flow (spec items 2–5). Any signed-in college
  // member can call this with a code — what happens depends on the club's
  // current state:
  //  - Not yet activated: only the student faculty designated as Club
  //    Leader may enter it, and doing so both enrolls them and activates
  //    the club (leader_confirmed: true), and the code becomes visible to
  //    them from here on (see canSeeClubCode above).
  //  - Already activated: anyone not yet a member joins as a regular
  //    member, subject to the Maximum Members cap.
  app.post('/api/clubs/join-by-code', requireAuth, requireRole('hod', 'faculty', 'student'), ah(async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Enter a club code.' });
    const club = await Clubs.findOne({ college_id: req.user.college_id, join_code: code });
    if (!club) return res.status(404).json({ error: 'That code did not match any club.' });

    if (!club.leader_confirmed) {
      if (club.leader_username !== req.user.username) {
        return res.status(403).json({ error: 'This code is reserved for the student chosen as Club Leader.' });
      }
      if (req.user.role === 'student') {
        const existingClub = await findStudentsCurrentClub(req.user.username, req.user.college_id, club.id);
        if (existingClub) {
          return res.status(400).json({ error: `You are already a member of ${existingClub.name}. A student can belong to only one club.` });
        }
      }
      await Clubs.updateOne({ id: club.id }, { $set: { leader_confirmed: true }, $addToSet: { member_usernames: req.user.username } });
      const fresh = await Clubs.findOne({ id: club.id });
      res.json({ ok: true, role: 'leader', club: await serializeClub(fresh, req.user) });
      notifyUsers([club.created_by], {
        college_id: club.college_id, tab: 'clubs', type: 'club_activated',
        title: club.name + ' is now active', message: req.user.name + ' joined as Club Leader.', related_id: club.id
      }).catch(err => console.error('notify failed', err));
      return;
    }

    if ((club.member_usernames || []).includes(req.user.username)) {
      return res.status(400).json({ error: 'You are already a member of this club.' });
    }
    if (req.user.role === 'student') {
      const existingClub = await findStudentsCurrentClub(req.user.username, req.user.college_id, club.id);
      if (existingClub) {
        return res.status(400).json({ error: `You are already a member of ${existingClub.name}. A student can belong to only one club.` });
      }
    }
    if ((club.member_usernames || []).length >= club.max_members) {
      return res.status(400).json({ error: 'Club is full. Maximum member limit has been reached.' });
    }
    await Clubs.updateOne({ id: club.id }, { $addToSet: { member_usernames: req.user.username } });
    const fresh = await Clubs.findOne({ id: club.id });
    res.json({ ok: true, role: 'member', club: await serializeClub(fresh, req.user) });
    notifyUsers([club.leader_username, club.created_by], {
      college_id: club.college_id, tab: 'clubs', type: 'club_join',
      title: 'New member in ' + club.name, message: req.user.name + ' joined ' + club.name + '.', related_id: club.id
    }).catch(err => console.error('notify failed', err));
  }));

  // NEW: Club Leader hands off their role to another existing member.
  // Callable by the current leader themselves, or by whoever can fully
  // manage the club. There's always exactly one active leader.
  app.post('/api/clubs/:id/transfer-leader', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const isCurrentLeader = club.leader_confirmed && club.leader_username === req.user.username;
    if (!isCurrentLeader && !canManageClub(req.user, club)) {
      return res.status(403).json({ error: 'You do not have permission to transfer leadership of this club.' });
    }
    const newLeaderUsername = String(req.body?.username || '').trim();
    if (!newLeaderUsername) return res.status(400).json({ error: 'Choose a member to become the new Club Leader.' });
    if (newLeaderUsername === club.leader_username) return res.status(400).json({ error: 'That member is already the Club Leader.' });
    if (!(club.member_usernames || []).includes(newLeaderUsername)) {
      return res.status(400).json({ error: 'Only an existing club member can become the new Club Leader.' });
    }
    const newLeader = await Users.findOne({ username: newLeaderUsername, college_id: req.user.college_id });
    if (!newLeader) return res.status(400).json({ error: 'Could not find that member.' });
    const oldLeaderUsername = club.leader_username;
    await Clubs.updateOne({ id: club.id }, { $set: { leader_username: newLeader.username, leader_name: newLeader.name, leader_confirmed: true } });
    const fresh = await Clubs.findOne({ id: club.id });
    res.json({ club: await serializeClub(fresh, req.user) });
    notifyUsers([newLeader.username], {
      college_id: club.college_id, tab: 'clubs', type: 'club_leader',
      title: 'You are now Club Leader of ' + club.name, message: req.user.name + ' made you the Club Leader.', related_id: club.id
    }).catch(err => console.error('notify failed', err));
    if (oldLeaderUsername) {
      notifyUsers([oldLeaderUsername], {
        college_id: club.college_id, tab: 'clubs', type: 'club_leader_transferred',
        title: 'Leadership of ' + club.name + ' was transferred', message: newLeader.name + ' is now the Club Leader.', related_id: club.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  // ---------- Faculty/manager-driven roster management ----------
  // Search college students to add to a club roster (excludes existing
  // members). Open to anyone who can add members to this specific club.
  app.get('/api/clubs/:id/eligible-students', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!canAddClubMembers(req.user, club)) return res.status(403).json({ error: 'You do not have permission to add members to this club.' });
    const search = (req.query.search || '').trim();
    const filter = {
      college_id: req.user.college_id, role: 'student',
      username: { $nin: club.member_usernames || [] }
    };
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: re }, { username: re }, { roll_number: re }];
    }
    const rows = await Users.find(filter, { projection: { name: 1, username: 1, department: 1, section_id: 1, roll_number: 1, _id: 0 } })
      .sort({ name: 1 }).limit(25).toArray();
    res.json({ students: rows });
  }));

  // Add one or more students to a club's roster directly (no self-join
  // needed) — this is the "faculty add students to existing clubs" flow.
  app.post('/api/clubs/:id/members', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!canAddClubMembers(req.user, club)) return res.status(403).json({ error: 'You do not have permission to add members to this club.' });
    const usernames = req.body?.usernames ? [].concat(req.body.usernames) : (req.body?.username ? [req.body.username] : []);
    const cleaned = [...new Set(usernames.map(u => String(u || '').trim()).filter(Boolean))];
    if (!cleaned.length) return res.status(400).json({ error: 'Choose at least one student to add.' });
    const students = await Users.find({ username: { $in: cleaned }, college_id: req.user.college_id, role: 'student' }, { projection: { username: 1, name: 1, _id: 0 } }).toArray();
    if (!students.length) return res.status(400).json({ error: 'Could not find those students.' });
    // NEW (spec item 7): silently skip anyone already in a different club —
    // one club per student — and report who was skipped and why.
    const otherClubMemberships = await Clubs.find(
      { college_id: req.user.college_id, id: { $ne: club.id }, member_usernames: { $in: students.map(s => s.username) } },
      { projection: { name: 1, member_usernames: 1, _id: 0 } }
    ).toArray();
    const alreadyClubbed = new Map();
    for (const c of otherClubMemberships) {
      for (const u of c.member_usernames) alreadyClubbed.set(u, c.name);
    }
    const eligible = students.filter(s => !alreadyClubbed.has(s.username));
    const skipped = students.filter(s => alreadyClubbed.has(s.username)).map(s => ({ username: s.username, name: s.name, existing_club: alreadyClubbed.get(s.username) }));
    if (!eligible.length) {
      return res.status(400).json({ error: 'Every selected student already belongs to another club. A student can belong to only one club.', skipped });
    }
    const currentCount = (club.member_usernames || []).length;
    const newCount = new Set([...(club.member_usernames || []), ...eligible.map(s => s.username)]).size;
    if (newCount > club.max_members) {
      return res.status(400).json({ error: `Club is full. Maximum member limit has been reached. Room for ${Math.max(0, club.max_members - currentCount)} more.` });
    }
    await Clubs.updateOne({ id: req.params.id }, { $addToSet: { member_usernames: { $each: eligible.map(s => s.username) } } });
    res.json({ ok: true, added: eligible.map(s => s.username), skipped });
    notifyUsers(eligible.map(s => s.username), {
      college_id: club.college_id, tab: 'clubs', type: 'club_added',
      title: 'Added to ' + club.name, message: req.user.name + ' added you to ' + club.name + '.', related_id: club.id
    }).catch(err => console.error('notify failed', err));
  }));

  // Remove a member from a club's roster (manager action, not self-leave).
  app.delete('/api/clubs/:id/members/:username', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club) return res.status(404).json({ error: 'Not found.' });
    if (!canManageClub(req.user, club)) return res.status(403).json({ error: 'You do not have permission to remove members from this club.' });
    await Clubs.updateOne({ id: req.params.id }, { $pull: { member_usernames: req.params.username } });
    if (club.leader_username === req.params.username) {
      await Clubs.updateOne({ id: req.params.id }, { $set: { leader_username: null, leader_name: null, leader_confirmed: false } });
    }
    res.json({ ok: true });
  }));

  // Club announcements/updates — visible to anyone who can see the club,
  // postable by a member (keeps club chatter self-serve, like a mini board).
  app.post('/api/clubs/:id/posts', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!club.member_usernames.includes(req.user.username) && !canManageClub(req.user, club)) {
      return res.status(403).json({ error: 'Join the club to post an update.' });
    }
    const { body } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: 'Write something before posting.' });
    const post = { id: newId('cpost'), body: String(body).trim(), author_username: req.user.username, author_name: req.user.name, created_at: Date.now() };
    await Clubs.updateOne({ id: req.params.id }, { $push: { posts: post } });
    res.status(201).json({ post });
    const otherMembers = (club.member_usernames || []).filter(u => u !== req.user.username);
    notifyUsers(otherMembers, {
      college_id: club.college_id, tab: 'clubs', type: 'club_post',
      title: club.name + ' update', message: req.user.name + ' posted in ' + club.name + '.', related_id: club.id
    }).catch(err => console.error('notify failed', err));
  }));

  app.delete('/api/clubs/:id/posts/:postId', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club) return res.status(404).json({ error: 'Not found.' });
    const post = (club.posts || []).find(p => p.id === req.params.postId);
    if (!post) return res.status(404).json({ error: 'Not found.' });
    if (post.author_username !== req.user.username && !canManageClub(req.user, club)) return res.status(403).json({ error: 'You do not have permission to remove this.' });
    await Clubs.updateOne({ id: req.params.id }, { $pull: { posts: { id: req.params.postId } } });
    res.json({ ok: true });
  }));

  // ---------- Club gallery (photos) ----------
  app.get('/api/clubs/:id/gallery', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const files = await db.collection('club_gallery.files').find({ 'metadata.club_id': req.params.id }).sort({ uploadDate: -1 }).toArray();
    res.json({ images: files.map(f => ({ id: String(f._id), caption: f.metadata.caption || '', uploaded_by: f.metadata.uploaded_by, uploaded_by_name: f.metadata.uploaded_by_name, created_at: f.metadata.created_at })) });
  }));

  app.post('/api/clubs/:id/gallery', requireAuth, uploadLimiter, uploadImage.single('image'), ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!club.member_usernames.includes(req.user.username) && !canManageClub(req.user, club)) {
      return res.status(403).json({ error: 'Join the club to add photos.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a photo to upload.' });
    const uploadStream = galleryBucket.openUploadStream(req.file.originalname, {
      contentType: req.file.mimetype,
      metadata: { club_id: req.params.id, uploaded_by: req.user.username, uploaded_by_name: req.user.name, caption: (req.body.caption || '').trim(), created_at: Date.now() }
    });
    await new Promise((resolve, reject) => {
      uploadStream.end(req.file.buffer, err => (err ? reject(err) : resolve()));
      uploadStream.on('error', reject);
    });
    res.status(201).json({ image: { id: String(uploadStream.id), caption: (req.body.caption || '').trim() } });
  }));

  // IDOR fix: same issue and same fix as the events gallery file route above
  // — verify the file's parent club (and that club's college) before
  // streaming, instead of trusting :imgId alone.
  app.get('/api/clubs/:id/gallery/:imgId/file', requireAuth, ah(async (req, res) => {
    let fileObjectId;
    try { fileObjectId = new ObjectId(req.params.imgId); } catch { return res.status(404).end(); }
    const file = await db.collection('club_gallery.files').findOne({ _id: fileObjectId });
    if (!file || file.metadata.club_id !== req.params.id) return res.status(404).end();
    const club = await Clubs.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!club) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=600');
    const stream = galleryBucket.openDownloadStream(fileObjectId);
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
    stream.pipe(res);
  }));

  app.delete('/api/clubs/:id/gallery/:imgId', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club) return res.status(404).json({ error: 'Not found.' });
    const file = await db.collection('club_gallery.files').findOne({ _id: new ObjectId(req.params.imgId) });
    if (!file) return res.status(404).json({ error: 'Not found.' });
    if (file.metadata.uploaded_by !== req.user.username && !canManageClub(req.user, club)) return res.status(403).json({ error: 'You do not have permission to remove this photo.' });
    await galleryBucket.delete(new ObjectId(req.params.imgId));
    res.json({ ok: true });
  }));

  // =====================================================================
  // COMPETITION — fast-paced live quiz competitions, ranked CLUB vs CLUB
  // (spec items 8–17). Faculty (or hod/college_admin) author a quiz with
  // per-question options, correct answer, and a timer (max 60s/question).
  // A quiz is NOT scoped to one club — any student who already belongs to
  // a club (spec item 9) can join with the quiz code, but only ONE student
  // per club may represent that club in a given quiz (spec item 10); that
  // representative's answers score points on behalf of their whole club.
  // The live leaderboard and final results rank by Club Name, never by
  // the individual student's name (spec items 13, 15–17).
  //
  // All scoring/ranking is computed server-side from server clock time —
  // the client only ever sends "which option did I pick", never a score,
  // a rank, or a timer value — so nothing here trusts the frontend.
  //
  // This lives in its own two collections (ClubQuizzes, ClubQuizParticipants)
  // and is kept entirely separate from Tests/TestSubmissions and from
  // GET /api/leaderboard (the normal academic Campus Orbis leaderboard) —
  // per spec item 17, the two must never mix.
  // =====================================================================
  const CLUB_QUIZ_TOP_N_LIVE = 5;
  const CLUB_QUIZ_TOP_N_FINAL = 10;
  const CLUB_QUIZ_BETWEEN_MS = 5000; // how long the Top 5 shows before auto-advancing
  const CLUB_QUIZ_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function generateQuizCode() {
    let code = '';
    for (let i = 0; i < 8; i++) code += CLUB_QUIZ_CODE_CHARS[crypto.randomInt(CLUB_QUIZ_CODE_CHARS.length)];
    return code;
  }
  // Any faculty/hod/college_admin in the college may create a competition
  // quiz — it isn't tied to any single club, so no club-management right
  // is required, just being a faculty-tier account.
  function canCreateClubQuiz(user) {
    return ['faculty', 'hod', 'college_admin'].includes(user.role);
  }
  function canManageClubQuiz(user, quiz) {
    if (quiz.created_by === user.username) return true;
    return ['college_admin', 'hod'].includes(user.role) && quiz.college_id === user.college_id;
  }
  function validateQuizQuestions(input) {
    const list = Array.isArray(input) ? input : [];
    if (!list.length) return { error: 'Add at least one question.' };
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const q = list[i] || {};
      // Multi-line questions (incl. pasted code): keep every inner line
      // break, space and indentation. Only normalise CRLF -> LF and drop
      // blank lines / trailing whitespace at the very edges. Single-line
      // text is still fully trimmed, exactly as before.
      const rawText = String(q.text || '').replace(/\r\n?/g, '\n');
      if (!rawText.trim()) return { error: `Question ${i + 1}: question text is required.` };
      if (rawText.length > 5000) return { error: `Question ${i + 1}: question text is too long (max 5000 characters).` };
      const edged = rawText.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
      const text = edged.includes('\n') ? edged : edged.trim();
      const options = Array.isArray(q.options) ? q.options.map(o => String(o || '').trim()) : [];
      if (options.length < 2 || options.length > 6 || options.some(o => !o)) {
        return { error: `Question ${i + 1}: provide between 2 and 6 non-empty options.` };
      }
      const correctIndex = Number(q.correct_index);
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
        return { error: `Question ${i + 1}: choose a valid correct answer.` };
      }
      const timeLimit = Number(q.time_limit_seconds) || 30;
      if (!Number.isInteger(timeLimit) || timeLimit < 5 || timeLimit > 60) {
        return { error: `Question ${i + 1}: time limit must be between 5 and 60 seconds.` };
      }
      const maxPoints = q.max_points === undefined ? 10 : Number(q.max_points);
      if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 100) {
        return { error: `Question ${i + 1}: max points must be between 1 and 100.` };
      }
      out.push({ id: newId('cqq'), order: i, text, options, correct_index: correctIndex, time_limit_seconds: timeLimit, max_points: maxPoints });
    }
    return { questions: out };
  }
  // Ranked by club, not by student — every row here is one club's single
  // representative and that club's accumulated score.
  async function sortedQuizParticipants(quizId) {
    // Root-cause fix: this used to pull every participant row and sort it
    // in JS on every call. It's on the hot path — called from the session
    // endpoint on every 'between' poll tick from every connected client,
    // plus the leaderboard/final-results endpoints — so pushing the sort
    // down to MongoDB (covered by the {quiz_id,total_score,joined_at}
    // index added above) removes a per-request in-memory sort and lets
    // Mongo return already-ordered results straight off the index.
    return ClubQuizParticipants.find({ quiz_id: quizId }).sort({ total_score: -1, joined_at: 1 }).toArray();
  }
  // rankView keys off club_id (spec items 13, 16) — "mine" resolves to the
  // requesting user's own club's row, wherever it currently sits.
  function rankView(sortedRows, myClubId, limit) {
    // NEW (spec item 5): each row carries both the participant's chosen
    // display name and their club name, so the leaderboard can show them
    // together without touching the score/ranking logic below.
    const top = sortedRows.slice(0, limit).map((r, i) => ({ rank: i + 1, club_id: r.club_id, club_name: r.club_name, participant_name: r.display_name || r.name, logo: r.logo || null, points: r.total_score }));
    const myIndex = sortedRows.findIndex(r => r.club_id === myClubId);
    const mine = (myIndex >= 0 && myIndex >= limit)
      ? { rank: myIndex + 1, club_id: myClubId, club_name: sortedRows[myIndex].club_name, participant_name: sortedRows[myIndex].display_name || sortedRows[myIndex].name, logo: sortedRows[myIndex].logo || null, points: sortedRows[myIndex].total_score }
      : null;
    return { top, mine };
  }
  // Self-healing state machine: called on every read/write touching a quiz
  // so the live experience advances even though this app is polling-driven
  // rather than socket-driven. A question that has run out of time flips
  // to 'between' (showing the Top 5) as soon as anyone next asks about the
  // quiz; after CLUB_QUIZ_BETWEEN_MS that flips to the next question (or
  // 'finished' if that was the last one). Both transitions use an atomic
  // updateOne guarded by the expected current status, so two simultaneous
  // pollers can't double-advance the same quiz.
  async function checkAndAdvanceQuiz(quiz) {
    if (quiz.status === 'live') {
      const q = quiz.questions[quiz.current_index];
      const durationMs = q.time_limit_seconds * 1000;
      if (Date.now() - quiz.current_started_at >= durationMs) {
        const result = await ClubQuizzes.updateOne(
          { id: quiz.id, status: 'live' },
          { $set: { status: 'between', between_started_at: Date.now() } }
        );
        if (result.modifiedCount) quiz = await ClubQuizzes.findOne({ id: quiz.id });
      }
    }
    if (quiz.status === 'between') {
      if (Date.now() - quiz.between_started_at >= CLUB_QUIZ_BETWEEN_MS) {
        const nextIndex = quiz.current_index + 1;
        if (nextIndex >= quiz.questions.length) {
          const result = await ClubQuizzes.updateOne({ id: quiz.id, status: 'between' }, { $set: { status: 'finished', ended_at: Date.now() } });
          if (result.modifiedCount) quiz = await ClubQuizzes.findOne({ id: quiz.id });
        } else {
          const result = await ClubQuizzes.updateOne(
            { id: quiz.id, status: 'between' },
            { $set: { status: 'live', current_index: nextIndex, current_started_at: Date.now() } }
          );
          if (result.modifiedCount) quiz = await ClubQuizzes.findOne({ id: quiz.id });
        }
      }
    }
    return quiz;
  }
  function serializeQuizForBrowsing(quiz, user) {
    const { _id, quiz_code, questions, ...rest } = quiz;
    const canManage = canManageClubQuiz(user, quiz);
    return { ...rest, question_count: questions.length, can_manage: canManage, quiz_code: canManage ? quiz_code : null };
  }
  // The live/poll payload — never includes the correct answer for a
  // question that's still open, never includes upcoming questions, and
  // never reveals any other club's representative, only the ranking.
  async function serializeQuizSession(quiz, user, participant) {
    const isHost = canManageClubQuiz(user, quiz);
    const out = {
      id: quiz.id, title: quiz.title, status: quiz.status,
      logo: quiz.logo || null,
      total_questions: quiz.questions.length, current_index: quiz.current_index,
      is_host: isHost, joined: !!participant, my_score: participant ? participant.total_score : null,
      my_club_name: participant ? participant.club_name : null,
      my_display_name: participant ? (participant.display_name || participant.name) : null,
      my_logo: participant ? (participant.logo || null) : null,
      quiz_code: isHost ? quiz.quiz_code : null
    };
    if (quiz.status === 'lobby' && isHost) {
      out.participant_count = await ClubQuizParticipants.countDocuments({ quiz_id: quiz.id });
    }
    if (quiz.status === 'live') {
      const q = quiz.questions[quiz.current_index];
      const durationMs = q.time_limit_seconds * 1000;
      out.time_remaining_ms = Math.max(0, durationMs - (Date.now() - quiz.current_started_at));
      out.question = {
        id: q.id, index: quiz.current_index, text: q.text, options: q.options,
        time_limit_seconds: q.time_limit_seconds, max_points: q.max_points
      };
      out.answered = participant ? participant.answers.some(a => a.question_id === q.id) : false;
    } else if (quiz.status === 'between') {
      const q = quiz.questions[quiz.current_index];
      out.between_remaining_ms = Math.max(0, CLUB_QUIZ_BETWEEN_MS - (Date.now() - quiz.between_started_at));
      out.question_result = { id: q.id, text: q.text, options: q.options, correct_index: q.correct_index };
      const sorted = await sortedQuizParticipants(quiz.id);
      out.leaderboard = rankView(sorted, participant ? participant.club_id : null, CLUB_QUIZ_TOP_N_LIVE);
    } else if (quiz.status === 'finished') {
      const sorted = await sortedQuizParticipants(quiz.id);
      out.final_leaderboard = rankView(sorted, participant ? participant.club_id : null, CLUB_QUIZ_TOP_N_FINAL);
    }
    return out;
  }

  // Create a competition quiz — a college-level draft/"lobby", not scoped
  // to any one club (spec item 8).
  app.post('/api/competition-quizzes', requireAuth, requireRole('faculty', 'hod', 'college_admin'), ah(async (req, res) => {
    const { title, description, questions, save_as_test, logo } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Quiz name is required.' });
    const { error, questions: cleanQuestions } = validateQuizQuestions(questions);
    if (error) return res.status(400).json({ error });
    const cleanLogo = logo ? String(logo).trim() : null;
    const row = {
      id: newId('cquiz'), college_id: req.user.college_id,
      title: String(title).trim(), description: (description || '').trim(),
      logo: cleanLogo,
      created_by: req.user.username, created_by_name: req.user.name, created_at: Date.now(),
      questions: cleanQuestions, quiz_code: generateQuizCode(),
      status: 'lobby', current_index: -1, current_started_at: null, between_started_at: null,
      started_at: null, ended_at: null
    };
    await ClubQuizzes.insertOne(row);
    let savedTest = null;
    // NEW (spec item 2): "Save as Test" at creation time — stores a frozen
    // copy of the questions/settings as a reusable template, entirely
    // separate from the live quiz that was just created above.
    if (save_as_test) {
      const savedRow = {
        id: newId('scquiz'), college_id: req.user.college_id,
        title: row.title, description: row.description,
        logo: cleanLogo,
        questions: cleanQuestions,
        created_by: req.user.username, created_by_name: req.user.name, created_at: Date.now(),
        source_quiz_id: row.id, times_conducted: 0
      };
      await SavedClubQuizzes.insertOne(savedRow);
      savedTest = serializeSavedQuiz(savedRow);
    }
    res.status(201).json({ quiz: serializeQuizForBrowsing(row, req.user), saved_test: savedTest });
  }));

  function serializeSavedQuiz(row, includeAnswers) {
    const { _id, questions, ...rest } = row;
    return {
      ...rest,
      logo: row.logo || null,
      question_count: (questions || []).length,
      questions: includeAnswers ? questions : (questions || []).map(q => ({ id: q.id, order: q.order, text: q.text, options: q.options, time_limit_seconds: q.time_limit_seconds, max_points: q.max_points }))
    };
  }
  function canManageSavedQuiz(user, row) {
    if (row.created_by === user.username) return true;
    return ['college_admin', 'hod'].includes(user.role) && row.college_id === user.college_id;
  }

  // Save an already-created competition quiz as a reusable test — usable
  // any time after creation too, not only at creation time.
  app.post('/api/competition-quizzes/:id/save-as-test', requireAuth, requireRole('faculty', 'hod', 'college_admin'), ah(async (req, res) => {
    const quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!canManageClubQuiz(req.user, quiz)) return res.status(403).json({ error: 'You do not have permission to save this quiz.' });
    const savedRow = {
      id: newId('scquiz'), college_id: req.user.college_id,
      title: quiz.title, description: quiz.description || '',
      logo: quiz.logo || null,
      questions: quiz.questions,
      created_by: req.user.username, created_by_name: req.user.name, created_at: Date.now(),
      source_quiz_id: quiz.id, times_conducted: 0
    };
    await SavedClubQuizzes.insertOne(savedRow);
    res.status(201).json({ saved_test: serializeSavedQuiz(savedRow) });
  }));

  // Saved Tests / Saved Quizzes list — every faculty/HOD/college_admin in
  // the college can see what's saved (spec item 2); editing the original
  // quiz never touches these frozen copies.
  app.get('/api/saved-club-quizzes', requireAuth, requireRole('faculty', 'hod', 'college_admin'), ah(async (req, res) => {
    const rows = await SavedClubQuizzes.find({ college_id: req.user.college_id }).sort({ created_at: -1 }).toArray();
    res.json({ saved_tests: rows.map(r => ({ ...serializeSavedQuiz(r), can_manage: canManageSavedQuiz(req.user, r) })) });
  }));

  app.get('/api/saved-club-quizzes/:id', requireAuth, requireRole('faculty', 'hod', 'college_admin'), ah(async (req, res) => {
    const row = await SavedClubQuizzes.findOne({ id: req.params.id });
    if (!row || row.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    res.json({ saved_test: { ...serializeSavedQuiz(row, true), can_manage: canManageSavedQuiz(req.user, row) } });
  }));

  // Edit a saved quiz template — faculty/hod/college_admin who can manage it
  app.put('/api/saved-club-quizzes/:id', requireAuth, requireRole('faculty', 'hod', 'college_admin'), ah(async (req, res) => {
    const row = await SavedClubQuizzes.findOne({ id: req.params.id });
    if (!row || row.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!canManageSavedQuiz(req.user, row)) return res.status(403).json({ error: 'You do not have permission to edit this saved test.' });
    const { title, description, questions, logo } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Quiz name is required.' });
    const { error, questions: cleanQuestions } = validateQuizQuestions(questions);
    if (error) return res.status(400).json({ error });

    const updateDoc = {
      title: String(title).trim(),
      description: (description || '').trim(),
      questions: cleanQuestions,
      updated_at: Date.now()
    };
    if (logo !== undefined) {
      updateDoc.logo = logo ? String(logo).trim() : null;
    }

    await SavedClubQuizzes.updateOne({ id: req.params.id }, { $set: updateDoc });
    const updated = await SavedClubQuizzes.findOne({ id: req.params.id });
    res.json({ saved_test: { ...serializeSavedQuiz(updated, true), can_manage: true } });
  }));

  app.delete('/api/saved-club-quizzes/:id', requireAuth, requireRole('faculty', 'hod', 'college_admin'), ah(async (req, res) => {
    const row = await SavedClubQuizzes.findOne({ id: req.params.id });
    if (!row || row.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!canManageSavedQuiz(req.user, row)) return res.status(403).json({ error: 'You do not have permission to remove this saved test.' });
    await SavedClubQuizzes.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // Conduct a saved test — spins up a brand-new live quiz (its own id,
  // join code and lobby state) from the frozen questions, and leaves the
  // saved template completely untouched (spec item 2).
  app.post('/api/saved-club-quizzes/:id/conduct', requireAuth, requireRole('faculty', 'hod', 'college_admin'), ah(async (req, res) => {
    const row = await SavedClubQuizzes.findOne({ id: req.params.id });
    if (!row || row.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const { title, description } = req.body || {};
    const newQuiz = {
      id: newId('cquiz'), college_id: req.user.college_id,
      title: (title && title.trim()) || row.title, description: (description !== undefined ? description : row.description) || '',
      logo: row.logo || null,
      created_by: req.user.username, created_by_name: req.user.name, created_at: Date.now(),
      questions: row.questions, quiz_code: generateQuizCode(),
      status: 'lobby', current_index: -1, current_started_at: null, between_started_at: null,
      started_at: null, ended_at: null, saved_test_id: row.id
    };
    await ClubQuizzes.insertOne(newQuiz);
    await SavedClubQuizzes.updateOne({ id: row.id }, { $inc: { times_conducted: 1 } });
    res.status(201).json({ quiz: serializeQuizForBrowsing(newQuiz, req.user) });
  }));

  // List competition quizzes for the college — everyone can see that a
  // quiz exists (title/status/question count), but the code and any
  // answers stay hidden unless you manage that specific quiz.
  app.get('/api/competition-quizzes', requireAuth, ah(async (req, res) => {
    if (req.user.role === 'super_admin') return res.json({ quizzes: [] });
    const rows = await ClubQuizzes.find({ college_id: req.user.college_id }).sort({ created_at: -1 }).toArray();
    res.json({ quizzes: rows.map(q => serializeQuizForBrowsing(q, req.user)) });
  }));

  app.get('/api/competition-quizzes/:id', requireAuth, ah(async (req, res) => {
    const quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    res.json({ quiz: serializeQuizForBrowsing(quiz, req.user) });
  }));

  app.delete('/api/competition-quizzes/:id', requireAuth, ah(async (req, res) => {
    const quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!canManageClubQuiz(req.user, quiz)) return res.status(403).json({ error: 'You do not have permission to remove this quiz.' });
    await ClubQuizzes.deleteOne({ id: req.params.id });
    await ClubQuizParticipants.deleteMany({ quiz_id: req.params.id });
    res.json({ ok: true });
  }));

  // A student joins a competition quiz with its code. Spec items 9 & 10:
  //  - Must already belong to a club (any club, one per student per spec
  // Students/Participants join with just the quiz code:
  app.post('/api/competition-quizzes/join', requireAuth, requireRole('hod', 'faculty', 'student'), ah(async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Enter a quiz code.' });
    const displayName = String(req.body?.display_name || '').trim() || req.user.name;
    const quiz = await ClubQuizzes.findOne({ college_id: req.user.college_id, quiz_code: code });
    if (!quiz) return res.status(404).json({ error: 'That code did not match any quiz.' });
    if (quiz.status === 'finished') return res.status(400).json({ error: 'This quiz has already ended.' });

    const myClub = await Clubs.findOne({ college_id: req.user.college_id, member_usernames: req.user.username });
    const defaultTeamName = myClub ? myClub.name : `${displayName}'s Team`;
    const clubId = myClub ? myClub.id : `ind_${req.user.username}`;

    const existing = await ClubQuizParticipants.findOne({ quiz_id: quiz.id, username: req.user.username });
    if (!existing) {
      await ClubQuizParticipants.insertOne({
        id: newId('cqp'), quiz_id: quiz.id, club_id: clubId, club_name: defaultTeamName,
        username: req.user.username, name: req.user.name, display_name: displayName,
        roll_number: req.user.roll_number || '', logo: null,
        joined_at: Date.now(), total_score: 0, answers: []
      });
    } else {
      // Re-joining or updating name
      await ClubQuizParticipants.updateOne({ id: existing.id }, { $set: { display_name: displayName } });
    }
    const current = await ClubQuizParticipants.findOne({ quiz_id: quiz.id, username: req.user.username });
    res.json({ ok: true, quiz_id: quiz.id, title: quiz.title, club_name: current.club_name, display_name: current.display_name });
  }));

  // Update participant profile (Team Name, Display Name, Logo) in the quiz lobby without exiting:
  app.patch('/api/competition-quizzes/:id/my-profile', requireAuth, ah(async (req, res) => {
    const quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Quiz not found.' });
    const participant = await ClubQuizParticipants.findOne({ quiz_id: quiz.id, username: req.user.username });
    if (!participant) return res.status(404).json({ error: 'You have not joined this quiz.' });
    const updates = {};
    if (typeof req.body?.club_name === 'string' && req.body.club_name.trim()) {
      updates.club_name = req.body.club_name.trim().slice(0, 60);
    }
    if (typeof req.body?.display_name === 'string' && req.body.display_name.trim()) {
      updates.display_name = req.body.display_name.trim().slice(0, 60);
    }
    if (req.body?.logo !== undefined) {
      updates.logo = req.body.logo ? String(req.body.logo).trim() : null;
    }
    if (Object.keys(updates).length > 0) {
      await ClubQuizParticipants.updateOne({ id: participant.id }, { $set: updates });
    }
    res.json({ ok: true, ...updates });
  }));

  // Host can kick a participant from the quiz lobby:
  app.post('/api/competition-quizzes/:id/kick', requireAuth, ah(async (req, res) => {
    const quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Quiz not found.' });
    if (!canManageClubQuiz(req.user, quiz)) return res.status(403).json({ error: 'Only the quiz host can kick participants.' });
    const targetUsername = String(req.body?.username || '').trim();
    if (!targetUsername) return res.status(400).json({ error: 'Target username is required.' });
    await ClubQuizParticipants.deleteOne({ quiz_id: quiz.id, username: targetUsername });
    res.json({ ok: true, kicked: targetUsername });
  }));

  // Host starts the quiz — moves it out of the lobby into question 1, and
  // everyone (host + every joined club representative) starts together.
  app.post('/api/competition-quizzes/:id/start', requireAuth, ah(async (req, res) => {
    const quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    if (!canManageClubQuiz(req.user, quiz)) return res.status(403).json({ error: 'You do not have permission to start this quiz.' });
    if (quiz.status !== 'lobby') return res.status(400).json({ error: 'This quiz has already started.' });
    const now = Date.now();
    await ClubQuizzes.updateOne({ id: quiz.id, status: 'lobby' }, { $set: { status: 'live', current_index: 0, current_started_at: now, started_at: now } });
    res.json({ ok: true });
  }));

  // The core live/poll endpoint — both the host's live display and every
  // representative's screen call this every second or two. Self-heals
  // question timeouts and between-question advancement (checkAndAdvanceQuiz).
  app.get('/api/competition-quizzes/:id/session', requireAuth, ah(async (req, res) => {
    let quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const participant = await ClubQuizParticipants.findOne({ quiz_id: quiz.id, username: req.user.username });
    const isHost = canManageClubQuiz(req.user, quiz);
    if (!isHost && !participant) return res.status(403).json({ error: 'Join the quiz with its code first.' });
    quiz = await checkAndAdvanceQuiz(quiz);
    res.json({ session: await serializeQuizSession(quiz, req.user, participant) });
  }));

  // A club's representative answers the current question. Correctness,
  // remaining time, and points are all computed here from the server
  // clock and the server-held correct answer — never trusting anything
  // the client sends beyond "which option index did I pick." Points earned
  // count for the whole club, since this student represents it.
  app.post('/api/competition-quizzes/:id/answer', requireAuth, ah(async (req, res) => {
    let quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const participant = await ClubQuizParticipants.findOne({ quiz_id: quiz.id, username: req.user.username });
    if (!participant) return res.status(403).json({ error: 'Join the quiz with its code first.' });
    quiz = await checkAndAdvanceQuiz(quiz);
    if (quiz.status !== 'live') return res.status(400).json({ error: 'This question is closed.' });
    const q = quiz.questions[quiz.current_index];
    if (participant.answers.some(a => a.question_id === q.id)) return res.status(400).json({ error: 'You already answered this question.' });
    const optionIndex = Number(req.body?.option_index);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= q.options.length) {
      return res.status(400).json({ error: 'Choose one of the given options.' });
    }
    const durationMs = q.time_limit_seconds * 1000;
    const elapsedMs = Date.now() - quiz.current_started_at;
    if (elapsedMs > durationMs) return res.status(400).json({ error: 'Time is up for this question.' });
    const correct = optionIndex === q.correct_index;
    const remainingMs = Math.max(0, durationMs - elapsedMs);
    // Time-based scoring: a correct answer scores from 50% (near the very
    // end of the timer) up to 100% (answered instantly) of that
    // question's max points; any incorrect answer scores 0.
    const points = correct ? Math.round(q.max_points * (0.5 + 0.5 * (remainingMs / durationMs))) : 0;
    const answer = { question_id: q.id, option_index: optionIndex, correct, points, answered_at: Date.now() };
    await ClubQuizParticipants.updateOne(
      { id: participant.id },
      { $push: { answers: answer }, $inc: { total_score: points } }
    );
    res.json({ correct, points, total_score: participant.total_score + points });
  }));

  // Post-quiz review — the full ranked list of clubs for a single quiz
  // (host or anyone who played it).
  app.get('/api/competition-quizzes/:id/leaderboard', requireAuth, ah(async (req, res) => {
    const quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const participant = await ClubQuizParticipants.findOne({ quiz_id: quiz.id, username: req.user.username });
    if (!canManageClubQuiz(req.user, quiz) && !participant) return res.status(403).json({ error: 'You did not take part in this quiz.' });
    const sorted = await sortedQuizParticipants(quiz.id);
    res.json({
      quiz_title: quiz.title,
      // spec item 5: Participant Display Name + Club Name, alongside the
      // existing score/ranking (unchanged) and smooth rank-change data.
      leaderboard: sorted.map((r, i) => ({ rank: i + 1, club_id: r.club_id, club_name: r.club_name, participant_name: r.display_name || r.name, points: r.total_score }))
    });
  }));

  // Participants list (spec item 11) — who has joined so far, updating as
  // the lobby fills. Faculty/host view includes full identity per row
  // (name, username, roll number, club, joined status); the plain
  // participant view only sees which clubs are represented and by whom,
  // matching what a rival team would see in a live competition lobby.
  app.get('/api/competition-quizzes/:id/participants', requireAuth, ah(async (req, res) => {
    const quiz = await ClubQuizzes.findOne({ id: req.params.id });
    if (!quiz || quiz.college_id !== req.user.college_id) return res.status(404).json({ error: 'Not found.' });
    const isHost = canManageClubQuiz(req.user, quiz);
    const mine = await ClubQuizParticipants.findOne({ quiz_id: quiz.id, username: req.user.username });
    if (!isHost && !mine) return res.status(403).json({ error: 'Join the quiz with its code first.' });
    const rows = await ClubQuizParticipants.find({ quiz_id: quiz.id }).sort({ joined_at: 1 }).toArray();
    if (isHost) {
      res.json({
        participants: rows.map(r => ({
          id: r.id, name: r.name, display_name: r.display_name || r.name, username: r.username, roll_number: r.roll_number || '',
          club_name: r.club_name, logo: r.logo || null, joined: true, joined_at: r.joined_at
        }))
      });
    } else {
      res.json({ participants: rows.map(r => ({ id: r.id, name: r.display_name || r.name, club_name: r.club_name, logo: r.logo || null, joined: true })) });
    }
  }));

  // Club Leaderboard (spec item 17) — a separate, club-scoped leaderboard
  // built entirely from Competition Quiz scores across every quiz that
  // club has represented itself in. Deliberately kept apart from GET
  // /api/leaderboard (the normal academic Campus Orbis leaderboard) —
  // the two must never mix.
  app.get('/api/clubs/:id/quiz-leaderboard', requireAuth, ah(async (req, res) => {
    const club = await Clubs.findOne({ id: req.params.id });
    if (!club || club.college_id !== req.user.college_id) return res.status(404).json({ error: 'Club not found.' });
    if (!(club.member_usernames || []).includes(req.user.username) && !canManageClub(req.user, club)) {
      return res.status(403).json({ error: 'Join the club to see its leaderboard.' });
    }
    const rows = await ClubQuizParticipants.find({ club_id: club.id }).toArray();
    const points = rows.reduce((sum, r) => sum + r.total_score, 0);
    res.json({ club_name: club.name, points, quizzes_played: rows.length });
  }));
  // =====================================================================
  // NEW: DISCUSSION FORUM — Q&A threads, separate from the complaints /
  // lost & found Public Board. Students ask, faculty/HOD/students reply,
  // everyone can like a thread or a reply and filter/search by subject.
  // =====================================================================
  function canManageForum(user, row) {
    if (row.author_username === user.username) return true;
    return ['college_admin', 'hod'].includes(user.role) && row.college_id === user.college_id;
  }
  function serializeForumPost(row, replyCount, requestingUser) {
    const { _id, likes, ...rest } = row;
    return { ...rest, like_count: (likes || []).length, liked: (likes || []).includes(requestingUser.username), reply_count: replyCount };
  }
  function serializeForumReply(row, requestingUser) {
    const { _id, likes, ...rest } = row;
    return { ...rest, like_count: (likes || []).length, liked: (likes || []).includes(requestingUser.username) };
  }

  app.get('/api/forum', requireAuth, ah(async (req, res) => {
    if (req.user.role === 'super_admin') return res.json({ posts: [] });
    const filter = { college_id: req.user.college_id };
    if (req.query.subject) filter.subject = req.query.subject;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: rx }, { body: rx }];
    }
    const rows = await ForumPosts.find(filter).sort({ created_at: -1 }).toArray();
    const posts = await Promise.all(rows.map(async r => serializeForumPost(r, await ForumReplies.countDocuments({ post_id: r.id }), req.user)));
    res.json({ posts });
  }));

  app.post('/api/forum', requireAuth, requireRole('hod', 'faculty', 'student'), ah(async (req, res) => {
    const { subject, title, body } = req.body || {};
    if (!subject || !title || !body) return res.status(400).json({ error: 'Subject, title, and question details are all required.' });
    const row = {
      id: newId('fp'), subject: String(subject).trim(), title: String(title).trim(), body: String(body).trim(),
      college_id: req.user.college_id, author_username: req.user.username, author_name: req.user.name,
      author_role: req.user.role, likes: [], created_at: Date.now()
    };
    await ForumPosts.insertOne(row);
    res.status(201).json({ post: serializeForumPost(row, 0, req.user) });
  }));

  app.get('/api/forum/:id', requireAuth, ah(async (req, res) => {
    const row = await ForumPosts.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'This thread no longer exists.' });
    const replies = await ForumReplies.find({ post_id: req.params.id }).sort({ created_at: 1 }).toArray();
    res.json({ post: serializeForumPost(row, replies.length, req.user), replies: replies.map(r => serializeForumReply(r, req.user)) });
  }));

  app.delete('/api/forum/:id', requireAuth, ah(async (req, res) => {
    const row = await ForumPosts.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!canManageForum(req.user, row)) return res.status(403).json({ error: 'You do not have permission to remove this thread.' });
    await ForumPosts.deleteOne({ id: req.params.id });
    await ForumReplies.deleteMany({ post_id: req.params.id });
    res.json({ ok: true });
  }));

  app.post('/api/forum/:id/like', requireAuth, ah(async (req, res) => {
    const row = await ForumPosts.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const has = (row.likes || []).includes(req.user.username);
    await ForumPosts.updateOne({ id: req.params.id }, has ? { $pull: { likes: req.user.username } } : { $addToSet: { likes: req.user.username } });
    const updated = await ForumPosts.findOne({ id: req.params.id });
    res.json({ like_count: (updated.likes || []).length, liked: !has });
    if (!has && row.author_username !== req.user.username) {
      notifyUsers([row.author_username], {
        college_id: row.college_id, tab: 'forum', type: 'forum_like',
        title: 'New like on "' + row.title + '"', message: req.user.name + ' liked your question.', related_id: row.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  app.post('/api/forum/:id/replies', requireAuth, requireRole('hod', 'faculty', 'student'), ah(async (req, res) => {
    const post = await ForumPosts.findOne({ id: req.params.id });
    if (!post) return res.status(404).json({ error: 'This thread no longer exists.' });
    const { body } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: 'Write a reply before sending.' });
    const row = {
      id: newId('fr'), post_id: req.params.id, body: String(body).trim(), college_id: req.user.college_id,
      author_username: req.user.username, author_name: req.user.name, author_role: req.user.role, likes: [], created_at: Date.now()
    };
    await ForumReplies.insertOne(row);
    res.status(201).json({ reply: serializeForumReply(row, req.user) });
    if (post.author_username !== req.user.username) {
      notifyUsers([post.author_username], {
        college_id: post.college_id, tab: 'forum', type: 'forum_reply',
        title: 'New reply on "' + post.title + '"', message: req.user.name + ' answered your question.', related_id: post.id
      }).catch(err => console.error('notify failed', err));
    }
  }));

  app.post('/api/forum/replies/:id/like', requireAuth, ah(async (req, res) => {
    const row = await ForumReplies.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const has = (row.likes || []).includes(req.user.username);
    await ForumReplies.updateOne({ id: req.params.id }, has ? { $pull: { likes: req.user.username } } : { $addToSet: { likes: req.user.username } });
    const updated = await ForumReplies.findOne({ id: req.params.id });
    res.json({ like_count: (updated.likes || []).length, liked: !has });
  }));

  app.delete('/api/forum/replies/:id', requireAuth, ah(async (req, res) => {
    const row = await ForumReplies.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!canManageForum(req.user, row)) return res.status(403).json({ error: 'You do not have permission to remove this reply.' });
    await ForumReplies.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  }));

  // =====================================================================
  // NEW: LEADERBOARD — campus / department / section ranking built from
  // data that already exists (event RSVPs, attendance, marks, club
  // membership), so no separate "points" bookkeeping has to be threaded
  // through every other route. Badges & Hall of Fame are derived the
  // same way, recomputed each time the leaderboard is requested.
  // =====================================================================
  // Short, clean display label (item 3: "category names should be short and
  // clean") for a leaderboard point source. Falls back to a title-cased
  // version of the raw key for any future module's source that hasn't been
  // given an explicit label yet, so a new category never renders as a raw
  // uppercase key.
  function sourceLabel(key) {
    const LABELS = { TEST: 'Test', ATTENDANCE: 'Attendance', COMPETITION: 'Competition', ASSIGNMENT: 'Assignment', OTHER: 'Other' };
    if (LABELS[key]) return LABELS[key];
    return String(key).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  function badgesFor(b) {
    const badges = [];
    if (b.attendancePercent === 100) badges.push({ label: 'Perfect Attendance', icon: '🎯' });
    if (b.marksAvgPercent !== null && b.marksAvgPercent >= 90) badges.push({ label: 'Academic Topper', icon: '🏅' });
    if (b.eventCount >= 5) badges.push({ label: 'Event Enthusiast', icon: '🎉' });
    if (b.clubCount >= 3) badges.push({ label: 'Club Champion', icon: '🏆' });
    if (b.total >= 150) badges.push({ label: 'Campus Legend', icon: '⭐' });
    else if (b.total >= 60) badges.push({ label: 'Rising Star', icon: '✨' });
    return badges;
  }
  async function buildLeaderboard(collegeId, { department = null, section_id = null } = {}) {
    const studentFilter = { college_id: collegeId, role: 'student' };
    if (department) studentFilter.department = department;
    if (section_id) studentFilter.section_id = section_id;
    const students = await Users.find(studentFilter, { projection: { password_hash: 0, _id: 0 } }).toArray();
    if (!students.length) return [];
    // Root-cause fix: this used to pull Attendance.find({}) and Marks.find({})
    // — every attendance/marks row for every section in every college on the
    // platform — into memory just to then filter down to these students'
    // own sections in JS below. Scoping the query to this college's actual
    // section_ids produces the exact same rows those .filter() calls would
    // have kept, without transferring every other college's data first.
    const sectionIds = [...new Set(students.map(s => s.section_id).filter(Boolean))];

    const [events, allAttendance, allMarks, allClubs, adjustments, ledgerRows] = await Promise.all([
      Events.find({ college_id: collegeId }).toArray(),
      sectionIds.length ? Attendance.find({ section_id: { $in: sectionIds } }).toArray() : [],
      sectionIds.length ? Marks.find({ section_id: { $in: sectionIds } }).toArray() : [],
      Clubs.find({ college_id: collegeId }).toArray(),
      // Faculty-controlled point adjustments (item 6) — a small manual
      // +/- on top of the otherwise fully-computed score below.
      LeaderboardAdjustments.find({ college_id: collegeId }).toArray(),
      // Central point ledger (item 20) — the source of truth for TEST
      // points and for any future module's points. Any source key found
      // here that isn't one of the legacy categories below is surfaced
      // automatically as its own leaderboard category (see `extraSources`
      // further down), so a brand-new module can start writing ledger rows
      // and appear on the Main Leaderboard with zero leaderboard code
      // changes.
      PointTransactions.find({ college_id: collegeId }).toArray()
    ]);
    const adjustmentByStudent = Object.fromEntries(adjustments.map(a => [a.student_username, a.points]));

    // Lazily backfill the ledger for any TEST submission written before the
    // ledger existed (or that otherwise never reached awardPoints — e.g. a
    // crash between insert and the fire-and-forget award call). This is
    // idempotent (awardPoints no-ops on an existing reference_id) and keeps
    // the Main Leaderboard's TEST total in sync with the per-test
    // leaderboards without requiring a separate migration script.
    const collegeTests = await Tests.find({ college_id: collegeId }, { projection: { id: 1, title: 1, _id: 0 } }).toArray();
    if (collegeTests.length) {
      const testTitleById = Object.fromEntries(collegeTests.map(t => [t.id, t.title]));
      const ledgerRefIds = new Set(ledgerRows.filter(r => r.source === 'TEST').map(r => r.reference_id));
      const allSubs = await TestSubmissions.find({ test_id: { $in: collegeTests.map(t => t.id) } }).toArray();
      const missing = allSubs.filter(s => !ledgerRefIds.has(s.id));
      for (const sub of missing) {
        const hasNewFields = typeof sub.time_points === 'number';
        const stats = computeSubmissionStats(sub);
        const finalPoints = hasNewFields ? sub.points : cleanDecimal((sub.join_points || 0) + stats.points);
        const ok = await awardPoints({
          student_username: sub.student_username, college_id: collegeId, source: 'TEST',
          points: finalPoints, reference_id: sub.id,
          description: `${testTitleById[sub.test_id] || 'Test'} (backfilled)`
        });
        if (ok) ledgerRows.push({ student_username: sub.student_username, source: 'TEST', points: finalPoints });
      }
    }

    // Sum the ledger per (student, source). TEST comes from here now; any
    // future module's own source key is picked up the same way via
    // `extraSourcesByStudent` below.
    const KNOWN_SOURCES = new Set(['TEST', 'ATTENDANCE', 'COMPETITION', 'ASSIGNMENT', 'OTHER']);
    const ledgerByStudentSource = {}; // username -> { source -> points }
    for (const tx of ledgerRows) {
      if (!ledgerByStudentSource[tx.student_username]) ledgerByStudentSource[tx.student_username] = {};
      ledgerByStudentSource[tx.student_username][tx.source] = cleanDecimal((ledgerByStudentSource[tx.student_username][tx.source] || 0) + tx.points);
    }
    // Any source key present in the ledger that isn't one of the five
    // canonical categories gets its own auto-added column — this is what
    // makes the leaderboard extensible to future modules (item 3).
    const extraSourceKeys = [...new Set(ledgerRows.map(r => r.source))].filter(s => !KNOWN_SOURCES.has(s));

    const rows = students.map(s => {
      const eventCount = events.filter(ev => (ev.rsvps || []).includes(s.username)).length;
      const attRows = allAttendance.filter(a => a.section_id === s.section_id);
      let present = 0, attTotal = 0;
      attRows.forEach(a => { const mine = (a.records || []).find(x => x.student_username === s.username); if (mine) { attTotal++; if (mine.present) present++; } });
      const attendancePercent = attTotal ? Math.round((present / attTotal) * 100) : null;

      const markRows = allMarks.filter(m => m.section_id === s.section_id);
      const scores = markRows.map(m => { const r = (m.records || []).find(x => x.student_username === s.username); return r && m.max_score ? (r.score / m.max_score) * 100 : null; }).filter(v => v !== null);
      const marksAvgPercent = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

      const clubCount = allClubs.filter(c => (c.member_usernames || []).includes(s.username)).length;
      const mine = ledgerByStudentSource[s.username] || {};
      // TEST points come from the ledger exclusively now (see backfill
      // above) — decimals preserved, never rounded to an integer here, or
      // a 39.9 would silently become 40 on the Main Leaderboard.
      const testPoints = mine.TEST || 0;
      const competitionPoints = mine.COMPETITION || 0; // populated once a module writes COMPETITION ledger rows

      const eventPoints = eventCount * 10;
      const attendancePoints = attendancePercent !== null ? Math.round(attendancePercent * 0.5) : 0;
      // "Assignment" category (item 3/21) — mapped from graded Marks
      // records, the closest existing concept of assignment/exam scoring.
      const assignmentPoints = marksAvgPercent !== null ? Math.round(marksAvgPercent * 0.5) : 0;
      const clubPoints = clubCount * 5;
      const adjustmentPoints = adjustmentByStudent[s.username] || 0;
      // "Other" bucket — event RSVPs, club memberships, and manual faculty
      // adjustments, none of which map to Test/Attendance/Competition/
      // Assignment.
      const otherPoints = eventPoints + clubPoints + adjustmentPoints;

      const extraSources = extraSourceKeys.map(key => ({ source: key, label: sourceLabel(key), points: (mine[key] || 0) }));
      const sources = [
        { source: 'TEST', label: 'Test', points: testPoints },
        { source: 'ATTENDANCE', label: 'Attendance', points: attendancePoints },
        { source: 'COMPETITION', label: 'Competition', points: competitionPoints },
        { source: 'ASSIGNMENT', label: 'Assignment', points: assignmentPoints },
        { source: 'OTHER', label: 'Other', points: otherPoints },
        ...extraSources
      ];
      // Summed in integer tenths, then converted back, so combining the
      // decimal testPoints with the other (integer) point sources never
      // introduces floating-point drift like 39.900000000000006.
      const totalScore = cleanDecimal(sources.reduce((sum, src) => sum + src.points, 0));
      const breakdown = {
        eventCount, attendancePercent, marksAvgPercent, clubCount, testPoints, eventPoints, attendancePoints,
        academicPoints: assignmentPoints, clubPoints, adjustmentPoints, total: totalScore
      };
      return {
        username: s.username, name: s.name, department: s.department, section_id: s.section_id, roll_number: s.roll_number || '',
        score: totalScore, total: totalScore, sources, breakdown, badges: badgesFor(breakdown)
      };
    });
    rows.sort((a, b) => b.score - a.score);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  app.get('/api/leaderboard', requireAuth, ah(async (req, res) => {
    if (req.user.role === 'super_admin') return res.status(400).json({ error: 'Leaderboards are per-college.' });
    const scope = ['department', 'section'].includes(req.query.scope) ? req.query.scope : 'college';
    const opts = {};
    if (scope === 'department') opts.department = req.query.department || req.user.department || undefined;
    if (scope === 'section') opts.section_id = req.query.section_id || req.user.section_id || undefined;
    const full = await buildLeaderboard(req.user.college_id, {});
    const filtered = scope === 'college' ? full : await buildLeaderboard(req.user.college_id, opts);
    const hallOfFame = full.slice(0, 5);
    const me = full.find(r => r.username === req.user.username) || null;
    const sections = await Sections.find({ college_id: req.user.college_id }, { projection: { id: 1, name: 1, department: 1, _id: 0 } }).toArray();
    const departments = [...new Set(sections.map(s => s.department))];
    res.json({ leaderboard: filtered, hall_of_fame: hallOfFame, me, scope, departments, sections });
  }));

  // =====================================================================
  // NEW: EVENT PARTICIPATION CERTIFICATE — a student who RSVP'd to an
  // event that has already happened can download/print a certificate.
  // Rendered as a standalone printable HTML page (no extra PDF library
  // required); the browser's own "Print → Save as PDF" produces the PDF.
  // =====================================================================
  app.get('/api/events/:id/certificate', requireAuth, requireRole('student'), ah(async (req, res) => {
    const event = await Events.findOne({ id: req.params.id });
    if (!event) return res.status(404).send('Event not found.');
    if (!(event.rsvps || []).includes(req.user.username)) return res.status(403).send('You did not register for this event.');
    if (new Date(event.date) > new Date()) return res.status(400).send('This certificate unlocks after the event date has passed.');
    const college = await Colleges.findOne({ id: req.user.college_id });
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Certificate — ${event.title}</title>
    <style>
      body{font-family:Georgia,serif;background:#f4f1ea;margin:0;padding:40px;}
      .cert{max-width:900px;margin:0 auto;background:#fff;border:10px solid #1f6b3a;padding:60px;text-align:center;position:relative;}
      .cert:before{content:'';position:absolute;inset:14px;border:2px solid #f5a623;pointer-events:none;}
      h1{font-size:14px;letter-spacing:0.3em;text-transform:uppercase;color:#c0304f;margin:0 0 6px;}
      h2{font-size:34px;margin:10px 0 26px;color:#1f6b3a;}
      .name{font-size:30px;font-weight:bold;margin:18px 0;border-bottom:2px solid #1f6b3a;display:inline-block;padding:0 30px 8px;}
      .event{font-size:20px;margin:14px 0;color:#333;}
      .meta{margin-top:36px;font-size:13px;color:#555;}
      .print-btn{display:block;margin:24px auto 0;padding:10px 22px;font-size:14px;cursor:pointer;}
      @media print{ .print-btn{display:none;} body{background:#fff;padding:0;} }
    </style></head><body>
      <div class="cert">
        <h1>${esc(college ? college.name : 'Campus Orbis')}</h1>
        <h2>Certificate of Participation</h2>
        <p>This certifies that</p>
        <div class="name">${esc(req.user.name)}</div>
        <p class="event">participated in <strong>${esc(event.title)}</strong></p>
        <p class="event">held on ${esc(event.date)}${event.venue ? ' at ' + esc(event.venue) : ''}</p>
        <div class="meta">Issued by Campus Orbis · ${esc(college ? college.name : '')}</div>
      </div>
      <button class="print-btn" onclick="window.print()">🖨 Print / Save as PDF</button>
    </body></html>`;
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }));

  // =====================================================================
  // NEW: DASHBOARD ANALYTICS — aggregated numbers for chart widgets.
  // =====================================================================
  function last6MonthBuckets() {
    const buckets = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ label: d.toLocaleString('en-US', { month: 'short' }), year: d.getFullYear(), month: d.getMonth() });
    }
    return buckets;
  }
  function countByMonth(rows, tsField) {
    const buckets = last6MonthBuckets();
    return buckets.map(b => ({
      label: b.label,
      count: rows.filter(r => { const d = new Date(r[tsField]); return d.getFullYear() === b.year && d.getMonth() === b.month; }).length
    }));
  }

  app.get('/api/super/analytics', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const [colleges, users] = await Promise.all([Colleges.find({}).toArray(), Users.find({}).toArray()]);
    res.json({
      registrations_by_month: countByMonth(users, 'created_at'),
      colleges_by_status: [
        { label: 'Active', count: colleges.filter(c => c.status === 'active').length },
        { label: 'Disabled', count: colleges.filter(c => c.status === 'disabled').length }
      ],
      users_by_role: ['college_admin', 'hod', 'faculty', 'ao', 'student'].map(r => ({ label: roleTitle(r), count: users.filter(u => u.role === r).length }))
    });
  }));

  app.get('/api/college/analytics', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const cid = req.user.college_id;
    const [students, events, posts, sections] = await Promise.all([
      Users.find({ college_id: cid, role: 'student' }).toArray(),
      Events.find({ college_id: cid }).toArray(),
      Posts.find({ college_id: cid }).toArray(),
      Sections.find({ college_id: cid }).toArray()
    ]);
    const departments = [...new Set(sections.map(s => s.department))];
    res.json({
      registrations_by_month: countByMonth(students, 'created_at'),
      events_by_month: countByMonth(events, 'created_at'),
      post_status: [
        { label: 'Open', count: posts.filter(p => p.status === 'open').length },
        { label: 'Resolved', count: posts.filter(p => p.status === 'resolved').length }
      ],
      department_participation: departments.map(dep => {
        const deptStudents = students.filter(s => s.department === dep).map(s => s.username);
        const rsvpCount = events.reduce((sum, ev) => sum + (ev.rsvps || []).filter(u => deptStudents.includes(u)).length, 0);
        return { label: dep, count: rsvpCount };
      }),
      totals: { students: students.length, events: events.length, open_posts: posts.filter(p => p.status === 'open').length }
    });
  }));

  app.get('/api/hod/analytics', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const cid = req.user.college_id, dep = req.user.department;
    const [sections, students] = await Promise.all([
      Sections.find({ college_id: cid, department: dep }).toArray(),
      Users.find({ college_id: cid, department: dep, role: 'student' }).toArray(),
    ]);
    const sectionIds = sections.map(s => s.id);
    // Root-cause fix: previously Attendance.find({})/Marks.find({}) pulled
    // every section's attendance/marks across the entire platform before
    // filtering down to this HOD's own sections below — scoping the query
    // to sectionIds (already computed above) returns exactly the same rows
    // the .filter() calls kept, without transferring everyone else's data.
    const [attendance, marks] = await Promise.all([
      sectionIds.length ? Attendance.find({ section_id: { $in: sectionIds } }).toArray() : [],
      sectionIds.length ? Marks.find({ section_id: { $in: sectionIds } }).toArray() : [],
    ]);
    res.json({
      students_by_section: sections.map(sec => ({ label: sec.name, count: students.filter(s => s.section_id === sec.id).length })),
      attendance_by_section: sections.map(sec => {
        const rows = attendance.filter(a => a.section_id === sec.id);
        let present = 0, total = 0;
        rows.forEach(r => (r.records || []).forEach(rec => { total++; if (rec.present) present++; }));
        return { label: sec.name, count: total ? Math.round((present / total) * 100) : 0 };
      }),
      marks_by_section: sections.map(sec => {
        const rows = marks.filter(m => m.section_id === sec.id);
        const scores = [];
        rows.forEach(m => (m.records || []).forEach(rec => { if (m.max_score) scores.push((rec.score / m.max_score) * 100); }));
        return { label: sec.name, count: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0 };
      }),
      totals: { students: students.length, sections: sections.length }
    });
  }));
  function roleTitle(role) { return { college_admin: 'College Admins', hod: 'HODs', faculty: 'Faculty', ao: 'AOs', student: 'Students' }[role] || role; }

  // ---------- Placements (NEW) ----------
  // Drives are created by College Admin only (placement drives are normally
  // run centrally by one T&P cell, not per-department) and are college-wide,
  // optionally restricted to specific departments via `eligible_departments`
  // (empty array = open to every department). Eligibility here is
  // department-only — there's no CGPA field anywhere in this app's user
  // model, so a CGPA cutoff isn't something this can honestly enforce.
  function serializeDrive(drive, applications, requestingUser) {
    const mine = requestingUser.role === 'student'
      ? applications.find(a => a.drive_id === drive.id && a.student_username === requestingUser.username)
      : null;
    const eligible = requestingUser.role !== 'student' ? null :
      (!drive.eligible_departments || drive.eligible_departments.length === 0 || drive.eligible_departments.includes(requestingUser.department));
    const isOpen = drive.status === 'open' && drive.apply_by >= new Date().toISOString().slice(0, 10);
    return {
      ...stripId(drive),
      applicant_count: applications.filter(a => a.drive_id === drive.id).length,
      is_open: isOpen,
      my_application: mine ? { status: mine.status, applied_at: mine.applied_at } : null,
      eligible
    };
  }

  app.get('/api/placements', requireAuth, ah(async (req, res) => {
    const drives = await PlacementDrives.find({ college_id: req.user.college_id }).sort({ drive_date: 1 }).toArray();
    const applications = await PlacementApplications.find({ college_id: req.user.college_id }).toArray();
    res.json({ drives: drives.map(d => serializeDrive(d, applications, req.user)) });
  }));

  app.post('/api/placements', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const { company_name, role_title, description, package_info, eligible_departments, drive_date, apply_by } = req.body || {};
    if (!company_name || !role_title || !drive_date || !apply_by) {
      return res.status(400).json({ error: 'Company name, role title, drive date, and apply-by date are all required.' });
    }
    if (apply_by > drive_date) return res.status(400).json({ error: 'Apply-by date must be on or before the drive date.' });
    const row = {
      id: newId('pd'), college_id: req.user.college_id,
      company_name: String(company_name).trim(), role_title: String(role_title).trim(),
      description: (description || '').trim(), package_info: (package_info || '').trim(),
      eligible_departments: Array.isArray(eligible_departments) ? eligible_departments : [],
      drive_date, apply_by, status: 'open',
      created_by: req.user.username, created_by_name: req.user.name, created_at: Date.now()
    };
    await PlacementDrives.insertOne(row);
    res.status(201).json({ drive: serializeDrive(row, [], req.user) });
  }));

  app.patch('/api/placements/:id', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const drive = await PlacementDrives.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!drive) return res.status(404).json({ error: 'Not found.' });
    const { status } = req.body || {};
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Status must be "open" or "closed".' });
    await PlacementDrives.updateOne({ id: req.params.id }, { $set: { status } });
    res.json({ ok: true });
  }));

  app.delete('/api/placements/:id', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const drive = await PlacementDrives.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!drive) return res.status(404).json({ error: 'Not found.' });
    await PlacementDrives.deleteOne({ id: req.params.id });
    await PlacementApplications.deleteMany({ drive_id: req.params.id });
    res.json({ ok: true });
  }));

  app.post('/api/placements/:id/apply', requireAuth, requireRole('student'), ah(async (req, res) => {
    const drive = await PlacementDrives.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!drive) return res.status(404).json({ error: 'Not found.' });
    if (drive.status !== 'open' || drive.apply_by < new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'Applications for this drive are closed.' });
    }
    if (drive.eligible_departments?.length && !drive.eligible_departments.includes(req.user.department)) {
      return res.status(403).json({ error: 'This drive is not open to your department.' });
    }
    const existing = await PlacementApplications.findOne({ drive_id: req.params.id, student_username: req.user.username });
    if (existing) return res.status(409).json({ error: 'You have already applied to this drive.' });
    const row = {
      id: newId('pa'), college_id: req.user.college_id, drive_id: req.params.id,
      student_username: req.user.username, student_name: req.user.name,
      department: req.user.department, section_id: req.user.section_id,
      status: 'applied', applied_at: Date.now(), updated_at: Date.now()
    };
    await PlacementApplications.insertOne(row);
    res.status(201).json({ ok: true });
  }));

  app.delete('/api/placements/:id/apply', requireAuth, requireRole('student'), ah(async (req, res) => {
    const existing = await PlacementApplications.findOne({ drive_id: req.params.id, student_username: req.user.username });
    if (!existing) return res.status(404).json({ error: 'You have not applied to this drive.' });
    if (existing.status !== 'applied') return res.status(400).json({ error: 'You can only withdraw an application that has not been reviewed yet.' });
    await PlacementApplications.deleteOne({ id: existing.id });
    res.json({ ok: true });
  }));

  app.get('/api/placements/my', requireAuth, requireRole('student'), ah(async (req, res) => {
    const applications = await PlacementApplications.find({ student_username: req.user.username }).sort({ applied_at: -1 }).toArray();
    const driveIds = [...new Set(applications.map(a => a.drive_id))];
    const drives = driveIds.length ? await PlacementDrives.find({ id: { $in: driveIds } }).toArray() : [];
    const driveMap = Object.fromEntries(drives.map(d => [d.id, d]));
    res.json({
      applications: applications.map(a => ({
        ...stripId(a),
        company_name: driveMap[a.drive_id]?.company_name || null,
        role_title: driveMap[a.drive_id]?.role_title || null
      }))
    });
  }));

  // College Admin manages applicants for a drive: view + shortlist/select/reject.
  app.get('/api/placements/:id/applications', requireAuth, requireRole('college_admin', 'hod'), ah(async (req, res) => {
    const drive = await PlacementDrives.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!drive) return res.status(404).json({ error: 'Not found.' });
    const filter = { drive_id: req.params.id };
    if (req.user.role === 'hod') filter.department = req.user.department; // HOD only sees their own department's applicants
    const rows = await PlacementApplications.find(filter).sort({ applied_at: 1 }).toArray();
    res.json({ applications: rows.map(stripId) });
  }));

  app.patch('/api/placements/applications/:id', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const { status } = req.body || {};
    if (!['applied', 'shortlisted', 'selected', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const application = await PlacementApplications.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!application) return res.status(404).json({ error: 'Not found.' });
    await PlacementApplications.updateOne({ id: req.params.id }, { $set: { status, updated_at: Date.now() } });
    const drive = await PlacementDrives.findOne({ id: application.drive_id });
    notifyUsers([application.student_username], {
      college_id: req.user.college_id, tab: 'placements', type: status === 'selected' ? 'success' : status === 'rejected' ? 'warning' : 'info',
      title: `Placement update: ${drive?.company_name || 'a drive'}`,
      message: `Your application status is now "${status}".`, related_id: application.drive_id
    }).catch(err => console.error('notify failed', err));
    res.json({ ok: true });
  }));

  // Department-wide / college-wide placement reports.
  async function computePlacementReport({ college_id, department }) {
    const driveFilter = { college_id };
    const drives = await PlacementDrives.find(driveFilter).toArray();
    const appFilter = { college_id };
    if (department) appFilter.department = department;
    const applications = await PlacementApplications.find(appFilter).toArray();
    return drives.map(d => {
      const forDrive = applications.filter(a => a.drive_id === d.id);
      return {
        drive_id: d.id, company_name: d.company_name, role_title: d.role_title, status: d.status,
        applied: forDrive.length,
        shortlisted: forDrive.filter(a => a.status === 'shortlisted').length,
        selected: forDrive.filter(a => a.status === 'selected').length,
        rejected: forDrive.filter(a => a.status === 'rejected').length
      };
    });
  }

  app.get('/api/hod/placements/report', requireAuth, requireRole('hod'), ah(async (req, res) => {
    const report = await computePlacementReport({ college_id: req.user.college_id, department: req.user.department });
    res.json({ report });
  }));

  app.get('/api/college/placements/report', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const report = await computePlacementReport({ college_id: req.user.college_id, department: req.query.department || null });
    res.json({ report });
  }));

  app.get('/api/college/placements/report.csv', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const report = await computePlacementReport({ college_id: req.user.college_id, department: req.query.department || null });
    const escCsv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['Company,Role,Status,Applied,Shortlisted,Selected,Rejected'];
    for (const r of report) lines.push([escCsv(r.company_name), escCsv(r.role_title), escCsv(r.status), r.applied, r.shortlisted, r.selected, r.rejected].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="placements-report.csv"');
    res.send(lines.join('\r\n'));
  }));

  // =====================================================================
  // PYTHON FULL COURSE
  //
  // Reuses, unchanged: requireAuth/requireRole, the Users/session system,
  // and — critically — the exact same code-execution engine used by the
  // Exam Module (runCodeAgainstTestCases / prepareSubmission / Judge0,
  // defined earlier in this file). No second compiler, no second execution
  // API: a course coding question and an exam coding question are graded
  // by literally the same function call. The frontend's "Try in Compiler"
  // also reuses the exact same <CodeEditor/> component the Exam Module
  // uses (see src/components/tests/CodeEditor.jsx) — this course just
  // renders it in a new context and points it at the routes below instead
  // of /api/student/tests/:id/questions/:qId/run-code.
  //
  // Course structure (modules/lessons/tests) is static content living in
  // pythonCourseData.js, not the database — only per-student progress is
  // persisted, in PythonCourseProgress. If/when Campus Orbis grows a real
  // admin/faculty content-management system (see brief section 21), that
  // system should become the source of truth for PY_COURSE instead of the
  // static file; nothing about the routes/progress model below needs to
  // change for that swap.
  // =====================================================================

  function pyLesson(lessonId) { return PY_COURSE.lessonIndex.get(lessonId) || null; }
  function pyLessonOrderIndex(lessonId) { return PY_COURSE.orderedLessonIds.indexOf(lessonId); }
  function pyModuleForLesson(lessonId) {
    const l = pyLesson(lessonId);
    return l ? PY_COURSE.modules.find(m => m.id === l.module_id) : null;
  }

  async function getOrCreatePyProgress(username) {
    const now = Date.now();
    await PythonCourseProgress.updateOne(
      { student_username: username },
      { $setOnInsert: {
          id: newId('pyprog'), student_username: username,
          opened_lessons: [], completed_lessons: [], test_scores: {}, coding_attempts: 0,
          current_lesson: PY_COURSE.orderedLessonIds[0], started_at: now, completed_at: null
        },
        $set: { last_accessed_at: now }
      },
      { upsert: true }
    );
    return PythonCourseProgress.findOne({ student_username: username });
  }

  function pyIsUnlocked(lessonId, progress) {
    const idx = pyLessonOrderIndex(lessonId);
    if (idx <= 0) return true;
    const prevId = PY_COURSE.orderedLessonIds[idx - 1];
    return (progress.completed_lessons || []).includes(prevId);
  }

  // Strips answer-key fields the same way the Exam Module does for an
  // unattempted test (see serializeQuestionForStudent above) — MCQ/True-
  // False/Output-prediction questions never send correct_index up front;
  // code questions DO include their test_cases (inputs + expected outputs)
  // up front, matching the existing Exam Module convention exactly, since
  // those are shown to the student as sample cases while they iterate with
  // "Run".
  function pySerializeQuestion(q) {
    const base = { id: q.id, type: q.type, text: q.text };
    if (q.type === 'code') return { ...base, language: q.language || 'python', starter_code: q.starter_code || '', test_cases: q.test_cases || [] };
    return { ...base, options: q.options || null };
  }

  function pyModuleSummary(mod, progress) {
    const completed = mod.lessons.filter(l => (progress.completed_lessons || []).includes(l.id)).length;
    return {
      id: mod.id, order: mod.order, title: mod.title,
      total_lessons: mod.lessons.length, completed_lessons: completed,
      percentage: mod.lessons.length ? Math.round((completed / mod.lessons.length) * 100) : 0,
      lessons: mod.lessons.map(l => ({
        id: l.id, order: l.order, title: l.title, est_minutes: l.est_minutes, content_ready: l.content_ready,
        completed: (progress.completed_lessons || []).includes(l.id),
        opened: (progress.opened_lessons || []).includes(l.id),
        locked: !pyIsUnlocked(l.id, progress)
      }))
    };
  }

  // GET /api/student/python-course — dashboard: modules, overall progress,
  // continue-learning pointer, and test/coding stats. Progress is read
  // from (and lazily created in) PythonCourseProgress; the course
  // structure itself never changes per student.
  app.get('/api/student/python-course', requireAuth, requireRole('student'), ah(async (req, res) => {
    const progress = await getOrCreatePyProgress(req.user.username);
    const completedCount = (progress.completed_lessons || []).length;
    const scores = Object.values(progress.test_scores || {});
    const avgScore = scores.length ? Math.round(scores.reduce((a, s) => a + s.percentage, 0) / scores.length) : 0;
    const bestScore = scores.length ? Math.max(...scores.map(s => s.percentage)) : 0;
    const codingSolved = scores.reduce((n, s) => n + (s.coding_passed || 0), 0);
    let continueLessonId = progress.current_lesson;
    if (!continueLessonId || (progress.completed_lessons || []).includes(continueLessonId)) {
      continueLessonId = PY_COURSE.orderedLessonIds.find(id => !(progress.completed_lessons || []).includes(id)) || null;
    }
    res.json({
      course: { title: 'Python Full Course', total_modules: PY_COURSE.modules.length, total_lessons: PY_COURSE_TOTAL_LESSONS },
      modules: PY_COURSE.modules.map(m => pyModuleSummary(m, progress)),
      overall_percentage: PY_COURSE_TOTAL_LESSONS ? Math.round((completedCount / PY_COURSE_TOTAL_LESSONS) * 100) : 0,
      completed_lessons: completedCount,
      total_lessons: PY_COURSE_TOTAL_LESSONS,
      continue_lesson_id: continueLessonId,
      stats: {
        tests_completed: scores.length, average_score: avgScore, best_score: bestScore,
        coding_problems_solved: codingSolved
      },
      completed_at: progress.completed_at || null,
      started_at: progress.started_at
    });
  }));

  // GET /api/student/python-course/lessons/:lessonId — learn content +
  // practice starter code. Marks the lesson "opened" (idempotent — a Set-
  // like $addToSet, so revisiting never double-counts) and advances
  // current_lesson so Resume Learning points here next time.
  app.get('/api/student/python-course/lessons/:lessonId', requireAuth, requireRole('student'), ah(async (req, res) => {
    const lessonDef = pyLesson(req.params.lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const progress = await getOrCreatePyProgress(req.user.username);
    if (!pyIsUnlocked(req.params.lessonId, progress)) return res.status(403).json({ error: 'Complete the previous lesson first.' });
    const mod = pyModuleForLesson(req.params.lessonId);
    await PythonCourseProgress.updateOne(
      { student_username: req.user.username },
      { $addToSet: { opened_lessons: req.params.lessonId }, $set: { current_lesson: req.params.lessonId, last_accessed_at: Date.now() } }
    );
    res.json({
      lesson: {
        id: req.params.lessonId, title: lessonDef.title, order: lessonDef.order, est_minutes: lessonDef.est_minutes,
        content_ready: lessonDef.content_ready, learn: lessonDef.learn, practice: lessonDef.practice
      },
      module: { id: mod.id, title: mod.title },
      completed: (progress.completed_lessons || []).includes(req.params.lessonId)
    });
  }));

  // POST /api/student/python-course/lessons/:lessonId/practice/run-code
  // Body: { code, input? } — free-form "Try in Compiler" run, NOT graded
  // against any test cases (that's the Lesson Test's job, below). Uses the
  // exact same prepareSubmission()/Judge0 path as the Exam Module.
  app.post('/api/student/python-course/lessons/:lessonId/practice/run-code', requireAuth, requireRole('student'), codeExecutionLimiter, ah(async (req, res) => {
    const lessonDef = pyLesson(req.params.lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const code = String((req.body || {}).code || '');
    if (!code.trim()) return res.status(400).json({ error: 'Write some code first.' });
    const input = String((req.body || {}).input || '');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-orbis-pycourse-'));
    try {
      const prepared = prepareSubmission('python', code, dir);
      const result = await prepared.run(input);
      res.json({ output: result.stdout || '', error: result.error || null });
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }));

  // GET /api/student/python-course/lessons/:lessonId/test — questions with
  // answer keys stripped (see pySerializeQuestion above).
  app.get('/api/student/python-course/lessons/:lessonId/test', requireAuth, requireRole('student'), ah(async (req, res) => {
    const lessonDef = pyLesson(req.params.lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const progress = await getOrCreatePyProgress(req.user.username);
    if (!pyIsUnlocked(req.params.lessonId, progress)) return res.status(403).json({ error: 'Complete the previous lesson first.' });
    res.json({
      lesson_title: lessonDef.title,
      questions: lessonDef.test.questions.map(pySerializeQuestion),
      previous_score: progress.test_scores && progress.test_scores[req.params.lessonId] ? progress.test_scores[req.params.lessonId] : null
    });
  }));

  // POST .../test/questions/:qId/run-code — try a coding test question
  // before submitting, exactly like the Exam Module's equivalent route.
  // Every run is counted toward the student's coding_attempts stat.
  app.post('/api/student/python-course/lessons/:lessonId/test/questions/:qId/run-code', requireAuth, requireRole('student'), codeExecutionLimiter, ah(async (req, res) => {
    const lessonDef = pyLesson(req.params.lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const q = lessonDef.test.questions.find(qq => qq.id === req.params.qId && qq.type === 'code');
    if (!q) return res.status(404).json({ error: 'Question not found.' });
    const code = String((req.body || {}).code || '');
    if (!code.trim()) return res.status(400).json({ error: 'Write some code first.' });
    const { results, all_passed } = await runCodeAgainstTestCases(q.language || 'python', code, q.test_cases);
    await PythonCourseProgress.updateOne({ student_username: req.user.username }, { $inc: { coding_attempts: 1 } });
    res.json({ results, all_passed });
  }));

  // POST .../test/submit — grades MCQ/True-False/Output-prediction by
  // selected_index and code questions by re-running against test_cases
  // (same engine as above), then idempotently marks the lesson complete.
  // Idempotent by design: completed_lessons is a Set (via $addToSet), so a
  // lesson can only ever contribute once to the completed-lesson count no
  // matter how many times its test is retaken; test_scores[lessonId] is
  // simply overwritten with the latest attempt (students may retry).
  app.post('/api/student/python-course/lessons/:lessonId/test/submit', requireAuth, requireRole('student'), ah(async (req, res) => {
    const lessonDef = pyLesson(req.params.lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const progress = await getOrCreatePyProgress(req.user.username);
    if (!pyIsUnlocked(req.params.lessonId, progress)) return res.status(403).json({ error: 'Complete the previous lesson first.' });
    const answers = Array.isArray((req.body || {}).answers) ? req.body.answers : [];
    const questions = lessonDef.test.questions;
    let correct = 0, wrong = 0, codingPassed = 0, codingTotal = 0;
    const reviewed = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const ans = answers[i] || {};
      if (q.type === 'code') {
        codingTotal++;
        const code = String(ans.code || '');
        let passed = false, results = [];
        if (code.trim()) {
          const graded = await runCodeAgainstTestCases(q.language || 'python', code, q.test_cases);
          passed = graded.all_passed; results = graded.results;
        }
        if (passed) { correct++; codingPassed++; } else wrong++;
        reviewed.push({ id: q.id, type: q.type, passed, results, code });
      } else {
        const passed = typeof ans.selected_index === 'number' && ans.selected_index === q.correct_index;
        if (passed) correct++; else wrong++;
        reviewed.push({ id: q.id, type: q.type, passed, selected_index: ans.selected_index ?? null, correct_index: q.correct_index });
      }
    }
    const total = questions.length || 1;
    const percentage = Math.round((correct / total) * 100);
    const passedTest = percentage >= 50;
    const now = Date.now();
    const idx = pyLessonOrderIndex(req.params.lessonId);
    const nextLessonId = idx >= 0 && idx + 1 < PY_COURSE.orderedLessonIds.length ? PY_COURSE.orderedLessonIds[idx + 1] : null;

    const update = {
      $addToSet: { completed_lessons: req.params.lessonId },
      $set: {
        [`test_scores.${req.params.lessonId}`]: {
          correct, wrong, total, percentage, passed: passedTest, coding_passed: codingPassed, coding_total: codingTotal, taken_at: now
        },
        last_accessed_at: now,
        current_lesson: nextLessonId || req.params.lessonId
      }
    };
    await PythonCourseProgress.updateOne({ student_username: req.user.username }, update);

    // Course completion check — only flips completed_at the first time all
    // lessons are done (idempotent: never overwritten on subsequent visits).
    const freshProgress = await PythonCourseProgress.findOne({ student_username: req.user.username });
    const nowCompletedCount = (freshProgress.completed_lessons || []).length;
    if (nowCompletedCount >= PY_COURSE_TOTAL_LESSONS && !freshProgress.completed_at) {
      await PythonCourseProgress.updateOne({ student_username: req.user.username }, { $set: { completed_at: now } });
    }

    res.json({
      score: { correct, wrong, total, percentage, passed: passedTest, coding_passed: codingPassed, coding_total: codingTotal },
      review: reviewed,
      next_lesson_id: nextLessonId,
      overall_percentage: PY_COURSE_TOTAL_LESSONS ? Math.round((nowCompletedCount / PY_COURSE_TOTAL_LESSONS) * 100) : 0
    });
  }));

  // GET /api/student/python-course/certificate — only meaningful once
  // completed_at is set. Campus Orbis has no existing certificate system
  // (see /api/events/:id/certificate for the one other place "certificate"
  // is used — it's an unrelated per-event PDF, not a reusable platform
  // certificate service), so per the brief this stays a simple modular
  // JSON payload the frontend renders, rather than inventing a new
  // certificate platform.
  app.get('/api/student/python-course/certificate', requireAuth, requireRole('student'), ah(async (req, res) => {
    const progress = await getOrCreatePyProgress(req.user.username);
    if (!progress.completed_at) return res.status(403).json({ error: 'Course not completed yet.' });
    const scores = Object.values(progress.test_scores || {});
    const finalScore = scores.length ? Math.round(scores.reduce((a, s) => a + s.percentage, 0) / scores.length) : 0;
    res.json({
      student_name: req.user.name, course_name: 'Python Full Course',
      completion_date: new Date(progress.completed_at).toISOString(),
      final_score: finalScore, percentage: 100
    });
  }));

  // =====================================================================
  // COURSES (multi-language) — generalizes the Python Full Course above to
  // all 5 languages (python/c/cpp/java/javascript) plus the faculty
  // semester-unlock system, faculty course analytics, and the Practice
  // workspace. Reuses, unchanged: requireAuth/requireRole, the existing
  // code-execution engine (runCodeAgainstTestCases/prepareSubmission —
  // same Judge0 path the Exam Module and Python Full Course already use),
  // and the existing faculty->student section_ids assignment model (see
  // GET /api/faculty/students above). No second compiler, no duplicate
  // Python course — /api/student/python-course/* above is untouched and
  // keeps working exactly as before; these are new, additive routes.
  // =====================================================================
  const CourseProgress = db.collection('course_progress');
  const SemesterCourseUnlock = db.collection('semester_course_unlock');
  await CourseProgress.createIndex({ student_username: 1, language: 1 }, { unique: true });
  await SemesterCourseUnlock.createIndex({ college_id: 1, faculty_id: 1, semester: 1 }, { unique: true });
  const PracticeFiles = db.collection('practice_files');
  await PracticeFiles.createIndex({ username: 1, language: 1, name: 1 }, { unique: true });

  function courseFor(language) { return COURSES_BY_LANGUAGE[language]; }
  function courseLesson(language, lessonId) {
    const c = courseFor(language);
    return c ? (c.lessonIndex.get(lessonId) || null) : null;
  }
  function courseLessonOrderIndex(language, lessonId) {
    const c = courseFor(language);
    return c ? c.orderedLessonIds.indexOf(lessonId) : -1;
  }
  function courseModuleForLesson(language, lessonId) {
    const l = courseLesson(language, lessonId);
    const c = courseFor(language);
    return l && c ? c.modules.find(m => m.id === l.module_id) : null;
  }
  async function getOrCreateCourseProgress(username, language) {
    const now = Date.now();
    const c = courseFor(language);
    await CourseProgress.updateOne(
      { student_username: username, language },
      { $setOnInsert: {
          id: newId('cprog'), student_username: username, language,
          opened_lessons: [], completed_lessons: [], test_scores: {}, coding_attempts: 0,
          current_lesson: c.orderedLessonIds[0] || null, started_at: now, completed_at: null
        },
        $set: { last_accessed_at: now }
      },
      { upsert: true }
    );
    return CourseProgress.findOne({ student_username: username, language });
  }
  function courseLessonIsUnlocked(language, lessonId, progress, forceUnlocked) {
    // Faculty always see every lesson unlocked (spec §4: "Faculty: ALL
    // languages unlocked, always") — they're reviewing/authorized content,
    // not progressing through it lesson-by-lesson like a student.
    if (forceUnlocked) return true;
    const idx = courseLessonOrderIndex(language, lessonId);
    if (idx <= 0) return true;
    const c = courseFor(language);
    const prevId = c.orderedLessonIds[idx - 1];
    return (progress.completed_lessons || []).includes(prevId);
  }
  // Previous/Next lesson navigation (spec Part 6). Returns lesson ids (not
  // full lesson objects — the frontend already knows how to fetch a lesson
  // by id) plus whether the "next" lesson is currently unlocked for this
  // student, so the UI can show it as a normal link or a locked state
  // without a second round-trip. Faculty (forceUnlocked) always see next
  // as unlocked, matching every other lesson-access rule in this file.
  function courseLessonNav(language, lessonId, progress, forceUnlocked) {
    const c = courseFor(language);
    if (!c) return { prev_lesson_id: null, next_lesson_id: null, next_lesson_locked: false, is_first: true, is_last: true };
    const idx = courseLessonOrderIndex(language, lessonId);
    const prevId = idx > 0 ? c.orderedLessonIds[idx - 1] : null;
    const nextId = idx >= 0 && idx + 1 < c.orderedLessonIds.length ? c.orderedLessonIds[idx + 1] : null;
    const nextLocked = nextId ? !courseLessonIsUnlocked(language, nextId, progress, forceUnlocked) : false;
    return {
      prev_lesson_id: prevId,
      next_lesson_id: nextId,
      next_lesson_locked: nextLocked,
      is_first: idx <= 0,
      is_last: nextId === null,
    };
  }
  function courseSerializeQuestion(q, language) {
    const base = { id: q.id, type: q.type, text: q.text };
    if (q.type === 'code') return { ...base, language: q.language || language, starter_code: q.starter_code || '', test_cases: q.test_cases || [] };
    return { ...base, options: q.options || null };
  }
  function courseModuleSummary(language, mod, progress, forceUnlocked) {
    const completed = mod.lessons.filter(l => (progress.completed_lessons || []).includes(l.id)).length;
    return {
      id: mod.id, order: mod.order, title: mod.title, tier: mod.tier || 'beginner',
      total_lessons: mod.lessons.length, completed_lessons: completed,
      percentage: mod.lessons.length ? Math.round((completed / mod.lessons.length) * 100) : 0,
      lessons: mod.lessons.map(l => ({
        id: l.id, order: l.order, title: l.title, est_minutes: l.est_minutes, content_ready: l.content_ready,
        completed: (progress.completed_lessons || []).includes(l.id),
        opened: (progress.opened_lessons || []).includes(l.id),
        locked: !courseLessonIsUnlocked(language, l.id, progress, forceUnlocked)
      }))
    };
  }
  // Groups a course's modules into the three learning stages (spec item 9:
  // Beginner -> Intermediate -> Advanced). A tier's own lock state is just
  // "is its first lesson locked" — sequential per-lesson unlocking already
  // guarantees a later tier can't open before the earlier one is finished,
  // this just packages that fact for the UI (🌱/🚀/🔥 cards + gate copy).
  const TIER_ORDER = ['beginner', 'intermediate', 'advanced'];
  const TIER_LABEL = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
  function courseTierSummary(language, moduleSummaries) {
    return TIER_ORDER.map(tier => {
      const mods = moduleSummaries.filter(m => m.tier === tier);
      const totalLessons = mods.reduce((s, m) => s + m.total_lessons, 0);
      const completedLessons = mods.reduce((s, m) => s + m.completed_lessons, 0);
      const firstLesson = mods[0] && mods[0].lessons[0];
      return {
        tier, label: TIER_LABEL[tier],
        total_lessons: totalLessons, completed_lessons: completedLessons,
        percentage: totalLessons ? Math.round((completedLessons / totalLessons) * 100) : 0,
        locked: mods.length > 0 && !!firstLesson && !!firstLesson.locked,
        modules: mods
      };
    }).filter(t => t.total_lessons > 0);
  }
  function courseOverallPercentage(language, progress) {
    const total = TOTAL_LESSONS_BY_LANGUAGE[language] || 1;
    return Math.round(((progress.completed_lessons || []).length / total) * 100);
  }
  // A read-only, never-persisted stand-in for a student's CourseProgress
  // row, used whenever a FACULTY member views course content. Faculty
  // access to a course is never gated by progress (they always have every
  // lesson unlocked, per spec §4) and their own viewing shouldn't create,
  // mutate, or be confused with any student's actual progress record —
  // so this is computed fresh on every request and never written to
  // CourseProgress at all.
  function facultyCourseViewProgress(language) {
    const c = courseFor(language);
    return {
      opened_lessons: [], completed_lessons: [], test_scores: {}, coding_attempts: 0,
      current_lesson: c.orderedLessonIds[0] || null, started_at: null, completed_at: null, last_accessed_at: null
    };
  }

  // "Updated Course Answers" (Faculty-only) — generates a plain-text
  // export live from whatever's actually in COURSES_BY_LANGUAGE (never a
  // stored/stale file), so an edit to any MCQ/coding question is reflected
  // on the very next download. This is deliberately an ANSWER KEY ONLY:
  // it contains just each test question plus its correct answer / coding
  // reference solution — no lesson explanations, no course content, no
  // student submissions or personal data. Replaces the old "Download Full
  // Course Answers" feature, which mixed in full lesson explanations and
  // was available to students; neither is true of this feature.
  function buildUpdatedCourseAnswersText(language) {
    const course = courseFor(language);
    const meta = LANGUAGE_META[language];
    const divider = '='.repeat(60);
    let answers = `${meta.label} Course — Updated Course Answers\n${divider}\n`;
    for (const mod of course.modules) {
      answers += `\n\nMODULE ${mod.order}: ${mod.title}\n${'-'.repeat(40)}`;
      for (const lesson of mod.lessons) {
        const questions = lesson.test?.questions || [];
        if (!questions.length) continue;
        answers += `\n\n${mod.order}.${lesson.order} ${lesson.title}`;
        questions.forEach((q, qi) => {
          answers += `\n  Q${qi + 1}. ${q.text}`;
          if (q.type === 'mcq') {
            answers += `\n     Options: ${(q.options || []).join(' | ')}`;
            answers += `\n     Correct Answer: ${(q.options || [])[q.correct_index] ?? '—'}`;
          } else if (q.type === 'code') {
            answers += `\n     Language: ${q.language || language}`;
            if (q.starter_code) answers += `\n     Reference Solution:\n       ${q.starter_code.split('\n').join('\n       ')}`;
            (q.test_cases || []).forEach((tc) => { answers += `\n       Test Case — Input: ${tc.input || '(none)'}  →  Expected Output: ${tc.expected_output}`; });
          }
        });
      }
    }
    return `${answers}\n`;
  }
  function sendUpdatedCourseAnswers(res, language) {
    const text = buildUpdatedCourseAnswersText(language);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${language}-updated-course-answers.txt"`);
    res.send(text);
  }

  // ---- Semester unlock (faculty configures which single language their
  // students may access this semester; students never see the others as
  // "in progress", only locked-for-discovery, per spec) ----
  async function getFacultyUnlockedLanguage(facultyId) {
    const row = await SemesterCourseUnlock.findOne({ faculty_id: facultyId, active: true });
    return row ? row.language : null;
  }
  // A student's unlocked language is determined by whichever of their
  // assigned faculty (any faculty teaching their section) has unlocked a
  // language. If multiple faculty teach the same section with different
  // unlocks, the student sees every language any of them unlocked.
  async function getStudentUnlockedLanguages(student) {
    const facultyRows = await Users.find({ college_id: student.college_id, role: 'faculty', section_ids: student.section_id }, { projection: { id: 1 } }).toArray();
    if (!facultyRows.length) return [];
    const unlocks = await SemesterCourseUnlock.find({ faculty_id: { $in: facultyRows.map(f => f.id) }, active: true }).toArray();
    return [...new Set(unlocks.map(u => u.language))];
  }

  // GET /api/faculty/courses/unlock — current semester unlock for this faculty.
  app.get('/api/faculty/courses/unlock', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const row = await SemesterCourseUnlock.findOne({ faculty_id: req.user.id, active: true });
    res.json({ language: row ? row.language : null, semester: row ? row.semester : null });
  }));

  // POST /api/faculty/courses/unlock — body: { language, semester }.
  // "One language per semester" (spec §3): deactivates any previous
  // unlock for this faculty before activating the new one, rather than
  // stacking multiple active languages.
  app.post('/api/faculty/courses/unlock', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { language, semester } = req.body || {};
    if (!isValidLanguage(language)) return res.status(400).json({ error: 'Unknown language.' });
    if (!semester) return res.status(400).json({ error: 'Semester is required.' });
    await SemesterCourseUnlock.updateMany({ faculty_id: req.user.id, active: true }, { $set: { active: false } });
    await SemesterCourseUnlock.updateOne(
      { college_id: req.user.college_id, faculty_id: req.user.id, semester },
      { $set: { id: newId('unlock'), college_id: req.user.college_id, faculty_id: req.user.id, semester, language, active: true, created_at: Date.now() } },
      { upsert: true }
    );
    res.json({ ok: true, language, semester });
  }));

  // GET /api/student/courses — the 5 language cards with lock state +
  // per-language progress (only computed for unlocked languages — locked
  // cards stay visible for discovery per spec §3 but show no progress).
  app.get('/api/student/courses', requireAuth, requireRole('student'), ah(async (req, res) => {
    const unlocked = await getStudentUnlockedLanguages(req.user);
    const cards = [];
    for (const lang of LANGUAGES) {
      const isUnlocked = unlocked.includes(lang);
      let progressSummary = null;
      if (isUnlocked) {
        const progress = await getOrCreateCourseProgress(req.user.username, lang);
        progressSummary = {
          percentage: courseOverallPercentage(lang, progress),
          status: progress.completed_at ? 'passed' : ((progress.completed_lessons || []).length ? 'in_progress' : 'not_started'),
          last_activity: progress.last_accessed_at || null
        };
      }
      cards.push({ language: lang, label: LANGUAGE_META[lang].label, locked: !isUnlocked, progress: progressSummary });
    }
    res.json({ courses: cards });
  }));

  // Faculty: ALL languages unlocked, always (spec §4) — no unlock check.
  app.get('/api/faculty/courses', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    res.json({ courses: LANGUAGES.map(lang => ({ language: lang, label: LANGUAGE_META[lang].label, locked: false })) });
  }));

  // "Updated Course Answers" — Faculty-only. Faculty always have full
  // access to every course/language (spec §4: "ALL languages unlocked,
  // always"), so no per-course ownership check is needed beyond the role
  // check itself — there's no faculty-to-course assignment to manipulate
  // an id against. Students are never routed here: no student endpoint
  // for this exists at all (see removal note below), so a direct API call
  // from a student hits requireRole('faculty') and gets a 403.
  app.get('/api/faculty/courses/:language/download', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    if (!isValidLanguage(req.params.language)) return res.status(404).json({ error: 'Unknown course language.' });
    sendUpdatedCourseAnswers(res, req.params.language);
  }));

  // Shared middleware: for students, enforces the semester lock at the
  // backend (spec §38 — never rely on frontend-only checks) before any
  // course/lesson/test route below runs. Faculty always pass through.
  const requireCourseAccess = ah(async (req, res, next) => {
    const language = req.params.language;
    if (!isValidLanguage(language)) return res.status(404).json({ error: 'Unknown course language.' });
    if (req.user.role === 'faculty') return next();
    const unlocked = await getStudentUnlockedLanguages(req.user);
    if (!unlocked.includes(language)) return res.status(403).json({ error: 'This course has not been unlocked for your semester.' });
    next();
  });

  // GET /api/student/courses/:language — dashboard (mirrors GET
  // /api/student/python-course, generalized by language). Despite the
  // path, Faculty use this exact route too (see the /courses/:language
  // frontend route, shared by both roles) — requireCourseAccess above
  // already lets faculty through unconditionally; this just needs to stop
  // rejecting them at the role check first, and skip all of the
  // student-only progress plumbing when the caller is faculty.
  app.get('/api/student/courses/:language', requireAuth, requireRole('student', 'faculty'), requireCourseAccess, ah(async (req, res) => {
    const language = req.params.language;
    const course = courseFor(language);
    const isFaculty = req.user.role === 'faculty';
    const progress = isFaculty ? facultyCourseViewProgress(language) : await getOrCreateCourseProgress(req.user.username, language);
    const completedCount = (progress.completed_lessons || []).length;
    const scores = Object.values(progress.test_scores || {});
    const avgScore = scores.length ? Math.round(scores.reduce((a, s) => a + s.percentage, 0) / scores.length) : 0;
    const bestScore = scores.length ? Math.max(...scores.map(s => s.percentage)) : 0;
    const codingSolved = scores.reduce((n, s) => n + (s.coding_passed || 0), 0);
    let continueLessonId = progress.current_lesson;
    if (!continueLessonId || (progress.completed_lessons || []).includes(continueLessonId)) {
      continueLessonId = course.orderedLessonIds.find(id => !(progress.completed_lessons || []).includes(id)) || null;
    }
    const moduleSummaries = course.modules.map(m => courseModuleSummary(language, m, progress, isFaculty));
    res.json({
      course: { language, title: `${LANGUAGE_META[language].label} Full Course`, total_modules: course.modules.length, total_lessons: TOTAL_LESSONS_BY_LANGUAGE[language] },
      modules: moduleSummaries,
      tiers: courseTierSummary(language, moduleSummaries),
      overall_percentage: courseOverallPercentage(language, progress),
      completed_lessons: completedCount, total_lessons: TOTAL_LESSONS_BY_LANGUAGE[language],
      continue_lesson_id: continueLessonId,
      stats: { tests_completed: scores.length, average_score: avgScore, best_score: bestScore, coding_problems_solved: codingSolved },
      completed_at: progress.completed_at || null, started_at: progress.started_at
    });
  }));

  // "Updated Course Answers" (formerly "Download Full Course Answers") is
  // Faculty-only per spec — there is intentionally no student-facing
  // download route here anymore. Removed rather than left disabled, so
  // there's no answer-key endpoint reachable by a student under any
  // circumstance, direct API calls included.

  // GET /api/student/courses/:language/lessons/:lessonId — Faculty use this
  // same route too (see dashboard route above for why); they always see
  // every lesson unlocked and never get an opened/completed record
  // written under their own username.
  app.get('/api/student/courses/:language/lessons/:lessonId', requireAuth, requireRole('student', 'faculty'), requireCourseAccess, ah(async (req, res) => {
    const { language, lessonId } = req.params;
    const lessonDef = courseLesson(language, lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const isFaculty = req.user.role === 'faculty';
    if (isFaculty) {
      const mod = courseModuleForLesson(language, lessonId);
      return res.json({
        lesson: { id: lessonId, title: lessonDef.title, order: lessonDef.order, est_minutes: lessonDef.est_minutes, content_ready: lessonDef.content_ready, learn: lessonDef.learn, practice: lessonDef.practice },
        module: { id: mod.id, title: mod.title },
        completed: false,
        nav: courseLessonNav(language, lessonId, null, true)
      });
    }
    const progress = await getOrCreateCourseProgress(req.user.username, language);
    if (!courseLessonIsUnlocked(language, lessonId, progress)) return res.status(403).json({ error: 'Complete the previous lesson first.' });
    const mod = courseModuleForLesson(language, lessonId);
    await CourseProgress.updateOne(
      { student_username: req.user.username, language },
      { $addToSet: { opened_lessons: lessonId }, $set: { current_lesson: lessonId, last_accessed_at: Date.now() } }
    );
    res.json({
      lesson: { id: lessonId, title: lessonDef.title, order: lessonDef.order, est_minutes: lessonDef.est_minutes, content_ready: lessonDef.content_ready, learn: lessonDef.learn, practice: lessonDef.practice },
      module: { id: mod.id, title: mod.title },
      completed: (progress.completed_lessons || []).includes(lessonId),
      nav: courseLessonNav(language, lessonId, progress, false)
    });
  }));

  // Stateless sandboxed execution (no progress read/write either way) —
  // Faculty can try the practice code shown in a lesson they're viewing
  // exactly like a student would, same as run-code everywhere else in
  // the app (Exam Module, Practice, Tests).
  app.post('/api/student/courses/:language/lessons/:lessonId/practice/run-code', requireAuth, requireRole('student', 'faculty'), requireCourseAccess, codeExecutionLimiter, ah(async (req, res) => {
    const { language, lessonId } = req.params;
    const lessonDef = courseLesson(language, lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const code = String((req.body || {}).code || '');
    if (!code.trim()) return res.status(400).json({ error: 'Write some code first.' });
    const input = String((req.body || {}).input || '');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-orbis-course-'));
    try {
      const prepared = prepareSubmission(LANGUAGE_META[language].judge0_name, code, dir);
      const result = await prepared.run(input);
      res.json({ output: result.stdout || '', error: result.error || null });
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }));

  // GET .../test — lesson test preview. Faculty use this same route (see
  // dashboard route above); they see the questions with no previous-score
  // state and without the "complete the previous lesson first" gate,
  // since faculty always have every lesson unlocked.
  app.get('/api/student/courses/:language/lessons/:lessonId/test', requireAuth, requireRole('student', 'faculty'), requireCourseAccess, ah(async (req, res) => {
    const { language, lessonId } = req.params;
    const lessonDef = courseLesson(language, lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const isFaculty = req.user.role === 'faculty';
    if (isFaculty) {
      return res.json({
        lesson_title: lessonDef.title,
        questions: lessonDef.test.questions.map(q => courseSerializeQuestion(q, language)),
        previous_score: null
      });
    }
    const progress = await getOrCreateCourseProgress(req.user.username, language);
    if (!courseLessonIsUnlocked(language, lessonId, progress)) return res.status(403).json({ error: 'Complete the previous lesson first.' });
    res.json({
      lesson_title: lessonDef.title,
      questions: lessonDef.test.questions.map(q => courseSerializeQuestion(q, language)),
      previous_score: (progress.test_scores || {})[lessonId] || null
    });
  }));

  // Stateless grading for a single coding question inside a test preview.
  // Faculty use this too so a coding question inside a test they're
  // viewing can actually be tried, exactly like the lesson practice
  // run-code above — no progress row is touched for a faculty caller.
  app.post('/api/student/courses/:language/lessons/:lessonId/test/questions/:qId/run-code', requireAuth, requireRole('student', 'faculty'), requireCourseAccess, codeExecutionLimiter, ah(async (req, res) => {
    const { language, lessonId, qId } = req.params;
    const lessonDef = courseLesson(language, lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const q = lessonDef.test.questions.find(qq => qq.id === qId && qq.type === 'code');
    if (!q) return res.status(404).json({ error: 'Question not found.' });
    const code = String((req.body || {}).code || '');
    if (!code.trim()) return res.status(400).json({ error: 'Write some code first.' });
    const { results, all_passed } = await runCodeAgainstTestCases(q.language || LANGUAGE_META[language].judge0_name, code, q.test_cases);
    if (req.user.role !== 'faculty') {
      await CourseProgress.updateOne({ student_username: req.user.username, language }, { $inc: { coding_attempts: 1 } });
    }
    res.json({ results, all_passed });
  }));

  app.post('/api/student/courses/:language/lessons/:lessonId/test/submit', requireAuth, requireRole('student'), requireCourseAccess, ah(async (req, res) => {
    const { language, lessonId } = req.params;
    const lessonDef = courseLesson(language, lessonId);
    if (!lessonDef) return res.status(404).json({ error: 'Lesson not found.' });
    const progress = await getOrCreateCourseProgress(req.user.username, language);
    if (!courseLessonIsUnlocked(language, lessonId, progress)) return res.status(403).json({ error: 'Complete the previous lesson first.' });
    const answers = Array.isArray((req.body || {}).answers) ? req.body.answers : [];
    const questions = lessonDef.test.questions;
    let correct = 0, wrong = 0, codingPassed = 0, codingTotal = 0;
    const reviewed = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const ans = answers[i] || {};
      if (q.type === 'code') {
        codingTotal++;
        const code = String(ans.code || '');
        let passed = false, results = [];
        if (code.trim()) {
          const graded = await runCodeAgainstTestCases(q.language || LANGUAGE_META[language].judge0_name, code, q.test_cases);
          passed = graded.all_passed; results = graded.results;
        }
        if (passed) { correct++; codingPassed++; } else wrong++;
        reviewed.push({ id: q.id, type: q.type, passed, results, code });
      } else {
        const passed = typeof ans.selected_index === 'number' && ans.selected_index === q.correct_index;
        if (passed) correct++; else wrong++;
        reviewed.push({ id: q.id, type: q.type, passed, selected_index: ans.selected_index ?? null, correct_index: q.correct_index });
      }
    }
    const total = questions.length || 1;
    const percentage = Math.round((correct / total) * 100);
    const passedTest = percentage >= 50;
    const now = Date.now();
    const idx = courseLessonOrderIndex(language, lessonId);
    const course = courseFor(language);
    const nextLessonId = idx >= 0 && idx + 1 < course.orderedLessonIds.length ? course.orderedLessonIds[idx + 1] : null;

    await CourseProgress.updateOne(
      { student_username: req.user.username, language },
      { $addToSet: { completed_lessons: lessonId },
        $set: {
          [`test_scores.${lessonId}`]: { correct, wrong, total, percentage, passed: passedTest, coding_passed: codingPassed, coding_total: codingTotal, taken_at: now },
          last_accessed_at: now, current_lesson: nextLessonId || lessonId
        }
      }
    );

    const freshProgress = await CourseProgress.findOne({ student_username: req.user.username, language });
    const nowCompletedCount = (freshProgress.completed_lessons || []).length;
    if (nowCompletedCount >= TOTAL_LESSONS_BY_LANGUAGE[language] && !freshProgress.completed_at) {
      await CourseProgress.updateOne({ student_username: req.user.username, language }, { $set: { completed_at: now } });
    }

    // Daily progress (spec §11) — one row per (student, language, date),
    // incremented by however many percentage points this submission added.
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const prevPercentage = courseOverallPercentage(language, progress);
    const newPercentage = courseOverallPercentage(language, freshProgress);
    const delta = Math.max(0, newPercentage - prevPercentage);
    await db.collection('daily_course_progress').updateOne(
      { student_username: req.user.username, language, date: dayKey },
      { $inc: { percentage: delta, activity_count: 1 }, $setOnInsert: { id: newId('dprog') } },
      { upsert: true }
    );

    res.json({
      score: { correct, wrong, total, percentage, passed: passedTest, coding_passed: codingPassed, coding_total: codingTotal },
      review: reviewed, next_lesson_id: nextLessonId, overall_percentage: newPercentage
    });
  }));

  // ---- Faculty course analytics (spec §9-13) ----

  // GET /api/faculty/courses/:language/students — assigned students only
  // (same section_ids scoping as GET /api/faculty/students), with their
  // progress for this language. Never hardcoded — read live from
  // CourseProgress.
  app.get('/api/faculty/courses/:language/students', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const language = req.params.language;
    if (!isValidLanguage(language)) return res.status(404).json({ error: 'Unknown course language.' });
    const sectionIds = req.user.section_ids || [];
    const students = sectionIds.length
      ? await Users.find({ college_id: req.user.college_id, role: 'student', section_id: { $in: sectionIds } }, { projection: { password_hash: 0, _id: 0 } }).toArray()
      : [];
    const usernames = students.map(s => s.username);
    const progressRows = usernames.length ? await CourseProgress.find({ student_username: { $in: usernames }, language }).toArray() : [];
    const progressByUser = Object.fromEntries(progressRows.map(p => [p.student_username, p]));
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayRows = usernames.length ? await db.collection('daily_course_progress').find({ student_username: { $in: usernames }, language, date: todayKey }).toArray() : [];
    const todayByUser = Object.fromEntries(todayRows.map(d => [d.student_username, d.percentage]));
    // item 2: Section/Year filter data — fetched once here rather than
    // making the frontend issue a second round-trip per section.
    const sectionRows = sectionIds.length ? await Sections.find({ id: { $in: sectionIds } }).toArray() : [];
    const sectionMap = Object.fromEntries(sectionRows.map(s => [s.id, s]));

    const rows = students.map(s => {
      const p = progressByUser[s.username];
      const scores = p ? Object.values(p.test_scores || {}) : [];
      const avgScore = scores.length ? Math.round(scores.reduce((a, sc) => a + sc.percentage, 0) / scores.length) : 0;
      return {
        username: s.username, name: s.name, roll_number: s.roll_number || '',
        section_id: s.section_id || null, section_name: sectionMap[s.section_id]?.name || null, year: sectionMap[s.section_id]?.year || null,
        progress: p ? courseOverallPercentage(language, p) : 0,
        todays_progress: todayByUser[s.username] || 0,
        last_active: p ? (p.last_accessed_at || null) : null,
        test_score: avgScore,
        status: p && p.completed_at ? 'Passed' : (p && (p.completed_lessons || []).length ? 'In Progress' : 'Not Started')
      };
    });
    res.json({ language, students: rows });
  }));

  // GET /api/faculty/courses/:language/students/:username — detailed
  // drill-down (spec §10). Scoped to the faculty's own assigned sections.
  app.get('/api/faculty/courses/:language/students/:username', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { language, username } = req.params;
    if (!isValidLanguage(language)) return res.status(404).json({ error: 'Unknown course language.' });
    const sectionIds = req.user.section_ids || [];
    const student = await Users.findOne({ username, college_id: req.user.college_id, role: 'student', section_id: { $in: sectionIds } }, { projection: { password_hash: 0, _id: 0 } });
    if (!student) return res.status(403).json({ error: 'That student is not assigned to you.' });
    const progress = await getOrCreateCourseProgress(username, language);
    const course = courseFor(language);
    const scores = Object.values(progress.test_scores || {});
    const avgScore = scores.length ? Math.round(scores.reduce((a, s) => a + s.percentage, 0) / scores.length) : 0;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const dailyRows = await db.collection('daily_course_progress').find({ student_username: username, language, date: { $gte: new Date(weekAgo).toISOString().slice(0, 10) } }).sort({ date: 1 }).toArray();
    const lastCompletedId = [...(progress.completed_lessons || [])].pop() || null;
    const lastCompletedLesson = lastCompletedId ? courseLesson(language, lastCompletedId) : null;
    res.json({
      student: { username: student.username, name: student.name, roll_number: student.roll_number || '' },
      course: { language, title: `${LANGUAGE_META[language].label} Full Course` },
      overall_percentage: courseOverallPercentage(language, progress),
      todays_progress: (dailyRows.find(d => d.date === new Date().toISOString().slice(0, 10)) || {}).percentage || 0,
      weekly_progress: dailyRows.map(d => ({ date: d.date, percentage: d.percentage })),
      modules: course.modules.map(m => courseModuleSummary(language, m, progress)),
      average_score: avgScore, status: progress.completed_at ? 'Passed' : ((progress.completed_lessons || []).length ? 'In Progress' : 'Not Started'),
      last_active: progress.last_accessed_at || null,
      last_completed_topic: lastCompletedLesson ? lastCompletedLesson.title : null,
      tests_attempted: scores.length, tests_passed: scores.filter(s => s.passed).length
    });
  }));

  // GET /api/faculty/courses/:language/daily-progress — chart data across
  // all assigned students for this language (spec §11).
  app.get('/api/faculty/courses/:language/daily-progress', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const language = req.params.language;
    if (!isValidLanguage(language)) return res.status(404).json({ error: 'Unknown course language.' });
    const sectionIds = req.user.section_ids || [];
    const students = sectionIds.length
      ? await Users.find({ college_id: req.user.college_id, role: 'student', section_id: { $in: sectionIds } }, { projection: { username: 1 } }).toArray()
      : [];
    const usernames = students.map(s => s.username);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = usernames.length ? await db.collection('daily_course_progress').find({ student_username: { $in: usernames }, language, date: { $gte: since } }).toArray() : [];
    const byDate = {};
    rows.forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + r.percentage; });
    const series = Object.keys(byDate).sort().map(date => ({ date, average_percentage: usernames.length ? Math.round(byDate[date] / usernames.length) : 0 }));
    res.json({ language, series });
  }));

  // =====================================================================
  // COURSE ACCESS HIERARCHY + PAYMENTS (spec §5-14 of the latest brief).
  // Replaces the earlier "one language per semester" faculty unlock model
  // with: Super Admin gates course access per college (paid or free) ->
  // once a college is unlocked, its faculty can toggle individual
  // languages ON/OFF for their own students. SemesterCourseUnlock (the
  // older model) is left in place as a collection but is no longer read
  // by requireCourseAccess below — FacultyLanguageAccess is now the
  // source of truth, gated by CollegeCourseAccess.
  // =====================================================================
  const CollegeCourseAccess = db.collection('college_course_access');
  await CollegeCourseAccess.createIndex({ college_id: 1 }, { unique: true });
  const PaymentSettings = db.collection('payment_settings');
  const CourseRequests = db.collection('course_requests');
  await CourseRequests.createIndex({ college_id: 1, created_at: -1 });
  const FacultyLanguageAccess = db.collection('faculty_language_access');
  await FacultyLanguageAccess.createIndex({ faculty_id: 1, language: 1 }, { unique: true });
  const paymentScreenshotBucket = new GridFSBucket(db, { bucketName: 'payment_screenshots' });
  const paymentQrBucket = new GridFSBucket(db, { bucketName: 'payment_qr' });

  const COURSE_PACKAGES = {
    basic: { label: 'Basic', months: 1 },
    standard: { label: 'Standard', months: 3 },
    premium: { label: 'Premium', months: 6 },
    pro: { label: 'Pro', months: 12 },
    enterprise: { label: 'Enterprise', months: 24 }
  };

  async function getCollegeCourseAccess(collegeId) {
    const row = await CollegeCourseAccess.findOne({ college_id: collegeId });
    if (!row) return { status: 'locked', expiry_date: null };
    if (row.status === 'unlocked' && row.expiry_date && row.expiry_date < Date.now()) {
      // Expired — treat as locked from here on without needing a cron job;
      // the next read (or a background sweep, if one is added later) will
      // naturally reconcile the stored status.
      await CollegeCourseAccess.updateOne({ college_id: collegeId }, { $set: { status: 'locked' } });
      return { status: 'locked', expiry_date: row.expiry_date };
    }
    return row;
  }

  // ---- Super Admin: college-wise course access management (spec §6) ----
  app.get('/api/super/course-access', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const colleges = await Colleges.find({}).toArray();
    const accessRows = await CollegeCourseAccess.find({}).toArray();
    const accessByCollege = Object.fromEntries(accessRows.map(a => [a.college_id, a]));
    const rows = await Promise.all(colleges.map(async (c) => {
      const admin = await Users.findOne({ college_id: c.id, role: 'college_admin' }, { projection: { name: 1 } });
      const facultyCount = await Users.countDocuments({ college_id: c.id, role: 'faculty' });
      const access = await getCollegeCourseAccess(c.id);
      return {
        college_id: c.id, college_name: c.name, admin_name: admin ? admin.name : '—',
        total_faculties: facultyCount, status: access.status, expiry_date: access.expiry_date || null
      };
    }));
    res.json({ colleges: rows });
  }));

  app.get('/api/super/course-access/:collegeId/history', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const rows = await CourseRequests.find({ college_id: req.params.collegeId }).sort({ created_at: -1 }).toArray();
    res.json({ history: rows.map(stripId) });
  }));

  async function applyCollegeUnlock(collegeId, { months, customExpiry, unlockedBy, free }) {
    const now = Date.now();
    const expiry = customExpiry ? new Date(customExpiry).getTime() : now + months * 30 * 24 * 60 * 60 * 1000;
    await CollegeCourseAccess.updateOne(
      { college_id: collegeId },
      { $set: { college_id: collegeId, status: 'unlocked', expiry_date: expiry, unlocked_by: unlockedBy, free: !!free, updated_at: now } },
      { upsert: true }
    );
    const admins = await Users.find({ college_id: collegeId, role: 'college_admin' }, { projection: { username: 1 } }).toArray();
    const faculty = await Users.find({ college_id: collegeId, role: 'faculty' }, { projection: { username: 1 } }).toArray();
    await notifyUsers(admins.map(a => a.username), { college_id: collegeId, tab: 'course_access', type: 'course_activated', title: 'Course access activated', message: `Your college's Courses module is now active until ${new Date(expiry).toLocaleDateString()}.` });
    await notifyUsers(faculty.map(f => f.username), { college_id: collegeId, tab: 'courses', type: 'course_unlocked', title: 'Courses module unlocked', message: 'You can now enable individual languages for your students.' });
    // Real-time: any College Admin with Course Management open right now
    // (see GET /api/college/course-access below) sees the new status
    // immediately, no manual refresh needed — the REST fetch it triggers
    // is the same one the page's own on-mount load and poll fallback use.
    admins.forEach(a => broadcastToRoom(`user:${a.username}`, { type: 'course_access_changed' }));
    return expiry;
  }

  app.post('/api/super/course-access/:collegeId/unlock', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const college = await Colleges.findOne({ id: req.params.collegeId });
    if (!college) return res.status(404).json({ error: 'College not found.' });
    const { duration_months, custom_expiry } = req.body || {};
    if (!duration_months && !custom_expiry) return res.status(400).json({ error: 'Provide a duration or a custom expiry date.' });
    const expiry = await applyCollegeUnlock(req.params.collegeId, { months: Number(duration_months) || 0, customExpiry: custom_expiry, unlockedBy: req.user.username, free: false });
    res.json({ ok: true, status: 'unlocked', expiry_date: expiry });
  }));

  app.post('/api/super/course-access/:collegeId/unlock-free', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const college = await Colleges.findOne({ id: req.params.collegeId });
    if (!college) return res.status(404).json({ error: 'College not found.' });
    const { duration_months, custom_expiry } = req.body || {};
    const expiry = await applyCollegeUnlock(req.params.collegeId, { months: Number(duration_months) || 12, customExpiry: custom_expiry, unlockedBy: req.user.username, free: true });
    res.json({ ok: true, status: 'unlocked', expiry_date: expiry, free: true });
  }));

  app.post('/api/super/course-access/:collegeId/lock', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const college = await Colleges.findOne({ id: req.params.collegeId });
    if (!college) return res.status(404).json({ error: 'College not found.' });
    await CollegeCourseAccess.updateOne({ college_id: req.params.collegeId }, { $set: { status: 'locked', updated_at: Date.now() } }, { upsert: true });
    const admins = await Users.find({ college_id: req.params.collegeId, role: 'college_admin' }, { projection: { username: 1 } }).toArray();
    const faculty = await Users.find({ college_id: req.params.collegeId, role: 'faculty' }, { projection: { username: 1 } }).toArray();
    await notifyUsers(admins.map(a => a.username), { college_id: req.params.collegeId, tab: 'course_access', type: 'course_locked', title: 'Course access locked', message: 'The Courses module has been locked by Campus Orbis.' });
    await notifyUsers(faculty.map(f => f.username), { college_id: req.params.collegeId, tab: 'courses', type: 'course_locked', title: 'Course access locked', message: 'The Courses module has been locked by Campus Orbis.' });
    admins.forEach(a => broadcastToRoom(`user:${a.username}`, { type: 'course_access_changed' }));
    res.json({ ok: true, status: 'locked' });
  }));

  // ---- Super Admin: payment settings (spec §8), shared across colleges ----
  app.get('/api/super/payment-settings', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const row = await PaymentSettings.findOne({});
    res.json({ settings: row ? { ...stripId(row), has_qr: !!row.qr_file_id } : null });
  }));

  app.put('/api/super/payment-settings', requireAuth, requireRole('super_admin'), uploadImage.single('qr_image'), ah(async (req, res) => {
    const { upi_id, account_name, bank_name, amount, currency, description } = req.body || {};
    const existing = await PaymentSettings.findOne({});
    let qrFileId = existing ? existing.qr_file_id : null;
    if (req.file) {
      if (qrFileId) await paymentQrBucket.delete(new ObjectId(qrFileId)).catch(() => {});
      const uploadStream = paymentQrBucket.openUploadStream(req.file.originalname, { contentType: req.file.mimetype });
      uploadStream.end(req.file.buffer);
      await new Promise((resolve, reject) => { uploadStream.on('finish', resolve); uploadStream.on('error', reject); });
      qrFileId = uploadStream.id;
    }
    const doc = {
      upi_id: upi_id ?? existing?.upi_id ?? '', account_name: account_name ?? existing?.account_name ?? '',
      bank_name: bank_name ?? existing?.bank_name ?? '', amount: amount ?? existing?.amount ?? '',
      currency: currency ?? existing?.currency ?? 'INR', description: description ?? existing?.description ?? '',
      qr_file_id: qrFileId, updated_at: Date.now(), updated_by: req.user.username
    };
    await PaymentSettings.updateOne({}, { $set: doc }, { upsert: true });
    res.json({ ok: true });
  }));

  app.get('/api/super/payment-settings/qr', requireAuth, ah(async (req, res) => {
    const row = await PaymentSettings.findOne({});
    if (!row || !row.qr_file_id) return res.status(404).json({ error: 'No QR code uploaded yet.' });
    paymentQrBucket.openDownloadStream(new ObjectId(row.qr_file_id)).pipe(res);
  }));

  // College Admin: read-only view of current payment settings, so they
  // know where to pay before submitting a request.
  app.get('/api/college/payment-settings', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const row = await PaymentSettings.findOne({});
    if (!row) return res.json({ settings: null });
    const { qr_file_id, ...rest } = row;
    res.json({ settings: { ...rest, has_qr: !!qr_file_id } });
  }));

  // ---- College Admin: request a course package + submit payment (spec §7) ----
  // Also College Admin's Course Lock/Unlock visibility (this prompt): the
  // college-wide gate (`status`/`expiry_date`, Super-Admin-controlled)
  // plus a per-language breakdown so College Admin can see exactly which
  // languages are actually unlocked for students right now — that's
  // decided per-faculty (spec §11: each faculty toggles languages ON/OFF
  // for their own students, once the college-wide gate is unlocked), so
  // "unlocked" here means at least one faculty member has switched it on;
  // the faculty_count breakdown shows the College Admin exactly how many.
  // Read-only: College Admin has no POST route for either the college
  // gate (that's Super Admin only, above) or individual language toggles
  // (that's Faculty only, below) — this endpoint can only ever be used to
  // look, never to change anything, and requireRole enforces that
  // regardless of what any frontend does.
  app.get('/api/college/course-access', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const access = await getCollegeCourseAccess(req.user.college_id);
    const totalFaculty = await Users.countDocuments({ college_id: req.user.college_id, role: 'faculty' });
    let languages;
    if (access.status !== 'unlocked' || totalFaculty === 0) {
      // Nothing can be individually unlocked while the college-wide gate
      // itself is locked (or before any faculty even exist) — every
      // language is locked in that case, without needing to query
      // FacultyLanguageAccess at all.
      languages = LANGUAGES.map(l => ({ language: l, label: LANGUAGE_META[l].label, status: 'locked', enabled_faculty_count: 0, total_faculty_count: totalFaculty }));
    } else {
      const facultyRows = await Users.find({ college_id: req.user.college_id, role: 'faculty' }, { projection: { id: 1 } }).toArray();
      const toggles = await FacultyLanguageAccess.find({ faculty_id: { $in: facultyRows.map(f => f.id) }, enabled: true }).toArray();
      const enabledCounts = {};
      toggles.forEach(t => { enabledCounts[t.language] = (enabledCounts[t.language] || 0) + 1; });
      languages = LANGUAGES.map(l => ({
        language: l, label: LANGUAGE_META[l].label,
        status: enabledCounts[l] > 0 ? 'unlocked' : 'locked',
        enabled_faculty_count: enabledCounts[l] || 0, total_faculty_count: totalFaculty
      }));
    }
    res.json({ ...access, languages });
  }));

  app.get('/api/college/course-requests', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const rows = await CourseRequests.find({ college_id: req.user.college_id }).sort({ created_at: -1 }).toArray();
    res.json({ requests: rows.map(stripId) });
  }));

  app.post('/api/college/course-requests', requireAuth, requireRole('college_admin'), uploadLimiter, uploadImage.single('screenshot'), ah(async (req, res) => {
    const { package: pkg, transaction_id, upi_id, notes } = req.body || {};
    if (!COURSE_PACKAGES[pkg]) return res.status(400).json({ error: 'Choose a valid package.' });
    if (!transaction_id || !String(transaction_id).trim()) return res.status(400).json({ error: 'Transaction ID is required.' });
    if (!req.file) return res.status(400).json({ error: 'A payment screenshot is required.' });

    const uploadStream = paymentScreenshotBucket.openUploadStream(req.file.originalname, { contentType: req.file.mimetype });
    uploadStream.end(req.file.buffer);
    await new Promise((resolve, reject) => { uploadStream.on('finish', resolve); uploadStream.on('error', reject); });

    const settings = await PaymentSettings.findOne({});
    const row = {
      id: newId('creq'), college_id: req.user.college_id, admin_id: req.user.id, admin_username: req.user.username,
      package: pkg, duration_months: COURSE_PACKAGES[pkg].months, amount: settings?.amount || '',
      transaction_id: String(transaction_id).trim(), upi_id: upi_id || '', screenshot_file_id: uploadStream.id,
      notes: notes || '', status: 'pending', created_at: Date.now(), reviewed_at: null, reviewed_by: null
    };
    await CourseRequests.insertOne(row);

    const supers = await Users.find({ role: 'super_admin' }, { projection: { username: 1 } }).toArray();
    await notifyUsers(supers.map(s => s.username), { tab: 'courses', type: 'payment_request', title: 'New course payment request', message: `${req.user.name} submitted a ${COURSE_PACKAGES[pkg].label} request.`, related_id: row.id });
    await notifyUsers([req.user.username], { college_id: req.user.college_id, tab: 'courses', type: 'request_submitted', title: 'Request submitted', message: 'Your course access request is pending review.' });

    res.status(201).json({ request: stripId(row) });
  }));

  app.get('/api/college/course-requests/:id/screenshot', requireAuth, requireRole('college_admin'), ah(async (req, res) => {
    const row = await CourseRequests.findOne({ id: req.params.id, college_id: req.user.college_id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    paymentScreenshotBucket.openDownloadStream(new ObjectId(row.screenshot_file_id)).pipe(res);
  }));

  // ---- Super Admin: payment verification panel (spec §9-10) ----
  app.get('/api/super/course-requests', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const rows = await CourseRequests.find(filter).sort({ created_at: -1 }).toArray();
    const collegeIds = [...new Set(rows.map(r => r.college_id))];
    const colleges = await Colleges.find({ id: { $in: collegeIds } }, { projection: { name: 1 } }).toArray();
    const collegeNameById = Object.fromEntries(colleges.map(c => [c.id, c.name]));
    res.json({ requests: rows.map(r => ({ ...stripId(r), college_name: collegeNameById[r.college_id] || '—', package_label: COURSE_PACKAGES[r.package]?.label || r.package })) });
  }));

  app.get('/api/super/course-requests/:id/screenshot', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const row = await CourseRequests.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    paymentScreenshotBucket.openDownloadStream(new ObjectId(row.screenshot_file_id)).pipe(res);
  }));

  app.post('/api/super/course-requests/:id/approve', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const row = await CourseRequests.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'This request has already been reviewed.' });
    const { duration_months, custom_expiry } = req.body || {};
    const months = Number(duration_months) || row.duration_months;
    const expiry = await applyCollegeUnlock(row.college_id, { months, customExpiry: custom_expiry, unlockedBy: req.user.username, free: false });
    await CourseRequests.updateOne({ id: row.id }, { $set: { status: 'approved', reviewed_by: req.user.username, reviewed_at: Date.now(), expiry_date_granted: expiry } });
    await notifyUsers([row.admin_username], { college_id: row.college_id, tab: 'courses', type: 'payment_approved', title: 'Payment approved', message: `Course access is now active until ${new Date(expiry).toLocaleDateString()}.` });
    res.json({ ok: true, expiry_date: expiry });
  }));

  app.post('/api/super/course-requests/:id/reject', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
    const row = await CourseRequests.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'This request has already been reviewed.' });
    const { reason } = req.body || {};
    await CourseRequests.updateOne({ id: row.id }, { $set: { status: 'rejected', reviewed_by: req.user.username, reviewed_at: Date.now(), reject_reason: reason || '' } });
    await notifyUsers([row.admin_username], { college_id: row.college_id, tab: 'courses', type: 'payment_rejected', title: 'Payment rejected', message: reason || 'Your course access request was rejected.' });
    res.json({ ok: true });
  }));

  // ---- Faculty: per-language toggles (spec §11), gated by college access ----
  app.get('/api/faculty/courses/access', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const access = await getCollegeCourseAccess(req.user.college_id);
    const toggles = await FacultyLanguageAccess.find({ faculty_id: req.user.id }).toArray();
    const enabledMap = Object.fromEntries(LANGUAGES.map(l => [l, false]));
    toggles.forEach(t => { enabledMap[t.language] = t.enabled; });
    res.json({ college_status: access.status, expiry_date: access.expiry_date || null, languages: enabledMap });
  }));

  app.post('/api/faculty/courses/access', requireAuth, requireRole('faculty'), ah(async (req, res) => {
    const { language, enabled } = req.body || {};
    if (!isValidLanguage(language)) return res.status(400).json({ error: 'Unknown language.' });
    const access = await getCollegeCourseAccess(req.user.college_id);
    if (access.status !== 'unlocked') return res.status(403).json({ error: 'Your college does not have active course access. Ask your College Admin to request it.' });
    await FacultyLanguageAccess.updateOne(
      { faculty_id: req.user.id, language },
      { $set: { faculty_id: req.user.id, college_id: req.user.college_id, language, enabled: !!enabled, updated_at: Date.now() } },
      { upsert: true }
    );
    // College Admin can't see this change happen (it's a Faculty-only
    // action) unless told — real OS-level push via notifyUsers (see
    // sendPushToUsers in the Web Push section above) plus an instant
    // in-app refresh for anyone with Course Management open right now.
    const admins = await Users.find({ college_id: req.user.college_id, role: 'college_admin' }, { projection: { username: 1 } }).toArray();
    const label = LANGUAGE_META[language].label;
    await notifyUsers(admins.map(a => a.username), {
      college_id: req.user.college_id, tab: 'course_access', type: enabled ? 'course_language_unlocked' : 'course_language_locked',
      title: `${label} ${enabled ? 'unlocked' : 'locked'}`, message: `${req.user.name} ${enabled ? 'unlocked' : 'locked'} ${label} for their students.`
    });
    admins.forEach(a => broadcastToRoom(`user:${a.username}`, { type: 'course_access_changed' }));
    res.json({ ok: true, language, enabled: !!enabled });
  }));

  // Superseded by getStudentUnlockedLanguages below (redefined here to
  // read from FacultyLanguageAccess + the college gate rather than the
  // older SemesterCourseUnlock collection).
  getStudentUnlockedLanguages = async function (student) {
    const access = await getCollegeCourseAccess(student.college_id);
    if (access.status !== 'unlocked') return [];
    const facultyRows = await Users.find({ college_id: student.college_id, role: 'faculty', section_ids: student.section_id }, { projection: { id: 1 } }).toArray();
    if (!facultyRows.length) return [];
    const toggles = await FacultyLanguageAccess.find({ faculty_id: { $in: facultyRows.map(f => f.id) }, enabled: true }).toArray();
    return [...new Set(toggles.map(t => t.language))];
  };


  // Module (prepareSubmission/runCodeAgainstTestCases, Judge0-backed). No
  // new compiler. This is free-form scratch code, not graded, with
  // optional per-user saved files.
  // =====================================================================
  app.post('/api/practice/run', requireAuth, codeExecutionLimiter, ah(async (req, res) => {
    const { language, code, input } = req.body || {};
    if (!isValidLanguage(language)) return res.status(400).json({ error: 'Unsupported language.' });
    if (!String(code || '').trim()) return res.status(400).json({ error: 'Write some code first.' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-orbis-practice-'));
    try {
      const prepared = prepareSubmission(LANGUAGE_META[language].judge0_name, code, dir);
      const result = await prepared.run(String(input || ''));
      res.json({ output: result.stdout || '', error: result.error || null });
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }));

  app.get('/api/practice/files', requireAuth, ah(async (req, res) => {
    const rows = await PracticeFiles.find({ username: req.user.username }, { projection: { _id: 0, code: 0 } }).sort({ updated_at: -1 }).toArray();
    res.json({ files: rows });
  }));

  app.get('/api/practice/files/:id', requireAuth, ah(async (req, res) => {
    const row = await PracticeFiles.findOne({ id: req.params.id, username: req.user.username });
    if (!row) return res.status(404).json({ error: 'File not found.' });
    res.json({ file: stripId(row) });
  }));

  app.post('/api/practice/files', requireAuth, ah(async (req, res) => {
    const { name, language, code } = req.body || {};
    if (!isValidLanguage(language)) return res.status(400).json({ error: 'Unsupported language.' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'File name is required.' });
    const now = Date.now();
    await PracticeFiles.updateOne(
      { username: req.user.username, language, name },
      { $set: { code: String(code || ''), updated_at: now }, $setOnInsert: { id: newId('pfile'), username: req.user.username, language, name, created_at: now } },
      { upsert: true }
    );
    const saved = await PracticeFiles.findOne({ username: req.user.username, language, name });
    res.json({ file: stripId(saved) });
  }));

  app.delete('/api/practice/files/:id', requireAuth, ah(async (req, res) => {
    await PracticeFiles.deleteOne({ id: req.params.id, username: req.user.username });
    res.json({ ok: true });
  }));

  // ---------- Fallback (SPA) ----------
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // =====================================================================
  // TEST MONITORING — WebRTC LIVE VIEW SIGNALLING
  //
  // Everything above (the /monitoring/chunk, /monitoring/heartbeat, and
  // /monitoring/:username/stream routes) is the existing rolling-recording
  // pipeline and is left completely untouched — it keeps working exactly
  // as before, and is still what drives the "Camera On/Off" status.
  //
  // This block adds a SEPARATE, real-time path so Faculty → View Live
  // shows the student's actual live camera feed instead of a periodically-
  // refreshed recorded chunk: a plain WebSocket signalling channel (there
  // was no WebSocket/real-time infra in this codebase before) that the
  // two browsers use to exchange WebRTC SDP offers/answers and ICE
  // candidates. The actual audio/video never touches this server or the
  // database — it flows browser-to-browser (or via a STUN/TURN relay)
  // once the peer connection is established. This server only relays a
  // handful of small JSON signalling messages.
  //
  // Auth: the same session cookie used by the REST API authenticates the
  // WebSocket upgrade. A student connection is only accepted if they hold
  // a real TestJoins row for that test (i.e. they actually started it,
  // same gate the REST monitoring routes use). A faculty connection is
  // only accepted if they created that test. A faculty "view-live-request"
  // is additionally re-checked against both of those facts before being
  // relayed, so a faculty member can never be routed to a student/test
  // they don't own, and a student can never be impersonated by anyone
  // else's socket.
  // =====================================================================
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  // Second, independent WebSocket server on the same HTTP server/port for
  // the general-purpose real-time layer (leaderboards, test status, rejoin
  // requests) — kept entirely separate from `wss` above (Test Monitoring's
  // WebRTC signalling) so that code is never touched by this addition.
  const wssLive = new WebSocketServer({ noServer: true });

  // testId -> { username -> ws }  (one active socket per student per test)
  const studentSockets = new Map();
  // testId -> Map(connId -> ws)   (a faculty member may watch several
  // students from the same tab, all over one socket; connId identifies
  // which "View Live" viewer a given offer/answer/candidate belongs to)
  const facultySockets = new Map();

  function wsLog(who, ...args) {
    // Temporary development logging for the full signalling flow (spec
    // item 11) — left in place but namespaced so it's easy to grep/mute.
    console.log(`[monitoring-rtc:${who}]`, ...args);
  }

  function parseCookie(header, name) {
    if (!header) return null;
    const match = header.split(';').map(p => p.trim()).find(p => p.startsWith(name + '='));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
  }

  async function authenticateWsRequest(req) {
    let token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) {
      try {
        const url = new URL(req.url, 'http://localhost');
        token = url.searchParams.get('token');
      } catch (e) {}
    }
    if (!token) return null;
    const session = await Sessions.findOne({ token });
    if (!session) return null;
    const user = await Users.findOne({ username: session.username });
    return user || null;
  }

  function sendJson(ws, payload) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  function registerStudentSocket(testId, username, ws) {
    if (!studentSockets.has(testId)) studentSockets.set(testId, new Map());
    const forTest = studentSockets.get(testId);
    const existing = forTest.get(username);
    if (existing && existing !== ws) {
      // A stale connection from a previous tab/reload — close it so we
      // never accidentally keep signalling to a dead socket.
      try { existing.close(); } catch { /* already dead */ }
    }
    forTest.set(username, ws);
  }
  function unregisterStudentSocket(testId, username, ws) {
    const forTest = studentSockets.get(testId);
    if (forTest && forTest.get(username) === ws) forTest.delete(username);
    if (forTest && forTest.size === 0) studentSockets.delete(testId);
  }
  function registerFacultySocket(testId, connId, ws) {
    if (!facultySockets.has(testId)) facultySockets.set(testId, new Map());
    facultySockets.get(testId).set(connId, ws);
  }
  function unregisterFacultySocket(testId, connId) {
    const forTest = facultySockets.get(testId);
    if (forTest) forTest.delete(connId);
    if (forTest && forTest.size === 0) facultySockets.delete(testId);
  }
  function findFacultyConn(testId, connId) {
    return facultySockets.get(testId)?.get(connId) || null;
  }
  function findStudentConn(testId, username) {
    return studentSockets.get(testId)?.get(username) || null;
  }

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname === '/ws/monitoring') {
      wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
    } else if (pathname === '/ws/live') {
      wssLive.handleUpgrade(req, socket, head, (ws) => { wssLive.emit('connection', ws, req); });
    } else {
      socket.destroy();
    }
  });

  // Real-time layer connection handler. Auth reuses the exact same
  // session-cookie check as the monitoring socket above (authenticateWsRequest)
  // — the same login session that authorizes REST calls authorizes this
  // socket, nothing new to configure. A connection with no valid session is
  // closed immediately (1008 = policy violation), same as an unauthenticated
  // REST request would get a 401.
  wssLive.on('connection', async (ws, req) => {
    const user = await authenticateWsRequest(req);
    if (!user) { ws.close(1008, 'Not authenticated'); return; }
    ws._username = user.username;
    ws._rooms = new Set();

    // Heartbeat — detects a dead connection (network drop, laptop sleep)
    // that never sent a proper close frame, so it gets cleaned out of
    // every room instead of silently accumulating as a leak.
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'subscribe' && typeof msg.room === 'string' && msg.room.length < 200) {
        try {
          if (await canSubscribeToRoom(user, msg.room)) joinRoom(msg.room, ws);
        } catch (err) { console.error('ws subscribe check failed', err); }
      } else if (msg.type === 'unsubscribe' && typeof msg.room === 'string') {
        const set = realtimeRooms.get(msg.room);
        if (set) { set.delete(ws); if (set.size === 0) realtimeRooms.delete(msg.room); }
        ws._rooms?.delete(msg.room);
      }
    });

    ws.on('close', () => leaveAllRooms(ws));
    ws.on('error', () => leaveAllRooms(ws));
  });

  // Ping every open /ws/live socket every 30s; any socket that didn't
  // pong back since the last sweep is presumed dead and terminated —
  // this is what actually reclaims a connection lost to something other
  // than a clean close (e.g. a laptop going to sleep mid-test), preventing
  // an unbounded memory leak in `realtimeRooms` over a long-running server.
  const liveHeartbeat = setInterval(() => {
    wssLive.clients.forEach((ws) => {
      if (ws._alive === false) { leaveAllRooms(ws); return ws.terminate(); }
      ws._alive = false;
      try { ws.ping(); } catch { /* already closing */ }
    });
  }, 30000);
  wssLive.on('close', () => clearInterval(liveHeartbeat));

  wss.on('connection', async (ws, req) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { ws.close(1008, 'Bad request'); return; }
    const role = url.searchParams.get('role'); // 'student' | 'faculty' | 'hod'
    const testId = url.searchParams.get('testId');
    if (!testId || (role !== 'student' && role !== 'faculty' && role !== 'hod')) { ws.close(1008, 'Missing testId/role'); return; }

    const user = await authenticateWsRequest(req);
    if (!user || user.role !== role) { ws.close(1008, 'Not authorised'); return; }

    const test = await Tests.findOne({ id: testId });
    if (!test) { ws.close(1008, 'Test not found'); return; }

    // HOD is a read-only viewer with the exact same signalling shape as
    // faculty (it shares facultySockets/connId below) — the only
    // difference throughout this handler is HOW ownership is checked:
    // faculty by test.created_by, HOD by the test's section belonging to
    // their own department. Neither viewer role can send anything that
    // touches a question or a student's answer — this socket only ever
    // relays offer/answer/ICE/view-live messages.
    async function viewerIsAuthorized() {
      if (role === 'faculty') return test.created_by === user.username;
      if (role === 'hod') {
        if (test.created_by === user.username) return true;
        const section = await Sections.findOne({ id: test.section_id, college_id: user.college_id, department: user.department });
        return !!section;
      }
      return false;
    }

    let connId = null; // only used on the faculty/hod side, to disambiguate multiple watched students

    if (role === 'student') {
      if (test.section_id !== user.section_id) { ws.close(1008, 'Not authorised'); return; }
      const join = await TestJoins.findOne({ test_id: testId, student_username: user.username });
      if (!join) { ws.close(1008, 'You have not started this test.'); return; }
      registerStudentSocket(testId, user.username, ws);
      wsLog('student', `connected test=${testId} student=${user.username}`);
    } else {
      if (!(await viewerIsAuthorized())) { ws.close(1008, 'Not authorised'); return; }
      connId = crypto.randomBytes(8).toString('hex');
      registerFacultySocket(testId, connId, ws);
      // Let the viewer tab know which connection id to tag its
      // requests/candidates with once several students are being watched.
      sendJson(ws, { type: 'ready', connId });
      wsLog(role, `connected test=${testId} user=${user.username} connId=${connId}`);
    }

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (role === 'faculty' || role === 'hod') {
        const studentUsername = msg.studentUsername;
        if (!studentUsername) return;

        if (msg.type === 'view-live-request') {
          // Re-validate on every request — authorization can't be assumed
          // just because the socket was accepted at connect time.
          if (!(await viewerIsAuthorized())) return;
          const join = await TestJoins.findOne({ test_id: testId, student_username: studentUsername });
          if (!join) { sendJson(ws, { type: 'student-disconnected', studentUsername, connId }); return; }
          const studentWs = findStudentConn(testId, studentUsername);
          wsLog(role, `view-live-request -> student=${studentUsername} online=${!!studentWs}`);
          if (!studentWs) { sendJson(ws, { type: 'student-disconnected', studentUsername, connId }); return; }
          sendJson(studentWs, { type: 'live-view-request', connId, studentUsername });
          return;
        }

        if (msg.type === 'view-live-close') {
          const studentWs = findStudentConn(testId, studentUsername);
          wsLog(role, `view-live-close -> student=${studentUsername} connId=${connId}`);
          sendJson(studentWs, { type: 'view-live-close', connId, studentUsername });
          return;
        }

        if (msg.type === 'answer' || msg.type === 'ice-candidate') {
          const studentWs = findStudentConn(testId, studentUsername);
          wsLog(role, `relay ${msg.type} -> student=${studentUsername}`);
          sendJson(studentWs, { ...msg, connId });
          return;
        }
      }

      if (role === 'student') {
        // Every message from a student is tagged with the connId of the
        // faculty/HOD viewer it belongs to, so a student being watched by
        // more than one viewer tab (or reconnecting mid-session) never
        // has its offer/candidates cross-wired to the wrong viewer.
        const targetConnId = msg.connId;
        if (!targetConnId) return;
        const facultyWs = findFacultyConn(testId, targetConnId);
        if (!facultyWs) return;
        if (msg.type === 'offer' || msg.type === 'ice-candidate') {
          wsLog('student', `relay ${msg.type} -> viewer connId=${targetConnId}`);
          sendJson(facultyWs, { ...msg, studentUsername: user.username });
          return;
        }
        if (msg.type === 'camera-ended') {
          wsLog('student', `camera-ended -> viewer connId=${targetConnId}`);
          sendJson(facultyWs, { type: 'camera-ended', studentUsername: user.username, connId: targetConnId });
          return;
        }
      }
    });

    ws.on('close', () => {
      if (role === 'student') {
        unregisterStudentSocket(testId, user.username, ws);
        // Tell every faculty/HOD tab currently watching this test that
        // this student's signalling channel is gone (their camera may
        // still be fine — this only means live viewing can't be
        // (re)established until they reconnect; the REST "Camera On/Off"
        // status is driven independently by the heartbeat route).
        const forTest = facultySockets.get(testId);
        if (forTest) {
          for (const [fConnId, fws] of forTest) {
            sendJson(fws, { type: 'student-disconnected', studentUsername: user.username, connId: fConnId });
          }
        }
        wsLog('student', `disconnected test=${testId} student=${user.username}`);
      } else if (connId) {
        unregisterFacultySocket(testId, connId);
        wsLog(role, `disconnected test=${testId} user=${user.username} connId=${connId}`);
      }
    });
  });

  // Section 21: anything that escapes the ah() wrapper — most commonly a
  // Multer error thrown synchronously during file-size/type checks before an
  // async handler even starts — falls through to here instead of Express's
  // default error page, which (outside production) renders the full stack
  // trace straight into the HTTP response body. Every error is logged
  // server-side in full; the client only ever gets a safe, generic message.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.name === 'MulterError') {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : 'There was a problem with your upload.';
      return res.status(400).json({ error: message });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  server.listen(PORT, () => {
    console.log(`Campus Orbis is running at http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('\nCampus Orbis failed to start.');
  console.error('Make sure MongoDB is running and reachable at:', MONGODB_URI);
  console.error('Set the MONGODB_URI environment variable to point elsewhere if needed.\n');
  console.error(err.message);
  process.exit(1);
});
