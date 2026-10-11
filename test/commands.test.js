import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand } from '../src/commands.js';
import worker from '../src/worker.js';
import { database, bucket } from './helpers.js';
import { STAGES } from '../src/core.js';

test('testicon queues only the chosen stage without a date or other overlays', async (t) => {
  const env = {
    DB: database(),
    FILES: bucket(),
    ALLOWED_UNIVERSE_IDS: '1001',
    UNIVERSE_ROOT_PLACES: '{"1001":"2001"}',
    IMAGES: {
      async info() {
        return { width: 512, height: 512, format: 'png' };
      },
    },
  };
  t.after(() => env.DB.close());
  await env.DB.prepare('INSERT INTO overlays VALUES (?, ?, ?, ?)')
    .bind('guild', '6h', 'saved-six-hour', Date.now())
    .run();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('cdn.discordapp.com')) {
      return new Response('image');
    }
    if (url.includes('readMask')) {
      return Response.json({ icon: 'assets/previous' });
    }
    if (url.includes('game-icon')) {
      return Response.json({ data: [] });
    }
    return Response.json({
      assetType: 'Place',
      creationContext: { creator: { userId: '3001' } },
    });
  };
  const interaction = {
    guild_id: 'guild',
    channel_id: 'channel',
    data: {
      name: 'testicon',
      options: [
        { name: 'universe_id', value: '1001' },
        { name: 'stage', value: '6h' },
        { name: 'icon', value: 'file' },
      ],
      resolved: {
        attachments: {
          file: {
            url: 'https://cdn.discordapp.com/ephemeral-attachments/a/b/icon.png',
            size: 5,
          },
        },
      },
    },
  };
  assert.match(
    (await executeCommand(env, interaction)).content,
    /Queued a real main-icon change/,
  );
  const { results } = await env.DB.prepare('SELECT * FROM jobs').all();
  assert.equal(results.length, 1);
  assert.equal(results[0].stage, '6h');
  assert.equal(results[0].overlay_key, 'saved-six-hour');
  assert.ok(results[0].due_at <= Date.now());
  await assert.rejects(executeCommand(env, interaction), /active schedule/);
});

test('creating a schedule snapshots all overlays and resolves the owner without mutating Roblox', async (t) => {
  const env = {
    DB: database(),
    FILES: bucket(),
    ALLOWED_UNIVERSE_IDS: '1001',
    UNIVERSE_ROOT_PLACES: '{"1001":"2001"}',
    IMAGES: {
      async info() {
        return { width: 512, height: 512, format: 'image/png' };
      },
    },
  };
  t.after(() => env.DB.close());
  for (const [stage] of STAGES) {
    await env.DB.prepare('INSERT INTO overlays VALUES (?, ?, ?, ?)')
      .bind('guild', stage, `original/${stage}`, Date.now())
      .run();
  }
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(!init.method || init.method === 'GET');
    if (String(url).includes('cdn.discordapp.com')) {
      return new Response('test image');
    }
    if (url.includes('readMask=icon')) {
      return Response.json({ icon: 'assets/previous' });
    }
    if (url.includes('game-icon')) {
      return Response.json({
        data: [{ imageId: 'previous', languageCode: 'en' }],
      });
    }
    return Response.json({
      assetType: 'Place',
      creationContext: { creator: { userId: '3001' } },
    });
  };
  const target = new Date(Date.now() + 48 * 3600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const interaction = {
    guild_id: 'guild',
    channel_id: 'channel',
    data: {
      name: 'updategame',
      options: [
        { name: 'universe_id', value: '1001' },
        { name: 'target_time', value: target },
        { name: 'icon', value: 'attachment' },
      ],
      resolved: {
        attachments: {
          attachment: {
            url: 'https://cdn.discordapp.com/attachments/a/b/icon.png',
            size: 10,
          },
        },
      },
    },
  };
  const result = await executeCommand(env, interaction);
  assert.match(result.content, /Scheduled Game/);
  assert.equal(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n,
    9,
  );
  await env.DB.prepare("UPDATE overlays SET object_key = 'replacement'").run();
  const { results: jobs } = await env.DB.prepare('SELECT * FROM jobs').all();
  assert.ok(jobs.every((job) => job.overlay_key.startsWith('original/')));
  await assert.rejects(
    executeCommand(env, interaction),
    /active schedule already exists/,
  );
});

test('signed Discord ping, forged signature, and interaction replay', async (t) => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const env = {
    DB: database(),
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: Buffer.from(
      await crypto.subtle.exportKey('raw', pair.publicKey),
    ).toString('hex'),
    ALLOWED_GUILD_IDS: 'guild',
    ALLOW_SERVER_ADMINS: 'true',
  };
  t.after(() => env.DB.close());
  async function request(data) {
    const raw = JSON.stringify(data);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = Buffer.from(
      await crypto.subtle.sign(
        'Ed25519',
        pair.privateKey,
        new TextEncoder().encode(timestamp + raw),
      ),
    ).toString('hex');
    return new Request('https://bot.test/interactions', {
      method: 'POST',
      body: raw,
      headers: {
        'x-signature-timestamp': timestamp,
        'x-signature-ed25519': signature,
      },
    });
  }
  const pending = [];
  const ctx = {
    waitUntil(promise) {
      pending.push(promise);
    },
  };
  assert.deepEqual(
    await (
      await worker.fetch(
        await request({ type: 1, application_id: 'app' }),
        env,
        ctx,
      )
    ).json(),
    { type: 1 },
  );
  assert.equal(
    (
      await worker.fetch(
        new Request('https://bot.test/interactions', {
          method: 'POST',
          body: '{}',
        }),
        env,
        ctx,
      )
    ).status,
    401,
  );
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let edits = 0;
  globalThis.fetch = async () => {
    edits++;
    return Response.json({});
  };
  const command = {
    id: 'interaction',
    type: 2,
    application_id: 'app',
    guild_id: 'guild',
    member: { user: { id: 'admin' }, permissions: '8' },
    token: 'test',
    data: { name: 'overlays' },
  };
  assert.equal(
    (await (await worker.fetch(await request(command), env, ctx)).json()).type,
    5,
  );
  assert.equal(
    (await (await worker.fetch(await request(command), env, ctx)).json()).type,
    5,
  );
  await Promise.all(pending);
  assert.equal(edits, 1);
});
