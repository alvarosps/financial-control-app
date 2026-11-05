import { describe, expect, it } from 'vitest';
import { CaptureDeviceService } from '../services/capture-device.service.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { handleCaptureRequest } from './capture-http.ts';

describe('capture transport', () => {
  it('gates activation and bounds malformed bodies without exposing submitted secrets', async () => {
    await withRollback(async (db) => {
      const req = (body: string, type = 'application/json') =>
        new Request('https://fixture.test/api/capture/pair', {
          method: 'POST',
          headers: { 'Content-Type': type },
          body,
        });
      expect((await handleCaptureRequest(req('{}'), db, 'pair', false)).status).toBe(503);
      expect((await handleCaptureRequest(req('{}', 'text/plain'), db, 'pair', true)).status).toBe(
        415,
      );
      expect((await handleCaptureRequest(req('x'.repeat(65537)), db, 'pair', true)).status).toBe(
        413,
      );
      const malformed = await handleCaptureRequest(req('secret: invalid JSON'), db, 'pair', true);
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain('secret');
      expect((await handleCaptureRequest(req('{}'), db, 'events', true)).status).toBe(401);
    });
  });
  it('exchanges a portal code through the same HTTP transport used by the phone', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const code = await new CaptureDeviceService(db).createPairing(f.user.id, { name: 'Phone' });
      const response = await handleCaptureRequest(
        new Request('https://fixture.test/api/capture/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code.code }),
        }),
        db,
        'pair',
        true,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ cards: [{ id: f.card.id }] });
    });
  });
});
