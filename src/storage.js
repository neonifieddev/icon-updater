// KV stores immutable image bytes; D1 remains the source of truth for scheduling.
// A newly written key may take time to become visible in another region.
// Scheduler retries cover this propagation delay without treating it as data loss.
export async function putFile(env, key, blob) {
  await env.FILES.put(key, blob.stream());
}

export async function getFile(env, key) {
  const stream = await env.FILES.get(key, { type: 'stream' });

  if (!stream) {
    return null;
  }

  return {
    body: stream,
    arrayBuffer: () => new Response(stream).arrayBuffer(),
  };
}
