import { MAX_IMAGE_BYTES } from './core.js';
export async function readLimited(response, limit = MAX_IMAGE_BYTES) {
  if (!response.ok || !response.body) {
    throw new Error(
      'Could not download the Discord image. Upload the attachment again.',
    );
  }
  if (Number(response.headers.get('content-length')) > limit) {
    throw new Error('Image exceeds 5 MB.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Image exceeds 5 MB.');
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}
export async function attachmentImage(env, attachment, overlay = false) {
  if (!attachment || attachment.size > MAX_IMAGE_BYTES) {
    throw new Error('Attach an image no larger than 5 MB.');
  }
  const url = new URL(attachment.url);
  if (
    url.protocol !== 'https:' ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !/^\/(?:attachments|ephemeral-attachments)\//.test(url.pathname)
  ) {
    throw new Error('Only Discord image attachments are accepted.');
  }
  const blob = await readLimited(
    await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }),
  );
  const info = await env.IMAGES.info(blob.stream());
  const format = String(info.format).toLowerCase().replace('image/', '');
  if (!(overlay ? ['png'] : ['png', 'jpeg', 'jpg']).includes(format)) {
    throw new Error(
      overlay
        ? 'Overlays must be transparent PNG files.'
        : 'Use a PNG or JPEG icon.',
    );
  }
  if (!info.width || info.width !== info.height || info.width > 2048) {
    throw new Error('Use a square image, at most 2048 x 2048 pixels.');
  }
  return blob;
}
export async function compose(env, base, overlay) {
  const result = await env.IMAGES.input(base)
    .transform({ width: 512, height: 512, fit: 'cover' })
    .draw(
      env.IMAGES.input(overlay).transform({
        width: 512,
        height: 512,
        fit: 'cover',
      }),
      {
        top: 0,
        left: 0,
        opacity: 1,
      },
    )
    .output({ format: 'image/png' });
  return result.response().blob();
}
