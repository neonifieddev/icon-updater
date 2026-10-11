import { savedGameLabel } from './game-names.js';
import { studioEnvironment } from './connections.js';
import { latestDue, retryDelay, cleanError, assetId } from './core.js';
import { compose } from './images.js';
import { getFile, putFile } from './storage.js';
import {
  roblox,
  uploadImage,
  pollOperation,
  patchIcon,
  operationPath,
} from './roblox.js';

export async function updateJob(env, id, changes) {
  const fields = Object.keys(changes);
  await env.DB.prepare(
    `UPDATE jobs SET ${fields.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
  )
    .bind(...Object.values(changes), id)
    .run();
}
async function notify(env, id, schedule, content) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO notifications(id, channel_id, content) VALUES (?, ?, ?)',
  )
    .bind(id, schedule.channel_id, content)
    .run();
}
async function flushNotifications(env) {
  if (!env.DISCORD_TOKEN) {
    return;
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM notifications WHERE sent = 0 AND attempts < 5 LIMIT 2',
  ).all();
  for (const item of results) {
    try {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${item.channel_id}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bot ${env.DISCORD_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: item.content,
            allowed_mentions: { parse: [] },
            nonce: item.id.slice(0, 25),
            enforce_nonce: true,
          }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      await env.DB.prepare(
        'UPDATE notifications SET sent = ?, attempts = attempts + 1 WHERE id = ?',
      )
        .bind(response.ok ? 1 : 0, item.id)
        .run();
    } catch {
      await env.DB.prepare(
        'UPDATE notifications SET attempts = attempts + 1 WHERE id = ?',
      )
        .bind(item.id)
        .run();
    }
  }
}
export async function prepareJob(env, schedule, job, now) {
  let changes = {};
  if (job.state === 'pending') {
    const [base, overlay] = await Promise.all([
      getFile(env, schedule.base_key),
      getFile(env, job.overlay_key),
    ]);
    if (!base || !overlay) {
      throw new Error(
        'Source image is not available yet; waiting for storage propagation.',
      );
    }
    const blob = await compose(env, base.body, overlay.body);
    const key = `rendered/${job.id}.png`;
    await putFile(env, key, blob);
    changes = { rendered_key: key, state: 'rendered' };
  } else if (job.state === 'rendered') {
    const file = await getFile(env, job.rendered_key);
    if (!file) {
      throw new Error(
        'Generated image is not available yet; waiting for storage propagation.',
      );
    }
    const result = await uploadImage(
      env,
      JSON.parse(schedule.creator_json),
      new Blob([await file.arrayBuffer()], { type: 'image/png' }),
      job.stage,
    );
    changes = result.operation
      ? { upload_operation: result.operation, state: 'uploading' }
      : { image_id: result.imageId, state: 'moderating' };
  } else if (job.state === 'uploading') {
    const result = await pollOperation(env, job.upload_operation);
    if (!result) {
      if (now > schedule.created_at + 24 * 3600_000) {
        throw new Error('Upload operation still incomplete after 24 hours.');
      }
      await updateJob(env, job.id, { next_attempt: now + 60_000 });
      return;
    }
    changes = { image_id: assetId(result), state: 'moderating' };
  } else if (job.state === 'moderating') {
    const result = await roblox(env, `/assets/v1/assets/${job.image_id}`);
    const moderation = String(
      result.moderationResult?.moderationState || '',
    ).toUpperCase();
    if (moderation.endsWith('REJECTED')) {
      const error = new Error(
        `Roblox rejected the ${job.stage} image. Replace its artwork and create a new schedule.`,
      );
      error.permanent = true;
      throw error;
    }
    if (!moderation.endsWith('APPROVED')) {
      if (
        now >
        Math.max(
          schedule.created_at + 24 * 3600_000,
          schedule.target_at + 3600_000,
        )
      ) {
        throw new Error('Image moderation did not complete in time.');
      }
      await updateJob(env, job.id, { next_attempt: now + 60_000 });
      return;
    }
    changes = { state: 'ready' };
  }
  if (Object.keys(changes).length) {
    await updateJob(env, job.id, {
      ...changes,
      attempts: 0,
      last_error: null,
      next_attempt: 0,
    });
  }
}
export async function applyJob(env, schedule, job, now) {
  if (job.state === 'applying' && job.apply_operation) {
    const result = await pollOperation(env, job.apply_operation);
    if (!result) {
      if (now > job.due_at + 3600_000) {
        throw new Error('Icon update operation has not completed.');
      }
      await updateJob(env, job.id, { next_attempt: now + 60_000 });
      return;
    }
    await updateJob(env, job.id, { apply_operation: null });
  }
  const current = await roblox(
    env,
    `/assets/v1/assets/${schedule.place_id}?readMask=icon`,
  );
  if (current.icon !== `assets/${job.image_id}`) {
    if (job.state === 'applying') {
      throw new Error(
        'Roblox accepted the icon update, but metadata readback has not matched yet.',
      );
    }
    const fresh = await env.DB.prepare(
      'SELECT status, cancel_requested FROM schedules WHERE id = ?',
    )
      .bind(schedule.id)
      .first();
    if (fresh?.status !== 'active' || fresh.cancel_requested) {
      return;
    }
    // Re-check time at the point of mutation, not only at the start of this cron invocation.
    const newer = await env.DB.prepare(
      'SELECT id FROM jobs WHERE schedule_id = ? AND due_at > ? AND due_at <= ? LIMIT 1',
    )
      .bind(schedule.id, job.due_at, Date.now())
      .first();
    if (newer) {
      await updateJob(env, job.id, { state: 'skipped' });
      return;
    }
    const result = await patchIcon(env, schedule.place_id, job.image_id);
    await updateJob(env, job.id, {
      state: 'applying',
      apply_operation: operationPath(result),
      next_attempt: now + 60_000,
    });
    return;
  }
  // Main metadata is not enough: compare actual public and uploaded-image renders.
  const [gameResponse, imageResponse] = await Promise.all([
    fetch(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${schedule.universe_id}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`,
      { signal: AbortSignal.timeout(10_000) },
    ),
    fetch(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${job.image_id}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`,
      { signal: AbortSignal.timeout(10_000) },
    ),
  ]);
  if (!gameResponse.ok || !imageResponse.ok) {
    throw new Error('Could not verify the public icon render.');
  }
  const game = (await gameResponse.json()).data?.[0];
  const image = (await imageResponse.json()).data?.[0];
  if (
    game?.state !== 'Completed' ||
    image?.state !== 'Completed' ||
    !game.imageUrl ||
    game.imageUrl !== image.imageUrl
  ) {
    throw new Error(
      'Main icon is set, but public rendering differs. Check caching or localized overrides in Creator Dashboard.',
    );
  }
  await updateJob(env, job.id, {
    state: 'applied',
    applied_at: now,
    attempts: 0,
    last_error: null,
    next_attempt: 0,
  });
  await env.DB.prepare('UPDATE schedules SET last_error = NULL WHERE id = ?')
    .bind(schedule.id)
    .run();
  await notify(
    env,
    job.id,
    schedule,
    `${job.stage} icon verified for ${await savedGameLabel(env, schedule.guild_id, schedule.universe_id)}.`,
  );
  await env.DB.prepare(
    "UPDATE schedules SET status = 'complete' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM jobs WHERE schedule_id = ? AND due_at > ?)",
  )
    .bind(schedule.id, schedule.id, job.due_at)
    .run();
}
async function handleFailure(env, schedule, job, error, now) {
  const attempts = job.attempts + 1;
  const message = cleanError(error, env);
  const failed = error.permanent || attempts >= 8;
  await updateJob(env, job.id, {
    attempts,
    last_error: message,
    next_attempt: now + retryDelay(attempts),
    ...(failed ? { state: 'failed' } : {}),
  });
  await env.DB.prepare('UPDATE schedules SET last_error = ? WHERE id = ?')
    .bind(`${job.stage}: ${message}`, schedule.id)
    .run();
  if (failed || attempts === 1) {
    await notify(
      env,
      `${job.id.slice(0, 20)}-${failed ? 'fail' : 'retry'}`,
      schedule,
      `${job.stage} for ${await savedGameLabel(env, schedule.guild_id, schedule.universe_id)}: ${message}${failed ? ' Open /panel → Status; this stage has stopped retrying.' : ' Retrying automatically.'}`,
    );
  }
  if (failed) {
    await env.DB.prepare(
      "UPDATE schedules SET status = 'failed' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM jobs WHERE schedule_id = ? AND due_at > ?)",
    )
      .bind(schedule.id, schedule.id, job.due_at)
      .run();
  }
}
export async function runScheduler(env) {
  const started = Date.now();
  const token = crypto.randomUUID();
  const lock = await env.DB.prepare(
    `INSERT INTO locks(name, token, expires_at) VALUES ('scheduler', ?, ?)
    ON CONFLICT(name) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at WHERE locks.expires_at < ?`,
  )
    .bind(token, started + 180_000, started)
    .run();
  if (!lock.meta.changes) {
    return;
  }
  try {
    await env.DB.prepare(
      "UPDATE schedules SET status = 'cancelled' WHERE status = 'active' AND cancel_requested = 1",
    ).run();
    const { results: schedules } = await env.DB.prepare(
      "SELECT * FROM schedules WHERE status = 'active' ORDER BY target_at LIMIT 3",
    ).all();
    let budget = 6;
    for (const schedule of schedules) {
      let scoped = env;
      if (schedule.studio_id) {
        try {
          scoped = await studioEnvironment(
            env,
            schedule.guild_id,
            schedule.studio_id,
          );
        } catch (error) {
          const message = cleanError(error, env);
          await env.DB.prepare(
            "UPDATE schedules SET status = 'failed', last_error = ? WHERE id = ?",
          )
            .bind(message, schedule.id)
            .run();
          await notify(
            env,
            `studio-${schedule.id}`,
            schedule,
            `${await savedGameLabel(env, schedule.guild_id, schedule.universe_id)}: ${message}`,
          );
          continue;
        }
      }
      let jobs = (
        await env.DB.prepare(
          'SELECT * FROM jobs WHERE schedule_id = ? ORDER BY due_at',
        )
          .bind(schedule.id)
          .all()
      ).results;
      const due = latestDue(jobs, Date.now());
      if (due) {
        await env.DB.prepare(
          "UPDATE jobs SET state = 'skipped' WHERE schedule_id = ? AND due_at < ? AND state NOT IN ('applied', 'applying', 'skipped')",
        )
          .bind(schedule.id, due.due_at)
          .run();
      }
      // Settle already submitted PATCH operations before issuing another update.
      const applying = jobs.find((j) => j.state === 'applying');
      const candidate = applying || (due?.state === 'ready' ? due : null);
      if (candidate && candidate.next_attempt <= Date.now() && budget > 0) {
        try {
          await applyJob(scoped, schedule, candidate, Date.now());
        } catch (error) {
          await handleFailure(scoped, schedule, candidate, error, Date.now());
        }
        budget -= 2;
      }
      jobs = (
        await env.DB.prepare(
          'SELECT * FROM jobs WHERE schedule_id = ? ORDER BY due_at',
        )
          .bind(schedule.id)
          .all()
      ).results;
      for (const job of jobs) {
        if (budget <= 0 || Date.now() - started > 45_000) {
          break;
        }
        if (
          !['pending', 'rendered', 'uploading', 'moderating'].includes(
            job.state,
          ) ||
          job.next_attempt > Date.now()
        ) {
          continue;
        }
        try {
          await prepareJob(scoped, schedule, job, Date.now());
        } catch (error) {
          await handleFailure(scoped, schedule, job, error, Date.now());
        }
        budget--;
      }
    }
    await flushNotifications(env);
    await env.DB.prepare('DELETE FROM panels WHERE expires_at < ?')
      .bind(Date.now())
      .run();
    await env.DB.prepare('DELETE FROM interactions WHERE created_at < ?')
      .bind(Date.now() - 86400_000)
      .run();
  } finally {
    await env.DB.prepare(
      "DELETE FROM locks WHERE name = 'scheduler' AND token = ?",
    )
      .bind(token)
      .run();
  }
}
