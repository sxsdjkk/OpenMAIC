import { afterEach, expect, it, vi } from 'vitest';
import {
  listCloudCourses,
  listCloudGenerationJobs,
  retryCloudGenerationJob,
  loadCloudCursor,
  saveCloudCursor,
} from '@/lib/classroom/worker-account';
import { loadCursor, saveCursor, clearCursor } from '@/lib/playback/cursor';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('paginates the cloud catalog independently of the browser library', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ courses: [{ id: 'old', updatedAt: 1 }], cursor: 'next' }),
    )
    .mockResolvedValueOnce(Response.json({ courses: [{ id: 'new', updatedAt: 2 }], cursor: null }));
  vi.stubGlobal('fetch', fetch);
  expect((await listCloudCourses()).map((course) => course.id)).toEqual(['new', 'old']);
  expect(fetch.mock.calls[1][0]).toContain('cursor=next');
});

it('loads, saves and clears worker cursors through the authenticated cloud, without opening device storage', async () => {
  vi.stubEnv('NEXT_PUBLIC_WORKERS_ACCOUNT', '1');
  const cursor = { sceneId: 's2', actionIndex: 3, updatedAt: new Date().toISOString() };
  const fetch = vi.fn().mockImplementation(async () => Response.json({ cursor }));
  vi.stubGlobal('fetch', fetch);
  expect(await loadCursor('course1')).toEqual(cursor);
  await saveCursor('course1', cursor);
  await clearCursor('course1');
  expect(fetch.mock.calls.map(([, init]) => init.method || 'GET')).toEqual([
    'GET',
    'PUT',
    'DELETE',
  ]);
});

it('never falls back to another account cache after authorization/network failure', async () => {
  vi.stubEnv('NEXT_PUBLIC_WORKERS_ACCOUNT', '1');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not found', { status: 404 })));
  await expect(loadCursor('foreign-course')).rejects.toThrow('404');
  await expect(listCloudCourses()).rejects.toThrow('404');
});

it('imports local progress only-if-absent rather than overwriting a concurrent cloud cursor', async () => {
  const cursor = { sceneId: 's1', actionIndex: 0, updatedAt: new Date().toISOString() };
  const fetch = vi.fn().mockImplementation(async () => Response.json({ cursor }));
  vi.stubGlobal('fetch', fetch);
  await saveCloudCursor('course1', cursor, true);
  expect(fetch.mock.calls[0][1].headers['If-None-Match']).toBe('*');
  expect(await loadCloudCursor('course1')).toEqual(cursor);
});

it('paginates generation history and submits retries without client ownership or provider keys', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ jobs: [{ id: 'old', updatedAt: '2026-09-29T00:00:00Z' }], cursor: 'next' }),
    )
    .mockResolvedValueOnce(
      Response.json({ jobs: [{ id: 'new', updatedAt: '2026-09-30T00:00:00Z' }], cursor: null }),
    )
    .mockResolvedValueOnce(Response.json({ jobId: 'new' }, { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  expect((await listCloudGenerationJobs()).map((job) => job.id)).toEqual(['new', 'old']);
  expect(fetch.mock.calls[1][0]).toContain('cursor=next');
  expect(await retryCloudGenerationJob('new')).toEqual({ jobId: 'new' });
  expect(fetch.mock.calls[2]).toEqual([
    '/api/generate-classroom/new/retry',
    { method: 'POST', cache: 'no-store' },
  ]);
});

it('surfaces retry failures rather than treating a rejected task as submitted', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error: '请重新创建课程' }, { status: 409 })),
  );
  await expect(retryCloudGenerationJob('old')).rejects.toThrow('请重新创建课程');
});
