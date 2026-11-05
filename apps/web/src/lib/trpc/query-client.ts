import { defaultShouldDehydrateQuery, QueryClient } from '@tanstack/react-query';
import superjson from 'superjson';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        refetchOnWindowFocus: true,
      },
      dehydrate: {
        serializeData: superjson.serialize,
        // Dehydrate RESOLVED queries only (success or error). Shells `await`
        // their prefetches, so the data is resolved before render: the server
        // renders real content and the client hydrates the same content — no
        // loading→loaded divergence. NEVER dehydrate `pending`: a fast (local)
        // query would resolve on the client by hydration time while the server
        // HTML is frozen mid-load, producing a hydration mismatch.
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === 'error',
      },
      hydrate: {
        deserializeData: superjson.deserialize,
      },
    },
  });
}
