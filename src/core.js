export const STAGES = [
  ['24h', 1440],
  ['12h', 720],
  ['6h', 360],
  ['3h', 180],
  ['2h', 120],
  ['1h', 60],
  ['30m', 30],
  ['15m', 15],
  ['NOW', 0],
];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function ids(value = '') {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function authorize(interaction, env) {
  if (!ids(env.ALLOWED_GUILD_IDS).includes(interaction.guild_id)) {
    return false;
  }

  const member = interaction.member;

  if (!member?.user?.id) {
    return false;
  }

  if (ids(env.ALLOWED_USER_IDS).includes(member.user.id)) {
    return true;
  }

  try {
    return (
      env.ALLOW_SERVER_ADMINS === 'true' &&
      (BigInt(member.permissions || 0) & 8n) !== 0n
    );
  } catch {
    return false;
  }
}

export function universeAllowed(id, env) {
  if (
    !/^[1-9]\d{0,19}$/.test(id || '') ||
    !ids(env.ALLOWED_UNIVERSE_IDS).includes(id)
  ) {
    throw new Error('This universe is not in ALLOWED_UNIVERSE_IDS.');
  }
}

export function parseTarget(value, now = Date.now()) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value || '',
    )
  ) {
    throw new Error(
      'Use an ISO date with timezone, e.g. 2026-10-10T18:00:00+02:00.',
    );
  }

  const result = Date.parse(value);
  const day = Number(value.slice(8, 10));
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));

  if (
    !Number.isFinite(result) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(value.slice(11, 13)) > 23
  ) {
    throw new Error('Invalid target date.');
  }

  if (result < now + 15 * 60_000) {
    throw new Error(
      'Schedule at least 15 minutes ahead to allow image preparation and moderation.',
    );
  }

  if (result > now + 366 * 86400_000) {
    throw new Error('Schedule within the next year.');
  }

  return result;
}

export function stagesFor(target, now) {
  const stages = STAGES.map(([stage, minutes]) => ({
    stage,
    due_at: target - minutes * 60_000,
  }));
  const current = stages.filter((x) => x.due_at <= now).at(-1);

  return stages.filter((x) => x.due_at > now || x === current);
}

export function latestDue(jobs, now) {
  return jobs
    .filter((j) => j.due_at <= now)
    .sort((a, b) => b.due_at - a.due_at)[0];
}

export function retryDelay(attempt) {
  return Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

export function cleanError(error, env = {}) {
  let message = String(error?.message || 'Unknown error');

  for (const secret of [
    env.ROBLOX_API_KEY,
    env.DISCORD_TOKEN,
    env.STUDIO_ENCRYPTION_KEY,
  ]) {
    if (secret) {
      message = message.split(secret).join('[redacted]');
    }
  }

  return message.replace(/https:\/\/[^\s]+/g, '[URL]').slice(0, 500);
}

export function assetId(asset) {
  const id = String(
    asset?.assetId || asset?.path?.match(/^assets\/(\d+)$/)?.[1] || '',
  );

  if (!/^[1-9]\d*$/.test(id)) {
    throw new Error('Roblox did not return a valid image asset ID.');
  }

  return id;
}
