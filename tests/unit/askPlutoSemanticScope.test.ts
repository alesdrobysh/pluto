import { describe, expect, it, vi } from 'vitest';
import {
  needsSemanticMeetingScope,
  parseSemanticMeetingScope,
  resolveSemanticMeetingScope,
} from '../../electron/intelligence/askPlutoSemanticScope';
const meetings = [
  { id: 'recorded', title: 'Meeting', started_at: '2026-10-15T22:42:00.000Z' },
  { id: 'another', title: 'Meeting', started_at: '2026-10-16T00:00:00.000Z' },
  {
    id: 'planning',
    title: 'Pilot planning',
    started_at: '2026-10-14T18:00:00.000Z',
  },
];
const selection = {
  kind: 'single',
  meetingIds: ['recorded'],
  intent: 'factual',
  expanded_keywords: [],
};
const options = {
  query:
    'Using the meeting titled “Meeting”, recorded October 15 at 3:42 PM, was the 5 PM Eastern review booked?',
  meetings,
  timeZone: 'America/Los_Angeles',
  now: new Date('2026-10-16T12:00:00Z'),
};
describe('semantic meeting scope', () => {
  it('requests structured semantic selection using complete metadata, with no meeting content', async () => {
    const classifyQueryIntent = vi.fn(async () => JSON.stringify(selection));
    expect(
      await resolveSemanticMeetingScope({
        ...options,
        meetings: meetings.map((m) => ({
          ...m,
          transcript_json: 'private transcript',
          analysis_json: 'private notes',
        })),
        provider: { classifyQueryIntent },
      }),
    ).toEqual(selection);
    expect(classifyQueryIntent).toHaveBeenCalledTimes(1);
    const [prompt, request] = classifyQueryIntent.mock.calls[0] as unknown as [
      string,
      any,
    ];
    expect(prompt).toContain('Oct 15, 2026, 3:42 PM GMT-7');
    expect(prompt).toContain('Friday, October 16, 2026');
    expect(prompt).toContain(options.query);
    expect(prompt).toContain('Distinguish a recording time from a deadline');
    expect(prompt).not.toContain('private transcript');
    expect(prompt).not.toContain('private notes');
    expect(request).toMatchObject({
      purpose: 'meetingScope',
      workClass: 'ask_pluto',
      responseSchema: { additionalProperties: false },
    });
    expect(request.responseSchema.properties.meetingIds.items.enum).toEqual([
      'another',
      'planning',
      'recorded',
    ]);
  });
  it.each([
    { kind: 'ambiguous', meetingIds: ['recorded', 'another'] },
    { kind: 'not_found', meetingIds: [] },
    { kind: 'global', meetingIds: [] },
    { kind: 'current', meetingIds: [] },
    { kind: 'multiple', meetingIds: ['recorded', 'planning'] },
  ])(
    'preserves $kind instead of silently widening a specific reference',
    async (scope) => {
      const expected = { ...selection, ...scope };
      expect(
        await resolveSemanticMeetingScope({
          ...options,
          provider: {
            classifyQueryIntent: vi.fn(async () => JSON.stringify(expected)),
          },
        }),
      ).toEqual(expected);
    },
  );
  it.each([
    'not JSON',
    '```json\n{}\n```',
    JSON.stringify({ ...selection, meetingIds: ['invented'] }),
    JSON.stringify({ ...selection, meetingIds: ['recorded', 'another'] }),
    JSON.stringify({
      ...selection,
      kind: 'multiple',
      meetingIds: ['recorded'],
    }),
    JSON.stringify({ ...selection, kind: 'global' }),
    JSON.stringify({ ...selection, kind: 'current' }),
    JSON.stringify({ ...selection, meetingIds: ['recorded', 'recorded'] }),
    JSON.stringify({ ...selection, intent: 'invented' }),
    JSON.stringify({ ...selection, expanded_keywords: ['x'.repeat(81)] }),
    JSON.stringify({ ...selection, extra: 'ignored?' }),
  ])(
    'rejects invalid output without fallback prose parsing or broad retrieval',
    (raw) => {
      expect(parseSemanticMeetingScope(raw, meetings)).toBeNull();
    },
  );
  it('returns a safe failure without retrying invalid model output', async () => {
    const classifyQueryIntent = vi.fn(async () => '{bad');
    expect(
      await resolveSemanticMeetingScope({
        ...options,
        provider: { classifyQueryIntent },
      }),
    ).toEqual({
      kind: 'unavailable',
      meetingIds: [],
      reason: 'invalid_response',
    });
    expect(classifyQueryIntent).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized complete catalogs and questions before any model call', async () => {
    const classifyQueryIntent = vi.fn();
    for (const input of [
      { ...options, meetings: [{ id: 'long', title: 'x'.repeat(64001) }] },
      { ...options, query: 'x'.repeat(8001) },
      {
        ...options,
        meetings: Array.from({ length: 801 }, (_, i) => ({ id: String(i) })),
      },
    ]) {
      expect(
        await resolveSemanticMeetingScope({
          ...input,
          provider: { classifyQueryIntent },
        }),
      ).toMatchObject({ kind: 'unavailable', reason: 'catalog_limit' });
    }
    expect(classifyQueryIntent).not.toHaveBeenCalled();
  });
  it('propagates cancellation and usage rejection without retrying or broadening', async () => {
    const controller = new AbortController();
    controller.abort();
    const classifyQueryIntent = vi.fn();
    await expect(
      resolveSemanticMeetingScope({
        ...options,
        signal: controller.signal,
        provider: { classifyQueryIntent },
      }),
    ).rejects.toBeDefined();
    expect(classifyQueryIntent).not.toHaveBeenCalled();
    const quota = Object.assign(new Error('limit'), {
      code: 'chatgpt_daily_limit',
    });
    classifyQueryIntent.mockRejectedValue(quota);
    await expect(
      resolveSemanticMeetingScope({
        ...options,
        provider: { classifyQueryIntent },
      }),
    ).rejects.toBe(quota);
    expect(classifyQueryIntent).toHaveBeenCalledTimes(1);
  });
  it('preserves complete metadata for a year-sized workspace within a bounded scope request', async () => {
    const catalog = Array.from({ length: 500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: `Weekly planning ${index}`,
      started_at: '2026-10-15T22:42:00Z',
    }));
    const chosen = catalog.at(-1)!;
    const classifyQueryIntent = vi.fn(async (_prompt: string) =>
      JSON.stringify({ ...selection, meetingIds: [chosen.id] }),
    );
    expect(
      await resolveSemanticMeetingScope({
        ...options,
        meetings: catalog,
        provider: { classifyQueryIntent },
      }),
    ).toMatchObject({ kind: 'single', meetingIds: [chosen.id] });
    const prompt = classifyQueryIntent.mock.calls[0][0] as unknown as string;
    expect(prompt).toContain(catalog[0]!.id);
    expect(prompt).toContain(chosen.id);
    expect(prompt).toContain('GMT-7');
  });

  it('keeps repeated wall-clock times distinct across the daylight-saving transition', async () => {
    const classifyQueryIntent = vi.fn(async (_prompt: string) =>
      JSON.stringify({ ...selection, meetingIds: ['second'] }),
    );
    await resolveSemanticMeetingScope({
      ...options,
      meetings: [
        { id: 'first', title: 'Meeting', started_at: '2026-11-01T08:30:00Z' },
        { id: 'second', title: 'Meeting', started_at: '2026-11-01T09:30:00Z' },
      ],
      provider: { classifyQueryIntent },
    });
    const prompt = classifyQueryIntent.mock.calls[0][0];
    expect(prompt).toContain('Nov 1, 2026, 1:30 AM GMT-7');
    expect(prompt).toContain('Nov 1, 2026, 1:30 AM GMT-8');
  });

  it('does not spend on an empty workspace', async () => {
    const classifyQueryIntent = vi.fn();
    expect(
      await resolveSemanticMeetingScope({
        ...options,
        meetings: [],
        provider: { classifyQueryIntent },
      }),
    ).toMatchObject({ kind: 'not_found' });
    expect(classifyQueryIntent).not.toHaveBeenCalled();
  });
  it('keeps identical catalogs stable for duplicate sharing despite database row ordering', async () => {
    const classifyQueryIntent = vi.fn(async () => JSON.stringify(selection));
    await resolveSemanticMeetingScope({
      ...options,
      provider: { classifyQueryIntent },
    });
    await resolveSemanticMeetingScope({
      ...options,
      meetings: [...meetings].reverse(),
      provider: { classifyQueryIntent },
    });
    expect(classifyQueryIntent.mock.calls[0]).toEqual(
      classifyQueryIntent.mock.calls[1],
    );
  });
});

