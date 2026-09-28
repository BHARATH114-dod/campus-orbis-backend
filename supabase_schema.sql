-- ========================================================
-- Campus Orbis - Supabase PostgreSQL Schema
-- Paste and click 'Run' in Supabase SQL Editor
-- ========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Storage table for images, logos, documents and files
CREATE TABLE IF NOT EXISTS storage_files (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  length BIGINT DEFAULT 0,
  data TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  upload_date TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_storage_files_bucket ON storage_files (bucket);
CREATE INDEX IF NOT EXISTS idx_storage_files_filename ON storage_files (filename);

-- Collection Tables & GIN Indexes (JSONB Document Model)
CREATE TABLE IF NOT EXISTS academic_calendar (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_academic_calendar_doc ON academic_calendar USING gin (doc);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_announcements_doc ON announcements USING gin (doc);

CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attendance_doc ON attendance USING gin (doc);

CREATE TABLE IF NOT EXISTS club_quiz_participants (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_club_quiz_participants_doc ON club_quiz_participants USING gin (doc);

CREATE TABLE IF NOT EXISTS club_quizzes (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_club_quizzes_doc ON club_quizzes USING gin (doc);

CREATE TABLE IF NOT EXISTS clubs (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clubs_doc ON clubs USING gin (doc);

CREATE TABLE IF NOT EXISTS code_test_attempts (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_code_test_attempts_doc ON code_test_attempts USING gin (doc);

CREATE TABLE IF NOT EXISTS college_connections (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_college_connections_doc ON college_connections USING gin (doc);

CREATE TABLE IF NOT EXISTS college_course_access (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_college_course_access_doc ON college_course_access USING gin (doc);

CREATE TABLE IF NOT EXISTS college_messages (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_college_messages_doc ON college_messages USING gin (doc);

CREATE TABLE IF NOT EXISTS colleges (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_colleges_doc ON colleges USING gin (doc);

CREATE TABLE IF NOT EXISTS course_progress (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_course_progress_doc ON course_progress USING gin (doc);

CREATE TABLE IF NOT EXISTS course_requests (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_course_requests_doc ON course_requests USING gin (doc);

CREATE TABLE IF NOT EXISTS daily_course_progress (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daily_course_progress_doc ON daily_course_progress USING gin (doc);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_doc ON events USING gin (doc);

CREATE TABLE IF NOT EXISTS face_attendance_sessions (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_face_attendance_sessions_doc ON face_attendance_sessions USING gin (doc);

CREATE TABLE IF NOT EXISTS face_profiles (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_face_profiles_doc ON face_profiles USING gin (doc);

CREATE TABLE IF NOT EXISTS face_update_requests (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_face_update_requests_doc ON face_update_requests USING gin (doc);

CREATE TABLE IF NOT EXISTS faculty_language_access (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_faculty_language_access_doc ON faculty_language_access USING gin (doc);

CREATE TABLE IF NOT EXISTS forum_posts (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_forum_posts_doc ON forum_posts USING gin (doc);

CREATE TABLE IF NOT EXISTS forum_replies (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_forum_replies_doc ON forum_replies USING gin (doc);

CREATE TABLE IF NOT EXISTS leaderboard_adjustments (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_adjustments_doc ON leaderboard_adjustments USING gin (doc);

CREATE TABLE IF NOT EXISTS marks (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marks_doc ON marks USING gin (doc);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_doc ON notes USING gin (doc);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_doc ON notifications USING gin (doc);

CREATE TABLE IF NOT EXISTS payment_settings (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_settings_doc ON payment_settings USING gin (doc);

CREATE TABLE IF NOT EXISTS placement_applications (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_placement_applications_doc ON placement_applications USING gin (doc);

CREATE TABLE IF NOT EXISTS placement_drives (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_placement_drives_doc ON placement_drives USING gin (doc);

CREATE TABLE IF NOT EXISTS point_transactions (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_point_transactions_doc ON point_transactions USING gin (doc);

CREATE TABLE IF NOT EXISTS post_replies (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_replies_doc ON post_replies USING gin (doc);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_posts_doc ON posts USING gin (doc);

CREATE TABLE IF NOT EXISTS practice_files (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_practice_files_doc ON practice_files USING gin (doc);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_doc ON push_subscriptions USING gin (doc);

CREATE TABLE IF NOT EXISTS python_course_progress (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_python_course_progress_doc ON python_course_progress USING gin (doc);

CREATE TABLE IF NOT EXISTS saved_club_quizzes (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_club_quizzes_doc ON saved_club_quizzes USING gin (doc);

CREATE TABLE IF NOT EXISTS saved_tests (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_tests_doc ON saved_tests USING gin (doc);

CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sections_doc ON sections USING gin (doc);

CREATE TABLE IF NOT EXISTS security_logs (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_security_logs_doc ON security_logs USING gin (doc);

CREATE TABLE IF NOT EXISTS semester_course_unlock (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_semester_course_unlock_doc ON semester_course_unlock USING gin (doc);

CREATE TABLE IF NOT EXISTS semesters (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_semesters_doc ON semesters USING gin (doc);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_doc ON sessions USING gin (doc);

CREATE TABLE IF NOT EXISTS staff_conversations (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_conversations_doc ON staff_conversations USING gin (doc);

CREATE TABLE IF NOT EXISTS staff_messages (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_messages_doc ON staff_messages USING gin (doc);

CREATE TABLE IF NOT EXISTS student_fees (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_student_fees_doc ON student_fees USING gin (doc);

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subjects_doc ON subjects USING gin (doc);

CREATE TABLE IF NOT EXISTS super_admin_otps (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_super_admin_otps_doc ON super_admin_otps USING gin (doc);

CREATE TABLE IF NOT EXISTS super_admin_password_changes (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_super_admin_password_changes_doc ON super_admin_password_changes USING gin (doc);

CREATE TABLE IF NOT EXISTS test_activity (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_activity_doc ON test_activity USING gin (doc);

CREATE TABLE IF NOT EXISTS test_joins (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_joins_doc ON test_joins USING gin (doc);

CREATE TABLE IF NOT EXISTS test_monitoring_streams (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_monitoring_streams_doc ON test_monitoring_streams USING gin (doc);

CREATE TABLE IF NOT EXISTS test_progress (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_progress_doc ON test_progress USING gin (doc);

CREATE TABLE IF NOT EXISTS test_rejoin_requests (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_rejoin_requests_doc ON test_rejoin_requests USING gin (doc);

CREATE TABLE IF NOT EXISTS test_submissions (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_submissions_doc ON test_submissions USING gin (doc);

CREATE TABLE IF NOT EXISTS tests (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tests_doc ON tests USING gin (doc);

CREATE TABLE IF NOT EXISTS timetable (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_timetable_doc ON timetable USING gin (doc);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_doc ON users USING gin (doc);

