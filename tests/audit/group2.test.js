'use strict';
const test = require('node:test');
const { BASE, db, otpService, newId, boot, resetTwoVerifiedPhones, loginTo, seedOtp, request, assert } = require('./_common');

let cookie;
test.before(async () => { await boot(); await resetTwoVerifiedPhones(); cookie = await loginTo(); });

test('AUDIT-6: an OTP issued for "password_change_1" cannot verify an add-phone request (purpose binding)', async () => {
  const { id, code } = await seedOtp({ purpose: 'password_change_1:whatever', phone: '917000000003' });
  const res = await request(BASE).post('/api/super/security/phones/verify').set('Cookie', cookie).send({ otp_id: id, code });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid code for this action/i);
});

test('AUDIT-7: wrong OTP code is rejected with a generic message (no hinting)', async () => {
  const { id } = await seedOtp({ purpose: 'add_phone', phone: '917000000004' });
  const res = await request(BASE).post('/api/super/security/phones/verify').set('Cookie', cookie).send({ otp_id: id, code: '000000' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Incorrect code.');
});

test('AUDIT-8: expired OTP is rejected', async () => {
  const code = '111111';
  const id = newId('otp');
  await db.collection('super_admin_otps').insertOne({
    id, purpose: 'add_phone', phone: '917000000005',
    otp_hash: otpService.hashOtp(code), attempts: 0, consumed: false,
    created_at: Date.now() - 10 * 60 * 1000,
    expires_at: new Date(Date.now() - 1000),
  });
  const res = await request(BASE).post('/api/super/security/phones/verify').set('Cookie', cookie).send({ otp_id: id, code });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /expired/i);
});

test('AUDIT-9: OTP is consumed after successful use and cannot be replayed', async () => {
  await db.collection('users').updateOne(
    { username: process.env.SUPER_ADMIN_USERNAME },
    { $set: { trusted_phones: [{ id: 'phoneA', phone: '911234567890', verified: true, created_at: Date.now() }] } }
  );
  const pendingPhone = '917000000006';
  await db.collection('users').updateOne(
    { username: process.env.SUPER_ADMIN_USERNAME },
    { $push: { trusted_phones: { id: 'phonePending', phone: pendingPhone, verified: false, created_at: Date.now() } } }
  );
  const { id, code } = await seedOtp({ purpose: 'add_phone', phone: pendingPhone });
  const first = await request(BASE).post('/api/super/security/phones/verify').set('Cookie', cookie).send({ otp_id: id, code });
  assert.equal(first.status, 200);
  const replay = await request(BASE).post('/api/super/security/phones/verify').set('Cookie', cookie).send({ otp_id: id, code });
  assert.equal(replay.status, 400);
  assert.match(replay.body.error, /already-used|invalid/i);
});
