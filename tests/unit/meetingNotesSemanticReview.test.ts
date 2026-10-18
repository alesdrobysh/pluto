import { describe, expect, it, vi } from 'vitest';
import {
  acceptEditedNotes,
  projectAuditedNotes,
} from '../../electron/llm/meetingNotesAudit';
import { reviewSourceBoundNotes } from '../../electron/llm/meetingNotesSemanticReview';
import { createNotesSource } from '../../electron/llm/meetingNotesSource';
import type { NotesDraft } from '../../electron/llm/meetingNotesTypes';

const fixture = (
  text = "I haven't told Morgan about the pilot yet, but I'll tell them soon.",
  claimedText = 'Remote Speaker 2 will tell Morgan about the pilot soon',
) => {
  const source = createNotesSource(
    JSON.stringify([{ speaker: 'Remote Speaker 2', text }]),
  );
  const sources = [{ segment: 0, start: 0, end: text.length }];
  const draft: NotesDraft = {
    title: null,
    meetingType: 'general',
    overview: null,
    sections: [
      {
        id: 'section',
        title: { id: 'heading', text: 'Pilot', sources },
        items: [
          {
            id: 'task',
            kind: 'action',
            text: claimedText,
            owner: 'Remote Speaker 2',
            due: null,
            sources,
          },
        ],
      },
    ],
  };
  const notes = acceptEditedNotes({
    source,
    draft,
    acceptancePolicy: 'conservative',
  });
  return { notes, source, sources };
};
const resolution = (values: Record<string, unknown> = {}) => ({
  kind: 'accepted_action',
  text: 'Tell Morgan about the pilot soon',
  owner: 'Remote Speaker 2',
  due: null,
  sources: ['R0'],
  ...values,
});
const response = (values: Record<string, unknown> = {}) =>
  JSON.stringify({
    reviews: { I0: resolution(values) },
    additions: [],
    overview: null,
  });

