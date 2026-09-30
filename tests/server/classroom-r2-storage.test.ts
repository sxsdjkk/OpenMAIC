import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassroomBucket } from '@/lib/server/classroom-storage';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Workers classroom R2 storage', () => {
  it('reserves, publishes, and reads classroom JSON without touching disk', async () => {
    vi.stubEnv('CLOUDFLARE_WORKERS', '1');
    const storage = await import('@/lib/server/classroom-storage');
    const objects = new Map<string, string | Uint8Array>();
    const bucket: ClassroomBucket = {
      async get(key) {
        const value = objects.get(key);
        if (value === undefined) return null;
        return { text: async () => String(value), body: new ReadableStream() };
      },
      async head(key) {
        const value = objects.get(key);
        return value === undefined ? null : { size: String(value).length };
      },
      async put(key, value, options) {
        if (options?.onlyIf && objects.has(key)) return null;
        objects.set(key, value);
        return {};
      },
      async delete(key) {
        objects.delete(key);
      },
    };

    await storage.runWithClassroomBucket(bucket, async () => {
      await storage.reserveClassroom('r2test1234', {} as never);
      expect(await storage.readClassroom('r2test1234')).toBeNull();
      await expect(storage.reserveClassroom('r2test1234', {} as never)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      await storage.persistClassroom(
        { id: 'r2test1234', stage: {} as never, scenes: [] },
        'https://example.com',
      );
      expect(await storage.readClassroom('r2test1234')).toMatchObject({ id: 'r2test1234' });
      await storage.writeClassroomMedia('r2test1234', 'audio', 'clip.mp3', new Uint8Array([1, 2]));
      await storage.publishClassroomReadView({
        id: 'sanitized123',
        createdAt: new Date().toISOString(),
        stage: {} as never,
        scenes: [
          { type: 'text', content: '<p onclick="bad()">safe</p><script>bad()</script>' },
        ] as never,
      });
    });

    expect(objects.has('classrooms/r2test1234.json')).toBe(true);
    expect(JSON.parse(String(objects.get('classrooms/r2test1234/published.json')))).toMatchObject({
      success: true,
      classroom: { id: 'r2test1234', scenes: [] },
    });
    expect(objects.get('classrooms/r2test1234/audio/clip.mp3')).toEqual(new Uint8Array([1, 2]));
    const published = String(objects.get('classrooms/sanitized123/published.json'));
    expect(published).toContain('<p>safe</p>');
    expect(published).not.toMatch(/onclick|<script/);
  });
});
