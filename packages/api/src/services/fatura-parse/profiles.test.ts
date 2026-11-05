import { describe, expect, it } from 'vitest';
import { FATURA_PROFILE_IDS, FATURA_PROFILES, getFaturaProfile } from './profiles.ts';

describe('FATURA_PROFILES', () => {
  it('has unique ids and a generic fallback', () => {
    expect(new Set(FATURA_PROFILE_IDS).size).toBe(FATURA_PROFILES.length);
    expect(FATURA_PROFILE_IDS).toContain('generic');
  });

  it('defines useful labels and hints for every profile', () => {
    for (const profile of FATURA_PROFILES) {
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.hints.length).toBeGreaterThan(20);
    }
  });
});

describe('getFaturaProfile', () => {
  it('resolves a known id', () => {
    expect(getFaturaProfile('nubank').id).toBe('nubank');
  });

  it('falls back to generic for absent or unknown ids', () => {
    expect(getFaturaProfile('unknown').id).toBe('generic');
    expect(getFaturaProfile(null).id).toBe('generic');
    expect(getFaturaProfile(undefined).id).toBe('generic');
  });
});
