'use strict';
// ---------------------------------------------------------------------------
// Rate limiting — Section 12. Deliberately NOT one single global limiter:
// security-sensitive/expensive endpoints get tight limits, everything else
// gets a much looser one so normal app usage (polling notifications, list
// views, etc.) is never affected.
// ---------------------------------------------------------------------------
const rateLimit = require('express-rate-limit');

const jsonLimitHandler = (req, res /*, next */) => {
  res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
};

// Login / credential-guessing surface: tight, per-IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

// Password reset / change and OTP send+verify: brute-force and SMS-bombing
// surface. Tighter than login because each hit can also cost real money
// (an SMS) or lock someone out of their own account.
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

const otpResendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

const passwordResetLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

// Untrusted code execution: expensive (network round-trip to Judge0) and a
// natural target for resource-exhaustion abuse.
const codeExecutionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

// File uploads (notes, bulk student import, profile photos, monitoring
// chunks aside — those are limited by test duration already).
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

// Messaging — generous, but still bounded so a compromised/malicious client
// can't spam every recipient in a tight loop.
const messagingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

// A gentle floor under the entire /api surface, mainly to blunt scripted
// scraping/DoS — high enough that no legitimate usage pattern (dashboard
// polling, search-as-you-type, etc.) should ever notice it.
const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

module.exports = {
  loginLimiter,
  otpLimiter,
  otpResendLimiter,
  passwordResetLimiter,
  codeExecutionLimiter,
  uploadLimiter,
  messagingLimiter,
  generalApiLimiter,
};
