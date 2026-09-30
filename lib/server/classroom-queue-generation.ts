import {
  prepareClassroomGeneration,
  generateClassroomScene,
  type ClassroomGenerationPlan,
  type GenerateClassroomInput,
} from './classroom-generation';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
  countNarratableSpeechActions,
} from './classroom-media-generation';
import {
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  readClassroomGenerationJob,
  updateClassroomGenerationJob,
} from './classroom-job-store';
import { persistClassroom, type ClassroomBucket } from './classroom-storage';
import { getServerTTSProviders } from './provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import type { Scene } from '@/lib/types/stage';
import type { Queue } from '@/workers/generator-env';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

export interface ClassroomStartTask {
  jobId: string;
  input: GenerateClassroomInput;
  baseUrl: string;
}

export interface ClassroomStepTask {
  kind: 'classroom-step';
  jobId: string;
  phase: 'scene' | 'media' | 'prepare-tts' | 'tts' | 'publish';
  index: number;
}

interface Checkpoint {
  input: GenerateClassroomInput;
  baseUrl: string;
  plan: ClassroomGenerationPlan;
  scenes: Scene[];
  clips: Array<{ sceneIndex: number; actionIndex: number }>;
  ttsGenerated: number;
  next: ClassroomStepTask | null;
}

type QueueProducer = Pick<Queue<ClassroomStepTask>, 'send'>;

