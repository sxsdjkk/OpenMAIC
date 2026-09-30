import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishFeishuLogin,
  getFeishuSession,
  isFeishuAuthRequired,
  startFeishuLogin,
} from '@/lib/server/feishu-auth';

const callbackUrl = 'https://ai-learning-agent.sxsdjkk.workers.dev/auth/callback';

beforeEach(() => {
  vi.stubEnv('FEISHU_AUTH_REQUIRED', '1');
  vi.stubEnv('FEISHU_APP_ID', 'test-app');
  vi.stubEnv('FEISHU_APP_SECRET', 'test-app-secret');
  vi.stubEnv('AUTH_SESSION_SECRET', 'test-session-secret');
  vi.stubEnv('FEISHU_REDIRECT_URI', callbackUrl);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Feishu login', () => {
  it('requires explicit opt-in and sends a state-bound authorization request', () => {
    expect(isFeishuAuthRequired()).toBe(true);
    const response = startFeishuLogin();
    const location = new URL(response.headers.get('location')!);
    expect(response.status).toBe(302);
    expect(location.searchParams.get('client_id')).toBe('test-app');
    expect(location.searchParams.get('redirect_uri')).toBe(callbackUrl);
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(response.headers.get('set-cookie')).toContain('__Host-openmaic_feishu_state=');
  });

  it('rejects a callback with missing or mismatched state before exchanging a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await finishFeishuLogin(
      new Request(`${callbackUrl}?code=test-code&state=wrong`, {
        headers: { Cookie: '__Host-openmaic_feishu_state=expected' },
      }),
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a signed session after a valid callback and rejects tampering', async () => {
    const login = startFeishuLogin();
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, access_token: 'test-token' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { open_id: 'ou_test' } })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const response = await finishFeishuLogin(
      new Request(`${callbackUrl}?code=test-code&state=${state}`, {
        headers: { Cookie: `__Host-openmaic_feishu_state=${state}` },
      }),
    );
    expect(response.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sessionCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-openmaic_feishu='))!;
    const sessionValue = sessionCookie.split(';')[0];
    const request = new Request('https://ai-learning-agent.sxsdjkk.workers.dev/', {
      headers: { Cookie: sessionValue },
    });
    expect((await getFeishuSession(request))?.sub).toBe('ou_test');
    // The last base64url character has unused bits; change a significant byte.
    const signatureStart = sessionValue.lastIndexOf('.') + 1;
    const tampered =
      sessionValue.slice(0, signatureStart) +
      (sessionValue[signatureStart] === 'A' ? 'B' : 'A') +
      sessionValue.slice(signatureStart + 1);
    expect(
      await getFeishuSession(new Request(request.url, { headers: { Cookie: tampered } })),
    ).toBeNull();
  });
});
