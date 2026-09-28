'use strict';
// ---------------------------------------------------------------------------
// Unit tests for services/bulkImport.js.
//
// Deliberately dependency-free: this sandbox has no network access to npm,
// so it can't install the 'mongodb'/'mingo' packages the full integration
// smoke test (tests/integration.smoke.test.js, tests/support/fakeMongo.js)
// needs, nor '@e965/xlsx' to build real workbook buffers. These tests avoid
// both by:
//   - using tests/support/tinyMongo.js, a ~50-line stub covering only the
//     query shapes bulkImport.js actually issues (see that file's header),
//   - calling extractTable() directly with a hand-built matrix instead of
//     going through parseStudentSheet/parseClubSheet (which need a real
//     XLSX.read()) — this still exercises the exact same header-detection
//     and row-extraction logic those two functions rely on.
//
// Run with: node --test tests/bulkImport.unit.test.js
// (Node's built-in test runner — no extra packages needed.)
//
// What this does NOT cover, and why:
//   - XLSX.read() itself (needs @e965/xlsx — untestable here)
//   - insertMany duplicate-key handling (tinyMongo has no unique indexes;
//     covered by the real integration test once deps can be installed)
//   - the Express routes in server.js (needs 'express'/'multer'/'mongodb')
// Before calling this feature verified, run the full integration suite in
// an environment with npm access: `npm install && npm test`.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const { TinyCollection } = require('./support/tinyMongo');
const bulkImport = require('../services/bulkImport');

const {
  extractTable, validateStudentRows, insertStudents, buildStudentImportReport,
  parseLeaderFlag, validateClubRows, createClubsFromImport, resolveClubDetails
} = bulkImport;

// Fakes for the two server.js-provided helpers bulkImport.js takes as params.
let idCounter = 0;
const newId = (prefix) => `${prefix}_${++idCounter}`;
const hashPasswordAsync = async (pw) => `hashed:${pw}`;
const courseYearFields = () => ({ fields: {} }); // not under test here

// ===========================================================================
// extractTable — header detection + row extraction
// ===========================================================================
test('extractTable finds the header below a title row and skips blank rows', () => {
  const aliases = { name: 'name', username: 'username', password: 'password', rollnumber: 'roll_number' };
  const matrix = [
    ['CampusOrbis Student Import'],           // title row — not the header
    [],                                        // blank row
    ['Name', 'Username', 'Password', 'Roll Number'],
    ['Ravi', '244M1A05J9', 'password', '244M1A05J9'],
    [],                                        // blank row in the middle — skipped
    ['Suresh', '244M1A05K0', 'password', '244M1A05K0']
  ];
  const table = extractTable(matrix, 1, aliases, { minMatches: 2 });
  assert.equal(table.headerFound, true);
  assert.deepEqual([...table.fields].sort(), ['name', 'password', 'roll_number', 'username']);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].row, 4);       // real Excel row number, not array index
  assert.equal(table.rows[0].name, 'Ravi');
  assert.equal(table.rows[1].row, 6);       // gap for the blank row is preserved
});

test('extractTable reports headerFound:false when no row has enough matches', () => {
  const aliases = { name: 'name', username: 'username' };
  const matrix = [['Foo', 'Bar', 'Baz'], ['x', 'y', 'z']];
  const table = extractTable(matrix, 1, aliases, { minMatches: 2 });
  assert.equal(table.headerFound, false);
});

// ===========================================================================
// validateStudentRows
// ===========================================================================
function studentRow(row, over = {}) {
  return { row, name: 'Ravi', username: '244M1A05J9', password: 'password', roll_number: '244M1A05J9', section: '', ...over };
}

test('validateStudentRows: valid row gets the selected section assigned, no errors', async () => {
  const Users = new TinyCollection([]);
  const section = { id: 'sec1', name: 'CSE-D', department: 'CSE' };
  const results = await validateStudentRows({
    Users, rows: [studentRow(2)], collegeId: 'c1', department: 'CSE',
    sections: [section], selectedSection: section, requireSection: true, courseYearFields
  });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].errors, []);
  assert.equal(results[0].section.id, 'sec1');
});

