CREATE TABLE studios (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL,
  encrypted_key TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(guild_id, name)
);
CREATE TABLE games (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL,
  studio_id TEXT NOT NULL REFERENCES studios(id), name TEXT NOT NULL,
  universe_id TEXT NOT NULL, place_id TEXT NOT NULL,
  UNIQUE(guild_id, universe_id)
);
ALTER TABLE schedules ADD COLUMN studio_id TEXT REFERENCES studios(id);
CREATE TRIGGER require_connected_studio BEFORE INSERT ON schedules
WHEN NEW.studio_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM studios WHERE id = NEW.studio_id AND guild_id = NEW.guild_id AND encrypted_key != ''
)
BEGIN SELECT RAISE(ABORT, 'Studio disconnected; reconnect before scheduling'); END;
CREATE TRIGGER prevent_active_disconnect BEFORE UPDATE OF encrypted_key ON studios
WHEN NEW.encrypted_key = '' AND EXISTS (
  SELECT 1 FROM schedules WHERE studio_id = NEW.id AND status = 'active'
)
BEGIN SELECT RAISE(ABORT, 'Cancel active countdowns before disconnecting'); END;
CREATE TABLE panels (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  game_id TEXT, studio_id TEXT, expires_at INTEGER NOT NULL
);
CREATE INDEX panels_expiry ON panels(expires_at);
CREATE TRIGGER max_studios BEFORE INSERT ON studios
WHEN (SELECT COUNT(*) FROM studios WHERE guild_id = NEW.guild_id) >= 10
BEGIN SELECT RAISE(ABORT, 'Maximum 10 studios per server'); END;
CREATE TRIGGER max_games BEFORE INSERT ON games
WHEN (SELECT COUNT(*) FROM games WHERE guild_id = NEW.guild_id) >= 25
BEGIN SELECT RAISE(ABORT, 'Maximum 25 games per server'); END;
