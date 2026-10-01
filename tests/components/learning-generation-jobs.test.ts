// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GenerationJobs, RetryGenerationButton } from '@/components/learning/GenerationJobs';
import { listCloudGenerationJobs, retryCloudGenerationJob } from '@/lib/classroom/worker-account';
import type { GenerationJobSummary } from '@/lib/classroom/generation-job';

vi.mock('@/lib/classroom/worker-account', () => ({
  listCloudGenerationJobs: vi.fn(),
  retryCloudGenerationJob: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
const failed = {
  id: 'job1',
  name: '失败的 Python 长课',
  status: 'failed',
  progress: 84,
  scenesGenerated: 12,
  totalScenes: 12,
  ttsGenerated: 39,
  totalTts: 80,
  error: '第 5 节语音片段生成失败',
  canRetry: true,
} as GenerationJobSummary;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(listCloudGenerationJobs).mockResolvedValue([failed]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('shows failed courses, saved counts, errors and an honest legacy create-again action', async () => {
  vi.mocked(listCloudGenerationJobs).mockResolvedValue([
    failed,
    { ...failed, id: 'legacy', canRetry: false },
  ]);
  await act(async () => root.render(createElement(GenerationJobs, { chinese: true })));
  expect(container.textContent).toContain('生成失败');
  expect(container.textContent).toContain('第 5 节语音片段生成失败');
  expect(container.textContent).toContain('39 / 80');
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect(container.textContent).toContain('历史任务未保存完整需求或断点');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/');
});

it('blocks rapid duplicate clicks and offers the real progress URL after acceptance', async () => {
  let resolve!: (result: { jobId: string }) => void;
  vi.mocked(retryCloudGenerationJob).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await act(async () => root.render(createElement(RetryGenerationButton, { jobId: 'job1' })));
  const button = container.querySelector('button')!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(retryCloudGenerationJob).toHaveBeenCalledExactlyOnceWith('job1');
  expect(button.disabled).toBe(true);
  await act(async () => resolve({ jobId: 'job1' }));
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/worker-generation?jobId=job1');
  expect(container.textContent).toContain('重试已提交');
});

it('reenables retry and displays server submission errors', async () => {
  vi.mocked(retryCloudGenerationJob).mockRejectedValue(new Error('提交失败，请稍后再试'));
  await act(async () => root.render(createElement(RetryGenerationButton, { jobId: 'job1' })));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('提交失败，请稍后再试');
  expect(container.querySelector('button')?.disabled).toBe(false);
  expect(container.querySelector('a')).toBeNull();
});

it('polls active retries but stops polling once the task is terminal', async () => {
  vi.useFakeTimers();
  vi.mocked(listCloudGenerationJobs)
    .mockResolvedValueOnce([{ ...failed, status: 'queued', error: undefined }])
    .mockResolvedValue([]);
  await act(async () => root.render(createElement(GenerationJobs, { chinese: false })));
  expect(container.textContent).toContain('Queued');
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(listCloudGenerationJobs).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(listCloudGenerationJobs).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('');
});
