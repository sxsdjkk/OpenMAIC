import type { ClassroomGenerationJob } from './classroom-job-store';
import type { AccountBucket } from './worker-accounts';
import type { ClassroomBucket } from './classroom-storage';
import {
  isGenerationJobStale,
  STALE_GENERATION_ERROR,
  type GenerationJobSummary,
} from '@/lib/classroom/generation-job';

export async function canRetryGenerationJob(bucket: ClassroomBucket, id: string) {
  return Boolean(
    (await bucket.head(`jobs/${id}/checkpoint.json`)) ||
    (await bucket.head(`jobs/${id}/input.json`)),
  );
}

export async function indexGenerationJob(bucket: ClassroomBucket, job: ClassroomGenerationJob) {
  if (!job.ownerId) return;
  const summary: GenerationJobSummary = {
    id: job.id,
    name: (job.inputSummary?.requirementPreview || '课程生成').slice(0, 120),
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    scenesGenerated: job.scenesGenerated,
    totalScenes: job.totalScenes,
    ttsGenerated: job.ttsGenerated,
    totalTts: job.totalTts,
    error: job.error?.slice(0, 160),
    canRetry: job.retryable ?? (await canRetryGenerationJob(bucket, job.id)),
  };
  const value = JSON.stringify(summary);
  await bucket.put(`accounts/${job.ownerId}/jobs/${job.id}.json`, value, {
    customMetadata: { job: value },
  });
}

export async function listGenerationJobs(bucket: AccountBucket, ownerId: string, cursor?: string) {
  const page = await bucket.list({
    prefix: `accounts/${ownerId}/jobs/`,
    include: ['customMetadata'],
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  const jobs = page.objects.flatMap((object) => {
    if (!object.customMetadata?.job) return [];
    const job = JSON.parse(object.customMetadata.job) as GenerationJobSummary;
    if (job.status === 'succeeded') return [];
    return [
      isGenerationJobStale(job)
        ? { ...job, status: 'failed' as const, error: STALE_GENERATION_ERROR }
        : job,
    ];
  });
  return { jobs, cursor: page.truncated ? page.cursor : null };
}

/** Explicit admin backfill: index only records already owned by this account. */
export async function indexAccountJob(bucket: ClassroomBucket, ownerId: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(ownerId) || !/^[\w-]{1,64}$/.test(id))
    throw new Error('Invalid account job');
  const object = await bucket.get(`jobs/${id}.json`);
  if (!object) throw new Error('Job not found');
  const job = JSON.parse(await object.text()) as ClassroomGenerationJob;
  if (job.ownerId !== ownerId) throw new Error('Job belongs to another account');
  await indexGenerationJob(bucket, job);
}
