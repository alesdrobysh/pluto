import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectProfileContent } from '../../src/components/features/projects/ProjectProfileContent';
import {
  type ProjectBrief,
  buildProjectHealth,
  buildProjectMeetingStats,
  buildProjectMomentum,
} from '../../src/utils/projectBriefing';

const brief: ProjectBrief = {
  project: {
    id: 'project-launch',
    displayTitle: 'Launch',
    detectedTitle: 'Launch',
    metadata: null,
    status: 'active',
  },
  theme: {
    version: 3,
    sourceMeetingIds: [],
    candidateProjectIds: [],
    outcome: '',
    currentFocus: '',
    recentChanges: [],
    openThreads: [],
    synthesizedAt: '2026-10-01T00:00:00Z',
  },
  meetings: [],
  tasks: [],
  milestones: [],
  mergedProjects: [],
  meetingStats: buildProjectMeetingStats([]),
  momentum: buildProjectMomentum([], []),
  health: buildProjectHealth([], null),
};

const render = (overrides: Partial<ProjectBrief>) =>
  renderToStaticMarkup(
    <ProjectProfileContent
      brief={{ ...brief, ...overrides }}
      relatedWork={[]}
      onDetachWork={async () => {}}
      milestones={null}
      onPrepareUpdates={() => {}}
      preparationState="idle"
    />,
  );

describe('ProjectProfileContent empty discussion state', () => {
  it('does not claim nothing is unresolved when changed notes removed saved support', () => {
    const markup = render({ themeSourceOutdated: true });
    expect(markup).toContain(
      'Refresh the brief to see current discussion points.',
    );
    expect(markup).toContain('Refresh the brief to see the next decision.');
    expect(markup).not.toContain('No unresolved questions were established');
    expect(markup).not.toContain('No pending decision was established');
    expect(markup).not.toContain(
      'No specific discussion points were established',
    );
  });

  it('distinguishes a missing synthesis from an empty saved synthesis', () => {
    const markup = render({ theme: null });
    expect(markup).toContain('No discussion points have been synthesized yet.');
    expect(markup).toContain('No next decision has been synthesized yet.');
    expect(markup).not.toContain('No pending decision was established');
    expect(markup).not.toContain(
      'No specific discussion points were established',
    );
  });

  it('keeps empty conclusions scoped to the saved synthesis', () => {
    const markup = render({});
    expect(markup).toContain(
      'No unresolved questions were established in the saved synthesis.',
    );
    expect(markup).toContain(
      'No pending decision was established in the saved synthesis.',
    );
    expect(markup).toContain(
      'No specific discussion points were established in the saved synthesis.',
    );
  });

  it('does not describe uncited linked meetings as unprocessed sources', () => {
    const markup = render({
      meetings: [{ id: 'meeting-review', title: 'Launch review' }],
    });
    expect(markup).not.toContain('not incorporated');
    expect(markup).not.toContain('Source notes changed. Refresh');
    expect(markup).toContain(
      'No pending decision was established in the saved synthesis.',
    );
  });

  it('retains supported questions when another part of the brief is outdated', () => {
    const markup = render({
      themeSourceOutdated: true,
      theme: {
        ...brief.theme!,
        openThreads: [
          {
            kind: 'question',
            text: 'Which launch date is feasible?',
            sourceMeetingId: 'meeting-planning',
            evidenceQuote: 'Which launch date is feasible?',
          },
        ],
      },
    });
    expect(markup).toContain('Which launch date is feasible?');
    expect(markup).not.toContain(
      'Refresh the brief to see current discussion points.',
    );
    expect(markup).not.toContain('Refresh the brief to see the next decision.');
  });
});
