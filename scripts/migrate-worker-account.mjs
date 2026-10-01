import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Explicit target from /account in the authenticated browser. No automatic "first login" claims.
const [mode, ownerId, manifestPath] = process.argv.slice(2);
if (
  !['inspect', 'enqueue', 'verify', 'index-jobs'].includes(mode) ||
  !/^[a-f0-9]{64}$/.test(ownerId || '') ||
  !manifestPath
)
  throw new Error(
    'Usage: node scripts/migrate-worker-account.mjs inspect|enqueue|verify|index-jobs ACCOUNT_ID MANIFEST_PATH',
  );
const token = readFileSync(
  '/Users/keke/Library/Preferences/.wrangler/config/default.toml',
  'utf8',
).match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) throw new Error('Wrangler login required');
const account = 'aa58fc76eac27f83586a94e561b28632';
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const bucket = '/r2/buckets/ai-learning-agent-classrooms/objects';
async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloudflare API failed (${response.status}): ${path}`);
  return response;
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const objectPath = (key) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
async function raw(key) {
  return (await api(objectPath(key)))?.text() ?? null;
}
async function list(prefix) {
  const entries = [];
  let cursor;
  do {
    const params = new URLSearchParams({
      prefix,
      delimiter: '/',
      per_page: '1000',
      ...(cursor ? { cursor } : {}),
    });
    const json = await (await api(`${bucket}?${params}`)).json();
    if (!json.success) throw new Error('R2 listing failed');
    entries.push(...json.result);
    const info = json.result_info || {};
    cursor = info.is_truncated || info.truncated ? info.cursor : undefined;
    if ((info.is_truncated || info.truncated) && !cursor)
      throw new Error('R2 pagination cursor missing');
  } while (cursor);
  return entries;
}

if (mode === 'inspect') {
  const records = [];
  for (const prefix of ['classrooms/', 'jobs/']) {
    for (const entry of await list(prefix)) {
      const match = new RegExp(`^${prefix}([\\w-]{1,64})\\.json$`).exec(entry.key);
      if (!match) continue;
      const value = await raw(entry.key);
      const parsed = JSON.parse(value);
      const course = prefix === 'classrooms/';
      const ownership = course
        ? JSON.parse((await raw(`course-owners/${match[1]}.json`)) || 'null')
        : parsed;
      const existingOwner = ownership?.ownerId;
      records.push({
        key: entry.key,
        id: match[1],
        type: course ? 'course' : 'job',
        sha256: hash(value),
        eligible: !existingOwner || existingOwner === ownerId,
        status: course ? (parsed.reserved ? 'reserved' : 'complete') : parsed.status,
        scenes: course ? parsed.scenes.length : undefined,
        existingOwner,
      });
    }
  }
  writeFileSync(
    manifestPath,
    JSON.stringify({ ownerId, inspectedAt: new Date().toISOString(), records }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      manifestPath,
      courses: records.filter((r) => r.type === 'course'),
      jobs: records
        .filter((r) => r.type === 'job')
        .map(({ id, status, eligible }) => ({ id, status, eligible })),
    }),
  );
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.ownerId !== ownerId) throw new Error('Manifest account mismatch');
  const records = manifest.records.filter(
    (r) => r.eligible && (mode !== 'index-jobs' || r.type === 'job'),
  );
  if (mode === 'enqueue' || mode === 'index-jobs') {
    const queues = await (await api('/queues?per_page=100')).json();
    const queue = queues.result.find((q) => q.queue_name === 'ai-learning-agent-generation');
    if (!queue) throw new Error('Existing classroom Queue not found');
    for (const record of records) {
      const body = {
        kind: mode === 'index-jobs' ? 'index-account-job' : 'link-legacy-account',
        ownerId,
        [record.type === 'course' ? 'classroomId' : 'jobId']: record.id,
      };
      const result = await (
        await api(`/queues/${queue.queue_id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body, content_type: 'json' }),
        })
      ).json();
      if (!result.success) throw new Error('Queue rejected migration message');
    }
    console.log(JSON.stringify({ enqueued: records.length }));
  } else {
    const results = [];
    for (const record of records) {
      const receipt = await raw(`account-migrations/${ownerId}/${record.type}-${record.id}.json`);
      const value = await raw(record.key);
      const parsed = JSON.parse(value);
      const backup =
        record.type === 'job' && !record.existingOwner
          ? await raw(`account-migrations/${ownerId}/backups/${record.id}.json`)
          : value;
      const preserved = hash(backup ?? value) === record.sha256;
      const actualOwner =
        record.type === 'course'
          ? JSON.parse((await raw(`course-owners/${record.id}.json`)) || 'null')?.ownerId
          : parsed.ownerId;
      const catalogRequired =
        record.type === 'course' && record.status === 'complete' && record.scenes > 0;
      const catalog = catalogRequired
        ? await raw(`accounts/${ownerId}/courses/${record.id}.json`)
        : null;
      results.push({
        id: record.id,
        type: record.type,
        linked: actualOwner === ownerId,
        receipt: Boolean(receipt),
        preserved,
        catalog: Boolean(catalog),
        catalogRequired,
      });
    }
    const ok = results.every(
      (r) => r.linked && r.receipt && r.preserved && (!r.catalogRequired || r.catalog),
    );
    console.log(JSON.stringify({ ok, results }));
    if (!ok) process.exitCode = 1;
  }
}
