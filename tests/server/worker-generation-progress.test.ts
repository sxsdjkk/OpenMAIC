// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkerGenerationPage from '@/app/worker-generation/page';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const fetchJob = vi.fn();
const job = (patch = {}) =>
  Response.json({
    success: true,
    status: 'running',
    step: 'generating_scenes',
    progress: 45,
    message: '正在制作课件',
    scenesGenerated: 4,
    totalScenes: 12,
    ttsGenerated: 0,
    totalTts: 0,
    ...patch,
  });
beforeEach(() => {
  vi.useFakeTimers();
  fetchJob.mockReset();
  vi.stubGlobal('fetch', fetchJob);
  window.history.replaceState({}, '', '/worker-generation?jobId=job1');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () => {
    root.render(createElement(WorkerGenerationPage));
  });
const bar = () => host.querySelector('[role="progressbar"]')!;

describe('generation progress animation and real counts', () => {
  it('animates the active bar without inventing progress while waiting', async () => {
    fetchJob.mockResolvedValue(job());
    await render();
    expect(bar().getAttribute('aria-valuenow')).toBe('45');
    expect(bar().firstElementChild?.getAttribute('style')).toContain('width: 45%');
    expect(bar().firstElementChild?.className).toContain('running');
    expect(host.textContent).toContain('已保存课件：4 / 12');
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('制作课件');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(bar().getAttribute('aria-valuenow')).toBe('45');
    expect(fetchJob).toHaveBeenCalledOnce();
  });

  it('transitions to the TTS phase and updates persisted clip counts', async () => {
    fetchJob.mockResolvedValueOnce(job()).mockResolvedValueOnce(
      job({
        progress: 86,
        step: 'generating_tts',
        scenesGenerated: 12,
        ttsGenerated: 24,
        totalTts: 48,
      }),
    );
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(bar().getAttribute('aria-valuenow')).toBe('86');
    expect(host.textContent).toContain('已保存语音：24 / 48');
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('合成语音');
  });

  it('stops animation and polling on terminal failure, preserving actual progress', async () => {
    fetchJob.mockResolvedValue(job({ status: 'failed', progress: 79, error: '语音片段生成失败' }));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('语音片段生成失败');
    expect(bar().firstElementChild?.className).not.toContain('running');
    expect(bar().firstElementChild?.className).toContain('failed');
    expect(bar().getAttribute('aria-valuenow')).toBe('79');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(fetchJob).toHaveBeenCalledOnce();
  });

  it('fails clearly without a job id and never calls the API', async () => {
    window.history.replaceState({}, '', '/worker-generation');
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('缺少生成任务编号');
    expect(fetchJob).not.toHaveBeenCalled();
  });

  it('supports width transitions, moving stripes and reduced motion', () => {
    const css = readFileSync('app/worker-generation/progress.module.css', 'utf8');
    expect(css).toContain('transition: width');
    expect(css).toMatch(/animation:\s*flow/);
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('animation: none');
  });
});
