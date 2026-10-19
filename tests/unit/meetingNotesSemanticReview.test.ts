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
  id: 'task',
  kind: 'accepted_action',
  text: 'Tell Morgan about the pilot soon',
  owner: 'Remote Speaker 2',
  due: null,
  discussion: null,
  ...values,
});
const response = (values: Record<string, unknown> = {}) =>
  JSON.stringify({ resolutions: [resolution(values)] });

describe('bounded source-bound semantic notes review', () => {
  it('reviews gendered discussion against its own source without inferring identity from a name', async () => {
    const { notes } = fixture(
      'The lift worked. I felt relieved because carrying the pieces upstairs had worried me.',
      'Remote Speaker 2 felt relieved because she had worried about carrying the pieces upstairs.',
    );
    notes.draft.sections[0]!.items[0] = {
      ...notes.draft.sections[0]!.items[0]!,
      kind: 'point',
      text: 'Remote Speaker 2 felt relieved because she had worried about carrying the pieces upstairs.',
      owner: null,
      due: null,
    };
    notes.issues = [];
    notes.proseReviewItems = [];
    const generate = vi.fn(async ({ prompt }) => {
      expect(prompt).toContain('never infer gender from a name');
      expect(prompt).toContain('The lift worked. I felt relieved');
      return response({
        kind: 'point',
        text: 'Remote Speaker 2 felt relieved that the lift worked because carrying the pieces upstairs had been a concern.',
        owner: null,
      });
    });
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    expect(generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(projectAuditedNotes(reviewed).topics)).not.toMatch(
      /\bshe\b/,
    );
    expect(projectAuditedNotes(reviewed).all_action_items).toHaveLength(0);
  });
  it('restores a valid promise rejected by the legacy wording check and rebuilds canonical provenance', async () => {
    const { notes, sources } = fixture();
    expect(notes.draft.sections[0]!.items[0]!.kind).toBe('point');
    const generate = vi.fn(async () => response());
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    const result = projectAuditedNotes(reviewed);
    expect(generate).toHaveBeenCalledOnce();
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
      const cases = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      expect(cases[0].source[0].text).toBe('I will not book the review.');
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

  it('constrains unassigned results to null owner, due and discussion in the response schema', async () => {
    const { notes } = fixture();
    await reviewSourceBoundNotes(notes, async ({ responseSchema }) => {
      const schema = responseSchema as any;
      const branches = schema.properties.resolutions.items.anyOf;
      expect(branches).toHaveLength(2);
      expect(branches[0].properties.kind.enum).toEqual([
        'accepted_action',
        'decision',
      ]);
      expect(branches[1].properties.kind.enum).toEqual(['point', 'question']);
      for (const key of ['owner', 'due', 'discussion'])
        expect(branches[1].properties[key]).toEqual({ type: 'null' });
      return response();
    });
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

  it('does not issue requests for ordinary source-grounded discussion', async () => {
    const { notes } = fixture('The pilot remains in staging.');
    notes.draft.sections[0]!.items[0]!.kind = 'point';
    notes.issues = [];
    notes.proseReviewItems = [];
    const generate = vi.fn();
    expect(await reviewSourceBoundNotes(notes, generate)).toBe(notes);
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps useful notes when admission or the review fails, without retrying', async () => {
    const { notes } = fixture();
    const before = structuredClone(notes.draft);
    const generate = vi.fn(async () => {
      throw new Error('usage_limit');
    });
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    expect(generate).toHaveBeenCalledOnce();
    expect(reviewed.draft).toEqual(before);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('holds an oversized case while reviewing an independent smaller commitment in one request', async () => {
    const lines = [
      {
        speaker: 'Remote Speaker 2',
        text: `I will send the outline. ${'FICTIONAL_LARGE_SOURCE '.repeat(1000)}`,
      },
      { speaker: 'Me', text: "I'll send the checklist." },
    ];
    const source = createNotesSource(JSON.stringify(lines));
    const draft: NotesDraft = {
      title: null,
      meetingType: 'general',
      overview: null,
      sections: [
        {
          id: 's',
          title: {
            id: 'h',
            text: 'Follow-ups',
            sources: [{ segment: 1, start: 0, end: lines[1]!.text.length }],
          },
          items: lines.map((line, segment) => ({
            id: segment ? 'small' : 'large',
            kind: 'action',
            text: segment ? 'Send the checklist' : 'Send the outline',
            owner: line.speaker,
            due: null,
            sources: [{ segment, start: 0, end: line.text.length }],
          })),
        },
      ],
    };
    const notes = acceptEditedNotes({
      source,
      draft,
      acceptancePolicy: 'conservative',
    });
    const generate = vi.fn(async ({ prompt }) => {
      const cases = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      expect(cases.map((entry: { id: string }) => entry.id)).toEqual(['small']);
      expect(prompt).not.toContain('FICTIONAL_LARGE_SOURCE');
      return JSON.stringify({
        resolutions: [
          resolution({ id: 'small', text: 'Send the checklist', owner: 'Me' }),
        ],
      });
    });
    const reviewed = await reviewSourceBoundNotes(notes, generate);
    expect(generate).toHaveBeenCalledOnce();
    expect(reviewed.issues).toContain('semantic_notes_review_capacity:large');
    expect(projectAuditedNotes(reviewed).all_action_items).toContainEqual(
      expect.objectContaining({ text: 'Send the checklist', assignee: 'Me' }),
    );
  });

  it('caps source data and candidate counts before a request', async () => {
    const { notes } = fixture();
    const item = notes.draft.sections[0]!.items[0]!;
    notes.draft.sections[0]!.items = Array.from({ length: 17 }, (_, index) => ({
      ...item,
      id: String(index),
      kind: 'action',
    }));
    const generate = vi.fn();
    expect((await reviewSourceBoundNotes(notes, generate)).issues).toContain(
      'semantic_notes_review_capacity',
    );
    expect(generate).not.toHaveBeenCalled();
    const large = fixture(
      `Riley agreed to send the checklist. ${'context '.repeat(1600)}`,
    );
    large.notes.draft.sections[0]!.items[0]!.kind = 'action';
    expect(
      (await reviewSourceBoundNotes(large.notes, generate)).issues,
    ).toContain('semantic_notes_review_capacity');
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
        resolutions: [
          resolution(),
          resolution({ id: 'other', owner: 'Invented Person' }),
        ],
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
