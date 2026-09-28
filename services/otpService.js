'use strict';
// ---------------------------------------------------------------------------
// otpService — Sections 4-7 of the hardening pass (Super Admin mobile-number
// OTP verification + dual-OTP password change).
//
// SMS delivery is intentionally pluggable and, out of the box, NOT
// configured. This project has no SMS provider credentials anywhere in it
// (no Twilio/MSG91/etc. keys), and the spec explicitly forbids ever logging
// an OTP value as a substitute — so rather than fake-deliver OTPs to the
// server console (which would violate "never log OTP values" the moment
// someone wired this up against real users), sendSms() below fails loudly
// and tells the caller SMS isn't configured, until a real provider is wired
// in via SMS_PROVIDER_URL/SMS_PROVIDER_API_KEY (see sendSms below). This is
// called out again in the final security report as an explicit unresolved
// item — the OTP *mechanics* (hashing, expiry, rate limits, single-use,
// masking) are all real and enforced; only the transport is a stub.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_MAX_VERIFY_ATTEMPTS = 5;

function generateOtpCode() {
  // Uniform 0..999999 via rejection sampling on a crypto-random byte range,
  // so the code is not just "cryptographically random bytes mod 1e6" (which
  // would very slightly bias low values) — good hygiene for a 6-digit code
  // even though the practical bias would be negligible either way.
  const max = 1000000;
  const range = Math.floor(0x100000000 / max) * max;
  let x;
  do { x = crypto.randomBytes(4).readUInt32BE(0); } while (x >= range);
  return String(x % max).padStart(OTP_LENGTH, '0');
}

// OTPs are stored hashed (SHA-256 + a server-side pepper from OTP_PEPPER, if
// set) — never in plaintext — so a database read alone never discloses a
// usable code. A 6-digit space is small enough that a slow KDF isn't the
// point here; what matters is (a) not storing plaintext, (b) short TTL, and
// (c) attempt limits, all of which are enforced below.
function hashOtp(code) {
  const pepper = process.env.OTP_PEPPER || '';
  return crypto.createHash('sha256').update(`${pepper}:${code}`).digest('hex');
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let bufA, bufB;
  try { bufA = Buffer.from(a, 'hex'); bufB = Buffer.from(b, 'hex'); } catch { return false; }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Masks a mobile number as "first 2 digits + stars + last 3 digits" per
// Section 5. Falls back to full masking for anything shorter than that
// would meaningfully reveal.
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6) return '*'.repeat(digits.length);
  const first = digits.slice(0, 2);
  const last = digits.slice(-3);
  const middleStars = '*'.repeat(Math.max(digits.length - 5, 4));
  return `${first}${middleStars}${last}`;
}

// Very deliberately conservative validation: digits only, 8-15 of them
// (E.164 max length minus the leading "+", which we don't require the
// caller to include). Reject anything else server-side regardless of what
// client-side validation may or may not have done.
function isValidPhone(phone) {
  return typeof phone === 'string' && /^[0-9]{8,15}$/.test(phone.trim());
}

// Two concrete transports are supported out of the box:
//   1. Twilio — the most common real-world choice, wired to their actual
//      REST API shape (Basic Auth with Account SID/Auth Token, form-encoded
//      body), so setting the three TWILIO_* env vars below is enough to
//      really send SMS with no code changes.
//   2. A generic JSON-webhook provider (SMS_PROVIDER_URL/API_KEY) for any
//      other provider or an internal gateway.
// If neither is configured, delivery fails loudly and explains what to set
// — it never fakes success or logs the OTP as a workaround (see file header).
async function sendSms(phone, message) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;
  if (twilioSid && twilioToken && twilioFrom) {
    try {
      const body = new URLSearchParams({ To: phone.startsWith('+') ? phone : `+${phone}`, From: twilioFrom, Body: message });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64')}`,
        },
        body,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Twilio returned HTTP ${res.status}.${detail ? ` ${detail.slice(0, 200)}` : ''}` };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach Twilio.' };
    }
  }

  const url = process.env.SMS_PROVIDER_URL;
  const apiKey = process.env.SMS_PROVIDER_API_KEY;
  if (!url || !apiKey) {
    // No provider configured — fail clearly rather than silently "succeeding"
    // or logging the OTP as a workaround. See file header.
    return { ok: false, error: 'SMS delivery is not configured on this server. Set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER, or SMS_PROVIDER_URL/SMS_PROVIDER_API_KEY, to enable OTP delivery.' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to: phone, message }),
    });
    if (!res.ok) return { ok: false, error: `SMS provider returned HTTP ${res.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not reach the SMS provider.' };
  }
}

// Creates and stores a hashed OTP for the given purpose/subject, then
// attempts delivery. Returns {ok, id, error}. `id` is an opaque reference
// the caller stores server-side (never sent to the client) to look the OTP
// back up on verification.
async function issueOtp(SuperAdminOtps, { purpose, phone, newId }) {
  const code = generateOtpCode();
  const doc = {
    id: newId('otp'),
    purpose, // e.g. 'add_phone', 'password_change_1', 'password_change_2'
    phone,
    otp_hash: hashOtp(code),
    attempts: 0,
    consumed: false,
    created_at: Date.now(),
    expires_at: new Date(Date.now() + OTP_TTL_MS),
  };
  await SuperAdminOtps.insertOne(doc);
  const delivery = await sendSms(phone, `Your Campus Orbis verification code is ${code}. It expires in 5 minutes.`);
  if (!delivery.ok) {
    // Delivery failed — remove the now-undeliverable OTP rather than leaving
    // a live, never-sendable code sitting in the database.
    await SuperAdminOtps.deleteOne({ id: doc.id });
    return { ok: false, error: delivery.error };
  }
  return { ok: true, id: doc.id };
}

// Verifies a submitted code against the stored OTP document. Single-use
// (consumed on success), attempt-limited, and expiry-checked independently
// of Mongo's TTL reaper (which runs on its own schedule, not instantly).
async function verifyOtp(SuperAdminOtps, { otpId, code }) {
  if (!otpId || typeof code !== 'string') return { valid: false, error: 'Invalid request.' };
  const doc = await SuperAdminOtps.findOne({ id: otpId });
  if (!doc || doc.consumed) return { valid: false, error: 'Invalid or already-used code.' };
  if (new Date(doc.expires_at).getTime() < Date.now()) {
    await SuperAdminOtps.deleteOne({ id: otpId });
    return { valid: false, error: 'This code has expired. Request a new one.' };
  }
  if (doc.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
    await SuperAdminOtps.deleteOne({ id: otpId });
    return { valid: false, error: 'Too many incorrect attempts. Request a new code.' };
  }
  const isMatch = timingSafeHexEqual(hashOtp(code.trim()), doc.otp_hash);
  if (!isMatch) {
    await SuperAdminOtps.updateOne({ id: otpId }, { $inc: { attempts: 1 } });
    return { valid: false, error: 'Incorrect code.' };
  }
  await SuperAdminOtps.updateOne({ id: otpId }, { $set: { consumed: true } });
  return { valid: true, phone: doc.phone, purpose: doc.purpose };
}

module.exports = {
  OTP_TTL_MS,
  generateOtpCode,
  hashOtp,
  maskPhone,
  isValidPhone,
  sendSms,
  issueOtp,
  verifyOtp,
};
