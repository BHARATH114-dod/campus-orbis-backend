'use strict';
const test = require('node:test');
const { BASE, db, otpService, boot, resetTwoVerifiedPhones, loginTo, seedOtp, request, assert } = require('./_common');

let cookie;
test.before(async () => { await boot(); await resetTwoVerifiedPhones(); cookie = await loginTo(); });

test('AUDIT-10: removing a number with 2 verified requires OTP, not a bare DELETE', async () => {
  const bare = await request(BASE).delete('/api/super/security/phones/phoneA').set('Cookie', cookie).send({});
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /OTP verification is required/i);
});

test('AUDIT-11a: initiate correctly tries to SMS the OTHER verified number, and fails safely (no provider configured) rather than fabricating an OTP', async () => {
  const initiate = await request(BASE).post('/api/super/security/phones/phoneA/remove/initiate')
    .set('Cookie', cookie).send({ current_password: process.env.SUPER_ADMIN_PASSWORD });
  assert.equal(initiate.status, 502);
  assert.match(initiate.body.error, /SMS delivery is not configured/i);
});

test('AUDIT-11b: given a delivered OTP (seeded here in place of the blocked live SMS) bound to remove_phone:phoneA, DELETE succeeds only with it', async () => {
  // Purpose string mirrors exactly what /remove/initiate itself constructs
  // (`remove_phone:${id}`) — this is not a bypass, it supplies the one
  // precondition (an SMS having been delivered) that's blocked in this
  // environment, then exercises the real verifyOtp() + DELETE route.
  const { id, code } = await seedOtp({ purpose: 'remove_phone:phoneA', phone: '919876543210' });

  // wrong code first — must not succeed
  const wrong = await request(BASE).delete('/api/super/security/phones/phoneA')
    .set('Cookie', cookie).send({ otp_id: id, code: '000000' });
  assert.equal(wrong.status, 400);

  const del = await request(BASE).delete('/api/super/security/phones/phoneA')
    .set('Cookie', cookie).send({ otp_id: id, code });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const fresh = await db.collection('users').findOne({ username: process.env.SUPER_ADMIN_USERNAME });
  assert.equal((fresh.trusted_phones || []).some(p => p.id === 'phoneA'), false);
});

test('AUDIT-11c: an OTP bound to remove_phone:phoneA cannot be replayed to remove a DIFFERENT number', async () => {
  // rebuild 2 verified numbers, then prove cross-target purpose binding
  await db.collection('users').updateOne(
    { username: process.env.SUPER_ADMIN_USERNAME },
    { $set: { trusted_phones: [
      { id: 'phoneA', phone: '911234567890', verified: true, created_at: Date.now() },
      { id: 'phoneC', phone: '917111111111', verified: true, created_at: Date.now() },
    ] } }
  );
  const { id, code } = await seedOtp({ purpose: 'remove_phone:phoneA', phone: '917111111111' });
  const del = await request(BASE).delete('/api/super/security/phones/phoneC')
    .set('Cookie', cookie).send({ otp_id: id, code });
  assert.equal(del.status, 400, 'an OTP issued to remove phoneA must not remove phoneC');
});

test('AUDIT-12: removing the last remaining number falls back to password re-verification (no OTP possible)', async () => {
  await db.collection('users').updateOne(
    { username: process.env.SUPER_ADMIN_USERNAME },
    { $set: { trusted_phones: [{ id: 'phoneOnly', phone: '911234567890', verified: true, created_at: Date.now() }] } }
  );
  const initiate = await request(BASE).post('/api/super/security/phones/phoneOnly/remove/initiate')
    .set('Cookie', cookie).send({ current_password: process.env.SUPER_ADMIN_PASSWORD });
  assert.equal(initiate.status, 200, JSON.stringify(initiate.body));
  assert.equal(initiate.body.requires_otp, false);
  const del = await request(BASE).delete('/api/super/security/phones/phoneOnly')
    .set('Cookie', cookie).send({ current_password: process.env.SUPER_ADMIN_PASSWORD });
  assert.equal(del.status, 200, JSON.stringify(del.body));
});