/** One bounded phase per message. The consumer is configured with concurrency=1. */
export async function runClassroomQueueTask(
  task: ClassroomStartTask | ClassroomStepTask,
  bucket: ClassroomBucket,
  queue: QueueProducer,
) {
  const job = await readClassroomGenerationJob(task.jobId);
  if (!job || job.status === 'succeeded' || job.status === 'failed') return;
  const key = `jobs/${task.jobId}/checkpoint.json`;
  const saved = await bucket.get(key);
  let checkpoint: Checkpoint;
  const step = (phase: ClassroomStepTask['phase'], index = 0): ClassroomStepTask => ({
    kind: 'classroom-step',
    jobId: task.jobId,
    phase,
    index,
  });
  const saveAndDispatch = async () => {
    // Persist BEFORE send. A redelivery can resend next without repeating paid work.
    await bucket.put(key, JSON.stringify(checkpoint));
    if (checkpoint.next) await queue.send(checkpoint.next);
  };
  const progress = async (
    phase: 'generating_scenes' | 'generating_media' | 'generating_tts' | 'persisting',
    value: number,
    message: string,
  ) =>
    updateClassroomGenerationJob(task.jobId, {
      status: 'running',
      step: phase,
      progress: value,
      message,
      scenesGenerated: checkpoint.scenes.length,
      totalScenes: checkpoint.plan.outlines.length,
      ttsGenerated: checkpoint.ttsGenerated,
      totalTts: checkpoint.clips.length,
    });
  const prepareTts = () => {
    if (!checkpoint.input.enableTTS) return step('publish');
    const provider = Object.entries(getServerTTSProviders()).find(
      ([id, info]) => id !== 'browser-native-tts' && !info.disabled,
    )?.[0];
    if (!provider) throw new Error('未配置服务端语音服务，无法生成课程讲解');
    // Split long narration once, before recording stable clip addresses in R2.
    countNarratableSpeechActions(checkpoint.scenes, provider as TTSProviderId);
    checkpoint.clips = [];
    checkpoint.scenes.forEach((scene, sceneIndex) => {
      scene.actions?.forEach((action, actionIndex) => {
        if (action.type === 'speech' && action.text?.trim()) {
          checkpoint.clips.push({ sceneIndex, actionIndex });
        }
      });
    });
    return checkpoint.clips.length ? step('tts') : step('publish');
  };

  if (!saved) {
    if ('kind' in task) throw new Error('课程生成断点不存在');
    await markClassroomGenerationJobRunning(task.jobId);
    const plan = await prepareClassroomGeneration(task.input, {
      baseUrl: task.baseUrl,
      signal: AbortSignal.timeout(8 * 60_000),
      onProgress: (event) => updateClassroomGenerationJob(task.jobId, event).then(() => {}),
    });
    if (!plan.outlines.length) throw new Error('课程大纲为空');
    checkpoint = {
      input: task.input,
      baseUrl: task.baseUrl,
      plan,
      scenes: [],
      clips: [],
      ttsGenerated: 0,
      next: step('scene'),
    };
    await saveAndDispatch();
    return;
  }
  checkpoint = JSON.parse(await saved.text()) as Checkpoint;
  if (!checkpoint.next) return;
  if (
    !('kind' in task) ||
    task.phase !== checkpoint.next.phase ||
    task.index !== checkpoint.next.index
  ) {
    // Handles a crash between checkpoint write and enqueue (and duplicate delivery).
    await queue.send(checkpoint.next);
    return;
  }
  const { plan, baseUrl } = checkpoint;
  if (task.phase === 'scene') {
    const index = task.index;
    await progress(
      'generating_scenes',
      30 + Math.floor((index / plan.outlines.length) * 45),
      `正在生成第 ${index + 1}/${plan.outlines.length} 节：${plan.outlines[index].title}`,
    );
    const scene = await generateClassroomScene(plan, index, {
      baseUrl,
      signal: AbortSignal.timeout(8 * 60_000),
      onProgress: (event) =>
        progress(
          'generating_scenes',
          30 + Math.floor((index / plan.outlines.length) * 45),
          event.message,
        ).then(() => {}),
    });
    if (!scene) throw new Error(`第 ${index + 1} 节生成失败，已保留此前完成的场景`);
    checkpoint.scenes.push(scene);
    checkpoint.next =
      index + 1 < plan.outlines.length
        ? step('scene', index + 1)
        : checkpoint.input.enableImageGeneration
          ? step('media')
          : step('prepare-tts');
    await saveAndDispatch();
    await progress(
      'generating_scenes',
      30 + Math.floor((checkpoint.scenes.length / plan.outlines.length) * 45),
      `已保存 ${checkpoint.scenes.length}/${plan.outlines.length} 节课件`,
    );
  } else if (task.phase === 'media') {
    const index = task.index;
    await progress(
      'generating_media',
      75,
      `正在生成第 ${index + 1}/${plan.outlines.length} 节配图`,
    );
    const media = await generateMediaForClassroom([plan.outlines[index]], plan.stage.id, baseUrl);
    replaceMediaPlaceholders([checkpoint.scenes[index]], media);
    checkpoint.next =
      index + 1 < plan.outlines.length ? step('media', index + 1) : step('prepare-tts');
    await saveAndDispatch();
  } else if (task.phase === 'prepare-tts') {
    checkpoint.next = prepareTts();
    await saveAndDispatch();
  } else if (task.phase === 'tts') {
    const { sceneIndex, actionIndex } = checkpoint.clips[task.index];
    const scene = checkpoint.scenes[sceneIndex];
    const clipScene = { ...scene, actions: [scene.actions![actionIndex]] };
    await progress(
      'generating_tts',
      75 + Math.floor((checkpoint.ttsGenerated / checkpoint.clips.length) * 22),
      `正在生成语音 ${task.index + 1}/${checkpoint.clips.length}（第 ${sceneIndex + 1} 节）`,
    );
    // Audio can be committed before the checkpoint write fails. Reuse its stable
    // object key on retry, including provider formats that differ from MP3.
    const action = clipScene.actions[0];
    const audioId = `tts_s${scene.order}_${action.id}`;
    const formats = new Set(
      Object.values(TTS_PROVIDERS).flatMap((provider) => provider.supportedFormats),
    );
    let savedFilename: string | undefined;
    for (const format of formats) {
      const filename = `${audioId}.${format}`;
      if ((await bucket.head(`classrooms/${plan.stage.id}/audio/${filename}`))?.size) {
        savedFilename = filename;
        break;
      }
    }
    const coverage = savedFilename
      ? (Object.assign(action, {
          audioId,
          audioUrl: `${baseUrl}/api/classroom-media/${plan.stage.id}/audio/${savedFilename}`,
        }),
        { written: 1, total: 1 })
      : await generateTTSForClassroom(
          [clipScene],
          plan.stage.id,
          baseUrl,
          AbortSignal.timeout(3 * 60_000),
        );
    if (coverage.written !== 1 || coverage.total !== 1)
      throw new Error(`第 ${sceneIndex + 1} 节语音片段生成失败`);
    scene.actions![actionIndex] = clipScene.actions[0];
    checkpoint.ttsGenerated += 1;
    checkpoint.next =
      task.index + 1 < checkpoint.clips.length ? step('tts', task.index + 1) : step('publish');
    await saveAndDispatch();
    await progress(
      'generating_tts',
      75 + Math.floor((checkpoint.ttsGenerated / checkpoint.clips.length) * 22),
      `已保存 ${checkpoint.ttsGenerated}/${checkpoint.clips.length} 段语音`,
    );
  } else {
    await progress('persisting', 98, '正在保存完整课程');
    const persisted = await persistClassroom(
      { id: plan.stage.id, stage: plan.stage, scenes: checkpoint.scenes },
      baseUrl,
    );
    await markClassroomGenerationJobSucceeded(task.jobId, {
      ...persisted,
      scenesCount: persisted.scenes.length,
      ...(checkpoint.input.enableTTS
        ? { ttsCoverage: { written: checkpoint.ttsGenerated, total: checkpoint.clips.length } }
        : {}),
    });
    checkpoint.next = null;
    await saveAndDispatch();
  }
}