it('reuses an established scope only for reuse turns, and resolves new or clarified references semantically', () => {
  const previousScope = {
    kind: 'meeting_ids' as const,
    meetingIds: ['recorded'],
    source: 'explicit' as const,
    resolvedAt: '2026-10-16',
  };
  const reuse = {
    provider: 'chatgpt',
    relation: 'follow_up',
    turnMode: 'lookup',
    retrievalPolicy: 'reuse',
    previousScope,
  };
  expect(needsSemanticMeetingScope(reuse)).toBe(false);
  expect(needsSemanticMeetingScope({ ...reuse, relation: 'new_topic' })).toBe(
    true,
  );
  expect(
    needsSemanticMeetingScope({ ...reuse, retrievalPolicy: 'fresh' }),
  ).toBe(true);
  expect(
    needsSemanticMeetingScope({ ...reuse, previousTurnMode: 'clarify' }),
  ).toBe(true);
  expect(
    needsSemanticMeetingScope({
      ...reuse,
      previousScope: { ...previousScope, meetingIds: [] },
    }),
  ).toBe(true);
  expect(needsSemanticMeetingScope({ ...reuse, turnMode: 'social' })).toBe(
    false,
  );
});

it.each(['ollama', 'openai', 'openrouter', 'gemini', 'claude', undefined])(
  'keeps %s on its existing query path without semantic scope calls or catalog limits',
  (provider) => {
    expect(
      needsSemanticMeetingScope({
        provider,
        relation: 'new_topic',
        turnMode: 'lookup',
        retrievalPolicy: 'fresh',
      }),
    ).toBe(false);
  },
);
