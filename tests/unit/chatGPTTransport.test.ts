import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTAuth } from '../../electron/chatgpt/auth';
import {
  getChatGPTUsage,
  initializeChatGPTAuth,
} from '../../electron/chatgpt/runtime';
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
  initializeChatGPTAuth(auth);
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

  it('honors cancellation before sending meeting text', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeChatGPT({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
