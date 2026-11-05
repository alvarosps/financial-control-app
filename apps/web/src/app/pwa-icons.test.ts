import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const webRoot = process.cwd();
const expectedIcons = [
  { path: 'src/app/icon.png', size: 512 },
  { path: 'src/app/apple-icon.png', size: 180 },
  { path: 'public/icons/icon-192.png', size: 192 },
  { path: 'public/icons/icon-512.png', size: 512 },
  { path: 'public/icons/icon-512-maskable.png', size: 512 },
];

describe('generated PWA icons', () => {
  it.each(expectedIcons)('$path exists at $size × $size', async ({ path: relativePath, size }) => {
    const fullPath = path.join(webRoot, relativePath);

    expect(existsSync(fullPath)).toBe(true);
    const metadata = await sharp(fullPath).metadata();
    expect(metadata.width).toBe(size);
    expect(metadata.height).toBe(size);
  });
});
