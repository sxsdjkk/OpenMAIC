'use client';

import { useEffect, useState } from 'react';

export default function WorkerGenerationPage() {
  const [message, setMessage] = useState('正在读取生成任务…');
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
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
        setProgress(job.progress);
        if (job.status === 'succeeded') {
          window.location.replace(`/classroom/${encodeURIComponent(job.result.classroomId)}`);
        } else if (job.status === 'failed') {
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
  return (
    <main className="mx-auto max-w-xl space-y-6 px-6 py-24">
      <h1 className="text-2xl font-semibold">AI 课程生成</h1>
      <p role={failed ? 'alert' : 'status'}>{message}</p>
      <progress className="w-full" max={100} value={progress} />
      <p>{progress}%</p>
      <a className="text-violet-600" href="/">
        返回学习平台
      </a>
    </main>
  );
}
