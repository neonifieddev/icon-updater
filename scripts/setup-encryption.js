import { readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const path = new URL('../.dev.vars', import.meta.url);
const contents = readFileSync(path, 'utf8');
let key = contents
  .match(/^STUDIO_ENCRYPTION_KEY=(.+)$/m)?.[1]
  ?.trim()
  .replace(/^"|"$/g, '');

if (!key) {
  key = randomBytes(32).toString('base64');
  appendFileSync(path, `\nSTUDIO_ENCRYPTION_KEY=${key}\n`);
  console.log('Encryption key created in .dev.vars. Keep a secure backup.');
}

if (Buffer.from(key, 'base64').length !== 32) {
  throw new Error('Invalid encryption key length.');
}

if (process.argv.includes('--upload')) {
  const result = spawnSync(
    process.execPath,
    ['--use-system-ca', 'scripts/wrangler.js', 'secret', 'bulk'],
    {
      input: JSON.stringify({ STUDIO_ENCRYPTION_KEY: key }),
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    },
  );

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
}
