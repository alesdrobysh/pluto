import { describe, expect, it } from 'vitest';
import {
  acceptEditedNotes,
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
  it('folds a reconstructed narrative into an identical task, preserving owner, condition and evidence', async () => {
    const notes = fixture();
    const reviewed = await replay(notes, action);
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

  it.each([
    { owner: null },
    { text: 'Coordinate the pilot only after security approval' },
    { sources: ['R0', 'R1'] },
    { kind: 'point', owner: null },
  ])('preserves differing structured facts: %j', async (difference) => {
    const reviewed = await replay(fixture(), { ...action, ...difference });
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
  });

  it.each([false, true])(
    'protects original commitments, including after guard demotion: %s',
    async (demoted) => {
      const notes = fixture('action');
      expect(notes.reviewOriginals?.get('narrative')?.kind).toBe('action');
      if (demoted) {
        notes.draft.sections[0]!.items[0]!.kind = 'point';
        notes.draft.sections[0]!.items[0]!.owner = null;
      }
      const reviewed = await replay(notes, action);
      expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
    },
  );

  it('retains evidence and identity when a candidate fails owner validation', async () => {
    const reviewed = await replay(fixture(), { ...action, owner: 'Ari' });
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
    expect(reviewed.issues).toContain('semantic_notes_review_unavailable');
  });

  it('keeps independently worded narratives without a complete reconstructed match', async () => {
    const reviewed = await replay(fixture(), 'point');
    expect(reviewed.draft.sections[0]!.items).toHaveLength(2);
  });
});
