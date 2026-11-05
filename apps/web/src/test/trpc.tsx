'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import type { ReactNode } from 'react';
import { useState } from 'react';
import superjson from 'superjson';
import { trpc } from '@/lib/trpc/client';

/**
 * tRPC + React Query provider for web component tests. Mirrors the real
 * `TRPCProvider` wiring (single `httpLink`, superjson transformer) but points
 * at a fixed test origin so msw can intercept the HTTP boundary. Retries are
 * disabled so a failed (or unhandled) request surfaces immediately instead of
 * stalling the test. The transformer matches the production client, so msw
 * handlers must return `superjson.serialize(...)` payloads.
 */
export const TRPC_TEST_URL = 'http://localhost:3000/api/trpc';

export function TRPCTestProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [httpLink({ url: TRPC_TEST_URL, transformer: superjson })],
    }),
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
