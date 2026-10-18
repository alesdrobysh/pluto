import { generateKeyPairSync, sign } from 'node:crypto';
import { get } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ChatGPTAuth } from '../../electron/chatgpt/auth';
import { createChatGPTStorage } from '../../electron/chatgpt/storage';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const key = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'test-key',
  alg: 'RS256',
  use: 'sig',
};
const scope =
  'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct';
const visit = (url: string) =>
  new Promise<number>((resolve, reject) => {
    get(url, (response) => {
      response.resume();
      resolve(response.statusCode!);
    }).on('error', reject);
  });

function fixture(
  options: {
    claims?: Record<string, unknown>;
    scopes?: string;
    callback?: (url: URL) => void;
    expiry?: number;
    timeout?: number;
  } = {},
) {
  let stored: string | null = null;
  let host: string | null = null;
  let authorizeUrl: URL;
  let now = Date.now();
  const request = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/jwks.json')) return Response.json({ keys: [key] });
      if (url.endsWith('/openid-configuration'))
        return Response.json({
          issuer: 'https://auth.openai.com',
          revocation_endpoint:
            'https://auth.openai.com/api/accounts/oauth/revoke',
        });
      if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'refresh_token')
        return Response.json({
          access_token: 'renewed-access',
          refresh_token: 'renewed-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      const claims = {
        iss: 'https://auth.openai.com',
        sub: 'fictional-user',
        aud: 'oaiapp_test',
        exp: now / 1000 + 3600,
        nonce: authorizeUrl.searchParams.get('nonce'),
        email: 'test@example.test',
        ...options.claims,
      };
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', kid: key.kid }),
      ).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = sign(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        privateKey,
      ).toString('base64url');
      return Response.json({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        id_token: `${header}.${payload}.${signature}`,
        token_type: 'Bearer',
        expires_in: options.expiry ?? 3600,
        scope: options.scopes ?? scope,
      });
    },
  );
  const openBrowser = vi.fn(async (url: string) => {
    authorizeUrl = new URL(url);
    const callback = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      state: authorizeUrl.searchParams.get('state')!,
      code: 'test-code',
      client_id: 'oaiapp_test',
    }).toString();
    options.callback?.(callback);
    await visit(callback.toString());
  });
  const save = vi.fn((value: string) => {
    stored = value;
  });
  const auth = new ChatGPTAuth({
    load: () => stored,
    save,
    getHostId: () => host,
    saveHostId: (value) => {
      host = value;
    },
    openBrowser,
    fetch: request as typeof fetch,
    now: () => now,
    signInTimeoutMs: options.timeout ?? 1000,
  });
  return {
    auth,
    request,
    openBrowser,
    save,
    stored: () => stored,
    host: () => host,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ChatGPT sign-in', () => {
  it('restores and renews the encrypted session after restart without opening sign-in', async () => {
    const f = fixture({ expiry: 120 });
    await f.auth.signIn();
    const openBrowser = vi.fn();
    const restarted = new ChatGPTAuth({
      load: () => f.stored(),
      save: f.save,
      getHostId: () => f.host(),
      saveHostId: vi.fn(),
      openBrowser,
      fetch: f.request as typeof fetch,
      now: () => Date.now() + 90_000,
    });
    expect(restarted.status().planEnabled).toBe(true);
    expect(await restarted.accessToken()).toBe('renewed-access');
    expect(openBrowser).not.toHaveBeenCalled();
  });
  it('rejects a forged ID-token signature', async () => {
    const f = fixture();
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: key.kid }),
    ).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ sub: 'forged-user' })).toString(
      'base64url',
    );
    f.request.mockResolvedValueOnce(
      Response.json({
        access_token: 'fake-access',
        refresh_token: 'fake-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope,
        id_token: `${header}.${claims}.Zm9yZ2Vk`,
      }),
    );
    await expect(f.auth.signIn()).rejects.toMatchObject({
      code: 'chatgpt_invalid_identity',
    });
    expect(f.save).not.toHaveBeenCalled();
  });

  it('rejects a changed issued client ID on reauthorization without replacing credentials', async () => {
    let changeClient = false;
    const f = fixture({
      callback: (url) => {
        if (changeClient) url.searchParams.set('client_id', 'another-client');
      },
    });
    await f.auth.signIn();
    const stored = f.stored();
    changeClient = true;
    await expect(f.auth.signIn()).rejects.toMatchObject({
      code: 'chatgpt_invalid_callback',
    });
    expect(f.stored()).toBe(stored);
    expect(f.auth.status().connected).toBe(true);
  });

  it('cancels pending sign-in and closes its callback listener', async () => {
    const f = fixture({
      callback: (url) => url.searchParams.set('state', 'unmatched'),
    });
    const pending = f.auth.signIn();
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'chatgpt_sign_in_cancelled',
    });
    await vi.waitFor(() => expect(f.openBrowser).toHaveBeenCalled());
    f.auth.cancelSignIn();
    await rejected;
    expect(f.request).not.toHaveBeenCalled();
    const redirect = new URL(f.openBrowser.mock.calls[0][0]).searchParams.get(
      'redirect_uri',
    )!;
    await expect(visit(redirect)).rejects.toBeInstanceOf(Error);
  });
  it('uses dynamic registration, PKCE, loopback, issued client ID, and verified identity', async () => {
    const f = fixture();
    const status = await f.auth.signIn();
    expect(status).toMatchObject({
      connected: true,
      planEnabled: true,
      email: 'test@example.test',
    });
    expect(JSON.stringify(status)).not.toMatch(
      /test-access|test-refresh|id_token/,
    );
    const authorize = new URL(f.openBrowser.mock.calls[0][0]);
    expect(authorize.searchParams.get('client_id')).toBe(
      'dynamic_agent_client',
    );
    expect(authorize.searchParams.get('agent_name_hint')).toBe('Pluto');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('ext_agent_host_id')).toBe(f.host());
    expect(authorize.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    const exchange = f.request.mock.calls.find(([url]) =>
      String(url).endsWith('/oauth/token'),
    )!;
    const form = new URLSearchParams(String(exchange[1]?.body));
    expect(form.get('client_id')).toBe('oaiapp_test');
    expect(form.get('code_verifier')).toBeTruthy();
    expect(form.get('redirect_uri')).toBe(
      authorize.searchParams.get('redirect_uri'),
    );
    expect(await f.auth.accessToken()).toBe('test-access');
  });

  it.each([
    { iss: 'https://untrusted.test' },
    { aud: 'another-client' },
    { exp: 1 },
    { nonce: 'wrong' },
    { sub: '' },
  ])(
    'rejects invalid signed claims %j without saving credentials',
    async (claims) => {
      const f = fixture({ claims });
      await expect(f.auth.signIn()).rejects.toMatchObject({
        code: 'chatgpt_invalid_identity',
      });
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid state without exchanging a code and closes the listener on timeout', async () => {
    const f = fixture({
      callback: (url) => url.searchParams.set('state', 'wrong'),
      timeout: 50,
    });
    await expect(f.auth.signIn()).rejects.toMatchObject({
      code: 'chatgpt_sign_in_timeout',
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('rejects a missing issued client ID and a denied grant', async () => {
    const missing = fixture({
      callback: (url) => url.searchParams.delete('client_id'),
    });
    await expect(missing.auth.signIn()).rejects.toMatchObject({
      code: 'chatgpt_invalid_callback',
    });
    const denied = fixture({
      callback: (url) => url.searchParams.set('error', 'access_denied'),
    });
    await expect(denied.auth.signIn()).rejects.toMatchObject({
      code: 'chatgpt_sign_in_cancelled',
    });
    expect(missing.request).not.toHaveBeenCalled();
    expect(denied.request).not.toHaveBeenCalled();
  });

  it('keeps identity sign-in separate from permission to use the plan', async () => {
    const f = fixture({ scopes: 'openid email profile' });
    expect(await f.auth.signIn()).toMatchObject({
      connected: true,
      planEnabled: false,
    });
    await expect(f.auth.accessToken()).rejects.toMatchObject({
      code: 'chatgpt_plan_permission_required',
    });
  });

  it('serializes rotating refreshes and retains scopes when omitted on refresh', async () => {
    const f = fixture({ expiry: 120 });
    await f.auth.signIn();
    f.advance(90_000);
    expect(
      await Promise.all([f.auth.accessToken(), f.auth.accessToken()]),
    ).toEqual(['renewed-access', 'renewed-access']);
    const refreshes = f.request.mock.calls.filter(([, init]) =>
      String(init?.body).includes('grant_type=refresh_token'),
    );
    expect(refreshes).toHaveLength(1);
    expect(String(refreshes[0][1]?.body)).toContain('client_id=oaiapp_test');
    expect(f.stored()).toContain('renewed-refresh');
    expect(f.auth.status().planEnabled).toBe(true);
  });

  it('clears unusable tokens but preserves registration, and keeps tokens on transient errors', async () => {
    const f = fixture({ expiry: 120 });
    await f.auth.signIn();
    f.advance(90_000);
    f.request.mockResolvedValueOnce(
      Response.json({ error: 'temporarily_unavailable' }, { status: 503 }),
    );
    await expect(f.auth.accessToken()).rejects.toMatchObject({ status: 503 });
    expect(f.auth.status().connected).toBe(true);
    f.request.mockResolvedValueOnce(
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );
    await expect(f.auth.accessToken()).rejects.toMatchObject({
      code: 'chatgpt_sign_in_required',
    });
    expect(f.auth.status().connected).toBe(false);
    expect(f.stored()).toContain('oaiapp_test');
    expect(f.stored()).not.toContain('test-refresh');
  });

  it('revokes the session, clears tokens, and reuses the registration and host', async () => {
    const f = fixture();
    await f.auth.signIn();
    const host = f.host();
    expect(await f.auth.signOut()).toEqual({ remoteRevoked: true });
    expect(f.auth.status().connected).toBe(false);
    expect(f.stored()).not.toMatch(/test-access|test-refresh|idToken/);
    await f.auth.signIn();
    const reauth = new URL(f.openBrowser.mock.calls[1][0]);
    expect(reauth.searchParams.get('client_id')).toBe('oaiapp_test');
    expect(reauth.searchParams.has('agent_name_hint')).toBe(false);
    expect(f.host()).toBe(host);
  });

  it('reports unconfirmed remote revocation while clearing locally', async () => {
    const f = fixture();
    await f.auth.signIn();
    f.request.mockRejectedValueOnce(new Error('offline'));
    expect(await f.auth.signOut()).toEqual({ remoteRevoked: false });
    expect(f.auth.status().connected).toBe(false);
  });

  it('reads the account-specific model catalog and filters hidden models', async () => {
    const f = fixture();
    await f.auth.signIn();
    f.request.mockResolvedValueOnce(
      Response.json({
        models: [
          {
            slug: 'available-model',
            display_name: 'Available model',
            visibility: 'list',
          },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
        ],
      }),
    );
    expect(await f.auth.models()).toEqual([
      { id: 'available-model', name: 'Available model' },
    ]);
  });
});

describe('ChatGPT credential storage', () => {
  it('uses protected storage, preserves other secrets, and fails closed', () => {
    let records: Record<string, string> = {
      openai_api_key: 'existing-encrypted-key',
    };
    let available = true;
    const backend = {
      isAvailable: () => available,
      readAll: () => records,
      writeAll: (next: Record<string, string>) => {
        records = next;
      },
      encrypt: (value: string) => Buffer.from(value).toString('base64'),
      decrypt: (value: string) => Buffer.from(value, 'base64').toString(),
    };
    const storage = createChatGPTStorage(backend);
    storage.save('fictional-refresh-token');
    expect(records.chatgpt_session).not.toContain('fictional-refresh-token');
    expect(records.openai_api_key).toBe('existing-encrypted-key');
    expect(storage.load()).toBe('fictional-refresh-token');
    available = false;
    expect(() => storage.load()).toThrow('chatgpt_secure_storage_unavailable');
    expect(() => storage.save('replacement')).toThrow(
      'chatgpt_secure_storage_unavailable',
    );
    storage.clear();
    expect(records).toEqual({ openai_api_key: 'existing-encrypted-key' });
  });
});
