import { claimCourse, registerCourse } from './worker-accounts';
import type { ClassroomBucket, PersistedClassroomData } from './classroom-storage';
import type { ClassroomGenerationJob } from './classroom-job-store';

/** Admin-only Queue messages. There is deliberately no public claim/migration endpoint. */
export interface LegacyAccountTask {
  kind: 'link-legacy-account';
  ownerId: string;
  classroomId?: string;
  jobId?: string;
}

export async function linkLegacyAccount(bucket: ClassroomBucket, task: LegacyAccountTask) {
  if (
    !/^[a-f0-9]{64}$/.test(task.ownerId) ||
    !/^[\w-]{1,64}$/.test(task.classroomId || task.jobId || '') ||
    Boolean(task.classroomId) === Boolean(task.jobId)
  )
    throw new Error('Invalid migration task');
  const receiptKey = `account-migrations/${task.ownerId}/${task.classroomId ? 'course' : 'job'}-${task.classroomId || task.jobId}.json`;
  if (await bucket.head(receiptKey)) return;
  if (task.classroomId) {
    const object = await bucket.get(`classrooms/${task.classroomId}.json`);
    if (!object) throw new Error('Legacy course not found');
    const course = JSON.parse(await object.text()) as PersistedClassroomData;
    await claimCourse(bucket, task.ownerId, task.classroomId);
    // Reserved/failed courses remain reserved, with no incomplete catalog entry.
    if (!course.reserved && course.scenes.length)
      await registerCourse(bucket, task.ownerId, course);
  } else {
    const key = `jobs/${task.jobId}.json`;
    const object = await bucket.get(key);
    if (!object) throw new Error('Legacy job not found');
    const raw = await object.text();
    const job = JSON.parse(raw) as ClassroomGenerationJob;
    if (job.ownerId && job.ownerId !== task.ownerId)
      throw new Error('Job belongs to another account');
    if (!job.ownerId) {
      // Preserve the exact old record, and never overwrite a concurrently updated job.
      await bucket.put(`account-migrations/${task.ownerId}/backups/${task.jobId}.json`, raw, {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
      });
      const updated = await bucket.put(key, JSON.stringify({ ...job, ownerId: task.ownerId }), {
        onlyIf: new Headers({ 'If-Match': `"${object.etag}"` }),
      });
      if (!updated) throw new Error('Job changed concurrently; retry migration');
    }
  }
  await bucket.put(receiptKey, JSON.stringify({ ...task, linkedAt: new Date().toISOString() }));
}
