import {
  finishFeishuLogin,
  getFeishuSession,
  isFeishuAuthConfigured,
  isFeishuAuthRequired,
  startFeishuLogin,
} from '../lib/server/feishu-auth';
import { parseRangeHeader } from '../lib/server/http-range';
import { apiError, apiSuccess } from '../lib/server/api-response';
import { GET as serverProviders } from '../app/api/server-providers/route';
import { POST as generateImage } from '../app/api/generate/image/route';
import type { GenerateClassroomInput } from '../lib/server/classroom-generation';
import type { ClassroomGenerationJob } from '../lib/server/classroom-job-store';
import type { ClassroomBucket } from '../lib/server/classroom-storage';

interface WebEnv {
  CLASSROOM_BUCKET: ClassroomBucket;
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

async function createJob(request: Request, env: WebEnv, url: URL) {
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
  await env.CLASSROOM_BUCKET.put(`jobs/${jobId}.json`, JSON.stringify(job));
  try {
    await env.CLASSROOM_QUEUE.send({ jobId, input, baseUrl: url.origin });
  } catch {
    await env.CLASSROOM_BUCKET.put(
      `jobs/${jobId}.json`,
      JSON.stringify({
        ...job,
        status: 'failed',
        step: 'failed',
        error: 'Queue submission failed',
      }),
    );
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
  const pathname = url.pathname;
  if (pathname === '/auth/login') return startFeishuLogin();
  if (pathname === '/auth/callback') return finishFeishuLogin(request);
  if (isFeishuAuthRequired()) {
    if (!isFeishuAuthConfigured())
      return new Response('Feishu login is not configured', { status: 503 });
    if (!(await getFeishuSession(request))) {
      return pathname.startsWith('/api/')
        ? apiError('UNAUTHENTICATED', 401, 'Feishu login required')
        : new Response(null, {
            status: 302,
            headers: { Location: '/auth/login', 'Cache-Control': 'no-store' },
          });
    }
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
    return createJob(request, env, url);
  const jobPath = /^\/api\/generate-classroom\/([a-zA-Z0-9_-]{1,64})$/.exec(pathname);
  if (jobPath && request.method === 'GET') {
    const object = await env.CLASSROOM_BUCKET.get(`jobs/${jobPath[1]}.json`);
    if (!object) return apiError('INVALID_REQUEST', 404, 'Job not found');
    const job: ClassroomGenerationJob = JSON.parse(await object.text());
    return apiSuccess({
      ...job,
      jobId: job.id,
      done: job.status === 'succeeded' || job.status === 'failed',
      pollIntervalMs: 5000,
    });
  }
  if (pathname === '/api/classroom' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!validId(id)) return apiError('INVALID_REQUEST', 400, 'Invalid classroom id');
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
        'Cache-Control': 'private, max-age=86400, immutable',
        'Accept-Ranges': 'bytes',
        ...(partial
          ? { 'Content-Range': `bytes ${range.start}-${range.end}/${metadata.size}` }
          : {}),
      },
    });
  }
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
