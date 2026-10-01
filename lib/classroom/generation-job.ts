import type { ClassroomGenerationJobStatus } from '@/lib/server/classroom-job-store';

export interface GenerationJobSummary {
  id: string;
  name: string;
  status: ClassroomGenerationJobStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  scenesGenerated: number;
  totalScenes?: number;
  ttsGenerated?: number;
  totalTts?: number;
  error?: string;
  canRetry: boolean;
}

export const STALE_GENERATION_ERROR = '生成任务长时间没有进展，可能已中断，请重试。';
export function isGenerationJobStale(job: { status: string; updatedAt: string }) {
  return (
    (job.status === 'running' || job.status === 'queued') &&
    Date.now() - Date.parse(job.updatedAt) > 30 * 60_000
  );
}