describe('bounded source-bound semantic notes review', () => {
  it('restores a valid promise rejected by the legacy wording check and rebuilds canonical provenance', async () => {
    const { notes, sources } = fixture();
    expect(notes.draft.sections[0]!.items[0]!.kind).toBe('point');
    const generate = vi.fn(async () => response());
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    const result = projectAuditedNotes(reviewed);
    expect(generate).toHaveBeenCalledOnce();
    await expect(generate.mock.results[0]?.value).resolves.toEqual(
      expect.any(String),
    );
    expect(result.all_action_items).toHaveLength(1);
    expect(result.all_action_items[0]).toMatchObject({
      text: 'Tell Morgan about the pilot soon',
      assignee: 'Remote Speaker 2',
    });
    expect(result.topics[0]!.action_items).toHaveLength(1);
    expect(result.topics[0]!.key_points).toHaveLength(0);
    expect(
      result.generation_metadata?.source_provenance?.blocks[
        'all_action_items:0'
      ],
    ).toEqual({ id: 'task', sources });
    expect(result.quality.issues).toEqual([]);
  });

  it('reviews omitted speech inside the cited window and carries the complete window into provenance', async () => {
    const source = createNotesSource(
      JSON.stringify([
        { speaker: 'Me', text: 'I will' },
        { speaker: 'Me', text: 'not' },
        { speaker: 'Me', text: 'book the review.' },
      ]),
    );
    const sources = [0, 2].map((segment) => ({
      segment,
      start: 0,
      end: source.segments[segment]!.text.length,
    }));
    const draft: NotesDraft = {
      title: null,
      meetingType: 'general',
      overview: null,
      sections: [
        {
          id: 's',
          title: { id: 'h', text: 'Review', sources },
          items: [
            {
              id: 'task',
              kind: 'action',
              text: 'Book the review',
              owner: 'Me',
              due: null,
              sources,
            },
          ],
        },
      ],
    };
    const notes = acceptEditedNotes({
      source,
      draft,
      acceptancePolicy: 'conservative',
    });
    const reviewed = await reviewSourceBoundNotes(notes, async ({ prompt }) => {
      const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      expect(packet.source[0][2]).toBe('I will not book the review.');
      return response({
        kind: 'point',
        text: 'The speaker will not book the review.',
        owner: null,
      });
    });
    const result = projectAuditedNotes(reviewed);
    expect(result.all_action_items).toHaveLength(0);
    expect(result.quality.issues).toEqual([]);
    expect(
      reviewed.draft.sections[0]!.items[0]!.sources.map((span) => span.segment),
    ).toEqual([0, 1, 2]);
    expect(JSON.stringify(result.topics)).toContain('not book');
    const block = Object.values(
      result.generation_metadata!.source_provenance!.blocks,
    ).find((row) => row.id === 'task');
    expect(block?.sources.map((span) => span.segment)).toEqual([0, 1, 2]);
  });

  it('requires every draft id and constrains narrative results to null owner and due', async () => {
    const { notes } = fixture();
    const generate = vi.fn(
      async (_request: { responseSchema: Record<string, unknown> }) =>
        response(),
    );
    await reviewSourceBoundNotes(notes, generate);
    const schema = generate.mock.calls[0]![0].responseSchema as any;
    expect(schema.properties.reviews.required).toEqual(['I0']);
    expect(schema.properties.reviews.additionalProperties).toBe(false);
    expect(schema.properties.reviews.properties.I0.anyOf[1]).toEqual({
      $ref: '#/$defs/reviewItem',
    });
    const branches = schema.$defs.reviewItem.anyOf;
    expect(branches).toHaveLength(2);
    expect(branches[0].properties.kind.enum).toEqual([
      'accepted_action',
      'settled_choice',
    ]);
    expect(branches[1].properties.kind.enum).toEqual(['point', 'question']);
    for (const key of ['owner', 'due'])
      expect(branches[1].properties[key]).toEqual({ type: 'null' });
    expect(branches[1].properties).not.toHaveProperty('discussion');
  });

  it('shares schema definitions so many draft items do not multiply citation enums', async () => {
    const source = createNotesSource(
      JSON.stringify(
        Array.from({ length: 100 }, (_, index) => ({
          speaker: index % 2 ? 'Tavi' : 'Rowan',
          text: `Status ${index}.`,
        })),
      ),
    );
    const span = (segment: number) => [
      { segment, start: 0, end: source.segments[segment]!.text.length },
    ];
    const notes = acceptEditedNotes({
      source,
      acceptancePolicy: 'conservative',
      draft: {
        title: null,
        meetingType: 'general',
        overview: null,
        sections: [
          {
            id: 'section',
            title: { id: 'heading', text: 'Status', sources: span(0) },
            items: Array.from({ length: 40 }, (_, index) => ({
              id: `item-${index}`,
              kind: 'point' as const,
              text: source.segments[index]!.text,
              owner: null,
              due: null,
              sources: span(index),
            })),
          },
        ],
      },
    });
    let schema: any;
    await reviewSourceBoundNotes(notes, async (request) => {
      schema = request.responseSchema;
      return JSON.stringify({
        reviews: Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [`I${index}`, 'point']),
        ),
        additions: [],
        overview: null,
      });
    });
    const enumCount = (value: unknown): number => {
      if (!value || typeof value !== 'object') return 0;
      if (Array.isArray(value))
        return value.reduce((total, item) => total + enumCount(item), 0);
      return Object.entries(value).reduce(
        (total, [key, item]) =>
          total +
          (key === 'enum' && Array.isArray(item)
            ? item.length
            : enumCount(item)),
        0,
      );
    };
    expect(schema.$defs.sourceId.enum).toHaveLength(100);
    expect(Object.keys(schema.properties.reviews.properties)).toHaveLength(40);
    expect(enumCount(schema)).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(schema).length).toBeLessThan(20_000);
    expect(notes.issues ?? []).not.toContain(
      'semantic_notes_review_unavailable',
    );
  });

  it('declines a schema exceeding enum capacity before making any model request', async () => {
    const { notes } = fixture('The pilot remains in staging.');
    const source = createNotesSource(
      JSON.stringify(
        Array.from({ length: 1000 }, (_, index) => ({
          speaker: index % 2 ? 'Tavi' : 'Rowan',
          text: `Status ${index}.`,
        })),
      ),
    );
    const sources = [
      { segment: 0, start: 0, end: source.segments[0]!.text.length },
    ];
    const draft = {
      ...notes.draft,
      sections: [
        {
          id: 'section',
          title: { id: 'heading', text: 'Status', sources },
          items: [
            {
              id: 'item',
              kind: 'point' as const,
              text: source.segments[0]!.text,
              owner: null,
              due: null,
              sources,
            },
          ],
        },
      ],
    };
    const input = acceptEditedNotes({
      source,
      draft,
      acceptancePolicy: 'conservative',
    });
    const generate = vi.fn(async () => response());
    const result = await reviewSourceBoundNotes(input, generate);
    expect(generate).not.toHaveBeenCalled();
    expect(result.issues).toContain('semantic_notes_review_capacity');
    expect(result.draft).toEqual(input.draft);
  });

  it('does not treat the word me in another participant’s speech as the reserved Me identity', async () => {
    const { notes } = fixture(
      'Let me send the checklist.',
      'Send the checklist',
    );
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      response({ text: 'Send the checklist', owner: 'Me' }),
    );
    expect(
      projectAuditedNotes(reviewed).all_action_items.some(
        (item) => item.assignee === 'Me',
      ),
    ).toBe(false);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable:task');
  });

  it('keeps proposals as readable discussion without inventing an assignment', async () => {
    const { notes } = fixture(
      'Could Riley book a review? No one accepted that request.',
    );
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      response({
        kind: 'point',
        text: 'A review was requested, but no one accepted it.',
        owner: null,
      }),
    );
    const result = projectAuditedNotes(reviewed);
    expect(result.all_action_items).toHaveLength(0);
    expect(result.topics[0]!.summary).toBe(
      'A review was requested, but no one accepted it.',
    );
  });

  it('reviews established actions too, including routine farewells', async () => {
    const { notes } = fixture(
      "Thanks everyone. I'll speak to you later. Goodbye.",
    );
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      response({
        kind: 'point',
        text: 'The meeting closed with farewells.',
        owner: null,
      }),
    );
    expect(projectAuditedNotes(reviewed).all_action_items).toHaveLength(0);
  });

  it('can retain confirmed source fields and conditions without changing the source spans', async () => {
    const { notes, sources } = fixture(
      'Riley agreed to send the checklist by Monday after approval.',
    );
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      response({
        text: 'Send the checklist by Monday after approval',
        owner: 'Riley',
        due: 'Monday',
      }),
    );
    const item = reviewed.draft.sections[0]!.items[0]!;
    expect(item).toMatchObject({ owner: 'Riley', due: 'Monday', sources });
    expect(notes.source.segments[0]!.text).toContain('after approval');
  });

  it('rejects missing reviewed wording rather than reusing an untrusted claim', async () => {
    const { notes } = fixture(
      "I'll tell Morgan about the pilot soon.",
      'Tell Morgan about the pilot soon',
    );
    const before = structuredClone(notes.draft);
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      response({ text: null }),
    );
    expect(reviewed.draft).toEqual(before);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it.each([
    ['foreign id', { id: 'other' }],
    ['expanded name', { owner: 'Morgan Stone' }],
    ['partial name', { owner: 'Morg' }],
    ['invented owner', { owner: 'Avery' }],
    ['anonymous channel mistaken for an owner', { owner: 'Them' }],
    ['invented deadline', { due: 'Friday' }],
    ['invalid kind', { kind: 'approved' }],
    ['empty text', { text: '' }],
    ['numeric owner', { owner: 42 }],
    ['string null owner', { owner: 'null' }],
    ['string null deadline', { due: 'null' }],
    ['string null discussion', { discussion: 'null' }],
    ['oversized text', { text: 'a'.repeat(1601) }],
    ['point owner', { kind: 'point', owner: 'Remote Speaker 2' }],
    ['unchanged corrections', { kind: 'unchanged' }],
    ['unknown field', { confidence: 1 }],
  ])(
    'rejects %s without promoting the conservative writer result',
    async (_label, values) => {
      const { notes } = fixture();
      const before = structuredClone(notes.draft);
      const reviewed = await reviewSourceBoundNotes(notes, async () =>
        response(values),
      );
      expect(reviewed.draft).toEqual(before);
      expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
    },
  );

  it.each([
    JSON.stringify({ resolutions: [] }),
    JSON.stringify({ resolutions: [resolution(), resolution()] }),
    JSON.stringify({ resolutions: [resolution()], extra: true }),
    '{incomplete',
  ])('rejects incomplete or duplicate batches', async (raw) => {
    const { notes } = fixture();
    const before = structuredClone(notes.draft);
    const reviewed = await reviewSourceBoundNotes(notes, async () => raw);
    expect(reviewed.draft).toEqual(before);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('reviews ordinary discussion so omitted material can be added in the same request', async () => {
    const { notes } = fixture('The pilot remains in staging.');
    notes.draft.sections[0]!.items[0]!.kind = 'point';
    notes.issues = [];
    notes.proseReviewItems = [];
    const generate = vi.fn(async () =>
      JSON.stringify({
        reviews: { I0: 'point' },
        additions: [],
        overview: null,
      }),
    );
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    expect(reviewed.draft).toEqual(notes.draft);
    expect(generate).toHaveBeenCalledOnce();
    await expect(generate.mock.results[0]?.value).resolves.toEqual(
      expect.any(String),
    );
  });

  it('coalesces an exact corrected fact also returned as an addition without losing its canonical identity', async () => {
    const { notes } = fixture('I have not sent the draft.', 'Send the draft');
    const text = 'The draft has not been sent.';
    const generate = vi.fn(async () =>
      JSON.stringify({
        reviews: { I0: resolution({ kind: 'point', text, owner: null }) },
        additions: [
          { kind: 'point', text, owner: null, due: null, sources: ['R0'] },
        ],
        overview: null,
      }),
    );
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    const items = reviewed.draft.sections.flatMap((section) => section.items);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'task', kind: 'point', text });
    expect(reviewed.issues ?? []).not.toContain(
      'semantic_notes_review_unavailable',
    );
    expect(generate).toHaveBeenCalledOnce();
    await expect(generate.mock.results[0]?.value).resolves.toEqual(
      expect.any(String),
    );
  });

  it('preserves separate accepted work with the same wording and different source-supported owners', async () => {
    const text = 'Review the plan';
    const { notes } = fixture(
      'I will review the plan. Jules will review the plan.',
      text,
    );
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      JSON.stringify({
        reviews: { I0: resolution({ text }) },
        additions: [
          {
            kind: 'accepted_action',
            text,
            owner: 'Jules',
            due: null,
            sources: ['R0'],
          },
        ],
        overview: null,
      }),
    );
    const actions = projectAuditedNotes(reviewed).all_action_items;
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.assignee)).toEqual([
      'Remote Speaker 2',
      'Jules',
    ]);
    expect(reviewed.issues ?? []).not.toContain(
      'semantic_notes_review_unavailable',
    );
  });

  it('keeps useful notes when admission or the review fails, without retrying', async () => {
    const { notes } = fixture();
    const before = structuredClone(notes.draft);
    const generate = vi.fn(async () => {
      throw new Error('usage_limit');
    });
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    expect(generate).toHaveBeenCalledOnce();
    await expect(generate.mock.results[0]?.value).rejects.toThrow(
      'usage_limit',
    );
    expect(reviewed.draft).toEqual(before);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('rejects oversized complete source before egress instead of silently reviewing a smaller subset', async () => {
    const { notes } = fixture(
      `Riley agreed to send the checklist. ${'context '.repeat(6000)}`,
    );
    const generate = vi.fn();
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    expect(reviewed.issues).toContain('semantic_notes_review_capacity');
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects missing spans and duplicate case ids before egress', async () => {
    const { notes } = fixture();
    const generate = vi.fn();
    notes.draft.sections[0]!.items[0]!.sources = [];
    expect((await reviewSourceBoundNotes(notes, generate)).issues).toContain(
      'semantic_notes_review_unavailable',
    );
    const other = fixture();
    other.notes.draft.sections[0]!.items.push(
      structuredClone(other.notes.draft.sections[0]!.items[0]!),
    );
    expect(
      (await reviewSourceBoundNotes(other.notes, generate)).issues,
    ).toContain('semantic_notes_review_unavailable');
    expect(generate).not.toHaveBeenCalled();
  });

  it('accepts an equivalent explicit ISO date using calendar formatting, without inferring a year', async () => {
    const full = fixture(
      'Riley agreed to send the checklist by October 20, 2026.',
    );
    const reviewed = await reviewSourceBoundNotes(full.notes, async () =>
      response({
        text: 'Send the checklist',
        owner: 'Riley',
        due: '2026-10-20',
      }),
    );
    expect(projectAuditedNotes(reviewed).all_action_items[0]?.due).toBe(
      '2026-10-20',
    );
    const partial = fixture(
      'Riley agreed to send the checklist by October 20.',
    );
    const rejected = await reviewSourceBoundNotes(partial.notes, async () =>
      response({
        text: 'Send the checklist',
        owner: 'Riley',
        due: '2026-10-20',
      }),
    );
    expect(rejected.issues).toContain('semantic_notes_review_unavailable');
  });

  it('keeps valid independent corrections when another item has an unanchored owner', async () => {
    const { notes } = fixture();
    const second = {
      ...structuredClone(notes.draft.sections[0]!.items[0]!),
      id: 'other',
    };
    notes.draft.sections[0]!.items.push(second);
    notes.issues?.push('deterministic_unsupported_commitment:other');
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      JSON.stringify({
        reviews: {
          I0: resolution(),
          I1: resolution({ owner: 'Invented Person' }),
        },
        additions: [],
        overview: null,
      }),
    );
    expect(projectAuditedNotes(reviewed).all_action_items).toHaveLength(1);
    expect(projectAuditedNotes(reviewed).all_action_items[0]?.assignee).toBe(
      'Remote Speaker 2',
    );
    expect(reviewed.issues).toContain(
      'semantic_notes_review_unavailable:other',
    );
    expect(reviewed.issues).not.toContain(
      'semantic_notes_review_unavailable:task',
    );
  });

  it('propagates cancellation before and after a request', async () => {
    const { notes } = fixture();
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn();
    await expect(
      reviewSourceBoundNotes(notes, generate, controller.signal),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    const running = new AbortController();
    await expect(
      reviewSourceBoundNotes(
        fixture().notes,
        async () => {
          running.abort();
          return response();
        },
        running.signal,
      ),
    ).rejects.toThrow();
  });
});