test('validateStudentRows: missing required fields are reported together', async () => {
  const Users = new TinyCollection([]);
  const section = { id: 'sec1', name: 'CSE-D', department: 'CSE' };
  const results = await validateStudentRows({
    Users, rows: [studentRow(2, { name: '', password: '' })], collegeId: 'c1', department: 'CSE',
    sections: [section], selectedSection: section, requireSection: true, courseYearFields
  });
  assert.match(results[0].errors[0], /Name, Password are required/);
});

test('validateStudentRows: duplicate username/roll number within the file are both flagged', async () => {
  const Users = new TinyCollection([]);
  const section = { id: 'sec1', name: 'CSE-D', department: 'CSE' };
  const rows = [studentRow(2), studentRow(3, { name: 'Suresh' })]; // same username+roll on purpose
  const results = await validateStudentRows({
    Users, rows, collegeId: 'c1', department: 'CSE',
    sections: [section], selectedSection: section, requireSection: true, courseYearFields
  });
  assert.equal(results[0].errors.length, 0); // first occurrence is fine
  assert.match(results[1].errors.join(' '), /Duplicate username in this file \(also on row 2\)/);
  assert.match(results[1].errors.join(' '), /Duplicate roll number in this file \(also on row 2\)/);
});

test('validateStudentRows: existing username in DB is rejected; existing roll number scoped to department', async () => {
  const Users = new TinyCollection([
    { username: 'taken_user', role: 'student', college_id: 'c1' },
    { username: 'other_dept_student', role: 'student', college_id: 'c1', roll_number: '244M1A05J9', department: 'ECE', name: 'Someone Else' }
  ]);
  const section = { id: 'sec1', name: 'CSE-D', department: 'CSE' };
  const rows = [
    studentRow(2, { username: 'taken_user', roll_number: 'ROWTWO' }),
    studentRow(3, { username: 'brand_new_user', roll_number: '244M1A05J9' }) // roll clashes with ECE student, not CSE
  ];
  const results = await validateStudentRows({
    Users, rows, collegeId: 'c1', department: 'CSE',
    sections: [section], selectedSection: section, requireSection: true, courseYearFields
  });
  assert.match(results[0].errors.join(' '), /Username already exists/);
  // roll number belongs to a DIFFERENT department -> not flagged as a clash for this CSE import
  assert.equal(results[1].errors.length, 0);
});

test('validateStudentRows: with no section selected, requireSection=false allows preview without a section error', async () => {
  const Users = new TinyCollection([]);
  const results = await validateStudentRows({
    Users, rows: [studentRow(2)], collegeId: 'c1', department: 'CSE',
    sections: [], selectedSection: null, requireSection: false, courseYearFields
  });
  assert.equal(results[0].errors.length, 0);
  assert.equal(results[0].section, null);
});

test('validateStudentRows: with no section selected, requireSection=true reports "No section selected"', async () => {
  const Users = new TinyCollection([]);
  const results = await validateStudentRows({
    Users, rows: [studentRow(2)], collegeId: 'c1', department: 'CSE',
    sections: [], selectedSection: null, requireSection: true, courseYearFields
  });
  assert.match(results[0].errors.join(' '), /No section selected/);
});

test('validateStudentRows: falls back to a per-row Section column when nothing was selected', async () => {
  const Users = new TinyCollection([]);
  const sectionA = { id: 'a', name: 'CSE-A', department: 'CSE' };
  const sectionB = { id: 'b', name: 'CSE-B', department: 'CSE' };
  const rows = [studentRow(2, { section: 'CSE-B' })];
  const results = await validateStudentRows({
    Users, rows, collegeId: 'c1', department: 'CSE',
    sections: [sectionA, sectionB], selectedSection: null, requireSection: true, courseYearFields
  });
  assert.equal(results[0].errors.length, 0);
  assert.equal(results[0].section.id, 'b');
});

// ===========================================================================
// insertStudents / buildStudentImportReport
// ===========================================================================
test('insertStudents creates only the rows with no validation errors, with hashed passwords', async () => {
  const Users = new TinyCollection([]);
  const section = { id: 'sec1', name: 'CSE-D', department: 'CSE' };
  const results = [
    { row: 2, name: 'Ravi', username: 'ravi1', password: 'pw1', roll_number: 'R1', section, cy: null, errors: [] },
    { row: 3, name: 'Bad', username: 'bad1', password: 'pw2', roll_number: 'R2', section: null, cy: null, errors: ['No section selected'] }
  ];
  const { created, failed } = await insertStudents({ Users, results, collegeId: 'c1', department: 'CSE', newId, hashPasswordAsync });
  assert.equal(created.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, 'No section selected');
  const stored = Users.all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].password_hash, 'hashed:pw1');
  assert.equal(stored[0].section_id, 'sec1');

  const report = buildStudentImportReport(results, { created, failed }, section);
  assert.equal(report.total, 2);
  assert.equal(report.created_count, 1);
  assert.equal(report.failed_count, 1);
  assert.equal(report.section.name, 'CSE-D');
  assert.equal(report.failures[0].row, 3);
});

