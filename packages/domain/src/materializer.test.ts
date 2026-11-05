import { describe, expect, it } from 'vitest';
import { computeOccurrenceDates } from './materializer.ts';

describe('computeOccurrenceDates', () => {
  describe('monthly frequency', () => {
    it('generates 12 months of dates for infinite recurring', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 2, 1),
        dueDay: 10,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 12,
      });
      expect(dates).toHaveLength(12);
      expect(dates[0]).toEqual({ date: new Date(2026, 2, 10), occurrenceNumber: 1 });
      expect(dates[11]).toEqual({ date: new Date(2027, 1, 10), occurrenceNumber: 12 });
    });

    it('generates remaining installments for 10-part plan starting at 3', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 3, 5),
        dueDay: 5,
        totalOccurrences: 10,
        startingOccurrence: 3,
        horizonMonths: 12,
      });
      expect(dates).toHaveLength(8);
      expect(dates[0]).toEqual({ date: new Date(2026, 3, 5), occurrenceNumber: 3 });
      expect(dates[7]).toEqual({ date: new Date(2026, 10, 5), occurrenceNumber: 10 });
    });

    it('stops at totalOccurrences even if horizon is longer', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 2, 1),
        dueDay: 15,
        totalOccurrences: 3,
        startingOccurrence: 1,
        horizonMonths: 12,
      });
      expect(dates).toHaveLength(3);
    });

    it('stops at horizon even if more occurrences remain', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 2, 1),
        dueDay: 15,
        totalOccurrences: 100,
        startingOccurrence: 1,
        horizonMonths: 6,
      });
      expect(dates).toHaveLength(6);
    });

    it('handles dueDay 31 in short months', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 1, 1),
        dueDay: 31,
        totalOccurrences: 3,
        startingOccurrence: 1,
        horizonMonths: 12,
      });
      expect(dates[0].date.getDate()).toBeLessThanOrEqual(28);
      expect(dates[1].date.getDate()).toBe(31);
      expect(dates[2].date.getDate()).toBe(30);
    });
  });

  describe('once frequency', () => {
    it('generates exactly one date', () => {
      const dates = computeOccurrenceDates({
        frequency: 'once',
        startDate: new Date(2026, 2, 15),
        dueDay: null,
        totalOccurrences: 1,
        startingOccurrence: 1,
        horizonMonths: 12,
      });
      expect(dates).toHaveLength(1);
      expect(dates[0]).toEqual({ date: new Date(2026, 2, 15), occurrenceNumber: 1 });
    });
  });

  describe('bimonthly frequency', () => {
    it('generates every 2 months', () => {
      const dates = computeOccurrenceDates({
        frequency: 'bimonthly',
        startDate: new Date(2026, 0, 1),
        dueDay: 10,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 12,
      });
      expect(dates).toHaveLength(6);
      expect(dates[0].date.getMonth()).toBe(0);
      expect(dates[1].date.getMonth()).toBe(2);
      expect(dates[2].date.getMonth()).toBe(4);
    });
  });

  describe('quarterly frequency', () => {
    it('generates every 3 months', () => {
      const dates = computeOccurrenceDates({
        frequency: 'quarterly',
        startDate: new Date(2026, 0, 1),
        dueDay: 15,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 12,
      });
      expect(dates).toHaveLength(4);
    });
  });

  describe('annual frequency', () => {
    it('generates one per year within horizon', () => {
      const dates = computeOccurrenceDates({
        frequency: 'annual',
        startDate: new Date(2026, 5, 1),
        dueDay: 20,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 24,
      });
      expect(dates).toHaveLength(2);
    });
  });

  describe('weekly frequency', () => {
    it('generates weekly dates', () => {
      const dates = computeOccurrenceDates({
        frequency: 'weekly',
        startDate: new Date(2026, 2, 2),
        dueDay: null,
        totalOccurrences: 4,
        startingOccurrence: 1,
        horizonMonths: 1,
      });
      expect(dates).toHaveLength(4);
      expect(dates[1].date).toEqual(new Date(2026, 2, 9));
      expect(dates[2].date).toEqual(new Date(2026, 2, 16));
    });
  });

  describe('biweekly frequency', () => {
    it('generates every 2 weeks', () => {
      const dates = computeOccurrenceDates({
        frequency: 'biweekly',
        startDate: new Date(2026, 2, 2),
        dueDay: null,
        totalOccurrences: 3,
        startingOccurrence: 1,
        horizonMonths: 2,
      });
      expect(dates).toHaveLength(3);
      expect(dates[1].date).toEqual(new Date(2026, 2, 16));
      expect(dates[2].date).toEqual(new Date(2026, 2, 30));
    });
  });

  describe('horizon overflow-safety (startDate dia 29-31)', () => {
    it('monthly: start Jan 31, horizon 1 -> exatamente 1 ocorrencia', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 0, 31),
        dueDay: 31,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 1,
      });
      expect(dates).toHaveLength(1);
      expect(dates[0].date).toEqual(new Date(2026, 0, 31));
    });

    it('monthly: start Jan 30, horizon 1 -> exatamente 1 ocorrencia', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 0, 30),
        dueDay: 30,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 1,
      });
      expect(dates).toHaveLength(1);
    });

    it('monthly: start Jan 31, horizon 12 -> 12 ocorrencias, ultima em Dez 31', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 0, 31),
        dueDay: 31,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 12,
      });
      expect(dates).toHaveLength(12);
      expect(dates[11].date).toEqual(new Date(2026, 11, 31));
    });

    it('monthly: start Fev 29 (bissexto), horizon 12 -> 12 ocorrencias', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2028, 1, 29),
        dueDay: 29,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 12,
      });
      expect(dates).toHaveLength(12);
    });

    it('weekly: start Jan 31, horizon 1 -> para antes de Fev 28', () => {
      const dates = computeOccurrenceDates({
        frequency: 'weekly',
        startDate: new Date(2026, 0, 31),
        dueDay: null,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 1,
      });
      expect(dates).toHaveLength(4);
      expect(dates[3].date).toEqual(new Date(2026, 1, 21));
    });
  });

  describe('endDate cutoff', () => {
    it('stops before endDate', () => {
      const dates = computeOccurrenceDates({
        frequency: 'monthly',
        startDate: new Date(2026, 0, 1),
        dueDay: 10,
        totalOccurrences: null,
        startingOccurrence: 1,
        horizonMonths: 12,
        endDate: new Date(2026, 3, 30),
      });
      expect(dates).toHaveLength(4);
    });
  });
});
