'use strict';
const test = require('node:test');
const { BASE, db, boot, resetTwoVerifiedPhones, loginTo, request, assert } = require('./_common');

let cookie;
test.before(async () => { await boot(); await resetTwoVerifiedPhones(); cookie = await loginTo(); });

test('AUDIT-1: phone list is always masked, never the raw number', async () => {
  const res = await request(BASE).get('/api/super/security/phones').set('Cookie', cookie);
  assert.equal(res.status, 200);
  for (const p of res.body.phones) {
    assert.equal(JSON.stringify(p).includes('911234567890'), false);
    assert.equal(JSON.stringify(p).includes('919876543210'), false);
    assert.match(p.maskedNumber, /\*/);
  }
});

test('AUDIT-2: adding a 3rd number is blocked before any OTP is issued (max 2 enforced)', async () => {
  const res = await request(BASE).post('/api/super/security/phones').set('Cookie', cookie).send({ phone: '917000000001' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already have 2 verified/i);
});

test('AUDIT-3: duplicate of an existing verified number is rejected', async () => {
  await db.collection('users').updateOne(
    { username: process.env.SUPER_ADMIN_USERNAME },
    { $set: { trusted_phones: [{ id: 'phoneA', phone: '911234567890', verified: true, created_at: Date.now() }] } }
  );
  const res = await request(BASE).post('/api/super/security/phones').set('Cookie', cookie).send({ phone: '911234567890' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already verified/i);
});

test('AUDIT-4: invalid phone format is rejected before any OTP is issued', async () => {
  const res = await request(BASE).post('/api/super/security/phones').set('Cookie', cookie).send({ phone: 'abc123' });
  assert.equal(res.status, 400);
});

test('AUDIT-5: SMS send fails safely (never fakes success) when no provider is configured', async () => {
  const res = await request(BASE).post('/api/super/security/phones').set('Cookie', cookie).send({ phone: '917000000002' });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /SMS delivery is not configured/i);
  const fresh = await db.collection('users').findOne({ username: process.env.SUPER_ADMIN_USERNAME });
  assert.equal((fresh.trusted_phones || []).filter(p => p.verified).length, 1, 'a failed send must not leave a phantom verified number');
});
