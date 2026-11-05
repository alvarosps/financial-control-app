// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from './middleware';

describe('device capture middleware', () => {
  it('leaves the exact integration endpoints to their server secret authentication', () => {
    for (const path of ['/api/integrations/pluggy/webhook', '/api/cron/integrations']) {
      expect(
        middleware(new NextRequest(`https://fixture.test${path}`)).headers.get('x-middleware-next'),
      ).toBe('1');
    }
    for (const path of ['/api/integrations/pluggy/webhook/extra', '/api/cron/integrations-other']) {
      expect(
        middleware(new NextRequest(`https://fixture.test${path}`)).headers.get('location'),
      ).toBe('https://fixture.test/login');
    }
  });
  it('lets exact capture endpoints authenticate their own device credentials without a web session', () => {
    for (const path of ['/api/capture/pair', '/api/capture/events']) {
      const response = middleware(
        new NextRequest(`https://fixture.test${path}`, { method: 'POST' }),
      );
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
  });
  it('still requires a web session for settings and lookalike capture paths', () => {
    for (const path of ['/settings', '/api/capture/events-other', '/api/capture/pair/extra']) {
      expect(
        middleware(new NextRequest(`https://fixture.test${path}`)).headers.get('location'),
      ).toBe('https://fixture.test/login');
    }
  });
});
