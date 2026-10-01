import {
  finishFeishuLogin,
  getFeishuSession,
  isFeishuAuthConfigured,
  isFeishuAuthRequired,
  startFeishuLogin,
  feishuAccountId,
} from '../lib/server/feishu-auth';
import { parseRangeHeader } from '../lib/server/http-range';
import { apiError, apiSuccess } from '../lib/server/api-response';
import { GET as serverProviders } from '../app/api/server-providers/route';
import { POST as generateImage } from '../app/api/generate/image/route';
import type { GenerateClassroomInput } from '../lib/server/classroom-generation';
import type { ClassroomGenerationJob } from '../lib/server/classroom-job-store';
import {
  ownsCourse,
  listAccountCourses,
  readProgress,
  writeProgress,
  deleteProgress,
  validProgress,
  type AccountBucket,
} from '../lib/server/worker-accounts';
import {
  canRetryGenerationJob,
  indexGenerationJob,
  listGenerationJobs,
} from '../lib/server/worker-generation-jobs';
import { isGenerationJobStale, STALE_GENERATION_ERROR } from '../lib/classroom/generation-job';

interface WebEnv {
  CLASSROOM_BUCKET: AccountBucket;
  CLASSROOM_QUEUE: { send(message: unknown): Promise<void> };
  ASSETS: { fetch(request: Request): Promise<Response> };
  LEGACY_APP: { fetch(request: Request): Promise<Response> };
}

const validId = (value: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const pageNames: Record<string, string> = {
  '/': 'index',
  '/learn': 'learn',
  '/worker-classroom': 'worker-classroom',
  '/worker-generation': 'worker-generation',
};
const mime: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

async function readSmallBody(request: Request): Promise<string | Response> {
  // Bound parsing and Queue message size, independently of Content-Length.
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24000) {
        await reader.cancel();
        return apiError('INVALID_REQUEST', 413, 'Course request is too large');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function createJob(request: Request, env: WebEnv, url: URL, ownerId: string) {
  const body = await readSmallBody(request);
  if (body instanceof Response) return body;
  let raw: Partial<GenerateClassroomInput>;
  try {
    raw = JSON.parse(body);
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON');
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.requirement !== 'string' ||
    !raw.requirement.trim()
  ) {
    return apiError('INVALID_REQUEST', 400, 'Missing learning requirement');
  }
  if (raw.pdfContent !== undefined || raw.enableVideoGeneration) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'PDF and video generation are not supported on Workers yet',
    );
  }
  const input: GenerateClassroomInput = {
    requirement: raw.requirement,
    enableTTS: raw.enableTTS === true,
    enableImageGeneration: raw.enableImageGeneration === true,
    enableWebSearch: raw.enableWebSearch === true,
    agentMode: raw.agentMode === 'generate' ? 'generate' : 'default',
  };
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job: ClassroomGenerationJob = {
    id: jobId,
    ownerId,
    retryable: true,
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: 'Classroom generation job queued',
    createdAt: now,
    updatedAt: now,
    inputSummary: {
      requirementPreview: input.requirement.slice(0, 200),
      hasPdf: false,
      pdfTextLength: 0,
      pdfImageCount: 0,
    },
    scenesGenerated: 0,
  };
  await env.CLASSROOM_BUCKET.put(
    `jobs/${jobId}/input.json`,
    JSON.stringify({ input, baseUrl: url.origin }),
  );
  await env.CLASSROOM_BUCKET.put(`jobs/${jobId}.json`, JSON.stringify(job));
  await indexGenerationJob(env.CLASSROOM_BUCKET, job);
  try {
    await env.CLASSROOM_QUEUE.send({ jobId, input, baseUrl: url.origin });
  } catch {
    job.status = 'failed';
    job.step = 'failed';
    job.error = 'Queue submission failed';
    await env.CLASSROOM_BUCKET.put(`jobs/${jobId}.json`, JSON.stringify(job));
    await indexGenerationJob(env.CLASSROOM_BUCKET, job);
    return apiError('INTERNAL_ERROR', 503, 'Queue submission failed');
  }
  return apiSuccess(
    {
      jobId,
      status: job.status,
      pollUrl: `${url.origin}/api/generate-classroom/${jobId}`,
      pollIntervalMs: 5000,
    },
    202,
  );
}

