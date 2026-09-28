'use strict';
// ---------------------------------------------------------------------------
// A minimal, in-memory stand-in for the 'mongodb' driver, used ONLY by the
// integration smoke test (tests/integration.smoke.test.js). This sandbox has
// no MongoDB server and restricted network access, so this is what makes it
// possible to actually boot server.js and fire real HTTP requests at it
// instead of only unit-testing isolated functions.
//
// Scope is deliberately narrow: exactly the driver surface server.js uses
// (checked by grepping the real file for every $-operator and collection
// method it calls) — find/findOne/insertOne/insertMany/updateOne/updateMany/
// deleteOne/deleteMany/countDocuments/createIndex, plus a GridFSBucket
// stand-in backed by in-memory Buffers. Query matching is delegated to
// `mingo` (a real, independent MongoDB-query-language implementation) so
// $ne/$in/$or/$regex/etc. behave like real MongoDB, not like a guess. Update
// operators ($set/$push/$pull/$addToSet/$inc/$setOnInsert) are hand-applied
// below since mingo doesn't do update application.
//
// This is a test harness, not a product feature — it is never required by
// server.js itself and ships in devDependencies only.
// ---------------------------------------------------------------------------
const { Query } = require('mingo');
const { ObjectId } = require('mongodb'); // the real BSON ObjectId — ids behave exactly like production

function clone(x) { return x === undefined ? x : JSON.parse(JSON.stringify(x)); }

function applyUpdate(doc, update) {
  const out = clone(doc) || {};
  for (const [op, spec] of Object.entries(update)) {
    if (op === '$set') {
      for (const [k, v] of Object.entries(spec)) setPath(out, k, v);
    } else if (op === '$setOnInsert') {
      // Only meaningful combined with upsert, handled by caller before calling applyUpdate on a fresh doc.
      for (const [k, v] of Object.entries(spec)) setPath(out, k, v);
    } else if (op === '$unset') {
      for (const k of Object.keys(spec)) unsetPath(out, k);
    } else if (op === '$inc') {
      for (const [k, v] of Object.entries(spec)) setPath(out, k, (getPath(out, k) || 0) + v);
    } else if (op === '$push') {
      for (const [k, v] of Object.entries(spec)) {
        const arr = getPath(out, k) || [];
        if (v && typeof v === 'object' && v.$each) arr.push(...v.$each);
        else arr.push(v);
        setPath(out, k, arr);
      }
    } else if (op === '$addToSet') {
      for (const [k, v] of Object.entries(spec)) {
        const arr = getPath(out, k) || [];
        const toAdd = (v && typeof v === 'object' && v.$each) ? v.$each : [v];
        for (const item of toAdd) {
          const exists = arr.some(a => JSON.stringify(a) === JSON.stringify(item));
          if (!exists) arr.push(item);
        }
        setPath(out, k, arr);
      }
    } else if (op === '$pull') {
      for (const [k, v] of Object.entries(spec)) {
        const arr = getPath(out, k) || [];
        const filtered = arr.filter(item => {
          if (v && typeof v === 'object' && !(v instanceof ObjectId)) {
            // condition object, e.g. { verified: false } or { id: 'x' }
            return !Object.entries(v).every(([fk, fv]) => item && item[fk] === fv);
          }
          return JSON.stringify(item) !== JSON.stringify(v);
        });
        setPath(out, k, filtered);
      }
    } else if (!op.startsWith('$')) {
      // A plain replacement doc (no operators at all) — replace wholesale.
      return clone(update);
    }
  }
  return out;
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = value;
}
function unsetPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null) return; cur = cur[parts[i]]; }
  delete cur[parts[parts.length - 1]];
}

class FakeCursor {
  constructor(docs) { this._docs = docs; }
  sort(spec) {
    const entries = Object.entries(spec || {});
    this._docs = [...this._docs].sort((a, b) => {
      for (const [k, dir] of entries) {
        const av = getPath(a, k), bv = getPath(b, k);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
      }
      return 0;
    });
    return this;
  }
  limit(n) { this._docs = this._docs.slice(0, n); return this; }
  skip(n) { this._docs = this._docs.slice(n); return this; }
  async toArray() { return clone(this._docs); }
}

