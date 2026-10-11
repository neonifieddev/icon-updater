import { assetId } from './core.js';

const API = 'https://apis.roblox.com';

export async function roblox(
  env,
  path,
  { method = 'GET', request, file } = {},
) {
  let body;

  if (request) {
    body = new FormData();
    body.set('request', JSON.stringify(request));

    if (file) {
      body.set('fileContent', file, 'icon.png');
    }
  }

  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-api-key': env.ROBLOX_API_KEY },
    body,
    signal: AbortSignal.timeout(12_000),
    redirect: 'manual',
  });

  if (!response.ok) {
    throw new Error(
      `Roblox returned ${response.status}. ${[401, 403].includes(response.status) ? 'Check the studio key’s permissions and access to this experience.' : 'Check the experience ID or try again shortly.'}`,
    );
  }

  const text = await response.text();

  return text ? JSON.parse(text) : {};
}

export async function pollOperation(env, path) {
  if (!/^operations\/[a-zA-Z0-9_-]+$/.test(path)) {
    throw new Error('Invalid Roblox operation path.');
  }

  const result = await roblox(env, `/assets/v1/${path}`);

  if (result.error) {
    throw new Error(`Roblox operation failed: ${result.error.message}`);
  }

  return result.done ? result.response || {} : null;
}

export function operationPath(result) {
  if (result.error) {
    throw new Error(`Roblox operation failed: ${result.error.message}`);
  }

  if (result.path?.startsWith('operations/')) {
    return result.path;
  }

  return null;
}

export async function getPlace(env, universe) {
  // Explicit mappings support private experiences whose public lookup returns zero IDs.
  const configured = JSON.parse(env.UNIVERSE_ROOT_PLACES || '{}')[universe];
  let placeId = configured;

  if (!placeId) {
    const details = await roblox(env, `/cloud/v2/universes/${universe}`);

    placeId = String(details.rootPlace || '').match(
      /(?:^|\/)places\/(\d+)$/,
    )?.[1];

    if (!placeId) {
      throw new Error(
        'Could not find the root place. Check the universe ID and give this key permission to read the universe.',
      );
    }
  }

  if (!/^[1-9]\d*$/.test(String(placeId))) {
    throw new Error('Invalid root place mapping.');
  }

  const [asset, metadata, icons] = await Promise.all([
    roblox(env, `/assets/v1/assets/${placeId}`),
    roblox(env, `/assets/v1/assets/${placeId}?readMask=icon`),
    roblox(
      env,
      `/legacy-game-internationalization/v1/game-icon/games/${universe}`,
    ),
  ]);

  if (asset.assetType !== 'Place' && asset.assetType !== 'ASSET_TYPE_PLACE') {
    throw new Error('Root asset is not a Place.');
  }

  const owner = asset.creationContext?.creator;
  let creator = null;

  if (owner?.groupId) {
    creator = { groupId: String(owner.groupId) };
  } else if (owner?.userId) {
    creator = { userId: String(owner.userId) };
  }

  if (!creator) {
    throw new Error('Could not determine the place owner.');
  }

  // Fail visibly rather than silently claiming a public update under a localized override.
  // Even an override pointing at today's main image will become stale on the next update.
  const entries = icons.data || [];
  const overrides =
    entries.length > 1
      ? entries
      : entries.filter((x) => `assets/${x.imageId}` !== metadata.icon);

  if (overrides.length) {
    throw new Error(
      `Localized icon overrides exist (${overrides.map((x) => x.languageCode).join(', ')}). Remove them in Creator Dashboard before scheduling.`,
    );
  }

  return {
    placeId: String(placeId),
    creator,
    previousIcon: metadata.icon || null,
  };
}

export async function uploadImage(env, creator, blob, label) {
  const result = await roblox(env, '/assets/v1/assets', {
    method: 'POST',
    file: blob,
    request: {
      assetType: 'Image',
      displayName: `Countdown ${label}`,
      description: 'Experience countdown icon',
      creationContext: { creator, expectedPrice: 0 },
    },
  });
  const operation = operationPath(result);

  return operation
    ? { operation }
    : { imageId: assetId(result.response || result) };
}

export function patchIcon(env, placeId, imageId) {
  return roblox(env, `/assets/v1/assets/${placeId}?updateMask=icon`, {
    method: 'PATCH',
    request: { assetId: placeId, icon: `assets/${imageId}` },
  });
}
