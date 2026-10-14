import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_DEPARTURE_LAYOUTS,
  type AcceptedDepartureLayout,
  inspectDeparture,
} from '../../electron/activeCall/departureAdapters';
import type {
  CallSource,
  InspectionSnapshot,
  UiMarker,
} from '../../electron/activeCall/departureTypes';
import { parseCallMonitorLine } from '../../electron/activeCall/nativeCallMonitor';

const joined: UiMarker = {
  role: 'AXButton',
  identifier: 'joined-hash',
  token: 'leave_meeting',
};
const departed: UiMarker = {
  role: 'AXStaticText',
  identifier: 'left-hash',
  token: 'left_meeting',
};
const source = (
  bundleId: string,
  version = 'verified-version',
): CallSource => ({
  id: 'app-instance',
  bundleId,
  version,
  pid: 100,
  name: 'Call app',
  input: false,
  output: false,
  audioGeneration: 'audio-1',
});
const snapshot = (markers: UiMarker[]): InspectionSnapshot => ({
  kind: 'inspection',
  version: 1,
  requestId: 'request',
  sourceId: 'app-instance',
  healthy: true,
  trusted: true,
  windows: [{ id: 'session-1', markers }],
});

describe('departure adapter gates', () => {
  it('ships with no unaccepted UI layout authorized', () => {
    expect(ACCEPTED_DEPARTURE_LAYOUTS).toEqual([]);
    expect(
      inspectDeparture(source('us.zoom.xos'), snapshot([departed]))[0].state,
    ).toBe('unknown');
  });

  it.each([
    ['com.google.Chrome', 'meet'],
    ['us.zoom.xos', 'zoom'],
    ['com.microsoft.teams2', 'teams'],
    ['com.tinyspeck.slackmacgap', 'slack'],
  ] as const)(
    'requires positive exact markers and version for %s',
    (bundleId, provider) => {
      const layout: AcceptedDepartureLayout = {
        provider,
        appVersion: 'verified-version',
        acceptance: 'signed-matrix-artifact',
        joined: [joined],
        departed: [departed],
      };
      expect(
        inspectDeparture(source(bundleId), snapshot([joined]), [layout])[0]
          .state,
      ).toBe('joined');
      expect(
        inspectDeparture(source(bundleId), snapshot([departed]), [layout])[0]
          .state,
      ).toBe('departed');
      expect(
        inspectDeparture(source(bundleId), snapshot([joined, departed]), [
          layout,
        ])[0].state,
      ).toBe('unknown');
      expect(
        inspectDeparture(
          source(bundleId, 'new-version'),
          snapshot([departed]),
          [layout],
        )[0].state,
      ).toBe('unknown');
      expect(
        inspectDeparture(
          source(bundleId),
          { ...snapshot([departed]), trusted: false },
          [layout],
        ),
      ).toEqual([]);
      expect(
        inspectDeparture(
          source(bundleId),
          { ...snapshot([departed]), sourceId: 'another-app' },
          [layout],
        ),
      ).toEqual([]);
    },
  );

  it('cannot authorize departure from a generic End or Leave control', () => {
    const unsafe: AcceptedDepartureLayout = {
      provider: 'meet',
      appVersion: 'verified-version',
      acceptance: 'signed-matrix-artifact',
      joined: [joined],
      departed: [{ role: 'AXButton', identifier: 'generic', token: 'end' }],
    };
    expect(
      inspectDeparture(source('com.google.Chrome'), snapshot(unsafe.departed), [
        unsafe,
      ])[0].state,
    ).toBe('unknown');
    const unversioned = {
      ...unsafe,
      departed: [departed],
      appVersion: 'unknown',
    };
    expect(
      inspectDeparture(
        source('com.google.Chrome', 'unknown'),
        snapshot([departed]),
        [unversioned],
      )[0].state,
    ).toBe('unknown');
  });

  it('rejects malformed or content-bearing monitor messages', () => {
    expect(parseCallMonitorLine('{bad json')).toBeNull();
    expect(
      parseCallMonitorLine(
        JSON.stringify({ ...snapshot([]), rawWindowTitle: 'private meeting' }),
      ),
    ).toBeNull();
    expect(
      parseCallMonitorLine(
        JSON.stringify({
          ...snapshot([]),
          windows: [
            { id: 'session-1', markers: [{ ...departed, token: 123 }] },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseCallMonitorLine(JSON.stringify(snapshot([departed]))),
    ).toMatchObject({ kind: 'inspection' });
  });
});
