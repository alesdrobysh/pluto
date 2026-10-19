import { expect, it, vi } from 'vitest';
import {
  applyNotesAudit,
  projectAuditedNotes,
} from '../../electron/llm/meetingNotesAudit';
import { generateMeetingNotes } from '../../electron/llm/meetingNotesPipeline';
import type {
  NotesDraft,
  NotesItem,
  NotesRequest,
} from '../../electron/llm/meetingNotesTypes';
import { createNotesWireRequest } from '../../electron/llm/meetingNotesWire';
import { getAnalysisEditBlocks } from '../../src/utils/analysisDocument';
import { buildMeetingNotesDocument } from '../../src/utils/meetingNotesDocument';
import {
  applyMeetingNotesUserEdit,
  rebaseMeetingNotesEdits,
} from '../../src/utils/meetingNotesEditRebase';
import captured from '../fixtures/meeting-notes-qualified-publication-seed41.json';
import {
  makeDirectNotesFixture,
  makeNotesContext,
  makeSyntheticNotesSource,
} from '../fixtures/meeting-notes-v10';

const projectSections = (
  groups: Array<
    Array<Pick<NotesItem, 'kind' | 'text'> & Partial<Pick<NotesItem, 'owner'>>>
  >,
  explicitOverview = false,
) => {
  const source = makeSyntheticNotesSource(
    groups.flatMap((group) =>
      group.map((item) => ({ speaker: 'Milo', text: item.text })),
    ),
  );
  let index = 0;
  const draft: NotesDraft = {
    meetingType: 'general',
    overview: null,
    sections: groups.map((group, sectionIndex) => {
      const items = group.map((item, itemIndex) => {
        const segment = source.segments[index++]!;
        return {
          ...item,
          id: `s${sectionIndex}:item:${itemIndex}`,
          sources: [
            { segment: segment.index, start: 0, end: segment.text.length },
          ],
          owner: item.owner ?? null,
          due: null,
        };
      });
      return {
        id: `s${sectionIndex}`,
        title: {
          id: `s${sectionIndex}:title`,
          text: `Topic ${sectionIndex + 1}`,
          sources: items[0]!.sources,
        },
        items,
      };
    }),
  };
  if (explicitOverview)
    draft.overview = { ...draft.sections[0]!.items[0]!, id: 'overview' };
  const blocks = [
    ...(draft.overview ? [draft.overview] : []),
    ...draft.sections.flatMap((section) => [section.title, ...section.items]),
  ];
  const result = projectAuditedNotes(
    applyNotesAudit({
      source,
      draft,
      audit: {
        changes: [],
        dispositions: [],
        terminology: [],
        verdicts: blocks.map((block) => ({
          target: block.id,
          status: 'supported',
          sources: block.sources,
        })),
      },
    }),
  );
  return { result, draft };
};

it('summarizes action-only follow-ups with matching provenance', () => {
  const fixture = makeDirectNotesFixture();
  const action = fixture.draft.sections[0]!.items[0]!;
  const result = projectAuditedNotes(applyNotesAudit(fixture));
  expect(result.all_action_items[0]!.text).toBe('Send the outline');
  expect(result.overview).toBe('The meeting recorded 1 follow-up.');
  expect(
    result.generation_metadata?.source_provenance?.blocks.overview?.sources,
  ).toEqual(action.sources);
});

it.each([
  [
    { kind: 'action' as const, text: 'I will send the outline.' },
    { kind: 'decision' as const, text: 'We decided to keep the report plain.' },
  ],
  [
    { kind: 'decision' as const, text: 'We decided to keep the report plain.' },
    { kind: 'action' as const, text: 'I will send the outline.' },
  ],
])(
  'keeps discussion and decisions in the recap without repeating action commands',
  (first, second) => {
    const { result, draft } = projectSections([
      [
        { kind: 'point', text: 'The discussion covered the report.' },
        first,
        second,
        { kind: 'point', text: 'The report includes a diagram.' },
      ],
    ]);
    expect(result.all_action_items[0]!.text).toBe('Send the outline');
    expect(result.overview).toBe(
      'The discussion covered the report. We decided to keep the report plain. The report includes a diagram.',
    );
    expect(
      result.generation_metadata?.source_provenance?.blocks.overview?.sources,
    ).toEqual(
      [0, first.kind === 'decision' ? 1 : 2, 3].flatMap(
        (index) => draft.sections[0]!.items[index]!.sources,
      ),
    );
  },
);

