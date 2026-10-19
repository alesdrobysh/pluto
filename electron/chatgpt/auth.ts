import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';
import { createServer } from 'node:http';
import type { ChatGPTModel, ChatGPTStatus } from './types';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

interface Session {
  clientId: string;
  subject: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scopes: string[];
}

export class ChatGPTError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly requestId?: string,
  ) {
    super(code);
    this.name = 'ChatGPTError';
  }
}

export function isChatGPTUsageProtectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error instanceof ChatGPTError &&
      /^(chatgpt_(daily_limit|background_paused|background_limit|usage_storage_error)|subscription_sharing_usage_(limit_exceeded|unavailable))$/.test(
        error.code,
      )) ||
      isChatGPTUsageProtectionError(
        (error as Error & { cause?: unknown }).cause,
      ))
  );
}

export const chatGPTErrorMessage = (error: unknown): string => {
  const code = error instanceof ChatGPTError ? error.code : '';
  switch (code) {
    case 'chatgpt_sign_in_cancelled':
      return 'ChatGPT sign-in was cancelled.';
    case 'chatgpt_sign_in_timeout':
      return 'ChatGPT sign-in timed out. Try again.';
    case 'chatgpt_not_selected':
      return 'ChatGPT requests stopped because another intelligence provider is selected.';
    case 'chatgpt_cloud_consent_required':
      return 'ChatGPT requests stopped because text sharing is not enabled. Review Settings → Intelligence.';
    case 'chatgpt_sign_in_required':
      return 'Connect your ChatGPT account in Settings → Intelligence.';
    case 'chatgpt_plan_permission_required':
      return 'Enable ChatGPT plan usage in Settings → Intelligence.';
    case 'chatgpt_model_required':
      return 'Choose an available ChatGPT model in Settings → Intelligence.';
    case 'chatgpt_daily_limit':
      return 'Pluto’s daily ChatGPT allowance is used up or this request would exceed it. Review Usage protection in Settings → Intelligence, or wait until tomorrow.';
    case 'chatgpt_background_paused':
      return 'Automatic background enrichment is paused to protect your ChatGPT allowance. You can enable it in Settings → Intelligence.';
    case 'chatgpt_background_limit':
      return 'Pluto has used today’s background ChatGPT allowance. Background updates will wait until tomorrow.';
    case 'chatgpt_usage_policy_invalid':
      return 'Choose a daily limit of 1–1,000 requests and 1,000–10,000,000 tokens.';
    case 'chatgpt_usage_storage_error':
      return 'Pluto could not read its usage protection record. ChatGPT requests are paused to protect your allowance.';
    case 'subscription_sharing_usage_limit_exceeded':
      return 'Pluto has reached a ChatGPT usage limit. Manage usage in ChatGPT settings, or try again later.';
    case 'subscription_sharing_user_not_eligible':
      return 'ChatGPT plan usage is unavailable for this account or workspace. An eligible Plus or Pro plan is required.';
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return 'ChatGPT usage is temporarily unavailable. Try again later.';
    case 'chatgpt_secure_storage_unavailable':
      return 'ChatGPT could not access secure local storage. Try again after unlocking your Mac.';
    default:
      return 'ChatGPT could not complete this request. Check your connection or sign in again in Settings → Intelligence.';
  }
};

export interface ChatGPTAuthOptions {
  load(): string | null;
  save(value: string): void;
  clear?(): void;
  getHostId(): string | null;
  saveHostId(value: string): void;
  openBrowser(url: string): Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
  signInTimeoutMs?: number;
}

/** Tokens stay in the main process; the storage adapter must encrypt the entire record. */
export class ChatGPTAuth {
  private session: Session | null | undefined;
  private refreshPromise: Promise<string> | null = null;
  private signInPromise: Promise<ChatGPTStatus> | null = null;
  private signInController: AbortController | null = null;
  private epoch = 0;
  private usageLimited = false;
  private inferenceController = new AbortController();
  private request: typeof fetch;
  private now: () => number;

