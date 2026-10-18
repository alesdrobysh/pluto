import { describe, expect, it } from 'vitest';
import {
  acceptEditedNotes,
  projectAuditedNotes,
} from '../../electron/llm/meetingNotesAudit';
import { reviewSourceBoundNotes } from '../../electron/llm/meetingNotesSemanticReview';
import { createNotesSource } from '../../electron/llm/meetingNotesSource';
import type { NotesItem } from '../../electron/llm/meetingNotesTypes';
import { notesSemanticReviewCases } from '../fixtures/notes-semantic-review';
import {
  scoreNotesSemanticCollection,
  scoreNotesSemanticEvidence,
} from '../manual/fixtures/notesSemanticEvidence';

const source = createNotesSource(
  JSON.stringify([
    {
      speaker: 'Tavi',
      text: 'Coordinate Juniper and Kestrel only after security approves.',
    },
    { speaker: 'Ari', text: 'Riley owns this work; deliver it by Monday.' },
    { speaker: 'Riley', text: 'I accept that task.' },
  ]),
);
const requirements = [
  { lineIndex: 0, quote: 'Juniper and Kestrel' },
  { lineIndex: 0, quote: 'only after security approves' },
  { lineIndex: 1, quote: 'Riley owns this work' },
  { lineIndex: 1, quote: 'by Monday' },
  { lineIndex: 2, quote: 'I accept that task' },
];
const item: NotesItem = {
  id: 'original-task',
  kind: 'action',
  text: 'Coordinate Juniper and Kestrel by Monday only after security approves.',
  owner: 'Riley',
  due: 'Monday',
  sources: source.segments.map((segment) => ({
    segment: segment.index,
    start: 0,
    end: segment.text.length,
  })),
};

describe('semantic quality evidence oracle', () => {
  it('accepts exact coverage of scope, condition, ownership, deadline and acceptance', () => {
    expect(
      scoreNotesSemanticEvidence(source, item, 'original-task', requirements),
    ).toEqual([]);
  });
  it('rejects acceptance-only citations even when the text sounds correct', () => {
    expect(
      scoreNotesSemanticEvidence(
        source,
        { ...item, sources: item.sources.slice(2) },
        'original-task',
        requirements,
      ),
    ).toEqual([
      'missing_evidence:0:Juniper and Kestrel',
      'missing_evidence:0:only after security approves',
      'missing_evidence:1:Riley owns this work',
      'missing_evidence:1:by Monday',
    ]);
  });
  it('does not borrow evidence from unrelated added points or a swapped task ID', () => {
    expect(
      scoreNotesSemanticEvidence(
        source,
        { ...item, id: 'semantic-addition:0' },
        'original-task',
        requirements,
      ),
    ).toContain('original_claim_identity');
    expect(
      scoreNotesSemanticEvidence(
        source,
        undefined,
        'original-task',
        requirements,
      ),
    ).toEqual(['original_claim_missing']);
  });
  it('requires the cited span to cover the exact declared evidence, not merely its segment', () => {
    const start = source.segments[0]!.text.indexOf('Juniper');
    const scoped = {
      ...item,
      sources: [
        { segment: 0, start, end: start + 'Juniper and Kestrel'.length },
      ],
    };
    expect(
      scoreNotesSemanticEvidence(
        source,
        scoped,
        'original-task',
        requirements.slice(0, 2),
      ),
    ).toEqual(['missing_evidence:0:only after security approves']);
  });
  it('accepts contiguous evidence split across adjacent spans without accepting a gap', () => {
    const quote = 'Juniper and Kestrel';
    const start = source.segments[0]!.text.indexOf(quote);
    const sources = [
      { segment: 0, start, end: start + 7 },
      { segment: 0, start: start + 7, end: start + quote.length },
    ];
    expect(
      scoreNotesSemanticEvidence(
        source,
        { ...item, sources },
        'original-task',
        [requirements[0]!],
      ),
    ).toEqual([]);
    sources[1]!.start++;
    expect(
      scoreNotesSemanticEvidence(
        source,
        { ...item, sources },
        'original-task',
        [requirements[0]!],
      ),
    ).toEqual(['missing_evidence:0:Juniper and Kestrel']);
  });
  it.each([
    ['I will send it. I will send it.', 'I will send it'],
    ['aaaa', 'aa'],
  ])(
    'rejects ambiguous repeated evidence even when a cited occurrence exists',
    (text, quote) => {
      const repeated = createNotesSource(
        JSON.stringify([{ speaker: 'Riley', text }]),
      );
      expect(() =>
        scoreNotesSemanticEvidence(repeated, item, 'original-task', [
          { lineIndex: 0, quote },
        ]),
      ).toThrow('invalid_gold_evidence');
    },
  );
  it('fails invalid gold references instead of silently accepting an untestable case', () => {
    expect(() =>
      scoreNotesSemanticEvidence(source, item, 'original-task', [
        { lineIndex: 99, quote: 'missing' },
      ]),
    ).toThrow('invalid_gold_evidence');
    expect(() =>
      scoreNotesSemanticEvidence(source, item, 'original-task', [
        { lineIndex: 0, quote: 'invented' },
      ]),
    ).toThrow('invalid_gold_evidence');
  });
});

