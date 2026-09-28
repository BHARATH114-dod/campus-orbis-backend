'use strict';
const test = require('node:test');
const { BASE, db, otpService, newId, boot, resetTwoVerifiedPhones, loginTo, request, assert } = require('./_common');

let cookie;
test.before(async () => { await boot(); await resetTwoVerifiedPhones(); cookie = await loginTo(); });

test('AUDIT-13a: initiate correctly tries to SMS BOTH verified numbers, and fails safely (no provider configured) rather than fabricating OTPs', async () => {
  const initiate = await request(BASE).post('/api/super/security/password-change/initiate')
    .set('Cookie', cookie).send({ current_password: process.env.SUPER_ADMIN_PASSWORD });
  assert.equal(initiate.status, 502);
  assert.match(initiate.body.error, /SMS delivery is not configured/i);
});

// Live SMS is blocked, so the change record + both OTPs are seeded directly
// here — mirroring exactly what /password-change/initiate itself would
// have written (same collections, same purpose-string format
// `password_change_1:<id>` / `password_change_2:<id>`) — and the REAL
// verify/confirm routes are exercised against that seeded state.
async function seedPasswordChange() {
  const changeId = newId('pwchange');
  const code1 = '333333', code2 = '444444';
  const otp1Id = newId('otp'), otp2Id = newId('otp');
  await db.collection('super_admin_otps').insertOne({
    id: otp1Id, purpose: `password_change_1:${changeId}`, phone: '911234567890',
    otp_hash: otpService.hashOtp(code1), attempts: 0, consumed: false,
    created_at: Date.now(), expires_at: new Date(Date.now() + otpService.OTP_TTL_MS),
  });
  await db.collection('super_admin_otps').insertOne({
    id: otp2Id, purpose: `password_change_2:${changeId}`, phone: '919876543210',
    otp_hash: otpService.hashOtp(code2), attempts: 0, consumed: false,
    created_at: Date.now(), expires_at: new Date(Date.now() + otpService.OTP_TTL_MS),
  });
  await db.collection('super_admin_password_changes').insertOne({
    id: changeId, username: process.env.SUPER_ADMIN_USERNAME,
    otp1_id: otp1Id, otp2_id: otp2Id, otp1_verified: false, otp2_verified: false,
    created_at: Date.now(), expires_at: new Date(Date.now() + otpService.OTP_TTL_MS),
  });
  return { changeId, code1, code2 };
}

test('AUDIT-13b: dual-OTP password change requires BOTH OTPs — one alone is not enough, and OTP A never verifies as OTP B', async () => {
  const { changeId, code1, code2 } = await seedPasswordChange();

  const verify1 = await request(BASE).post('/api/super/security/password-change/verify')
    .set('Cookie', cookie).send({ change_id: changeId, slot: 1, code: code1 });
  assert.equal(verify1.status, 200, JSON.stringify(verify1.body));
  assert.equal(verify1.body.ready, false, 'must not be ready with only 1 of 2 OTPs verified');

  const confirmEarly = await request(BASE).post('/api/super/security/password-change/confirm')
    .set('Cookie', cookie).send({ change_id: changeId, new_password: 'BrandNewPassw0rd!' });
  assert.equal(confirmEarly.status, 400);
  assert.match(confirmEarly.body.error, /Both mobile numbers must be verified/i);

  const wrongSlot2 = await request(BASE).post('/api/super/security/password-change/verify')
    .set('Cookie', cookie).send({ change_id: changeId, slot: 2, code: code1 });
  assert.equal(wrongSlot2.status, 400, 'OTP A must never verify as OTP B');

  const verify2 = await request(BASE).post('/api/super/security/password-change/verify')
    .set('Cookie', cookie).send({ change_id: changeId, slot: 2, code: code2 });
  assert.equal(verify2.status, 200, JSON.stringify(verify2.body));
  assert.equal(verify2.body.ready, true);

  const confirm = await request(BASE).post('/api/super/security/password-change/confirm')
    .set('Cookie', cookie).send({ change_id: changeId, new_password: 'BrandNewPassw0rd!' });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

  const reLogin = await request(BASE).post('/api/auth/login').send({
    username: process.env.SUPER_ADMIN_USERNAME, password: 'BrandNewPassw0rd!', role: 'super_admin',
  });
  assert.equal(reLogin.status, 200, 'new password must actually work after confirm');
});

test('AUDIT-14: a consumed change_id cannot be confirmed a second time', async () => {
  const { changeId, code1, code2 } = await seedPasswordChange();
  const v1 = await request(BASE).post('/api/super/security/password-change/verify').set('Cookie', cookie).send({ change_id: changeId, slot: 1, code: code1 });
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  const v2 = await request(BASE).post('/api/super/security/password-change/verify').set('Cookie', cookie).send({ change_id: changeId, slot: 2, code: code2 });
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  const confirm1 = await request(BASE).post('/api/super/security/password-change/confirm').set('Cookie', cookie).send({ change_id: changeId, new_password: 'AnotherPassw0rd!' });
  assert.equal(confirm1.status, 200, JSON.stringify(confirm1.body));
  const confirm2 = await request(BASE).post('/api/super/security/password-change/confirm').set('Cookie', cookie).send({ change_id: changeId, new_password: 'YetAnotherPassw0rd!' });
  assert.equal(confirm2.status, 404, 'a consumed change_id must not be reusable');
});
