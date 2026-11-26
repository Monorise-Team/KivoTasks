/**
 * Testy separacji firm na bazie PostgreSQL (ADR-0037) za pomocą `checkTenantIsolation`
 * z `@monorise-team/testing`. W etapie 0 (przed tabelami domenowymi z etapu 1) weryfikują
 * funkcję pomocniczą `public.current_organization_id()`, `public.current_account_id()` oraz `withUser`
 * na tabeli tymczasowej z wymuszonym RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY`).
 *
 * Wymaga uruchomionej bazy testowej (`pnpm db:up && pnpm db:migrate`, rola `kivo_tasks_app` z RLS).
 */
import { checkTenantIsolation, formatViolations } from "@monorise-team/testing";
import { createDb, uuidv7, withUser, type Actor } from "@kivotasks/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/server/config";

// Jedno połączenie w puli gwarantuje wspólną sesję PostgreSQL dla tabeli tymczasowej z RLS.
const db = createDb(config.databaseUrl, { max: 1 });

beforeAll(async () => {
  await db.$executeRawUnsafe(`
    CREATE TEMP TABLE tenant_isolation_probe (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      account_id UUID NOT NULL,
      title TEXT NOT NULL
    )
  `);
  await db.$executeRawUnsafe(`ALTER TABLE tenant_isolation_probe ENABLE ROW LEVEL SECURITY`);
  await db.$executeRawUnsafe(`ALTER TABLE tenant_isolation_probe FORCE ROW LEVEL SECURITY`);
  await db.$executeRawUnsafe(`
    CREATE POLICY tenant_isolation ON tenant_isolation_probe
      USING (organization_id = "public"."current_organization_id"())
      WITH CHECK (organization_id = "public"."current_organization_id"())
  `);
});

afterAll(async () => {
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS tenant_isolation_probe`);
  await db.$disconnect();
});

describe("Separacja firm w bazie danych (checkTenantIsolation, ADR-0037)", () => {
  it("withUser: firma B nigdy nie odczytuje wierszy firmy A przez politykę RLS", async () => {
    const actorsByTenant = new Map<string, Actor>();

    const actorFor = (tenantId: string): Actor => {
      let actor = actorsByTenant.get(tenantId);
      if (!actor) {
        actor = { organizationId: tenantId, accountId: uuidv7() };
        actorsByTenant.set(tenantId, actor);
      }
      return actor;
    };

    const result = await checkTenantIsolation({
      seedAsTenant: async (tenantId) => {
        const actor = actorFor(tenantId);
        await withUser(
          db,
          actor,
          (tx) =>
            tx.$executeRaw`
            INSERT INTO tenant_isolation_probe (id, organization_id, account_id, title)
            VALUES (${uuidv7()}::uuid, ${actor.organizationId}::uuid, ${actor.accountId}::uuid, 'Zadanie firmy A')
          `,
        );
      },
      readAsTenant: async (tenantId) => {
        const actor = actorFor(tenantId);
        return withUser(
          db,
          actor,
          (tx) =>
            tx.$queryRaw<{ id: string; organizationId: string }[]>`
            SELECT id::text AS id, organization_id::text AS "organizationId"
            FROM tenant_isolation_probe
          `,
        );
      },
      cleanup: async ({ tenantAId, tenantBId }) => {
        for (const tenantId of [tenantAId, tenantBId]) {
          const actor = actorsByTenant.get(tenantId);
          if (actor) {
            await withUser(db, actor, (tx) => tx.$executeRaw`DELETE FROM tenant_isolation_probe`);
          }
        }
      },
    });

    expect(result.passed, formatViolations(result.violations)).toBe(true);
  });
});
