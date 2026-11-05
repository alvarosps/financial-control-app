import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { SettingsClient } from './SettingsClient';

// authClient.signOut() drives a real fetch through better-auth's client, which
// constructs its own AbortSignal. jsdom's Request/fetch polyfill in this test
// environment rejects that cross-realm signal (a pre-existing jsdom/undici
// interop limitation, unrelated to this feature), so we can't exercise the
// real HTTP round-trip here. This is a render-only test per the project's
// no-internal-mocking policy: authClient is an external HTTP boundary and the
// only way to stub it without hitting the jsdom limitation would be mocking
// the module directly, which the mocking policy disallows.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe('SettingsClient sign-out control', () => {
  it('renders a sign-out button in the profile section', async () => {
    server.use(
      http.get(`${TRPC_TEST_URL}/integration.list`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({ enabled: false, configuredItems: [], connections: [] }),
          },
        }),
      ),
      http.get(`${TRPC_TEST_URL}/captureDevice.list`, () =>
        HttpResponse.json({
          result: { data: superjson.serialize({ enabled: false, devices: [] }) },
        }),
      ),
      http.get(`${TRPC_TEST_URL}/dashboard.profile`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: 'user-1',
              email: 'alvaro@example.com',
              name: 'Alvaro Souza',
              createdAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
      ),
    );

    renderWithProviders(
      <TRPCTestProvider>
        <SettingsClient />
      </TRPCTestProvider>,
    );

    const button = await screen.findByRole('button', { name: 'Sair da conta' });
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(await screen.findByText('Nenhuma conexão pessoal cadastrada.')).toBeInTheDocument();
  });
});
