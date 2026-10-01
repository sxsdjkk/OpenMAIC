import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '@/workers/web';
import { createFeishuSession, feishuAccountId } from '@/lib/server/feishu-auth';

describe('lightweight Workers entry', () => {
  let cookie: string;
  let ownerId: string;
  const env = {
    CLASSROOM_BUCKET: { get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() },
    CLASSROOM_QUEUE: { send: vi.fn() },
    ASSETS: { fetch: vi.fn() },
    LEGACY_APP: { fetch: vi.fn() },
  };
  const request = (path: string, init: RequestInit = {}) =>
    new Request(`https://example.com${path}`, {
      ...init,
      headers: { cookie, ...init.headers },
    });

  beforeEach(async () => {
    vi.stubEnv('FEISHU_AUTH_REQUIRED', '1');
    vi.stubEnv('FEISHU_APP_ID', 'test-app');
    vi.stubEnv('FEISHU_APP_SECRET', 'test-app-secret');
    vi.stubEnv('AUTH_SESSION_SECRET', 'test-session-secret');
    vi.stubEnv('FEISHU_REDIRECT_URI', 'https://example.com/auth/callback');
    cookie = (await createFeishuSession({ open_id: 'test-user' }, 'test-session-secret')).split(
      ';',
    )[0];
    vi.resetAllMocks();
    ownerId = await feishuAccountId('test-user');
    env.CLASSROOM_BUCKET.get.mockResolvedValue(null);
    env.CLASSROOM_BUCKET.head.mockImplementation(async (key: string) =>
      key.startsWith('course-owners/') ? { size: 100, customMetadata: { ownerId } } : null,
    );
    env.CLASSROOM_BUCKET.list.mockResolvedValue({ objects: [], truncated: false });
    env.CLASSROOM_BUCKET.put.mockResolvedValue({});
    env.ASSETS.fetch.mockImplementation(async () => new Response('<html>static</html>'));
    env.LEGACY_APP.fetch.mockResolvedValue(new Response('legacy'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('protects pages and APIs without invoking the legacy runtime', async () => {
    const page = await worker.fetch(new Request('https://example.com/'), env);
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/auth/login');
    expect(
      (await worker.fetch(new Request('https://example.com/api/classroom?id=demo'), env)).status,
    ).toBe(401);
    expect(env.LEGACY_APP.fetch).not.toHaveBeenCalled();
    expect(env.CLASSROOM_BUCKET.get).not.toHaveBeenCalled();
  });

  it('identifies the authenticated account without exposing its Feishu id', async () => {
    const response = await worker.fetch(request('/api/account'), env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accountId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain('test-user');
    expect((await worker.fetch(new Request('https://example.com/api/account'), env)).status).toBe(
      401,
    );
  });

  it('serves authenticated static HTML and RSC, blocking raw private pages', async () => {
    const page = await worker.fetch(request('/'), env);
    expect(await page.text()).toContain('static');
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(page.headers.get('x-learning-runtime')).toBe('lite');
    expect(env.ASSETS.fetch.mock.calls[0][0].url).toBe(
      'https://example.com/__worker-pages/index.html',
    );
    const rsc = await worker.fetch(request('/learn', { headers: { rsc: '1' } }), env);
    expect(rsc.headers.get('content-type')).toBe('text/x-component');
    expect(env.ASSETS.fetch.mock.calls[1][0].url).toBe(
      'https://example.com/__worker-pages/learn.rsc',
    );
    expect((await worker.fetch(request('/__worker-pages/index.html'), env)).status).toBe(404);
    expect(env.LEGACY_APP.fetch).not.toHaveBeenCalled();
  });

  it('keeps existing classroom links usable', async () => {
    const page = await worker.fetch(request('/classroom/course_123'), env);
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/worker-classroom?id=course_123');
  });

  it('streams the pre-sanitized classroom without parsing it', async () => {
    const text = vi.fn();
    env.CLASSROOM_BUCKET.get.mockResolvedValue({
      body: new Response('{"success":true}').body,
      text,
    });
    const response = await worker.fetch(request('/api/classroom?id=course_123'), env);
    expect(await response.json()).toEqual({ success: true });
    expect(text).not.toHaveBeenCalled();
    expect(env.CLASSROOM_BUCKET.get).toHaveBeenCalledWith('classrooms/course_123/published.json');
  });

  it('prepares legacy classrooms in Queue rather than in the HTTP request', async () => {
    env.CLASSROOM_BUCKET.head.mockResolvedValue({ size: 123, customMetadata: { ownerId } });
    const response = await worker.fetch(request('/api/classroom?id=course_123'), env);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(env.CLASSROOM_QUEUE.send).toHaveBeenCalledWith({
      kind: 'publish-classroom',
      classroomId: 'course_123',
    });
    expect((await worker.fetch(request('/api/classroom?id=../bad'), env)).status).toBe(400);
  });

  it('queues a bounded course input without forwarding client service keys', async () => {
    const response = await worker.fetch(
      request('/api/generate-classroom', {
        method: 'POST',
        body: JSON.stringify({
          requirement: 'learn math',
          enableTTS: true,
          apiKey: 'do-not-forward',
          ownerId: 'spoofed-owner',
        }),
      }),
      env,
    );
    expect(response.status).toBe(202);
    const job = await response.json();
    expect(job.jobId).toBeTruthy();
    expect(env.CLASSROOM_QUEUE.send.mock.calls[0][0]).toMatchObject({
      input: { requirement: 'learn math', enableTTS: true },
      baseUrl: 'https://example.com',
    });
    expect(JSON.stringify(env.CLASSROOM_QUEUE.send.mock.calls)).not.toContain('do-not-forward');
    expect(JSON.parse(env.CLASSROOM_BUCKET.put.mock.calls[0][1]).ownerId).toBe(ownerId);
    expect(env.CLASSROOM_BUCKET.put).toHaveBeenCalledWith(
      `jobs/${job.jobId}.json`,
      expect.any(String),
    );
  });

  it('rejects oversized, malformed and unsupported inputs before queuing', async () => {
    for (const [body, status] of [
      ['x'.repeat(24001), 413],
      ['{', 400],
      ['{}', 400],
      [JSON.stringify({ requirement: 'learn', pdfContent: {} }), 400],
    ] as const) {
      expect(
        (await worker.fetch(request('/api/generate-classroom', { method: 'POST', body }), env))
          .status,
      ).toBe(status);
    }
    expect(env.CLASSROOM_QUEUE.send).not.toHaveBeenCalled();
  });

  it('marks queue-submission failures as failed rather than leaving a queued job', async () => {
    env.CLASSROOM_QUEUE.send.mockRejectedValue(new Error('Queue down'));
    expect(
      (
        await worker.fetch(
          request('/api/generate-classroom', {
            method: 'POST',
            body: JSON.stringify({ requirement: 'learn' }),
          }),
          env,
        )
      ).status,
    ).toBe(503);
    expect(JSON.parse(env.CLASSROOM_BUCKET.put.mock.calls[1][1]).status).toBe('failed');
  });

  it('reads small job status objects without running the generation code', async () => {
    env.CLASSROOM_BUCKET.get.mockResolvedValue({
      text: async () =>
        JSON.stringify({ id: 'job123', ownerId, status: 'succeeded', classroomId: 'course123' }),
    });
    expect(
      await (await worker.fetch(request('/api/generate-classroom/job123'), env)).json(),
    ).toMatchObject({ success: true, done: true, classroomId: 'course123' });
    expect(env.LEGACY_APP.fetch).not.toHaveBeenCalled();
  });

  it('streams byte ranges and HEAD without buffering audio', async () => {
    env.CLASSROOM_BUCKET.head.mockResolvedValue({ size: 100, customMetadata: { ownerId } });
    env.CLASSROOM_BUCKET.get.mockResolvedValue({ body: new Response(new Uint8Array([1, 2])).body });
    const response = await worker.fetch(
      request('/api/classroom-media/course123/audio/clip.mp3', { headers: { range: 'bytes=0-1' } }),
      env,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1/100');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(env.CLASSROOM_BUCKET.get).toHaveBeenCalledWith('classrooms/course123/audio/clip.mp3', {
      range: { offset: 0, length: 2 },
    });
    env.CLASSROOM_BUCKET.get.mockClear();
    expect(
      (
        await worker.fetch(
          request('/api/classroom-media/course123/audio/clip.mp3', { method: 'HEAD' }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(env.CLASSROOM_BUCKET.get).not.toHaveBeenCalled();
    expect(
      (
        await worker.fetch(
          request('/api/classroom-media/course123/audio/clip.mp3', {
            headers: { range: 'bytes=100-' },
          }),
          env,
        )
      ).status,
    ).toBe(416);
    expect(
      (await worker.fetch(request('/api/classroom-media/course123/audio/%2e%2e%2fsecret'), env))
        .status,
    ).toBe(400);
  });

  it('preserves non-core APIs through the private compatibility binding', async () => {
    const original = request('/api/verify-model', { method: 'POST', body: '{}' });
    const response = await worker.fetch(original, env);
    expect(await response.text()).toBe('legacy');
    expect(response.headers.get('x-learning-runtime')).toBe('legacy');
    expect(env.LEGACY_APP.fetch).toHaveBeenCalledWith(original);
  });

  it('answers disabled capability probes without starting the compatibility runtime', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('RENDER_SERVICE_URL', '');
    for (const path of ['/api/access-code/status', '/api/export-video/capability']) {
      expect(await (await worker.fetch(request(path), env)).json()).toMatchObject({
        success: true,
        enabled: false,
      });
    }
    expect(env.LEGACY_APP.fetch).not.toHaveBeenCalled();
  });

  it('returns clip counts and terminates a stale job instead of an endless progress bar', async () => {
    const job = {
      ownerId,
      status: 'running',
      updatedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      progress: 86,
      scenesGenerated: 12,
      totalScenes: 12,
      ttsGenerated: 24,
      totalTts: 48,
    };
    env.CLASSROOM_BUCKET.get.mockResolvedValue({ text: async () => JSON.stringify(job) });
    const response = await worker.fetch(request('/api/generate-classroom/job1'), env);
    expect(await response.json()).toMatchObject({
      success: true,
      done: true,
      status: 'failed',
      progress: 86,
      ttsGenerated: 24,
      totalTts: 48,
      error: expect.stringContaining('长时间没有进展'),
    });
    expect(env.CLASSROOM_BUCKET.put).not.toHaveBeenCalled();
  });

  it('streams queued TTS results without parsing or generating audio in HTTP', async () => {
    const text = vi.fn();
    env.CLASSROOM_BUCKET.get.mockResolvedValue({
      body: new Response('{"success":true,"base64":"demo"}').body,
      customMetadata: { status: '200' },
      text,
    });
    const response = await worker.fetch(
      request('/api/generate/tts', { method: 'POST', body: '{"text":"hello"}' }),
      env,
    );
    expect(await response.json()).toMatchObject({ success: true, base64: 'demo' });
    expect(env.CLASSROOM_QUEUE.send).toHaveBeenCalledWith({
      kind: 'tts',
      jobId: expect.any(String),
      body: '{"text":"hello"}',
    });
    expect(text).not.toHaveBeenCalled();
    expect(env.LEGACY_APP.fetch).not.toHaveBeenCalled();
  });

  it('isolates catalog, course, media, progress and job status by account', async () => {
    env.CLASSROOM_BUCKET.head.mockResolvedValue({
      size: 100,
      customMetadata: { ownerId: 'other' },
    });
    env.CLASSROOM_BUCKET.get.mockResolvedValue({
      text: async () => JSON.stringify({ ownerId: 'other' }),
    });
    for (const path of [
      '/api/classroom?id=course1',
      '/api/classroom-media/course1/audio/a.mp3',
      '/api/account/courses/course1/progress',
      '/api/generate-classroom/job1',
    ]) {
      expect((await worker.fetch(request(path), env)).status).toBe(404);
    }
    await worker.fetch(request('/api/account/courses?cursor=next'), env);
    expect(env.CLASSROOM_BUCKET.list).toHaveBeenCalledWith({
      prefix: `accounts/${ownerId}/courses/`,
      include: ['customMetadata'],
      limit: 100,
      cursor: 'next',
    });
    expect(env.LEGACY_APP.fetch).not.toHaveBeenCalled();
  });

  it('validates cloud progress and rejects cross-origin writes and legacy ownership bypass', async () => {
    const path = '/api/account/courses/course1/progress';
    for (const body of [
      '{',
      '{}',
      JSON.stringify({ sceneId: 's1', actionIndex: -1, updatedAt: 'bad' }),
    ])
      expect((await worker.fetch(request(path, { method: 'PUT', body }), env)).status).toBe(400);
    const cursor = { sceneId: 's1', actionIndex: 2, updatedAt: new Date().toISOString() };
    const response = await worker.fetch(
      request(path, { method: 'PUT', body: JSON.stringify(cursor) }),
      env,
    );
    expect(await response.json()).toMatchObject({ cursor });
    expect(env.CLASSROOM_BUCKET.put.mock.calls[0][0]).toBe(
      `accounts/${ownerId}/progress/course1.json`,
    );
    expect(
      (
        await worker.fetch(
          request(path, { method: 'PUT', headers: { origin: 'https://attacker.com' }, body: '{}' }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (await worker.fetch(request('/api/classroom', { method: 'POST', body: '{}' }), env)).status,
    ).toBe(405);
  });

  it('does not allow compatibility route aliases to bypass account ownership', async () => {
    env.CLASSROOM_BUCKET.head.mockResolvedValue({
      size: 100,
      customMetadata: { ownerId: 'other' },
    });
    for (const path of [
      '/api/classroom/?id=course1',
      '/api/classroom////?id=course1',
      '/api/%63lassroom?id=course1',
      '/api/Classroom?id=course1',
      '/api//classroom?id=course1',
      '/api/%63lassroom-media/course1/audio/a.mp3',
      '/api/Generate-Classroom/job1',
      '/api/Account/courses',
    ]) {
      expect((await worker.fetch(request(path), env)).status).toBe(404);
    }
    expect(env.LEGACY_APP.fetch).not.toHaveBeenCalled();
  });

  it('preserves TTS provider errors and bounds waiting for Queue', async () => {
    env.CLASSROOM_BUCKET.get.mockResolvedValueOnce({
      body: new Response('{"errorCode":"RATE_LIMITED"}').body,
      customMetadata: { status: '429' },
    });
    expect(
      (await worker.fetch(request('/api/generate/tts', { method: 'POST', body: '{}' }), env))
        .status,
    ).toBe(429);
    vi.useFakeTimers();
    const pending = worker.fetch(request('/api/generate/tts', { method: 'POST', body: '{}' }), env);
    await vi.waitFor(() => expect(env.CLASSROOM_QUEUE.send).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(30000);
    expect((await pending).status).toBe(504);
  });
});
