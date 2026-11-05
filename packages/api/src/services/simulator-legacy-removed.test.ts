import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = __dirname;
const serviceSrc = readFileSync(path.join(HERE, 'simulator.service.ts'), 'utf8');
const routerSrc = readFileSync(path.join(HERE, '..', 'routers', 'simulator.router.ts'), 'utf8');

describe('legacy simulator code removed', () => {
  it('drops FREQUENCY_FACTOR monthly-averaging from the service', () => {
    expect(serviceSrc).not.toContain('FREQUENCY_FACTOR');
  });

  it('drops the simulatePayoff/simulateWithout methods', () => {
    expect(serviceSrc).not.toMatch(/\bsimulatePayoff\b/);
    expect(serviceSrc).not.toMatch(/\bsimulateWithout\b/);
  });

  it('exposes run + scenario CRUD on the service', () => {
    expect(serviceSrc).toMatch(/\brun\s*\(/);
    expect(serviceSrc).toMatch(/\blistScenarios\b/);
    expect(serviceSrc).toMatch(/\bsaveScenario\b/);
    expect(serviceSrc).toMatch(/\bupdateScenario\b/);
    expect(serviceSrc).toMatch(/\bduplicateScenario\b/);
    expect(serviceSrc).toMatch(/\bdeleteScenario\b/);
  });

  it('drops payoff/without procedures from the router and keeps run', () => {
    expect(routerSrc).not.toMatch(/\bpayoff:\s*protectedProcedure/);
    expect(routerSrc).not.toMatch(/\bwithout:\s*protectedProcedure/);
    expect(routerSrc).toMatch(/\brun:\s*protectedProcedure/);
  });
});
