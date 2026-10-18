// Fictional source-first quality cases. Run provider evaluation explicitly; unit tests never spend model usage.
export interface NotesSemanticReviewCase {
  id: string;
  lines: Array<{ speaker: string; text: string }>;
  citedLineIndexes?: number[];
  claim: {
    kind: 'action' | 'decision' | 'point';
    text: string;
    owner: string | null;
    due: string | null;
  };
  expected: {
    kinds: string[];
    owner: string | null;
    due: string | null;
    required: string[];
    forbidden: string[];
    contextRequired?: string[];
    ambiguousAcceptance?: boolean;
    evidence?: Array<{ lineIndex: number; quote: string }>;
  };
}

export const notesSemanticReviewCases: NotesSemanticReviewCase[] = [
  {
    id: 'operational-coordination-reference',
    lines: [
      {
        speaker: 'Tavi',
        text: 'For next quarter, our two workstreams are Juniper and Kestrel.',
      },
      { speaker: 'Ari', text: 'Any other questions?' },
      {
        speaker: 'Tavi',
        text: "No, nothing else. I'll coordinate how that progresses.",
      },
    ],
    citedLineIndexes: [2],
    claim: {
      kind: 'point',
      text: 'Tavi will coordinate progress of the work',
      owner: null,
      due: null,
    },
    expected: {
      evidence: [
        { lineIndex: 0, quote: 'Juniper and Kestrel' },
        { lineIndex: 2, quote: "I'll coordinate how that progresses" },
      ],
      kinds: ['action'],
      owner: 'Tavi',
      due: null,
      required: ['Juniper', 'Kestrel'],
      forbidden: [],
    },
  },
  {
    id: 'independent-unconditional',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'I will publish the release checklist by October 20, 2026. If security approves access, I will enable the external pilot on October 22, 2026.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Publish the release checklist',
      owner: 'Maya Hart',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: 'October 20, 2026',
      required: ['checklist'],
      forbidden: ['if security'],
    },
  },
  {
    id: 'independent-conditional',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'I will publish the release checklist by October 20, 2026. If security approves access, I will enable the external pilot on October 22, 2026.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Enable the external pilot',
      owner: 'Maya Hart',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: 'October 22, 2026',
      required: ['security', 'pilot'],
      forbidden: [],
    },
  },
  {
    id: 'bug-description-not-prerequisite',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'The SSO redirect is a blocker: users return to the wrong screen after sign-in. I will fix the SSO redirect.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Fix the SSO redirect',
      owner: 'Maya Hart',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: null,
      required: ['SSO'],
      forbidden: [],
    },
  },
  {
    id: 'standalone-prerequisite-0',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'I will publish the release checklist. Only after legal approves.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Publish the release checklist',
      owner: 'Maya Hart',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: null,
      required: ['legal'],
      forbidden: [],
    },
  },
  {
    id: 'standalone-prerequisite-1',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'I will publish the release checklist. That will only happen after legal approves.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Publish the release checklist',
      owner: 'Maya Hart',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: null,
      required: ['legal'],
      forbidden: [],
    },
  },
  {
    id: 'standalone-prerequisite-2',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'I will publish the release checklist. If legal approves.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Publish the release checklist',
      owner: 'Maya Hart',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: null,
      required: ['legal'],
      forbidden: [],
    },
  },
  {
    id: 'standalone-prerequisite-3',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'I will publish the release checklist. Unless legal refuses.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Publish the release checklist',
      owner: 'Maya Hart',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: null,
      required: ['legal'],
      forbidden: [],
    },
  },
  {
    id: 'reaffirmed-owner-self',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'Riley still owns sending the test checklist. I still own updating the runbook.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Update the runbook',
      owner: 'Maya Hart',
      due: null,
    },
    expected: {
      evidence: [{ lineIndex: 0, quote: 'I still own updating the runbook' }],
      kinds: ['action'],
      owner: 'Maya Hart',
      due: null,
      required: ['runbook'],
      forbidden: [],
    },
  },
  {
    id: 'reaffirmed-owner-named',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'Riley still owns sending the test checklist. I still own updating the runbook.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Send the test checklist',
      owner: 'Riley',
      due: null,
    },
    expected: {
      evidence: [
        { lineIndex: 0, quote: 'Riley still owns sending the test checklist' },
      ],
      kinds: ['action'],
      owner: 'Riley',
      due: null,
      required: ['checklist'],
      forbidden: [],
    },
  },
  {
    id: 'explicit-date',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'I will publish the release checklist by October 20, 2026.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Publish the release checklist',
      owner: 'Maya Hart',
      due: '2026-10-20',
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: 'October 20, 2026',
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'no-invented-year',
    lines: [
      {
        speaker: 'Maya Hart',
        text: 'I will publish the release checklist by October 20.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Publish the release checklist',
      owner: 'Maya Hart',
      due: '2026-10-20',
    },
    expected: {
      kinds: ['action'],
      owner: 'Maya Hart',
      due: 'October 20',
      required: [],
      forbidden: ['2026'],
    },
  },
  {
    id: 'revised-deadline',
    lines: [
      {
        speaker: 'Jordan Vale',
        text: 'I will verify backup restore by October 20, 2026. Actually, move my backup restore deadline to October 23, 2026. October 20 is no longer the deadline.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Verify backup restore by October 20, 2026',
      owner: 'Jordan Vale',
      due: 'October 20, 2026',
    },
    expected: {
      evidence: [
        { lineIndex: 0, quote: 'I will verify backup restore' },
        {
          lineIndex: 0,
          quote: 'move my backup restore deadline to October 23, 2026',
        },
      ],
      kinds: ['action'],
      owner: 'Jordan Vale',
      due: 'October 23, 2026',
      required: ['restore'],
      forbidden: ['October 20'],
    },
  },
  {
    id: 'colloquial-promise-0',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me arrange the review.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Me',
      due: null,
      required: ['review'],
      forbidden: [],
    },
  },
  {
    id: 'colloquial-promise-1',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me schedule the review.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Me',
      due: null,
      required: ['review'],
      forbidden: [],
    },
  },
  {
    id: 'colloquial-promise-2',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me book the review.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Me',
      due: null,
      required: ['review'],
      forbidden: [],
    },
  },
  {
    id: 'colloquial-promise-3',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me put the review time on the calendar.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Me',
      due: null,
      required: ['review'],
      forbidden: [],
    },
  },
  {
    id: 'noncommitment-0',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me know if you can arrange the review.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point', 'question'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'noncommitment-1',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me think about arranging the review.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point', 'question'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'noncommitment-2',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me explain how the review works.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point', 'question'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'noncommitment-3',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me put it another way.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point', 'question'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'noncommitment-4',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me arrange the review?',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point', 'question'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'conditional-scheduling',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me arrange the review if legal approves.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Me',
      due: null,
      required: ['legal'],
      forbidden: [],
    },
  },
  {
    id: 'not-yet-future-0',
    lines: [
      {
        speaker: 'Remote Speaker 2',
        text: "I haven't told Casey yet, but we'll tell I'll tell him soon.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Tell Casey about the work',
      owner: 'Remote Speaker 2',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Remote Speaker 2',
      due: null,
      required: ['Casey'],
      forbidden: ['work allocation'],
    },
  },
  {
    id: 'not-yet-future-1',
    lines: [
      {
        speaker: 'Remote Speaker 2',
        text: "I haven’t told Casey yet, but we'll tell I'll tell him soon.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Tell Casey about the work',
      owner: 'Remote Speaker 2',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Remote Speaker 2',
      due: null,
      required: ['Casey'],
      forbidden: ['work allocation'],
    },
  },
  {
    id: 'not-yet-future-2',
    lines: [
      {
        speaker: 'Remote Speaker 2',
        text: "I hadn’t told Casey yet, but we'll tell I'll tell him soon.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Tell Casey about the work',
      owner: 'Remote Speaker 2',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Remote Speaker 2',
      due: null,
      required: ['Casey'],
      forbidden: ['work allocation'],
    },
  },
  {
    id: 'unconfirmed-expanded-owner',
    lines: [
      {
        speaker: 'Remote Speaker 2',
        text: "I haven't told Casey yet, but I'll tell him. I'll tell them soon.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Taylor will tell Casey soon',
      owner: 'Taylor',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Remote Speaker 2',
      due: null,
      required: ['Casey'],
      forbidden: ['Taylor'],
    },
  },
  {
    id: 'numbered-owner',
    lines: [
      {
        speaker: 'Speaker 12',
        text: "I haven't told Casey yet, but I'll tell him. I'll tell them soon.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Speaker 12 will tell Casey about the work soon',
      owner: 'Speaker 12',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Speaker 12',
      due: null,
      required: ['Casey'],
      forbidden: [],
    },
  },
  {
    id: 'unsupported-quantity',
    lines: [
      {
        speaker: 'Speaker 12',
        text: "I'll send the reports.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Speaker 12 will send 42 reports',
      owner: 'Speaker 12',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Speaker 12',
      due: null,
      required: ['reports'],
      forbidden: ['42'],
    },
  },
  {
    id: 'cancelled-promise',
    lines: [
      {
        speaker: 'Me',
        text: "I haven't told Casey yet, but I'll tell him. Actually, I won't tell Casey.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Tell Casey about the work',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'tentative-offer',
    lines: [
      {
        speaker: 'Me',
        text: "I haven't told Casey yet, but I might tell him.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Tell Casey about the work',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'combined-plan-and-promise',
    lines: [
      {
        speaker: 'Me',
        text: 'Maybe we sit down with Riley to review onboarding and have Riley design the experience.',
      },
      {
        speaker: 'Them',
        text: 'I think you need to speak to Riley.',
      },
      {
        speaker: 'Me',
        text: 'Let me put the time with Riley on the calendar depending on how we feel about the plan.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Meet with Riley to design onboarding; schedule time depending on the plan',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action', 'point'],
      ambiguousAcceptance: true,
      owner: 'Me',
      due: null,
      required: ['Riley', 'plan'],
      forbidden: ['design onboarding'],
      contextRequired: ['Riley', 'design'],
    },
  },
  {
    id: 'source-amount-condition',
    lines: [
      {
        speaker: 'Me',
        text: 'Maybe we meet with Riley to discuss reports. Let me schedule time with Riley to send 3 reports only after legal approves.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Meet with Riley to discuss reports; schedule time to send reports',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Me',
      due: null,
      required: ['3', 'legal', 'Riley'],
      forbidden: [],
    },
  },
  {
    id: 'unsupported-relative-date',
    lines: [
      {
        speaker: 'Me',
        text: 'Let me put the time with Riley on the calendar depending on how we feel about the plan.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Schedule time with Riley tomorrow depending on the plan',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action', 'point'],
      ambiguousAcceptance: true,
      owner: 'Me',
      due: null,
      required: ['Riley', 'plan'],
      forbidden: ['tomorrow'],
    },
  },
  {
    id: 'correct-supported-date',
    lines: [
      {
        speaker: 'Nora',
        text: 'Riley agreed to send the release checklist on Monday.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Send the release checklist tomorrow',
      owner: 'Riley',
      due: 'tomorrow',
    },
    expected: {
      kinds: ['action'],
      owner: 'Riley',
      due: 'Monday',
      required: ['Monday'],
      forbidden: ['tomorrow'],
    },
  },
  {
    id: 'social-farewell',
    lines: [
      {
        speaker: 'Me',
        text: "Thanks everyone. I'll speak to some of you later. Goodbye.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Speak to some attendees later',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'concrete-promised-call',
    lines: [
      {
        speaker: 'Me',
        text: "I'll call Jamie tomorrow at ten to review the pilot checklist.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Call Jamie to review the pilot checklist',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Me',
      due: 'tomorrow at ten',
      required: ['Jamie', 'checklist'],
      forbidden: [],
    },
  },
  {
    id: 'cancelled-scheduling',
    lines: [
      {
        speaker: 'Me',
        text: "Maybe we meet with Riley to review onboarding. Let me schedule calendar time with Riley. Actually, I won't schedule calendar time with Riley.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Meet with Riley to review onboarding and schedule calendar time',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'negative-0',
    lines: [
      {
        speaker: 'Me',
        text: "I haven't sent the draft.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Send the draft',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'negative-1',
    lines: [
      {
        speaker: 'Me',
        text: "I didn't send the draft.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Send the draft',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'negative-2',
    lines: [
      {
        speaker: 'Me',
        text: "I won't send the draft.",
      },
    ],
    claim: {
      kind: 'action',
      text: 'Send the draft',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'negative-3',
    lines: [
      {
        speaker: 'Me',
        text: 'I won’t send the draft.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Send the draft',
      owner: 'Me',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
  {
    id: 'multilingual-ownership',
    lines: [
      {
        speaker: 'Marta',
        text: 'Yo me encargo de enviar el borrador a Jamie.',
      },
    ],
    claim: {
      kind: 'action',
      text: 'Send the draft to Jamie',
      owner: null,
      due: null,
    },
    expected: {
      kinds: ['action'],
      owner: 'Marta',
      due: null,
      required: ['Jamie'],
      forbidden: [],
    },
  },
  {
    id: 'adjacent-fragment-promise',
    lines: [
      { speaker: 'Me', text: 'Let me put' },
      { speaker: 'Me', text: 'the review' },
      { speaker: 'Me', text: 'time on the calendar.' },
    ],
    claim: {
      kind: 'action',
      text: 'Arrange the review',
      owner: 'Me',
      due: null,
    },
    expected: {
      evidence: [
        { lineIndex: 0, quote: 'Let me put' },
        { lineIndex: 1, quote: 'the review' },
        { lineIndex: 2, quote: 'time on the calendar' },
      ],
      kinds: ['action'],
      owner: 'Me',
      due: null,
      required: ['review'],
      forbidden: [],
    },
  },
  {
    id: 'gapped-fragment-promise',
    lines: [
      { speaker: 'Me', text: 'I will' },
      { speaker: 'Me', text: 'not' },
      { speaker: 'Me', text: 'book the review.' },
    ],
    claim: { kind: 'action', text: 'Book the review', owner: 'Me', due: null },
    expected: {
      evidence: [
        { lineIndex: 0, quote: 'I will' },
        { lineIndex: 1, quote: 'not' },
        { lineIndex: 2, quote: 'book the review' },
      ],
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
    citedLineIndexes: [0, 2],
  },
  {
    id: 'request-and-acceptance',
    lines: [
      { speaker: 'Nora', text: 'Could you send the pilot checklist?' },
      { speaker: 'Me', text: 'Yes, by Monday.' },
    ],
    claim: {
      kind: 'action',
      text: 'Send the pilot checklist',
      owner: 'Nora',
      due: null,
    },
    expected: {
      evidence: [
        { lineIndex: 0, quote: 'send the pilot checklist' },
        { lineIndex: 1, quote: 'Yes, by Monday' },
      ],
      kinds: ['action'],
      owner: 'Me',
      due: 'Monday',
      required: ['checklist'],
      forbidden: [],
    },
  },
  {
    id: 'accepted-unowned-task',
    lines: [
      {
        speaker: 'Morgan',
        text: 'The group accepted sending the outline, but no owner has been assigned.',
      },
    ],
    claim: { kind: 'action', text: 'Send the outline', owner: null, due: null },
    expected: {
      kinds: ['action'],
      owner: null,
      due: null,
      required: ['outline'],
      forbidden: [],
    },
  },
  {
    id: 'suggestion-with-reserved-judgment',
    lines: [
      {
        speaker: 'Me',
        text: 'How about bringing in the security helper who tested the old portal?',
      },
      { speaker: 'Remote Speaker 2', text: 'Let me, let me have a think.' },
    ],
    claim: {
      kind: 'action',
      text: 'Consider bringing in the security helper',
      owner: 'Remote Speaker 2',
      due: null,
    },
    expected: {
      kinds: ['point'],
      owner: null,
      due: null,
      required: [],
      forbidden: [],
    },
  },
];

// Pair uncertain intentions with definite promises; do not infer acceptance from ambiguous speech.
for (const id of ['combined-plan-and-promise', 'unsupported-relative-date']) {
  const original = notesSemanticReviewCases.find((item) => item.id === id)!;
  notesSemanticReviewCases.push({
    ...original,
    id: `definite-${id}`,
    lines: original.lines.map((line, index) =>
      index === original.lines.length - 1
        ? {
            speaker: 'Me',
            text: 'I will put time with Riley on the calendar once legal approves the plan. I am taking ownership of that follow-up.',
          }
        : { ...line },
    ),
    expected: {
      ...original.expected,
      kinds: ['action'],
      ambiguousAcceptance: false,
    },
  });
}
