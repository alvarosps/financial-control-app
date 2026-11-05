import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import pt from '../messages/pt-BR.json';

type Messages = Record<string, unknown>;

function flatten(obj: Messages, prefix = ''): Array<[string, string]> {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      return flatten(v as Messages, key);
    }
    return [[key, String(v)]];
  });
}

describe('i18n message parity', () => {
  const flatPt = flatten(pt as Messages);
  const flatEn = flatten(en as Messages);
  const ptKeys = flatPt.map(([k]) => k).sort();
  const enKeys = flatEn.map(([k]) => k).sort();

  it('en.json has exactly the same keys as pt-BR.json', () => {
    const missingInEn = ptKeys.filter((k) => !enKeys.includes(k));
    const missingInPt = enKeys.filter((k) => !ptKeys.includes(k));
    expect(missingInEn, 'keys present in pt-BR but missing from en').toEqual([]);
    expect(missingInPt, 'keys present in en but missing from pt-BR').toEqual([]);
  });

  it('every value is a non-empty string', () => {
    const emptyPt = flatPt.filter(([, v]) => !v || v.trim() === '');
    const emptyEn = flatEn.filter(([, v]) => !v || v.trim() === '');
    expect(emptyPt, 'empty values in pt-BR').toEqual([]);
    expect(emptyEn, 'empty values in en').toEqual([]);
  });
});
