import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = new URL('../wrangler.local.jsonc', import.meta.url);
const args = process.argv.slice(2);
const explicitConfig = args.some(
  (arg) => arg === '--config' || arg === '-c' || arg.startsWith('--config='),
);
if (!explicitConfig) {
  args.push(
    '--config',
    existsSync(local) ? 'wrangler.local.jsonc' : 'wrangler.jsonc',
  );
}

const result = spawnSync(
  process.execPath,
  ['--use-system-ca', 'node_modules/wrangler/bin/wrangler.js', ...args],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
