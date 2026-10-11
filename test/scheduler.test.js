import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduler, prepareJob, applyJob } from '../src/scheduler.js';
import { database, bucket, seed, job, schedule } from './helpers.js';

function fixture(t) {
  const env = { DB: database(), FILES: bucket(), ROBLOX_API_KEY: 'test-key' };

  t.after(() => env.DB.close());

  return env;
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;

  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('full main-icon update waits for operation and verifies public rendering', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now());
  let current = 'assets/old';
  let patches = 0;

  mockFetch(t, async (url, init = {}) => {
    if (init.method === 'PATCH') {
      assert.match(url, /2001\?updateMask=icon$/);
      assert.equal(init.headers['x-api-key'], 'test-key');
      assert.deepEqual(JSON.parse(init.body.get('request')), {
        assetId: '2001',
        icon: 'assets/123',
      });
      patches++;

      return Response.json({ path: 'operations/update' });
    }

    if (url.includes('operations/update')) {
      current = 'assets/123';

      return Response.json({ done: true, response: {} });
    }

    if (url.includes('readMask=icon')) {
      return Response.json({ icon: current });
    }

    if (url.includes('thumbnails.roblox.com')) {
      return Response.json({
        data: [{ state: 'Completed', imageUrl: 'https://cdn.test/same.png' }],
      });
    }

    throw new Error(`Unexpected URL ${url}`);
  });
  await runScheduler(env);
  assert.equal((await job(env)).state, 'applying');
  await env.DB.prepare('UPDATE jobs SET next_attempt = 0').run();
  await runScheduler(env);
  assert.equal((await job(env)).state, 'applied');
  assert.equal((await schedule(env)).status, 'complete');
  assert.equal(patches, 1);
});
test('public localized override mismatch does not report success', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now());
  mockFetch(t, async (url) =>
    url.includes('readMask')
      ? Response.json({ icon: 'assets/123' })
      : Response.json({
          data: [
            {
              state: 'Completed',
              imageUrl: url.includes('/games/') ? 'old.png' : 'new.png',
            },
          ],
        }),
  );
  await runScheduler(env);
  assert.equal((await job(env)).state, 'ready');
  assert.match((await job(env)).last_error, /public rendering differs/);
  assert.equal((await schedule(env)).status, 'active');
});
test('cancellation prevents new PATCH requests', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now());
  await env.DB.prepare('UPDATE schedules SET cancel_requested = 1').run();
  mockFetch(t, async () => {
    throw new Error('Network must not be called');
  });
  await runScheduler(env);
  assert.equal((await schedule(env)).status, 'cancelled');
});

test('a single non-NOW test stage completes and releases the universe', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now(), '6h');
  mockFetch(t, async (url) =>
    url.includes('readMask')
      ? Response.json({ icon: 'assets/123' })
      : Response.json({
          data: [{ state: 'Completed', imageUrl: 'https://cdn.test/same.png' }],
        }),
  );
  await runScheduler(env);
  assert.equal((await job(env)).state, 'applied');
  assert.equal((await schedule(env)).status, 'complete');
});

test('rejection of a single non-NOW test stage releases the universe', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now(), '6h', 'moderating');
  mockFetch(t, async () =>
    Response.json({ moderationResult: { moderationState: 'Rejected' } }),
  );
  await runScheduler(env);
  assert.equal((await schedule(env)).status, 'failed');
});
test('restarts skip outdated stages instead of flashing old countdowns', async (t) => {
  const env = fixture(t);
  const now = Date.now();

  await seed(env, now, '24h');
  await env.DB.prepare("UPDATE jobs SET due_at = ? WHERE id = 'job'")
    .bind(now - 86400_000)
    .run();
  await env.DB.prepare(
    "INSERT INTO jobs(id,schedule_id,stage,due_at,overlay_key,state) VALUES ('now','schedule','NOW',?,'overlay','failed')",
  )
    .bind(now - 1000)
    .run();
  mockFetch(t, async () => {
    throw new Error('Outdated icon must not be submitted');
  });
  await runScheduler(env);
  assert.equal((await job(env)).state, 'skipped');
});
test('scheduler lease prevents overlapping runs', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now());
  await env.DB.prepare(
    "INSERT INTO locks VALUES ('scheduler', 'another-worker', ?)",
  )
    .bind(Date.now() + 60_000)
    .run();
  mockFetch(t, async () => {
    throw new Error('Locked worker must not run');
  });
  await runScheduler(env);
  assert.equal((await job(env)).state, 'ready');
});
test('image upload is multipart Image and pending operations are persisted', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now(), 'NOW', 'rendered');
  await env.FILES.put(
    'rendered/job.png',
    new Blob(['PNG'], { type: 'image/png' }),
  );
  await env.DB.prepare("UPDATE jobs SET rendered_key='rendered/job.png'").run();
  mockFetch(t, async (url, init) => {
    assert.equal(init.method, 'POST');
    const payload = JSON.parse(init.body.get('request'));

    assert.equal(payload.assetType, 'Image');
    assert.equal(payload.creationContext.creator.userId, '3001');
    assert.equal(init.body.get('fileContent').type, 'image/png');

    return Response.json({ path: 'operations/upload' });
  });
  await prepareJob(env, await schedule(env), await job(env), Date.now());
  assert.equal((await job(env)).upload_operation, 'operations/upload');
  assert.equal((await job(env)).state, 'uploading');
});
test('moderation pending waits; rejection fails the stage', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now(), 'NOW', 'moderating');
  let moderationState = 'Reviewing';

  mockFetch(t, async () =>
    Response.json({ moderationResult: { moderationState } }),
  );
  await runScheduler(env);
  assert.equal((await job(env)).state, 'moderating');
  await env.DB.prepare('UPDATE jobs SET next_attempt = 0').run();
  moderationState = 'Rejected';
  await runScheduler(env);
  assert.equal((await job(env)).state, 'failed');
  assert.equal((await schedule(env)).status, 'failed');
});
test('cancellation is checked again immediately before mutation', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now());
  mockFetch(t, async (url, init = {}) => {
    assert.notEqual(init.method, 'PATCH');
    await env.DB.prepare('UPDATE schedules SET cancel_requested = 1').run();

    return Response.json({ icon: 'assets/old' });
  });
  await applyJob(env, await schedule(env), await job(env), Date.now());
  assert.equal((await job(env)).state, 'ready');
});
test('only one active schedule per universe is allowed by the database', async (t) => {
  const env = fixture(t);

  await seed(env, Date.now());
  await assert.rejects(
    env.DB.prepare(
      `INSERT INTO schedules SELECT 'other',guild_id,channel_id,universe_id,place_id,creator_json,target_at,created_at,base_key,previous_icon,status,cancel_requested,last_error,studio_id FROM schedules`,
    ).run(),
    /UNIQUE/,
  );
});
