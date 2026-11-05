// apps/web/src/lib/simulator/export-types.ts
// `RunResult` is the de-serialized `trpc.simulator.run` output on the client.
// It is inferred from `SimulatorService.run` in `@fc/api`; import it rather than
// redeclaring so the export stays in lockstep with the server contract.
export type { RunResult } from '@fc/api';

/** The three artifacts produced by `buildExport` for the export-to-AI dialog. */
export type ScenarioExport = { markdown: string; json: string; prompt: string };
