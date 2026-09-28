'use strict';
// ---------------------------------------------------------------------------
// A deliberately tiny, dependency-free stand-in for the handful of MongoDB
// query shapes services/bulkImport.js actually issues (checked by grepping
// that file — see the comment at the top of bulkImport.unit.test.js).
//
// This is NOT a replacement for tests/support/fakeMongo.js (which backs the
// full integration smoke test and uses the real `mingo` query engine for
// full MongoDB operator fidelity). fakeMongo needs the `mingo` and
// `mongodb` npm packages installed; this file needs nothing beyond Node
// itself, which is what makes it possible to unit-test bulkImport.js's
// validation logic in a sandbox with no network access to npm.
//
// Supported filter shapes only: exact-value equality, { $in: [...] }, and a
// top-level $or of such filters. That is the complete set bulkImport.js
// uses today (Users.find / Clubs.find). insertMany here NEVER enforces
// uniqueness (no indexes) — it's here to test the "everything valid gets
// created" path; bulkImport.js's duplicate-key handling on insertMany is
// exercised separately in server.js's real integration test (with the real
// MongoDB driver / fakeMongo+mingo), not here.
// ---------------------------------------------------------------------------
function clone(x) { return x === undefined ? x : JSON.parse(JSON.stringify(x)); }

function matchesClause(doc, field, cond) {
  const val = doc[field];
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && '$in' in cond) {
    return cond.$in.includes(val);
  }
  return val === cond;
}

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter || {})) {
    if (key === '$or') {
      if (!cond.some((sub) => matches(doc, sub))) return false;
      continue;
    }
    if (!matchesClause(doc, key, cond)) return false;
  }
  return true;
}

class TinyCursor {
  constructor(docs) { this._docs = docs; }
  async toArray() { return clone(this._docs); }
}

class TinyCollection {
  constructor(seed = []) { this._docs = seed.map(clone); }
  find(filter) { return new TinyCursor(this._docs.filter((d) => matches(d, filter))); }
  async findOne(filter) {
    const hit = this._docs.find((d) => matches(d, filter));
    return hit ? clone(hit) : null;
  }
  async insertOne(doc) { this._docs.push(clone(doc)); return { acknowledged: true }; }
  async insertMany(docs) { for (const d of docs) this._docs.push(clone(d)); return { acknowledged: true }; }
  all() { return clone(this._docs); }
}

module.exports = { TinyCollection };
