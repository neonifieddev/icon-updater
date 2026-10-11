import {
  commandDefinitions,
  legacyCommandNames,
} from '../src/discord-commands.js';

const { DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID } = process.env;
if (
  !DISCORD_TOKEN ||
  !/^\d+$/.test(DISCORD_APPLICATION_ID || '') ||
  !/^\d+$/.test(DISCORD_GUILD_ID || '')
) {
  throw new Error(
    'Set DISCORD_TOKEN, DISCORD_APPLICATION_ID, and DISCORD_GUILD_ID in .dev.vars.',
  );
}

const base = `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands`;

async function discord(method, path = '', body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const seconds = Number((await response.json()).retry_after);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) {
        break;
      }
      console.log('Discord rate limit reached; retrying shortly.');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1000, Math.ceil(seconds * 1000))),
      );
      continue;
    }
    if (method === 'DELETE' && response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw new Error(
        `Discord ${method} failed (${response.status}). Check the application, guild, and token.`,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }
  throw new Error('Discord rate limit persisted. Retry registration later.');
}

for (const command of commandDefinitions) {
  await discord('POST', '', command);
  console.log(`Registered /${command.name}`);
}

// Register first, then remove only commands retired by this project.
for (const command of await discord('GET')) {
  if (!legacyCommandNames.includes(command.name)) {
    continue;
  }
  await discord('DELETE', `/${command.id}`);
  console.log(`Replaced /${command.name} with /panel`);
}
