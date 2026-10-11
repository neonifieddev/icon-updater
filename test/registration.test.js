import test from 'node:test';
import assert from 'node:assert/strict';

test('registration retries rate limits and removes only retired commands after registering panel', async (t) => {
  const previousFetch = globalThis.fetch;
  const names = ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID'];
  const previousEnv = names.map((name) => process.env[name]);
  t.after(() => {
    globalThis.fetch = previousFetch;
    names.forEach((name, index) => {
      if (previousEnv[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previousEnv[index];
      }
    });
  });
  process.env.DISCORD_TOKEN = 'test-token';
  process.env.DISCORD_APPLICATION_ID = '123';
  process.env.DISCORD_GUILD_ID = '456';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) {
      return Response.json({ retry_after: 0 }, { status: 429 });
    }
    if (options.method === 'POST') {
      assert.equal(JSON.parse(options.body).name, 'panel');
      return Response.json({ id: 'panel-id' });
    }
    if (options.method === 'GET') {
      return Response.json([
        { id: 'panel-id', name: 'panel' },
        { id: 'old-id', name: 'icon' },
        { id: 'other-id', name: 'unrelated' },
      ]);
    }
    assert.ok(url.endsWith('/old-id'));
    return new Response(null, { status: 204 });
  };
  await import('../scripts/register-commands.js');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['POST', 'POST', 'GET', 'DELETE'],
  );
});