  constructor(private options: ChatGPTAuthOptions) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private read(): Session | null {
    if (this.session === undefined) {
      const raw = this.options.load();
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Session;
        if (
          !parsed.clientId ||
          !parsed.subject ||
          !Array.isArray(parsed.scopes)
        )
          throw new Error();
        this.session = parsed;
      } catch {
        throw new ChatGPTError('chatgpt_secure_storage_unavailable');
      }
    }
    return this.session ?? null;
  }

  private write(session: Session) {
    this.options.save(JSON.stringify(session));
    this.session = session;
  }

  status(): ChatGPTStatus {
    const session = this.read();
    return {
      connected: !!session?.accessToken,
      planEnabled:
        !!session?.accessToken &&
        session.scopes.includes('chatgpt.tokens.use.direct') &&
        session.scopes.includes('resource.invoke'),
      ...(session?.email ? { email: session.email } : {}),
      usageLimited: this.usageLimited,
    };
  }

  cancelSignIn() {
    this.signInController?.abort(new ChatGPTError('chatgpt_sign_in_cancelled'));
  }

  pauseUsage() {
    this.usageLimited = true;
  }
  resumeUsage() {
    this.usageLimited = false;
  }
  assertUsageAvailable() {
    if (this.usageLimited)
      throw new ChatGPTError('subscription_sharing_usage_limit_exceeded');
  }
  inferenceSignal() {
    return this.inferenceController.signal;
  }

  signIn(): Promise<ChatGPTStatus> {
    if (this.signInPromise) return this.signInPromise;
    this.signInController = new AbortController();
    this.signInPromise = this.authorize(this.signInController.signal).finally(
      () => {
        this.signInPromise = null;
        this.signInController = null;
      },
    );
    return this.signInPromise;
  }

  private async authorize(signal: AbortSignal): Promise<ChatGPTStatus> {
    const previous = this.read();
    let hostId = this.options.getHostId();
    if (!hostId) {
      hostId = `urn:uuid:${randomUUID()}`;
      this.options.saveHostId(hostId);
    }
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const controller = new AbortController();
    const attemptSignal = AbortSignal.any([signal, controller.signal]);
    const timeout = setTimeout(
      () => controller.abort(new ChatGPTError('chatgpt_sign_in_timeout')),
      this.options.signInTimeoutMs ?? 180_000,
    );
    let resolveCallback!: (url: URL) => void;
    let rejectCallback!: (error: unknown) => void;
    const callback = new Promise<URL>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    // Attach immediately: opening the browser can fail before we await the callback.
    void callback.catch(() => {});
    let accepted = false;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (
        req.method !== 'GET' ||
        url.pathname !== '/auth/callback' ||
        url.searchParams.get('state') !== state ||
        accepted
      ) {
        res
          .writeHead(400)
          .end('Invalid sign-in callback. Return to Pluto and try again.');
        return;
      }
      accepted = true;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      );
      res.setHeader('Referrer-Policy', 'no-referrer');
      const cancelled = url.searchParams.has('error');
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to Pluto</title>
        <style>:root{color-scheme:light dark}body{margin:0;background:light-dark(#f9fbfc,#191919);color:light-dark(#202c3c,#eee);font:16px/1.6 system-ui,sans-serif}main{max-width:30rem;margin:18vh auto;padding:2rem}h1{font:500 2rem/1.2 Georgia,serif}p{color:light-dark(#586475,#bbb)}</style>
        <main><h1>${cancelled ? 'Sign-in wasn’t completed' : 'Continue in Pluto'}</h1><p>${cancelled ? 'Return to Pluto to try again or keep using your current setup.' : 'Return to Pluto to finish connecting ChatGPT. Pluto will confirm when your account is ready.'}</p><p>You can close this tab.</p></main></html>`);

      resolveCallback(url);
    });
    const onAbort = () => rejectCallback(attemptSignal.reason);
    attemptSignal.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      attemptSignal.throwIfAborted();
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new ChatGPTError('chatgpt_callback_unavailable');
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const url = new URL(`${ISSUER}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: previous?.clientId ?? 'dynamic_agent_client',
        ...(previous ? {} : { agent_name_hint: 'Pluto' }),
        ext_agent_host_id: hostId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        ...(previous?.email ? { login_hint: previous.email } : {}),
        ...(previous?.idToken ? { id_token_hint: previous.idToken } : {}),
        ...(previous?.accessToken && !this.status().planEnabled
          ? { prompt: 'consent' }
          : {}),
      }).toString();
      await this.options.openBrowser(url.toString());
      const returned = await callback;
      attemptSignal.throwIfAborted();
      if (returned.searchParams.has('error'))
        throw new ChatGPTError('chatgpt_sign_in_cancelled');
      const clientId =
        returned.searchParams.get('client_id') ?? previous?.clientId;
      const code = returned.searchParams.get('code');
      if (
        !code ||
        !clientId ||
        clientId === 'dynamic_agent_client' ||
        (previous && clientId !== previous.clientId)
      )
        throw new ChatGPTError('chatgpt_invalid_callback');
      const tokens = await this.tokenRequest(
        {
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: RESOURCE,
        },
        attemptSignal,
      );
      const identity = await this.validateIdentity(
        tokens.id_token,
        clientId,
        nonce,
        attemptSignal,
      );
      if (previous && identity.sub !== previous.subject)
        throw new ChatGPTError('chatgpt_account_mismatch');
      attemptSignal.throwIfAborted();
      this.write(
        this.sessionFromTokens(tokens, {
          clientId,
          subject: identity.sub,
          scopes: [],
          ...(typeof identity.email === 'string'
            ? { email: identity.email }
            : {}),
        }),
      );
      this.epoch++;
      this.resumeUsage();
      this.inferenceController.abort();
      this.inferenceController = new AbortController();
      return this.status();
    } finally {
      clearTimeout(timeout);
      attemptSignal.removeEventListener('abort', onAbort);
      server.closeAllConnections();
      server.close();
    }
  }

  private async validateIdentity(
    token: unknown,
    clientId: string,
    nonce: string,
    signal: AbortSignal,
  ) {
    if (typeof token !== 'string')
      throw new ChatGPTError('chatgpt_invalid_identity');
    const parts = token.split('.');
    if (parts.length !== 3) throw new ChatGPTError('chatgpt_invalid_identity');
    try {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (header.alg !== 'RS256' || typeof header.kid !== 'string')
        throw new Error();
      const response = await this.request(`${ISSUER}/.well-known/jwks.json`, {
        signal,
      });
      if (!response.ok) throw new Error();
      const jwks = await response.json();
      const key = jwks.keys?.find(
        (candidate: {
          kid?: string;
          kty?: string;
          use?: string;
          alg?: string;
        }) =>
          candidate.kid === header.kid &&
          candidate.kty === 'RSA' &&
          (!candidate.use || candidate.use === 'sig') &&
          (!candidate.alg || candidate.alg === 'RS256'),
      );
      if (
        !key ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${parts[0]}.${parts[1]}`),
          createPublicKey({ key, format: 'jwk' }),
          Buffer.from(parts[2], 'base64url'),
        )
      )
        throw new Error();
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const now = this.now() / 1000;
      if (
        claims.iss !== ISSUER ||
        !audiences.includes(clientId) ||
        (audiences.length > 1 && claims.azp !== clientId) ||
        (claims.azp && claims.azp !== clientId) ||
        typeof claims.exp !== 'number' ||
        claims.exp <= now ||
        (typeof claims.nbf === 'number' && claims.nbf > now) ||
        claims.nonce !== nonce ||
        typeof claims.sub !== 'string' ||
        !claims.sub
      )
        throw new Error();
      return claims as { sub: string; email?: string };
    } catch {
      signal.throwIfAborted();
      throw new ChatGPTError('chatgpt_invalid_identity');
    }
  }

  private async tokenRequest(
    body: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const response = await this.request(`${ISSUER}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new ChatGPTError(
        typeof data.error === 'string' ? data.error : 'chatgpt_token_error',
        response.status,
      );
    return data;
  }

  private sessionFromTokens(
    tokens: Record<string, unknown>,
    previous: Session,
  ): Session {
    if (
      typeof tokens.access_token !== 'string' ||
      !tokens.access_token ||
      tokens.token_type !== 'Bearer' ||
      typeof tokens.expires_in !== 'number' ||
      tokens.expires_in <= 0 ||
      typeof tokens.refresh_token !== 'string' ||
      !tokens.refresh_token
    )
      throw new ChatGPTError('chatgpt_invalid_tokens');
    const scopes =
      typeof tokens.scope === 'string'
        ? tokens.scope.split(/\s+/)
        : previous.scopes;
    return {
      ...previous,
      scopes,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken:
        typeof tokens.id_token === 'string'
          ? tokens.id_token
          : previous.idToken,
      expiresAt: this.now() + tokens.expires_in * 1000,
    };
  }

  async accessToken(): Promise<string> {
    const session = this.read();
    if (!session?.accessToken)
      throw new ChatGPTError('chatgpt_sign_in_required');
    if (!this.status().planEnabled)
      throw new ChatGPTError('chatgpt_plan_permission_required');
    if ((session.expiresAt ?? 0) > this.now() + 60_000)
      return session.accessToken;
    if (!this.refreshPromise) {
      const epoch = this.epoch;
      this.refreshPromise = (async () => {
        try {
          if (!session.refreshToken)
            throw new ChatGPTError('invalid_refresh_token');
          const tokens = await this.tokenRequest({
            grant_type: 'refresh_token',
            client_id: session.clientId,
            refresh_token: session.refreshToken,
            resource: RESOURCE,
          });
          if (epoch !== this.epoch)
            throw new ChatGPTError('chatgpt_sign_in_required');
          const next = this.sessionFromTokens(tokens, session);
          this.write(next);
          if (!this.status().planEnabled)
            throw new ChatGPTError('chatgpt_plan_permission_required');
          return next.accessToken!;
        } catch (error) {
          if (
            epoch === this.epoch &&
            error instanceof ChatGPTError &&
            TERMINAL_REFRESH_ERRORS.has(error.code)
          ) {
            this.clearTokens(session);
            throw new ChatGPTError('chatgpt_sign_in_required');
          }
          throw error;
        } finally {
          this.refreshPromise = null;
        }
      })();
    }
    return this.refreshPromise;
  }

  private clearTokens(session: Session) {
    this.inferenceController.abort();
    const registration = {
      clientId: session.clientId,
      subject: session.subject,
      email: session.email,
      scopes: [],
    };
    try {
      this.write(registration);
    } catch (error) {
      if (!this.options.clear) throw error;
      // Deleting encrypted tokens must still work when Keychain cannot encrypt.
      this.options.clear();
      this.session = null;
    }
  }

  async signOut(): Promise<{ remoteRevoked: boolean }> {
    this.inferenceController.abort();
    this.cancelSignIn();
    if (this.signInPromise) await this.signInPromise.catch(() => {});
    // Let a rotating refresh finish before revoking its replacement.
    if (this.refreshPromise) await this.refreshPromise.catch(() => {});
    this.epoch++;
    const session = this.read();
    let remoteRevoked = !session?.refreshToken;
    try {
      if (session?.refreshToken) {
        const response = await this.request(
          `${ISSUER}/.well-known/openid-configuration`,
          { signal: AbortSignal.timeout(15_000) },
        );
        const discovery = await response.json();
        const endpoint = new URL(discovery.revocation_endpoint);
        if (
          discovery.issuer !== ISSUER ||
          endpoint.origin !== ISSUER ||
          endpoint.protocol !== 'https:'
        )
          throw new Error();
        const revoked = await this.request(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: session.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: session.clientId,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        remoteRevoked = revoked.status === 200;
      }
    } catch {
      remoteRevoked = false;
    } finally {
      if (session) this.clearTokens(session);
    }
    return { remoteRevoked };
  }

  async models(signal?: AbortSignal): Promise<ChatGPTModel[]> {
    const token = await this.accessToken();
    const response = await this.request(`${RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new ChatGPTError('chatgpt_models_unavailable', response.status);
    const data = await response.json();
    if (!Array.isArray(data.models))
      throw new ChatGPTError('chatgpt_models_unavailable');
    return data.models
      .filter(
        (model: Record<string, unknown>) =>
          model.visibility === 'list' &&
          typeof model.slug === 'string' &&
          typeof model.display_name === 'string',
      )
      .map((model: { slug: string; display_name: string }) => ({
        id: model.slug,
        name: model.display_name,
      }));
  }
}
