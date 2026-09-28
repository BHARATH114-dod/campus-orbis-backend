'use strict';
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('node:crypto');

const PORT = 47000;
const BASE = `http://localhost:${PORT}`;

const otpService = require('../../services/otpService');
const fakeMongo = require('../support/fakeMongo');
const db = new fakeMongo.MongoClient().db();

function newId(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }

async function boot() {
  await require('../support/bootServer').start({ port: PORT });
}

async function resetTwoVerifiedPhones() {
  await db.collection('users').updateOne(
    { username: process.env.SUPER_ADMIN_USERNAME },
    { $set: { trusted_phones: [
      { id: 'phoneA', phone: '911234567890', verified: true, created_at: Date.now() },
      { id: 'phoneB', phone: '919876543210', verified: true, created_at: Date.now() },
    ] } }
  );
}

async function loginTo(password) {
  const res = await request(BASE).post('/api/auth/login').send({
    username: process.env.SUPER_ADMIN_USERNAME,
    password: password || process.env.SUPER_ADMIN_PASSWORD,
    role: 'super_admin',
  });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
  return res.headers['set-cookie'];
}

async function seedOtp({ purpose, phone }) {
  const code = '654321';
  const id = newId('otp');
  await db.collection('super_admin_otps').insertOne({
    id, purpose, phone,
    otp_hash: otpService.hashOtp(code),
    attempts: 0, consumed: false,
    created_at: Date.now(),
    expires_at: new Date(Date.now() + otpService.OTP_TTL_MS),
  });
  return { id, code };
}

module.exports = { PORT, BASE, db, otpService, newId, boot, resetTwoVerifiedPhones, loginTo, seedOtp, request, assert };
