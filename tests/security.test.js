'use strict';
// ---------------------------------------------------------------------------
// Section 30 security tests — password hashing + OTP mechanics.
//
// These are pure unit tests: no MongoDB, no network, no running server
// required (this sandbox has neither available), so they exercise the
// actual crypto/logic functions directly by re-implementing the same
// call shape used in server.js. Run with:  node --test tests/security.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// --- Re-declare the password service exactly as it exists in server.js ----
// (server.js is a single non-modular script, so these are duplicated here
// rather than imported — kept in sync by construction since both were
// authored together as part of this hardening pass. If the algorithm in
// server.js changes, update this block to match, or these tests will start
// giving false confidence.)
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password ?? ''), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}
function isLegacySha256Hash(hash) { return typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash); }
function legacySha256(password) { return crypto.createHash('sha256').update(String(password ?? '')).digest('hex'); }
function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let bufA, bufB;
  try { bufA = Buffer.from(a, 'hex'); bufB = Buffer.from(b, 'hex'); } catch { return false; }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
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
  try { derived = crypto.scryptSync(String(password ?? ''), salt, keyLen, { N, r, p }); }
  catch { return { valid: false, needsRehash: false }; }
  return { valid: timingSafeHexEqual(derived.toString('hex'), storedKeyHex), needsRehash: false };
}

test('password hashing: never stores or re-derives to plaintext', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.notEqual(hash, 'correct horse battery staple');
  assert.match(hash, /^scrypt\$/);
});

test('password hashing: correct password verifies, wrong password does not', () => {
  const hash = hashPassword('s3cur3-P@ssw0rd');
  assert.equal(verifyPassword('s3cur3-P@ssw0rd', hash).valid, true);
  assert.equal(verifyPassword('wrong-password', hash).valid, false);
});

test('password hashing: two hashes of the same password are different (random salt)', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
});

test('legacy SHA-256 migration: old-format hash still authenticates and is flagged for rehash', () => {
  const legacyHash = legacySha256('legacy-password-123');
  const result = verifyPassword('legacy-password-123', legacyHash);
  assert.equal(result.valid, true);
  assert.equal(result.needsRehash, true);
});

test('legacy SHA-256 migration: wrong password against a legacy hash fails, no rehash flag', () => {
  const legacyHash = legacySha256('legacy-password-123');
  const result = verifyPassword('totally-wrong', legacyHash);
  assert.equal(result.valid, false);
  assert.equal(result.needsRehash, false);
});

test('password verification: garbage/malformed stored hash never crashes and never validates', () => {
  for (const bad of [null, undefined, '', 'not-a-real-hash', 'scrypt$bad$format', 12345, {}]) {
    assert.doesNotThrow(() => verifyPassword('anything', bad));
    assert.equal(verifyPassword('anything', bad).valid, false);
  }
});

// --- OTP service -----------------------------------------------------------
const otpService = require('../services/otpService');

test('OTP: generated codes are always 6 digits, numeric', () => {
  for (let i = 0; i < 200; i++) {
    const code = otpService.generateOtpCode();
    assert.match(code, /^[0-9]{6}$/);
  }
});

test('OTP: masking shows only first 2 + last 3 digits', () => {
  assert.equal(otpService.maskPhone('9876543210'), '98*****210');
});

test('OTP: masking never returns the original number', () => {
  const phone = '9123456789';
  assert.notEqual(otpService.maskPhone(phone), phone);
  assert.ok(!otpService.maskPhone(phone).includes(phone.slice(2, 7)));
});

test('OTP: phone validation rejects non-numeric / wrong-length input', () => {
  assert.equal(otpService.isValidPhone('9876543210'), true); // 10 digits, valid
  assert.equal(otpService.isValidPhone('123'), false); // too short
  assert.equal(otpService.isValidPhone('98765abcde'), false); // non-numeric
  assert.equal(otpService.isValidPhone({ $ne: null }), false); // injection-shaped input, not a string at all
  assert.equal(otpService.isValidPhone('1'.repeat(20)), false); // too long
});

test('OTP: verifyOtp rejects with no live DB collection gracefully for malformed input', async () => {
  const fakeCollection = { findOne: async () => null };
  const result = await otpService.verifyOtp(fakeCollection, { otpId: 'does-not-exist', code: '123456' });
  assert.equal(result.valid, false);
});

test('OTP: verifyOtp enforces expiry', async () => {
  let deleted = false;
  const fakeCollection = {
    findOne: async () => ({ id: 'x', consumed: false, expires_at: new Date(Date.now() - 1000), attempts: 0, otp_hash: otpService.hashOtp('111111') }),
    deleteOne: async () => { deleted = true; },
  };
  const result = await otpService.verifyOtp(fakeCollection, { otpId: 'x', code: '111111' });
  assert.equal(result.valid, false);
  assert.match(result.error, /expired/i);
  assert.equal(deleted, true);
});

test('OTP: verifyOtp enforces max attempts', async () => {
  const fakeCollection = {
    findOne: async () => ({ id: 'x', consumed: false, expires_at: new Date(Date.now() + 60000), attempts: 5, otp_hash: otpService.hashOtp('111111') }),
    deleteOne: async () => {},
  };
  const result = await otpService.verifyOtp(fakeCollection, { otpId: 'x', code: '111111' });
  assert.equal(result.valid, false);
  assert.match(result.error, /too many/i);
});

test('OTP: verifyOtp is single-use (consumed OTPs are rejected)', async () => {
  const fakeCollection = {
    findOne: async () => ({ id: 'x', consumed: true, expires_at: new Date(Date.now() + 60000), attempts: 0, otp_hash: otpService.hashOtp('111111') }),
  };
  const result = await otpService.verifyOtp(fakeCollection, { otpId: 'x', code: '111111' });
  assert.equal(result.valid, false);
});

test('OTP: correct code against a live, unexpired, unconsumed OTP verifies', async () => {
  let updated = null;
  const fakeCollection = {
    findOne: async () => ({ id: 'x', consumed: false, expires_at: new Date(Date.now() + 60000), attempts: 0, otp_hash: otpService.hashOtp('654321'), phone: '9876543210', purpose: 'add_phone' }),
    updateOne: async (_q, u) => { updated = u; },
  };
  const result = await otpService.verifyOtp(fakeCollection, { otpId: 'x', code: '654321' });
  assert.equal(result.valid, true);
  assert.equal(result.phone, '9876543210');
  assert.deepEqual(updated.$set, { consumed: true }); // confirms it marks itself consumed, enforcing single-use
});

test('OTP: sendSms fails clearly (never silently succeeds) when no provider is configured', async () => {
  delete process.env.SMS_PROVIDER_URL;
  delete process.env.SMS_PROVIDER_API_KEY;
  const result = await otpService.sendSms('9876543210', 'test message');
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/i);
});
