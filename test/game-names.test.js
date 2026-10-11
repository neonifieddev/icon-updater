import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.js';
import { refreshGameNames, savedGameLabel } from '../src/game-names.js';
import { encryptKey } from '../src/connections.js';

test('restricted public results fall back to the correct studio key for the universe name', async (t) => {
  const env = {
    DB: database(),
    STUDIO_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
  };
  const original = globalThis.fetch;
  t.after(() => {
    env.DB.close();
    globalThis.fetch = original;
  });
  const key = 'specific-studio-private-key';
  await env.DB.prepare('INSERT INTO studios VALUES (?,?,?,?,?)')
    .bind(
      'studio',
      'guild',
      'Studio',
      await encryptKey(env, 'guild', 'studio', key),
      0,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO games VALUES ('game','guild','studio','Game 42','42','84')",
  ).run();
  globalThis.fetch = async (url, options) => {
    if (url.includes('games.roblox.com')) {
      return Response.json({
        data: [
          { id: 0, name: '[TITLE UNAVAILABLE]', isContentRestricted: true },
        ],
      });
    }
    assert.equal(url, 'https://apis.roblox.com/cloud/v2/universes/42');
    assert.equal(options.headers['x-api-key'], key);
    return Response.json({
      displayName: 'Framework',
      rootPlace: 'universes/42/places/84',
    });
  };
  await refreshGameNames(env, 'guild');
  assert.equal(await savedGameLabel(env, 'guild', '42'), 'Framework (42)');
});

test('Roblox names refresh existing games, stay server-scoped and survive lookup failures', async (t) => {
  const env = { DB: database() };
  const original = globalThis.fetch;
  t.after(() => {
    env.DB.close();
    globalThis.fetch = original;
  });
  await env.DB.prepare(
    "INSERT INTO studios VALUES ('studio', 'guild', 'Studio', '', 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO games VALUES ('game', 'guild', 'studio', 'Game 42', '42', '84')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO games VALUES ('other', 'other-guild', 'studio', 'Other name', '42', '84')",
  ).run();
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://games.roblox.com/v1/games?universeIds=42');
    return Response.json({ data: [{ id: 42, name: 'Framework' }] });
  };
  await refreshGameNames(env, 'guild');
  assert.equal(await savedGameLabel(env, 'guild', '42'), 'Framework (42)');
  assert.equal(
    await savedGameLabel(env, 'other-guild', '42'),
    'Other name (42)',
  );
  globalThis.fetch = async () => new Response('', { status: 503 });
  await refreshGameNames(env, 'guild');
  assert.equal(await savedGameLabel(env, 'guild', '42'), 'Framework (42)');
  assert.equal(await savedGameLabel(env, 'guild', '99'), 'Game (99)');
});
