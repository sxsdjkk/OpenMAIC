import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/classroom-job-runner', () => ({ runClassroomGenerationJob: vi.fn() }));
vi.mock('@/app/api/generate/tts/route', () => ({ POST: vi.fn() }));
vi.mock('@/lib/server/classroom-storage', () => ({
  publishClassroomReadView: vi.fn(),
  readClassroom: vi.fn(),
  runWithClassroomBucket: vi.fn(async (_bucket, run) => run()),
}));

import generator from '@/workers/classroom-generator';
import { POST as tts } from '@/app/api/generate/tts/route';
import { publishClassroomReadView, readClassroom } from '@/lib/server/classroom-storage';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';

describe('Queue generation task boundaries', () => {
  const bucket = { get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn() };
  beforeEach(() => vi.resetAllMocks());

  it('generates one TTS result in Queue, preserving the API body and status', async () => {
    vi.mocked(tts).mockResolvedValue(
      Response.json({ success: false, errorCode: 'RATE_LIMITED' }, { status: 429 }),
    );
    await generator.queue(
      { messages: [{ body: { kind: 'tts', jobId: 'tts123', body: '{"text":"hello"}' } }] },
      { CLASSROOM_BUCKET: bucket },
    );
    expect(await vi.mocked(tts).mock.calls[0][0].json()).toEqual({ text: 'hello' });
    expect(bucket.put).toHaveBeenCalledWith(
      'tts-jobs/tts123.json',
      expect.stringContaining('RATE_LIMITED'),
      { customMetadata: { status: '429' } },
    );
    expect(runClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('reuses a completed TTS result on redelivery', async () => {
    bucket.head.mockResolvedValue({ size: 123 });
    await generator.queue(
      { messages: [{ body: { kind: 'tts', jobId: 'tts123', body: '{}' } }] },
      { CLASSROOM_BUCKET: bucket },
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
      { messages: [{ body: { kind: 'publish-classroom', classroomId: 'course123' } }] },
      { CLASSROOM_BUCKET: bucket },
    );
    expect(publishClassroomReadView).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'course123' }),
    );
  });
});
