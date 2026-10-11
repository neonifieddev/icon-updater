import { studioEnvironment } from './connections.js';
import { roblox } from './roblox.js';

export async function authenticatedGame(env, universe) {
  try {
    const details = await roblox(env, `/cloud/v2/universes/${universe}`);
    if (!details.displayName?.trim()) {
      return null;
    }
    return {
      id: universe,
      name: details.displayName.trim(),
      rootPlaceId: details.rootPlace?.match(/\/places\/(\d+)$/)?.[1],
    };
  } catch {
    return null;
  }
}

export function gameLabel(name, universe) {
  const clean =
    String(name || 'Game')
      .replace(/[\\*_`~|<>[\]\r\n]/g, '')
      .trim() || 'Game';
  return `${clean} (${universe})`;
}

export async function fetchGames(universes) {
  if (!universes.length) {
    return [];
  }
  try {
    const response = await fetch(
      `https://games.roblox.com/v1/games?universeIds=${universes.join(',')}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()).data;
    return Array.isArray(data)
      ? data.filter(
          (game) =>
            universes.includes(String(game.id)) &&
            typeof game.name === 'string' &&
            game.name.trim(),
        )
      : [];
  } catch {
    return [];
  }
}

export async function refreshGameNames(env, guild) {
  const { results } = await env.DB.prepare(
    'SELECT id, universe_id, name, studio_id FROM games WHERE guild_id = ?',
  )
    .bind(guild)
    .all();
  const details = await fetchGames(results.map((game) => game.universe_id));
  await Promise.all(
    results
      .filter(
        (game) => !details.some((item) => String(item.id) === game.universe_id),
      )
      .map(async (game) => {
        try {
          const scoped = await studioEnvironment(env, guild, game.studio_id);
          const authenticated = await authenticatedGame(
            scoped,
            game.universe_id,
          );
          if (authenticated) {
            details.push(authenticated);
          }
        } catch {
          /* Keep the saved name when a studio is disconnected or unavailable. */
        }
      }),
  );
  const changes = results.flatMap((game) => {
    const name = details
      .find((item) => String(item.id) === game.universe_id)
      ?.name.trim()
      .slice(0, 100);
    return name && name !== game.name
      ? [
          env.DB.prepare(
            'UPDATE games SET name = ? WHERE id = ? AND guild_id = ?',
          ).bind(name, game.id, guild),
        ]
      : [];
  });
  if (changes.length) {
    await env.DB.batch(changes);
  }
}

export async function savedGameLabel(env, guild, universe) {
  const game = await env.DB.prepare(
    'SELECT name FROM games WHERE guild_id = ? AND universe_id = ?',
  )
    .bind(guild, universe)
    .first();
  return gameLabel(game?.name, universe);
}
