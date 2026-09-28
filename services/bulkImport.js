'use strict';
// ---------------------------------------------------------------------------
// Bulk Excel/CSV import helpers — students and clubs.
//
// Everything in here is deliberately free of Express/multer/global state: the
// caller (server.js) passes in the SheetJS module, the Mongo collections and
// the few server helpers this needs (newId, hashPasswordAsync, ...). That keeps
// the routes in server.js thin and lets the parsing/validation rules be unit
// tested without booting the whole app (see tests/bulkImport.unit.test.js).
//
// Two-phase flow used by the routes:
//   1. PREVIEW  — parse + validate, write nothing, return row-level statuses.
//   2. IMPORT   — the file is parsed and validated AGAIN on the server (the
//                 preview is never trusted), then only the rows/clubs that
//                 pass are written, and a per-row / per-club report is returned.
// ---------------------------------------------------------------------------

const MAX_IMPORT_ROWS = 3000;      // hard ceiling on data rows per file
const MAX_IMPORT_COLUMNS = 200;    // sanity ceiling before converting a sheet
const MAX_HEADER_SCAN_ROWS = 25;   // header row may sit below a title/blank rows
const IN_CHUNK = 1000;             // max values per $in query
const INSERT_CHUNK = 500;          // docs per insertMany
const HASH_CONCURRENCY = 4;        // parallel scrypt calls (libuv pool is 4 threads)

// ---------------------------------------------------------------------------
// Generic sheet reading
// ---------------------------------------------------------------------------
function normalizeHeader(h) {
  return String(h == null ? '' : h).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Trim, drop zero-width/BOM/NBSP junk that Excel and CSV exports love to add,
// and cap the length so one crafted cell can never bloat a document.
function cleanCell(v, max = 300) {
  return String(v == null ? '' : v)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .slice(0, max);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Reads the FIRST sheet into an array-of-arrays. Unlike sheet_to_json's
// default object mode this keeps blank rows, so the row numbers we report
// ("Row 8") are the real Excel row numbers even when the sheet has gaps or
// starts below row 1. The sheet's declared size is checked BEFORE conversion
// so a tiny, highly-compressed workbook can't expand into a huge array.
function readSheetMatrix(XLSX, buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', codepage: 65001, cellFormula: false, cellHTML: false });
  } catch (err) {
    return { error: 'Could not read that file. Make sure it is a valid Excel (.xlsx/.xls) or CSV file.' };
  }
  const sheetName = wb.SheetNames && wb.SheetNames[0];
  if (!sheetName) return { error: 'That file has no sheets.' };
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) return { error: 'The first sheet is empty.' };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rowCount = range.e.r - range.s.r + 1;
  const colCount = range.e.c - range.s.c + 1;
  if (rowCount > MAX_IMPORT_ROWS + MAX_HEADER_SCAN_ROWS + 1 || colCount > MAX_IMPORT_COLUMNS) {
    return { error: `That sheet is too large — please split it into files of ${MAX_IMPORT_ROWS} rows or fewer.` };
  }
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
  return { matrix, firstRowNumber: range.s.r + 1 };
}

// Finds the header row (the first row, within the first few, that contains at
// least `minMatches` recognised column names) and returns every following
// non-blank row as { row, <field>: value }. Only fields from the fixed alias
// table are ever copied — arbitrary header text is never used as an object key.
function extractTable(matrix, firstRowNumber, aliases, { minMatches = 2 } = {}) {
  let headerIdx = -1;
  let columns = null;
  const scan = Math.min(matrix.length, MAX_HEADER_SCAN_ROWS);
  for (let i = 0; i < scan; i++) {
    const cols = [];
    const seen = new Set();
    (matrix[i] || []).forEach((cell, idx) => {
      const field = aliases[normalizeHeader(cell)];
      if (field && !seen.has(field)) { seen.add(field); cols.push({ idx, field }); }
    });
    if (cols.length >= minMatches) { headerIdx = i; columns = cols; break; }
  }
  if (headerIdx < 0) return { headerFound: false };

  const rows = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells = matrix[i] || [];
    const rec = { row: firstRowNumber + i };
    let any = false;
    for (const { idx, field } of columns) {
      const v = cleanCell(cells[idx]);
      rec[field] = v;
      if (v) any = true;
    }
    if (any) rows.push(rec);
  }
  return { headerFound: true, fields: new Set(columns.map((c) => c.field)), rows };
}

