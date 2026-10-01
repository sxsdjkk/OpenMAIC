'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle, Check, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import styles from './progress.module.css';
import { RetryGenerationButton } from '@/components/learning/GenerationJobs';

const steps = [
  { label: '生成大纲', stages: ['queued', 'initializing', 'researching', 'generating_outlines'] },
  { label: '制作课件', stages: ['generating_scenes', 'generating_media'] },
  { label: '合成语音', stages: ['generating_tts'] },
  { label: '保存课程', stages: ['persisting', 'completed'] },
];

export default function WorkerGenerationPage() {
  const [message, setMessage] = useState('正在读取生成任务…');
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [stage, setStage] = useState('queued');
  const [counts, setCounts] = useState({ scenes: 0, totalScenes: 0, audio: 0, totalAudio: 0 });
  const [complete, setComplete] = useState(false);
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const jobId = new URLSearchParams(window.location.search).get('jobId');
    async function poll() {
      try {
        if (!jobId) throw new Error('缺少生成任务编号');
        const response = await fetch(`/api/generate-classroom/${encodeURIComponent(jobId)}`, {
          signal: controller.signal,
        });
        const job = await response.json();
        if (!response.ok || !job.success) throw new Error(job.error || '任务查询失败');
        setMessage(job.message);
        setProgress(Number.isFinite(job.progress) ? Math.min(100, Math.max(0, job.progress)) : 0);
        setStage(job.step);
        setCounts({
          scenes: job.scenesGenerated ?? 0,
          totalScenes: job.totalScenes ?? 0,
          audio: job.ttsGenerated ?? 0,
          totalAudio: job.totalTts ?? 0,
        });
        if (job.status === 'succeeded') {
          setComplete(true);
          window.location.replace(`/classroom/${encodeURIComponent(job.result.classroomId)}`);
        } else if (job.status === 'failed') {
          if (job.canRetry) setRetryJobId(jobId);
          throw new Error(job.error || '课程生成失败');
        } else {
          timer = setTimeout(poll, 5000);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailed(true);
        setMessage(error instanceof Error ? error.message : '任务查询失败');
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const activeStep = steps.findIndex((step) => step.stages.includes(stage));
  const running = !failed && !complete;
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="mb-8 flex items-center gap-3">
          <div className="rounded-xl bg-violet-500/10 p-3 text-violet-600">
            {failed ? (
              <AlertCircle aria-hidden="true" className="size-6 text-destructive" />
            ) : complete ? (
              <Check aria-hidden="true" className="size-6" />
            ) : (
              <LoaderCircle
                aria-hidden="true"
                className="size-6 animate-spin motion-reduce:animate-none"
              />
            )}
          </div>
          <div>
            <h1 className="text-2xl font-semibold">AI 课程生成</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              课件与语音分段保存，长课也能逐步完成
            </p>
          </div>
        </div>
        <div className="mb-3 flex items-center justify-between gap-4">
          <p role={failed ? 'alert' : 'status'} className={failed ? 'text-destructive' : 'text-sm'}>
            {message}
          </p>
          <span className="shrink-0 font-mono text-lg font-semibold tabular-nums">{progress}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="课程生成进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-valuetext={`${progress}%`}
          className={styles.track}
        >
          <div
            className={`${styles.fill} ${running ? styles.running : ''} ${failed ? styles.failed : ''}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <ol aria-label="生成阶段" className="mt-6 grid grid-cols-4 gap-2 text-xs sm:text-sm">
          {steps.map((step, index) => (
            <li
              key={step.label}
              aria-current={index === activeStep ? 'step' : undefined}
              className={`flex flex-col items-center gap-2 ${index <= activeStep ? 'text-violet-600' : 'text-muted-foreground'}`}
            >
              <span
                className={`flex size-7 items-center justify-center rounded-full border ${index === activeStep && !failed ? 'border-violet-500 bg-violet-500/10' : 'border-border'}`}
              >
                {index < activeStep ? <Check aria-hidden="true" className="size-4" /> : index + 1}
              </span>
              {step.label}
            </li>
          ))}
        </ol>
        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-5 text-sm text-muted-foreground">
          <span>
            已保存课件：{counts.scenes} / {counts.totalScenes || '—'}
          </span>
          <span>
            已保存语音：{counts.audio} / {counts.totalAudio || '—'}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          百分比根据已完成的任务更新。等待模型响应时，动效表示任务仍在进行。
        </p>
        {failed && retryJobId && (
          <div className="mt-6">
            <RetryGenerationButton jobId={retryJobId} />
          </div>
        )}
      </div>
      <Link
        className="mt-6 inline-block text-sm text-violet-600 hover:underline"
        href="/learn"
        prefetch={false}
      >
        返回我的课程
      </Link>
    </main>
  );
}
