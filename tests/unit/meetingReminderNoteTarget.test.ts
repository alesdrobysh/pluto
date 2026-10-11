import { expect, it } from 'vitest';
import {
  type MeetingNotesSection,
  findReminderNoteBlock,
} from '../../src/utils/meetingNotesDocument';

const block = {
  id: 'a',
  path: 'all_action_items:0',
  text: 'Send the updated plan.',
  originalText: 'Send the plan.',
  blockType: 'action' as const,
  authorship: 'ai' as const,
  edited: true,
};
const sections: MeetingNotesSection[] = [
  {
    id: 'outcomes',
    kind: 'outcomes',
    title: 'Decisions & next steps',
    blocks: [block],
  },
];
const entity = {
  name: 'Send the plan.',
  metadata: JSON.stringify({
    source_meeting_id: 'meeting-a',
    source_path: 'all_action_items:0',
    original_description: 'Send the plan.',
  }),
};

it('finds the source-backed action after a user edits its visible text', () => {
  expect(findReminderNoteBlock(sections, entity, 'meeting-a')).toBe(block);
});
it('does not focus an action from another meeting or a retired commitment', () => {
  expect(findReminderNoteBlock(sections, entity, 'meeting-b')).toBeNull();
  expect(
    findReminderNoteBlock(
      sections,
      {
        ...entity,
        metadata: JSON.stringify({
          source_meeting_id: 'meeting-a',
          meeting_regeneration_retired_at: '2026-10-11',
        }),
      },
      'meeting-a',
    ),
  ).toBeNull();
});
it('does not trust a stale index when the source description changed', () => {
  expect(
    findReminderNoteBlock(
      [
        {
          ...sections[0],
          blocks: [{ ...block, originalText: 'Prepare a different task.' }],
        },
      ],
      entity,
      'meeting-a',
    ),
  ).toBeNull();
});
it('requires an unambiguous exact match for legacy commitments without a source path', () => {
  const legacy = {
    ...entity,
    metadata: JSON.stringify({ source_meeting_id: 'meeting-a' }),
  };
  expect(findReminderNoteBlock(sections, legacy, 'meeting-a')).toBe(block);
  expect(
    findReminderNoteBlock(
      [
        {
          ...sections[0],
          blocks: [block, { ...block, id: 'b', path: 'all_action_items:1' }],
        },
      ],
      legacy,
      'meeting-a',
    ),
  ).toBeNull();
});
