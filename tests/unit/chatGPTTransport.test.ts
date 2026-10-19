import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTAuth, ChatGPTError } from '../../electron/chatgpt/auth';
import { classifyAskPlutoFailure } from '../../electron/intelligence/askPlutoFailures';
import {
  cancelChatGPTInference,
  getChatGPTUsage,
  initializeChatGPTAuth,
} from '../../electron/chatgpt/runtime';
import { createMemoryChatGPTUsage } from '../../electron/chatgpt/usage';
import type { InferenceRequest } from '../../electron/llm/inferenceTypes';
import { executeChatGPT } from '../../electron/llm/transports/chatGPT';

const request: InferenceRequest = {
  task: 'notesWriter',
  model: 'account-model',
  messages: [
    { role: 'system', content: 'Return JSON grounded in the source.' },
    { role: 'user', content: 'Fictional meeting text.' },
  ],
  temperature: 0.1,
  maxOutputTokens: 2000,
  jsonMode: true,
  egress: { classification: 'selected_meeting_context', userInitiated: true },
};
const completed = {
  type: 'response.completed',
  response: {
    status: 'completed',
    model: 'account-model',
    usage: { input_tokens: 22, output_tokens: 4 },
  },
};
const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'fictional-request',
      },
    },
  );
let auth: ChatGPTAuth;
let settings: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  auth = new ChatGPTAuth({
    load: () =>
      JSON.stringify({
        clientId: 'oaiapp_test',
        subject: 'fictional-user',
        scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
        accessToken: 'test-access',
        refreshToken: 'test-refresh',
        expiresAt: Date.now() + 3600_000,
      }),
    save: vi.fn(),
    getHostId: () => 'urn:uuid:test',
    saveHostId: vi.fn(),
    openBrowser: vi.fn(),
  });
  settings = new Map([
    ['llm_provider', 'chatgpt'],
    ['cloud_consent_chatgpt', '1'],
  ]);
  initializeChatGPTAuth(auth, createMemoryChatGPTUsage(), (key) =>
    settings.get(key),
  );
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('ChatGPT Responses transport', () => {
  it('uses OAuth with the supported stateless streaming contract and preserves usage', async () => {
    fetchMock.mockResolvedValue(
      sse([
        { type: 'response.output_text.delta', delta: '{"ok":true}' },
        completed,
      ]),
    );
    const onStart = vi.fn();
    const result = await executeChatGPT(request, { onStart });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: '{"ok":true}',
      provider: 'chatgpt',
      finishReason: 'stop',
      usage: { inputTokens: 22, outputTokens: 4 },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer test-access');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'account-model',
      store: false,
      stream: true,
      instructions: request.messages[0].content,
      input: [{ role: 'user', content: 'Fictional meeting text.' }],
      text: { format: { type: 'json_object' } },
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body.input).not.toContainEqual(
      expect.objectContaining({ role: 'system' }),
    );
  });

  it('supports JSON schemas without forcing the strict subset on Pluto schemas', async () => {
    fetchMock.mockResolvedValue(
      sse([{ type: 'response.output_text.delta', delta: '{}' }, completed]),
    );
    await executeChatGPT({
      ...request,
      responseSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
      },
    });
    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body).text.format,
    ).toMatchObject({
      type: 'json_schema',
      strict: false,
      name: 'notesWriter',
    });
  });

  it('parses fragmented UTF-8 and CRLF SSE frames', async () => {
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Café' })}\r\n\r\ndata: ${JSON.stringify(completed)}\r\n\r\n`,
    );
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 3)
              controller.enqueue(bytes.slice(i, i + 3));
            controller.close();
          },
        }),
      ),
    );
    expect((await executeChatGPT({ ...request, jsonMode: false })).text).toBe(
      'Café',
    );
  });

  it.each(['response.incomplete', 'response.failed', 'missing'])(
    'rejects partial output on %s',
    async (type) => {
      const events: unknown[] = [
        { type: 'response.output_text.delta', delta: 'partial output' },
      ];
      if (type !== 'missing')
        events.push({ type, response: { error: { code: 'provider_failed' } } });
      fetchMock.mockResolvedValue(sse(events));
      await expect(executeChatGPT(request)).rejects.toBeInstanceOf(Error);
    },
  );

  it('pauses future inference after a late usage-limit failure without switching providers', async () => {
    fetchMock.mockResolvedValue(
      sse([
        {
          type: 'response.output_text.delta',
          delta: 'discard this partial output',
        },
        {
          type: 'response.failed',
          response: {
            error: { code: 'subscription_sharing_usage_limit_exceeded' },
          },
        },
      ]),
    );
    await expect(executeChatGPT(request)).rejects.toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
      requestId: 'fictional-request',
    });
    await expect(executeChatGPT(request)).rejects.toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.status().usageLimited).toBe(true);
    auth.resumeUsage();
    getChatGPTUsage().pause(false);
    fetchMock.mockResolvedValue(
      sse([{ type: 'response.output_text.delta', delta: '{}' }, completed]),
    );
    expect((await executeChatGPT(request)).text).toBe('{}');
  });

  it('handles nonstandard admission errors without exposing diagnostic bodies', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ detail: 'private diagnostic text' }, { status: 403 }),
    );
    const error = await executeChatGPT(request).catch((failure) => failure);
    expect(error).toMatchObject({
      status: 403,
      code: 'chatgpt_request_failed',
    });
    expect(String(error)).not.toContain('private diagnostic text');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['provider', 'consent'])(
    'blocks stale provider work after changing %s without reserving usage',
    async (setting) => {
      if (setting === 'provider') settings.set('llm_provider', 'ollama');
      else settings.set('cloud_consent_chatgpt', '');
      await expect(executeChatGPT(request)).rejects.toMatchObject({
        code:
          setting === 'provider'
            ? 'chatgpt_not_selected'
            : 'chatgpt_cloud_consent_required',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getChatGPTUsage().summary().requests).toBe(0);
      expect(auth.status().planEnabled).toBe(true);
    },
  );

  it('rechecks live consent after waiting for credentials and does not send meeting text', async () => {
    vi.spyOn(auth, 'accessToken').mockImplementation(async () => {
      settings.set('cloud_consent_chatgpt', '');
      return 'test-access';
    });
    await expect(executeChatGPT(request)).rejects.toMatchObject({
      code: 'chatgpt_cloud_consent_required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['provider', 'consent'])(
    'preserves the %s cancellation reason for active and queued work without resetting the account or usage',
    async (setting) => {
      let started!: () => void;
      const active = new Promise<void>((resolve) => {
        started = resolve;
      });
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            started();
            init.signal.addEventListener(
              'abort',
              () => reject(init.signal.reason),
              { once: true },
            );
          }),
      );
      const first = executeChatGPT(request).catch((error) => error);
      await active;
      const queued = executeChatGPT({
        ...request,
        model: 'different-model',
      }).catch((error) => error);
      const code =
        setting === 'provider'
          ? 'chatgpt_not_selected'
          : 'chatgpt_cloud_consent_required';
      if (setting === 'provider') settings.set('llm_provider', 'ollama');
      else settings.set('cloud_consent_chatgpt', '');
      cancelChatGPTInference(new ChatGPTError(code));
      for (const error of [await first, await queued]) {
        expect(error).toMatchObject({ code });
        expect(classifyAskPlutoFailure(error)).toMatchObject({
          reason: 'provider_unavailable',
          answer: expect.stringContaining(
            setting === 'provider'
              ? 'another intelligence provider'
              : 'text sharing is not enabled',
          ),
        });
      }
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(getChatGPTUsage().summary().requests).toBe(1);
      expect(auth.status().planEnabled).toBe(true);
      settings.set('llm_provider', 'chatgpt');
      settings.set('cloud_consent_chatgpt', '1');
      fetchMock.mockResolvedValue(
        sse([{ type: 'response.output_text.delta', delta: '{}' }, completed]),
      );
      expect((await executeChatGPT(request)).text).toBe('{}');
      expect(getChatGPTUsage().summary().requests).toBe(2);
    },
  );

  it('honors cancellation before sending meeting text', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeChatGPT({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
