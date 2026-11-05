/**
 * Demo persona credentials. Demo users are identified everywhere (reset,
 * inventory, guards) by the e-mail suffix below — NEVER touch data of users
 * outside this suffix.
 *
 * These are intentionally-public demo credentials (not secrets): the personas
 * exist only on local databases for demos/screenshots.
 */

export const DEMO_EMAIL_SUFFIX = '@demo.financial-control.test';

export type DemoCredentials = { email: string; password: string };

const CREDENTIALS = new Map<string, DemoCredentials>([
  ['rafael', { email: `rafael${DEMO_EMAIL_SUFFIX}`, password: 'DemoRafael!2026' }],
  ['marina', { email: `marina${DEMO_EMAIL_SUFFIX}`, password: 'DemoMarina!2026' }],
  ['demo_novo', { email: `novo${DEMO_EMAIL_SUFFIX}`, password: 'DemoNovo!2026' }],
]);

export function getDemoCredentials(personaKey: string): DemoCredentials {
  const creds = CREDENTIALS.get(personaKey);
  if (!creds) {
    throw new Error(`demo-seed: sem credenciais demo para a persona '${personaKey}'`);
  }
  return creds;
}
