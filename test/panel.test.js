import test from 'node:test';
import assert from 'node:assert/strict';
import { database, bucket, seed } from './helpers.js';
import {
  encryptKey,
  studioEnvironment,
  importExisting,
} from '../src/connections.js';
import {
  executePanel,
  openModal,
  panelSession,
  modalValues,
} from '../src/panel.js';
import { runScheduler } from '../src/scheduler.js';
import { commandDefinitions } from '../src/discord-commands.js';
import worker from '../src/worker.js';

function fixture(t) {
  const env = {
    DB: database(),
    FILES: bucket(),
    STUDIO_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ALLOWED_GUILD_IDS: 'guild',
    ROBLOX_API_KEY: 'original-private-key-12345',
    ALLOWED_UNIVERSE_IDS: '1001',
    UNIVERSE_ROOT_PLACES: '{"1001":"2001"}',
  };
  t.after(() => env.DB.close());
  return env;
}
const interaction = (type, data, guild = 'guild', user = 'admin') => ({
  type,
  guild_id: guild,
  channel_id: 'channel',
  member: { user: { id: user }, permissions: '8' },
  data,
});
const form = (custom_id, values, resolved) =>
  interaction(5, {
    custom_id,
    components: Object.entries(values).map(([custom_id, value]) => ({
      type: 18,
      component: {
        custom_id,
        ...(Array.isArray(value) ? { values: value } : { value }),
      },
    })),
    resolved,
  });
