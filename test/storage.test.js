import test from 'node:test';
import assert from 'node:assert/strict';
import { getFile, putFile } from '../src/storage.js';
import { bucket, database, seed, job } from './helpers.js';
import { runScheduler } from '../src/scheduler.js';

test('KV image adapter preserves binary bytes', async () => {
  const env = { FILES: bucket() };
  const bytes = new Uint8Array([0, 137, 255, 10, 128]);
  await putFile(env, 'icon', new Blob([bytes]));
  assert.deepEqual(
    new Uint8Array(await (await getFile(env, 'icon')).arrayBuffer()),
    bytes,
  );
  assert.equal(await getFile(env, 'not-yet-visible'), null);
});

test('KV propagation misses keep the preparation stage retryable', async (t) => {
  const env = { DB: database(), FILES: bucket() };
  t.after(() => env.DB.close());
  await seed(env, Date.now(), 'NOW', 'pending');
  await runScheduler(env);
  const row = await job(env);
  assert.equal(row.state, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt > Date.now());
  assert.match(row.last_error, /storage propagation/);
});
