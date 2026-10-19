import { describe, expect, it, vi } from 'vitest';
import { checkOllamaReadiness } from '../../electron/llm/ollamaReadiness';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const installed = (...names: string[]) =>
  reply({ models: names.map((name) => ({ name })) });

describe('read-only Ollama readiness', () => {
  it('reports a stopped service without generating or downloading', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await checkOllamaReadiness({}, request)).toMatchObject({
      status: 'service_unavailable',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/tags');
  });

  it('requires the configured model, not merely a running service', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(installed());
    expect(
      await checkOllamaReadiness({ ollama_model: 'custom:7b' }, request),
    ).toEqual({
      status: 'model_missing',
      models: ['custom:7b', 'phi4-mini:3.8b'],
      missingModels: ['custom:7b', 'phi4-mini:3.8b'],
    });
  });

  it('checks the existing general and quick defaults independently', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(installed('gemma4:12b'));
    expect(await checkOllamaReadiness({}, request)).toEqual({
      status: 'model_missing',
      models: ['gemma4:12b', 'phi4-mini:3.8b'],
      missingModels: ['phi4-mini:3.8b'],
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('checks installed custom models using metadata only', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(installed('private/custom:latest', 'quick:small'));
    expect(
      await checkOllamaReadiness(
        { ollama_model: 'private/custom', ollama_fast_model: 'quick:small' },
        request,
      ),
    ).toMatchObject({ status: 'ready' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('checks a quick override while preserving the configured legacy model', async () => {
    const settings = {
      ollama_model: ' ',
      llm_model: 'legacy',
      ollama_fast_model: 'quick:small',
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(installed('legacy:latest'));
    expect(await checkOllamaReadiness(settings, request)).toEqual({
      status: 'model_missing',
      models: ['legacy', 'quick:small'],
      missingModels: ['quick:small'],
    });
    expect(settings).toEqual({
      ollama_model: ' ',
      llm_model: 'legacy',
      ollama_fast_model: 'quick:small',
    });
  });

  it.each([null, {}, { models: [null] }, { models: [{ name: 5 }] }])(
    'fails closed on malformed tags %j',
    async (body) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      expect(await checkOllamaReadiness({}, request)).toMatchObject({
        status: 'check_failed',
      });
    },
  );

  it('does not treat an HTTP error as readiness', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply({}, 500));
    expect(await checkOllamaReadiness({}, request)).toMatchObject({
      status: 'check_failed',
    });
  });
});
