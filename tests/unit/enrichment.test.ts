import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Electron and Database to prevent side effects during import
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('better-sqlite3', () => {
  function BetterSqlite3Mock() {
    return {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
      transaction: vi.fn((fn) => fn),
      exec: vi.fn(),
    };
  }

  return {
    default: BetterSqlite3Mock,
  };
});

vi.mock('../../electron/database/applicationDatabase', async () => {
  const { default: Database } = await import('better-sqlite3');
  const connection = new Database(':memory:');
  return { getApplicationDatabase: () => connection };
});

import {
  parseDueDate,
  shouldEnrichEntity,
} from '../../electron/entityPipeline';

describe('Critical Business Logic', () => {
  describe('Enrichment Logic (shouldEnrichEntity)', () => {
    it('should enrich "Sarah" with "Sarah Chen"', () => {
      expect(shouldEnrichEntity('Sarah', 'Sarah Chen')).toBe(true);
    });

    it('should NOT enrich "Sarah Chen" with "Sarah"', () => {
      expect(shouldEnrichEntity('Sarah Chen', 'Sarah')).toBe(false);
    });

    it('should enrich "Project Alpha" with "Project Alpha v2"', () => {
      expect(shouldEnrichEntity('Project Alpha', 'Project Alpha v2')).toBe(
        true,
      );
    });

    it('should NOT enrich distinct names like "David" with "Sarah"', () => {
      expect(shouldEnrichEntity('David', 'Sarah')).toBe(false);
    });

    it('should handle different casing/punctuation', () => {
      // "P.O.C." -> "Proof of Concept" might not work with current simple logic
      // but let's test strict "substring-ish" enrichment
      expect(shouldEnrichEntity('sarah', 'Sarah Chen')).toBe(true);
    });
  });

  describe('Date Parsing Logic (parseDueDate)', () => {
    beforeEach(() => {
      // Freeze time to a known Monday for consistent testing
      vi.useFakeTimers();
      const monday = new Date(2023, 0, 2, 12, 0, 0); // Jan 2, 2023 is a Monday
      vi.setSystemTime(monday);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should parse "today"', () => {
      const date = parseDueDate('today', '2023-01-02T12:00:00-08:00');
      expect(date).toBeDefined();
      expect(date?.split('T')[0]).toBe('2023-01-02'); // Monday
    });

    it('should parse "tomorrow"', () => {
      const date = parseDueDate('tomorrow', '2023-01-02T12:00:00-08:00');
      expect(date).toBeDefined();
      expect(date?.split('T')[0]).toBe('2023-01-03'); // Tuesday
    });

    it('withholds ambiguous week-only deadlines', () => {
      expect(parseDueDate('next week', '2023-01-02T12:00:00-08:00')).toBeNull();
    });

    it('preserves explicit date-only and timestamp deadlines', () => {
      expect(parseDueDate('2026-10-15')).toBe('2026-10-15');
      expect(parseDueDate('2026-10-15T09:00:00-07:00')).toBe(
        '2026-10-15T16:00:00.000Z',
      );
      expect(parseDueDate('2026-02-30')).toBeNull();
      expect(parseDueDate('10/11/2026')).toBeNull();
    });

    it('anchors relative dates to the meeting offset or supplied timezone despite delayed extraction', () => {
      expect(parseDueDate('tomorrow', '2026-03-08T23:30:00-07:00')).toBe(
        '2026-03-09',
      );
      expect(
        parseDueDate('tomorrow', '2026-03-09T06:30:00Z', 'America/Los_Angeles'),
      ).toBe('2026-03-09');
      expect(parseDueDate('tomorrow')).toBeNull();
      expect(
        parseDueDate('Friday after approval', '2026-03-08T23:30:00-07:00'),
      ).toBeNull();
    });

    it('represents a later changed deadline as a new canonical date', () => {
      expect(parseDueDate('tomorrow', '2026-10-10T09:00:00-07:00')).toBe(
        '2026-10-11',
      );
      expect(parseDueDate('2026-10-14', '2026-10-10T09:00:00-07:00')).toBe(
        '2026-10-14',
      );
    });

    it('should parse "by Friday"', () => {
      const date = parseDueDate('by Friday', '2023-01-02T12:00:00-08:00');
      expect(date).toBeDefined();
      expect(date?.split('T')[0]).toBe('2023-01-06'); // This Friday
    });

    it('should parse "end of week"', () => {
      // Assuming default logic maps to Friday or Sunday.
      // Current impl is +daysUntilFriday
      const date = parseDueDate('end of week', '2023-01-02T12:00:00-08:00');
      expect(date).toBeDefined();
      expect(date?.split('T')[0]).toBe('2023-01-06'); // Friday
    });

    it('should handle invalid dates gracefully', () => {
      expect(parseDueDate('invalid date string')).toBeNull();
      expect(parseDueDate('')).toBeNull();
    });
  });
});
