'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, LoaderCircle, RotateCcw } from 'lucide-react';
import { listCloudGenerationJobs, retryCloudGenerationJob } from '@/lib/classroom/worker-account';
import type { GenerationJobSummary } from '@/lib/classroom/generation-job';

export function RetryGenerationButton({
  jobId,
  chinese = true,
  onSubmitted,
}: {
  jobId: string;
  chinese?: boolean;
  onSubmitted?: () => void;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  async function retry() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await retryCloudGenerationJob(jobId);
      setSubmitted(true);
      onSubmitted?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : chinese ? '重试失败' : 'Retry failed');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div>
      {submitted ? (
        <a
          className="text-sm font-medium text-violet-600 hover:underline"
          href={`/worker-generation?jobId=${encodeURIComponent(jobId)}`}
        >
          {chinese ? '重试已提交，查看进度 →' : 'Retry submitted — view progress →'}
        </a>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void retry()}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <RotateCcw className="size-4" />
          )}
          {chinese ? (busy ? '正在提交…' : '重试生成') : busy ? 'Submitting…' : 'Retry generation'}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function GenerationJobs({ chinese }: { chinese: boolean }) {
  const [jobs, setJobs] = useState<GenerationJobSummary[]>([]);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await listCloudGenerationJobs();
        if (!active) return;
        setJobs(result);
        setError(false);
        if (result.some((job) => job.status !== 'failed')) timer = setTimeout(load, 5000);
      } catch {
        if (active) setError(true);
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  if (!jobs.length && !error) return null;
  return (
    <section className="mt-12">
      <h2 className="text-xl font-semibold">{chinese ? '生成记录' : 'Generation history'}</h2>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {chinese
            ? '生成记录加载失败，请刷新后重试。'
            : 'Could not load generation history. Refresh to retry.'}
        </p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {jobs.map((job) => (
          <article
            key={job.id}
            className="rounded-xl border border-slate-200 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-900/80"
          >
            <div className="flex items-start gap-2">
              {job.status === 'failed' ? (
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
              ) : (
                <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-violet-500 motion-reduce:animate-none" />
              )}
              <h3 className="line-clamp-2 font-medium">{job.name}</h3>
            </div>
            <time dateTime={job.createdAt} className="mt-2 block text-xs text-slate-400">
              {new Date(job.createdAt).toLocaleString(chinese ? 'zh-CN' : 'en-US')}
            </time>
            <p
              className={`mt-3 text-sm ${job.status === 'failed' ? 'text-red-600' : 'text-violet-600'}`}
            >
              {chinese
                ? job.status === 'failed'
                  ? '生成失败'
                  : job.status === 'queued'
                    ? '正在排队'
                    : '正在生成'
                : job.status === 'failed'
                  ? 'Generation failed'
                  : job.status === 'queued'
                    ? 'Queued'
                    : 'Generating'}{' '}
              · {job.progress}%
            </p>
            {job.error && <p className="mt-2 break-words text-sm text-slate-500">{job.error}</p>}
            <p className="mt-3 text-xs text-slate-500">
              {chinese ? '已保存课件' : 'Slides saved'}：{job.scenesGenerated} /{' '}
              {job.totalScenes ?? '—'} · {chinese ? '语音' : 'Audio'}：{job.ttsGenerated ?? 0} /{' '}
              {job.totalTts ?? '—'}
            </p>
            <div className="mt-4">
              {job.status !== 'failed' ? (
                <a
                  className="text-sm text-violet-600 hover:underline"
                  href={`/worker-generation?jobId=${encodeURIComponent(job.id)}`}
                >
                  {chinese ? '查看生成进度 →' : 'View progress →'}
                </a>
              ) : job.canRetry ? (
                <RetryGenerationButton
                  jobId={job.id}
                  chinese={chinese}
                  onSubmitted={() => setRefresh((value) => value + 1)}
                />
              ) : (
                <>
                  <p className="mb-3 text-xs text-slate-500">
                    {chinese
                      ? '历史任务未保存完整需求或断点，请重新输入学习需求。'
                      : 'This legacy task has no complete input or checkpoint. Please enter your requirements again.'}
                  </p>
                  <Link
                    className="text-sm font-medium text-violet-600 hover:underline"
                    href="/"
                    prefetch={false}
                  >
                    {chinese ? '重新创建课程 →' : 'Create again →'}
                  </Link>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
