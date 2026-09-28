'use strict';

const { Pool } = require('pg');
const { Query, Aggregator } = require('mingo');
const { ObjectId } = require('mongodb');
const { Readable, Writable, PassThrough } = require('stream');

function clone(x) {
  return x === undefined ? x : JSON.parse(JSON.stringify(x));
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

function applyUpdate(doc, update) {
  const out = clone(doc) || {};
  for (const [op, spec] of Object.entries(update)) {
    if (op === '$set') {
      for (const [k, v] of Object.entries(spec)) setPath(out, k, v);
    } else if (op === '$setOnInsert') {
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
            return !Object.entries(v).every(([fk, fv]) => item && item[fk] === fv);
          }
          return JSON.stringify(item) !== JSON.stringify(v);
        });
        setPath(out, k, filtered);
      }
    } else if (!op.startsWith('$')) {
      return clone(update);
    }
  }
  return out;
}

class SupabaseCursor {
  constructor(docs) {
    this._docs = docs;
  }
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
  limit(n) {
    this._docs = this._docs.slice(0, n);
    return this;
  }
  skip(n) {
    this._docs = this._docs.slice(n);
    return this;
  }
  project(spec) {
    if (!spec || Object.keys(spec).length === 0) return this;
    const include = Object.values(spec).some(v => v === 1 || v === true);
    this._docs = this._docs.map(doc => {
      const out = {};
      if (include) {
        if (spec._id !== 0 && spec._id !== false && doc._id !== undefined) out._id = doc._id;
        for (const [k, v] of Object.entries(spec)) {
          if (v && doc[k] !== undefined) out[k] = clone(doc[k]);
        }
      } else {
        Object.assign(out, clone(doc));
        for (const [k, v] of Object.entries(spec)) {
          if (!v) delete out[k];
        }
      }
      return out;
    });
    return this;
  }
  async toArray() {
    return clone(this._docs);
  }
}

