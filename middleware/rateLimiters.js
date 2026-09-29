'use strict';
// ---------------------------------------------------------------------------
// Rate limiting — Hardened for Institutional & Campus Wi-Fi environments.
//
// In a college, dozens or hundreds of students (60+ per lab/class) share the
// exact same public NAT IP address.
// 
// Key fixes:
//  1. Client Key Isolation: Authenticated requests (taking tests, autosaving,
//     submitting code, browsing) are keyed by their individual Bearer/Session
//     token rather than the shared college IP. Each student has their own quota!
//  2. Login Protection: `skipSuccessfulRequests: true` ensures that students
//     logging in with valid credentials NEVER consume the rate limiter quota.
//     Only failed attempts (brute-force password guessing) are counted, and
//     keyed by IP + username so one typo doesn't block the rest of the lab.
//  3. General & Test Limits: Raised ceilings to comfortably handle continuous
//     monitoring chunks, live heartbeats, autosave, and code runs for 100+
//     concurrent students taking an exam simultaneously on the same network.
// ---------------------------------------------------------------------------
const rateLimit = require('express-rate-limit');

const jsonLimitHandler = (req, res /*, next */) => {
  res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
};

// Helper: extracts unique student token/user if signed in, or falls back to IP
function getClientKey(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return `token_${token}`;
  }
  if (req.cookies && req.cookies.campusync_session) {
    return `cookie_${req.cookies.campusync_session}`;
  }
  if (req.headers && req.headers['x-session-token']) {
    return `sess_${req.headers['x-session-token']}`;
  }
  if (req.query && req.query.token) {
    return `query_${req.query.token}`;
  }
  if (req.user && req.user.username) {
    return `user_${req.user.username}`;
  }
  return req.ip;
}

// Login: Only count FAILED login attempts. Keyed by targeted username when present
// so 60-100 students logging in at the start of a class from the same lab Wi-Fi
// will never block each other.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 2000, // 2,000 failed attempts per 15 min
  skipSuccessfulRequests: true, // SUCCESSFUL LOGINS NEVER COUNT AGAINST RATE LIMIT!
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const username = (req.body && typeof req.body.username === 'string')
      ? req.body.username.trim().toLowerCase()
      : '';
    return username ? `login_${username}` : `${req.ip}_anon`;
  },
  handler: jsonLimitHandler,
});

// Password reset / change and OTP send+verify
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const target = req.body?.phone || req.body?.username || '';
    return `${req.ip}_${target}`;
  },
  handler: jsonLimitHandler,
});

const otpResendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const target = req.body?.phone || req.body?.username || '';
    return `${req.ip}_${target}`;
  },
  handler: jsonLimitHandler,
});

const passwordResetLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const target = req.body?.username || req.body?.change_id || '';
    return `${req.ip}_${target}`;
  },
  handler: jsonLimitHandler,
});

// Untrusted code execution (exams and coding practice):
// Keyed by student token so every student in the lab gets their own 300 runs/min!
const codeExecutionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300, // 300 code runs per minute per student
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: getClientKey,
  handler: jsonLimitHandler,
});

// File uploads
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 500,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: getClientKey,
  handler: jsonLimitHandler,
});

// Messaging
const messagingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: getClientKey,
  handler: jsonLimitHandler,
});

// General API surface:
// Handles polling, live camera/mic monitoring chunks, heartbeats, autosave, etc.
// Keyed by user token so each student has their own 20,000 req/min quota.
// Unauthenticated IP fallback is also high so hundreds of devices on college Wi-Fi never collide.
const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20000, // 20,000 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: getClientKey,
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
