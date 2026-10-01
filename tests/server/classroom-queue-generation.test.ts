import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ClassroomBucket } from '@/lib/server/classroom-storage';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/server/classroom-generation', () => ({
  prepareClassroomGeneration: vi.fn(),
  generateClassroomScene: vi.fn(),
}));
vi.mock('@/lib/server/classroom-media-generation', () => ({
  generateMediaForClassroom: vi.fn(),
  replaceMediaPlaceholders: vi.fn(),
  generateTTSForClassroom: vi.fn(),
  countNarratableSpeechActions: vi.fn(),
}));
vi.mock('@/lib/server/classroom-storage', () => ({ persistClassroom: vi.fn() }));
vi.mock('@/lib/server/provider-config', () => ({ getServerTTSProviders: vi.fn() }));
vi.mock('@/lib/server/worker-accounts', () => ({ claimCourse: vi.fn(), registerCourse: vi.fn() }));
vi.mock('@/lib/server/classroom-job-store', () => ({
  readClassroomGenerationJob: vi.fn(),
  updateClassroomGenerationJob: vi.fn(),
  markClassroomGenerationJobRunning: vi.fn(),
  markClassroomGenerationJobSucceeded: vi.fn(),
}));

import {
  runClassroomQueueTask,
  type ClassroomStartTask,
  type ClassroomStepTask,
} from '@/lib/server/classroom-queue-generation';
import {
  prepareClassroomGeneration,
  generateClassroomScene,
} from '@/lib/server/classroom-generation';
import {
  generateTTSForClassroom,
  countNarratableSpeechActions,
} from '@/lib/server/classroom-media-generation';
import { persistClassroom } from '@/lib/server/classroom-storage';
import { getServerTTSProviders } from '@/lib/server/provider-config';
import { claimCourse, registerCourse } from '@/lib/server/worker-accounts';
import {
  readClassroomGenerationJob,
  updateClassroomGenerationJob,
  markClassroomGenerationJobSucceeded,
} from '@/lib/server/classroom-job-store';

