-- 学不通 2.0 PostgreSQL 初始化脚本
-- 对应 Server/internal/model/models.go
-- 适用: PostgreSQL 18+

BEGIN;

-- 1) 用户表
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  uid BIGINT NOT NULL UNIQUE,
  mobile VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  avatar VARCHAR(1024) NOT NULL DEFAULT '',
  credential_cipher TEXT NOT NULL,
  permission INTEGER NOT NULL DEFAULT 1,
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) 白名单表
CREATE TABLE IF NOT EXISTS whitelists (
  id BIGSERIAL PRIMARY KEY,
  mobile VARCHAR(32) NOT NULL UNIQUE,
  permission INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) 课程基础信息表
CREATE TABLE IF NOT EXISTS courses (
  id BIGSERIAL PRIMARY KEY,
  course_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  teacher VARCHAR(255) NOT NULL DEFAULT '',
  icon VARCHAR(1024) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_courses_course_class UNIQUE (course_id, class_id)
);

-- 4) 用户-课程关系表
CREATE TABLE IF NOT EXISTS user_courses (
  id BIGSERIAL PRIMARY KEY,
  user_uid BIGINT NOT NULL,
  course_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  is_selected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_courses_user_course_class UNIQUE (user_uid, course_id, class_id)
);

-- 5) 签到活动缓存表
CREATE TABLE IF NOT EXISTS sign_activities (
  id BIGSERIAL PRIMARY KEY,
  activity_id BIGINT NOT NULL UNIQUE,
  start_time BIGINT NOT NULL,
  end_time BIGINT NOT NULL,
  sign_type INTEGER NOT NULL,
  if_refresh_ewm BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6) 签到记录表
CREATE TABLE IF NOT EXISTS sign_records (
  id BIGSERIAL PRIMARY KEY,
  user_uid BIGINT NOT NULL,
  activity_id BIGINT NOT NULL,
  source_uid BIGINT NOT NULL,
  sign_time_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sign_records_user_activity UNIQUE (user_uid, activity_id)
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_user_courses_user_uid ON user_courses (user_uid);
CREATE INDEX IF NOT EXISTS idx_user_courses_course_class ON user_courses (course_id, class_id);
CREATE INDEX IF NOT EXISTS idx_sign_records_activity_id ON sign_records (activity_id);
CREATE INDEX IF NOT EXISTS idx_sign_records_user_uid ON sign_records (user_uid);
CREATE INDEX IF NOT EXISTS idx_whitelists_permission ON whitelists (permission);

COMMIT;

-- 可选: 手动插入首个管理员白名单（若不插入，则首次登录会自动成为管理员）
-- INSERT INTO whitelists (mobile, permission) VALUES ('13800000000', 2)
-- ON CONFLICT (mobile) DO UPDATE SET permission = EXCLUDED.permission, updated_at = NOW();
