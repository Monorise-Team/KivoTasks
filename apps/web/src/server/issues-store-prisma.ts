import "server-only";
import {
  DEFAULT_WORKFLOW_STATES,
  type ColorToken,
  type IssueDetail,
  type IssueListItem,
  type IssueReference,
  type IssueRelationView,
  type IssueSort,
  type IssueStateSummary,
  type Label,
  type PaginatedResult,
  type Team,
  type UpdateLabelInput,
  type UpdateWorkflowStateInput,
  type WorkflowState,
  type WorkflowStateCategory,
} from "@kivotasks/contracts";
import { Prisma, uuidv7, withUser, type Tx } from "@kivotasks/db";
import { ApiFailure } from "./api";
import { getDb } from "./db";
import {
  buildIssueCursorPayload,
  computeStateTimestamps,
  encodeIssueCursor,
  formatDateOnly,
  formatIssueIdentifier,
  parseDateOnly,
  toIssueRelationView,
  wouldCreateParentCycle,
  type IssueCursorPayload,
} from "./issue-helpers";
import type {
  CreateIssueStoreInput,
  IssueLocation,
  IssueLookup,
  IssueRelationRecordInfo,
  IssuesStore,
  ListIssuesStoreParams,
  SearchIssuesStoreParams,
  UpdateIssueStoreInput,
} from "./issues-store";
import type { TeamFilterScope } from "./permissions";

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function teamAllowed(scope: TeamFilterScope, teamId: string): boolean {
  return scope === "ALL" || scope.includes(teamId);
}

