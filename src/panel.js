import {
  row,
  componentId,
  button,
  label,
  input,
  select,
  stageField,
  fileField,
} from './panel-components.js';
import {
  gameLabel,
  fetchGames,
  refreshGameNames,
  authenticatedGame,
} from './game-names.js';
import { cleanError } from './core.js';
import { executeCommand } from './commands.js';
import {
  encryptKey,
  studioEnvironment,
  importExisting,
} from './connections.js';
import { getPlace } from './roblox.js';

// Input validation

const validateStudioName = (value) => {
  const name = String(value || '').trim();

  if (!name || name.length > 60 || /[\r\n]/.test(name)) {
    throw new Error('Use a name between 1 and 60 characters.');
  }

  return name;
};
const display = (value) => String(value).replace(/[\\*_`~|<>[\]]/g, '');

export function modalValues(data) {
  const values = {};

  function visit(component) {
    if (component.custom_id) {
      values[component.custom_id] = component.value ?? component.values?.[0];
    }

    if (component.component) {
      visit(component.component);
    }

    for (const child of component.components || []) {
      visit(child);
    }
  }

  for (const component of data.components || []) {
    visit(component);
  }

  return values;
}

export async function panelSession(env, interaction) {
  const [, id, action, target] = (interaction.data.custom_id || '').split(':');
  const session = await env.DB.prepare(
    'SELECT * FROM panels WHERE id = ? AND guild_id = ? AND user_id = ? AND expires_at > ?',
  )
    .bind(
      id || '',
      interaction.guild_id,
      interaction.member.user.id,
      Date.now(),
    )
    .first();

  if (!session) {
    throw new Error('This panel has expired. Open /panel again.');
  }

  return { session, action, target };
}

async function getGame(env, session, id) {
  const game = await env.DB.prepare(
    'SELECT * FROM games WHERE id = ? AND guild_id = ?',
  )
    .bind(id || '', session.guild_id)
    .first();

  if (!game) {
    throw new Error('Choose a saved game first.');
  }

  return game;
}

async function getStudio(env, session, id) {
  const studio = await env.DB.prepare(
    'SELECT id, name, encrypted_key FROM studios WHERE id = ? AND guild_id = ?',
  )
    .bind(id || '', session.guild_id)
    .first();

  if (!studio) {
    throw new Error('Choose a studio first.');
  }

  return studio;
}
// Panel views

export async function home(env, session, notice = '') {
  const { results: games } = await env.DB.prepare(
    'SELECT games.*, studios.name AS studio_name FROM games JOIN studios ON studios.id = games.studio_id WHERE games.guild_id = ? ORDER BY games.name',
  )
    .bind(session.guild_id)
    .all();
  const game = games.find((game) => game.id === session.game_id) || games[0];
  const components = [];

  if (game) {
    components.push(
      row(
        select(
          componentId(session, 'game'),
          games.map((savedGame) => ({
            label: gameLabel(
              savedGame.name.slice(0, 75),
              savedGame.universe_id,
            ).slice(0, 100),
            value: savedGame.id,
            description: savedGame.studio_name.slice(0, 100),
            emoji: { name: '🎮' },
            default: savedGame.id === game.id,
          })),
          'Choose a game',
        ),
      ),
    );
    components.push(
      row(
        button(session, 'preview', 'Preview', game.id),
        button(session, 'update', 'Update now', game.id, 1),
        button(session, 'schedule', 'Schedule', game.id, 1),
      ),
    );
    components.push(
      row(
        button(session, 'status', 'Status', game.id),
        button(session, 'cancel', 'Cancel countdown', game.id),
      ),
    );
  }

  components.push(
    row(
      button(session, 'overlays', 'Overlays'),
      button(session, 'studios', 'Studios'),
      button(session, 'addgame', 'Add game'),
    ),
  );

  return {
    title: '🗺️ Updater',
    content: [
      notice ? `✅ ${notice}` : '',
      game
        ? `🎮 **${gameLabel(game.name, game.universe_id)}**\n🏢 ${display(game.studio_name)}\n\nYour next icon, ready in a few clicks.\nPreview it, publish it, or plan a countdown.`
        : '👋 Welcome!\nStart with **Studios**, then **Add game**.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    components,
  };
}

async function studioPage(env, session, notice = '') {
  const { results } = await env.DB.prepare(
    'SELECT id, name, encrypted_key FROM studios WHERE guild_id = ? ORDER BY name',
  )
    .bind(session.guild_id)
    .all();
  const studio =
    results.find((studio) => studio.id === session.studio_id) || results[0];
  const components = [];

  if (studio) {
    components.push(
      row(
        select(
          componentId(session, 'studio'),
          results.map((savedStudio) => ({
            label: savedStudio.name,
            value: savedStudio.id,
            description: savedStudio.encrypted_key
              ? 'Connected'
              : 'Disconnected',
            emoji: { name: savedStudio.encrypted_key ? '🟢' : '⚪' },
            default: savedStudio.id === studio.id,
          })),
          'Choose a studio',
        ),
      ),
    );
    components.push(
      row(
        button(
          session,
          'key',
          studio.encrypted_key ? 'Replace key' : 'Reconnect',
          studio.id,
        ),
        button(
          session,
          'disconnect',
          'Disconnect',
          studio.id,
          4,
          !studio.encrypted_key,
        ),
      ),
    );
  }

  components.push(
    row(
      button(session, 'connect', 'Connect studio', '', 1, results.length >= 10),
      button(session, 'home', 'Back'),
    ),
  );

  return {
    title: '🏢 Studios',
    content: [
      notice ? `✅ ${notice}` : '',
      studio
        ? `**${display(studio.name)}**\n${studio.encrypted_key ? '🟢 Connected' : '⚪ Disconnected'}`
        : 'Connect your first studio to get started.',
      '🔐 Keys stay encrypted and hidden.\nManaged by this server’s administrators.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    components,
  };
}

// Modal responses must be sent immediately, before any deferred acknowledgement.
export async function openModal(env, interaction) {
  if (interaction.type !== 3) {
    return null;
  }

  const { session, action, target } = await panelSession(env, interaction);
  let title, components;

  if (action === 'connect' || action === 'key') {
    if (action === 'key') {
      await getStudio(env, session, target);
    }

    title = action === 'connect' ? '🏢 Connect studio' : '🔑 Replace API key';
    components = [
      ...(action === 'connect'
        ? [label('Studio name', input('name', 'My studio', 60))]
        : []),
      label(
        'Roblox API key',
        { ...input('key', 'Paste your API key', 4000), style: 2 },
        'Submitted privately. Stored encrypted; never shown in the panel.',
      ),
    ];
  } else if (action === 'addgame') {
    const { results } = await env.DB.prepare(
      "SELECT id, name FROM studios WHERE guild_id = ? AND encrypted_key != '' ORDER BY name",
    )
      .bind(session.guild_id)
      .all();

    if (!results.length) {
      throw new Error('Open Studios and connect a studio first.');
    }

    title = '🎮 Add game';
    components = [
      label(
        'Studio',
        select(
          'studio',
          results.map((savedStudio) => ({
            label: savedStudio.name,
            value: savedStudio.id,
          })),
        ),
      ),
      label('Universe ID', input('universe', '1234567890', 20)),
    ];
  } else if (['preview', 'update', 'schedule'].includes(action)) {
    await getGame(env, session, target);
    title = {
      preview: '👀 Preview icon',
      update: '🚀 Update main icon',
      schedule: '📅 Schedule countdown',
    }[action];
    components =
      action === 'schedule'
        ? [
            label(
              'Launch date and time',
              input('date', '2026-10-10 18:00', 30),
              'Use YYYY-MM-DD HH:MM, at least 15 minutes from now.',
            ),
            label(
              'Timezone',
              input('timezone', '+02:00', 6),
              'UTC offset on launch day. Sweden: +02:00 summer, +01:00 winter.',
            ),
            fileField(false),
          ]
        : [stageField(), fileField(false)];
  } else if (action === 'upload') {
    title = '🎨 Upload overlay';
    components = [stageField(), fileField(true)];
  } else {
    return null;
  }

  return {
    type: 9,
    data: {
      custom_id: componentId(session, `save-${action}`, target),
      title,
      components,
    },
  };
}
// Interaction handlers

export async function executePanel(env, interaction) {
  if (interaction.type === 2) {
    if (interaction.data.name !== 'panel') {
      throw new Error('Open /panel to manage your icons.');
    }

    await importExisting(env, interaction.guild_id);
    await refreshGameNames(env, interaction.guild_id);
    const session = {
      id: crypto.randomUUID(),
      guild_id: interaction.guild_id,
      user_id: interaction.member.user.id,
    };

    await env.DB.prepare(
      'INSERT INTO panels(id,guild_id,user_id,expires_at) VALUES (?,?,?,?)',
    )
      .bind(
        session.id,
        session.guild_id,
        session.user_id,
        Date.now() + 86400_000,
      )
      .run();

    return home(env, session);
  }

  const { session, action, target } = await panelSession(env, interaction);
  const back = [row(button(session, 'home', 'Back to panel'))];
  const values = modalValues(interaction.data);

  if (interaction.type === 3) {
    if (action === 'home') {
      return home(env, session);
    }

    if (action === 'game') {
      const game = await getGame(env, session, interaction.data.values?.[0]);

      await env.DB.prepare('UPDATE panels SET game_id = ? WHERE id = ?')
        .bind(game.id, session.id)
        .run();

      return home(env, { ...session, game_id: game.id });
    }

    if (action === 'studio') {
      const studio = await getStudio(
        env,
        session,
        interaction.data.values?.[0],
      );

      await env.DB.prepare('UPDATE panels SET studio_id = ? WHERE id = ?')
        .bind(studio.id, session.id)
        .run();

      return studioPage(env, { ...session, studio_id: studio.id });
    }

    if (action === 'studios') {
      return studioPage(env, session);
    }

    if (action === 'disconnect') {
      const studio = await getStudio(env, session, target);

      return {
        title: '🔌 Disconnect studio?',
        color: 0xfee75c,
        content: `Remove the key for **${display(studio.name)}**?\n\nGames and overlays stay saved.\nCancel active countdowns before disconnecting.`,
        components: [
          row(
            button(session, 'remove-key', 'Disconnect', target, 4),
            button(session, 'studios', 'Keep connected'),
          ),
        ],
      };
    }

    if (action === 'remove-key') {
      await getStudio(env, session, target);
      const active = await env.DB.prepare(
        "SELECT id FROM schedules WHERE studio_id = ? AND status = 'active'",
      )
        .bind(target)
        .first();

      if (active) {
        throw new Error(
          'Cancel this studio’s active countdowns and wait for them to stop before disconnecting.',
        );
      }

      await env.DB.prepare(
        "UPDATE studios SET encrypted_key = '' WHERE id = ? AND guild_id = ?",
      )
        .bind(target, session.guild_id)
        .run();

      return studioPage(env, session, 'Studio disconnected.');
    }

    if (action === 'overlays') {
      const result = await executeCommand(env, {
        ...interaction,
        data: { name: 'overlays' },
      });

      return {
        ...result,
        components: [
          row(
            button(session, 'upload', 'Upload overlay', '', 1),
            button(session, 'home', 'Back'),
          ),
        ],
      };
    }

    if (action === 'cancel') {
      const game = await getGame(env, session, target);

      return {
        title: '⏹️ Cancel countdown?',
        color: 0xfee75c,
        content: `Stop future updates for **${gameLabel(game.name, game.universe_id)}**?\n\nThe current icon stays in place.`,
        components: [
          row(
            button(session, 'stop', 'Cancel countdown', target, 4),
            button(session, 'home', 'Keep countdown'),
          ),
        ],
      };
    }

    if (action === 'status' || action === 'stop') {
      const game = await getGame(env, session, target);
      const result = await executeCommand(
        { ...env, ALLOWED_UNIVERSE_IDS: game.universe_id },
        {
          ...interaction,
          data: {
            name: action === 'status' ? 'gamestatus' : 'cancelgame',
            options: [{ name: 'universe_id', value: game.universe_id }],
          },
        },
      );

      return {
        ...result,
        components: [
          row(
            button(session, 'status', 'Refresh', target),
            button(session, 'home', 'Back'),
          ),
        ],
      };
    }
  }

  if (interaction.type !== 5) {
    throw new Error('Open /panel again to continue.');
  }

  if (action === 'save-connect' || action === 'save-key') {
    const id =
      action === 'save-key'
        ? (await getStudio(env, session, target)).id
        : crypto.randomUUID();
    const encrypted = await encryptKey(
      env,
      session.guild_id,
      id,
      values.key || '',
    );

    if (action === 'save-key') {
      await env.DB.prepare(
        'UPDATE studios SET encrypted_key = ? WHERE id = ? AND guild_id = ?',
      )
        .bind(encrypted, id, session.guild_id)
        .run();
    } else {
      const name = validateStudioName(values.name);

      if (
        await env.DB.prepare(
          'SELECT id FROM studios WHERE guild_id = ? AND name = ?',
        )
          .bind(session.guild_id, name)
          .first()
      ) {
        throw new Error(
          'A studio with this name already exists. Use Replace key to update it.',
        );
      }

      await env.DB.prepare('INSERT INTO studios VALUES (?,?,?,?,?)')
        .bind(id, session.guild_id, name, encrypted, Date.now())
        .run();
    }

    return studioPage(
      env,
      { ...session, studio_id: id },
      'Key saved. Access is checked when you add or update a game.',
    );
  }

  if (action === 'save-addgame') {
    const universe = values.universe;

    if (!/^[1-9]\d{0,19}$/.test(universe || '')) {
      throw new Error('Enter the numeric universe ID from Creator Dashboard.');
    }

    const scoped = await studioEnvironment(
      env,
      session.guild_id,
      values.studio || '',
    );

    scoped.UNIVERSE_ROOT_PLACES = '{}';
    const [publicDetails] = await fetchGames([universe]);
    const details =
      publicDetails || (await authenticatedGame(scoped, universe));
    const name = details?.name.trim().slice(0, 100) || 'Game';

    if (details?.rootPlaceId) {
      scoped.UNIVERSE_ROOT_PLACES = JSON.stringify({
        [universe]: String(details.rootPlaceId),
      });
    }

    let place;

    try {
      place = await getPlace(scoped, universe);
    } catch (error) {
      // Discard the original error because it may contain the studio key.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(cleanError(error, scoped));
    }

    const id = crypto.randomUUID();

    if (
      await env.DB.prepare(
        'SELECT id FROM games WHERE guild_id = ? AND universe_id = ?',
      )
        .bind(session.guild_id, universe)
        .first()
    ) {
      throw new Error('This game is already saved in this server.');
    }

    await env.DB.prepare('INSERT INTO games VALUES (?,?,?,?,?,?)')
      .bind(id, session.guild_id, values.studio, name, universe, place.placeId)
      .run();
    await env.DB.prepare('UPDATE panels SET game_id = ? WHERE id = ?')
      .bind(id, session.id)
      .run();

    return home(env, { ...session, game_id: id }, 'Game connected.');
  }

  if (
    ['save-upload', 'save-preview', 'save-update', 'save-schedule'].includes(
      action,
    )
  ) {
    let scoped = env,
      studioId = null;
    const options = [
      { name: 'stage', value: values.stage },
      {
        name: action === 'save-upload' ? 'image' : 'icon',
        value: values.image,
      },
    ];

    if (action !== 'save-upload') {
      const game = await getGame(env, session, target);

      studioId = game.studio_id;
      scoped =
        action === 'save-preview'
          ? { ...env }
          : await studioEnvironment(env, session.guild_id, studioId);
      scoped.ALLOWED_UNIVERSE_IDS = game.universe_id;
      scoped.UNIVERSE_ROOT_PLACES = JSON.stringify({
        [game.universe_id]: game.place_id,
      });
      options.push({ name: 'universe_id', value: game.universe_id });
    }

    if (action === 'save-schedule') {
      if (!/^(Z|[+-](0\d|1[0-4]):[0-5]\d)$/.test(values.timezone || '')) {
        throw new Error('Use a UTC offset such as +02:00 or +01:00.');
      }

      options.push({
        name: 'target_time',
        value: `${String(values.date || '')
          .trim()
          .replace(' ', 'T')}${values.timezone}`,
      });
    }

    const name = {
      'save-upload': 'overlay',
      'save-preview': 'previewoverlay',
      'save-update': 'testicon',
      'save-schedule': 'updategame',
    }[action];

    try {
      const result = await executeCommand(
        scoped,
        {
          ...interaction,
          data: { name, options, resolved: interaction.data.resolved },
        },
        { studioId },
      );

      return {
        ...result,
        components:
          action === 'save-upload'
            ? [
                row(
                  button(session, 'upload', 'Upload another', '', 1),
                  button(session, 'home', 'Back'),
                ),
              ]
            : back,
      };
    } catch (error) {
      // Discard the original error because it may contain the studio key.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(cleanError(error, scoped));
    }
  }

  throw new Error('Open /panel again to continue.');
}
