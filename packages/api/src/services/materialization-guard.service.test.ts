import { describe, expect, it } from 'vitest';

import { MaterializationGuard } from './materialization-guard.service.ts';

describe('MaterializationGuard', () => {
  describe('buildHash', () => {
    it('returns a consistent hash for the same inputs', () => {
      const hash1 = MaterializationGuard.buildHash(
        5,
        '2026-04-01T00:00:00Z',
        '2026-03-01T00:00:00Z',
      );
      const hash2 = MaterializationGuard.buildHash(
        5,
        '2026-04-01T00:00:00Z',
        '2026-03-01T00:00:00Z',
      );
      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different counts', () => {
      const hash1 = MaterializationGuard.buildHash(
        5,
        '2026-04-01T00:00:00Z',
        '2026-03-01T00:00:00Z',
      );
      const hash2 = MaterializationGuard.buildHash(
        6,
        '2026-04-01T00:00:00Z',
        '2026-03-01T00:00:00Z',
      );
      expect(hash1).not.toBe(hash2);
    });

    it('returns different hashes for different maxUpdated', () => {
      const hash1 = MaterializationGuard.buildHash(
        5,
        '2026-04-01T00:00:00Z',
        '2026-03-01T00:00:00Z',
      );
      const hash2 = MaterializationGuard.buildHash(
        5,
        '2026-04-02T00:00:00Z',
        '2026-03-01T00:00:00Z',
      );
      expect(hash1).not.toBe(hash2);
    });

    it('returns different hashes for different maxCreated', () => {
      const hash1 = MaterializationGuard.buildHash(
        5,
        '2026-04-01T00:00:00Z',
        '2026-03-01T00:00:00Z',
      );
      const hash2 = MaterializationGuard.buildHash(
        5,
        '2026-04-01T00:00:00Z',
        '2026-03-02T00:00:00Z',
      );
      expect(hash1).not.toBe(hash2);
    });

    it('handles null maxUpdated and maxCreated', () => {
      const hash = MaterializationGuard.buildHash(0, null, null);
      expect(hash).toBe('0||');
    });
  });

  describe('needsMaterialization', () => {
    const freshStatus = (
      overrides?: Partial<{ horizonEnd: string; schedulesHash: string; lastMaterializedAt: Date }>,
    ) => ({
      horizonEnd: '2027-04-30',
      schedulesHash: 'abc',
      lastMaterializedAt: new Date(), // just now
      ...overrides,
    });

    it('returns true when status is null', () => {
      expect(MaterializationGuard.needsMaterialization(null, 4, 2026, 'abc')).toBe(true);
    });

    it('returns true when horizon does not cover target month', () => {
      const status = freshStatus({ horizonEnd: '2026-03-31' }); // before April 2026
      expect(MaterializationGuard.needsMaterialization(status, 4, 2026, 'abc')).toBe(true);
    });

    it('returns false when horizon exactly covers the last day of target month', () => {
      const status = freshStatus({ horizonEnd: '2026-04-30' }); // last day of April 2026
      expect(MaterializationGuard.needsMaterialization(status, 4, 2026, 'abc')).toBe(false);
    });

    it('returns true when schedules hash has changed', () => {
      const status = freshStatus({ schedulesHash: 'old-hash' });
      expect(MaterializationGuard.needsMaterialization(status, 4, 2026, 'new-hash')).toBe(true);
    });

    it('returns true when cache has expired (>1h)', () => {
      const expiredAt = new Date(Date.now() - 61 * 60 * 1000); // 61 minutes ago
      const status = freshStatus({ lastMaterializedAt: expiredAt });
      expect(MaterializationGuard.needsMaterialization(status, 4, 2026, 'abc')).toBe(true);
    });

    it('returns false when everything is fresh and horizon covers target', () => {
      const status = freshStatus(); // just now, far horizon, matching hash
      expect(MaterializationGuard.needsMaterialization(status, 4, 2026, 'abc')).toBe(false);
    });

    it('returns false when cache is just under 1h old', () => {
      const recentAt = new Date(Date.now() - 59 * 60 * 1000); // 59 minutes ago
      const status = freshStatus({ lastMaterializedAt: recentAt });
      expect(MaterializationGuard.needsMaterialization(status, 4, 2026, 'abc')).toBe(false);
    });
  });
});
