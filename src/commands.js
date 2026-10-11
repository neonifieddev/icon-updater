import { savedGameLabel } from './game-names.js';
import { STAGES, parseTarget, stagesFor, universeAllowed } from './core.js';
import { attachmentImage, compose } from './images.js';
import { getPlace } from './roblox.js';
import { getFile, putFile } from './storage.js';

const stateLabels = {
  pending: '🎨 Preparing',
  rendered: '📤 Ready to upload',
  uploading: '📤 Uploading',
  moderating: '⏳ Awaiting approval',
  ready: '🟢 Ready · waiting to apply',
  applying: '🔄 Applying',
  applied: '✅ Live · verified',
  failed: '⚠️ Needs attention',
  skipped: '⏭️ Skipped',
};

export async function executeCommand(
  env,
  interaction,
  { studioId = null } = {},
) {
  const values = Object.fromEntries(
    (interaction.data.options || []).map((x) => [x.name, x.value]),
  );
  const guild = interaction.guild_id;
  const attachment = (name) =>
    interaction.data.resolved?.attachments?.[values[name]];
  const stage = () => {
    if (!STAGES.some(([name]) => name === values.stage)) {
      throw new Error('Invalid countdown stage.');
    }

    return values.stage;
  };

  switch (interaction.data.name) {
    case 'overlay': {
      const label = stage();
      const blob = await attachmentImage(env, attachment('image'), true);
      const key = `overlays/${guild}/${crypto.randomUUID()}.png`;

      await putFile(env, key, blob);
      await env.DB.prepare(
        `INSERT INTO overlays(guild_id, stage, object_key, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, stage) DO UPDATE SET object_key = excluded.object_key, updated_at = excluded.updated_at`,
      )
        .bind(guild, label, key, Date.now())
        .run();

      return {
        content: `**${label}** is ready to use.\nAdd another stage or head back to preview it.`,
        title: '✅ Overlay saved',
        color: 0x57f287,
      };
    }

    case 'overlays': {
      const { results } = await env.DB.prepare(
        'SELECT stage FROM overlays WHERE guild_id = ?',
      )
        .bind(guild)
        .all();
      const saved = STAGES.filter(([name]) =>
        results.some((x) => x.stage === name),
      ).map((x) => x[0]);
      const missing = STAGES.filter(
        ([name]) => !results.some((x) => x.stage === name),
      ).map((x) => x[0]);

      return {
        content: `**${saved.length} / 9 stages ready**\n\n✅ **Saved**\n${saved.join(' · ') || 'None yet'}\n\n${missing.length ? `⬜ **Still needed**\n${missing.join(' · ')}` : '🎉 Your countdown set is complete.'}\n\nUpload a transparent PNG to add or replace a stage.`,
        title: '🎨 Overlays',
      };
    }

    case 'previewoverlay': {
      const row = await env.DB.prepare(
        'SELECT object_key FROM overlays WHERE guild_id = ? AND stage = ?',
      )
        .bind(guild, stage())
        .first();

      if (!row) {
        throw new Error('Save this stage in Overlays first.');
      }

      const base = await attachmentImage(env, attachment('icon'));
      const overlay = await getFile(env, row.object_key);

      if (!overlay) {
        throw new Error(
          'Overlay is not available yet. Wait a minute and try again.',
        );
      }

      return {
        title: '👀 Icon preview',
        content: `**${values.stage}** · 512 × 512\nPreview only — your live icon is unchanged.`,
        file: await compose(env, base.stream(), overlay.body),
      };
    }

    case 'testicon':
    case 'updategame': {
      const isTest = interaction.data.name === 'testicon';

      universeAllowed(values.universe_id, env);
      const now = Date.now();
      const target = isTest ? now : parseTarget(values.target_time, now);
      const stages = isTest
        ? [{ stage: stage(), due_at: now }]
        : stagesFor(target, now);
      const active = await env.DB.prepare(
        "SELECT id FROM schedules WHERE universe_id = ? AND status = 'active'",
      )
        .bind(values.universe_id)
        .first();

      if (active) {
        throw new Error(
          'An active schedule already exists for this universe. Cancel it and wait for cancellation to complete first.',
        );
      }

      const allActive = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM schedules WHERE status = 'active'",
      ).first();

      if (allActive.count >= 3) {
        throw new Error(
          'This small deployment supports at most three active schedules.',
        );
      }

      const { results: overlays } = await env.DB.prepare(
        'SELECT * FROM overlays WHERE guild_id = ?',
      )
        .bind(guild)
        .all();
      const required = isTest ? [values.stage] : STAGES.map(([name]) => name);
      const missing = required.filter(
        (name) => !overlays.some((x) => x.stage === name),
      );

      if (missing.length) {
        throw new Error(`Upload these overlays first: ${missing.join(', ')}.`);
      }

      const [place, base] = await Promise.all([
        getPlace(env, values.universe_id),
        attachmentImage(env, attachment('icon')),
      ]);
      const id = crypto.randomUUID();
      const key = `bases/${id}`;

      await putFile(env, key, base);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO schedules(id, guild_id, channel_id, universe_id, place_id, creator_json, target_at, created_at, base_key, previous_icon, studio_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          guild,
          interaction.channel_id,
          values.universe_id,
          place.placeId,
          JSON.stringify(place.creator),
          target,
          now,
          key,
          place.previousIcon,
          studioId,
        ),
        ...stages.map((job) =>
          env.DB.prepare(
            'INSERT INTO jobs(id, schedule_id, stage, due_at, overlay_key) VALUES (?, ?, ?, ?, ?)',
          ).bind(
            crypto.randomUUID(),
            id,
            job.stage,
            job.due_at,
            overlays.find((x) => x.stage === job.stage).object_key,
          ),
        ),
      ]);
      const gameName = await savedGameLabel(env, guild, values.universe_id);

      if (isTest) {
        return {
          title: '🚀 Icon update queued',
          color: 0x57f287,
          content: `Queued a real main-icon change.\n\n⏳ **${values.stage}**\n🎮 ${gameName}\n\nAllow a few minutes for Roblox to process it.\nCheck **Status** for progress. Your new icon stays live afterward.`,
        };
      }

      return {
        title: '📅 Countdown scheduled',
        color: 0x57f287,
        content: `Scheduled ${gameName}.\n\n🚀 **Launch**\n<t:${Math.floor(target / 1000)}:F>\n\n⏳ **Stages**\n${stages.map((x) => x.stage).join(' → ')}\n\nWe’ll take it from here. Check **Status** for progress.\nRoblox processing may delay visible updates.`,
      };
    }

    case 'gamestatus': {
      universeAllowed(values.universe_id, env);
      const schedule = await env.DB.prepare(
        'SELECT * FROM schedules WHERE universe_id = ? AND guild_id = ? ORDER BY created_at DESC LIMIT 1',
      )
        .bind(values.universe_id, guild)
        .first();

      if (!schedule) {
        return {
          title: '📊 Status',
          content:
            'Nothing scheduled yet.\nChoose **Update now** or **Schedule** to get started.',
        };
      }

      const { results: jobs } = await env.DB.prepare(
        'SELECT * FROM jobs WHERE schedule_id = ? ORDER BY due_at',
      )
        .bind(schedule.id)
        .all();

      return {
        title:
          schedule.status === 'complete'
            ? '✅ Icon update complete'
            : '📊 Update status',
        color: schedule.status === 'complete' ? 0x57f287 : 0x5865f2,
        content: [
          `🎮 **Game:** ${await savedGameLabel(env, guild, schedule.universe_id)}`,
          `**Status:** ${schedule.cancel_requested && schedule.status === 'active' ? 'Cancelling' : { active: 'In progress', complete: 'Complete', cancelled: 'Cancelled', failed: 'Needs attention' }[schedule.status] || schedule.status}`,
          ...(jobs.length > 1
            ? [`**Launch:** <t:${Math.floor(schedule.target_at / 1000)}:F>`]
            : []),
          '',
          ...jobs.map(
            (j) => `**${j.stage}** — ${stateLabels[j.state] || j.state}`,
          ),
          ...(schedule.last_error
            ? ['', `**Needs attention**\n${schedule.last_error}`]
            : []),
          ...(schedule.status === 'active'
            ? ['', 'Checks run every minute. Tap **Refresh** for the latest.']
            : []),
        ]
          .join('\n')
          .slice(0, 1900),
      };
    }

    case 'cancelgame': {
      universeAllowed(values.universe_id, env);
      const result = await env.DB.prepare(
        "UPDATE schedules SET cancel_requested = 1 WHERE universe_id = ? AND guild_id = ? AND status = 'active'",
      )
        .bind(values.universe_id, guild)
        .run();

      return {
        title: '⏹️ Countdown',
        content: result.meta.changes
          ? 'Stopping future updates within a minute.\n\nAn update already sent to Roblox may still finish. Your current icon stays in place.'
          : 'No active countdown for this game.',
      };
    }

    default:
      throw new Error('Unknown command. Re-register this bot’s commands.');
  }
}