class SupabaseCollection {
  constructor(name, pool) {
    this.name = name;
    this.pool = pool;
    this._docs = [];
    this._loaded = false;
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    if (this.name === 'storage_files') {
      this._loaded = true;
      return;
    }
    try {
      const res = await this.pool.query(`SELECT id, doc FROM ${this.name};`);
      this._docs = res.rows.map(r => {
        const d = r.doc;
        if (d && !d._id && r.id) d._id = r.id;
        return d;
      });
      this._loaded = true;
    } catch (err) {
      // If table doesn't exist yet, create it on demand
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${this.name} (
            id TEXT PRIMARY KEY,
            doc JSONB NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_${this.name}_doc ON ${this.name} USING gin (doc);
        `);
        this._loaded = true;
      } catch (e) {
        console.warn(`[SupabaseCollection] Could not initialize table ${this.name}:`, e.message);
        this._loaded = true;
      }
    }
  }

  _match(query) {
    const q = query || {};
    // Handle ObjectId in query matching
    const mq = new Query(q);
    return this._docs.filter(d => mq.test(d));
  }

  find(query) {
    const matched = this._match(query);
    return new SupabaseCursor(matched);
  }

  async findOne(query) {
    await this._ensureLoaded();
    const r = this._match(query)[0];
    return r ? clone(r) : null;
  }

  async insertOne(doc) {
    await this._ensureLoaded();
    const toInsert = clone(doc);
    if (toInsert._id === undefined) toInsert._id = new ObjectId();
    const docId = toInsert.id || String(toInsert._id);

    this._docs.push(toInsert);

    // Write-through to Supabase
    try {
      await this.pool.query(
        `INSERT INTO ${this.name} (id, doc) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc;`,
        [docId, JSON.stringify(toInsert)]
      );
    } catch (err) {
      console.error(`[SupabaseCollection ${this.name}] insertOne error:`, err.message);
    }

    return { acknowledged: true, insertedId: toInsert._id };
  }

  async insertMany(docs) {
    const ids = [];
    for (const d of docs) {
      const r = await this.insertOne(d);
      ids.push(r.insertedId);
    }
    return { acknowledged: true, insertedIds: ids };
  }

  async updateOne(query, update, opts = {}) {
    await this._ensureLoaded();
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
    const updated = applyUpdate(match, update);
    this._docs[idx] = updated;

    const docId = updated.id || String(updated._id);
    try {
      await this.pool.query(
        `UPDATE ${this.name} SET doc = $2::jsonb WHERE id = $1;`,
        [docId, JSON.stringify(updated)]
      );
    } catch (err) {
      console.error(`[SupabaseCollection ${this.name}] updateOne error:`, err.message);
    }

    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(query, update) {
    await this._ensureLoaded();
    const matches = this._match(query);
    for (const m of matches) {
      const idx = this._docs.indexOf(m);
      const updated = applyUpdate(m, update);
      this._docs[idx] = updated;
      const docId = updated.id || String(updated._id);
      try {
        await this.pool.query(
          `UPDATE ${this.name} SET doc = $2::jsonb WHERE id = $1;`,
          [docId, JSON.stringify(updated)]
        );
      } catch (err) {
        console.error(`[SupabaseCollection ${this.name}] updateMany error:`, err.message);
      }
    }
    return { acknowledged: true, matchedCount: matches.length, modifiedCount: matches.length };
  }

  async deleteOne(query) {
    await this._ensureLoaded();
    const match = this._match(query)[0];
    if (!match) return { acknowledged: true, deletedCount: 0 };

    this._docs.splice(this._docs.indexOf(match), 1);
    const docId = match.id || String(match._id);
    try {
      await this.pool.query(`DELETE FROM ${this.name} WHERE id = $1;`, [docId]);
    } catch (err) {
      console.error(`[SupabaseCollection ${this.name}] deleteOne error:`, err.message);
    }
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(query) {
    await this._ensureLoaded();
    const matches = this._match(query);
    for (const m of matches) {
      this._docs.splice(this._docs.indexOf(m), 1);
      const docId = m.id || String(m._id);
      try {
        await this.pool.query(`DELETE FROM ${this.name} WHERE id = $1;`, [docId]);
      } catch (err) {
        console.error(`[SupabaseCollection ${this.name}] deleteMany error:`, err.message);
      }
    }
    return { acknowledged: true, deletedCount: matches.length };
  }

  async countDocuments(query) {
    await this._ensureLoaded();
    return this._match(query).length;
  }

  async distinct(field, query) {
    await this._ensureLoaded();
    return [...new Set(this._match(query).map(d => getPath(d, field)))];
  }

  async findOneAndUpdate(query, update, opts = {}) {
    await this._ensureLoaded();
    const match = this._match(query)[0];
    if (!match && opts.upsert) {
      let base = {};
      for (const [k, v] of Object.entries(query)) if (typeof v !== 'object') base[k] = v;
      const applied = applyUpdate(base, update);
      await this.insertOne(applied);
      return { value: applied };
    }
    if (!match) return { value: null };
    const original = clone(match);
    await this.updateOne(query, update, opts);
    return { value: opts.returnDocument === 'after' ? this._match(query)[0] : original };
  }

  aggregate(pipeline = []) {
    const agg = new Aggregator(pipeline);
    const results = agg.run(this._docs);
    return new SupabaseCursor(results);
  }

  async createIndex() {
    return 'ok';
  }
}

class SupabaseGridFSBucket {
  constructor(db, opts = {}) {
    this.db = db;
    this.bucketName = opts.bucketName || 'storage_files';
    this.pool = db.pool;
  }

  openUploadStream(filename, opts = {}) {
    const id = new ObjectId();
    const chunks = [];
    const writable = new Writable({
      write: (chunk, enc, cb) => {
        chunks.push(chunk);
        cb();
      },
      final: async (cb) => {
        const fullBuffer = Buffer.concat(chunks);
        const base64 = fullBuffer.toString('base64');
        const fileId = String(id);
        const metadata = opts.metadata || {};

        try {
          await this.pool.query(
            `INSERT INTO storage_files (id, bucket, filename, content_type, length, data, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data;`,
            [
              fileId,
              this.bucketName,
              filename,
              opts.contentType || 'application/octet-stream',
              fullBuffer.length,
              base64,
              JSON.stringify(metadata)
            ]
          );
        } catch (err) {
          console.error(`[SupabaseGridFS ${this.bucketName}] openUploadStream error:`, err.message);
        }
        cb();
      }
    });
    writable.id = id;
    return writable;
  }

  async getFile(id) {
    const fileId = String(id);
    try {
      const res = await this.pool.query(
        `SELECT data, content_type, filename, length FROM storage_files WHERE id = $1 LIMIT 1;`,
        [fileId]
      );
      if (!res.rows || res.rows.length === 0 || !res.rows[0].data) return null;
      return {
        buffer: Buffer.from(res.rows[0].data, 'base64'),
        contentType: res.rows[0].content_type || 'image/jpeg',
        filename: res.rows[0].filename,
        length: Number(res.rows[0].length)
      };
    } catch (err) {
      console.error(`[SupabaseGridFS ${this.bucketName}] getFile error:`, err.message);
      return null;
    }
  }

  openDownloadStream(id) {
    const fileId = String(id);
    const pt = new PassThrough();

    this.pool.query(
      `SELECT data, content_type, filename FROM storage_files WHERE id = $1 LIMIT 1;`,
      [fileId]
    ).then(res => {
      if (!res.rows || res.rows.length === 0 || !res.rows[0].data) {
        pt.emit('error', new Error('FileNotFound'));
        return;
      }
      pt.contentType = res.rows[0].content_type;
      pt.filename = res.rows[0].filename;
      pt.emit('file', { contentType: res.rows[0].content_type, filename: res.rows[0].filename });
      const buf = Buffer.from(res.rows[0].data, 'base64');
      pt.end(buf);
    }).catch(err => {
      pt.emit('error', err);
    });

    return pt;
  }

  async delete(id) {
    const fileId = String(id);
    try {
      await this.pool.query(`DELETE FROM storage_files WHERE id = $1;`, [fileId]);
    } catch (err) {
      console.error(`[SupabaseGridFS ${this.bucketName}] delete error:`, err.message);
    }
  }

  find(query = {}) {
    const cursor = {
      toArray: async () => {
        try {
          const res = await this.pool.query(
            `SELECT id, bucket, filename, content_type, length, metadata, upload_date FROM storage_files WHERE bucket = $1;`,
            [this.bucketName]
          );
          return res.rows.map(r => ({
            _id: new ObjectId(r.id.length === 24 ? r.id : undefined),
            id: r.id,
            filename: r.filename,
            contentType: r.content_type,
            length: Number(r.length),
            metadata: r.metadata,
            uploadDate: r.upload_date
          }));
        } catch (err) {
          return [];
        }
      }
    };
    return cursor;
  }
}

class SupabaseDb {
  constructor(pool) {
    this.pool = pool;
    this._collections = new Map();
  }

  collection(name) {
    if (!this._collections.has(name)) {
      this._collections.set(name, new SupabaseCollection(name, this.pool));
    }
    return this._collections.get(name);
  }

  async initAllTables() {
    try {
      const res = await this.pool.query(`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
      `);
      const loadPromises = res.rows
        .filter(row => row.table_name !== 'storage_files')
        .map(row => this.collection(row.table_name)._ensureLoaded());
      await Promise.all(loadPromises);
      console.log(`[SupabaseAdapter] Loaded data for ${loadPromises.length} tables from Supabase.`);
    } catch (err) {
      console.error('[SupabaseAdapter] Error initializing tables:', err.message);
    }
  }
}

class SupabaseMongoClient {
  constructor(connectionString, opts = {}) {
    this.connectionString = connectionString;
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 20
    });
    this._db = new SupabaseDb(this.pool);
  }

  async connect() {
    const client = await this.pool.connect();
    client.release();
    await this._db.initAllTables();
    return this;
  }

  db() {
    return this._db;
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = {
  MongoClient: SupabaseMongoClient,
  GridFSBucket: SupabaseGridFSBucket,
  ObjectId
};
