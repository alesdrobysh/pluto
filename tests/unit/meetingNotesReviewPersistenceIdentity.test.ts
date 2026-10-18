import { describe, expect, it } from 'vitest';
import {
  acceptEditedNotes,
  projectAuditedNotes,
} from '../../electron/llm/meetingNotesAudit';
import { reviewSourceBoundNotes } from '../../electron/llm/meetingNotesSemanticReview';
import { createNotesSource } from '../../electron/llm/meetingNotesSource';
import type {
  NotesDraft,
  NotesItem,
} from '../../electron/llm/meetingNotesTypes';
import { getAnalysisEditBlocks } from '../../src/utils/analysisDocument';
import { rebaseMeetingNotesEdits } from '../../src/utils/meetingNotesEditRebase';
import { notesSemanticReviewCases } from '../fixtures/notes-semantic-review';
import { scoreNotesSemanticCollection } from '../manual/fixtures/notesSemanticEvidence';
const originalActionResponse =
  '{"reviews":{"I0":{"kind":"accepted_action","text":"Put time with Riley on the calendar once legal approves the plan","owner":"Me","due":null,"sources":["R2"]}},"additions":[{"kind":"point","text":"Riley was suggested to review onboarding and design the experience","owner":null,"due":null,"sources":["R0","R1"]},{"kind":"accepted_action","text":"Put time with Riley on the calendar once legal approves the plan","owner":"Me","due":null,"sources":["R2"]}],"overview":null}';
const addedActionResponse =
  '{"reviews":{"I0":{"kind":"point","text":"Me suggested sitting down with Riley to review onboarding and have Riley design the experience.","owner":null,"due":null,"sources":["R0"]}},"additions":[{"kind":"accepted_action","text":"Put time with Riley on the calendar once legal approves the plan","owner":"Me","due":null,"sources":["R2"]},{"kind":"point","text":"Them suggested that Me speak to Riley.","owner":null,"due":null,"sources":["R1"]}], "overview":null}';
const gold = notesSemanticReviewCases.find(
  (row) => row.id === 'definite-combined-plan-and-promise',
)!;
const replay = async (raw: string) => {
  const source = createNotesSource(JSON.stringify(gold.lines));
  const sources = source.segments.map((segment) => ({
    segment: segment.index,
    start: 0,
    end: segment.text.length,
  }));
  const draft: NotesDraft = {
    title: null,
    meetingType: 'general',
    overview: null,
    sections: [
      {
        id: 'section',
        title: { id: 'heading', text: 'Review', sources },
        items: [{ id: 'claim-0', ...gold.claim, sources }],
      },
    ],
  };
  const reviewed = await reviewSourceBoundNotes(
    acceptEditedNotes({ source, draft, acceptancePolicy: 'conservative' }),
    async () => raw,
  );
  return {
    reviewed,
    document: projectAuditedNotes(reviewed),
    items: reviewed.draft.sections.flatMap((section) => section.items),
  };
};
const sourceFailures = (items: NotesItem[]) => {
  const failures = scoreNotesSemanticCollection(items, gold.expected);
  const actions = items.filter((item) => item.kind === 'action');
  if (actions.length !== 1) failures.push('action_count');
  if (actions[0]?.owner !== gold.expected.owner) failures.push('owner');
  if (actions[0]?.due !== gold.expected.due) failures.push('due');
  if (
    gold.expected.required.some(
      (word) => !actions[0]?.text.toLowerCase().includes(word.toLowerCase()),
    )
  )
    failures.push('scope');
  return failures;
};
describe('semantic review IDs and persisted action edit identity', () => {
  it('preserves action projections and user overlays when an accurately split action receives an addition ID', async () => {
    const before = await replay(originalActionResponse);
    const after = await replay(addedActionResponse);
    expect(before.items.find((item) => item.id === 'claim-0')?.kind).toBe(
      'action',
    );
    expect(after.items.find((item) => item.id === 'claim-0')?.kind).toBe(
      'point',
    );
    expect(after.items.find((item) => item.kind === 'action')?.id).toBe(
      'semantic-addition:0',
    );
    expect(sourceFailures(before.items)).toEqual([]);
    expect(sourceFailures(after.items)).toEqual([]);
    const canonicalFields = (
      actions: typeof before.document.all_action_items,
    ) => actions.map(({ topic, ...action }) => action);
    expect(canonicalFields(after.document.all_action_items)).toEqual(
      canonicalFields(before.document.all_action_items),
    );
    expect(before.document.all_action_items[0]?.topic).toBe('Review');
    expect(after.document.all_action_items[0]?.topic).toBe(
      'Additional context',
    );
    const action = after.document.all_action_items[0]!;
    expect(action).toMatchObject({
      text: 'Put time with Riley on the calendar once legal approves the plan',
      assignee: 'Me',
    });
    expect(action.due).toBeUndefined();
    expect(action.evidence).toContain(
      'I will put time with Riley on the calendar once legal approves the plan.',
    );
    const actionBlock = (document: typeof before.document) =>
      getAnalysisEditBlocks(document).filter(
        (block) =>
          block.path === 'all_action_items:0' ||
          block.path === 'completion:all_action_items:0',
      );
    expect(actionBlock(after.document)).toEqual(actionBlock(before.document));
    expect(
      before.document.generation_metadata?.source_provenance?.blocks[
        'all_action_items:0'
      ]?.id,
    ).toBe('claim-0');
    expect(
      after.document.generation_metadata?.source_provenance?.blocks[
        'all_action_items:0'
      ]?.id,
    ).toBe('semantic-addition:0');
    const edits = {
      'all_action_items:0': {
        original: action.text,
        edited: 'Arrange the Riley follow-up after approval.',
        edited_at: '2026-10-18T12:00:00Z',
      },
      'completion:all_action_items:0': { original: 'false', edited: 'true' },
    };
    expect(
      rebaseMeetingNotesEdits({
        edits,
        previousBlocks: getAnalysisEditBlocks(before.document),
        nextBlocks: getAnalysisEditBlocks(after.document),
      }),
    ).toEqual({ edits, conflicts: [] });
  });
  it.each(['scope', 'owner', 'due'] as const)(
    'still rejects a factual %s error independently of draft IDs',
    async (dimension) => {
      const response = JSON.parse(addedActionResponse);
      const action = response.additions.find(
        (item: any) => item.kind === 'accepted_action',
      );
      if (dimension === 'scope')
        action.text += ' and have Riley design the experience';
      if (dimension === 'owner') action.owner = 'Riley';
      if (dimension === 'due') action.due = { source: 'R2', quote: 'Monday' };
      const corrupted = await replay(JSON.stringify(response));
      expect(sourceFailures(corrupted.items).length).toBeGreaterThan(0);
    },
  );
});
