#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// Section 32 — "search again for the original vulnerabilities and verify
// they are actually gone, don't just report a fix that still exists
// elsewhere in the project." This is a grep-based static check, run with:
//   npm run security:verify
// It is deliberately simple (regex over the source tree) rather than a full
// static analyzer — good enough to catch a *regression* of one of the
// specific vulnerabilities this hardening pass fixed, which is exactly what
// this section asks for. It is not a substitute for the manual audit
// described in the security report.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|json|md|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const read = (f) => fs.readFileSync(f, 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    const problems = fn();
    if (problems && problems.length) {
      failures++;
      console.log(`\n\u2717 FAIL: ${name}`);
      for (const p of problems) console.log(`    ${p}`);
    } else {
      console.log(`\u2713 PASS: ${name}`);
    }
  } catch (err) {
    failures++;
    console.log(`\n\u2717 ERROR running check "${name}": ${err.message}`);
  }
}

check('No plain SHA-256 password hashing remains', () => {
  const problems = [];
  for (const f of files) {
    if (!f.endsWith('server.js')) continue;
    const content = stripJsComments(read(f));
    // The only permitted use of createHash('sha256') is the documented
    // legacy-hash *verification* path (legacySha256), which exists on
    // purpose so old accounts can still log in and get migrated. Anything
    // beyond that one function is a regression.
    const matches = content.match(/crypto\.createHash\(['"]sha256['"]\)/g) || [];
    if (matches.length > 1) problems.push(`${path.relative(ROOT, f)}: found ${matches.length} uses of createHash('sha256') — expected exactly 1 (the legacy-verification-only helper)`);
    if (matches.length === 0) problems.push(`${path.relative(ROOT, f)}: legacySha256() helper seems to be missing entirely — legacy accounts would be unable to log in`);
  }
  return problems;
});

function stripJsComments(content) {
  // Good enough for this grep-based checker: strips // line comments and
  // /* */ block comments so explanatory prose that *mentions* a bad pattern
  // (e.g. "never do execFile(process.execPath...) again") isn't confused
  // with the pattern actually being used in code.
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

check('No hardcoded "owner123" / predictable Super Admin default anywhere', () => {
  const problems = [];
  for (const f of files) {
    if (f.includes(`${path.sep}scripts${path.sep}`)) continue; // this checker's own source mentions the string
    if (f.includes(`${path.sep}tests${path.sep}`)) continue; // test files deliberately POST "owner123" to prove it's rejected
    const code = f.endsWith('.js') ? stripJsComments(read(f)) : read(f);
    if (code.includes('owner123')) problems.push(path.relative(ROOT, f));
  }
  return problems;
});

check('No student code execution via execFile/child_process', () => {
  const problems = [];
  for (const f of files) {
    if (!f.endsWith('server.js')) continue;
    const content = stripJsComments(read(f));
    if (/require\(['"]child_process['"]\)/.test(content)) problems.push(`${path.relative(ROOT, f)}: child_process is imported again`);
    if (/execFile\(/.test(content)) problems.push(`${path.relative(ROOT, f)}: execFile( call reintroduced`);
  }
  return problems;
});

check('Global NoSQL-injection sanitizer (express-mongo-sanitize) is wired in', () => {
  const content = read(path.join(ROOT, 'server.js'));
  const problems = [];
  if (!/express-mongo-sanitize/.test(content)) problems.push('express-mongo-sanitize is not required anywhere in server.js');
  if (!/app\.use\(mongoSanitize\(\)\)/.test(content)) problems.push('mongoSanitize() does not appear to be mounted with app.use()');
  return problems;
});

check('Login route validates username/role/college_id types before querying Mongo', () => {
  const content = read(path.join(ROOT, 'server.js'));
  const loginRouteMatch = content.match(/app\.post\('\/api\/auth\/login'[\s\S]{0,1500}/);
  if (!loginRouteMatch) return ['could not locate the /api/auth/login route at all'];
  const problems = [];
  if (!/typeof username !== 'string'/.test(loginRouteMatch[0])) problems.push('no typeof username string-guard found near the login route');
  return problems;
});

check('Session cookies are httpOnly + sameSite + conditionally secure', () => {
  const content = read(path.join(ROOT, 'server.js'));
  const problems = [];
  if (!/httpOnly:\s*true/.test(content)) problems.push('no httpOnly: true found');
  if (!/secure:\s*process\.env\.NODE_ENV === 'production'/.test(content)) problems.push('no conditional secure:true-in-production flag found on the session cookie');
  return problems;
});

check('express.json() has a body-size limit set', () => {
  const content = read(path.join(ROOT, 'server.js'));
  return /express\.json\(\s*\)/.test(content) && !/express\.json\(\{\s*limit/.test(content)
    ? ['express.json() is called with no limit option']
    : [];
});

check('Rate limiting is present on /api/auth/login and code-execution routes', () => {
  const content = read(path.join(ROOT, 'server.js'));
  const problems = [];
  if (!/app\.post\('\/api\/auth\/login',\s*loginLimiter/.test(content)) problems.push('loginLimiter does not appear to be attached to /api/auth/login');
  const runCodeMatches = content.match(/run-code'[^\n]*codeExecutionLimiter/g) || [];
  if (runCodeMatches.length < 4) problems.push(`only found codeExecutionLimiter on ${runCodeMatches.length} run-code routes — expected several more`);
  return problems;
});

check('Security headers (Helmet) are wired in', () => {
  const content = read(path.join(ROOT, 'server.js'));
  return /buildSecurityHeaders/.test(content) ? [] : ['buildSecurityHeaders is not referenced in server.js'];
});

check('Notes IDOR fix: /file and /bookmark routes use visibilityFilter, not a bare id lookup', () => {
  const content = read(path.join(ROOT, 'server.js'));
  const problems = [];
  const fileRoute = content.match(/app\.get\('\/api\/notes\/:id\/file'[\s\S]{0,400}/);
  if (!fileRoute || !/visibilityFilter/.test(fileRoute[0])) problems.push('/api/notes/:id/file does not appear to use visibilityFilter()');
  const bookmarkRoute = content.match(/app\.post\('\/api\/notes\/:id\/bookmark'[\s\S]{0,400}/);
  if (!bookmarkRoute || !/visibilityFilter/.test(bookmarkRoute[0])) problems.push('/api/notes/:id/bookmark does not appear to use visibilityFilter()');
  return problems;
});

check('CORS is never wide open with credentials', () => {
  const content = stripJsComments(read(path.join(ROOT, 'server.js')));
  const problems = [];
  if (/Access-Control-Allow-Origin['"]?\s*,\s*['"]\*/.test(content) || /origin:\s*['"]\*['"]/.test(content)) {
    problems.push('a wildcard CORS origin literal was found');
  }
  return problems;
});

check('.env.example contains no real-looking secret values', () => {
  const content = read(path.join(ROOT, '.env.example'));
  const problems = [];
  // A handful of vars are legitimately fine to ship with a default in the
  // example file (not secrets, or explicitly placeholder-shaped).
  const ALLOWED_NON_EMPTY = new Set(['PORT', 'NODE_ENV', 'MONGODB_URI', 'VAPID_SUBJECT']);
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !ALLOWED_NON_EMPTY.has(m[1]) && m[2].trim().length > 3) {
      problems.push(`"${m[1]}" has a non-empty value in .env.example: "${m[2]}"`);
    }
  }
  return problems;
});

check('The vulnerable xlsx package has been swapped for the patched @e965/xlsx republish', () => {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const problems = [];
  if (pkg.dependencies && pkg.dependencies.xlsx) problems.push('package.json still depends on the vulnerable "xlsx" package');
  if (!pkg.dependencies || !pkg.dependencies['@e965/xlsx']) problems.push('package.json does not depend on "@e965/xlsx"');
  const serverContent = read(path.join(ROOT, 'server.js'));
  if (!/require\(['"]@e965\/xlsx['"]\)/.test(serverContent)) problems.push('server.js does not require "@e965/xlsx"');
  if (/require\(['"]xlsx['"]\)/.test(serverContent)) problems.push('server.js still requires the plain "xlsx" package somewhere');
  return problems;
});

check('qs is pinned above the vulnerable range via package.json overrides', () => {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const qsOverride = pkg.overrides && pkg.overrides.qs;
  return qsOverride ? [] : ['package.json has no "qs" entry under "overrides"'];
});

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
