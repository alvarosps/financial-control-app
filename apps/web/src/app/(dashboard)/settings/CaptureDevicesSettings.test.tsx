import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { CaptureDevicesSettings } from './CaptureDevicesSettings';

const response = (value: unknown) =>
  HttpResponse.json({ result: { data: superjson.serialize(value) } });
describe('capture settings', () => {
  it('renews the selected device and clears a visible code when revoking', async () => {
    const device = {
      id: 'fa9eb041-bc6a-488a-8d92-2d4e29e5ac9b',
      name: 'Fixture phone',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
      lastReceivedAt: null,
    };
    const inputs: unknown[] = [];
    let revoked = false;
    server.use(
      http.get(`${TRPC_TEST_URL}/captureDevice.list`, () =>
        response({
          enabled: true,
          devices: [{ ...device, revokedAt: revoked ? new Date() : null }],
        }),
      ),
      http.post(`${TRPC_TEST_URL}/captureDevice.createPairing`, async ({ request }) => {
        inputs.push(await request.json());
        return response({ code: 'fixture-code', expiresAt: new Date(Date.now() + 300000) });
      }),
      http.post(`${TRPC_TEST_URL}/captureDevice.revoke`, () => {
        revoked = true;
        return response({ id: device.id });
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <CaptureDevicesSettings />
      </TRPCTestProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Renovar pareamento' }));
    expect(await screen.findByText('fixture-code')).toBeInTheDocument();
    expect(inputs[0]).toMatchObject({ json: { name: device.name, deviceId: device.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Revogar acesso de envio' }));
    await waitFor(() => expect(screen.queryByText('fixture-code')).not.toBeInTheDocument());
    expect(await screen.findByText('Revogado')).toBeInTheDocument();
  });
});
