import {
  resolveConfiguredOllamaModel,
  usesGemmaMtpDefaults,
} from '../../src/utils/ollamaModels';
import { ollamaHttpFetch } from './ollamaHttpTransport';

export type OllamaReadiness = {
  status:
    | 'ready'
    | 'service_unavailable'
    | 'model_missing'
    | 'upgrade_required'
    | 'check_failed';
  models: string[];
  missingModels: string[];
  version?: string;
};

const modelIdentity = (name: string) => {
  let identity = name.trim();
  for (const prefix of ['registry.ollama.ai/library/', 'library/']) {
    if (identity.startsWith(prefix)) {
      identity = identity.slice(prefix.length);
      break;
    }
  }
  return identity.slice(identity.lastIndexOf('/') + 1).includes(':')
    ? identity
    : `${identity}:latest`;
};

const supportsGemmaMtp = (version: string) => {
  const parts = version.split('-')[0].split('+')[0].split('.');
  if (
    parts.length !== 3 ||
    parts.some(
      (part) =>
        !part ||
        [...part].some((character) => character < '0' || character > '9'),
    )
  )
    return false;
  const [major, minor] = parts.map(Number);
  return major > 0 || minor >= 31;
};

// Readiness never loads a model or starts a download.
export async function checkOllamaReadiness(
  settings: Parameters<typeof resolveConfiguredOllamaModel>[0],
  request: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response> = ollamaHttpFetch,
): Promise<OllamaReadiness> {
  const models = [
    ...new Set([
      resolveConfiguredOllamaModel(settings),
      resolveConfiguredOllamaModel(settings, true),
    ]),
  ];
  const result = { models, missingModels: [] as string[] };
  const signal = AbortSignal.timeout(5_000);
  let response: Response;
  try {
    response = await request('http://127.0.0.1:11434/api/tags', { signal });
  } catch {
    return { ...result, status: 'service_unavailable' };
  }
  try {
    if (!response.ok) return { ...result, status: 'check_failed' };
    const tags: unknown = await response.json();
    if (
      !tags ||
      typeof tags !== 'object' ||
      !('models' in tags) ||
      !Array.isArray(tags.models)
    ) {
      return { ...result, status: 'check_failed' };
    }
    const installed = new Set<string>();
    for (const entry of tags.models) {
      if (!entry || typeof entry !== 'object')
        return { ...result, status: 'check_failed' };
      const name: unknown = entry.name ?? entry.model;
      if (typeof name !== 'string' || !name.trim())
        return { ...result, status: 'check_failed' };
      installed.add(modelIdentity(name));
    }
    const missingModels = models.filter(
      (model) => !installed.has(modelIdentity(model)),
    );
    if (missingModels.length)
      return { ...result, missingModels, status: 'model_missing' };
    if (!models.some(usesGemmaMtpDefaults))
      return { ...result, status: 'ready' };
    const versionResponse = await request(
      'http://127.0.0.1:11434/api/version',
      { signal },
    );
    if (!versionResponse.ok) return { ...result, status: 'check_failed' };
    const body: unknown = await versionResponse.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('version' in body) ||
      typeof body.version !== 'string'
    ) {
      return { ...result, status: 'check_failed' };
    }
    return {
      ...result,
      version: body.version,
      status: supportsGemmaMtp(body.version) ? 'ready' : 'upgrade_required',
    };
  } catch {
    return { ...result, status: 'check_failed' };
  }
}
