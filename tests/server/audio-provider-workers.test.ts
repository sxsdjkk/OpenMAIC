import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioProviderFetch } from '@/lib/server/audio-provider-fetch';

const dnsMocks = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn(), lookup: vi.fn() }));
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, ...dnsMocks } };
});

describe('Workers audio transport', () => {
  const transport = vi.fn();

  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_WORKERS', '1');
    vi.stubGlobal('fetch', transport);
    transport.mockReset();
    dnsMocks.lookup.mockReset();
    dnsMocks.resolve4.mockReset().mockResolvedValue(['93.184.216.34']);
    dnsMocks.resolve6.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses the Workers transport for a public audio endpoint without dns.lookup', async () => {
    const audio = new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } });
    transport.mockResolvedValue(audio);
    expect(await audioProviderFetch('https://audio.example/speech')).toBe(audio);
    expect(dnsMocks.lookup).not.toHaveBeenCalled();
  });

  it('blocks private DNS answers before sending credentials, even with a local opt-in', async () => {
    dnsMocks.resolve6.mockResolvedValue(['::1']);
    await expect(
      audioProviderFetch(
        'https://audio.example/speech',
        { headers: { Authorization: 'Bearer test-credential' } },
        { allowLocalNetworks: true },
      ),
    ).rejects.toThrow('Local/private network URLs');
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks redirects to cloud metadata', async () => {
    transport.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    await expect(audioProviderFetch('https://audio.example/speech')).rejects.toThrow(
      'Cloud instance metadata endpoints',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('strips provider credentials on a cross-origin public redirect', async () => {
    transport
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/audio.mp3' },
        }),
      )
      .mockResolvedValueOnce(new Response('audio'));
    await audioProviderFetch('https://audio.example/speech', {
      headers: { Authorization: 'Bearer test-credential' },
    });
    expect(new Headers(transport.mock.calls[1][1].headers).has('Authorization')).toBe(false);
  });

  it('fails closed when neither DNS address family can be verified', async () => {
    dnsMocks.resolve4.mockRejectedValue(new Error('DNS unavailable'));
    dnsMocks.resolve6.mockRejectedValue(new Error('DNS unavailable'));
    await expect(audioProviderFetch('https://audio.example/speech')).rejects.toThrow(
      'Unable to verify hostname safety',
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
