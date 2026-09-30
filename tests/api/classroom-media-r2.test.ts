import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const bucket = vi.hoisted(() => ({
  head: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  CLASSROOMS_DIR: '/unused',
  isValidClassroomId: () => true,
  getClassroomBucket: async () => bucket,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  bucket.head.mockReset();
  bucket.get.mockReset();
});

it('serves a ranged R2 audio object for classroom playback', async () => {
  vi.stubEnv('CLOUDFLARE_WORKERS', '1');
  const key = 'classrooms/abc123/audio/clip.mp3';
  bucket.head.mockResolvedValue({ size: 4 });
  bucket.get.mockResolvedValue({
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([2, 3]));
        controller.close();
      },
    }),
  });

  const { GET } = await import('@/app/api/classroom-media/[classroomId]/[...path]/route');
  const response = await GET(
    new NextRequest('http://localhost/api/classroom-media/abc123/audio/clip.mp3', {
      headers: { range: 'bytes=1-2' },
    }),
    { params: Promise.resolve({ classroomId: 'abc123', path: ['audio', 'clip.mp3'] }) },
  );

  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
  expect(response.headers.get('content-type')).toBe('audio/mpeg');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([2, 3]));
  expect(bucket.get).toHaveBeenCalledWith(key, { range: { offset: 1, length: 2 } });
});
