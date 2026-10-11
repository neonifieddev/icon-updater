import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
export function database() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  const wrap = (sql, values = []) => ({
    bind(...args) {
      return wrap(sql, args);
    },
    async run() {
      const result = db.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
    async first() {
      return db.prepare(sql).get(...values) || null;
    },
    async all() {
      return { results: db.prepare(sql).all(...values) };
    },
  });
  return {
    prepare: wrap,
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements) {
          out.push(await statement.run());
        }
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
export function bucket() {
  const files = new Map();
  return {
    async put(key, content) {
      files.set(key, await new Response(content).blob());
    },
    async get(key, options) {
      if (options?.type !== 'stream') {
        throw new Error('Tests expect KV stream reads');
      }
      return files.get(key)?.stream() || null;
    },
  };
}
export async function seed(env, now, stage = 'NOW', state = 'ready') {
  await env.DB.prepare(
    `INSERT INTO schedules(id,guild_id,channel_id,universe_id,place_id,creator_json,target_at,created_at,base_key)
    VALUES ('schedule','guild','channel','1001','2001','{"userId":"3001"}',?,?, 'base')`,
  )
    .bind(now - 1000, now - 3600_000)
    .run();
  await env.DB.prepare(
    'INSERT INTO jobs(id,schedule_id,stage,due_at,overlay_key,state,image_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      'job',
      'schedule',
      stage,
      now - 1000,
      'overlay',
      state,
      state === 'pending' ? null : '123',
    )
    .run();
}
export async function job(env) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = 'job'").first();
}
export async function schedule(env) {
  return env.DB.prepare(
    "SELECT * FROM schedules WHERE id = 'schedule'",
  ).first();
}
