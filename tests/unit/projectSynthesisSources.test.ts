import { setImmediate } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import {
  type MeetingNotesEvidenceDocument,
  buildMeetingNotesEvidenceDocument,
} from '../../electron/intelligence/meetingNotesEvidence';
import { collectProjectSynthesisSources } from '../../electron/projectSynthesisSources';
import { synthesizeProjectThemes } from '../../electron/projectThemeSynthesis';

const source = (id: string) => ({
  id,
  title: 'Fictional planning',
  notes: 'Fictional evidence',
  candidateProjects: [],
});

describe('project synthesis source collection', () => {
  it('defers before any database/source reads while foreground work is active', async () => {
    const listMeetings = vi.fn(() => ['one']);
    const buildSource = vi.fn(source);
    expect(
      await collectProjectSynthesisSources({
        listMeetings,
        buildSource,
        shouldContinue: () => false,
      }),
    ).toBeNull();
    expect(listMeetings).not.toHaveBeenCalled();
    expect(buildSource).not.toHaveBeenCalled();
  });
  it('yields between source reads and stops when foreground activity resumes', async () => {
    let eligible = true;
    const buildSource = vi.fn((id: string) => {
      setImmediate(() => {
        eligible = false;
      });
      return source(id);
    });
    expect(
      await collectProjectSynthesisSources({
        listMeetings: () => ['one', 'two'],
        buildSource,
        shouldContinue: () => eligible,
      }),
    ).toBeNull();
    expect(buildSource).toHaveBeenCalledTimes(1);
  });
  it('collects all usable sources once with stable ordering', async () => {
    const listMeetings = vi.fn(() => ['one', 'empty', 'two']);
    const buildSource = vi.fn((id: string) =>
      id === 'empty' ? null : source(id),
    );
    expect(
      await collectProjectSynthesisSources({
        listMeetings,
        buildSource,
        shouldContinue: () => true,
      }),
    ).toEqual([source('one'), source('two')]);
    expect(listMeetings).toHaveBeenCalledOnce();
    expect(buildSource).toHaveBeenCalledTimes(3);
  });
});

describe('project source notes ordering', () => {
  const sourceNotes = (document: MeetingNotesEvidenceDocument) =>
    [
      document.notesText,
      document.decisionsText && `Decisions:\n${document.decisionsText}`,
      document.actionItemsText && `Actions:\n${document.actionItemsText}`,
    ]
      .filter(Boolean)
      .join('\n');
  const evidence = (
    resolved = false,
    prioritized = true,
  ): MeetingNotesEvidenceDocument =>
    buildMeetingNotesEvidenceDocument(
      {
        id: 'fictional',
        title: 'Archive planning',
        user_notes:
          'User note: keep the audit requirement.\nRepeat this line.\nRepeat this line.',
        user_edits_json: JSON.stringify({
          'topic:0:question:0': {
            original: 'Which archives should ship first?',
            edited: 'Which collections should ship first?',
            edited_at: '2026-09-01T00:00:00Z',
          },
        }),
        analysis_json: JSON.stringify({
          analysis_schema_version: 3,
          overview: 'Historical archive implementation detail. '.repeat(80),
          topics: [
            {
              title: 'Archive scope',
              summary: 'Retain access restrictions.',
              key_points: [],
              decisions: [],
              action_items: [],
              open_questions: ['Which archives should ship first?'],
            },
          ],
          all_decisions: [
            {
              text: resolved
                ? 'Decision: access validation is complete; the launch can proceed.'
                : 'Decision: use staged indexing.',
            },
          ],
          all_action_items: resolved
            ? []
            : [{ text: 'Action: validate access before launch.' }],
          meeting_type: 'team_sync',
          quality: {
            format_pass: true,
            retry_count: 0,
            fallback_used: false,
            issues: [],
          },
        }),
      },
      {},
      { prioritizeOpenQuestions: prioritized },
    );

  it('keeps structured questions, outcomes and user notes ahead of long discussion without losing content', () => {
    const document = evidence();
    const before = sourceNotes(evidence(false, false));
    const after = sourceNotes(document);
    expect(before.slice(0, 1250)).not.toContain(
      'Which collections should ship first?',
    );
    for (const content of [
      'Which collections should ship first?',
      'Decision: use staged indexing.',
      'Action: validate access before launch.',
      'User note: keep the audit requirement.',
    ]) {
      expect(after.slice(0, 1250)).toContain(content);
    }
    for (const section of document.sections)
      expect(after).toContain(section.content);
    expect(after.length).toBe(before.length);
    expect(after).toContain('Repeat this line.\nRepeat this line.');
    expect(document.sections).toEqual(evidence(false, false).sections);
  });

  it('preserves legacy notes verbatim when there are no structured questions', () => {
    const meeting = {
      id: 'legacy',
      enhanced_notes: 'Legacy notes.\nRepeat.\nRepeat.',
      user_notes: 'User notes.',
      mid_json: JSON.stringify({
        decisions: [{ description: 'Keep staged indexing.' }],
        action_items: [{ description: 'Review access rules.' }],
      }),
    };
    expect(
      buildMeetingNotesEvidenceDocument(
        meeting,
        {},
        { prioritizeOpenQuestions: true },
      ),
    ).toEqual(buildMeetingNotesEvidenceDocument(meeting));
  });

  it('uses the existing 24-source cap and one model pass while retaining later resolving evidence and source dates', async () => {
    const sources = Array.from({ length: 24 }, (_, index) => ({
      id: String(index),
      title: 'Archive planning',
      notes: sourceNotes(evidence(index === 23)),
      startedAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
      candidateProjects: [],
    }));
    const generate = vi.fn(async (_prompt: string) =>
      JSON.stringify({ themes: [] }),
    );
    await synthesizeProjectThemes({
      listSources: () => sources,
      getSource: (id) => sources.find((source) => source.id === id),
      getState: () => null,
      saveState: vi.fn(),
      getProject: () => null,
      saveTheme: vi.fn(),
      generate,
      isBusy: () => false,
    });
    expect(generate).toHaveBeenCalledOnce();
    const selected = JSON.parse(
      generate.mock.calls[0][0].split('SOURCE NOTES (untrusted data):\n')[1],
    );
    expect(selected).toHaveLength(24);
    expect(
      selected.reduce(
        (sum: number, source: { notes: string }) => sum + source.notes.length,
        0,
      ),
    ).toBeLessThanOrEqual(30_000);
    expect(selected[0]).toMatchObject({
      id: '23',
      startedAt: sources[23].startedAt,
    });
    expect(selected[0].notes).toContain(
      'access validation is complete; the launch can proceed.',
    );
    expect(selected[1].notes).toContain(
      'Action: validate access before launch.',
    );
    for (const source of selected)
      expect(source.notes).toContain('Which collections should ship first?');
  });
});