// ---------------------------------------------------------------------------
// STUDENTS — parsing
// ---------------------------------------------------------------------------
// "Section" is accepted (older files have it) but is NEVER required — the
// section is normally chosen after upload and applied to every student.
const STUDENT_ALIASES = {
  name: 'name', studentname: 'name', fullname: 'name', studentfullname: 'name',
  username: 'username', userid: 'username', loginid: 'username',
  password: 'password', pass: 'password', initialpassword: 'password', temporarypassword: 'password',
  rollnumber: 'roll_number', rollno: 'roll_number', roll: 'roll_number', rollnum: 'roll_number',
  regno: 'roll_number', registrationno: 'roll_number', registrationnumber: 'roll_number',
  htno: 'roll_number', hallticketno: 'roll_number', hallticketnumber: 'roll_number',
  section: 'section', sectionname: 'section', class: 'section', classname: 'section',
  course: 'course', coursetype: 'course',
  year: 'current_year', currentyear: 'current_year', yearofstudy: 'current_year'
};
const STUDENT_REQUIRED_COLUMNS = [['name', 'Name'], ['username', 'Username'], ['password', 'Password']];

function parseStudentSheet(XLSX, buffer) {
  const sheet = readSheetMatrix(XLSX, buffer);
  if (sheet.error) return { error: sheet.error };
  const table = extractTable(sheet.matrix, sheet.firstRowNumber, STUDENT_ALIASES, { minMatches: 2 });
  if (!table.headerFound) {
    return { error: 'Could not find a header row. The first row should contain: Name, Username, Password, Roll Number.' };
  }
  const missing = STUDENT_REQUIRED_COLUMNS.filter(([f]) => !table.fields.has(f)).map(([, label]) => label);
  if (missing.length) {
    return { error: `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Expected columns: Name, Username, Password, Roll Number.` };
  }
  if (!table.rows.length) return { error: 'No student rows found below the header row.' };
  if (table.rows.length > MAX_IMPORT_ROWS) {
    return { error: `That sheet has ${table.rows.length} students — please split it into batches of ${MAX_IMPORT_ROWS} or fewer.` };
  }
  return {
    rows: table.rows,
    has_section_column: table.fields.has('section'),
    columns: [...table.fields]
  };
}

