import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import superjson from 'superjson';

// msw-trpc's createTRPCMsw requires the AppRouter type. We import it lazily
// inside tests that need tRPC interception so that tests only needing plain
// msw handlers (or none at all) don't pull the heavy type graph.
export const server = setupServer(
  http.get('*/api/trpc/account.balanceAdjustmentPreview', () =>
    HttpResponse.json({
      result: {
        data: superjson.serialize({
          name: 'Conta corrente',
          cash: 1000,
          anchorAt: new Date('2020-01-01T12:00:00Z'),
          revision: 'a'.repeat(64),
        }),
      },
    }),
  ),
  http.get('*/api/trpc/purchaseInbox.coverage', () =>
    HttpResponse.json({ result: { data: superjson.serialize([]) } }),
  ),
  http.get('*/api/trpc/faturaImport.capabilities', () =>
    HttpResponse.json({
      result: {
        data: superjson.serialize({
          available: true,
          provider: 'Anthropic',
          maxBytes: 3145728,
          maxPages: 50,
          timeoutMs: 60000,
        }),
      },
    }),
  ),
  http.get('*/api/trpc/faturaImport.listByCard', () =>
    HttpResponse.json({ result: { data: superjson.serialize([]) } }),
  ),
);
