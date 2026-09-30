import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/classroom-queue-generation', () => ({ runClassroomQueueTask: vi.fn() }));
vi.mock('@/lib/server/classroom-job-store', () => ({
  readClassroomGenerationJob: vi.fn(),
  updateClassroomGenerationJob: vi.fn(),
  markClassroomGenerationJobFailed: vi.fn(),
}));
vi.mock('@/app/api/generate/tts/route', () => ({ POST: vi.fn() }));
vi.mock('@/lib/server/classroom-storage', () => ({
  publishClassroomReadView: vi.fn(),
  readClassroom: vi.fn(),
  runWithClassroomBucket: vi.fn(async (_bucket, run) => run()),
}));

import generator from '@/workers/classroom-generator';
import { POST as tts } from '@/app/api/generate/tts/route';
import { publishClassroomReadView, readClassroom } from '@/lib/server/classroom-storage';
import { runClassroomQueueTask } from '@/lib/server/classroom-queue-generation';
import {
  readClassroomGenerationJob,
  updateClassroomGenerationJob,
  markClassroomGenerationJobFailed,
} from '@/lib/server/classroom-job-store';

describe('Queue generation task boundaries', () => {
  const bucket = { get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn() };
  const env = { CLASSROOM_BUCKET: bucket, CLASSROOM_QUEUE: { send: vi.fn() } };
  const delivery = <T>(body: T, attempts = 1) => ({ body, attempts, ack: vi.fn(), retry: vi.fn() });
  beforeEach(() => vi.resetAllMocks());

  it('generates one TTS result in Queue, preserving the API body and status', async () => {
    vi.mocked(tts).mockResolvedValue(
      Response.json({ success: false, errorCode: 'RATE_LIMITED' }, { status: 429 }),
    );
    await generator.queue(
      { messages: [delivery({ kind: 'tts', jobId: 'tts123', body: '{"text":"hello"}' })] },
      env,
    );
    expect(await vi.mocked(tts).mock.calls[0][0].json()).toEqual({ text: 'hello' });
    expect(bucket.put).toHaveBeenCalledWith(
      'tts-jobs/tts123.json',
      expect.stringContaining('RATE_LIMITED'),
      { customMetadata: { status: '429' } },
    );
    expect(runClassroomQueueTask).not.toHaveBeenCalled();
  });

  it('reuses a completed TTS result on redelivery', async () => {
    bucket.head.mockResolvedValue({ size: 123 });
    await generator.queue(
      { messages: [delivery({ kind: 'tts', jobId: 'tts123', body: '{}' })] },
      env,
    );
    expect(tts).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('publishes legacy classrooms off the HTTP path', async () => {
    vi.mocked(readClassroom).mockResolvedValue({
      id: 'course123',
      stage: {} as never,
      scenes: [],
      createdAt: '2026-09-30T00:00:00Z',
    });
    await generator.queue(
      { messages: [delivery({ kind: 'publish-classroom', classroomId: 'course123' })] },
      env,
    );
    expect(publishClassroomReadView).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'course123' }),
    );
  });

  it('acknowledges a committed scene task', async () => {
    const message = delivery({
      kind: 'classroom-step' as const,
      jobId: 'job1',
      phase: 'scene' as const,
      index: 5,
    });
    await generator.queue({ messages: [message] }, env);
    expect(runClassroomQueueTask).toHaveBeenCalledWith(message.body, bucket, env.CLASSROOM_QUEUE);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries only the failed task and surfaces terminal failure after three attempts', async () => {
    vi.mocked(runClassroomQueueTask).mockRejectedValue(new Error('clip unavailable'));
    vi.mocked(readClassroomGenerationJob).mockResolvedValue({ status: 'running' } as never);
    const body = {
      kind: 'classroom-step' as const,
      jobId: 'job1',
      phase: 'tts' as const,
      index: 12,
    };
    const first = delivery(body);
    await generator.queue({ messages: [first] }, env);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(updateClassroomGenerationJob).toHaveBeenCalledWith('job1', {
      message: expect.stringContaining('重试'),
    });
    const last = delivery(body, 3);
    await generator.queue({ messages: [last] }, env);
    expect(markClassroomGenerationJobFailed).toHaveBeenCalledWith('job1', 'clip unavailable');
    expect(last.ack).toHaveBeenCalledOnce();
    expect(last.retry).not.toHaveBeenCalled();
  });
});
