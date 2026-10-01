import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const localEnv = path.join(root, '.env.local');
const backup = path.join(root, '.env.local.workers-backup');

if (existsSync(backup)) {
  throw new Error(
    'A previous Workers build left .env.local.workers-backup; restore it before rebuilding',
  );
}

const localVariables = existsSync(localEnv)
  ? [...readFileSync(localEnv, 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)]
  : [];
const buildEnv = { ...process.env };
for (const [, key] of localVariables) delete buildEnv[key];
for (const key of Object.keys(buildEnv)) {
  if (/(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)$/.test(key)) delete buildEnv[key];
}
buildEnv.CLOUDFLARE_WORKERS = '1';
buildEnv.NEXT_PUBLIC_WORKERS_ACCOUNT = '1';

function run(binary, args) {
  const result = spawnSync(path.join(root, 'node_modules', '.bin', binary), args, {
    cwd: root,
    env: buildEnv,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed with exit code ${result.status}`);
}

let moved = false;
try {
  if (existsSync(localEnv)) {
    renameSync(localEnv, backup);
    moved = true;
  }
  run('next', ['build', '--webpack']);
  run('opennextjs-cloudflare', ['build', '--skipNextBuild']);
  const pages = path.join(root, '.open-next/assets/__worker-pages');
  mkdirSync(pages, { recursive: true });
  for (const page of ['index', 'learn', 'worker-classroom', 'worker-generation']) {
    for (const extension of ['html', 'rsc']) {
      copyFileSync(
        path.join(root, `.next/server/app/${page}.${extension}`),
        path.join(pages, `${page}.${extension}`),
      );
    }
  }
} finally {
  if (moved) renameSync(backup, localEnv);
}

const bundle = [
  '.open-next/cloudflare/next-env.mjs',
  '.open-next/server-functions/default/handler.mjs',
  '.open-next/middleware/handler.mjs',
]
  .map((file) => readFileSync(path.join(root, file), 'utf8'))
  .join('\n');
const leakedKeys = localVariables
  .filter(([, key, rawValue]) => {
    if (!/(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)$/.test(key)) return false;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
    return value.length >= 12 && bundle.includes(value);
  })
  .map(([, key]) => key);
if (leakedKeys.length) {
  throw new Error(`Workers bundle contains local secret values for: ${leakedKeys.join(', ')}`);
}
