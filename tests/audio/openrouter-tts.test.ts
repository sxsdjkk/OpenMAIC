import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/audio-provider-fetch', () => ({ audioProviderFetch: mockFetch }));

describe('OpenRouter Fish Audio TTS', () => {
  beforeEach(() => mockFetch.mockReset());

  it('uses only the free model, Fish voice ID, and MP3 format', async () => {
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
      response_format: 'mp3',
    });
    expect(result.format).toBe('mp3');
  });
});
