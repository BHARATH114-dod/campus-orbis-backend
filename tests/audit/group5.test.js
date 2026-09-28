'use strict';
const test = require('node:test');
const { BASE, boot, request, assert } = require('./_common');

test.before(async () => { await boot(); });

test('AUDIT-15: "SACO" as a header/body/query value grants no privilege on a protected route', async () => {
  const res1 = await request(BASE).get('/api/super/security/phones').set('X-Discovery', 'SACO');
  assert.equal(res1.status, 401, 'unauthenticated request must still be rejected regardless of any SACO value supplied');
  const res2 = await request(BASE).get('/api/super/security/phones?keyword=SACO');
  assert.equal(res2.status, 401);
});
