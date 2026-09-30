import { runClassroomGenerationJob } from '../lib/server/classroom-job-runner';
import {
  publishClassroomReadView,
  readClassroom,
  runWithClassroomBucket,
  type ClassroomBucket,
} from '../lib/server/classroom-storage';
import type { GenerateClassroomInput } from '../lib/server/classroom-generation';
import { POST as generateTTS } from '../app/api/generate/tts/route';

interface ClassroomQueueMessage {
  jobId: string;
  input: GenerateClassroomInput;
  baseUrl: string;
}

const classroomGenerator = {
  async queue(
    batch: {
      messages: Array<{
        body:
          | ClassroomQueueMessage
          | { kind: 'publish-classroom'; classroomId: string }
          | { kind: 'tts'; jobId: string; body: string };
      }>;
    },
    env: { CLASSROOM_BUCKET: ClassroomBucket },
  ) {
    for (const message of batch.messages) {
      if ('kind' in message.body) {
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
          continue;
        }
        const { classroomId } = message.body;
        await runWithClassroomBucket(env.CLASSROOM_BUCKET, async () => {
          const classroom = await readClassroom(classroomId);
          if (classroom) await publishClassroomReadView(classroom);
        });
        continue;
      }
      const { jobId, input, baseUrl } = message.body;
      await runWithClassroomBucket(env.CLASSROOM_BUCKET, () =>
        runClassroomGenerationJob(jobId, input, baseUrl),
      );
    }
  },
};

export default classroomGenerator;
