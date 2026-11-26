import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, uuidv7, withUser, type Actor } from "../src/index.js";

// Rola aplikacji (kivo_tasks_app): RLS obowiązuje ją zawsze. Lokalnie: pnpm db:up && pnpm db:migrate.
const url =
  process.env.KIVOTASKS_TEST_APP_DATABASE_URL ??
  "postgresql://kivo_tasks_app:kivo_tasks_app@localhost:5436/kivo_tasks_test";
// Jedno połączenie w puli pozwala użyć tabeli tymczasowej z wymuszonym RLS do sprawdzenia funkcji pomocniczych w etapie 0.
const db = createDb(url, { max: 1 });

const acme = uuidv7();
const globex = uuidv7();
const anna: Actor = { organizationId: acme, accountId: uuidv7() };
const bartek: Actor = { organizationId: acme, accountId: uuidv7() };
const celina: Actor = { organizationId: globex, accountId: uuidv7() };

beforeAll(async () => {
  await db.$executeRawUnsafe(`
    CREATE TEMP TABLE rls_stage0_probe (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      account_id UUID NOT NULL,
      label TEXT NOT NULL
    )
  `);
  await db.$executeRawUnsafe(`ALTER TABLE rls_stage0_probe ENABLE ROW LEVEL SECURITY`);
  await db.$executeRawUnsafe(`ALTER TABLE rls_stage0_probe FORCE ROW LEVEL SECURITY`);
  await db.$executeRawUnsafe(`
    CREATE POLICY owner_isolation ON rls_stage0_probe
      USING (
        organization_id = "public"."current_organization_id"()
        AND account_id = "public"."current_account_id"()
      )
      WITH CHECK (
        organization_id = "public"."current_organization_id"()
        AND account_id = "public"."current_account_id"()
      )
  `);
});

afterAll(async () => {
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS rls_stage0_probe`);
  await db.session.deleteMany({ where: { organizationId: { in: [acme, globex] } } });
  await db.processedEvent.deleteMany({ where: { consumer: "kivotasks-rls-test" } });
  await db.eventFeedCursor.deleteMany({ where: { id: "core-rls-test" } });
  await db.$disconnect();
});

describe("RLS i uprawnienia roli aplikacji kivo_tasks_app (etap 0)", () => {
  it("rola kivo_tasks_app nie jest superużytkownikiem i nie ma BYPASSRLS", async () => {
    const rows = await db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("withUser ustawia current_organization_id() i current_account_id() wyłącznie na czas transakcji", async () => {
    const inside = await withUser(
      db,
      anna,
      (tx) =>
        tx.$queryRaw<{ organizationId: string | null; accountId: string | null }[]>`
        SELECT "public"."current_organization_id"()::text AS "organizationId",
               "public"."current_account_id"()::text AS "accountId"
      `,
    );
    expect(inside).toEqual([{ organizationId: anna.organizationId, accountId: anna.accountId }]);

    // Po zakończeniu transakcji zmienne znikają i nie przeciekają na kolejne zapytania z puli
    const outside = await db.$queryRaw<{ organizationId: string | null; accountId: string | null }[]>`
      SELECT "public"."current_organization_id"()::text AS "organizationId",
             "public"."current_account_id"()::text AS "accountId"
    `;
    expect(outside).toEqual([{ organizationId: null, accountId: null }]);
  });

  it("odrzuca niepoprawny UUID w withUser przed wysłaniem zapytania do bazy", async () => {
    await expect(
      withUser(db, { organizationId: "nie-uuid", accountId: anna.accountId }, async () => true),
    ).rejects.toThrow(/UUID/);
    await expect(
      withUser(db, { organizationId: anna.organizationId, accountId: "nie-uuid" }, async () => true),
    ).rejects.toThrow(/UUID/);
  });

  it("polityka RLS oparta na funkcjach pomocniczych izoluje odczyt i zapis między firmami i kontami", async () => {
    const annaRowId = uuidv7();
    await withUser(
      db,
      anna,
      (tx) =>
        tx.$executeRaw`
        INSERT INTO rls_stage0_probe (id, organization_id, account_id, label)
        VALUES (${annaRowId}::uuid, ${anna.organizationId}::uuid, ${anna.accountId}::uuid, 'wpis-anny')
      `,
    );

    const annaVisible = await withUser(
      db,
      anna,
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM rls_stage0_probe`,
    );
    expect(annaVisible).toEqual([{ id: annaRowId }]);

    // Inna osoba z tej samej firmy, osoba z innej firmy i zapytanie bez withUser nie widzą wiersza
    expect(
      await withUser(db, bartek, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM rls_stage0_probe`),
    ).toEqual([]);
    expect(
      await withUser(db, celina, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM rls_stage0_probe`),
    ).toEqual([]);
    expect(await db.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM rls_stage0_probe`).toEqual([]);

    // Nie da się zapisać wiersza z cudzym organization_id albo account_id
    await expect(
      withUser(
        db,
        anna,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO rls_stage0_probe (id, organization_id, account_id, label)
          VALUES (${uuidv7()}::uuid, ${celina.organizationId}::uuid, ${celina.accountId}::uuid, 'obcy')
        `,
      ),
    ).rejects.toThrow();

    await withUser(db, anna, (tx) => tx.$executeRaw`DELETE FROM rls_stage0_probe WHERE id = ${annaRowId}::uuid`);
  });

  it("sesje przeglądarki i tabele kanału zdarzeń są dostępne dla kivo_tasks_app bez ustawionej firmy", async () => {
    const sessionId = `skrot-${uuidv7()}`;
    await db.session.create({
      data: {
        id: sessionId,
        accountId: anna.accountId,
        organizationId: acme,
        expiresAt: new Date(Date.now() + 60_000),
        data: "x",
      },
    });
    expect((await db.session.findUnique({ where: { id: sessionId } }))?.accountId).toBe(anna.accountId);
    await db.session.delete({ where: { id: sessionId } });

    await db.eventFeedCursor.upsert({
      where: { id: "core-rls-test" },
      create: { id: "core-rls-test", sequence: "42" },
      update: { sequence: "42" },
    });
    expect((await db.eventFeedCursor.findUnique({ where: { id: "core-rls-test" } }))?.sequence).toBe("42");

    const eventId = uuidv7();
    await db.processedEvent.create({
      data: { consumer: "kivotasks-rls-test", eventId, processedAt: new Date() },
    });
    expect(
      await db.processedEvent.findUnique({
        where: { consumer_eventId: { consumer: "kivotasks-rls-test", eventId } },
      }),
    ).not.toBeNull();
  });

  it("rola aplikacji nie widzi historii migracji", async () => {
    await expect(db.$queryRaw`SELECT count(*) FROM public._prisma_migrations`).rejects.toThrow(/permission denied/);
  });
});
