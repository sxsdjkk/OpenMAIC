import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { createFeishuSession } from '@/lib/server/feishu-auth';

beforeEach(() => {
  vi.stubEnv('ACCESS_CODE', '');
  vi.stubEnv('FEISHU_AUTH_REQUIRED', '1');
  vi.stubEnv('FEISHU_APP_ID', 'test-app');
  vi.stubEnv('FEISHU_APP_SECRET', 'test-app-secret');
  vi.stubEnv('AUTH_SESSION_SECRET', 'test-session-secret');
  vi.stubEnv('FEISHU_REDIRECT_URI', 'https://example.workers.dev/auth/callback');
});

afterEach(() => vi.unstubAllEnvs());

describe('Feishu middleware gate', () => {
  it('redirects an unauthenticated page and rejects an unauthenticated API', async () => {
    const page = await middleware(new NextRequest('https://example.workers.dev/classroom/abc'));
    const api = await middleware(new NextRequest('https://example.workers.dev/api/classroom'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('https://example.workers.dev/auth/login');
    expect(api.status).toBe(401);
  });

  it('allows an authenticated request', async () => {
    const cookie = await createFeishuSession({ open_id: 'ou_test' }, 'test-session-secret');
    const response = await middleware(
      new NextRequest('https://example.workers.dev/api/classroom', {
        headers: { Cookie: cookie.split(';')[0] },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('fails closed when authentication is required but not configured', async () => {
    vi.stubEnv('FEISHU_APP_SECRET', '');
    const response = await middleware(new NextRequest('https://example.workers.dev/'));
    expect(response.status).toBe(503);
  });
});
