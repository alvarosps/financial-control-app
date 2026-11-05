import { dehydrate, hydrate } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { makeQueryClient } from '../trpc/query-client';

// Locks in the server→client hydration round-trip: the shared makeQueryClient
// configures superjson serialize/deserialize on dehydrate/hydrate so Date (and
// other rich) values survive the RSC boundary as real Dates, not strings. If
// this regresses, prefetched detail pages would crash on `.toLocaleDateString`.
describe('makeQueryClient superjson dehydrate/hydrate', () => {
  it('round-trips a Date through dehydrate → JSON → hydrate', () => {
    const server = makeQueryClient();
    const iso = '2026-06-01T12:34:56.000Z';
    server.setQueryData(['detail'], { when: new Date(iso), amount: '1234.56' });

    // dehydrate uses the client's configured superjson serializeData
    const dehydrated = dehydrate(server);
    // simulate crossing the server→client boundary as JSON
    const wire = JSON.parse(JSON.stringify(dehydrated));

    const client = makeQueryClient();
    hydrate(client, wire);

    const data = client.getQueryData<{ when: Date; amount: string }>(['detail']);
    expect(data?.when).toBeInstanceOf(Date);
    expect(data?.when.toISOString()).toBe(iso);
    expect(data?.amount).toBe('1234.56');
  });

  it('does NOT dehydrate pending queries (prevents loading→loaded hydration mismatch)', () => {
    const server = makeQueryClient();
    // success query → dehydrated; pending query → excluded
    server.setQueryData(['resolved'], { ok: true });
    server.getQueryCache().build(server, { queryKey: ['stillPending'] });
    const dehydrated = dehydrate(server);
    const keys = dehydrated.queries.map((q) => JSON.stringify(q.queryKey));
    expect(keys).toContain(JSON.stringify(['resolved']));
    expect(keys).not.toContain(JSON.stringify(['stillPending']));
  });
});
