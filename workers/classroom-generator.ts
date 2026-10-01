import {
  runClassroomQueueTask,
  type ClassroomStartTask,
  type ClassroomStepTask,
  type ClassroomRetryTask,
} from '../lib/server/classroom-queue-generation';
import {
  markClassroomGenerationJobFailed,
  readClassroomGenerationJob,
  updateClassroomGenerationJob,
} from '../lib/server/classroom-job-store';
import {
  publishClassroomReadView,
  readClassroom,
  runWithClassroomBucket,
  type ClassroomBucket,
} from '../lib/server/classroom-storage';
import { POST as generateTTS } from '../app/api/generate/tts/route';
import type { ExportedHandler, GeneratorEnv, Message, Queue } from './generator-env';
import { linkLegacyAccount, type LegacyAccountTask } from '../lib/server/worker-account-migration';
import { indexAccountJob } from '../lib/server/worker-generation-jobs';

type ClassroomQueueMessage =
  | ClassroomStartTask
  | ClassroomStepTask
  | ClassroomRetryTask
  | { kind: 'index-account-job'; ownerId: string; jobId: string }
  | LegacyAccountTask
  | { kind: 'publish-classroom'; classroomId: string }
  | { kind: 'tts'; jobId: string; body: string };

// The shared storage adapter uses DOM streams, not the module-scoped workerd
// stream declaration. Keep that existing R2 contract at the app boundary.
type ClassroomGeneratorEnv = Omit<GeneratorEnv, 'CLASSROOM_BUCKET' | 'CLASSROOM_QUEUE'> & {
  CLASSROOM_BUCKET: ClassroomBucket;
  CLASSROOM_QUEUE: Pick<Queue<ClassroomStepTask>, 'send'>;
};

const classroomGenerator = {
  async queue(
    batch: {
      messages: ReadonlyArray<
        Pick<Message<ClassroomQueueMessage>, 'body' | 'attempts' | 'ack' | 'retry'>
      >;
    },
    env: {
      CLASSROOM_BUCKET: ClassroomBucket;
      CLASSROOM_QUEUE: Pick<Queue<ClassroomStepTask>, 'send'>;
    },
  ) {
    for (const message of batch.messages) {
      try {
        if (
          'kind' in message.body &&
          message.body.kind !== 'classroom-step' &&
          message.body.kind !== 'classroom-retry'
        ) {
          if (message.body.kind === 'index-account-job') {
            await indexAccountJob(env.CLASSROOM_BUCKET, message.body.ownerId, message.body.jobId);
            message.ack();
            continue;
          }
          if (message.body.kind === 'link-legacy-account') {
            await linkLegacyAccount(env.CLASSROOM_BUCKET, message.body);
            message.ack();
            continue;
          }
          if (message.body.kind === 'tts') {
            const { jobId, body } = message.body;
            const key = `tts-jobs/${jobId}.json`;
            // Queue can redeliver. Reuse an existing result rather than rebill TTS.
            if (!(await env.CLASSROOM_BUCKET.head(key))) {
              const response = await generateTTS(
                new Request('https://queue.internal/api/generate/tts', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body,
                }),
              );
              await env.CLASSROOM_BUCKET.put(key, await response.text(), {
                customMetadata: { status: String(response.status) },
              });
            }
            message.ack();
            continue;
          }
          const { classroomId } = message.body;
          await runWithClassroomBucket(env.CLASSROOM_BUCKET, async () => {
            const classroom = await readClassroom(classroomId);
            if (classroom) await publishClassroomReadView(classroom);
          });
          message.ack();
          continue;
        }
        const task = message.body;
        await runWithClassroomBucket(env.CLASSROOM_BUCKET, () =>
          runClassroomQueueTask(task, env.CLASSROOM_BUCKET, env.CLASSROOM_QUEUE),
        );
        console.info(
          JSON.stringify({
            message: 'Classroom task committed',
            jobId: task.jobId,
            phase:
              'kind' in task ? (task.kind === 'classroom-step' ? task.phase : 'retry') : 'plan',
            index: 'kind' in task && task.kind === 'classroom-step' ? task.index : 0,
          }),
        );
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            message: 'Queue task failed',
            attempts: message.attempts,
            kind: 'kind' in message.body ? message.body.kind : 'classroom-start',
          }),
        );
        const body = message.body;
        if (
          !('kind' in body) ||
          body.kind === 'classroom-step' ||
          body.kind === 'classroom-retry'
        ) {
          await runWithClassroomBucket(env.CLASSROOM_BUCKET, async () => {
            const job = await readClassroomGenerationJob(body.jobId);
            if (!job || job.status === 'succeeded' || job.status === 'failed') return;
            if (message.attempts >= 3) {
              await markClassroomGenerationJobFailed(
                body.jobId,
                error instanceof Error ? error.message : '课程生成失败',
              );
            } else {
              await updateClassroomGenerationJob(body.jobId, {
                message: `当前片段生成失败，正在重试（${message.attempts}/2）`,
              });
            }
          });
        }
        if (message.attempts >= 3) message.ack();
        else message.retry({ delaySeconds: 10 * message.attempts });
      }
    }
  },
};

export default classroomGenerator satisfies ExportedHandler<
  ClassroomGeneratorEnv,
  ClassroomQueueMessage
>;
