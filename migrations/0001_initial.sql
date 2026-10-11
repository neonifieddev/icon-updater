CREATE TABLE overlays (
  guild_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  object_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, stage)
);
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  universe_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  creator_json TEXT NOT NULL,
  target_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  previous_icon TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE UNIQUE INDEX one_active_universe ON schedules(universe_id) WHERE status = 'active';
CREATE TRIGGER max_active_schedules BEFORE INSERT ON schedules
WHEN NEW.status = 'active' AND (SELECT COUNT(*) FROM schedules WHERE status = 'active') >= 3
BEGIN SELECT RAISE(ABORT, 'At most three active schedules are supported'); END;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  stage TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  overlay_key TEXT NOT NULL,
  rendered_key TEXT,
  upload_operation TEXT,
  image_id TEXT,
  apply_operation TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  applied_at INTEGER,
  UNIQUE(schedule_id, stage)
);
CREATE INDEX jobs_due ON jobs(schedule_id, due_at);
CREATE TABLE locks (name TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE interactions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  content TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0
);
