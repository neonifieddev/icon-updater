import { authorize, cleanError } from './core.js';
import { executePanel, openModal, panelSession } from './panel.js';
import { runScheduler } from './scheduler.js';
import { readLimited } from './images.js';

function hexBytes(hex, length) {
  if (!new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(hex || '')) {
    throw new Error('Invalid hex');
  }
  return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
}
export async function verifyDiscord(
  request,
  rawBody,
  publicKey,
  now = Date.now(),
) {
  try {
    const timestamp = request.headers.get('x-signature-timestamp');
    if (
      !/^\d+$/.test(timestamp || '') ||
      Math.abs(now / 1000 - Number(timestamp)) > 300
    ) {
      return false;
    }
    const key = await crypto.subtle.importKey(
      'raw',
      hexBytes(publicKey, 32),
      'Ed25519',
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      hexBytes(request.headers.get('x-signature-ed25519'), 64),
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}
async function finishCommand(env, interaction) {
  let result;
  try {
    result = await executePanel(env, interaction);
  } catch (error) {
    result = {
      title: '⚠️ One thing to check',
      content: cleanError(error, env),
      error: true,
    };
    if (interaction.type !== 2) {
      try {
        const { session } = await panelSession(env, interaction);
        result.components = [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 2,
                label: 'Back to panel',
                emoji: { name: '↩️' },
                custom_id: `p:${session.id}:home`,
              },
            ],
          },
        ];
      } catch {
        /* Expired panels must be reopened with /panel. */
      }
    }
  }
  const payload = {
    embeds: [
      {
        title: result.title || '🗺️ Updater',
        description: result.content,
        color: result.error ? 0xfee75c : (result.color ?? 0x5865f2),
        footer: { text: 'Only you can see this • /panel' },
        ...(result.file ? { image: { url: 'attachment://preview.png' } } : {}),
      },
    ],
    components: result.components || [],
    attachments: [],
    allowed_mentions: { parse: [] },
  };
  let body;
  let headers;
  if (result.file) {
    body = new FormData();
    body.set(
      'payload_json',
      JSON.stringify({
        ...payload,
        attachments: [{ id: 0, filename: 'preview.png' }],
      }),
    );
    body.set('files[0]', result.file, 'preview.png');
  } else {
    body = JSON.stringify(payload);
    headers = { 'Content-Type': 'application/json' };
  }
  try {
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`,
      {
        method: 'PATCH',
        headers,
        body,
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      console.error('Discord response delivery failed', response.status);
    }
  } catch {
    console.error('Discord response delivery failed');
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true });
    }
    if (url.pathname !== '/interactions' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }
    if (Number(request.headers.get('content-length')) > 128_000) {
      return new Response('Too large', { status: 413 });
    }
    let body;
    try {
      body = await (
        await readLimited(new Response(request.body), 128_000)
      ).text();
    } catch {
      return new Response('Too large or empty', { status: 413 });
    }
    if (!(await verifyDiscord(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response('Invalid signature', { status: 401 });
    }
    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    if (interaction.application_id !== env.DISCORD_APPLICATION_ID) {
      return new Response('Wrong application', { status: 401 });
    }
    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }
    if (![2, 3, 5].includes(interaction.type)) {
      return new Response('Unsupported interaction', { status: 400 });
    }
    if (!authorize(interaction, env)) {
      return Response.json({
        type: 4,
        data: {
          content:
            'Only authorized users or administrators in configured servers can use this bot.',
          flags: 64,
        },
      });
    }
    if (interaction.type === 3) {
      try {
        const modal = await openModal(env, interaction);
        if (modal) {
          return Response.json(modal);
        }
      } catch (error) {
        return Response.json({
          type: 4,
          data: { content: cleanError(error, env), flags: 64 },
        });
      }
    }
    // Do not log interaction bodies: they contain short-lived Discord webhook tokens.
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO interactions(id, created_at) VALUES (?, ?)',
    )
      .bind(interaction.id, Date.now())
      .run();
    if (inserted.meta.changes) {
      ctx.waitUntil(finishCommand(env, interaction));
    }
    return Response.json(
      interaction.type === 3 ? { type: 6 } : { type: 5, data: { flags: 64 } },
    );
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runScheduler(env).catch((error) => {
        console.error('Scheduler failed:', cleanError(error, env));
      }),
    );
  },
};
