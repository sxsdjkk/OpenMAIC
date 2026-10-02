import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTTS, TTSInvalidResponseError, TTSRateLimitError } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/audio-provider-fetch', () => ({ audioProviderFetch: mockFetch }));
const config = {
  providerId: 'fish-tts' as const,
  apiKey: 'fish-test-key',
  voice: 'voice-1',
  speed: 1.25,
};
const audioResponse = () =>
  new Response(new Uint8Array([0x49, 0x44, 0x33]), { headers: { 'content-type': 'audio/mpeg' } });
const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ status, message }), {
    status,
    headers: { 'content-type': 'application/json', 'retry-after': '5' },
  });

describe('Fish Audio official TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv('TTS_FISH_FALLBACK_MODEL', 's2.1-pro');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses native headers/body, preserves voice/speed and reports the free model', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse());
    const result = await generateTTS(config, '欢迎来到课堂');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, request] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer fish-test-key',
      model: 's2.1-pro-free',
    });
    expect(JSON.parse(request.body)).toEqual({
      text: '欢迎来到课堂',
      reference_id: 'voice-1',
      prosody: { speed: 1.25 },
      format: 'mp3',
    });
    expect(result).toMatchObject({ format: 'mp3', modelId: 's2.1-pro-free' });
  });

  it.each([
    [429, 'Free tier daily quota exceeded'],
    [402, 'Free model allowance exhausted'],
    [429, 'free_quota_exhausted'],
  ])(
    'retries once with paid Pro only on explicit free exhaustion (%s)',
    async (status, message) => {
      mockFetch
        .mockResolvedValueOnce(failure(status as number, message as string))
        .mockResolvedValueOnce(audioResponse());
      const result = await generateTTS(config, '相同文字');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls.map(([, init]) => init.headers.model)).toEqual([
        's2.1-pro-free',
        's2.1-pro',
      ]);
      expect(mockFetch.mock.calls[1][1].body).toBe(mockFetch.mock.calls[0][1].body);
      expect(mockFetch.mock.calls[1][1].signal).toBe(mockFetch.mock.calls[0][1].signal);
      expect(result.modelId).toBe('s2.1-pro');
    },
  );

  it.each([
    [429, 'Rate limit exceeded'],
    [429, 'Free tier concurrent request quota exceeded'],
    [402, 'Insufficient balance'],
    [401, 'Free tier quota exceeded'],
    [403, 'Free tier quota exceeded'],
    [503, 'Free tier quota exceeded'],
    [500, 'Internal server error'],
  ])('does not spend money on other failures (%s, %s)', async (status, message) => {
    mockFetch.mockResolvedValueOnce(failure(status as number, message as string));
    await expect(generateTTS(config, 'Hello')).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fallback on network errors', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(generateTTS(config, 'Hello')).rejects.toThrow('fetch failed');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('can disable paid fallback and preserves rate-limit retry information', async () => {
    vi.stubEnv('TTS_FISH_FALLBACK_MODEL', '');
    mockFetch.mockResolvedValueOnce(failure(429, 'Free quota exhausted'));
    await expect(generateTTS(config, 'Hello')).rejects.toMatchObject({
      name: 'TTSRateLimitError',
      retryAfterMs: 5000,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('never loops when the paid fallback fails', async () => {
    mockFetch
      .mockResolvedValueOnce(failure(429, 'Free quota exhausted'))
      .mockResolvedValueOnce(failure(402, 'Insufficient balance'));
    await expect(generateTTS(config, 'Hello')).rejects.toThrow('402');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('never falls back again on paid concurrency throttling', async () => {
    mockFetch
      .mockResolvedValueOnce(failure(429, 'Free quota exhausted'))
      .mockResolvedValueOnce(failure(429, 'Concurrent limit exceeded'));
    await expect(generateTTS(config, 'Hello')).rejects.toBeInstanceOf(TTSRateLimitError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not fallback for a successful HTTP response containing JSON instead of audio', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('{"error":"free quota exhausted"}', {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(generateTTS(config, 'Hello')).rejects.toBeInstanceOf(TTSInvalidResponseError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown models before Fish can silently default to paid Pro', async () => {
    await expect(generateTTS({ ...config, modelId: 'typo-model' }, 'Hello')).rejects.toThrow(
      'Unsupported Fish',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('preserves the original catalog and replaces only incompatible Flux voices', async () => {
    expect(TTS_PROVIDERS['fish-tts'].voices).toEqual(TTS_PROVIDERS['openrouter-tts'].voices);
    expect(DEFAULT_TTS_MODELS['fish-tts']).toBe('s2.1-pro-free');
    mockFetch.mockResolvedValueOnce(audioResponse());
    await generateTTS({ ...config, voice: 'flux-bruce-en' }, 'Hello');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).reference_id).toBe(
      DEFAULT_TTS_VOICES['fish-tts'],
    );
  });
});
