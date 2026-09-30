import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/audio-provider-fetch', () => ({ audioProviderFetch: mockFetch }));

describe('OpenRouter Fish Audio TTS', () => {
  beforeEach(() => mockFetch.mockReset());

  it('pins the free Fish model and preserves the original Fish voice and speed', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const result = await generateTTS(
      {
        providerId: 'openrouter-tts',
        apiKey: 'sk-test',
        modelId: 'deepgram/flux-tts:free',
        voice: '5d29a99739c14d4ca3e4fe42193105b2',
        speed: 1.5,
      },
      '欢迎来到课堂',
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/audio/speech',
      expect.objectContaining({ method: 'POST' }),
      expect.any(Object),
    );
    const request = mockFetch.mock.calls[0][1];
    expect(request.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'fish-audio/s2.1-pro-free:free',
      voice: '5d29a99739c14d4ca3e4fe42193105b2',
      speed: 1.5,
      input: '欢迎来到课堂',
      response_format: 'mp3',
    });
    expect(result.format).toBe('mp3');
  });

  it('replaces a persisted Flux voice with the restored Fish default', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
    await generateTTS(
      { providerId: 'openrouter-tts', apiKey: 'sk-test', voice: 'flux-bruce-en' },
      'Welcome to the classroom.',
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).voice).toBe(
      '5d29a99739c14d4ca3e4fe42193105b2',
    );
  });

  it('keeps the model, default voice and catalog consistent', () => {
    const provider = TTS_PROVIDERS['openrouter-tts'];
    expect(provider.defaultModelId).toBe('fish-audio/s2.1-pro-free:free');
    expect(DEFAULT_TTS_MODELS['openrouter-tts']).toBe(provider.defaultModelId);
    expect(DEFAULT_TTS_VOICES['openrouter-tts']).toBe('5d29a99739c14d4ca3e4fe42193105b2');
    expect(provider.voices.some((voice) => voice.id === DEFAULT_TTS_VOICES['openrouter-tts'])).toBe(
      true,
    );
    expect(provider.voices.map((voice) => voice.id)).toEqual([
      '5d29a99739c14d4ca3e4fe42193105b2',
      '74c6aba5cbf94a15bbdc547ffce5cb38',
      'd675c275d1d44e57b4ef3840c5a23209',
      'e98fa6cdad6946bf8d9bb8f9cb8c2532',
      '1e85fd1e0d3e4cc2b79fbca800e7e3fe',
      '91ec588cf8ef443a9c0d5b21d0c1fa36',
    ]);
  });
});