// ===========================================================================
// parseLeaderFlag
// ===========================================================================
test('parseLeaderFlag recognizes common truthy/falsy spellings and rejects garbage', () => {
  assert.equal(parseLeaderFlag('YES'), true);
  assert.equal(parseLeaderFlag('y'), true);
  assert.equal(parseLeaderFlag('  Yes  '), true);
  assert.equal(parseLeaderFlag('NO'), false);
  assert.equal(parseLeaderFlag(''), false);
  assert.equal(parseLeaderFlag('maybe'), null);
});

// ===========================================================================
// validateClubRows
// ===========================================================================
function student(roll, name, over = {}) {
  return { id: `u_${roll}`, username: roll, name, roll_number: roll, role: 'student', college_id: 'c1', ...over };
}
function clubRow(row, club, roll, leader) {
  return { row, club_name: club, roll_number: roll, club_leader: leader };
}

test('validateClubRows: groups rows by club, detects the one leader, marks the club valid', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi'), student('R2', 'Suresh')]);
  const Clubs = new TinyCollection([]);
  const rows = [clubRow(2, 'Coding Club', 'R1', 'YES'), clubRow(3, 'Coding Club', 'R2', 'NO')];
  const { clubs } = await validateClubRows({ Users, Clubs, rows, collegeId: 'c1' });
  assert.equal(clubs.length, 1);
  assert.equal(clubs[0].valid, true);
  assert.equal(clubs[0].member_count, 2);
  assert.equal(clubs[0].leader.username, 'R1');
});

test('validateClubRows: no leader -> rejected with the exact spec wording', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi'), student('R2', 'Suresh')]);
  const Clubs = new TinyCollection([]);
  const rows = [clubRow(2, 'Coding Club', 'R1', 'NO'), clubRow(3, 'Coding Club', 'R2', 'NO')];
  const { clubs } = await validateClubRows({ Users, Clubs, rows, collegeId: 'c1' });
  assert.equal(clubs[0].valid, false);
  assert.match(clubs[0].errors.join(' '), /Coding Club must have exactly one Club Leader\./);
});

test('validateClubRows: two leaders -> rejected with the exact spec wording', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi'), student('R2', 'Suresh')]);
  const Clubs = new TinyCollection([]);
  const rows = [clubRow(2, 'Coding Club', 'R1', 'YES'), clubRow(3, 'Coding Club', 'R2', 'YES')];
  const { clubs } = await validateClubRows({ Users, Clubs, rows, collegeId: 'c1' });
  assert.equal(clubs[0].valid, false);
  assert.match(clubs[0].errors.join(' '), /Coding Club has multiple Club Leaders\. Only one leader is allowed\./);
});

test('validateClubRows: one student in two clubs in the same file -> second club rejected, first unaffected', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi'), student('R2', 'Suresh'), student('R3', 'Kiran')]);
  const Clubs = new TinyCollection([]);
  const rows = [
    clubRow(2, 'Coding Club', 'R1', 'YES'), clubRow(3, 'Coding Club', 'R2', 'NO'),
    clubRow(4, 'Sports Club', 'R1', 'YES'), clubRow(5, 'Sports Club', 'R3', 'NO')
  ];
  const { clubs } = await validateClubRows({ Users, Clubs, rows, collegeId: 'c1' });
  const coding = clubs.find((c) => c.name === 'Coding Club');
  const sports = clubs.find((c) => c.name === 'Sports Club');
  assert.equal(coding.valid, true); // first club in file order keeps the student
  assert.equal(sports.valid, false);
  assert.match(sports.errors.join(' '), /R1 cannot be added to Sports Club because the student is already assigned to Coding Club\./);
});

