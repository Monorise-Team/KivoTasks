/**
 * Testy separacji firm na bazie PostgreSQL (ADR-0037) za pomocą `checkTenantIsolation`
 * z `@monorise-team/testing` dla tabel domenowych etapu 1a (`teams`, `workflow_states`, `labels`,
 * `issues`, `issue_labels`, `issue_relations`) oraz równoległej numeracji przez `prismaIssuesStore`.
 *
 * Wymaga uruchomionej bazy testowej (`pnpm db:up && pnpm db:migrate`, rola `kivo_tasks_app` z RLS).
 */
import { checkTenantIsolation, formatViolations } from "@monorise-team/testing";
import { uuidv7, withUser, type Actor } from "@kivotasks/db";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { prismaIssuesStore } from "@/server/issues-store-prisma";

afterAll(async () => {
  await getDb().$disconnect();
});

async function cleanupTenant(actor: Actor): Promise<void> {
  await withUser(getDb(), actor, async (tx) => {
    await tx.issueRelation.deleteMany({});
    await tx.issueLabel.deleteMany({});
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
