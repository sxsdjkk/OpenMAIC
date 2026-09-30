import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/audio-provider-fetch', () => ({ audioProviderFetch: mockFetch }));

describe('OpenRouter Flux TTS', () => {
  beforeEach(() => mockFetch.mockReset());

  it('pins the free Flux model and replaces a persisted Fish voice with the Flux default', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const result = await generateTTS(
      {
        providerId: 'openrouter-tts',
        apiKey: 'sk-test',
        modelId: 'fish-audio/s2.1-pro',
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
      model: 'deepgram/flux-tts:free',
      voice: 'flux-haley-en',
      input: '欢迎来到课堂',
      response_format: 'mp3',
    });
    expect(JSON.parse(request.body)).not.toHaveProperty('speed');
    expect(result.format).toBe('mp3');
  });

  it('preserves a supported Flux voice', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
    await generateTTS(
      { providerId: 'openrouter-tts', apiKey: 'sk-test', voice: 'flux-bruce-en' },
      'Welcome to the classroom.',
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).voice).toBe('flux-bruce-en');
  });

  it('keeps the model, default voice and catalog consistent', () => {
    const provider = TTS_PROVIDERS['openrouter-tts'];
    expect(provider.defaultModelId).toBe('deepgram/flux-tts:free');
    expect(DEFAULT_TTS_MODELS['openrouter-tts']).toBe(provider.defaultModelId);
    expect(DEFAULT_TTS_VOICES['openrouter-tts']).toBe('flux-haley-en');
    expect(provider.voices.some((voice) => voice.id === DEFAULT_TTS_VOICES['openrouter-tts'])).toBe(
      true,
    );
    expect(
      provider.voices.every((voice) => voice.id.startsWith('flux-') && voice.language === 'en'),
    ).toBe(true);
  });
});