class FakeCollection {
  constructor(name) { this.name = name; this._docs = []; this._indexes = []; }
  _match(query) {
    const q = query || {};
    const mq = new Query(q);
    return this._docs.filter(d => mq.test(d));
  }
  find(query) { return new FakeCursor(this._match(query)); }
  async findOne(query) { const r = this._match(query)[0]; return r ? clone(r) : null; }
  async insertOne(doc) {
    const toInsert = clone(doc);
    if (toInsert._id === undefined) toInsert._id = new ObjectId();
    this._docs.push(toInsert);
    return { acknowledged: true, insertedId: toInsert._id };
  }
  async insertMany(docs) {
    const ids = [];
    for (const d of docs) { const r = await this.insertOne(d); ids.push(r.insertedId); }
    return { acknowledged: true, insertedIds: ids };
  }
  async updateOne(query, update, opts = {}) {
    const match = this._match(query)[0];
    if (!match) {
      if (opts.upsert) {
        let base = {};
        for (const [k, v] of Object.entries(query)) if (typeof v !== 'object') base[k] = v;
        const applied = applyUpdate(base, update);
        await this.insertOne(applied);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    const idx = this._docs.indexOf(match);
    this._docs[idx] = applyUpdate(match, update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }
  async updateMany(query, update) {
    const matches = this._match(query);
    for (const m of matches) { const idx = this._docs.indexOf(m); this._docs[idx] = applyUpdate(m, update); }
    return { acknowledged: true, matchedCount: matches.length, modifiedCount: matches.length };
  }
  async deleteOne(query) {
    const match = this._match(query)[0];
    if (!match) return { acknowledged: true, deletedCount: 0 };
    this._docs.splice(this._docs.indexOf(match), 1);
    return { acknowledged: true, deletedCount: 1 };
  }
  async deleteMany(query) {
    const matches = this._match(query);
    for (const m of matches) this._docs.splice(this._docs.indexOf(m), 1);
    return { acknowledged: true, deletedCount: matches.length };
  }
  async countDocuments(query) { return this._match(query).length; }
  async createIndex() { return 'ok'; } // no-op — uniqueness isn't enforced by this stub
  async distinct(field, query) { return [...new Set(this._match(query).map(d => getPath(d, field)))]; }
}

class FakeDb {
  constructor() { this._collections = new Map(); }
  collection(name) {
    if (!this._collections.has(name)) this._collections.set(name, new FakeCollection(name));
    return this._collections.get(name);
  }
}

// GridFS stand-in: stores file bytes + metadata as plain in-memory Buffers,
// keyed by ObjectId, with a real Readable/Writable stream interface so
// server.js's .pipe(res) and multer-buffer .end() calls work unmodified.
const { Readable, Writable } = require('stream');
class FakeGridFSBucket {
  constructor(db, opts) {
    this._filesCollection = db.collection(`${opts.bucketName}.files`);
    this._store = new Map(); // id -> Buffer
  }
  openUploadStream(filename, opts = {}) {
    const id = new ObjectId();
    const chunks = [];
    const writable = new Writable({
      write: (chunk, enc, cb) => { chunks.push(chunk); cb(); },
      final: async (cb) => {
        this._store.set(id.toString(), Buffer.concat(chunks));
        await this._filesCollection.insertOne({ _id: id, filename, metadata: opts.metadata || {}, length: Buffer.concat(chunks).length, uploadDate: new Date() });
        cb();
      },
    });
    writable.id = id;
    return writable;
  }
  openDownloadStream(id) {
    const buf = this._store.get(id.toString());
    if (!buf) { const r = new Readable({ read() {} }); process.nextTick(() => r.emit('error', new Error('FileNotFound'))); return r; }
    return Readable.from(buf);
  }
  async delete(id) { this._store.delete(id.toString()); await this._filesCollection.deleteOne({ _id: id }); }
}

// Singleton in-process "database": every `new MongoClient()` in this process
// (server.js creates one; the test file creates its own to reach in and
// seed/inspect data) shares the same underlying FakeDb, exactly like two
// real MongoClient connections pointed at the same mongod would.
const sharedDb = new FakeDb();

class FakeMongoClient {
  constructor() { this._db = sharedDb; }
  async connect() { return this; }
  db() { return this._db; }
  async close() {}
}

module.exports = {
  MongoClient: FakeMongoClient,
  GridFSBucket: FakeGridFSBucket,
  ObjectId,
};
