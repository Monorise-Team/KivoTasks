import { afterAll, describe, expect, it } from "vitest";
import { createDb, Prisma, uuidv7, withUser, type Actor } from "../src/index.js";

// Rola aplikacji (kivo_tasks_app): RLS obowiązuje ją zawsze. Lokalnie: pnpm db:up && pnpm db:migrate.
const url =
  process.env.KIVOTASKS_TEST_APP_DATABASE_URL ??
  "postgresql://kivo_tasks_app:kivo_tasks_app@localhost:5436/kivo_tasks_test";
const db = createDb(url, { max: 12 });

const acme = uuidv7();
const globex = uuidv7();
const anna: Actor = { organizationId: acme, accountId: uuidv7() };
const bartek: Actor = { organizationId: acme, accountId: uuidv7() };
const celina: Actor = { organizationId: globex, accountId: uuidv7() };

const DOMAIN_TABLES = [
  "teams",
  "workflow_states",
  "labels",
  "issues",
  "issue_labels",
  "issue_relations",
  "issue_comments",
  "comment_mentions",
  "comment_reactions",
  "issue_events",
  "issue_subscribers",
  "inbox_items",
] as const;

function expectForeignKeyError(error: unknown): void {
  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  const known = error as Prisma.PrismaClientKnownRequestError;
  const isFk = known.code === "P2003" || (known.code === "P2010" && /23503|foreign key/i.test(known.message));
  expect(isFk, `Oczekiwano błędu klucza obcego (P2003 / 23503), otrzymano ${known.code}: ${known.message}`).toBe(true);
}

afterAll(async () => {
  for (const actor of [anna, celina]) {
    await withUser(db, actor, async (tx) => {
      await tx.$executeRaw`DELETE FROM "public"."inbox_items"`;
      await tx.$executeRaw`DELETE FROM "public"."comment_reactions"`;
      await tx.$executeRaw`DELETE FROM "public"."comment_mentions"`;
      await tx.$executeRaw`DELETE FROM "public"."issue_comments"`;
      await tx.$executeRaw`DELETE FROM "public"."issue_events"`;
      await tx.$executeRaw`DELETE FROM "public"."issue_subscribers"`;
      await tx.issueRelation.deleteMany({});
      await tx.issueLabel.deleteMany({});
      await tx.issue.updateMany({ where: { parentId: { not: null } }, data: { parentId: null } });
      await tx.issue.deleteMany({});
      await tx.label.deleteMany({});
      await tx.workflowState.deleteMany({});
      await tx.team.deleteMany({});
    });
  }
  await db.session.deleteMany({ where: { organizationId: { in: [acme, globex] } } });
  await db.processedEvent.deleteMany({ where: { consumer: "kivotasks-rls-test" } });
  await db.eventFeedCursor.deleteMany({ where: { id: "core-rls-test" } });
  await db.$disconnect();
});

