/**
 * SEED DE DEMO (fable-audit Fase 5).
 *
 * Cria 3 personas demo (rafael/marina/novo @demo.financial-control.test) via
 * better-auth signUpEmail (exercita o provisionamento real de user_profiles) e
 * popula Rafael/Marina com o dataset de ./demo/dataset.ts usando os fluxos
 * canônicos do app (ver ./demo/seed-persona.ts). A persona "novo" fica vazia
 * de propósito (estados de onboarding).
 *
 * Uso (a partir da RAIZ do monorepo, .env carregado via dotenv):
 *   pnpm demo:seed --confirm     # reset das personas demo + seed completo
 *   pnpm demo:reset --confirm    # apaga SOMENTE os dados das personas demo
 *
 * GUARDAS:
 *   - Recusa qualquer DATABASE_URL cujo host não seja localhost/127.0.0.1.
 *   - Exige a flag --confirm.
 *   - Reset/seed tocam APENAS usuários com e-mail *@demo.financial-control.test.
 *
 * IMPORTANTE: pare o dev server antes de rodar (o auto-materializer pode
 * duplicar inserções em andamento). A execução é responsabilidade do
 * orquestrador, com aprovação humana.
 */
import 'dotenv/config';
import { createDb, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { createAuth } from '../auth.ts';
import { dataset } from './demo/dataset.ts';
import { printInventory } from './demo/inventory.ts';
import { getDemoCredentials } from './demo/personas.ts';
import { resetDemoData } from './demo/reset.ts';
import { seedPersonaData } from './demo/seed-persona.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function assertLocalDatabase(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    console.error('demo-seed: DATABASE_URL inválida.');
    process.exit(1);
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    console.error(
      `demo-seed: RECUSADO — host '${hostname}' não é local (localhost/127.0.0.1). ` +
        'Este seed nunca deve rodar contra um banco remoto.',
    );
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const resetOnly = args.includes('--reset');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('demo-seed: DATABASE_URL is required.');
  assertLocalDatabase(databaseUrl);
  if (!args.includes('--confirm')) {
    console.error(
      'demo-seed: a flag --confirm é obrigatória.\n' +
        '  pnpm demo:seed --confirm   (reset + seed)\n' +
        '  pnpm demo:reset --confirm  (apenas apagar personas demo)',
    );
    process.exit(1);
  }

  const db = createDb(databaseUrl);

  console.log('=== Reset das personas demo (*@demo.financial-control.test) ===');
  const removed = await resetDemoData(db);
  console.log(
    `Removidos: ${removed.profiles} perfil(is) de domínio, ${removed.authUsers} usuário(s) better-auth.`,
  );
  if (resetOnly) {
    console.log('Modo --reset: concluído.');
    process.exit(0);
  }

  // O sign-up das personas precisa funcionar mesmo com signup desabilitado no
  // ambiente; só afeta este processo.
  process.env.AUTH_DISABLE_SIGNUP = 'false';
  const auth = createAuth(db);
  const now = new Date();

  const refs: Array<{ key: string; email: string; userId: string }> = [];
  for (const persona of dataset.personas) {
    const creds = getDemoCredentials(persona.key);
    console.log(`\n=== Persona ${persona.name} <${creds.email}> ===`);
    await auth.api.signUpEmail({
      body: { email: creds.email, password: creds.password, name: persona.name },
    });
    const [profile] = await db
      .select({ id: userProfiles.id })
      .from(userProfiles)
      .where(eq(userProfiles.email, creds.email));
    if (!profile) {
      throw new Error(`demo-seed: user_profiles não foi provisionado para ${creds.email}`);
    }
    refs.push({ key: persona.key, email: creds.email, userId: profile.id });

    if (persona.role === 'empty') {
      console.log('  Persona vazia (onboarding) — apenas o cadastro, nenhum dado.');
      continue;
    }
    await seedPersonaData(db, profile.id, persona, now);
  }

  await printInventory(db, refs);
  console.log('\n=== Demo seed concluído ===');
  process.exit(0);
}

main().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
