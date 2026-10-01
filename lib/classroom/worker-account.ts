import type { StageListItem } from '@/lib/utils/stage-storage';
import type { PlaybackCursor } from '@/lib/playback/cursor';

export const isWorkerAccountEnabled = () => process.env.NEXT_PUBLIC_WORKERS_ACCOUNT === '1';

export async function accountRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init });
  if (!response.ok) throw new Error(`Account request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export async function listCloudCourses(): Promise<StageListItem[]> {
  const courses: StageListItem[] = [];
  let cursor: string | null = null;
  do {
    const page: { courses: StageListItem[]; cursor: string | null } = await accountRequest(
      `/api/account/courses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    courses.push(...page.courses);
    cursor = page.cursor;
  } while (cursor);
  return courses.sort((a, b) => b.updatedAt - a.updatedAt);
}

const progressPath = (id: string) => `/api/account/courses/${encodeURIComponent(id)}/progress`;
export async function loadCloudCursor(id: string) {
  return (await accountRequest<{ cursor: PlaybackCursor | null }>(progressPath(id))).cursor;
}

export async function saveCloudCursor(id: string, cursor: PlaybackCursor, onlyIfAbsent = false) {
  return (
    await accountRequest<{ cursor: PlaybackCursor }>(progressPath(id), {
      method: 'PUT',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(onlyIfAbsent ? { 'If-None-Match': '*' } : {}),
      },
      body: JSON.stringify(cursor),
    })
  ).cursor;
}

export async function clearCloudCursor(id: string) {
  await accountRequest(progressPath(id), { method: 'DELETE' });
}
