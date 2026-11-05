import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, '..');

function brandSvg({ maskable }) {
  const glyphs = `
    <rect x="130" y="150" width="38" height="212" rx="10" fill="#ffffff"/>
    <rect x="130" y="150" width="112" height="38" rx="10" fill="#ffffff"/>
    <rect x="130" y="240" width="92" height="34" rx="10" fill="#ffffff"/>
    <path d="M 392 196 A 86 86 0 1 0 392 316" fill="none" stroke="#ffffff" stroke-width="38" stroke-linecap="round"/>`;
  const content = maskable
    ? `<rect width="512" height="512" fill="url(#gradient)"/><g transform="translate(51.2 51.2) scale(0.8)">${glyphs}</g>`
    : `<rect width="512" height="512" rx="112" fill="url(#gradient)"/>${glyphs}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs><linearGradient id="gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a5af8"/><stop offset="1" stop-color="#43cfca"/></linearGradient></defs>
    ${content}
  </svg>`;
}

const outputs = [
  { file: 'src/app/icon.png', size: 512, maskable: false },
  { file: 'src/app/apple-icon.png', size: 180, maskable: false },
  { file: 'public/icons/icon-192.png', size: 192, maskable: false },
  { file: 'public/icons/icon-512.png', size: 512, maskable: false },
  { file: 'public/icons/icon-512-maskable.png', size: 512, maskable: true },
];

for (const { file, size, maskable } of outputs) {
  const destination = path.join(webRoot, file);
  await mkdir(path.dirname(destination), { recursive: true });
  const png = await sharp(Buffer.from(brandSvg({ maskable })))
    .resize(size, size)
    .png()
    .toBuffer();
  const metadata = await sharp(png).metadata();
  if (metadata.width !== size || metadata.height !== size) {
    throw new Error(`${file}: expected ${size}x${size}, got ${metadata.width}x${metadata.height}`);
  }
  await sharp(png).toFile(destination);
  console.log(`wrote ${file} (${size}x${size}${maskable ? ', maskable' : ''})`);
}