function serializeTeam(row: {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  nextIssueNumber: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}): Team {
  return {
    id: row.id,
    organizationId: row.organizationId,
    key: row.key,
    name: row.name,
    nextIssueNumber: row.nextIssueNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

function serializeWorkflowState(row: {
  id: string;
  organizationId: string;
  teamId: string;
  name: string;
  category: WorkflowStateCategory;
  color: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}): WorkflowState {
  return {
    id: row.id,
    organizationId: row.organizationId,
    teamId: row.teamId,
    name: row.name,
    category: row.category,
    color: row.color as ColorToken,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeStateSummary(row: {
  id: string;
  name: string;
  category: WorkflowStateCategory;
  color: string;
  position: number;
}): IssueStateSummary {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    color: row.color as ColorToken,
    position: row.position,
  };
}

function serializeLabel(row: {
  id: string;
  organizationId: string;
  teamId: string;
  name: string;
  color: string;
  createdAt: Date;
}): Label {
  return {
    id: row.id,
    organizationId: row.organizationId,
    teamId: row.teamId,
    name: row.name,
    color: row.color as ColorToken,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeIssueReference(row: {
  id: string;
  teamId: string;
  number: number;
  title: string;
  priority: number;
  assigneeAccountId: string | null;
  team: { key: string };
  state: { id: string; name: string; category: WorkflowStateCategory; color: string; position: number };
}): IssueReference {
  return {
    id: row.id,
    teamId: row.teamId,
    identifier: formatIssueIdentifier(row.team.key, row.number),
    number: row.number,
    title: row.title,
    priority: row.priority,
    state: serializeStateSummary(row.state),
    assigneeAccountId: row.assigneeAccountId,
  };
}

const ISSUE_LIST_INCLUDE = {
  team: { select: { key: true } },
  state: { select: { id: true, name: true, category: true, color: true, position: true } },
  issueLabels: {
    where: { label: { archivedAt: null } },
    include: { label: { select: { id: true, name: true, color: true } } },
    orderBy: { label: { name: "asc" as const } },
  },
} as const;

const ISSUE_REF_SELECT = {
  id: true,
  teamId: true,
  number: true,
  title: true,
  priority: true,
  assigneeAccountId: true,
  deletedAt: true,
  team: { select: { key: true } },
  state: { select: { id: true, name: true, category: true, color: true, position: true } },
} as const;

type HydratedListRow = Prisma.IssueGetPayload<{ include: typeof ISSUE_LIST_INCLUDE }>;

function serializeIssueListItem(row: HydratedListRow): IssueListItem {
  return {
    id: row.id,
    organizationId: row.organizationId,
    teamId: row.teamId,
    identifier: formatIssueIdentifier(row.team.key, row.number),
    number: row.number,
    title: row.title,
    stateId: row.stateId,
    state: serializeStateSummary(row.state),
    priority: row.priority,
    assigneeAccountId: row.assigneeAccountId,
    creatorAccountId: row.creatorAccountId,
    dueDate: formatDateOnly(row.dueDate),
    estimate: row.estimate,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    labels: row.issueLabels.map((item) => ({
      id: item.label.id,
      name: item.label.name,
      color: item.label.color as ColorToken,
    })),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    canceledAt: row.canceledAt ? row.canceledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function hydrateIssueDetail(
  tx: Tx,
  issueId: string,
  readableTeamIds: TeamFilterScope,
): Promise<IssueDetail | null> {
  const row = await tx.issue.findFirst({
    where: { id: issueId, deletedAt: null, team: { archivedAt: null } },
    include: {
      ...ISSUE_LIST_INCLUDE,
      parent: { select: ISSUE_REF_SELECT },
      children: {
        where: { deletedAt: null },
        select: ISSUE_REF_SELECT,
        orderBy: [{ sortOrder: "asc" }, { number: "asc" }],
      },
      outgoingRelations: {
        include: { relatedIssue: { select: ISSUE_REF_SELECT } },
        orderBy: { createdAt: "asc" },
      },
      incomingRelations: {
        include: { issue: { select: ISSUE_REF_SELECT } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!row || !teamAllowed(readableTeamIds, row.teamId)) {
    return null;
  }

  const relations: IssueRelationView[] = [];

  for (const rel of row.outgoingRelations) {
    if (rel.relatedIssue.deletedAt !== null) continue;
    if (!teamAllowed(readableTeamIds, rel.relatedIssue.teamId)) continue;
    relations.push(toIssueRelationView(row.id, rel, serializeIssueReference(rel.relatedIssue)));
  }

  for (const rel of row.incomingRelations) {
    if (rel.issue.deletedAt !== null) continue;
    if (!teamAllowed(readableTeamIds, rel.issue.teamId)) continue;
    relations.push(toIssueRelationView(row.id, rel, serializeIssueReference(rel.issue)));
  }

  relations.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id)));

  const base = serializeIssueListItem(row);
  return {
    ...base,
    description: row.description,
    parent: row.parent && row.parent.deletedAt === null ? serializeIssueReference(row.parent) : null,
    children: row.children.map((child) => serializeIssueReference(child)),
    relations,
  };
}

async function hydrateIssuesInOrder(tx: Tx, orderedIds: readonly string[]): Promise<IssueListItem[]> {
  if (orderedIds.length === 0) return [];
  const rows = await tx.issue.findMany({
    where: { id: { in: [...orderedIds] }, deletedAt: null },
    include: ISSUE_LIST_INCLUDE,
  });
  const byId = new Map<string, IssueListItem>();
  for (const row of rows) {
    byId.set(row.id, serializeIssueListItem(row));
  }
  const ordered: IssueListItem[] = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (item) ordered.push(item);
  }
  return ordered;
}

function buildCursorCondition(cursor: IssueCursorPayload): Prisma.Sql {
  switch (cursor.s) {
    case "updated": {
      const ts = new Date(cursor.u);
      return Prisma.sql`(i."updated_at" < ${ts} OR (i."updated_at" = ${ts} AND i."id" < ${cursor.id}::uuid))`;
    }
    case "created": {
      const ts = new Date(cursor.c);
      return Prisma.sql`(i."created_at" < ${ts} OR (i."created_at" = ${ts} AND i."id" < ${cursor.id}::uuid))`;
    }
    case "priority": {
      const ts = new Date(cursor.u);
      const rankExpr = Prisma.sql`CASE WHEN i."priority" = 0 THEN 5 ELSE i."priority" END`;
      return Prisma.sql`(
        (${rankExpr}) > ${cursor.p}
        OR ((${rankExpr}) = ${cursor.p} AND i."updated_at" < ${ts})
        OR ((${rankExpr}) = ${cursor.p} AND i."updated_at" = ${ts} AND i."id" < ${cursor.id}::uuid)
      )`;
    }
    case "dueDate": {
      const ts = new Date(cursor.u);
      if (cursor.d === null) {
        return Prisma.sql`(
          i."due_date" IS NULL
          AND (i."updated_at" < ${ts} OR (i."updated_at" = ${ts} AND i."id" < ${cursor.id}::uuid))
        )`;
      }
      const dueDate = parseDateOnly(cursor.d);
      return Prisma.sql`(
        i."due_date" IS NULL
        OR i."due_date" > ${dueDate}::date
        OR (i."due_date" = ${dueDate}::date AND i."updated_at" < ${ts})
        OR (i."due_date" = ${dueDate}::date AND i."updated_at" = ${ts} AND i."id" < ${cursor.id}::uuid)
      )`;
    }
    case "manual":
      return Prisma.sql`(i."sort_order" > ${cursor.o} OR (i."sort_order" = ${cursor.o} AND i."id" > ${cursor.id}::uuid))`;
  }
}

function buildOrderByClause(sort: IssueSort): Prisma.Sql {
  switch (sort) {
    case "updated":
      return Prisma.sql`i."updated_at" DESC, i."id" DESC`;
    case "created":
      return Prisma.sql`i."created_at" DESC, i."id" DESC`;
    case "priority":
      return Prisma.sql`CASE WHEN i."priority" = 0 THEN 5 ELSE i."priority" END ASC, i."updated_at" DESC, i."id" DESC`;
    case "dueDate":
      return Prisma.sql`i."due_date" ASC NULLS LAST, i."updated_at" DESC, i."id" DESC`;
    case "manual":
      return Prisma.sql`i."sort_order" ASC, i."id" ASC`;
  }
}

async function lockTeamStates(tx: Tx, teamId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('team_states:' || ${teamId}::uuid::text, 0))`;
}

async function lockTeamIssueHierarchy(tx: Tx, teamId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('issue_hierarchy:' || ${teamId}::uuid::text, 0))`;
}

/*
 * Blokady wierszy przeciw wyścigom z archiwizacją: kto przypisuje zadaniu status albo etykietę, trzyma wiersz
 * FOR SHARE, a archiwizacja bierze FOR UPDATE i dopiero potem liczy zadania. Klucz obcy bierze tylko
 * FOR KEY SHARE, które nie koliduje ze zmianą `archived_at`, więc sam nie wystarcza.
 */
type LockedState = { id: string; category: WorkflowStateCategory };

async function lockActiveState(
  tx: Tx,
  teamId: string,
  stateId: string,
  mode: "SHARE" | "UPDATE",
): Promise<LockedState | null> {
  const lock = mode === "SHARE" ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`;
  const rows = await tx.$queryRaw<LockedState[]>`
    SELECT "id"::text AS "id", "category"::text AS "category"
    FROM "public"."workflow_states"
    WHERE "id" = ${stateId}::uuid AND "team_id" = ${teamId}::uuid AND "archived_at" IS NULL
    ${lock}
  `;
  return rows[0] ?? null;
}

/** Domyślny status nowego zadania: pierwszy Backlog, a bez niego pierwszy „Do zrobienia” (FOR SHARE). */
async function lockDefaultState(tx: Tx, teamId: string): Promise<LockedState | null> {
  // Gdy wybrany wiersz zarchiwizowano w trakcie czekania na blokadę, zapytanie zwraca pusto: próbujemy raz jeszcze
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await tx.$queryRaw<LockedState[]>`
      SELECT "id"::text AS "id", "category"::text AS "category"
      FROM "public"."workflow_states"
      WHERE "team_id" = ${teamId}::uuid
        AND "archived_at" IS NULL
        AND "category" IN ('BACKLOG'::"public"."WorkflowStateCategory", 'UNSTARTED'::"public"."WorkflowStateCategory")
      ORDER BY CASE WHEN "category" = 'BACKLOG'::"public"."WorkflowStateCategory" THEN 0 ELSE 1 END,
               "position" ASC, "created_at" ASC
      LIMIT 1
      FOR SHARE
    `;
    if (rows[0]) return rows[0];
  }
  return null;
}

/** Blokuje FOR SHARE aktywne etykiety zespołu i zwraca, ile z podanych istnieje. */
async function lockActiveLabels(tx: Tx, teamId: string, labelIds: readonly string[]): Promise<number> {
  if (labelIds.length === 0) return 0;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS "id"
    FROM "public"."labels"
    WHERE "id" = ANY(${[...labelIds]}::uuid[]) AND "team_id" = ${teamId}::uuid AND "archived_at" IS NULL
    FOR SHARE
  `;
  return rows.length;
}

/** Blokuje FOR SHARE aktywne zadanie w aktywnym zespole; `null`, gdy go nie ma albo usunięto je w międzyczasie. */
async function lockActiveIssue(tx: Tx, issueId: string): Promise<{ id: string; teamId: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; teamId: string }[]>`
    SELECT i."id"::text AS "id", i."team_id"::text AS "teamId"
    FROM "public"."issues" i
    JOIN "public"."teams" t ON t."id" = i."team_id"
    WHERE i."id" = ${issueId}::uuid AND i."deleted_at" IS NULL AND t."archived_at" IS NULL
    FOR SHARE OF i
  `;
  return rows[0] ?? null;
}

const LABELS_OUTSIDE_TEAM = new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
  { field: "labelIds", message: "Wszystkie etykiety muszą należeć do tego samego zespołu" },
]);

export const prismaIssuesStore: IssuesStore = {
  async listTeams(actor, scope) {
    if (scope !== "ALL" && scope.length === 0) return [];
    const rows = await withUser(getDb(), actor, (tx) =>
      tx.team.findMany({
        where: {
          archivedAt: null,
          ...(scope !== "ALL" ? { id: { in: scope } } : {}),
        },
        orderBy: [{ name: "asc" }, { key: "asc" }],
      }),
    );
    return rows.map(serializeTeam);
  },

  async findTeamById(actor, teamId) {
    const row = await withUser(getDb(), actor, (tx) => tx.team.findFirst({ where: { id: teamId, archivedAt: null } }));
    return row ? serializeTeam(row) : null;
  },

  async listExistingTeamIds(actor) {
    const rows = await withUser(getDb(), actor, (tx) => tx.team.findMany({ select: { id: true } }));
    return rows.map((row) => row.id);
  },

  async createTeamWithDefaultStates(actor, input) {
    try {
      const created = await withUser(getDb(), actor, async (tx) => {
        const byId = await tx.team.findUnique({ where: { id: input.id }, select: { id: true } });
        if (byId) {
          throw new ApiFailure(409, "CONFLICT", "Ta jednostka organizacyjna jest już zespołem w KivoTasks");
        }
        const byKey = await tx.team.findUnique({
          where: { organizationId_key: { organizationId: actor.organizationId, key: input.key } },
          select: { id: true },
        });
        if (byKey) {
          throw new ApiFailure(409, "CONFLICT", "Zespół o tym kluczu już istnieje w firmie");
        }
        const team = await tx.team.create({
          data: {
            id: input.id,
            organizationId: actor.organizationId,
            key: input.key,
            name: input.name,
            nextIssueNumber: 1,
          },
        });
        await tx.workflowState.createMany({
          data: DEFAULT_WORKFLOW_STATES.map((state) => ({
            id: uuidv7(),
            organizationId: actor.organizationId,
            teamId: team.id,
            name: state.name,
            category: state.category,
            color: state.color,
            position: state.position,
          })),
        });
        return team;
      });
      return serializeTeam(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiFailure(409, "CONFLICT", "Zespół lub jego klucz już istnieje w firmie");
      }
      throw error;
    }
  },

  async updateTeamKey(actor, teamId, key) {
    try {
      const updated = await withUser(getDb(), actor, async (tx) => {
        const existing = await tx.team.findFirst({ where: { id: teamId, archivedAt: null } });
        if (!existing) return null;
        if (existing.key !== key) {
          const duplicate = await tx.team.findUnique({
            where: { organizationId_key: { organizationId: actor.organizationId, key } },
            select: { id: true },
          });
          if (duplicate) {
            throw new ApiFailure(409, "CONFLICT", "Zespół o tym kluczu już istnieje w firmie");
          }
        }
        return tx.team.update({
          where: { id: teamId },
          data: { key },
        });
      });
      return updated ? serializeTeam(updated) : null;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiFailure(409, "CONFLICT", "Zespół o tym kluczu już istnieje w firmie");
      }
      throw error;
    }
  },

  async updateTeamNames(actor, updates) {
    if (updates.length === 0) return;
    await withUser(getDb(), actor, async (tx) => {
      for (const update of updates) {
        await tx.team.updateMany({
          where: { id: update.id, archivedAt: null },
          data: { name: update.name },
        });
      }
    });
  },

  async listWorkflowStates(actor, teamId) {
    const rows = await withUser(getDb(), actor, (tx) =>
      tx.workflowState.findMany({
        where: { teamId, archivedAt: null },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      }),
    );
    return rows.map(serializeWorkflowState);
  },

  async createWorkflowState(actor, input) {
    const created = await withUser(getDb(), actor, async (tx) => {
      await lockTeamStates(tx, input.teamId);
      let position = input.position;
      if (position === undefined) {
        const agg = await tx.workflowState.aggregate({
          where: { teamId: input.teamId, archivedAt: null },
          _max: { position: true },
        });
        position = (agg._max.position ?? -1) + 1;
      }
      return tx.workflowState.create({
        data: {
          id: uuidv7(),
          organizationId: actor.organizationId,
          teamId: input.teamId,
          name: input.name,
          category: input.category,
          color: input.color,
          position,
        },
      });
    });
    return serializeWorkflowState(created);
  },

  async updateWorkflowState(actor, teamId, stateId, input: UpdateWorkflowStateInput) {
    const updated = await withUser(getDb(), actor, async (tx) => {
      await lockTeamStates(tx, teamId);
      const existing = await tx.workflowState.findFirst({
        where: { id: stateId, teamId, archivedAt: null },
      });
      if (!existing) return null;

      const leavingInitial =
        (existing.category === "BACKLOG" || existing.category === "UNSTARTED") &&
        input.category !== undefined &&
        input.category !== "BACKLOG" &&
        input.category !== "UNSTARTED";

      if (leavingInitial) {
        const remainingInitial = await tx.workflowState.count({
          where: {
            teamId,
            archivedAt: null,
            id: { not: stateId },
            category: { in: ["BACKLOG", "UNSTARTED"] },
          },
        });
        if (remainingInitial === 0) {
          throw new ApiFailure(
            409,
            "CONFLICT",
            "Zespół musi zachować co najmniej jeden status w kategorii Backlog lub Do zrobienia",
          );
        }
      }

      return tx.workflowState.update({
        where: { id: stateId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        },
      });
    });
    return updated ? serializeWorkflowState(updated) : null;
  },

  async deleteWorkflowState(actor, teamId, stateId) {
    return withUser(getDb(), actor, async (tx) => {
      await lockTeamStates(tx, teamId);
      // FOR UPDATE czeka na transakcje, które właśnie przypisują ten status, więc liczenie poniżej je widzi
      const existing = await lockActiveState(tx, teamId, stateId, "UPDATE");
      if (!existing) return false;

      const activeIssuesCount = await tx.issue.count({
        where: { teamId, stateId, deletedAt: null },
      });
      if (activeIssuesCount > 0) {
        throw new ApiFailure(409, "CONFLICT", "Nie można usunąć statusu używanego przez aktywne zadania");
      }

      if (existing.category === "BACKLOG" || existing.category === "UNSTARTED") {
        const remainingInitial = await tx.workflowState.count({
          where: {
            teamId,
            archivedAt: null,
            id: { not: stateId },
            category: { in: ["BACKLOG", "UNSTARTED"] },
          },
        });
        if (remainingInitial === 0) {
          throw new ApiFailure(
            409,
            "CONFLICT",
            "Zespół musi zachować co najmniej jeden status w kategorii Backlog lub Do zrobienia",
          );
        }
      }

      await tx.workflowState.update({
        where: { id: stateId },
        data: { archivedAt: new Date() },
      });
      return true;
    });
  },

  async listLabels(actor, teamId) {
    const rows = await withUser(getDb(), actor, (tx) =>
      tx.label.findMany({
        where: { teamId, archivedAt: null },
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      }),
    );
    return rows.map(serializeLabel);
  },

  async createLabel(actor, input) {
    try {
      const created = await withUser(getDb(), actor, async (tx) => {
        const duplicate = await tx.label.findFirst({
          where: {
            teamId: input.teamId,
            archivedAt: null,
            name: { equals: input.name, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new ApiFailure(409, "CONFLICT", "Etykieta o tej nazwie już istnieje w zespole");
        }
        return tx.label.create({
          data: {
            id: uuidv7(),
            organizationId: actor.organizationId,
            teamId: input.teamId,
            name: input.name,
            color: input.color,
          },
        });
      });
      return serializeLabel(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiFailure(409, "CONFLICT", "Etykieta o tej nazwie już istnieje w zespole");
      }
      throw error;
    }
  },

  async updateLabel(actor, teamId, labelId, input: UpdateLabelInput) {
    try {
      const updated = await withUser(getDb(), actor, async (tx) => {
        const existing = await tx.label.findFirst({
          where: { id: labelId, teamId, archivedAt: null },
        });
        if (!existing) return null;

        if (input.name !== undefined) {
          const duplicate = await tx.label.findFirst({
            where: {
              teamId,
              archivedAt: null,
              id: { not: labelId },
              name: { equals: input.name, mode: "insensitive" },
            },
            select: { id: true },
          });
          if (duplicate) {
            throw new ApiFailure(409, "CONFLICT", "Etykieta o tej nazwie już istnieje w zespole");
          }
        }

        return tx.label.update({
          where: { id: labelId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.color !== undefined ? { color: input.color } : {}),
          },
        });
      });
      return updated ? serializeLabel(updated) : null;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiFailure(409, "CONFLICT", "Etykieta o tej nazwie już istnieje w zespole");
      }
      throw error;
    }
  },

  async deleteLabel(actor, teamId, labelId) {
    return withUser(getDb(), actor, async (tx) => {
      // FOR UPDATE czeka na transakcje, które właśnie dodają tę etykietę do zadania
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"::text AS "id" FROM "public"."labels"
        WHERE "id" = ${labelId}::uuid AND "team_id" = ${teamId}::uuid AND "archived_at" IS NULL
        FOR UPDATE
      `;
      if (locked.length === 0) return false;
      await tx.issueLabel.deleteMany({ where: { labelId } });
      await tx.label.update({
        where: { id: labelId },
        data: { archivedAt: new Date() },
      });
      return true;
    });
  },

  async listIssues(actor, params: ListIssuesStoreParams): Promise<PaginatedResult<IssueListItem>> {
    if (params.readableTeamIds !== "ALL" && params.readableTeamIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    if (params.teamId && !teamAllowed(params.readableTeamIds, params.teamId)) {
      return { items: [], nextCursor: null };
    }
    if (params.q && params.q.length > 0 && !params.identifier && !params.tsQuery) {
      return { items: [], nextCursor: null };
    }

    return withUser(getDb(), actor, async (tx) => {
      const conditions: Prisma.Sql[] = [Prisma.sql`i."deleted_at" IS NULL`, Prisma.sql`t."archived_at" IS NULL`];

      if (params.readableTeamIds !== "ALL") {
        conditions.push(Prisma.sql`i."team_id" = ANY(${params.readableTeamIds}::uuid[])`);
      }
      if (params.teamId) {
        conditions.push(Prisma.sql`i."team_id" = ${params.teamId}::uuid`);
      }
      if (params.stateId) {
        conditions.push(Prisma.sql`i."state_id" = ${params.stateId}::uuid`);
      }
      if (params.stateCategory) {
        conditions.push(Prisma.sql`s."category" = ${params.stateCategory}::"public"."WorkflowStateCategory"`);
      }
      if (
        !params.includeCompleted &&
        !params.stateId &&
        params.stateCategory !== "COMPLETED" &&
        params.stateCategory !== "CANCELED"
      ) {
        conditions.push(
          Prisma.sql`s."category" NOT IN ('COMPLETED'::"public"."WorkflowStateCategory", 'CANCELED'::"public"."WorkflowStateCategory")`,
        );
      }
      if (params.assignee) {
        if (params.assignee.type === "none") {
          conditions.push(Prisma.sql`i."assignee_account_id" IS NULL`);
        } else {
          conditions.push(Prisma.sql`i."assignee_account_id" = ${params.assignee.accountId}::uuid`);
        }
      }
      if (params.labelId) {
        conditions.push(
          Prisma.sql`EXISTS (
            SELECT 1 FROM "public"."issue_labels" il
            JOIN "public"."labels" l ON l."id" = il."label_id"
            WHERE il."issue_id" = i."id"
              AND il."label_id" = ${params.labelId}::uuid
              AND l."archived_at" IS NULL
          )`,
        );
      }
      if (params.priority !== undefined) {
        conditions.push(Prisma.sql`i."priority" = ${params.priority}::smallint`);
      }
      if (params.parentId) {
        if (params.parentId.type === "none") {
          conditions.push(Prisma.sql`i."parent_id" IS NULL`);
        } else {
          conditions.push(Prisma.sql`i."parent_id" = ${params.parentId.issueId}::uuid`);
        }
      }
      if (params.identifier && params.tsQuery) {
        conditions.push(
          Prisma.sql`((t."key" = ${params.identifier.key} AND i."number" = ${params.identifier.number}) OR i."search_vector" @@ to_tsquery('simple', ${params.tsQuery}))`,
        );
      } else if (params.identifier) {
        conditions.push(Prisma.sql`(t."key" = ${params.identifier.key} AND i."number" = ${params.identifier.number})`);
      } else if (params.tsQuery) {
        conditions.push(Prisma.sql`i."search_vector" @@ to_tsquery('simple', ${params.tsQuery})`);
      }
      if (params.cursor) {
        conditions.push(buildCursorCondition(params.cursor));
      }

      const whereSql = Prisma.join(conditions, " AND ");
      const orderBySql = buildOrderByClause(params.sort);
      const take = params.limit + 1;

      const idRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT i."id"::text AS "id"
        FROM "public"."issues" i
        JOIN "public"."teams" t ON t."id" = i."team_id"
        JOIN "public"."workflow_states" s ON s."id" = i."state_id"
        WHERE ${whereSql}
        ORDER BY ${orderBySql}
        LIMIT ${take}
      `;

      const hasMore = idRows.length > params.limit;
      const pageIds = (hasMore ? idRows.slice(0, params.limit) : idRows).map((r) => r.id);
      const items = await hydrateIssuesInOrder(tx, pageIds);
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeIssueCursor(buildIssueCursorPayload(params.sort, last)) : null;

      return { items, nextCursor };
    });
  },

  async createIssue(actor, input: CreateIssueStoreInput) {
    return withUser(getDb(), actor, async (tx) => {
      // 1. Rozwiąż status (podany lub domyślny BACKLOG -> UNSTARTED) i zablokuj go przed archiwizacją
      let state: LockedState | null;
      if (input.stateId) {
        state = await lockActiveState(tx, input.teamId, input.stateId, "SHARE");
        if (!state) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "stateId", message: "Wybrany status nie należy do tego zespołu" },
          ]);
        }
      } else {
        state = await lockDefaultState(tx, input.teamId);
        if (!state) {
          throw new ApiFailure(409, "CONFLICT", "Zespół nie ma domyślnego statusu dla nowych zadań");
        }
      }

      // 2. Sprawdź etykiety (muszą należeć do tego samego zespołu) i zablokuj je przed archiwizacją
      const uniqueLabelIds = [...new Set(input.labelIds)];
      if ((await lockActiveLabels(tx, input.teamId, uniqueLabelIds)) !== uniqueLabelIds.length) {
        throw LABELS_OUTSIDE_TEAM;
      }

      // 3. Sprawdź zadanie nadrzędne (ten sam zespół, nieusunięte) pod blokadą hierarchii zespołu,
      // żeby równoległe usunięcie rodzica nie zostawiło nowego podzadania przy usuniętym zadaniu
      if (input.parentId !== null) {
        await lockTeamIssueHierarchy(tx, input.teamId);
        const parent = await tx.issue.findFirst({
          where: { id: input.parentId, teamId: input.teamId, deletedAt: null },
          select: { id: true },
        });
        if (!parent) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "parentId", message: "Zadanie nadrzędne musi istnieć w tym samym zespole" },
          ]);
        }
      }

      // 4. Atomowe przydzielenie numeru w tej samej transakcji
      const allocated = await tx.$queryRaw<{ number: number }[]>`
        UPDATE "public"."teams"
        SET "next_issue_number" = "next_issue_number" + 1,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${input.teamId}::uuid
          AND "archived_at" IS NULL
        RETURNING ("next_issue_number" - 1) AS "number"
      `;
      if (allocated.length === 0) {
        throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zespołu");
      }
      const number = allocated[0]!.number;

      const now = new Date();
      const timestamps = computeStateTimestamps(
        state.category,
        { startedAt: null, completedAt: null, canceledAt: null },
        now,
      );
      const id = uuidv7(now.getTime());

      await tx.issue.create({
        data: {
          id,
          organizationId: actor.organizationId,
          teamId: input.teamId,
          number,
          title: input.title,
          description: input.description,
          stateId: state.id,
          priority: input.priority,
          assigneeAccountId: input.assigneeAccountId,
          creatorAccountId: input.creatorAccountId,
          dueDate: input.dueDate ? parseDateOnly(input.dueDate) : null,
          estimate: input.estimate,
          parentId: input.parentId,
          sortOrder: number * 1000,
          startedAt: timestamps.startedAt,
          completedAt: timestamps.completedAt,
          canceledAt: timestamps.canceledAt,
        },
      });

      if (uniqueLabelIds.length > 0) {
        await tx.issueLabel.createMany({
          data: uniqueLabelIds.map((labelId) => ({
            issueId: id,
            labelId,
            organizationId: actor.organizationId,
            teamId: input.teamId,
          })),
        });
      }

      const detail = await hydrateIssueDetail(tx, id, "ALL");
      if (!detail) {
        throw new ApiFailure(500, "INTERNAL_ERROR", "Nie udało się odczytać utworzonego zadania");
      }
      return detail;
    });
  },

  async findIssueLocationById(actor, issueId): Promise<IssueLocation | null> {
    const row = await withUser(getDb(), actor, (tx) =>
      tx.issue.findFirst({
        where: { id: issueId, deletedAt: null, team: { archivedAt: null } },
        select: { id: true, teamId: true, assigneeAccountId: true, team: { select: { name: true } } },
      }),
    );
    return row
      ? { id: row.id, teamId: row.teamId, teamName: row.team.name, assigneeAccountId: row.assigneeAccountId }
      : null;
  },

  async findIssueDetail(actor, lookup: IssueLookup, readableTeamIds: TeamFilterScope): Promise<IssueDetail | null> {
    if (readableTeamIds !== "ALL" && readableTeamIds.length === 0) return null;
    return withUser(getDb(), actor, async (tx) => {
      let targetId: string;
      if (lookup.type === "id") {
        targetId = lookup.id;
      } else {
        const team = await tx.team.findFirst({
          where: { key: lookup.key, archivedAt: null },
          select: { id: true },
        });
        if (!team || !teamAllowed(readableTeamIds, team.id)) return null;
        const found = await tx.issue.findUnique({
          where: { teamId_number: { teamId: team.id, number: lookup.number } },
          select: { id: true, deletedAt: true },
        });
        if (!found || found.deletedAt !== null) return null;
        targetId = found.id;
      }
      return hydrateIssueDetail(tx, targetId, readableTeamIds);
    });
  },

  async updateIssue(
    actor,
    issueId,
    input: UpdateIssueStoreInput,
    readableTeamIds: TeamFilterScope,
  ): Promise<IssueDetail | null> {
    return withUser(getDb(), actor, async (tx) => {
      const existing = await tx.issue.findFirst({
        where: { id: issueId, deletedAt: null, team: { archivedAt: null } },
        include: { state: { select: { category: true } } },
      });
      if (!existing) return null;

      if (input.parentId !== undefined && input.parentId !== null) {
        await lockTeamIssueHierarchy(tx, existing.teamId);
      }

      let nextTimestamps: { startedAt: Date | null; completedAt: Date | null; canceledAt: Date | null } | undefined;
      if (input.stateId !== undefined && input.stateId !== existing.stateId) {
        const targetState = await lockActiveState(tx, existing.teamId, input.stateId, "SHARE");
        if (!targetState) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "stateId", message: "Wybrany status nie należy do tego zespołu" },
          ]);
        }
        if (targetState.category !== existing.state.category) {
          nextTimestamps = computeStateTimestamps(
            targetState.category,
            {
              startedAt: existing.startedAt,
              completedAt: existing.completedAt,
              canceledAt: existing.canceledAt,
            },
            new Date(),
          );
        }
      }

      if (input.parentId !== undefined && input.parentId !== null) {
        if (input.parentId === issueId) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "parentId", message: "Zadanie nie może być swoim własnym zadaniem nadrzędnym" },
          ]);
        }
        const parent = await tx.issue.findFirst({
          where: { id: input.parentId, teamId: existing.teamId, deletedAt: null },
          select: { id: true },
        });
        if (!parent) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "parentId", message: "Zadanie nadrzędne musi istnieć w tym samym zespole" },
          ]);
        }
        const createsCycle = await wouldCreateParentCycle(issueId, input.parentId, async (id) => {
          const row = await tx.issue.findFirst({
            where: { id, teamId: existing.teamId, deletedAt: null },
            select: { parentId: true },
          });
          return row?.parentId ?? null;
        });
        if (createsCycle) {
          throw new ApiFailure(409, "CONFLICT", "Wybrane zadanie nadrzędne tworzy cykl w hierarchii zadań");
        }
      }

      if (input.labelIds !== undefined) {
        const uniqueLabelIds = [...new Set(input.labelIds)];
        if ((await lockActiveLabels(tx, existing.teamId, uniqueLabelIds)) !== uniqueLabelIds.length) {
          throw LABELS_OUTSIDE_TEAM;
        }
        await tx.issueLabel.deleteMany({ where: { issueId } });
        if (uniqueLabelIds.length > 0) {
          await tx.issueLabel.createMany({
            data: uniqueLabelIds.map((labelId) => ({
              issueId,
              labelId,
              organizationId: actor.organizationId,
              teamId: existing.teamId,
            })),
          });
        }
      }

      await tx.issue.update({
        where: { id: issueId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.stateId !== undefined ? { stateId: input.stateId } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.assigneeAccountId !== undefined ? { assigneeAccountId: input.assigneeAccountId } : {}),
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? parseDateOnly(input.dueDate) : null } : {}),
          ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(nextTimestamps
            ? {
                startedAt: nextTimestamps.startedAt,
                completedAt: nextTimestamps.completedAt,
                canceledAt: nextTimestamps.canceledAt,
              }
            : {}),
        },
      });

      return hydrateIssueDetail(tx, issueId, readableTeamIds);
    });
  },

  async softDeleteIssue(actor, issueId) {
    return withUser(getDb(), actor, async (tx) => {
      const target = await tx.issue.findFirst({
        where: { id: issueId, deletedAt: null },
        select: { teamId: true },
      });
      if (!target) return false;
      // Pod blokadą hierarchii: podzadania stają się zadaniami głównymi, a usunięte zadanie traci rodzica,
      // więc nie zostają odwołania do usuniętych zadań ani ukryte cykle
      await lockTeamIssueHierarchy(tx, target.teamId);
      const updated = await tx.issue.updateMany({
        where: { id: issueId, deletedAt: null },
        data: { deletedAt: new Date(), parentId: null },
      });
      if (updated.count === 0) return false;
      await tx.issue.updateMany({
        where: { parentId: issueId, deletedAt: null },
        data: { parentId: null },
      });
      return true;
    });
  },

  async createIssueRelation(actor, input) {
    try {
      return await withUser(getDb(), actor, async (tx) => {
        // Oba zadania muszą nadal istnieć: blokada FOR SHARE czeka na równoległe usunięcie i widzi jego wynik
        const source = await lockActiveIssue(tx, input.storedIssueId);
        const target = await lockActiveIssue(tx, input.storedRelatedIssueId);
        if (!source || !target) {
          throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
        }

        if (input.storedType === "RELATED") {
          const existingSymmetric = await tx.issueRelation.findFirst({
            where: {
              type: "RELATED",
              OR: [
                { issueId: input.storedIssueId, relatedIssueId: input.storedRelatedIssueId },
                { issueId: input.storedRelatedIssueId, relatedIssueId: input.storedIssueId },
              ],
            },
            select: { id: true },
          });
          if (existingSymmetric) {
            throw new ApiFailure(409, "CONFLICT", "Taka relacja między zadaniami już istnieje");
          }
        } else {
          const existing = await tx.issueRelation.findUnique({
            where: {
              issueId_relatedIssueId_type: {
                issueId: input.storedIssueId,
                relatedIssueId: input.storedRelatedIssueId,
                type: input.storedType,
              },
            },
            select: { id: true },
          });
          if (existing) {
            throw new ApiFailure(409, "CONFLICT", "Taka relacja między zadaniami już istnieje");
          }
        }

        const created = await tx.issueRelation.create({
          data: {
            id: uuidv7(),
            organizationId: actor.organizationId,
            issueId: input.storedIssueId,
            relatedIssueId: input.storedRelatedIssueId,
            type: input.storedType,
          },
          include: {
            issue: { select: ISSUE_REF_SELECT },
            relatedIssue: { select: ISSUE_REF_SELECT },
          },
        });

        const other = created.issueId === input.viewerIssueId ? created.relatedIssue : created.issue;
        return toIssueRelationView(input.viewerIssueId, created, serializeIssueReference(other));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiFailure(409, "CONFLICT", "Taka relacja między zadaniami już istnieje");
      }
      throw error;
    }
  },

  async findIssueRelation(actor, issueId, relationId): Promise<IssueRelationRecordInfo | null> {
    return withUser(getDb(), actor, async (tx) => {
      const rel = await tx.issueRelation.findFirst({
        where: {
          id: relationId,
          OR: [{ issueId }, { relatedIssueId: issueId }],
        },
        include: {
          issue: { select: { teamId: true, deletedAt: true } },
          relatedIssue: { select: { teamId: true, deletedAt: true } },
        },
      });
      if (!rel || rel.issue.deletedAt !== null || rel.relatedIssue.deletedAt !== null) {
        return null;
      }
      return {
        id: rel.id,
        issueId: rel.issueId,
        relatedIssueId: rel.relatedIssueId,
        issueTeamId: rel.issue.teamId,
        relatedIssueTeamId: rel.relatedIssue.teamId,
      };
    });
  },

  async deleteIssueRelation(actor, relationId) {
    return withUser(getDb(), actor, async (tx) => {
      const deleted = await tx.issueRelation.deleteMany({ where: { id: relationId } });
      return deleted.count > 0;
    });
  },

  async searchIssues(actor, params: SearchIssuesStoreParams): Promise<IssueListItem[]> {
    if (params.readableTeamIds !== "ALL" && params.readableTeamIds.length === 0) {
      return [];
    }
    if (!params.identifier && !params.tsQuery) {
      return [];
    }

    return withUser(getDb(), actor, async (tx) => {
      const teamFilterSql =
        params.readableTeamIds === "ALL"
          ? Prisma.sql`TRUE`
          : Prisma.sql`i."team_id" = ANY(${params.readableTeamIds}::uuid[])`;

      const orderedIds: string[] = [];

      if (params.identifier) {
        const exactRows = await tx.$queryRaw<{ id: string }[]>`
          SELECT i."id"::text AS "id"
          FROM "public"."issues" i
          JOIN "public"."teams" t ON t."id" = i."team_id"
          WHERE i."deleted_at" IS NULL
            AND t."archived_at" IS NULL
            AND ${teamFilterSql}
            AND t."key" = ${params.identifier.key}
            AND i."number" = ${params.identifier.number}
          LIMIT 1
        `;
        if (exactRows[0]) {
          orderedIds.push(exactRows[0].id);
        }
      }

      const remaining = params.limit - orderedIds.length;
      if (remaining > 0 && params.tsQuery) {
        const excludeSql = orderedIds.length > 0 ? Prisma.sql`AND i."id" <> ${orderedIds[0]}::uuid` : Prisma.empty;
        const ftsRows = await tx.$queryRaw<{ id: string }[]>`
          SELECT i."id"::text AS "id"
          FROM "public"."issues" i
          JOIN "public"."teams" t ON t."id" = i."team_id"
          WHERE i."deleted_at" IS NULL
            AND t."archived_at" IS NULL
            AND ${teamFilterSql}
            ${excludeSql}
            AND i."search_vector" @@ to_tsquery('simple', ${params.tsQuery})
          ORDER BY ts_rank_cd(i."search_vector", to_tsquery('simple', ${params.tsQuery})) DESC,
                   i."updated_at" DESC,
                   i."id" DESC
          LIMIT ${remaining}
        `;
        for (const row of ftsRows) {
          orderedIds.push(row.id);
        }
      }

      return hydrateIssuesInOrder(tx, orderedIds);
    });
  },
};
