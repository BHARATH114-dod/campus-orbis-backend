const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'backup_mongo_data');
const OUT_FILE = path.join(__dirname, '..', 'supabase_init.sql');

const ALL_COLLECTIONS = [
  "academic_calendar",
  "announcements",
  "attendance",
  "club_quiz_participants",
  "club_quizzes",
  "clubs",
  "code_test_attempts",
  "college_connections",
  "college_course_access",
  "college_messages",
  "colleges",
  "course_progress",
  "course_requests",
  "daily_course_progress",
  "events",
  "face_attendance_sessions",
  "face_profiles",
  "face_update_requests",
  "faculty_language_access",
  "forum_posts",
  "forum_replies",
  "leaderboard_adjustments",
  "marks",
  "notes",
  "notifications",
  "payment_settings",
  "placement_applications",
  "placement_drives",
  "point_transactions",
  "post_replies",
  "posts",
  "practice_files",
  "push_subscriptions",
  "python_course_progress",
  "saved_club_quizzes",
  "saved_tests",
  "sections",
  "security_logs",
  "semester_course_unlock",
  "semesters",
  "sessions",
  "staff_conversations",
  "staff_messages",
  "student_fees",
  "subjects",
  "super_admin_otps",
  "super_admin_password_changes",
  "test_activity",
  "test_joins",
  "test_monitoring_streams",
  "test_progress",
  "test_rejoin_requests",
  "test_submissions",
  "tests",
  "timetable",
  "users"
];

function sanitizeSql(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/'/g, "''");
}

function generateFullSQL() {
  let sql = `-- ========================================================\n`;
  sql += `-- Campus Orbis - Supabase Full Schema & Data Import\n`;
  sql += `-- Run in Supabase SQL Editor\n`;
  sql += `-- ========================================================\n\n`;

  sql += `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\n\n`;

  // Storage files table
  sql += `CREATE TABLE IF NOT EXISTS storage_files (\n`;
  sql += `  id TEXT PRIMARY KEY,\n`;
  sql += `  bucket TEXT NOT NULL,\n`;
  sql += `  filename TEXT NOT NULL,\n`;
  sql += `  content_type TEXT,\n`;
  sql += `  length BIGINT DEFAULT 0,\n`;
  sql += `  data TEXT,\n`;
  sql += `  metadata JSONB DEFAULT '{}'::jsonb,\n`;
  sql += `  upload_date TIMESTAMPTZ DEFAULT NOW()\n`;
  sql += `);\n`;
  sql += `CREATE INDEX IF NOT EXISTS idx_storage_files_bucket ON storage_files (bucket);\n`;
  sql += `CREATE INDEX IF NOT EXISTS idx_storage_files_filename ON storage_files (filename);\n\n`;

  for (const table of ALL_COLLECTIONS) {
    sql += `CREATE TABLE IF NOT EXISTS ${table} (\n`;
    sql += `  id TEXT PRIMARY KEY,\n`;
    sql += `  doc JSONB NOT NULL,\n`;
    sql += `  created_at TIMESTAMPTZ DEFAULT NOW()\n`;
    sql += `);\n`;
    sql += `CREATE INDEX IF NOT EXISTS idx_${table}_doc ON ${table} USING gin (doc);\n\n`;
  }

  sql += `-- ========================================================\n`;
  sql += `-- Data Insert Statements\n`;
  sql += `-- ========================================================\n\n`;

  for (const table of ALL_COLLECTIONS) {
    const jsonPath = path.join(BACKUP_DIR, `${table}.json`);
    if (!fs.existsSync(jsonPath)) continue;

    const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!records || records.length === 0) continue;

    sql += `-- Inserting into ${table} (${records.length} records)\n`;
    for (const rec of records) {
      const id = rec.id || (rec._id ? (typeof rec._id === 'object' ? rec._id.$oid || String(rec._id) : String(rec._id)) : null);
      if (!id) continue;

      const cleanDoc = JSON.parse(JSON.stringify(rec, (key, value) => {
        if (value && typeof value === 'object' && value.$oid) return value.$oid;
        return value;
      }));

      const jsonStr = JSON.stringify(cleanDoc);
      const escapedJson = sanitizeSql(jsonStr);
      const escapedId = sanitizeSql(id);

      sql += `INSERT INTO ${table} (id, doc) VALUES ('${escapedId}', '${escapedJson}'::jsonb) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc;\n`;
    }
    sql += `\n`;
  }

  // Handle files
  const logoFilesPath = path.join(BACKUP_DIR, 'college_logos.files.json');
  const logoChunksPath = path.join(BACKUP_DIR, 'college_logos.chunks.json');
  if (fs.existsSync(logoFilesPath) && fs.existsSync(logoChunksPath)) {
    const logoFiles = JSON.parse(fs.readFileSync(logoFilesPath, 'utf8'));
    const logoChunks = JSON.parse(fs.readFileSync(logoChunksPath, 'utf8'));
    for (const file of logoFiles) {
      const fileId = file._id ? (file._id.$oid || String(file._id)) : file.id;
      const chunks = logoChunks.filter(c => {
        const cId = c.files_id ? (c.files_id.$oid || String(c.files_id)) : null;
        return cId === fileId;
      }).sort((a,b) => a.n - b.n);
      
      let base64 = '';
      for (const chunk of chunks) {
        if (chunk.data && chunk.data.$binary && chunk.data.$binary.base64) {
          base64 += chunk.data.$binary.base64;
        }
      }
      
      sql += `INSERT INTO storage_files (id, bucket, filename, content_type, length, data, metadata) VALUES (\n`;
      sql += `  '${sanitizeSql(fileId)}',\n`;
      sql += `  'college_logos',\n`;
      sql += `  '${sanitizeSql(file.filename || 'logo.png')}',\n`;
      sql += `  '${sanitizeSql(file.contentType || 'image/png')}',\n`;
      sql += `  ${file.length || 0},\n`;
      sql += `  '${base64}',\n`;
      sql += `  '${sanitizeSql(JSON.stringify(file.metadata || {}))}'::jsonb\n`;
      sql += `) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data;\n\n`;
    }
  }

  fs.writeFileSync(OUT_FILE, sql, 'utf8');
  console.log('Full SQL generated at:', OUT_FILE);
  console.log('Size:', (fs.statSync(OUT_FILE).size / 1024).toFixed(2), 'KB');
}

generateFullSQL();
