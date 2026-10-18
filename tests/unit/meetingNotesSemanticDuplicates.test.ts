import { describe, expect, it } from 'vitest';
import {
  acceptEditedNotes,
  applySourceBoundSemanticReview,
  projectAuditedNotes,
} from '../../electron/llm/meetingNotesAudit';
import { reviewSourceBoundNotes } from '../../electron/llm/meetingNotesSemanticReview';
import { createNotesSource } from '../../electron/llm/meetingNotesSource';
import type { NotesItem } from '../../electron/llm/meetingNotesTypes';

const fixture = (kind: NotesItem['kind'] = 'point', separateSource = false) => {
  const source = createNotesSource(
    JSON.stringify([
      { speaker: 'Me', text: 'I will coordinate the pilot after approval.' },
      { speaker: 'Them', text: 'The checklist still needs review.' },
    ]),
  );
  const span = (segment: number) => ({
    segment,
    start: 0,
    end: source.segments[segment]!.text.length,
  });
  return acceptEditedNotes({
    source,
    acceptancePolicy: 'conservative',
    draft: {
      title: null,
      meetingType: 'general',
      overview: null,
      sections: [
        {
          id: 'pilot',
          title: { id: 'heading', text: 'Pilot', sources: [span(0)] },
          items: [
            {
              id: 'narrative',
              kind,
              text: 'Me will coordinate the pilot after approval.',
              owner: kind === 'action' ? 'Me' : null,
              due: null,
              sources: [span(separateSource ? 1 : 0)],
            },
            {
              id: 'task',
              kind: 'action',
              text: 'Coordinate the pilot after approval',
              owner: 'Me',
              due: null,
              sources: [span(0)],
            },
          ],
        },
      ],
    },
  });
};
const action = {
  kind: 'accepted_action',
  text: 'Coordinate the pilot after approval',
  owner: 'Me',
  due: null,
  sources: ['R0'],
};
const replay = (
  notes: ReturnType<typeof fixture>,
  first: unknown,
  second: unknown = action,
) =>
  reviewSourceBoundNotes(notes, async () =>
    JSON.stringify({
      reviews: { I0: first, I1: second },
      additions: [],
      overview: null,
    }),
  );

describe('source-bound semantic duplicate identity', () => {
  it('folds an explicitly identified narrative into a reconstructed task, preserving its owner, condition and evidence', async () => {
    const notes = fixture();
    const reviewed = await replay(notes, { duplicate_of: 'I1' });
    expect(reviewed.draft.sections[0]!.items.map((item) => item.id)).toEqual([
      'task',
    ]);
    const result = projectAuditedNotes(reviewed);
    expect(result.all_action_items).toEqual([
      expect.objectContaining({ text: action.text, assignee: 'Me' }),
    ]);
    expect(
      result.generation_metadata?.source_provenance?.blocks[
        'all_action_items:0'
      ],
    ).toMatchObject({
      id: 'task',
      sources: notes.draft.sections[0]!.items[1]!.sources,
    });
    expect(reviewed.issues ?? []).not.toContain(
      'semantic_notes_review_unavailable',
    );
  });

  it('keeps both items when no semantic duplicate identity is supplied', async () => {
    const reviewed = await replay(fixture(), { ...action, owner: null });
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
  });

  it.each([
    { duplicate_of: 'I0' },
    { duplicate_of: 'I9' },
    { duplicate_of: 1 },
    { duplicate_of: 'I1', text: 'extra field' },
  ])('preserves the original on an invalid identity: %j', async (alias) => {
    const reviewed = await replay(fixture(), alias);
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('never folds an original commitment through a narrative shortcut', async () => {
    const reviewed = await replay(fixture('action'), { duplicate_of: 'I1' });
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('protects an original action even after a deterministic guard demotes it', async () => {
    const notes = fixture('action');
    expect(notes.reviewOriginals?.get('narrative')?.kind).toBe('action');
    notes.draft.sections[0]!.items[0]!.kind = 'point';
    notes.draft.sections[0]!.items[0]!.owner = null;
    const reviewed = await replay(notes, { duplicate_of: 'I1' });
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('validates narrative protection at the shared audit boundary too', () => {
    const notes = fixture('action');
    expect(() =>
      applySourceBoundSemanticReview(notes, [], {
        sourceSpans: notes.draft.sections[0]!.items[1]!.sources,
        additions: [],
        narrativeDuplicates: [{ id: 'narrative', retainedId: 'task' }],
      }),
    ).toThrow('invalid_notes_audit');
    expect(notes.draft.sections[0]!.items).toHaveLength(2);
  });

  it('keeps a narrative with source evidence absent from the retained task', async () => {
    const reviewed = await replay(fixture('point', true), {
      duplicate_of: 'I1',
    });
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('does not follow duplicate chains or cycles', async () => {
    const reviewed = await replay(
      fixture(),
      { duplicate_of: 'I1' },
      { duplicate_of: 'I0' },
    );
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('keeps the narrative if the retained task fails owner validation', async () => {
    const reviewed = await replay(
      fixture(),
      { duplicate_of: 'I1' },
      { ...action, owner: 'Ari' },
    );
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });
});
