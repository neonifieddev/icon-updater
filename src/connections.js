import { ids } from './core.js';
const encoder = new TextEncoder();
const encodeBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const decodeBase64 = (text) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
async function getEncryptionKey(env) {
  if (!env.STUDIO_ENCRYPTION_KEY) {
    throw new Error(
      'Studio encryption is not configured. Contact the bot owner.',
    );
  }
  return crypto.subtle.importKey(
    'raw',
    decodeBase64(env.STUDIO_ENCRYPTION_KEY),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function encryptKey(env, guild, id, value) {
  value = value.trim();
  if (value.length < 20 || value.length > 4000 || /\s/.test(value)) {
    throw new Error('Paste the complete Roblox API key without spaces.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`${guild}:${id}`) },
    await getEncryptionKey(env),
    encoder.encode(value),
  );
  return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
}
export async function studioEnvironment(env, guild, id) {
  const studio = await env.DB.prepare(
    'SELECT * FROM studios WHERE id = ? AND guild_id = ?',
  )
    .bind(id, guild)
    .first();
  if (!studio?.encrypted_key) {
    throw new Error(
      'This studio is disconnected. Connect a new key in Studios.',
    );
  }
  let key;
  try {
    const [iv, ciphertext] = studio.encrypted_key.split('.');
    key = new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: decodeBase64(iv),
          additionalData: encoder.encode(`${guild}:${id}`),
        },
        await getEncryptionKey(env),
        decodeBase64(ciphertext),
      ),
    );
  } catch {
    throw new Error('Could not unlock this studio. Contact the bot owner.');
  }
  return { ...env, ROBLOX_API_KEY: key };
}
// Import only the original configured server's key. Never share it with other servers.
export async function importExisting(env, guild) {
  if (guild !== ids(env.ALLOWED_GUILD_IDS)[0] || !env.ROBLOX_API_KEY) {
    return;
  }
  const id = `original-${guild}`;
  if (
    await env.DB.prepare('SELECT id FROM studios WHERE id = ?').bind(id).first()
  ) {
    return;
  }
  const encrypted = await encryptKey(env, guild, id, env.ROBLOX_API_KEY);
  const mappings = JSON.parse(env.UNIVERSE_ROOT_PLACES || '{}');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO studios VALUES (?, ?, ?, ?, ?)').bind(
      id,
      guild,
      'My studio',
      encrypted,
      Date.now(),
    ),
    ...ids(env.ALLOWED_UNIVERSE_IDS)
      .filter((universe) => mappings[universe])
      .map((universe) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO games VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(
          `original-${universe}`,
          guild,
          id,
          `Game ${universe}`,
          universe,
          String(mappings[universe]),
        ),
      ),
    env.DB.prepare(
      'UPDATE schedules SET studio_id = ? WHERE guild_id = ? AND studio_id IS NULL',
    ).bind(id, guild),
  ]);
}