describe("RLS i uprawnienia roli aplikacji kivo_tasks_app", () => {
  it("rola kivo_tasks_app nie jest superużytkownikiem i nie ma BYPASSRLS", async () => {
    const rows = await db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("każda tabela domenowa ma włączone i wymuszone RLS (ENABLE + FORCE ROW LEVEL SECURITY)", async () => {
    const rows = await db.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${[...DOMAIN_TABLES]}::text[])
      ORDER BY c.relname
    `;
    expect(rows).toEqual(
      [...DOMAIN_TABLES].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
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

  it("izoluje odczyt i zapis między firmami we wszystkich tabelach domenowych etapu 1a", async () => {
    const teamId = uuidv7();
    const stateId = uuidv7();
    const labelId = uuidv7();
    const issue1Id = uuidv7();
    const issue2Id = uuidv7();
    const relationId = uuidv7();

    await withUser(db, anna, async (tx) => {
      await tx.team.create({
        data: { id: teamId, organizationId: acme, key: "MAG", name: "Magazyn", nextIssueNumber: 3 },
      });
      await tx.workflowState.create({
        data: {
          id: stateId,
          organizationId: acme,
          teamId,
          name: "Backlog",
          category: "BACKLOG",
          color: "gray",
          position: 0,
        },
      });
      await tx.label.create({
        data: { id: labelId, organizationId: acme, teamId, name: "Pilne", color: "red" },
      });
      await tx.issue.create({
        data: {
          id: issue1Id,
          organizationId: acme,
          teamId,
          number: 1,
          title: "Przegląd strefy przyjęć",
          description: "Sprawdzić bramę numer 2",
          stateId,
          priority: 2,
          creatorAccountId: anna.accountId,
          sortOrder: 1000,
        },
      });
      await tx.issue.create({
        data: {
          id: issue2Id,
          organizationId: acme,
          teamId,
          number: 2,
          title: "Zamówienie etykiet",
          stateId,
          priority: 3,
          creatorAccountId: anna.accountId,
          sortOrder: 2000,
        },
      });
      await tx.issueLabel.create({
        data: { issueId: issue1Id, labelId, organizationId: acme, teamId },
      });
      await tx.issueRelation.create({
        data: {
          id: relationId,
          organizationId: acme,
          issueId: issue1Id,
          relatedIssueId: issue2Id,
          type: "BLOCKS",
        },
      });
    });

    // Inna osoba z tej samej firmy (Bartek z Acme) widzi dane firmy Acme
    const bartekCounts = await withUser(db, bartek, async (tx) => ({
      teams: await tx.team.count(),
      states: await tx.workflowState.count(),
      labels: await tx.label.count(),
      issues: await tx.issue.count(),
      issueLabels: await tx.issueLabel.count(),
      issueRelations: await tx.issueRelation.count(),
    }));
    expect(bartekCounts).toEqual({
      teams: 1,
      states: 1,
      labels: 1,
      issues: 2,
      issueLabels: 1,
      issueRelations: 1,
    });

    // Osoba z innej firmy (Celina z Globex) nie widzi ani jednego wiersza w żadnej tabeli
    const celinaCounts = await withUser(db, celina, async (tx) => ({
      teams: await tx.team.count(),
      states: await tx.workflowState.count(),
      labels: await tx.label.count(),
      issues: await tx.issue.count(),
      issueLabels: await tx.issueLabel.count(),
      issueRelations: await tx.issueRelation.count(),
    }));
    expect(celinaCounts).toEqual({
      teams: 0,
      states: 0,
      labels: 0,
      issues: 0,
      issueLabels: 0,
      issueRelations: 0,
    });

    // Zapytania bez withUser również nic nie widzą
    expect(await db.team.count()).toBe(0);
    expect(await db.workflowState.count()).toBe(0);
    expect(await db.label.count()).toBe(0);
    expect(await db.issue.count()).toBe(0);
    expect(await db.issueLabel.count()).toBe(0);
    expect(await db.issueRelation.count()).toBe(0);

    // Zapis wiersza z cudzym organization_id zostaje odrzucony przez WITH CHECK na każdej z 6 tabel
    await expect(
      withUser(db, celina, (tx) =>
        tx.team.create({ data: { id: uuidv7(), organizationId: acme, key: "OBC", name: "Obcy" } }),
      ),
    ).rejects.toThrow();

    await expect(
      withUser(db, celina, (tx) =>
        tx.workflowState.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            teamId,
            name: "Obcy",
            category: "BACKLOG",
            color: "gray",
            position: 9,
          },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withUser(db, celina, (tx) =>
        tx.label.create({ data: { id: uuidv7(), organizationId: acme, teamId, name: "Obca", color: "blue" } }),
      ),
    ).rejects.toThrow();

    await expect(
      withUser(db, celina, (tx) =>
        tx.issue.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            teamId,
            number: 99,
            title: "Obce zadanie",
            stateId,
            creatorAccountId: celina.accountId,
          },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withUser(db, celina, (tx) =>
        tx.issueLabel.create({ data: { issueId: issue2Id, labelId, organizationId: acme, teamId } }),
      ),
    ).rejects.toThrow();

    await expect(
      withUser(db, celina, (tx) =>
        tx.issueRelation.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            issueId: issue2Id,
            relatedIssueId: issue1Id,
            type: "RELATED",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("złożone klucze obce blokują odwołania między firmami oraz między zespołami w ramach jednej firmy", async () => {
    const acmeTeamAId = uuidv7();
    const acmeTeamBId = uuidv7();
    const acmeStateAId = uuidv7();
    const acmeStateBId = uuidv7();
    const acmeLabelAId = uuidv7();
    const acmeLabelBId = uuidv7();
    const acmeIssueAId = uuidv7();
    const acmeIssueBId = uuidv7();

    const globexTeamId = uuidv7();
    const globexStateId = uuidv7();
    const globexLabelId = uuidv7();
    const globexIssueId = uuidv7();

    await withUser(db, anna, async (tx) => {
      await tx.team.create({ data: { id: acmeTeamAId, organizationId: acme, key: "FKA", name: "FK Zespół A" } });
      await tx.team.create({ data: { id: acmeTeamBId, organizationId: acme, key: "FKB", name: "FK Zespół B" } });
      await tx.workflowState.create({
        data: {
          id: acmeStateAId,
          organizationId: acme,
          teamId: acmeTeamAId,
          name: "Backlog",
          category: "BACKLOG",
          color: "gray",
          position: 0,
        },
      });
      await tx.workflowState.create({
        data: {
          id: acmeStateBId,
          organizationId: acme,
          teamId: acmeTeamBId,
          name: "Backlog",
          category: "BACKLOG",
          color: "gray",
          position: 0,
        },
      });
      await tx.label.create({
        data: { id: acmeLabelAId, organizationId: acme, teamId: acmeTeamAId, name: "A", color: "blue" },
      });
      await tx.label.create({
        data: { id: acmeLabelBId, organizationId: acme, teamId: acmeTeamBId, name: "B", color: "green" },
      });
      await tx.issue.create({
        data: {
          id: acmeIssueAId,
          organizationId: acme,
          teamId: acmeTeamAId,
          number: 1,
          title: "Zadanie A",
          stateId: acmeStateAId,
          creatorAccountId: anna.accountId,
        },
      });
      await tx.issue.create({
        data: {
          id: acmeIssueBId,
          organizationId: acme,
          teamId: acmeTeamBId,
          number: 1,
          title: "Zadanie B",
          stateId: acmeStateBId,
          creatorAccountId: anna.accountId,
        },
      });
    });

    await withUser(db, celina, async (tx) => {
      await tx.team.create({ data: { id: globexTeamId, organizationId: globex, key: "GLX", name: "Globex" } });
      await tx.workflowState.create({
        data: {
          id: globexStateId,
          organizationId: globex,
          teamId: globexTeamId,
          name: "Backlog",
          category: "BACKLOG",
          color: "gray",
          position: 0,
        },
      });
      await tx.label.create({
        data: { id: globexLabelId, organizationId: globex, teamId: globexTeamId, name: "G", color: "red" },
      });
      await tx.issue.create({
        data: {
          id: globexIssueId,
          organizationId: globex,
          teamId: globexTeamId,
          number: 1,
          title: "Zadanie Globex",
          stateId: globexStateId,
          creatorAccountId: celina.accountId,
        },
      });
    });

    // Jako firma Globex (organization_id = globex przechodzi RLS): próba wskazania ID z Acme musi polec na FK
    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.workflowState.create({
          data: {
            id: uuidv7(),
            organizationId: globex,
            teamId: acmeTeamAId,
            name: "Wstrzyknięty",
            category: "BACKLOG",
            color: "gray",
            position: 1,
          },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.label.create({
          data: { id: uuidv7(), organizationId: globex, teamId: acmeTeamAId, name: "Wstrzyknięta", color: "red" },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.issue.create({
          data: {
            id: uuidv7(),
            organizationId: globex,
            teamId: acmeTeamAId,
            number: 2,
            title: "Obcy zespół",
            stateId: acmeStateAId,
            creatorAccountId: celina.accountId,
          },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.issue.create({
          data: {
            id: uuidv7(),
            organizationId: globex,
            teamId: globexTeamId,
            number: 2,
            title: "Obcy status",
            stateId: acmeStateAId,
            creatorAccountId: celina.accountId,
          },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.issue.create({
          data: {
            id: uuidv7(),
            organizationId: globex,
            teamId: globexTeamId,
            number: 3,
            title: "Obcy rodzic",
            stateId: globexStateId,
            parentId: acmeIssueAId,
            creatorAccountId: celina.accountId,
          },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.issueLabel.create({
          data: { issueId: acmeIssueAId, labelId: globexLabelId, organizationId: globex, teamId: globexTeamId },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.issueLabel.create({
          data: { issueId: globexIssueId, labelId: acmeLabelAId, organizationId: globex, teamId: globexTeamId },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.issueRelation.create({
          data: {
            id: uuidv7(),
            organizationId: globex,
            issueId: globexIssueId,
            relatedIssueId: acmeIssueAId,
            type: "RELATED",
          },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, celina, (tx) =>
        tx.issueRelation.create({
          data: {
            id: uuidv7(),
            organizationId: globex,
            issueId: acmeIssueAId,
            relatedIssueId: globexIssueId,
            type: "BLOCKS",
          },
        }),
      ).catch((e) => e),
    );

    // W obrębie tej samej firmy (Acme): status, rodzic i etykieta z innego zespołu muszą polec na FK
    expectForeignKeyError(
      await withUser(db, anna, (tx) =>
        tx.issue.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            teamId: acmeTeamAId,
            number: 2,
            title: "Status innego zespołu",
            stateId: acmeStateBId,
            creatorAccountId: anna.accountId,
          },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, anna, (tx) =>
        tx.issue.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            teamId: acmeTeamAId,
            number: 3,
            title: "Rodzic innego zespołu",
            stateId: acmeStateAId,
            parentId: acmeIssueBId,
            creatorAccountId: anna.accountId,
          },
        }),
      ).catch((e) => e),
    );

    expectForeignKeyError(
      await withUser(db, anna, (tx) =>
        tx.issueLabel.create({
          data: { issueId: acmeIssueAId, labelId: acmeLabelBId, organizationId: acme, teamId: acmeTeamAId },
        }),
      ).catch((e) => e),
    );

    // Unikalny indeks pary RELATED blokuje odwrotny duplikat na poziomie bazy
    await withUser(db, anna, (tx) =>
      tx.issueRelation.create({
        data: {
          id: uuidv7(),
          organizationId: acme,
          issueId: acmeIssueAId,
          relatedIssueId: acmeIssueBId,
          type: "RELATED",
        },
      }),
    );
    const reverseRelatedErr = await withUser(db, anna, (tx) =>
      tx.issueRelation.create({
        data: {
          id: uuidv7(),
          organizationId: acme,
          issueId: acmeIssueBId,
          relatedIssueId: acmeIssueAId,
          type: "RELATED",
        },
      }),
    ).catch((e) => e);
    expect(reverseRelatedErr).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((reverseRelatedErr as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");

    // ── Tabele etapu 2a: RLS i złożone klucze obce (między firmami, między zespołami i między zadaniami) ──
    const acmeCommentAId = uuidv7();
    const acmeCommentBId = uuidv7();
    const acmeEventAId = uuidv7();
    const acmeInboxId = uuidv7();
    const acmeReactionId = uuidv7();
    const now = new Date();

    await withUser(db, anna, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "public"."issue_comments"
          ("id", "organization_id", "team_id", "issue_id", "author_account_id", "body", "created_at", "updated_at")
        VALUES
          (${acmeCommentAId}::uuid, ${acme}::uuid, ${acmeTeamAId}::uuid, ${acmeIssueAId}::uuid, ${anna.accountId}::uuid, 'Komentarz A', ${now}, ${now}),
          (${acmeCommentBId}::uuid, ${acme}::uuid, ${acmeTeamBId}::uuid, ${acmeIssueBId}::uuid, ${anna.accountId}::uuid, 'Komentarz B', ${now}, ${now})
      `;
      await tx.$executeRaw`
        INSERT INTO "public"."comment_mentions" ("comment_id", "account_id", "organization_id", "created_at")
        VALUES (${acmeCommentAId}::uuid, ${bartek.accountId}::uuid, ${acme}::uuid, ${now})
      `;
      await tx.$executeRaw`
        INSERT INTO "public"."comment_reactions" ("id", "organization_id", "comment_id", "account_id", "emoji", "created_at")
        VALUES (${acmeReactionId}::uuid, ${acme}::uuid, ${acmeCommentAId}::uuid, ${bartek.accountId}::uuid, '👍', ${now})
      `;
      await tx.$executeRaw`
        INSERT INTO "public"."issue_events" ("id", "organization_id", "team_id", "issue_id", "actor_account_id", "type", "before", "after", "created_at")
        VALUES (${acmeEventAId}::uuid, ${acme}::uuid, ${acmeTeamAId}::uuid, ${acmeIssueAId}::uuid, ${anna.accountId}::uuid, 'CREATED'::"public"."IssueEventType", NULL, '{"title":"Zadanie A"}'::jsonb, ${now})
      `;
      await tx.$executeRaw`
        INSERT INTO "public"."issue_subscribers" ("issue_id", "account_id", "organization_id", "created_at")
        VALUES (${acmeIssueAId}::uuid, ${bartek.accountId}::uuid, ${acme}::uuid, ${now})
      `;
      await tx.$executeRaw`
        INSERT INTO "public"."inbox_items" ("id", "organization_id", "recipient_account_id", "kind", "issue_id", "actor_account_id", "comment_id", "created_at")
        VALUES (${acmeInboxId}::uuid, ${acme}::uuid, ${bartek.accountId}::uuid, 'MENTIONED'::"public"."InboxItemKind", ${acmeIssueAId}::uuid, ${anna.accountId}::uuid, ${acmeCommentAId}::uuid, ${now})
      `;
    });

    // Celina (Globex) nie widzi żadnego wiersza etapu 2a z Acme, a zapytania bez withUser również zwracają 0
    const countCollabTables = async (runner: Pick<typeof db, "$queryRaw">) => {
      const [c, m, r, e, s, i] = await Promise.all([
        runner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "public"."issue_comments"`,
        runner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "public"."comment_mentions"`,
        runner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "public"."comment_reactions"`,
        runner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "public"."issue_events"`,
        runner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "public"."issue_subscribers"`,
        runner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "public"."inbox_items"`,
      ]);
      return {
        comments: c[0]!.n,
        mentions: m[0]!.n,
        reactions: r[0]!.n,
        events: e[0]!.n,
        subscribers: s[0]!.n,
        inbox: i[0]!.n,
      };
    };

    expect(await withUser(db, bartek, (tx) => countCollabTables(tx))).toEqual({
      comments: 2,
      mentions: 1,
      reactions: 1,
      events: 1,
      subscribers: 1,
      inbox: 1,
    });
    expect(await withUser(db, celina, (tx) => countCollabTables(tx))).toEqual({
      comments: 0,
      mentions: 0,
      reactions: 0,
      events: 0,
      subscribers: 0,
      inbox: 0,
    });
    expect(await countCollabTables(db)).toEqual({
      comments: 0,
      mentions: 0,
      reactions: 0,
      events: 0,
      subscribers: 0,
      inbox: 0,
    });

    // Zapis z cudzym organization_id odrzucony przez RLS WITH CHECK na wszystkich 6 nowych tabelach
    await expect(
      withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."issue_comments" ("id","organization_id","team_id","issue_id","author_account_id","body","created_at","updated_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${acmeTeamAId}::uuid, ${acmeIssueAId}::uuid, ${celina.accountId}::uuid, 'Obcy', ${now}, ${now})`,
      ),
    ).rejects.toThrow();
    await expect(
      withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."comment_mentions" ("comment_id","account_id","organization_id","created_at") VALUES (${acmeCommentAId}::uuid, ${celina.accountId}::uuid, ${acme}::uuid, ${now})`,
      ),
    ).rejects.toThrow();
    await expect(
      withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."comment_reactions" ("id","organization_id","comment_id","account_id","emoji","created_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${acmeCommentAId}::uuid, ${celina.accountId}::uuid, '🚀', ${now})`,
      ),
    ).rejects.toThrow();
    await expect(
      withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."issue_events" ("id","organization_id","team_id","issue_id","actor_account_id","type","created_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${acmeTeamAId}::uuid, ${acmeIssueAId}::uuid, ${celina.accountId}::uuid, 'DELETED'::"public"."IssueEventType", ${now})`,
      ),
    ).rejects.toThrow();
    await expect(
      withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."issue_subscribers" ("issue_id","account_id","organization_id","created_at") VALUES (${acmeIssueAId}::uuid, ${celina.accountId}::uuid, ${acme}::uuid, ${now})`,
      ),
    ).rejects.toThrow();
    await expect(
      withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."inbox_items" ("id","organization_id","recipient_account_id","kind","issue_id","actor_account_id","created_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${bartek.accountId}::uuid, 'ASSIGNED'::"public"."InboxItemKind", ${acmeIssueAId}::uuid, ${celina.accountId}::uuid, ${now})`,
      ),
    ).rejects.toThrow();

    // Złożone klucze obce między firmami (organization_id = globex przechodzi RLS, ale wskazuje rekord Acme)
    expectForeignKeyError(
      await withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."issue_comments" ("id","organization_id","team_id","issue_id","author_account_id","body","created_at","updated_at") VALUES (${uuidv7()}::uuid, ${globex}::uuid, ${globexTeamId}::uuid, ${acmeIssueAId}::uuid, ${celina.accountId}::uuid, 'Obcy komentarz', ${now}, ${now})`,
      ).catch((e) => e),
    );
    expectForeignKeyError(
      await withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."comment_mentions" ("comment_id","account_id","organization_id","created_at") VALUES (${acmeCommentAId}::uuid, ${celina.accountId}::uuid, ${globex}::uuid, ${now})`,
      ).catch((e) => e),
    );
    expectForeignKeyError(
      await withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."comment_reactions" ("id","organization_id","comment_id","account_id","emoji","created_at") VALUES (${uuidv7()}::uuid, ${globex}::uuid, ${acmeCommentAId}::uuid, ${celina.accountId}::uuid, '👍', ${now})`,
      ).catch((e) => e),
    );
    expectForeignKeyError(
      await withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."issue_events" ("id","organization_id","team_id","issue_id","actor_account_id","type","created_at") VALUES (${uuidv7()}::uuid, ${globex}::uuid, ${globexTeamId}::uuid, ${acmeIssueAId}::uuid, ${celina.accountId}::uuid, 'CREATED'::"public"."IssueEventType", ${now})`,
      ).catch((e) => e),
    );
    expectForeignKeyError(
      await withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."issue_subscribers" ("issue_id","account_id","organization_id","created_at") VALUES (${acmeIssueAId}::uuid, ${celina.accountId}::uuid, ${globex}::uuid, ${now})`,
      ).catch((e) => e),
    );
    expectForeignKeyError(
      await withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."inbox_items" ("id","organization_id","recipient_account_id","kind","issue_id","actor_account_id","created_at") VALUES (${uuidv7()}::uuid, ${globex}::uuid, ${celina.accountId}::uuid, 'ASSIGNED'::"public"."InboxItemKind", ${acmeIssueAId}::uuid, ${anna.accountId}::uuid, ${now})`,
      ).catch((e) => e),
    );
    expectForeignKeyError(
      await withUser(
        db,
        celina,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."inbox_items" ("id","organization_id","recipient_account_id","kind","issue_id","actor_account_id","comment_id","created_at") VALUES (${uuidv7()}::uuid, ${globex}::uuid, ${celina.accountId}::uuid, 'MENTIONED'::"public"."InboxItemKind", ${globexIssueId}::uuid, ${anna.accountId}::uuid, ${acmeCommentAId}::uuid, ${now})`,
      ).catch((e) => e),
    );

    // Złożone klucze obce między zespołami i zadaniami w tej samej firmie (Acme)
    expectForeignKeyError(
      await withUser(
        db,
        anna,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."issue_comments" ("id","organization_id","team_id","issue_id","author_account_id","body","created_at","updated_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${acmeTeamAId}::uuid, ${acmeIssueBId}::uuid, ${anna.accountId}::uuid, 'Zły zespół', ${now}, ${now})`,
      ).catch((e) => e),
    );
    expectForeignKeyError(
      await withUser(
        db,
        anna,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."issue_events" ("id","organization_id","team_id","issue_id","actor_account_id","type","created_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${acmeTeamAId}::uuid, ${acmeIssueBId}::uuid, ${anna.accountId}::uuid, 'CREATED'::"public"."IssueEventType", ${now})`,
      ).catch((e) => e),
    );
    expectForeignKeyError(
      await withUser(
        db,
        anna,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."inbox_items" ("id","organization_id","recipient_account_id","kind","issue_id","actor_account_id","comment_id","created_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${bartek.accountId}::uuid, 'COMMENTED'::"public"."InboxItemKind", ${acmeIssueAId}::uuid, ${anna.accountId}::uuid, ${acmeCommentBId}::uuid, ${now})`,
      ).catch((e) => e),
    );

    // Ograniczenia CHECK: niedozwolone emoji oraz zakaz wpisu skrzynki dla sprawcy
    await expect(
      withUser(
        db,
        anna,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."comment_reactions" ("id","organization_id","comment_id","account_id","emoji","created_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${acmeCommentAId}::uuid, ${anna.accountId}::uuid, '🔥', ${now})`,
      ),
    ).rejects.toThrow();
    await expect(
      withUser(
        db,
        anna,
        (tx) =>
          tx.$executeRaw`INSERT INTO "public"."inbox_items" ("id","organization_id","recipient_account_id","kind","issue_id","actor_account_id","created_at") VALUES (${uuidv7()}::uuid, ${acme}::uuid, ${anna.accountId}::uuid, 'ASSIGNED'::"public"."InboxItemKind", ${acmeIssueAId}::uuid, ${anna.accountId}::uuid, ${now})`,
      ),
    ).rejects.toThrow();
  });

  it("atomowo przydziela kolejne numery zadań przy równoległym tworzeniu bez kolizji i luk", async () => {
    const parallelTeamId = uuidv7();
    const parallelStateId = uuidv7();

    await withUser(db, anna, async (tx) => {
      await tx.team.create({
        data: { id: parallelTeamId, organizationId: acme, key: "PAR", name: "Równoległy", nextIssueNumber: 1 },
      });
      await tx.workflowState.create({
        data: {
          id: parallelStateId,
          organizationId: acme,
          teamId: parallelTeamId,
          name: "Backlog",
          category: "BACKLOG",
          color: "gray",
          position: 0,
        },
      });
    });

    const createOne = (index: number) =>
      withUser(db, anna, async (tx) => {
        const rows = await tx.$queryRaw<{ number: number }[]>`
          UPDATE "public"."teams"
          SET "next_issue_number" = "next_issue_number" + 1,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${parallelTeamId}::uuid
            AND "archived_at" IS NULL
          RETURNING ("next_issue_number" - 1) AS "number"
        `;
        const number = rows[0]!.number;
        await tx.issue.create({
          data: {
            id: uuidv7(),
            organizationId: acme,
            teamId: parallelTeamId,
            number,
            title: `Zadanie równoległe ${index}`,
            stateId: parallelStateId,
            creatorAccountId: anna.accountId,
            sortOrder: number * 1000,
          },
        });
        return number;
      });

    const numbers = await Promise.all(Array.from({ length: 12 }, (_, i) => createOne(i)));
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // Wycofana transakcja nie zostawia luki w numeracji
    await expect(
      withUser(db, anna, async (tx) => {
        await tx.$queryRaw`
          UPDATE "public"."teams"
          SET "next_issue_number" = "next_issue_number" + 1,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${parallelTeamId}::uuid
          RETURNING ("next_issue_number" - 1) AS "number"
        `;
        throw new Error("celowe wycofanie transakcji");
      }),
    ).rejects.toThrow(/celowe wycofanie/);

    const nextNumber = await createOne(13);
    expect(nextNumber).toBe(13);

    const team = await withUser(db, anna, (tx) => tx.team.findUnique({ where: { id: parallelTeamId } }));
    expect(team?.nextIssueNumber).toBe(14);
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
