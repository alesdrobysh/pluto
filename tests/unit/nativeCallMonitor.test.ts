import { describe, expect, it } from 'vitest';
import { parseCallMonitorLine } from '../../electron/activeCall/nativeCallMonitor';

const source = {
  id: 'us.zoom.xos:100:launch',
  bundleId: 'us.zoom.xos',
  pid: 100,
  name: 'Zoom',
  version: '1',
  input: null,
  output: null,
  audioGeneration: '',
};

describe('native call-monitor protocol', () => {
  it('keeps failed audio reads explicitly unknown', () => {
    const parsed = parseCallMonitorLine(
      JSON.stringify({
        kind: 'activity',
        version: 1,
        epoch: 'helper-1',
        sequence: 1,
        healthy: false,
        discontinuity: false,
        sources: [source],
        terminated: [],
      }),
    );
    expect(parsed?.kind).toBe('activity');
    if (parsed?.kind === 'activity') {
      expect(parsed.sources[0].input).toBeNull();
      expect(parsed.sources[0].output).toBeNull();
    }
  });

  it('rejects malformed source state and extra unscoped inspection content', () => {
    const activity = {
      kind: 'activity',
      version: 1,
      epoch: 'helper-1',
      sequence: 1,
      healthy: true,
      discontinuity: false,
      sources: [{ ...source, input: 'inactive' }],
      terminated: [],
    };
    expect(parseCallMonitorLine(JSON.stringify(activity))).toBeNull();
    expect(
      parseCallMonitorLine(
        JSON.stringify({
          kind: 'inspection',
          version: 1,
          requestId: 'request-1',
          sourceId: source.id,
          healthy: true,
          trusted: true,
          windows: [{ id: 'opaque', markers: [], rawURL: 'meet.google.com' }],
        }),
      ),
    ).toBeNull();
  });
});
