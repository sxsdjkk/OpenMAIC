import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimCourse,
  ownsCourse,
  registerCourse,
  listAccountCourses,
  readProgress,
  writeProgress,
  type AccountBucket,
} from '@/lib/server/worker-accounts';
import { linkLegacyAccount } from '@/lib/server/worker-account-migration';
import type { PersistedClassroomData } from '@/lib/server/classroom-storage';

describe('R2 learning accounts', () => {
  const owner = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const objects = new Map<
    string,
    { value: string; etag: string; customMetadata?: Record<string, string> }
  >();
  let revision = 0;
  const bucket = {
    async head(key: string) {
      const object = objects.get(key);
      return object ? { size: object.value.length, customMetadata: object.customMetadata } : null;
    },
    async get(key: string) {
      const object = objects.get(key);
      return object
        ? { ...object, text: async () => object.value, body: new Response(object.value).body! }
        : null;
    },
    async put(
      key: string,
      value: string | Uint8Array,
      options?: { onlyIf?: Headers; customMetadata?: Record<string, string> },
    ) {
      const previous = objects.get(key);
      if (options?.onlyIf?.get('if-none-match') === '*' && previous) return null;
      if (
        options?.onlyIf?.has('if-match') &&
        options.onlyIf.get('if-match')?.replaceAll('"', '') !== previous?.etag
      )
        return null;
      const object = {
        value: String(value),
        etag: String(++revision),
        customMetadata: options?.customMetadata,
      };
      objects.set(key, object);
      return object;
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options: { prefix: string; cursor?: string }) {
      return {
        objects: [...objects]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, object]) => ({ key, customMetadata: object.customMetadata })),
        truncated: false,
      };
    },
  } as AccountBucket;
  const course = {
    id: 'course1',
    stage: { id: 'course1', name: '旧课程', createdAt: 10, updatedAt: 20 },
    scenes: [{ id: 'scene1' }],
    createdAt: new Date(10).toISOString(),
  } as PersistedClassroomData;

  beforeEach(() => {
    objects.clear();
    revision = 0;
  });

  it('claims immutable ownership idempotently without letting another account steal it', async () => {
    await claimCourse(bucket, owner, course.id);
    await claimCourse(bucket, owner, course.id);
    expect(await ownsCourse(bucket, owner, course.id)).toBe(true);
    expect(await ownsCourse(bucket, other, course.id)).toBe(false);
    await expect(claimCourse(bucket, other, course.id)).rejects.toThrow('another account');
  });

  it('lists only the account prefix, with bounded multilingual metadata', async () => {
    await registerCourse(bucket, owner, {
      ...course,
      stage: { ...course.stage, name: '中文🚀'.repeat(500), description: '说明🚀'.repeat(500) },
    });
    const catalog = await listAccountCourses(bucket, owner);
    expect(catalog.courses).toHaveLength(1);
    expect(catalog.courses[0].sceneCount).toBe(1);
    expect((await listAccountCourses(bucket, other)).courses).toEqual([]);
    const metadata = objects.get(`accounts/${owner}/courses/course1.json`)!.customMetadata!;
    expect(new TextEncoder().encode(JSON.stringify(metadata)).byteLength).toBeLessThan(2048);
  });

  it('preserves newer cloud progress against stale device and migration writes', async () => {
    const recent = { sceneId: 'scene1', actionIndex: 5, updatedAt: new Date().toISOString() };
    await writeProgress(bucket, owner, course.id, recent);
    const old = {
      ...recent,
      actionIndex: 1,
      updatedAt: new Date(Date.now() - 60000).toISOString(),
    };
    expect(await writeProgress(bucket, owner, course.id, old)).toEqual(recent);
    expect(
      await writeProgress(bucket, owner, course.id, { ...recent, actionIndex: 8 }, true),
    ).toEqual(recent);
    expect(await readProgress(bucket, other, course.id)).toBeNull();
  });

  it('migrates complete and reserved courses without changing course bytes', async () => {
    const raw = JSON.stringify(course);
    await bucket.put('classrooms/course1.json', raw);
    const task = { kind: 'link-legacy-account' as const, ownerId: owner, classroomId: course.id };
    await linkLegacyAccount(bucket, task);
    await linkLegacyAccount(bucket, task);
    expect(objects.get('classrooms/course1.json')!.value).toBe(raw);
    expect((await listAccountCourses(bucket, owner)).courses).toHaveLength(1);
    await bucket.put(
      'classrooms/reserved.json',
      JSON.stringify({ ...course, id: 'reserved', reserved: true, scenes: [] }),
    );
    await linkLegacyAccount(bucket, { ...task, classroomId: 'reserved' });
    expect(await ownsCourse(bucket, owner, 'reserved')).toBe(true);
    expect((await listAccountCourses(bucket, owner)).courses).toHaveLength(1);
  });

  it('backs up old job state and preserves failures, checkpoints and foreign ownership', async () => {
    const raw = JSON.stringify({ id: 'job1', status: 'failed', progress: 91, error: '429 quota' });
    await bucket.put('jobs/job1.json', raw);
    await bucket.put('jobs/job1/checkpoint.json', 'original checkpoint');
    await linkLegacyAccount(bucket, { kind: 'link-legacy-account', ownerId: owner, jobId: 'job1' });
    expect(objects.get(`account-migrations/${owner}/backups/job1.json`)!.value).toBe(raw);
    expect(JSON.parse(objects.get('jobs/job1.json')!.value)).toEqual({
      ...JSON.parse(raw),
      ownerId: owner,
    });
    expect(objects.get('jobs/job1/checkpoint.json')!.value).toBe('original checkpoint');
    await expect(
      linkLegacyAccount(bucket, { kind: 'link-legacy-account', ownerId: other, jobId: 'job1' }),
    ).rejects.toThrow('another account');
  });
});
