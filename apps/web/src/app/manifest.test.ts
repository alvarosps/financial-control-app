import { describe, expect, it } from 'vitest';
import manifest from './manifest';

describe('PWA manifest', () => {
  it('declares a standalone app anchored at /dashboard', () => {
    const value = manifest();

    expect(value.name).toBe('Financial Control');
    expect(value.short_name).toBe('Financial Control');
    expect(value.display).toBe('standalone');
    expect(value.start_url).toBe('/dashboard');
    expect(value.scope).toBe('/');
    expect(value.prefer_related_applications).toBe(false);
  });

  it('uses Aurora-derived hex colors', () => {
    const value = manifest();

    expect(value.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(value.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('declares 192/512 icons plus a maskable variant under /icons/', () => {
    const icons = manifest().icons ?? [];

    expect(icons).toHaveLength(3);
    for (const icon of icons) {
      expect(icon.src.startsWith('/icons/')).toBe(true);
      expect(icon.type).toBe('image/png');
    }
    expect(icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(icons.filter((icon) => icon.sizes === '512x512')).toHaveLength(2);
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });
});
