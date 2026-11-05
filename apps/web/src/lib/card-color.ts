// Deterministic per-entity OKLCH color from a stable id (no DB color field exists).
export function cardColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `oklch(0.62 0.17 ${hue})`;
}
