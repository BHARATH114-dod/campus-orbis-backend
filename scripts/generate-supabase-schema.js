const fs = require('fs');
const path = require('path');

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

function generateSchema() {
  const OUT_FILE = path.join(__dirname, '..', 'supabase_schema.sql');
  
  let sql = `-- ========================================================\n`;
  sql += `-- Campus Orbis - Supabase PostgreSQL Schema\n`;
  sql += `-- Paste and click 'Run' in Supabase SQL Editor\n`;
  sql += `-- ========================================================\n\n`;

  sql += `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\n\n`;

  // Storage files table (GridFS drop-in replacement)
  sql += `-- Storage table for images, logos, documents and files\n`;
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

  sql += `-- Collection Tables & GIN Indexes (JSONB Document Model)\n`;
  for (const table of ALL_COLLECTIONS) {
    sql += `CREATE TABLE IF NOT EXISTS ${table} (\n`;
    sql += `  id TEXT PRIMARY KEY,\n`;
    sql += `  doc JSONB NOT NULL,\n`;
    sql += `  created_at TIMESTAMPTZ DEFAULT NOW()\n`;
    sql += `);\n`;
    sql += `CREATE INDEX IF NOT EXISTS idx_${table}_doc ON ${table} USING gin (doc);\n\n`;
  }

  fs.writeFileSync(OUT_FILE, sql, 'utf8');
  console.log('Schema written to:', OUT_FILE);
}

generateSchema();
