/**
 * Testy separacji firm na bazie PostgreSQL (ADR-0037) za pomocą `checkTenantIsolation`
 * z `@monorise-team/testing` dla tabel domenowych etapu 1a (`teams`, `workflow_states`, `labels`,
 * `issues`, `issue_labels`, `issue_relations`) oraz równoległej numeracji przez `prismaIssuesStore`.
 *
 * Wymaga uruchomionej bazy testowej (`pnpm db:up && pnpm db:migrate`, rola `kivo_tasks_app` z RLS).
 */
import { checkTenantIsolation, formatViolations } from "@monorise-team/testing";
import { uuidv7, withUser, type Actor } from "@kivotasks/db";
import { ApiFailure } from "@/server/api";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { prismaIssuesStore } from "@/server/issues-store-prisma";

afterAll(async () => {
  await getDb().$disconnect();
});

async function cleanupTenant(actor: Actor): Promise<void> {
  await withUser(getDb(), actor, async (tx) => {
    await tx.$executeRaw`DELETE FROM "public"."issue_attachments"`;
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

describe("Separacja firm w bazie danych (checkTenantIsolation, ADR-0037)", () => {
  it("withUser: firma B nigdy nie odczytuje zespołów, statusów, etykiet, zadań ani relacji firmy A", async () => {
    const db = getDb();
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
        const team = await prismaIssuesStore.createTeamWithDefaultStates(actor, {
          id: uuidv7(),
          key: "MAG",
          name: "Magazyn",
        });
        const label = await prismaIssuesStore.createLabel(actor, {
          teamId: team.id,
          name: "Pilne",
          color: "red",
        });
        const issue1 = await prismaIssuesStore.createIssue(actor, {
          teamId: team.id,
          title: "Zadanie 1 firmy A",
          description: "Opis poufny",
          priority: 1,
          assigneeAccountId: null,
          creatorAccountId: actor.accountId,
          labelIds: [label.id],
          dueDate: "2026-12-01",
          estimate: 3,
          parentId: null,
        });
        const issue2 = await prismaIssuesStore.createIssue(actor, {
          teamId: team.id,
          title: "Zadanie 2 firmy A",
          description: null,
          priority: 2,
          assigneeAccountId: null,
          creatorAccountId: actor.accountId,
          labelIds: [],
          dueDate: null,
          estimate: null,
          parentId: issue1.id,
        });
        await prismaIssuesStore.createIssueRelation(actor, {
          viewerIssueId: issue1.id,
          storedIssueId: issue1.id,
          storedRelatedIssueId: issue2.id,
          storedType: "BLOCKS",
        });
        const colleagueId = uuidv7();
        const comment = await prismaIssuesStore.createIssueComment(actor, {
          issueId: issue1.id,
          teamId: team.id,
          body: `Współpraca @[Kolega](${colleagueId})`,
          mentionedAccountIds: [colleagueId],
        });
        await prismaIssuesStore.addCommentReaction(actor, {
          issueId: issue1.id,
          commentId: comment.id,
          emoji: "👍",
        });
        const attachmentId = uuidv7();
        await prismaIssuesStore.createIssueAttachment(actor, {
          id: attachmentId,
          issueId: issue1.id,
          teamId: team.id,
          fileName: "zrzut.png",
          contentType: "image/png",
          sizeBytes: 512,
          sha256: "a".repeat(64),
          storageKey: `organizations/${tenantId}/issues/${issue1.id}/attachments/${attachmentId}`,
          quotaBytes: 1_000_000,
        });
      },
      readAsTenant: async (tenantId) => {
        const actor = actorFor(tenantId);
        const allRows = await withUser(db, actor, async (tx) => [
          ...(await tx.team.findMany({ select: { id: true, organizationId: true } })),
          ...(await tx.workflowState.findMany({ select: { id: true, organizationId: true } })),
          ...(await tx.label.findMany({ select: { id: true, organizationId: true } })),
          ...(await tx.issue.findMany({ select: { id: true, organizationId: true } })),
          ...(await tx.issueLabel.findMany({ select: { issueId: true, labelId: true, organizationId: true } })),
          ...(await tx.issueRelation.findMany({ select: { id: true, organizationId: true } })),
          ...(await tx.$queryRaw<{ id: string; organizationId: string }[]>`
            SELECT "id"::text AS "id", "organization_id"::text AS "organizationId" FROM "public"."issue_comments"
          `),
          ...(await tx.$queryRaw<{ commentId: string; accountId: string; organizationId: string }[]>`
            SELECT "comment_id"::text AS "commentId", "account_id"::text AS "accountId", "organization_id"::text AS "organizationId" FROM "public"."comment_mentions"
          `),
          ...(await tx.$queryRaw<{ id: string; organizationId: string }[]>`
            SELECT "id"::text AS "id", "organization_id"::text AS "organizationId" FROM "public"."comment_reactions"
          `),
          ...(await tx.$queryRaw<{ id: string; organizationId: string }[]>`
            SELECT "id"::text AS "id", "organization_id"::text AS "organizationId" FROM "public"."issue_events"
          `),
          ...(await tx.$queryRaw<{ issueId: string; accountId: string; organizationId: string }[]>`
            SELECT "issue_id"::text AS "issueId", "account_id"::text AS "accountId", "organization_id"::text AS "organizationId" FROM "public"."issue_subscribers"
          `),
          ...(await tx.$queryRaw<{ id: string; organizationId: string }[]>`
            SELECT "id"::text AS "id", "organization_id"::text AS "organizationId" FROM "public"."inbox_items"
          `),
          ...(await tx.$queryRaw<{ id: string; organizationId: string }[]>`
            SELECT "id"::text AS "id", "organization_id"::text AS "organizationId" FROM "public"."issue_attachments"
          `),
        ]);
        return allRows;
      },
      cleanup: async ({ tenantAId, tenantBId }) => {
        for (const tenantId of [tenantAId, tenantBId]) {
          const actor = actorsByTenant.get(tenantId);
          if (actor) {
            await cleanupTenant(actor);
          }
        }
      },
    });

    expect(result.passed, formatViolations(result.violations)).toBe(true);
  });

  it("prismaIssuesStore.createIssue przydziela unikalne kolejne numery bez luk przy równoległym tworzeniu", async () => {
    const actor: Actor = { organizationId: uuidv7(), accountId: uuidv7() };
    const teamId = uuidv7();
    try {
      await prismaIssuesStore.createTeamWithDefaultStates(actor, {
        id: teamId,
        key: "MAG",
        name: "Magazyn",
      });

      const created = await Promise.all(
        Array.from({ length: 10 }, (_, idx) =>
          prismaIssuesStore.createIssue(actor, {
            teamId,
            title: `Zadanie równoległe ${idx + 1}`,
            description: null,
            priority: 2,
            assigneeAccountId: null,
            creatorAccountId: actor.accountId,
            labelIds: [],
            dueDate: null,
            estimate: null,
            parentId: null,
          }),
        ),
      );

      const numbers = created.map((item) => item.number).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const search = await prismaIssuesStore.searchIssues(actor, {
        readableTeamIds: "ALL",
        identifier: { key: "MAG", number: 5 },
        tsQuery: "równoległe:*",
        limit: 20,
      });
      expect(search[0]?.identifier).toBe("MAG-5");
    } finally {
      await cleanupTenant(actor);
    }
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectApiFailure(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiFailure);
  expect((error as ApiFailure).status).toBe(status);
}

describe("Blokady przy archiwizacji statusu (wyścig z przypisaniem zadania)", () => {
  async function teamWithStartedState(actor: Actor): Promise<{ teamId: string; stateId: string }> {
    const teamId = uuidv7();
    await prismaIssuesStore.createTeamWithDefaultStates(actor, { id: teamId, key: "MAG", name: "Magazyn" });
    const states = await prismaIssuesStore.listWorkflowStates(actor, teamId);
    const started = states.find((state) => state.category === "STARTED");
    if (!started) throw new Error("Brak statusu STARTED");
    return { teamId, stateId: started.id };
  }

  it("archiwizacja czeka na transakcję, która właśnie przypisuje status, i wtedy odmawia (409)", async () => {
    const actor: Actor = { organizationId: uuidv7(), accountId: uuidv7() };
    try {
      const { teamId, stateId } = await teamWithStartedState(actor);
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => (markLocked = resolve));

      // Transakcja A trzyma status FOR SHARE (jak createIssue) i dopiero po chwili zapisuje zadanie
      const assigning = withUser(getDb(), actor, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "public"."workflow_states" WHERE "id" = ${stateId}::uuid FOR SHARE`;
        markLocked();
        await sleep(300);
        await tx.issue.create({
          data: {
            id: uuidv7(),
            organizationId: actor.organizationId,
            teamId,
            number: 999,
            title: "Zadanie w trakcie zapisu",
            stateId,
            creatorAccountId: actor.accountId,
          },
        });
      });

      await locked;
      await expectApiFailure(prismaIssuesStore.deleteWorkflowState(actor, teamId, stateId), 409);
      await assigning;

      const states = await prismaIssuesStore.listWorkflowStates(actor, teamId);
      expect(states.some((state) => state.id === stateId)).toBe(true);
    } finally {
      await cleanupTenant(actor);
    }
  });

  it("nowe zadanie czeka na trwającą archiwizację statusu i wtedy go odrzuca (422)", async () => {
    const actor: Actor = { organizationId: uuidv7(), accountId: uuidv7() };
    try {
      const { teamId, stateId } = await teamWithStartedState(actor);
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => (markLocked = resolve));

      // Transakcja B archiwizuje status (jak deleteWorkflowState) i zatwierdza po chwili
      const archiving = withUser(getDb(), actor, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "public"."workflow_states" WHERE "id" = ${stateId}::uuid FOR UPDATE`;
        markLocked();
        await sleep(300);
        await tx.workflowState.update({ where: { id: stateId }, data: { archivedAt: new Date() } });
      });

      await locked;
      await expectApiFailure(
        prismaIssuesStore.createIssue(actor, {
          teamId,
          title: "Zadanie do zarchiwizowanego statusu",
          description: null,
          stateId,
          priority: 0,
          assigneeAccountId: null,
          creatorAccountId: actor.accountId,
          labelIds: [],
          dueDate: null,
          estimate: null,
          parentId: null,
        }),
        422,
      );
      await archiving;
    } finally {
      await cleanupTenant(actor);
    }
  });
});
