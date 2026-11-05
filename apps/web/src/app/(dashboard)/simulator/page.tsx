import { HydrateClient, trpc } from '@/lib/trpc/server';
import { SimulatorClient } from './SimulatorClient';

export const dynamic = 'force-dynamic';

export default async function SimulatorPage() {
  await Promise.all([
    trpc.simulator.run.prefetch({ horizon: 12, levers: [] }),
    trpc.simulator.listScenarios.prefetch(),
  ]);
  return (
    <HydrateClient>
      <SimulatorClient />
    </HydrateClient>
  );
}