describe('fictional semantic evidence requirements', () => {
  it('resolves every required quote against the declared source without model calls', () => {
    const cases = notesSemanticReviewCases.filter(
      (row) => row.expected.evidence,
    );
    expect(cases).toHaveLength(9);
    for (const gold of cases) {
      const source = createNotesSource(JSON.stringify(gold.lines));
      const item: NotesItem = {
        id: 'original-task',
        ...gold.claim,
        sources: source.segments.map((row) => ({
          segment: row.index,
          start: 0,
          end: row.text.length,
        })),
      };
      expect(
        scoreNotesSemanticEvidence(
          source,
          item,
          'original-task',
          gold.expected.evidence!,
        ),
      ).toEqual([]);
    }
  });
});

describe('semantic collection oracle', () => {
  it('rejects unaccepted or duplicate additional actions even when the original task is correct', () => {
    expect(
      scoreNotesSemanticCollection(
        [item, { ...item, id: 'semantic-addition:0', owner: null }],
        { maxActionItems: 1 },
      ),
    ).toEqual(['excess_actions']);
    expect(
      scoreNotesSemanticCollection(
        [item, { ...item, id: 'semantic-addition:0' }],
        { maxActionItems: 2 },
      ),
    ).toEqual([]);
  });
  it('checks forbidden invented wording in additions without searching citations or due fields', () => {
    const expectations = {
      maxActionItems: 2,
      forbiddenAnywhere: ['about the work'],
    };
    expect(
      scoreNotesSemanticCollection(
        [
          item,
          {
            ...item,
            id: 'semantic-addition:0',
            text: 'Tell Casey about the work',
          },
        ],
        expectations,
      ),
    ).toEqual(['unsupported_text:about the work']);
    expect(
      scoreNotesSemanticCollection(
        [{ ...item, due: 'about the work' }],
        expectations,
      ),
    ).toEqual([]);
  });
  it('fails invalid action limits instead of silently disabling the count gate', () => {
    for (const maxActionItems of [-1, 1.5, Number.NaN])
      expect(() =>
        scoreNotesSemanticCollection([item], { maxActionItems }),
      ).toThrow('invalid_gold_action_limit');
  });
  it('declares source-audited action bounds and source-absent forbidden wording for all gold cases', () => {
    expect(notesSemanticReviewCases).toHaveLength(52);
    for (const gold of notesSemanticReviewCases) {
      expect(Number.isInteger(gold.expected.maxActionItems)).toBe(true);
      expect(gold.expected.maxActionItems).toBeGreaterThanOrEqual(0);
      for (const phrase of gold.expected.forbiddenAnywhere ?? [])
        expect(
          gold.lines.some((line) =>
            line.text.toLowerCase().includes(phrase.toLowerCase()),
          ),
        ).toBe(false);
    }
    const pairs = notesSemanticReviewCases.filter(
      (row) => row.expected.maxActionItems === 2,
    );
    expect(pairs.map((row) => row.id)).toEqual([
      'independent-unconditional',
      'independent-conditional',
      'reaffirmed-owner-self',
      'reaffirmed-owner-named',
    ]);
  });
});