it('keeps narrative-only topics in section order before filling their remaining details', () => {
  const { result, draft } = projectSections([
    [
      { kind: 'point', text: 'The first loaf was flat.' },
      { kind: 'point', text: 'The second loaf rose.' },
    ],
    [{ kind: 'point', text: 'The radio still hums.' }],
  ]);
  expect(result.overview).toBe(
    'The first loaf was flat. The radio still hums. The second loaf rose.',
  );
  expect(
    result.generation_metadata?.source_provenance?.blocks.overview?.sources,
  ).toEqual([
    ...draft.sections[0]!.items[0]!.sources,
    ...draft.sections[1]!.items[0]!.sources,
    ...draft.sections[0]!.items[1]!.sources,
  ]);
});

it('leaves an explicit reviewed overview and its provenance untouched', () => {
  const { result, draft } = projectSections(
    [
      [
        { kind: 'point', text: 'The outline needs a diagram.' },
        { kind: 'action', text: 'I will send the outline.' },
      ],
    ],
    true,
  );
  expect(result.overview).toBe(draft.overview!.text);
  expect(
    result.generation_metadata?.source_provenance?.blocks.overview,
  ).toEqual(
    draft.overview && {
      id: draft.overview.id,
      sources: draft.overview.sources,
    },
  );
});