describe('complete-source coverage and source-cited additions', () => {
  const coverageFixture = (
    lines: Array<{ speaker: string; text: string }>,
    itemText: string,
    segment: number,
    kind: 'point' | 'action' = 'action',
  ) => {
    const source = createNotesSource(JSON.stringify(lines));
    const sources = [{ segment, start: 0, end: lines[segment]!.text.length }];
    const draft: NotesDraft = {
      title: null,
      meetingType: 'general',
      overview: null,
      sections: [
        {
          id: 's',
          title: { id: 'h', text: 'Review', sources },
          items: [
            {
              id: 'task',
              kind,
              text: itemText,
              owner: kind === 'action' ? lines[segment]!.speaker : null,
              due: null,
              sources,
            },
          ],
        },
      ],
    };
    return acceptEditedNotes({
      source,
      draft,
      acceptancePolicy: 'conservative',
    });
  };
  const encode = (
    resolutions: unknown[] = [],
    additions: unknown[] = [],
    overview: unknown = null,
  ) =>
    JSON.stringify({
      reviews: Object.fromEntries(
        resolutions.length
          ? resolutions.map((value, index) => {
              const { id, ...item } = value as {
                id: string;
                [key: string]: unknown;
              };
              return [id ?? `I${index}`, item];
            })
          : [['I0', 'point']],
      ),
      additions,
      overview,
    });
  it('coalesces an unchanged fact while preserving both exact source contexts and the original draft', async () => {
    const text = 'The prototype is in staging.';
    const notes = coverageFixture(
      [
        { speaker: 'Tavi', text },
        {
          speaker: 'Ellis',
          text: 'The prototype is in staging; production approval is pending.',
        },
      ],
      text,
      0,
      'point',
    );
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      encode(
        [],
        [{ kind: 'point', text, owner: null, due: null, sources: ['R1'] }],
      ),
    );
    const items = reviewed.draft.sections.flatMap((section) => section.items);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('task');
    expect(items[0]!.sources.map((span) => span.segment)).toEqual([0, 1]);
    expect(notes.draft.sections[0]!.items[0]!.sources).toHaveLength(1);
  });
  it('recovers an uncited earlier recipient and deadline with precise provenance in one request', async () => {
    const lines = [
      {
        speaker: 'Rowan',
        text: 'We need three sample reports for Mika by Friday.',
      },
      {
        speaker: 'Mika',
        text: 'The samples are for accessibility review, not publication.',
      },
      { speaker: 'Rowan', text: 'Release approval is still pending.' },
      { speaker: 'Ellis', text: 'I will provide the three sample reports.' },
    ];
    const notes = coverageFixture(lines, 'Provide the three sample reports', 3);
    const generate = vi.fn(async ({ prompt }) => {
      const data = JSON.parse(prompt.split('\n').at(-1)!);
      expect(data.source.map((row: any) => row[2])).toEqual(
        lines.map((line) => line.text),
      );
      return encode([
        resolution({
          owner: 'Ellis',
          due: 'Friday',
          text: 'Provide three sample reports for Mika by Friday',
          sources: ['R0', 'R3'],
        }),
      ]);
    });
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    const projected = projectAuditedNotes(reviewed);
    expect(projected.all_action_items[0]).toMatchObject({
      assignee: 'Ellis',
      due: 'Friday',
      text: 'Provide three sample reports for Mika by Friday',
    });
    expect(
      projected.generation_metadata!.source_provenance!.blocks[
        'all_action_items:0'
      ]!.sources.map((span) => span.segment),
    ).toEqual([0, 3]);
    expect(generate).toHaveBeenCalledOnce();
    await expect(generate.mock.results[0]?.value).resolves.toEqual(
      expect.any(String),
    );
  });
  it.each(['point', 'accepted_action'])(
    'restores missing %s material even when the writer produced no action candidates',
    async (kind) => {
      const notes = coverageFixture(
        [
          {
            speaker: 'Rowan',
            text: 'Could Mika update the handbook by Tuesday?',
          },
          {
            speaker: 'Mika',
            text: 'I will send the review checklist by Monday.',
          },
        ],
        'The meeting discussed documentation',
        0,
        'point',
      );
      const addition = {
        kind,
        text:
          kind === 'point'
            ? 'A handbook update by Tuesday was requested; it was not accepted.'
            : 'Send the review checklist by Monday',
        owner: kind === 'point' ? null : 'Mika',
        due: kind === 'point' ? null : 'Monday',
        sources: [kind === 'point' ? 'R0' : 'R1'],
      };
      const reviewed = await reviewSourceBoundNotes(notes, async () =>
        encode([], [addition]),
      );
      const result = projectAuditedNotes(reviewed);
      expect(result.quality.issues).toEqual([]);
      expect(JSON.stringify(result.topics)).toContain(addition.text);
      expect(result.all_action_items).toHaveLength(kind === 'point' ? 0 : 1);
      const block = Object.values(
        result.generation_metadata!.source_provenance!.blocks,
      ).find((block) => block.id === 'semantic-addition:0');
      expect(block!.sources[0]!.segment).toBe(kind === 'point' ? 0 : 1);
    },
  );
  it('checks later completion outside an action citation and preserves the resolved outcome', async () => {
    const notes = coverageFixture(
      [
        { speaker: 'Noor', text: 'I will rerun the export.' },
        {
          speaker: 'Mika',
          text: 'We discussed the layout; no changes were agreed.',
        },
        { speaker: 'Noor', text: 'I reran the export and it works now.' },
      ],
      'Rerun the export',
      0,
    );
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      encode([
        resolution({
          kind: 'point',
          text: 'Noor reran the export successfully.',
          owner: null,
          sources: ['R0', 'R2'],
        }),
      ]),
    );
    expect(projectAuditedNotes(reviewed).all_action_items).toEqual([]);
    expect(
      reviewed.draft.sections[0]!.items[0]!.sources.map((span) => span.segment),
    ).toEqual([0, 2]);
  });
  it('repairs a stale explicit overview from the same supplied source', async () => {
    const notes = coverageFixture(
      [{ speaker: 'Noor', text: 'The export works now.' }],
      'The export works now',
      0,
      'point',
    );
    notes.draft.overview = {
      id: 'overview',
      text: 'The export is still broken',
      sources: [{ segment: 0, start: 0, end: 21 }],
    };
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      encode([], [], { text: 'The export now works.', sources: ['R0'] }),
    );
    expect(projectAuditedNotes(reviewed).overview).toBe(
      'The export now works.',
    );
  });
  it.each([
    { sources: ['R99'] },
    { sources: [] },
    { sources: ['R0', 'R0'] },
    { sources: [{ segment: 0, start: 0, end: 3 }] },
    { id: 'model-assigned-id' },
    { owner: 'Invented Person' },
    { due: 'Friday' },
  ])(
    'does not insert unsupported or malformed additions: %j',
    async (change) => {
      const { notes } = fixture('The pilot is in staging.');
      const before = structuredClone(notes.draft);
      const { id: _id, ...addition } = resolution({
        kind: 'point',
        owner: null,
        text: 'The pilot is in staging.',
      });
      const reviewed = await reviewSourceBoundNotes(notes, async () =>
        encode([], [{ ...addition, ...change }]),
      );
      expect(reviewed.draft).toEqual(before);
      expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
    },
  );
  it('accepts an empty correction batch as a complete review without rewriting notes', async () => {
    const { notes } = fixture();
    const before = structuredClone(notes.draft);
    const reviewed = await reviewSourceBoundNotes(notes, async () => encode());
    expect(reviewed.draft).toEqual(before);
  });
  it('does not anchor the reviewer to writer kinds or normalized broad discussion', async () => {
    const { notes } = fixture(
      'I will publish the checklist. If approval arrives, I will enable the pilot.',
      'Publish the checklist',
    );
    const generate = vi.fn(async ({ prompt }) => {
      const data = JSON.parse(prompt.split('\n').at(-1)!);
      expect(data.draft.items[0]).toEqual([
        'I0',
        'Publish the checklist',
        ['R0'],
      ]);
      expect(data.source[0]).toEqual([
        'R0',
        'Remote Speaker 2',
        'I will publish the checklist. If approval arrives, I will enable the pilot.',
      ]);
      return JSON.stringify({
        reviews: { I0: resolution({ text: 'Publish the checklist' }) },
        additions: [],
        overview: null,
      });
    });
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    expect(projectAuditedNotes(reviewed).all_action_items[0]!.text).toBe(
      'Publish the checklist',
    );
  });
  it('applies a source-reviewed classification without rewriting accurate discussion', async () => {
    const notes = coverageFixture(
      [
        {
          speaker: 'Tavi',
          text: 'We discussed the layout; no changes were agreed.',
        },
      ],
      'No changes were agreed for the layout',
      0,
      'point',
    );
    notes.draft.sections[0]!.items[0]!.kind = 'decision';
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      JSON.stringify({
        reviews: { I0: 'point' },
        additions: [],
        overview: null,
      }),
    );
    expect(projectAuditedNotes(reviewed).all_decisions).toEqual([]);
    expect(reviewed.draft.sections[0]!.items[0]!.text).toBe(
      'No changes were agreed for the layout',
    );
  });
  it.each([
    {},
    { I0: 'accepted_action' },
    { foreign: 'point' },
    { I0: [] },
    { I0: {} },
    null,
  ])('rejects missing or unsupported item reviews: %j', async (reviews) => {
    const { notes } = fixture();
    const before = structuredClone(notes.draft);
    const result = await reviewSourceBoundNotes(notes, async () =>
      JSON.stringify({ reviews, additions: [], overview: null }),
    );
    expect(result.draft).toEqual(before);
    expect(result.issues).toContain('semantic_notes_review_unavailable');
  });
  it('rejects extra review ids instead of applying part of a batch', async () => {
    const { notes } = fixture();
    const before = structuredClone(notes.draft);
    const result = await reviewSourceBoundNotes(notes, async () =>
      JSON.stringify({
        reviews: { I0: resolution(), foreign: 'point' },
        additions: [],
        overview: null,
      }),
    );
    expect(result.draft).toEqual(before);
    expect(result.issues).toContain('semantic_notes_review_unavailable');
  });
  it('retires heuristic repair signals only after a complete successful source review', async () => {
    const { notes } = fixture('The export succeeded.');
    notes.draft.sections[0]!.items[0]!.kind = 'point';
    notes.issues = [
      'notes_guardrail:missing_action',
      'deterministic_unsupported_commitment:task',
      'semantic_notes_review_unavailable',
      'notes_leaf_audit_fallback:deadline_budget',
    ];
    const reviewed = await reviewSourceBoundNotes(notes, async () =>
      JSON.stringify({
        reviews: { I0: 'point' },
        additions: [],
        overview: null,
      }),
    );
    expect(reviewed.issues).toEqual([
      'notes_leaf_audit_fallback:deadline_budget',
    ]);
    const failed = fixture();
    failed.notes.issues = ['notes_guardrail:missing_action'];
    const incomplete = await reviewSourceBoundNotes(failed.notes, async () => {
      throw Error('usage_limit');
    });
    expect(incomplete.issues).toContain('notes_guardrail:missing_action');
    expect(incomplete.issues).toContain('semantic_notes_review_unavailable');
  });
});
