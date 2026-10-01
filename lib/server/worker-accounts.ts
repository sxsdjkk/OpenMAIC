import type { ClassroomBucket } from './classroom-storage';
import type { Stage, Scene } from '@/lib/types/stage';
import type { StageListItem } from '@/lib/utils/stage-storage';
import type { PlaybackCursor } from '@/lib/playback/cursor';
import type { GeneratorEnv } from '@/workers/generator-env';

export type AccountBucket = ClassroomBucket & Pick<GeneratorEnv['CLASSROOM_BUCKET'], 'list'>;
const ownerKey = (id: string) => `course-owners/${id}.json`;
const progressKey = (ownerId: string, id: string) => `accounts/${ownerId}/progress/${id}.json`;

export async function ownsCourse(bucket: ClassroomBucket, ownerId: string, id: string) {
  return (await bucket.head(ownerKey(id)))?.customMetadata?.ownerId === ownerId;
}

/** Immutable ownership: retries may link the same owner, never a different account. */
export async function claimCourse(bucket: ClassroomBucket, ownerId: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(ownerId) || !/^[\w-]{1,64}$/.test(id))
    throw new Error('Invalid account or course id');
  const created = await bucket.put(ownerKey(id), JSON.stringify({ ownerId, classroomId: id }), {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
    customMetadata: { ownerId },
  });
  if (!created && !(await ownsCourse(bucket, ownerId, id)))
    throw new Error('Course already belongs to another account');
}

export async function registerCourse(
  bucket: ClassroomBucket,
  ownerId: string,
  classroom: { id: string; stage: Stage; scenes: readonly Scene[]; createdAt: string },
) {
  await claimCourse(bucket, ownerId, classroom.id);
  const summary: StageListItem = {
    id: classroom.id,
    // R2 custom metadata is bounded; large descriptions stay in the course itself.
    name: (classroom.stage.name || 'Untitled course').slice(0, 120),
    description: classroom.stage.description?.slice(0, 200),
    sceneCount: classroom.scenes.length,
    createdAt: classroom.stage.createdAt || Date.parse(classroom.createdAt),
    updatedAt: classroom.stage.updatedAt || Date.parse(classroom.createdAt),
  };
  const serialized = JSON.stringify(summary);
  await bucket.put(`accounts/${ownerId}/courses/${classroom.id}.json`, serialized, {
    customMetadata: { course: serialized },
  });
}

export async function listAccountCourses(bucket: AccountBucket, ownerId: string, cursor?: string) {
  const page = await bucket.list({
    prefix: `accounts/${ownerId}/courses/`,
    limit: 100,
    include: ['customMetadata'],
    ...(cursor ? { cursor } : {}),
  });
  return {
    courses: page.objects.flatMap((object) => {
      const summary = object.customMetadata?.course;
      return summary ? [JSON.parse(summary) as StageListItem] : [];
    }),
    cursor: page.truncated ? page.cursor : null,
  };
}

export function validProgress(value: unknown): value is PlaybackCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as PlaybackCursor;
  return (
    typeof cursor.sceneId === 'string' &&
    cursor.sceneId.length > 0 &&
    cursor.sceneId.length <= 128 &&
    Number.isInteger(cursor.actionIndex) &&
    cursor.actionIndex >= 0 &&
    cursor.actionIndex <= 100000 &&
    typeof cursor.updatedAt === 'string' &&
    Number.isFinite(Date.parse(cursor.updatedAt)) &&
    Date.parse(cursor.updatedAt) <= Date.now() + 300000
  );
}

export async function readProgress(bucket: ClassroomBucket, ownerId: string, id: string) {
  const object = await bucket.get(progressKey(ownerId, id));
  return object ? (JSON.parse(await object.text()) as PlaybackCursor) : null;
}

export async function writeProgress(
  bucket: ClassroomBucket,
  ownerId: string,
  id: string,
  cursor: PlaybackCursor,
  onlyIfAbsent = false,
) {
  const key = progressKey(ownerId, id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const object = await bucket.get(key);
    const previous = object ? (JSON.parse(await object.text()) as PlaybackCursor) : null;
    if (
      previous &&
      (onlyIfAbsent || Date.parse(previous.updatedAt) >= Date.parse(cursor.updatedAt))
    )
      return previous;
    const saved = await bucket.put(key, JSON.stringify(cursor), {
      onlyIf: new Headers(object ? { 'If-Match': `"${object.etag}"` } : { 'If-None-Match': '*' }),
    });
    if (saved) return cursor;
  }
  throw new Error('Progress changed concurrently; retry');
}

export async function deleteProgress(bucket: ClassroomBucket, ownerId: string, id: string) {
  await bucket.delete(progressKey(ownerId, id));
}