describe('checkpointed classroom Queue tasks', () => {
  const objects = new Map<string, string | Uint8Array>();
  const pending: ClassroomStepTask[] = [];
  const bucket: ClassroomBucket = {
    async get(key) {
      const value = objects.get(key);
      return value === undefined
        ? null
        : { text: async () => String(value), body: new ReadableStream() };
    },
    async head(key) {
      return objects.has(key) ? { size: String(objects.get(key)).length } : null;
    },
    put: vi.fn(async (key, value) => {
      objects.set(key, value);
      return {};
    }),
    async delete(key) {
      objects.delete(key);
    },
  };
  const queue = {
    send: vi.fn(async (task: ClassroomStepTask) => {
      pending.push(task);
      return { metadata: { metrics: { backlogCount: pending.length, backlogBytes: 0 } } };
    }),
  };
  const start: ClassroomStartTask = {
    jobId: 'job1',
    input: { requirement: 'A 12 scene course', enableTTS: true },
    baseUrl: 'https://example.com',
  };
  const checkpoint = () => JSON.parse(String(objects.get('jobs/job1/checkpoint.json')));
  const next = async () => {
    const task = pending.shift();
    if (!task) throw new Error('No task');
    await runClassroomQueueTask(task, bucket, queue);
    return task;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    objects.clear();
    pending.length = 0;
    vi.mocked(bucket.put).mockImplementation(async (key, value) => {
      objects.set(key, value);
      return {};
    });
    queue.send.mockImplementation(async (task) => {
      pending.push(task);
      return { metadata: { metrics: { backlogCount: pending.length, backlogBytes: 0 } } };
    });
    vi.mocked(readClassroomGenerationJob).mockResolvedValue({ status: 'running' } as never);
    vi.mocked(prepareClassroomGeneration).mockResolvedValue({
      stage: { id: 'course1' },
      outlines: Array.from({ length: 12 }, (_, index) => ({ title: `Scene ${index + 1}` })),
      agents: [],
      languageDirective: '',
      vocationalActive: false,
    } as never);
    vi.mocked(generateClassroomScene).mockImplementation(
      async (_plan, index) =>
        ({
          id: `scene${index}`,
          order: index,
          actions: [{ id: `speech${index}`, type: 'speech', text: 'Narration' }],
        }) as Scene,
    );
    vi.mocked(getServerTTSProviders).mockReturnValue({
      'openrouter-tts': { disabled: false },
    } as never);
    vi.mocked(generateTTSForClassroom).mockResolvedValue({ written: 1, total: 1 });
    vi.mocked(persistClassroom).mockResolvedValue({
      id: 'course1',
      scenes: Array(12).fill({}),
      url: 'https://example.com/classroom/course1',
    } as never);
  });

  it('splits 12 scenes and 12 clips into independent bounded messages, then publishes', async () => {
    await runClassroomQueueTask(start, bucket, queue);
    expect(generateClassroomScene).not.toHaveBeenCalled();
    let tasks = 1;
    while (pending.length) {
      const beforeScenes = vi.mocked(generateClassroomScene).mock.calls.length;
      const beforeTts = vi.mocked(generateTTSForClassroom).mock.calls.length;
      await next();
      tasks += 1;
      expect(
        vi.mocked(generateClassroomScene).mock.calls.length - beforeScenes,
      ).toBeLessThanOrEqual(1);
      expect(vi.mocked(generateTTSForClassroom).mock.calls.length - beforeTts).toBeLessThanOrEqual(
        1,
      );
    }
    expect(tasks).toBe(27); // plan + 12 scenes + prepare + 12 clips + publish
    expect(generateClassroomScene).toHaveBeenCalledTimes(12);
    expect(generateTTSForClassroom).toHaveBeenCalledTimes(12);
    expect(countNarratableSpeechActions).toHaveBeenCalledOnce();
    expect(markClassroomGenerationJobSucceeded).toHaveBeenCalledWith(
      'job1',
      expect.objectContaining({ scenesCount: 12, ttsCoverage: { written: 12, total: 12 } }),
    );
    expect(checkpoint().next).toBeNull();
    const values = vi
      .mocked(updateClassroomGenerationJob)
      .mock.calls.map(([, patch]) => patch.progress!);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(queue.send.mock.calls.every(([task]) => JSON.stringify(task).length < 200)).toBe(true);
  });

  it('redelivery after checkpoint commit does not repeat scene generation', async () => {
    await runClassroomQueueTask(start, bucket, queue);
    const sceneTask = await next();
    await runClassroomQueueTask(sceneTask, bucket, queue);
    expect(generateClassroomScene).toHaveBeenCalledOnce();
    expect(checkpoint().scenes).toHaveLength(1);
    expect(queue.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'scene', index: 1 }),
    );
  });

  it('carries the verified job owner into course ownership and catalog before completion', async () => {
    const ownerId = 'a'.repeat(64);
    vi.mocked(readClassroomGenerationJob).mockResolvedValue({
      status: 'running',
      ownerId,
    } as never);
    await runClassroomQueueTask(
      { ...start, input: { requirement: 'owned course', enableTTS: false } },
      bucket,
      queue,
    );
    expect(claimCourse).toHaveBeenCalledWith(bucket, ownerId, 'course1');
    while (pending.length) await next();
    expect(registerCourse).toHaveBeenCalledWith(
      bucket,
      ownerId,
      expect.objectContaining({ id: 'course1' }),
    );
    expect(vi.mocked(registerCourse).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(markClassroomGenerationJobSucceeded).mock.invocationCallOrder[0],
    );
  });

  it('recovers a failed dispatch after committing a scene without regenerating it', async () => {
    await runClassroomQueueTask(start, bucket, queue);
    const task = pending.shift()!;
    queue.send.mockRejectedValueOnce(new Error('send failed'));
    await expect(runClassroomQueueTask(task, bucket, queue)).rejects.toThrow('send failed');
    await runClassroomQueueTask(task, bucket, queue);
    expect(generateClassroomScene).toHaveBeenCalledOnce();
    expect(checkpoint().next.index).toBe(1);
  });

  it('failed TTS retries the same clip, retaining all scenes and prior clips', async () => {
    await runClassroomQueueTask(start, bucket, queue);
    while (pending[0].phase !== 'tts') await next();
    await next();
    const task = pending.shift()!;
    vi.mocked(generateTTSForClassroom).mockResolvedValueOnce({ written: 0, total: 1 });
    await expect(runClassroomQueueTask(task, bucket, queue)).rejects.toThrow('语音片段生成失败');
    expect(checkpoint()).toMatchObject({ ttsGenerated: 1, next: task });
    await runClassroomQueueTask(task, bucket, queue);
    expect(generateClassroomScene).toHaveBeenCalledTimes(12);
    expect(checkpoint().ttsGenerated).toBe(2);
  });

  it('reuses an audio object if the checkpoint write crashed after synthesis', async () => {
    await runClassroomQueueTask(start, bucket, queue);
    while (pending[0].phase !== 'tts') await next();
    const task = pending.shift()!;
    objects.set('classrooms/course1/audio/tts_s0_speech0.mp3', new Uint8Array([1, 2, 3]));
    await runClassroomQueueTask(task, bucket, queue);
    expect(generateTTSForClassroom).not.toHaveBeenCalled();
    expect(checkpoint().scenes[0].actions[0].audioUrl).toBe(
      'https://example.com/api/classroom-media/course1/audio/tts_s0_speech0.mp3',
    );
    expect(checkpoint().ttsGenerated).toBe(1);
  });

  it('saves the final scene before validating the TTS configuration', async () => {
    await runClassroomQueueTask(start, bucket, queue);
    for (let index = 0; index < 12; index++) await next();
    vi.mocked(getServerTTSProviders).mockReturnValue({});
    await expect(next()).rejects.toThrow('未配置服务端语音');
    expect(checkpoint().scenes).toHaveLength(12);
    expect(checkpoint().next.phase).toBe('prepare-tts');
  });

  it('publishes without scheduling clips when narration is disabled', async () => {
    await runClassroomQueueTask(
      { ...start, input: { ...start.input, enableTTS: false } },
      bucket,
      queue,
    );
    while (pending.length) await next();
    expect(generateTTSForClassroom).not.toHaveBeenCalled();
    expect(persistClassroom).toHaveBeenCalledOnce();
  });

  it('does not invoke providers for a terminal job', async () => {
    vi.mocked(readClassroomGenerationJob).mockResolvedValue({ status: 'failed' } as never);
    await runClassroomQueueTask(start, bucket, queue);
    expect(prepareClassroomGeneration).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('keeps consumer concurrency and retry limits consistent with checkpoint safety', () => {
    const config = readFileSync('wrangler.generator.jsonc', 'utf8');
    expect(config).toMatch(/"max_concurrency":\s*1/);
    expect(config).toMatch(/"max_retries":\s*2/);
  });
});