describe('tentative scope oracle', () => {
  it('rejects accepted design scope in actions and overview while allowing an independent tentative point', () => {
    const gold = notesSemanticReviewCases.find(
      (row) => row.id === 'definite-combined-plan-and-promise',
    )!;
    const tentative = {
      ...item,
      kind: 'point' as const,
      owner: null,
      text: 'It was suggested to have Riley design the experience, but this work was not assigned.',
    };
    const calendar = {
      ...item,
      text: 'Schedule time with Riley once legal approves the plan',
    };
    expect(
      scoreNotesSemanticCollection([calendar, tentative], gold.expected, {
        text: 'Design was suggested; only the calendar follow-up was accepted.',
      }),
    ).toEqual([]);
    expect(
      scoreNotesSemanticCollection(
        [
          {
            ...calendar,
            text: 'Schedule time with Riley and have Riley design the experience',
          },
        ],
        gold.expected,
      ),
    ).toContain('unsupported_action_text:have Riley design the experience');
    expect(
      scoreNotesSemanticCollection([calendar], gold.expected, {
        text: 'The speaker will schedule time with Riley to review onboarding and have Riley design the experience once legal approves.',
      }),
    ).toContain(
      'unsupported_overview_text:the speaker will schedule time with Riley to review onboarding and have Riley design the experience',
    );
  });
});