it.each(['decision-first', 'offer-first'])(
  'represents each reviewed topic in the fallback instead of promoting only the declined offer: %s',
  async (order) => {
    const writer = JSON.parse(captured.writerRaw);
    const audit = JSON.parse(captured.repairedAuditRaw);
    if (order === 'offer-first') {
      // Reproduce the notes-v20 seed41 writer ordering with the same captured
      // statements and matching review targets, without a model call.
      writer.sections[0].items.reverse();
      for (const verdict of audit.verdicts) {
        if (verdict.target === 's0:item:0') verdict.target = 's0:item:1';
        else if (verdict.target === 's0:item:1') verdict.target = 's0:item:0';
      }
    }
    const replies = [JSON.stringify(writer), JSON.stringify(audit)];
    const generate = vi.fn(async (request: NotesRequest) => {
      const raw = replies.shift();
      if (!raw) throw new Error('offline_replay_exhausted');
      return createNotesWireRequest(
        request.prompt,
        request.sourceSpans ?? [],
      ).decode(raw);
    });
    const result = await generateMeetingNotes({
      source: structuredClone(captured.source),
      context: makeNotesContext(),
      generate,
      provider: 'ollama',
      model: 'gemma4:12b',
      contextTokens: 16384,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    const decision = result.all_decisions[0]!.text;
    const offer = result.topics[0]!.key_points[0]!.text;
    const withdrawal = result.topics[1]!.key_points[0]!.text;
    expect(result.overview).toBe(
      (order === 'decision-first'
        ? [decision, withdrawal, offer]
        : [offer, withdrawal, decision]
      ).join(' '),
    );
    const metadata = result.generation_metadata!.source_provenance!.blocks;
    const recapPaths =
      order === 'decision-first'
        ? ['all_decisions:0', 'topic:1:point:0', 'topic:0:point:0']
        : ['topic:0:point:0', 'topic:1:point:0', 'all_decisions:0'];
    expect(metadata.overview?.sources).toEqual(
      recapPaths.flatMap((path) => metadata[path]!.sources),
    );
    expect(result.all_action_items).toHaveLength(1);
    expect(result.all_action_items[0]!.text).toContain(
      'once the accessibility review passes',
    );
    expect(result.all_action_items[0]!.due).toBe('Wednesday');
  },
);

it('retains discussion as body points without duplicate topic summaries', () => {
  const { result, draft } = projectSections([
    [
      { kind: 'point', text: 'Cedar seemed promising.' },
      { kind: 'point', text: 'The quote is only an estimate.' },
      { kind: 'decision', text: 'We decided to trial Birch.' },
    ],
  ]);
  expect(result.topics[0]!.summary).toBe('');
  expect(result.topics[0]!.key_points).toEqual([
    { text: 'Cedar seemed promising.' },
    { text: 'The quote is only an estimate.' },
  ]);
  const blocks = result.generation_metadata!.source_provenance!.blocks;
  expect(blocks['topic:0:summary']).toBeUndefined();
  for (const index of [0, 1])
    expect(blocks[`topic:0:point:${index}`]).toEqual({
      id: `s0:item:${index}`,
      sources: draft.sections[0]!.items[index]!.sources,
    });
});

it('keeps a conditional owned action separate from the narrative recap', () => {
  const { result, draft } = projectSections([
    [
      { kind: 'point', text: 'Cedar seemed promising.' },
      { kind: 'point', text: 'The estimate remains uncertain.' },
    ],
    [
      {
        kind: 'action',
        owner: 'Milo',
        text: 'If approval arrives, Milo will send the outline by Thursday.',
      },
    ],
  ]);
  expect(result.topics[0]!.summary).toBe('');
  expect(result.topics[0]!.key_points.map((point) => point.text)).toEqual(
    draft.sections[0]!.items.map((item) => item.text),
  );
  expect(result.overview).toBe(
    'Cedar seemed promising. The estimate remains uncertain.',
  );
  expect(result.topics[1]!.summary).toBe('');
  expect(result.all_action_items[0]!.assignee).toBe('Milo');
  expect(result.all_action_items[0]!.text).toBe(
    'If approval arrives, Milo will send the outline by Thursday',
  );
  const blocks = result.generation_metadata!.source_provenance!.blocks;
  expect(blocks.overview!.sources).toEqual(
    draft.sections[0]!.items.flatMap((item) => item.sources),
  );
  expect(blocks['topic:1:summary']).toBeUndefined();
  expect(blocks['topic:0:point:0']).toEqual({
    id: 's0:item:0',
    sources: draft.sections[0]!.items[0]!.sources,
  });
});

it('keeps an unnamed speaker action separate from the reader', () => {
  const fixture = makeDirectNotesFixture();
  fixture.source = {
    ...fixture.source,
    segments: fixture.source.segments.map((segment) => ({
      ...segment,
      speaker: null,
    })),
  };
  fixture.draft.sections[0]!.items[0]!.owner = null;
  const result = projectAuditedNotes(applyNotesAudit(fixture));
  expect(result.all_action_items[0]!.assignee).toBe('Speaker');
  expect(result.all_action_items[0]!.text).toBe('Send the outline');
  expect(result.overview).toBe('The meeting recorded 1 follow-up.');
  expect(result.topics[0]!.summary).toBe('');
});

it.each(['action', 'decision'] as const)(
  'preserves a %s edit through actual block extraction without duplicate topic summaries',
  (kind) => {
    const group = [
      { kind: 'point' as const, text: 'The quote remains uncertain.' },
      {
        kind,
        owner: 'Milo',
        text:
          kind === 'action'
            ? 'Milo will send the outline.'
            : 'We decided to keep the report plain.',
      },
    ];
    const previous = projectSections([group]).result;
    const next = projectSections([group]).result;
    const original = structuredClone(next);
    const outcomePath =
      kind === 'action' ? 'all_action_items:0' : 'all_decisions:0';
    const outcome =
      kind === 'action'
        ? previous.all_action_items[0]!
        : previous.all_decisions[0]!;
    const { edits } = applyMeetingNotesUserEdit(
      {},
      outcomePath,
      outcome.text,
      'User clarification of the outcome.',
      '2026-10-10T12:00:00Z',
    );
    const previousBlocks = getAnalysisEditBlocks(previous);
    const nextBlocks = getAnalysisEditBlocks(next);
    if (kind === 'decision') {
      expect(previous.overview).toBe(
        `The quote remains uncertain. ${outcome.text}`,
      );
      expect(
        previous.generation_metadata!.source_provenance!.blocks.overview!
          .sources,
      ).toEqual([
        ...previous.generation_metadata!.source_provenance!.blocks[
          'topic:0:point:0'
        ]!.sources,
        ...previous.generation_metadata!.source_provenance!.blocks[outcomePath]!
          .sources,
      ]);
    }
    const overviewEdit = applyMeetingNotesUserEdit(
      {},
      'overview',
      previous.overview,
      'User overview clarification.',
      '2026-10-10T12:00:00Z',
    );
    const rebasedOverview = rebaseMeetingNotesEdits({
      edits: overviewEdit.edits,
      previousBlocks,
      nextBlocks,
    });
    expect(rebasedOverview.conflicts).toEqual([]);
    expect(Object.keys(rebasedOverview.edits)).toEqual(['overview']);
    expect(rebasedOverview.edits.overview!.edited).toBe(
      'User overview clarification.',
    );
    expect(nextBlocks.some((block) => block.path === 'topic:0:summary')).toBe(
      false,
    );
    const rebased = rebaseMeetingNotesEdits({
      edits,
      previousBlocks,
      nextBlocks,
    });
    expect(rebased.conflicts).toEqual([]);
    expect(Object.keys(rebased.edits)).toEqual([outcomePath]);
    const document = buildMeetingNotesDocument({
      v2: null,
      v3: next,
      userNotes: '',
      editsMap: rebased.edits,
    });
    const visible = document.sections.flatMap((section) => section.blocks);
    expect(visible.find((block) => block.path === outcomePath)).toMatchObject({
      text: 'User clarification of the outcome.',
      edited: true,
      ...(kind === 'action' ? { assignee: 'Milo' } : {}),
    });
    expect(
      visible.find((block) => block.path === 'topic:0:point:0'),
    ).toMatchObject({ text: 'The quote remains uncertain.', edited: false });
    expect(next).toEqual(original);
  },
);

it('rebases an existing discussion summary edit to its retained body point', () => {
  const next = projectSections([
    [
      { kind: 'point', text: 'The quote remains uncertain.' },
      { kind: 'decision', text: 'We decided to keep the report plain.' },
    ],
  ]).result;
  const previous = structuredClone(next);
  previous.topics[0]!.summary = previous.topics[0]!.key_points.shift()!.text;
  const metadata = previous.generation_metadata!.source_provenance!.blocks;
  metadata['topic:0:summary'] = metadata['topic:0:point:0']!;
  previous.generation_metadata!.source_provenance!.blocks = Object.fromEntries(
    Object.entries(metadata).filter(([path]) => path !== 'topic:0:point:0'),
  );
  const { edits } = applyMeetingNotesUserEdit(
    {},
    'topic:0:summary',
    previous.topics[0]!.summary,
    'The quote needs confirmation.',
    '2026-10-10T12:00:00Z',
  );
  const rebased = rebaseMeetingNotesEdits({
    edits,
    previousBlocks: getAnalysisEditBlocks(previous),
    nextBlocks: getAnalysisEditBlocks(next),
  });
  expect(rebased.conflicts).toEqual([]);
  expect(Object.keys(rebased.edits)).toEqual(['topic:0:point:0']);
  expect(rebased.edits['topic:0:point:0']!.edited).toBe(
    'The quote needs confirmation.',
  );
});
