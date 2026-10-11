import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorize,
  parseTarget,
  stagesFor,
  latestDue,
  assetId,
  cleanError,
} from '../src/core.js';
import { verifyDiscord } from '../src/worker.js';
import { readLimited, attachmentImage } from '../src/images.js';

test('access is limited to configured guilds and authorized people or administrators', () => {
  const env = {
    ALLOWED_GUILD_IDS: 'a',
    ALLOWED_USER_IDS: 'owner',
    ALLOW_SERVER_ADMINS: 'true',
  };
  const interaction = {
    guild_id: 'a',
    member: { user: { id: 'admin' }, permissions: '8' },
  };

  assert.equal(authorize(interaction, env), true);
  assert.equal(authorize({ ...interaction, guild_id: 'b' }, env), false);
  assert.equal(
    authorize(
      {
        ...interaction,
        member: { user: { id: 'ordinary' }, permissions: '32' },
      },
      env,
    ),
    false,
  );
  assert.equal(
    authorize(
      { ...interaction, member: { user: { id: 'owner' }, permissions: '0' } },
      env,
    ),
    true,
  );
  assert.equal(
    authorize(interaction, { ...env, ALLOW_SERVER_ADMINS: 'false' }),
    false,
  );
});
test('target times require a timezone, valid calendar date, and preparation time', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');

  assert.equal(
    parseTarget('2026-10-02T18:00:00+02:00', now),
    Date.parse('2026-10-02T16:00:00Z'),
  );

  for (const invalid of [
    '2026-10-02T18:00',
    '2026-10-01T00:05:00Z',
    '2026-02-30T18:00:00Z',
    '2026-10-02T24:00:00Z',
  ]) {
    assert.throws(() => parseTarget(invalid, now));
  }
});
test('late starts keep only the currently applicable stage and future checkpoints', () => {
  const target = 24 * 3600_000;

  assert.deepEqual(
    stagesFor(target, 0).map((x) => x.stage),
    ['24h', '12h', '6h', '3h', '2h', '1h', '30m', '15m', 'NOW'],
  );
  assert.deepEqual(
    stagesFor(target, target - 40 * 60_000).map((x) => x.stage),
    ['1h', '30m', '15m', 'NOW'],
  );
  assert.equal(latestDue(stagesFor(target, 0), target).stage, 'NOW');
});
test('asset IDs and error messages are handled without leaking credentials', () => {
  assert.equal(assetId({ path: 'assets/123' }), '123');
  assert.throws(() => assetId({ path: 'operations/123' }));
  assert.equal(
    cleanError(new Error('key secret'), { ROBLOX_API_KEY: 'secret' }),
    'key [redacted]',
  );
});
test('Discord signature verification rejects changed payloads and stale requests', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const publicKey = Buffer.from(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  ).toString('hex');
  const body = '{"type":1}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(timestamp + body),
    ),
  ).toString('hex');
  const request = new Request('https://test/interactions', {
    headers: {
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signature,
    },
  });

  assert.equal(await verifyDiscord(request, body, publicKey), true);
  assert.equal(await verifyDiscord(request, '{}', publicKey), false);
  assert.equal(
    await verifyDiscord(request, body, publicKey, Date.now() + 3600_000),
    false,
  );
});
test('attachment downloader enforces byte limits even without content-length', async () => {
  await assert.rejects(readLimited(new Response('123456'), 3), /exceeds/);
  await assert.rejects(
    attachmentImage({}, { url: 'https://evil.test/attachments/a', size: 1 }),
    /Only Discord/,
  );
});

test('slash-command ephemeral PNG attachments are accepted with signed URLs intact', async (t) => {
  const original = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = original;
  });
  const url =
    'https://cdn.discordapp.com/ephemeral-attachments/123/456/overlay.png?ex=abc&is=def&hm=signature';

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), url);
    assert.equal(init.redirect, 'manual');

    return new Response(new Uint8Array([137, 80, 78, 71]));
  };

  const env = {
    IMAGES: {
      async info() {
        return { format: 'image/png', width: 512, height: 512 };
      },
    },
  };

  assert.equal((await attachmentImage(env, { url, size: 4 }, true)).size, 4);

  for (const bad of [
    'https://cdn.discordapp.com.evil.test/ephemeral-attachments/a',
    'http://cdn.discordapp.com/attachments/a',
    'https://cdn.discordapp.com/avatars/a',
  ]) {
    await assert.rejects(
      attachmentImage(env, { url: bad, size: 4 }, true),
      /Only Discord/,
    );
  }
});