test('validateClubRows: student already in an existing club is rejected', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi')]);
  const Clubs = new TinyCollection([{ college_id: 'c1', name: 'Old Club', member_usernames: ['R1'], leader_username: null }]);
  const rows = [clubRow(2, 'Coding Club', 'R1', 'YES')];
  const { clubs } = await validateClubRows({ Users, Clubs, rows, collegeId: 'c1' });
  assert.equal(clubs[0].valid, false);
  assert.match(clubs[0].errors.join(' '), /already assigned to the existing club "Old Club"/);
});

test('validateClubRows: unknown roll number is reported and does not crash leader resolution', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi')]);
  const Clubs = new TinyCollection([]);
  const rows = [clubRow(2, 'Coding Club', 'R1', 'NO'), clubRow(3, 'Coding Club', 'NOPE', 'YES')];
  const { clubs } = await validateClubRows({ Users, Clubs, rows, collegeId: 'c1' });
  assert.equal(clubs[0].valid, false);
  assert.match(clubs[0].errors.join(' '), /Student does not exist in this college/);
});

test('validateClubRows: duplicate row for the same student in the same club is rejected', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi')]);
  const Clubs = new TinyCollection([]);
  const rows = [clubRow(2, 'Coding Club', 'R1', 'YES'), clubRow(3, 'Coding Club', 'R1', 'NO')];
  const { clubs } = await validateClubRows({ Users, Clubs, rows, collegeId: 'c1' });
  assert.match(clubs[0].errors.join(' '), /Duplicate row: this student is already listed in Coding Club \(row 2\)/);
});

// ===========================================================================
// resolveClubDetails
// ===========================================================================
test('resolveClubDetails: rejects a max_members smaller than the club roster', () => {
  const r = resolveClubDetails({ max_members: 2 }, null, 5);
  assert.match(r.error, /Maximum members \(2\) is smaller than the 5 students/);
});
test('resolveClubDetails: override wins over the common value', () => {
  const r = resolveClubDetails({ category: 'General', max_members: 10 }, { category: 'Technical' }, 3);
  assert.equal(r.details.category, 'Technical');
  assert.equal(r.details.max_members, 10);
});

// ===========================================================================
// createClubsFromImport — end-to-end over the fake collections
// ===========================================================================
test('createClubsFromImport creates only the valid clubs, applies common + override details, notifies nobody it shouldn\'t', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi'), student('R2', 'Suresh'), student('R3', 'Kiran')]);
  const Clubs = new TinyCollection([]);
  const rows = [
    clubRow(2, 'Coding Club', 'R1', 'YES'), clubRow(3, 'Coding Club', 'R2', 'NO'),
    clubRow(4, 'Sports Club', 'R3', 'NO') // no leader -> invalid, must not be created
  ];
  const generateClubCode = () => 'CODE123';
  const user = { college_id: 'c1', username: 'faculty1', name: 'Prof X' };
  const result = await createClubsFromImport({
    Users, Clubs, rows, user,
    common: { category: 'General', max_members: 10, description: 'Default desc' },
    overrides: { 'Coding Club': { category: 'Technical' } },
    newId, generateClubCode, eligibleLeaderCheck: null
  });
  assert.equal(result.total_clubs, 2);
  assert.equal(result.created_count, 1);
  assert.equal(result.failed_count, 1);
  assert.equal(result.failed[0].club, 'Sports Club');

  const stored = Clubs.all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'Coding Club');
  assert.equal(stored[0].category, 'Technical'); // override applied
  assert.equal(stored[0].description, 'Default desc'); // common applied
  assert.equal(stored[0].member_usernames.length, 2);
  assert.equal(stored[0].leader_username, 'R1');
});

test('createClubsFromImport rejects when the eligible-leader check fails (faculty scope)', async () => {
  const Users = new TinyCollection([student('R1', 'Ravi')]);
  const Clubs = new TinyCollection([]);
  const rows = [clubRow(2, 'Coding Club', 'R1', 'YES')];
  const eligibleLeaderCheck = async () => 'is not in one of your assigned sections';
  const result = await createClubsFromImport({
    Users, Clubs, rows, user: { college_id: 'c1', username: 'f1', name: 'F' },
    common: { max_members: 5 }, overrides: {}, newId, generateClubCode: () => 'X', eligibleLeaderCheck
  });
  assert.equal(result.created_count, 0);
  assert.match(result.failed[0].reason, /is not in one of your assigned sections/);
});