async function retryJob(env: WebEnv, id: string, ownerId: string) {
  const key = `jobs/${id}.json`;
  const object = await env.CLASSROOM_BUCKET.get(key);
  if (!object) return apiError('INVALID_REQUEST', 404, 'Job not found');
  const job = JSON.parse(await object.text()) as ClassroomGenerationJob;
  if (job.ownerId !== ownerId) return apiError('INVALID_REQUEST', 404, 'Job not found');
  if (job.status === 'succeeded')
    return apiError('INVALID_REQUEST', 409, 'Course is already complete');
  const accepted = () => apiSuccess({ jobId: id, pollUrl: `/api/generate-classroom/${id}` }, 202);
  if (job.status !== 'failed' && !isGenerationJobStale(job)) return accepted();
  if (!(await canRetryGenerationJob(env.CLASSROOM_BUCKET, id)))
    return apiError('INVALID_REQUEST', 409, '历史任务未保存完整需求或断点，请重新创建课程');
  const queued: ClassroomGenerationJob = {
    ...job,
    status: 'queued',
    step: 'queued',
    message: '重试已提交，等待继续生成',
    error: undefined,
    completedAt: undefined,
    updatedAt: new Date().toISOString(),
    retryable: true,
    retryCount: (job.retryCount || 0) + 1,
  };
  const saved = await env.CLASSROOM_BUCKET.put(key, JSON.stringify(queued), {
    onlyIf: new Headers({ 'If-Match': `"${object.etag}"` }),
  });
  if (!saved) return apiError('INVALID_REQUEST', 409, '任务状态已更新，请刷新后重试');
  try {
    await indexGenerationJob(env.CLASSROOM_BUCKET, queued);
    await env.CLASSROOM_QUEUE.send({
      kind: 'classroom-retry',
      jobId: id,
      attempt: queued.retryCount,
    });
  } catch {
    // Do not undo a newer consumer update if dispatch had an uncertain outcome.
    const current = await env.CLASSROOM_BUCKET.get(key);
    const state = current ? (JSON.parse(await current.text()) as ClassroomGenerationJob) : null;
    if (state?.status === 'queued' && state.retryCount === queued.retryCount) {
      const failed: ClassroomGenerationJob = {
        ...queued,
        status: 'failed',
        error: '重试任务提交失败，请稍后再试',
      };
      if (
        await env.CLASSROOM_BUCKET.put(key, JSON.stringify(failed), {
          onlyIf: new Headers({ 'If-Match': `"${current!.etag}"` }),
        })
      )
        await indexGenerationJob(env.CLASSROOM_BUCKET, failed);
    }
    return apiError('INTERNAL_ERROR', 503, '重试任务提交失败，请稍后再试');
  }
  return accepted();
}