async function start(env) {
  const original = globalThis.fetch;
  let page;
  try {
    globalThis.fetch = async () => Response.json({ data: [] });
    page = await executePanel(env, interaction(2, { name: 'panel' }));
  } finally {
    globalThis.fetch = original;
  }
  const id = page.components[0].components[0].custom_id.split(':')[1];
  return {
    page,
    id,
    click: (action, target = '') =>
      interaction(3, {
        custom_id: `p:${id}:${action}${target ? `:${target}` : ''}`,
      }),
  };
}
test('one option-free command; original configuration imports only into its own server', async (t) => {
  const env = fixture(t);
  assert.equal(commandDefinitions[0].name, 'panel');
  assert.equal(commandDefinitions[0].options, undefined);
  await importExisting(env, 'other');
  assert.equal(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM studios').first()).n,
    0,
  );
  const { page } = await start(env);
  await importExisting(env, 'guild');
  const { results } = await env.DB.prepare('SELECT * FROM studios').all();
  assert.equal(results.length, 1);
  assert.ok(!results[0].encrypted_key.includes(env.ROBLOX_API_KEY));
  assert.ok(!JSON.stringify(page).includes(env.ROBLOX_API_KEY));
  assert.equal(
    (await studioEnvironment(env, 'guild', results[0].id)).ROBLOX_API_KEY,
    env.ROBLOX_API_KEY,
  );
  assert.equal(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM games').first()).n,
    1,
  );
});
test('encryption is authenticated, randomized and bound to both studio and server', async (t) => {
  const env = fixture(t),
    key = 'studio-private-api-key-12345';
  const encrypted = await encryptKey(env, 'guild', 'studio', key);
  assert.notEqual(encrypted, await encryptKey(env, 'guild', 'studio', key));
  await env.DB.prepare('INSERT INTO studios VALUES (?,?,?,?,?)')
    .bind('studio', 'guild', 'A', encrypted, 0)
    .run();
  assert.equal(
    (await studioEnvironment(env, 'guild', 'studio')).ROBLOX_API_KEY,
    key,
  );
  await assert.rejects(
    studioEnvironment(env, 'other', 'studio'),
    /disconnected/,
  );
  await env.DB.prepare('UPDATE studios SET guild_id = ? WHERE id = ?')
    .bind('other', 'studio')
    .run();
  await assert.rejects(studioEnvironment(env, 'other', 'studio'), /unlock/);
});
test('panel ownership, expiry and game lookup block forged cross-server actions', async (t) => {
  const env = fixture(t),
    { click } = await start(env);
  await assert.rejects(
    panelSession(env, { ...click('home'), guild_id: 'other' }),
    /expired/,
  );
  await assert.rejects(
    panelSession(env, {
      ...click('home'),
      member: { user: { id: 'another-admin' } },
    }),
    /expired/,
  );
  await assert.rejects(
    openModal(env, click('update', 'unowned-game')),
    /Choose a saved game/,
  );
  await env.DB.prepare('UPDATE panels SET expires_at = 0').run();
  await assert.rejects(executePanel(env, click('home')), /expired/);
});
test('forms upload attachments without command options and keep game targets fixed', async (t) => {
  const env = fixture(t),
    { click, id } = await start(env);
  const modal = await openModal(env, click('update', 'original-1001'));
  assert.equal(modal.type, 9);
  assert.equal(modal.data.components[1].component.type, 19);
  assert.ok(modal.data.custom_id.length <= 100);
  assert.ok(modal.data.custom_id.endsWith('original-1001'));
  const data = form(`p:${id}:save-upload`, {
    stage: ['24h'],
    image: ['attachment'],
  }).data;
  assert.deepEqual(modalValues(data), { stage: '24h', image: 'attachment' });
  const connect = await openModal(env, click('connect'));
  assert.equal(connect.data.components[1].component.value, undefined);
});
test('studio connect, replace and disconnect never echo keys; active schedules block disconnect', async (t) => {
  const env = fixture(t),
    { id, click } = await start(env);
  const secret = 'new-studio-private-key-12345';
  const result = await executePanel(
    env,
    form(`p:${id}:save-connect`, { name: 'Second studio', key: secret }),
  );
  assert.ok(!JSON.stringify(result).includes(secret));
  const studio = await env.DB.prepare('SELECT * FROM studios WHERE name = ?')
    .bind('Second studio')
    .first();
  assert.equal(
    (await studioEnvironment(env, 'guild', studio.id)).ROBLOX_API_KEY,
    secret,
  );
  await seed(env, Date.now());
  await env.DB.prepare('UPDATE schedules SET studio_id = ?')
    .bind(studio.id)
    .run();
  await assert.rejects(
    executePanel(env, click('remove-key', studio.id)),
    /Cancel/,
  );
  await assert.rejects(
    env.DB.prepare("UPDATE studios SET encrypted_key = '' WHERE id = ?")
      .bind(studio.id)
      .run(),
    /Cancel/,
  );
  await executePanel(
    env,
    form(`p:${id}:save-key:${studio.id}`, { key: 'replacement-key-12345678' }),
  );
  assert.equal(
    (await studioEnvironment(env, 'guild', studio.id)).ROBLOX_API_KEY,
    'replacement-key-12345678',
  );
  await env.DB.prepare("UPDATE schedules SET status = 'cancelled'").run();
  await executePanel(env, click('remove-key', studio.id));
  await assert.rejects(
    studioEnvironment(env, 'guild', studio.id),
    /disconnected/,
  );
});
test('new game reads Roblox with selected studio key and scheduled job retains that connection', async (t) => {
  const env = fixture(t),
    { id } = await start(env);
  const secret = 'studio-b-private-key-12345';
  await executePanel(
    env,
    form(`p:${id}:save-connect`, { name: 'B', key: secret }),
  );
  const studio = await env.DB.prepare(
    "SELECT id FROM studios WHERE name = 'B'",
  ).first();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('games.roblox.com')) {
      return Response.json({
        data: [{ id: 42, rootPlaceId: 84, name: 'Roblox Game B' }],
      });
    }
    if (url.includes('cdn.discordapp.com')) {
      return new Response('PNG');
    }
    assert.equal(init.headers['x-api-key'], secret);
    if (url.includes('readMask')) {
      return Response.json({ icon: 'assets/123' });
    }
    if (url.includes('game-icon')) {
      return Response.json({ data: [] });
    }
    return Response.json({
      assetType: 'Place',
      creationContext: { creator: { groupId: '7' } },
    });
  };
  await executePanel(
    env,
    form(`p:${id}:save-addgame`, {
      name: 'Game B',
      studio: [studio.id],
      universe: '42',
    }),
  );
  const game = await env.DB.prepare(
    "SELECT * FROM games WHERE universe_id = '42'",
  ).first();
  assert.equal(game.studio_id, studio.id);
  assert.equal(game.place_id, '84');
  await env.DB.prepare('INSERT INTO overlays VALUES (?,?,?,?)')
    .bind('guild', '6h', 'overlay', Date.now())
    .run();
  env.IMAGES = {
    async info() {
      return { width: 512, height: 512, format: 'png' };
    },
  };
  await executePanel(
    env,
    form(
      `p:${id}:save-update:${game.id}`,
      { stage: ['6h'], image: ['file'] },
      {
        attachments: {
          file: {
            url: 'https://cdn.discordapp.com/ephemeral-attachments/a/b/icon.png',
            size: 3,
          },
        },
      },
    ),
  );
  const schedule = await env.DB.prepare('SELECT * FROM schedules').first();
  assert.equal(schedule.studio_id, studio.id);
  assert.equal(schedule.creator_json, '{"groupId":"7"}');
  await env.DB.prepare(
    "UPDATE jobs SET state = 'moderating', image_id = '999'",
  ).run();
  await runScheduler(env); // Proves cron decrypts B's key rather than falling back to the global key.
});
test('signed button interactions open forms immediately, then defer navigation as message updates', async (t) => {
  const env = fixture(t),
    { click } = await start(env);
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  env.DISCORD_APPLICATION_ID = 'app';
  env.ALLOW_SERVER_ADMINS = 'true';
  env.DISCORD_PUBLIC_KEY = Buffer.from(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  ).toString('hex');
  async function request(data) {
    const body = JSON.stringify({
      ...data,
      id: crypto.randomUUID(),
      application_id: 'app',
      token: 'test-token',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = Buffer.from(
      await crypto.subtle.sign(
        'Ed25519',
        pair.privateKey,
        new TextEncoder().encode(timestamp + body),
      ),
    ).toString('hex');
    return new Request('https://test/interactions', {
      method: 'POST',
      body,
      headers: {
        'x-signature-timestamp': timestamp,
        'x-signature-ed25519': signature,
      },
    });
  }
  const tasks = [],
    ctx = {
      waitUntil(p) {
        tasks.push(p);
      },
    };
  assert.equal(
    (
      await (
        await worker.fetch(await request(click('connect')), env, ctx)
      ).json()
    ).type,
    9,
  );
  assert.equal(tasks.length, 0);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({});
  };
  assert.equal(
    (await (await worker.fetch(await request(click('home')), env, ctx)).json())
      .type,
    6,
  );
  await Promise.all(tasks);
  assert.ok(payload.components.length > 0);
  assert.deepEqual(payload.attachments, []);
});