describe('source-audited decision bounds', () => {
  it('rejects a tentative design decision added beside a valid calendar undertaking', () => {
    const gold = notesSemanticReviewCases.find(
      (row) => row.id === 'combined-plan-and-promise',
    )!;
    const calendar: NotesItem = {
      ...item,
      text: 'Schedule time with Riley depending on how we feel about the plan',
      owner: 'Me',
      due: null,
    };
    const design: NotesItem = {
      ...calendar,
      id: 'semantic-addition:0',
      kind: 'decision',
      text: 'Riley will design the experience',
      owner: null,
    };
    expect(
      scoreNotesSemanticCollection([calendar, design], gold.expected),
    ).toEqual(['excess_decisions']);
    expect(
      scoreNotesSemanticCollection(
        [
          calendar,
          {
            ...design,
            kind: 'point',
            text: 'Riley was suggested to design the experience',
          },
        ],
        gold.expected,
      ),
    ).toEqual([]);
  });

  it('allows the source-selected deadline change even though the original claim is an action', () => {
    const gold = notesSemanticReviewCases.find(
      (row) => row.id === 'revised-deadline',
    )!;
    const notesSource = createNotesSource(JSON.stringify(gold.lines));
    const sources = notesSource.segments.map((segment) => ({
      segment: segment.index,
      start: 0,
      end: segment.text.length,
    }));
    const action: NotesItem = {
      ...item,
      text: 'Verify backup restore by October 23, 2026',
      owner: 'Jordan Vale',
      due: 'October 23, 2026',
      sources,
    };
    const decision: NotesItem = {
      id: 'deadline-change',
      kind: 'decision',
      text: 'Move the backup restore deadline to October 23, 2026',
      owner: null,
      due: null,
      sources,
    };
    expect(
      scoreNotesSemanticEvidence(notesSource, decision, 'deadline-change', [
        {
          lineIndex: 0,
          quote: 'move my backup restore deadline to October 23, 2026',
        },
      ]),
    ).toEqual([]);
    expect(
      scoreNotesSemanticCollection([action, decision], gold.expected),
    ).toEqual([]);
    expect(
      scoreNotesSemanticCollection(
        [action, decision, { ...decision, id: 'extra-decision' }],
        gold.expected,
      ),
    ).toEqual(['excess_decisions']);
  });

  it('rejects invalid configured decision bounds and preserves callers without one', () => {
    for (const maxDecisionItems of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(() =>
        scoreNotesSemanticCollection([item], {
          maxActionItems: 1,
          maxDecisionItems,
        }),
      ).toThrow('invalid_gold_decision_limit');
    expect(
      scoreNotesSemanticCollection(
        [{ ...item, kind: 'decision', owner: null, due: null }],
        { maxActionItems: 0 },
      ),
    ).toEqual([]);
  });

  it('declares a decision limit for every source case, including both derived definite promises', () => {
    expect(notesSemanticReviewCases).toHaveLength(52);
    for (const gold of notesSemanticReviewCases) {
      expect(Number.isInteger(gold.expected.maxDecisionItems)).toBe(true);
      expect(gold.expected.maxDecisionItems).toBeGreaterThanOrEqual(0);
    }
    expect(
      notesSemanticReviewCases
        .filter((row) => row.expected.maxDecisionItems > 0)
        .map((row) => [row.id, row.expected.maxDecisionItems]),
    ).toEqual([
      ['revised-deadline', 1],
      ['affirmative-alternative-selected', 1],
      ['affirmative-retain-and-defer', 1],
    ]);
  });
});

const positiveDecisionCases = [
  {
    id: 'affirmative-alternative-selected',
    text: 'Choose the single installer for this release and reject separate helper downloads.',
  },
  {
    id: 'affirmative-retain-and-defer',
    text: 'Retain the current alerting policy until the review ends and defer replacement.',
  },
];

describe('affirmative decision recall fixtures', () => {
  it.each(positiveDecisionCases)(
    'preserves the corrected decision and source evidence through review and projection: $id',
    async ({ id, text }) => {
      const gold = notesSemanticReviewCases.find((row) => row.id === id)!;
      expect(gold.expected.kinds).toEqual(['decision']);
      expect(gold.expected.maxActionItems).toBe(0);
      expect(gold.expected.maxDecisionItems).toBe(1);
      const notesSource = createNotesSource(JSON.stringify(gold.lines));
      const sources = notesSource.segments.map((segment) => ({
        segment: segment.index,
        start: 0,
        end: segment.text.length,
      }));
      const draft = {
        title: null,
        meetingType: 'general' as const,
        overview: null,
        sections: [
          {
            id: 'section',
            title: { id: 'heading', text: 'Review', sources },
            items: [{ id: 'claim-0', ...gold.claim, sources }],
          },
        ],
      };
      const replay = async (kind: 'settled_choice' | 'point' | null) => {
        let callbacks = 0;
        const reviewed = await reviewSourceBoundNotes(
          acceptEditedNotes({
            source: notesSource,
            draft,
            acceptancePolicy: 'conservative',
          }),
          async ({ prompt }) => {
            callbacks++;
            const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
            return JSON.stringify({
              reviews:
                kind === null
                  ? {}
                  : {
                      I0: {
                        kind,
                        text,
                        owner: null,
                        due: null,
                        sources: data.source.map((row: string[]) => row[0]),
                      },
                    },
              additions: [],
              overview: null,
            });
          },
        );
        expect(callbacks).toBe(1);
        return reviewed;
      };
      const reviewed = await replay('settled_choice');
      const decision = reviewed.draft.sections
        .flatMap((section) => section.items)
        .find((entry) => entry.id === 'claim-0')!;
      expect(decision).toMatchObject({
        kind: 'decision',
        text,
        owner: null,
        due: null,
      });
      expect(
        scoreNotesSemanticEvidence(
          notesSource,
          decision,
          'claim-0',
          gold.expected.evidence!,
        ),
      ).toEqual([]);
      expect(scoreNotesSemanticCollection([decision], gold.expected)).toEqual(
        [],
      );
      const projected = projectAuditedNotes(reviewed);
      expect(projected.all_decisions).toHaveLength(1);
      expect(projected.all_decisions[0]?.text).toBe(text);
      expect(projected.all_action_items).toEqual([]);
      expect(
        projected.generation_metadata?.source_provenance?.blocks[
          'all_decisions:0'
        ],
      ).toEqual({ id: 'claim-0', sources });

      // Upper decision bounds alone do not require recall: the source case's
      // primary kind must be a decision, and projection must expose it.
      const suppressed = projectAuditedNotes(await replay('point'));
      expect(suppressed.all_decisions).toEqual([]);
      const omitted = await replay(null);
      expect(omitted.issues).toContain('semantic_notes_review_unavailable');
      expect(
        scoreNotesSemanticEvidence(
          notesSource,
          undefined,
          'claim-0',
          gold.expected.evidence!,
        ),
      ).toEqual(['original_claim_missing']);
    },
  );
});
