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
      models: ['custom:7b'],
      missingModels: ['custom:7b'],
    });
  });

  it('keeps custom models independent of MTP version requirements', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(installed('private/gemma4:12b-mlx'));
    expect(
      await checkOllamaReadiness(
        { ollama_model: 'private/gemma4:12b-mlx' },
        request,
      ),
    ).toMatchObject({ status: 'ready' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['0.31.0', '0.40.5', '1.0.0'])(
    'accepts supported Ollama %s for canonical Gemma MTP',
    async (version) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(installed('gemma4:12b-mlx'))
        .mockResolvedValueOnce(reply({ version }));
      expect(
        await checkOllamaReadiness(
          { ollama_model: 'registry.ollama.ai/library/gemma4:12b-mlx' },
          request,
        ),
      ).toMatchObject({ status: 'ready', version });
      expect(request.mock.calls.map(([url]) => url)).toEqual([
        'http://127.0.0.1:11434/api/tags',
        'http://127.0.0.1:11434/api/version',
      ]);
    },
  );

  it.each(['0.30.9', '0.9.0', 'unknown'])(
    'does not claim MTP readiness on %s',
    async (version) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(installed('gemma4:12b-mlx'))
        .mockResolvedValueOnce(reply({ version }));
      expect(
        await checkOllamaReadiness({ ollama_model: 'gemma4:12b-mlx' }, request),
      ).toMatchObject({ status: 'upgrade_required' });
    },
  );

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