async function queuedTTS(request: Request, env: WebEnv) {
  const body = await readSmallBody(request);
  if (body instanceof Response) return body;
  const jobId = crypto.randomUUID();
  await env.CLASSROOM_QUEUE.send({ kind: 'tts', jobId, body });
  // Preserve the existing API contract. Waiting on timers/R2 is wall time,
  // not CPU; provider calls, audio conversion and JSON encoding stay in Queue.
  for (let attempt = 0; attempt < 15; attempt++) {
    if (request.signal.aborted) break;
    const object = await env.CLASSROOM_BUCKET.get(`tts-jobs/${jobId}.json`);
    if (object)
      return new Response(object.body, {
        status: Number(object.customMetadata?.status || '200'),
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return apiError('UPSTREAM_ERROR', 504, 'TTS queue timed out; please retry');
}

async function route(request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/auth/login') return startFeishuLogin();
  if (pathname === '/auth/callback') return finishFeishuLogin(request);
  const session = await getFeishuSession(request);
  if (isFeishuAuthRequired()) {
    if (!isFeishuAuthConfigured())
      return new Response('Feishu login is not configured', { status: 503 });
    if (!session) {
      return pathname.startsWith('/api/')
        ? apiError('UNAUTHENTICATED', 401, 'Feishu login required')
        : new Response(null, {
            status: 302,
            headers: { Location: '/auth/login', 'Cache-Control': 'no-store' },
          });
    }
  }
  const ownerId = session ? await feishuAccountId(session.sub) : null;
  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.headers.has('origin') &&
    request.headers.get('origin') !== url.origin
  )
    return apiError('INVALID_REQUEST', 403, 'Cross-origin write is not allowed');
  if (pathname === '/api/account/courses' && request.method === 'GET') {
    if (!ownerId) return apiError('UNAUTHENTICATED', 401, 'Feishu login required');
    const cursor = url.searchParams.get('cursor') || undefined;
    if (cursor && cursor.length > 2048) return apiError('INVALID_REQUEST', 400, 'Invalid cursor');
    return apiSuccess(await listAccountCourses(env.CLASSROOM_BUCKET, ownerId, cursor));
  }
  if (pathname === '/api/account/jobs' && request.method === 'GET') {
    if (!ownerId) return apiError('UNAUTHENTICATED', 401, 'Feishu login required');
    const cursor = url.searchParams.get('cursor') || undefined;
    if (cursor && cursor.length > 2048) return apiError('INVALID_REQUEST', 400, 'Invalid cursor');
    return apiSuccess(await listGenerationJobs(env.CLASSROOM_BUCKET, ownerId, cursor));
  }
  const progressPath = /^\/api\/account\/courses\/([\w-]{1,64})\/progress$/.exec(pathname);
  if (progressPath) {
    if (!ownerId) return apiError('UNAUTHENTICATED', 401, 'Feishu login required');
    const id = progressPath[1];
    if (!(await ownsCourse(env.CLASSROOM_BUCKET, ownerId, id)))
      return apiError('INVALID_REQUEST', 404, 'Course not found');
    if (request.method === 'GET')
      return apiSuccess({ cursor: await readProgress(env.CLASSROOM_BUCKET, ownerId, id) });
    if (request.method === 'PUT') {
      const body = await readSmallBody(request);
      if (body instanceof Response) return body;
      let cursor: unknown;
      try {
        cursor = JSON.parse(body);
      } catch {
        return apiError('INVALID_REQUEST', 400, 'Invalid JSON');
      }
      if (!validProgress(cursor)) return apiError('INVALID_REQUEST', 400, 'Invalid progress');
      return apiSuccess({
        cursor: await writeProgress(
          env.CLASSROOM_BUCKET,
          ownerId,
          id,
          { sceneId: cursor.sceneId, actionIndex: cursor.actionIndex, updatedAt: cursor.updatedAt },
          request.headers.get('if-none-match') === '*',
        ),
      });
    }
    if (request.method === 'DELETE') {
      await deleteProgress(env.CLASSROOM_BUCKET, ownerId, id);
      return apiSuccess({ cursor: null });
    }
    return apiError('INVALID_REQUEST', 405, 'Method not allowed');
  }
  if ((pathname === '/api/account' || pathname === '/account') && request.method === 'GET') {
    if (!session) return apiError('UNAUTHENTICATED', 401, 'Feishu login required');
    const accountId = await feishuAccountId(session.sub);
    if (pathname === '/account')
      return new Response(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>当前学习账号</title><body><h1>当前学习账号</h1><p>已通过飞书登录</p><p id="account-id">${accountId}</p><a href="/learn">我的课程</a></body></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    return apiSuccess({ accountId });
  }
  if (pathname.startsWith('/__worker-pages/')) return new Response('Not found', { status: 404 });
  const classroomPath = /^\/classroom\/([a-zA-Z0-9_-]{1,64})$/.exec(pathname);
  if (classroomPath)
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/worker-classroom?id=${classroomPath[1]}`,
        'Cache-Control': 'no-store',
      },
    });
  const page = pageNames[pathname];
  if (page && request.method === 'GET') {
    const isRsc = request.headers.get('rsc') === '1';
    const assetUrl = new URL(`/__worker-pages/${page}.${isRsc ? 'rsc' : 'html'}`, url.origin);
    const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
    const headers = new Headers(asset.headers);
    headers.set('Content-Type', isRsc ? 'text/x-component' : 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Vary', 'RSC, Next-Router-State-Tree, Next-Router-Prefetch');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    headers.set('Content-Security-Policy', "frame-ancestors 'self'");
    return new Response(asset.body, { status: asset.status, headers });
  }
  if (pathname === '/api/server-providers' && request.method === 'GET') return serverProviders();
  // These capability checks run on page load even when the features are off.
  if (request.method === 'GET') {
    if (pathname === '/api/access-code/status' && !process.env.ACCESS_CODE)
      return apiSuccess({ enabled: false, authenticated: false });
    if (pathname === '/api/export-video/capability' && !process.env.RENDER_SERVICE_URL)
      return apiSuccess({ enabled: false });
  }
  if (pathname === '/api/generate/tts' && request.method === 'POST') return queuedTTS(request, env);
  if (pathname === '/api/generate/image' && request.method === 'POST')
    return generateImage(request);
  if (pathname === '/api/generate-classroom' && request.method === 'POST')
    return ownerId
      ? createJob(request, env, url, ownerId)
      : apiError('UNAUTHENTICATED', 401, 'Feishu login required');
  const retryPath = /^\/api\/generate-classroom\/([a-zA-Z0-9_-]{1,64})\/retry$/.exec(pathname);
  if (retryPath && request.method === 'POST')
    return ownerId
      ? retryJob(env, retryPath[1], ownerId)
      : apiError('UNAUTHENTICATED', 401, 'Feishu login required');
  const jobPath = /^\/api\/generate-classroom\/([a-zA-Z0-9_-]{1,64})$/.exec(pathname);
  if (jobPath && request.method === 'GET') {
    const object = await env.CLASSROOM_BUCKET.get(`jobs/${jobPath[1]}.json`);
    if (!object) return apiError('INVALID_REQUEST', 404, 'Job not found');
    const job: ClassroomGenerationJob = JSON.parse(await object.text());
    if (!ownerId || job.ownerId !== ownerId)
      return apiError('INVALID_REQUEST', 404, 'Job not found');
    // A hard runtime termination cannot write a failure. Do not animate/poll forever.
    if (isGenerationJobStale(job)) {
      job.status = 'failed';
      job.step = 'failed';
      job.error = STALE_GENERATION_ERROR;
      job.message = job.error;
    }
    return apiSuccess({
      ...job,
      jobId: job.id,
      done: job.status === 'succeeded' || job.status === 'failed',
      pollIntervalMs: 5000,
      canRetry:
        job.status === 'failed' && (await canRetryGenerationJob(env.CLASSROOM_BUCKET, jobPath[1])),
    });
  }
  if (pathname === '/api/classroom' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!validId(id)) return apiError('INVALID_REQUEST', 400, 'Invalid classroom id');
    if (!ownerId || !(await ownsCourse(env.CLASSROOM_BUCKET, ownerId, id)))
      return apiError('INVALID_REQUEST', 404, 'Classroom not found');
    const object = await env.CLASSROOM_BUCKET.get(`classrooms/${id}/published.json`);
    if (object)
      return new Response(object.body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    if (!(await env.CLASSROOM_BUCKET.head(`classrooms/${id}.json`)))
      return apiError('INVALID_REQUEST', 404, 'Classroom not found');
    await env.CLASSROOM_QUEUE.send({ kind: 'publish-classroom', classroomId: id });
    return Response.json(
      { success: false, error: 'Preparing legacy classroom' },
      { status: 503, headers: { 'Retry-After': '2' } },
    );
  }
  const mediaPath = /^\/api\/classroom-media\/([a-zA-Z0-9_-]{1,64})\/(audio|media)\/(.+)$/.exec(
    pathname,
  );
  if (mediaPath && (request.method === 'GET' || request.method === 'HEAD')) {
    if (!ownerId || !(await ownsCourse(env.CLASSROOM_BUCKET, ownerId, mediaPath[1])))
      return apiError('ASSET_NOT_FOUND', 404, 'Media not found');
    let file: string;
    try {
      file = decodeURIComponent(mediaPath[3]);
    } catch {
      return apiError('INVALID_REQUEST', 400, 'Invalid media path');
    }
    if (file.includes('..') || /[\x00\\]/.test(file))
      return apiError('INVALID_REQUEST', 400, 'Invalid media path');
    const key = `classrooms/${mediaPath[1]}/${mediaPath[2]}/${file}`;
    const metadata = await env.CLASSROOM_BUCKET.head(key);
    if (!metadata) return apiError('ASSET_NOT_FOUND', 404, 'Media not found');
    const range = parseRangeHeader(request.headers.get('range'), metadata.size);
    if (range.kind === 'unsatisfiable')
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${metadata.size}` },
      });
    const partial = range.kind === 'range';
    const object =
      request.method === 'HEAD'
        ? null
        : await env.CLASSROOM_BUCKET.get(
            key,
            partial
              ? { range: { offset: range.start, length: range.end - range.start + 1 } }
              : undefined,
          );
    if (request.method !== 'HEAD' && !object)
      return apiError('ASSET_NOT_FOUND', 404, 'Media not found');
    return new Response(object?.body || null, {
      status: partial ? 206 : 200,
      headers: {
        'Content-Type':
          mime[file.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream',
        'Content-Length': String(partial ? range.end - range.start + 1 : metadata.size),
        'Cache-Control': 'private, no-store',
        'Accept-Ranges': 'bytes',
        ...(partial
          ? { 'Content-Range': `bytes ${range.start}-${range.end}/${metadata.size}` }
          : {}),
      },
    });
  }
  // The legacy create route has no account ownership contract. Never bypass the Queue path.
  if (pathname === '/api/classroom')
    return apiError('INVALID_REQUEST', 405, 'Use account-scoped course generation');
  // Next's compatibility router may accept aliases that did not match our
  // handlers. Never forward any spelling of an account-sensitive endpoint.
  let legacyPath: string;
  try {
    legacyPath = decodeURIComponent(pathname).replace(/\/+/g, '/');
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid path');
  }
  if (/^\/api\/(classroom|classroom-media|generate-classroom|account)(\/|$)/i.test(legacyPath))
    return apiError('INVALID_REQUEST', 404, 'Not found');
  // Non-core APIs retain their existing behavior in a separate isolate.
  const response = await env.LEGACY_APP.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('X-Learning-Runtime', 'legacy');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: WebEnv) {
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store');
      if (!headers.has('X-Learning-Runtime')) headers.set('X-Learning-Runtime', 'lite');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      console.error(
        JSON.stringify({
          message: 'Lightweight request failed',
          path: new URL(request.url).pathname,
        }),
      );
      return apiError('INTERNAL_ERROR', 500, 'Request failed');
    }
  },
};