// ---------------------------------------------------------------------------
// STUDENTS — validation (no writes)
// ---------------------------------------------------------------------------
// ctx:
//   Users            — users collection
//   rows             — output of parseStudentSheet().rows
//   collegeId        — the importing user's college (every check is scoped to it)
//   department       — fixed department for HOD/Faculty, null for AO
//   sections         — section docs the importer is allowed to use (scope)
//   selectedSection  — the section the user picked after upload, or null
//   requireSection   — true at import time: every row must end up with a section
//   courseYearFields — server.js's courseYearFieldsForCreate (same Course/Year rules
//                      as the single "Add student" forms)
async function validateStudentRows(ctx) {
  const { Users, rows, collegeId, department, sections, selectedSection, requireSection, courseYearFields } = ctx;

  const results = rows.map((r) => ({
    row: r.row,
    name: r.name || '', username: r.username || '', password: r.password || '',
    roll_number: r.roll_number || '',
    section: null, cy: null, errors: []
  }));

  // ---- pass 1: per-row checks that need no database -----------------------
  const firstUsernameRow = new Map();
  const firstRollRow = new Map();
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const src = rows[i];

    const missing = [];
    if (!res.name) missing.push('Name');
    if (!res.username) missing.push('Username');
    if (!res.password) missing.push('Password');
    if (missing.length) res.errors.push(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required`);
    if (res.roll_number.length > 50) res.errors.push('Roll number is too long (max 50 characters)');

    if (res.username) {
      const key = res.username.toLowerCase();
      if (firstUsernameRow.has(key)) res.errors.push(`Duplicate username in this file (also on row ${firstUsernameRow.get(key)})`);
      else firstUsernameRow.set(key, res.row);
    }
    if (res.roll_number) {
      const key = res.roll_number.toLowerCase();
      if (firstRollRow.has(key)) res.errors.push(`Duplicate roll number in this file (also on row ${firstRollRow.get(key)})`);
      else firstRollRow.set(key, res.row);
    }

    // Section: the one picked after upload wins for every row. Only when
    // nothing was picked do we fall back to a per-row "Section" cell (how the
    // old import worked), so existing files keep working.
    if (selectedSection) {
      res.section = selectedSection;
    } else if (src.section) {
      const s = (sections || []).find((x) => String(x.name).trim().toLowerCase() === src.section.toLowerCase());
      if (s) res.section = s;
      else res.errors.push(`Section "${src.section}" was not found`);
    } else if (requireSection) {
      res.errors.push('No section selected');
    }

    // Optional Course / Year columns — same rules as the single-student forms.
    if (src.course || src.current_year) {
      const courseKey = normalizeHeader(src.course);
      let yearVal = '';
      if (src.current_year) {
        yearVal = Number(String(src.current_year).replace(/[^0-9]/g, ''));
        if (!yearVal) res.errors.push(`Year "${src.current_year}" is not a valid number`);
      }
      if (src.current_year && !src.course) {
        res.errors.push('Year was given without a Course');
      } else if (!(src.current_year && !yearVal)) {
        const cy = courseYearFields(courseKey || null, yearVal || null);
        if (cy.error) res.errors.push(cy.error);
        else res.cy = cy.fields;
      }
    }
  }

  // ---- pass 2: batched database checks (no per-row queries) ---------------
  const usernames = [...new Set(results.map((r) => r.username).filter(Boolean))];
  const takenUsernames = new Set();
  for (const part of chunk(usernames, IN_CHUNK)) {
    const found = await Users.find({ username: { $in: part } }, { projection: { username: 1, _id: 0 } }).toArray();
    for (const u of found) takenUsernames.add(u.username);
  }

  const rollVariants = new Set();
  for (const r of results) {
    if (!r.roll_number) continue;
    rollVariants.add(r.roll_number); rollVariants.add(r.roll_number.toUpperCase()); rollVariants.add(r.roll_number.toLowerCase());
  }
  const existingByRoll = new Map(); // lower-cased roll -> [{ name, department }]
  for (const part of chunk([...rollVariants], IN_CHUNK)) {
    const found = await Users.find(
      { college_id: collegeId, role: 'student', roll_number: { $in: part } },
      { projection: { roll_number: 1, name: 1, department: 1, _id: 0 } }
    ).toArray();
    for (const u of found) {
      const key = String(u.roll_number).toLowerCase();
      if (!existingByRoll.has(key)) existingByRoll.set(key, []);
      existingByRoll.get(key).push(u);
    }
  }

  for (const res of results) {
    if (res.username && takenUsernames.has(res.username)) res.errors.push('Username already exists');
    if (res.roll_number) {
      // Roll numbers are unique per department (the same rule the AO "Add
      // student" form already applies). If the department isn't known yet
      // (AO, no section picked) check the whole college — conservative, and
      // re-checked against the chosen section's department at import time.
      const dept = department || (res.section && res.section.department) || null;
      const hits = (existingByRoll.get(res.roll_number.toLowerCase()) || []).filter((u) => !dept || u.department === dept);
      if (hits.length) res.errors.push(`Student already exists with roll number ${res.roll_number} (${hits[0].name}${hits[0].department ? ', ' + hits[0].department : ''})`);
    }
  }

  return results;
}

function toStudentPreview(results) {
  return results.map((r) => ({
    row: r.row, name: r.name, roll_number: r.roll_number, username: r.username,
    status: r.errors.length ? 'invalid' : 'valid', errors: r.errors
  }));
}

// ---------------------------------------------------------------------------
// STUDENTS — insertion of the rows that passed validation
// ---------------------------------------------------------------------------
async function insertStudents(ctx) {
  const { Users, results, collegeId, department, newId, hashPasswordAsync, extraFields } = ctx;
  const valid = results.filter((r) => !r.errors.length);
  const created = [];
  const failed = results.filter((r) => r.errors.length).map((r) => ({ res: r, reason: r.errors.join('; ') }));

  // Hash with bounded concurrency — the old synchronous scrypt call blocked the
  // whole server for ~50-100ms per student, which froze every other request
  // during a large import.
  const docs = new Array(valid.length);
  for (let i = 0; i < valid.length; i += HASH_CONCURRENCY) {
    const slice = valid.slice(i, i + HASH_CONCURRENCY);
    const hashes = await Promise.all(slice.map((r) => hashPasswordAsync(r.password)));
    slice.forEach((r, j) => {
      docs[i + j] = {
        id: newId('u'), name: r.name, username: r.username,
        password_hash: hashes[j], role: 'student',
        college_id: collegeId, department: department || r.section.department,
        section_id: r.section.id, roll_number: r.roll_number,
        ...(r.cy || {}), academic_status: 'active',
        ...(extraFields || {}), created_at: Date.now()
      };
    });
  }

  for (let start = 0; start < docs.length; start += INSERT_CHUNK) {
    const part = docs.slice(start, start + INSERT_CHUNK);
    const failedIdx = new Map(); // index within `part` -> reason
    try {
      await Users.insertMany(part, { ordered: false });
    } catch (err) {
      const writeErrors = err && err.writeErrors ? [].concat(err.writeErrors) : [];
      if (writeErrors.length) {
        for (const we of writeErrors) {
          const idx = we.index != null ? we.index : (we.err && we.err.index);
          const code = we.code != null ? we.code : (we.err && we.err.code);
          if (idx != null) failedIdx.set(idx, code === 11000 ? 'Username already exists' : 'Could not be saved');
        }
      } else {
        console.error('bulk student insert failed', err);
        part.forEach((_, i) => failedIdx.set(i, 'Database error while saving this batch'));
      }
    }
    part.forEach((doc, i) => {
      const res = valid[start + i];
      if (failedIdx.has(i)) failed.push({ res, reason: failedIdx.get(i) });
      else created.push({ row: res.row, name: doc.name, username: doc.username, roll_number: doc.roll_number, section: res.section.name });
    });
  }

  failed.sort((a, b) => a.res.row - b.res.row);
  created.sort((a, b) => a.row - b.row);
  return { created, failed };
}

function buildStudentImportReport(results, { created, failed }, section) {
  return {
    total: results.length,
    created_count: created.length,
    failed_count: failed.length,
    section: section ? { id: section.id, name: section.name } : null,
    created,
    // `errors` keeps the shape the previous import API returned.
    errors: failed.map((f) => ({ row: f.res.row, error: f.reason })),
    failures: failed.map((f) => ({
      row: f.res.row, roll_number: f.res.roll_number, username: f.res.username, status: 'Failed', reason: f.reason
    }))
  };
}

// ---------------------------------------------------------------------------
// CLUBS — parsing
// ---------------------------------------------------------------------------
const CLUB_ALIASES = {
  clubname: 'club_name', club: 'club_name', nameofclub: 'club_name', nameoftheclub: 'club_name',
  studentrollnumber: 'roll_number', studentrollno: 'roll_number', studentroll: 'roll_number',
  rollnumber: 'roll_number', rollno: 'roll_number', roll: 'roll_number',
  clubleader: 'club_leader', leader: 'club_leader', isleader: 'club_leader', isclubleader: 'club_leader'
};

function parseClubSheet(XLSX, buffer) {
  const sheet = readSheetMatrix(XLSX, buffer);
  if (sheet.error) return { error: sheet.error };
  const table = extractTable(sheet.matrix, sheet.firstRowNumber, CLUB_ALIASES, { minMatches: 2 });
  if (!table.headerFound) {
    return { error: 'Could not find a header row. The first row should contain: Club Name, Student Roll Number, Club Leader.' };
  }
  const missing = [['club_name', 'Club Name'], ['roll_number', 'Student Roll Number'], ['club_leader', 'Club Leader']]
    .filter(([f]) => !table.fields.has(f)).map(([, label]) => label);
  if (missing.length) {
    return { error: `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Expected columns: Club Name, Student Roll Number, Club Leader (YES for exactly one student per club, NO for the rest).` };
  }
  if (!table.rows.length) return { error: 'No rows found below the header row.' };
  if (table.rows.length > MAX_IMPORT_ROWS) {
    return { error: `That sheet has ${table.rows.length} rows — please split it into files of ${MAX_IMPORT_ROWS} rows or fewer.` };
  }
  return { rows: table.rows };
}

function parseLeaderFlag(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0', ''].includes(s)) return false;
  return null; // unrecognised
}

function collapseName(n) {
  return String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 100);
}

// ---------------------------------------------------------------------------
// CLUBS — validation (no writes)
// ---------------------------------------------------------------------------
// ctx:
//   Users, Clubs     — collections
//   rows             — parseClubSheet().rows
//   collegeId        — importing user's college
//   eligibleLeaderCheck(leaderDoc) -> Promise<string|null> — server.js's
//                      assertEligibleLeaderCandidate bound to the current user
//                      (faculty may only pick leaders from their own sections)
//
// Rules enforced per club (a club with ANY error is not created; other clubs
// in the same file are unaffected):
//   - name not empty, and no club with that name already in the college
//   - every roll number resolves to exactly one student of this college
//   - no student listed twice in the same club
//   - one student = one club: not in another club in this file (first club in
//     file order keeps them, later ones are rejected — nothing is moved), and
//     not already a member/leader of an existing club
//   - exactly one Club Leader (YES); leader is always one of the member rows
async function validateClubRows(ctx) {
  const { Users, Clubs, rows, collegeId, eligibleLeaderCheck } = ctx;

  // group rows by club (case/space-insensitive), preserving file order
  const order = [];
  const groups = new Map();
  const rowErrors = [];
  for (const r of rows) {
    const name = collapseName(r.club_name);
    if (!name) {
      rowErrors.push({ row: r.row, club: '', roll_number: r.roll_number, error: 'Club name is empty' });
      continue;
    }
    const key = name.toLowerCase();
    if (!groups.has(key)) { groups.set(key, { name, key, rows: [] }); order.push(key); }
    groups.get(key).rows.push(r);
  }

  // one batched lookup for every roll number in the file
  const rolls = [...new Set(rows.map((r) => r.roll_number).filter(Boolean))];
  const variants = new Set();
  for (const x of rolls) { variants.add(x); variants.add(x.toUpperCase()); variants.add(x.toLowerCase()); }
  const byRoll = new Map();
  const byUsername = new Map();
  for (const part of chunk([...variants], IN_CHUNK)) {
    const found = await Users.find(
      { college_id: collegeId, role: 'student', $or: [{ roll_number: { $in: part } }, { username: { $in: part } }] },
      { projection: { id: 1, name: 1, username: 1, roll_number: 1, section_id: 1, department: 1, _id: 0 } }
    ).toArray();
    for (const u of found) {
      if (u.roll_number) {
        const k = String(u.roll_number).toLowerCase();
        if (!byRoll.has(k)) byRoll.set(k, new Map());
        byRoll.get(k).set(u.username, u);
      }
      const uk = String(u.username).toLowerCase();
      if (!byUsername.has(uk)) byUsername.set(uk, new Map());
      byUsername.get(uk).set(u.username, u);
    }
  }
  const resolveStudent = (input) => {
    const k = input.toLowerCase();
    let c = byRoll.has(k) ? [...byRoll.get(k).values()] : [];
    if (!c.length && byUsername.has(k)) c = [...byUsername.get(k).values()];
    if (!c.length) return { error: 'Student does not exist in this college' };
    if (c.length > 1) return { error: 'Roll number matches more than one student' };
    return { student: c[0] };
  };

  // one query for every existing club in the college (names + memberships)
  const existing = await Clubs.find({ college_id: collegeId }, { projection: { name: 1, member_usernames: 1, leader_username: 1, _id: 0 } }).toArray();
  const existingNames = new Set(existing.map((c) => collapseName(c.name).toLowerCase()));
  const existingClubOf = new Map(); // username -> existing club name
  for (const c of existing) {
    for (const u of (c.member_usernames || [])) if (!existingClubOf.has(u)) existingClubOf.set(u, c.name);
    if (c.leader_username && !existingClubOf.has(c.leader_username)) existingClubOf.set(c.leader_username, c.name);
  }

  const assignedInFile = new Map(); // username -> { key, name } of the first club to list them
  const clubs = [];
  for (const key of order) {
    const g = groups.get(key);
    const errors = [];
    const members = [];
    const seenInClub = new Map();
    const leaderRows = [];

    if (existingNames.has(key)) errors.push(`A club named "${g.name}" already exists in your college.`);

    for (const r of g.rows) {
      const label = `Row ${r.row} – ${r.roll_number || '(blank roll number)'}`;
      if (!r.roll_number) { errors.push(`${label} – Student roll number is empty.`); continue; }

      const flag = parseLeaderFlag(r.club_leader);
      if (flag === null) errors.push(`${label} – Club Leader must be YES or NO (found "${r.club_leader}").`);

      const found = resolveStudent(r.roll_number);
      if (found.error) {
        errors.push(`${label} – ${found.error}.`);
        if (flag === true) leaderRows.push({ row: r.row, student: null });
        continue;
      }
      const stu = found.student;

      if (seenInClub.has(stu.username)) {
        errors.push(`${label} – Duplicate row: this student is already listed in ${g.name} (row ${seenInClub.get(stu.username)}).`);
        continue;
      }
      seenInClub.set(stu.username, r.row);

      const earlier = assignedInFile.get(stu.username);
      if (earlier && earlier.key !== key) {
        errors.push(`${r.roll_number} cannot be added to ${g.name} because the student is already assigned to ${earlier.name}.`);
        continue;
      }
      if (!earlier) assignedInFile.set(stu.username, { key, name: g.name });

      const inExisting = existingClubOf.get(stu.username);
      if (inExisting) {
        errors.push(`${label} – ${stu.name} is already assigned to the existing club "${inExisting}". A student can belong to only one club.`);
        continue;
      }

      members.push({ row: r.row, roll_number: r.roll_number, username: stu.username, name: stu.name, is_leader: flag === true });
      if (flag === true) leaderRows.push({ row: r.row, student: stu });
    }

    let leader = null;
    if (leaderRows.length === 0) {
      errors.push(`${g.name} must have exactly one Club Leader.`);
    } else if (leaderRows.length > 1) {
      errors.push(`${g.name} has multiple Club Leaders. Only one leader is allowed.`);
    } else if (leaderRows[0].student) {
      leader = leaderRows[0].student;
      if (eligibleLeaderCheck) {
        const msg = await eligibleLeaderCheck(leader);
        if (msg) errors.push(`${leader.roll_number || leader.username} – ${msg}`);
      }
    }

    clubs.push({
      name: g.name, key, members, member_count: members.length,
      leader: leader ? { username: leader.username, name: leader.name, roll_number: leader.roll_number || '' } : null,
      errors, valid: errors.length === 0
    });
  }

  return { clubs, row_errors: rowErrors, total_rows: rows.length };
}

// ---------------------------------------------------------------------------
// CLUBS — per-club details (common + overrides)
// ---------------------------------------------------------------------------
// Only the fields the existing Club model actually has are accepted here:
// description, category, max_members. Anything else in the request is ignored.
function pickClubDetails(src) {
  const o = src && typeof src === 'object' ? src : {};
  const out = {};
  if (o.description != null) out.description = String(o.description).trim().slice(0, 2000);
  if (o.category != null && String(o.category).trim()) out.category = String(o.category).trim().slice(0, 60);
  if (o.max_members != null && String(o.max_members).trim() !== '') out.max_members = Number(o.max_members);
  return out;
}

// overrides arrives as JSON keyed by club name; build a Map keyed by the
// lower-cased name so a hostile key such as "__proto__" is just data.
function parseClubOverrides(raw) {
  const map = new Map();
  if (!raw || typeof raw !== 'object') return map;
  for (const [name, val] of Object.entries(raw)) map.set(collapseName(name).toLowerCase(), pickClubDetails(val));
  return map;
}

function resolveClubDetails(common, override, memberCount) {
  const eff = { description: '', category: 'General', max_members: undefined, ...common, ...(override || {}) };
  if (!Number.isInteger(eff.max_members) || eff.max_members < 1) {
    return { error: 'Maximum number of members must be a whole number of at least 1.' };
  }
  if (eff.max_members < memberCount) {
    return { error: `Maximum members (${eff.max_members}) is smaller than the ${memberCount} students listed for this club.` };
  }
  return { details: eff };
}

// ---------------------------------------------------------------------------
// CLUBS — creation
// ---------------------------------------------------------------------------
// Validation is re-run here (never trusting the preview) and the whole
// validate-then-insert step is serialised per college (see withKeyedLock) so
// two simultaneous imports can't both grab the same student.
//
// Each club is ONE document: members live in club.member_usernames, so a club
// and its roster are written in a single atomic insert — there is no state
// where a club exists without its members.
async function createClubsFromImport(ctx) {
  const { Users, Clubs, rows, user, common, overrides, newId, generateClubCode, eligibleLeaderCheck } = ctx;
  return withKeyedLock(`clubs:${user.college_id}`, async () => {
    const validation = await validateClubRows({ Users, Clubs, rows, collegeId: user.college_id, eligibleLeaderCheck });
    const commonDetails = pickClubDetails(common);
    const overrideMap = parseClubOverrides(overrides);

    const failed = [];
    const toInsert = [];
    for (const club of validation.clubs) {
      if (!club.valid) { failed.push({ club: club.name, reason: club.errors.join(' '), reasons: club.errors }); continue; }
      const d = resolveClubDetails(commonDetails, overrideMap.get(club.key), club.member_count);
      if (d.error) { failed.push({ club: club.name, reason: d.error, reasons: [d.error] }); continue; }
      toInsert.push({
        club,
        doc: {
          id: newId('club'), name: club.name, description: d.details.description || '',
          category: d.details.category || 'General', college_id: user.college_id,
          created_by: user.username, created_by_name: user.name, created_at: Date.now(),
          max_members: d.details.max_members,
          leader_username: club.leader.username, leader_name: club.leader.name,
          // The leader comes straight from the sheet and is enrolled as a member,
          // so leadership is active immediately (no join-code activation step).
          leader_confirmed: true,
          join_code: generateClubCode(),
          member_usernames: club.members.map((m) => m.username),
          posts: []
        }
      });
    }

    const created = [];
    if (toInsert.length) {
      const failedIdx = new Map();
      try {
        await Clubs.insertMany(toInsert.map((t) => t.doc), { ordered: false });
      } catch (err) {
        const writeErrors = err && err.writeErrors ? [].concat(err.writeErrors) : [];
        if (writeErrors.length) {
          for (const we of writeErrors) {
            const idx = we.index != null ? we.index : (we.err && we.err.index);
            if (idx != null) failedIdx.set(idx, 'The club could not be saved.');
          }
        } else {
          console.error('bulk club insert failed', err);
          toInsert.forEach((_, i) => failedIdx.set(i, 'Database error while saving this club.'));
        }
      }
      toInsert.forEach((t, i) => {
        if (failedIdx.has(i)) failed.push({ club: t.club.name, reason: failedIdx.get(i), reasons: [failedIdx.get(i)] });
        else created.push({ id: t.doc.id, name: t.doc.name, member_count: t.doc.member_usernames.length, leader_username: t.doc.leader_username, _doc: t.doc });
      });
    }

    return {
      total_clubs: validation.clubs.length,
      created_count: created.length,
      failed_count: failed.length,
      created, failed,
      row_errors: validation.row_errors
    };
  });
}

// ---------------------------------------------------------------------------
// Tiny keyed async mutex (single-process server — see server.js header notes)
// ---------------------------------------------------------------------------
const locks = new Map();
function withKeyedLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// ---------------------------------------------------------------------------
// Downloadable templates
// ---------------------------------------------------------------------------
// The first sheet holds ONLY the header row (that is the sheet the importer
// reads), so a template can never be uploaded with sample data still in it.
// Worked examples live on a second "Instructions" sheet.
function buildStudentTemplate(XLSX) {
  const wb = XLSX.utils.book_new();
  const data = XLSX.utils.aoa_to_sheet([['Name', 'Username', 'Password', 'Roll Number']]);
  data['!cols'] = [{ wch: 26 }, { wch: 20 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, data, 'Students');
  const info = XLSX.utils.aoa_to_sheet([
    ['How to use this template'],
    ['1. Fill one student per row on the "Students" sheet (columns: Name, Username, Password, Roll Number).'],
    ['2. Do NOT add a Section column — you choose the section after uploading, and it is applied to every student.'],
    ['3. Usernames must be unique across the whole platform; roll numbers must be unique within a department.'],
    [''],
    ['Example rows'],
    ['Name', 'Username', 'Password', 'Roll Number'],
    ['Ravi', '244M1A05J9', 'password', '244M1A05J9'],
    ['Suresh', '244M1A05K0', 'password', '244M1A05K0']
  ]);
  info['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, info, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildClubTemplate(XLSX) {
  const wb = XLSX.utils.book_new();
  const data = XLSX.utils.aoa_to_sheet([['Club Name', 'Student Roll Number', 'Club Leader']]);
  data['!cols'] = [{ wch: 28 }, { wch: 24 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, data, 'Clubs');
  const info = XLSX.utils.aoa_to_sheet([
    ['How to use this template'],
    ['1. One row per student, on the "Clubs" sheet. Repeat the club name on every row of that club.'],
    ['2. Club Leader: exactly ONE row per club must say YES; every other row says NO.'],
    ['3. A student can belong to only ONE club. Roll numbers must belong to existing students.'],
    ['4. Description, category and maximum members are entered on screen after upload and apply to all clubs.'],
    [''],
    ['Example rows'],
    ['Club Name', 'Student Roll Number', 'Club Leader'],
    ['Coding Club', '244M1A05J9', 'YES'],
    ['Coding Club', '244M1A05K0', 'NO'],
    ['Photography Club', '244M1A05K1', 'YES']
  ]);
  info['!cols'] = [{ wch: 28 }, { wch: 24 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, info, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  MAX_IMPORT_ROWS,
  normalizeHeader, readSheetMatrix, extractTable,
  parseStudentSheet, validateStudentRows, toStudentPreview, insertStudents, buildStudentImportReport,
  parseClubSheet, parseLeaderFlag, validateClubRows, createClubsFromImport,
  pickClubDetails, parseClubOverrides, resolveClubDetails,
  withKeyedLock, buildStudentTemplate, buildClubTemplate
};
