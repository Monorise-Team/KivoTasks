import "server-only";
import {
  DEFAULT_WORKFLOW_STATES,
  type AttachmentContentType,
  type ColorToken,
  type CommentReactionsResult,
  type InboxItem,
  type InboxItemKind,
  type IssueActivityItem,
  type IssueComment,
  type IssueDetail,
  type IssueEvent,
  type IssueEventPayload,
  type IssueEventType,
  type IssueListItem,
  type IssueReference,
  type IssueRelationView,
  type IssueSort,
  type IssueStateSummary,
  type IssueSubscription,
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
import {
  aggregateCommentReactions,
  buildCommentExcerpt,
  buildIssueUpdateEvents,
  computeAssignmentInboxRecipients,
  computeCommentEditMentionRecipients,
  computeCommentInboxFanout,
  encodeActivityCursor,
  encodeTimeIdCursor,
  redactIssueEvent,
} from "./collaboration-helpers";
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
  AttachmentRecord,
  CommentLocation,
  CreateIssueAttachmentStoreInput,
  CreateIssueStoreInput,
  IssueLocation,
  IssueLookup,
  IssueRelationRecordInfo,
  IssuesStore,
  ListInboxStoreParams,
  ListIssueActivityStoreParams,
  ListIssueAttachmentsStoreParams,
  ListIssueCommentsStoreParams,
  ListIssuesStoreParams,
  SearchIssuesStoreParams,
  UpdateInboxItemStoreParams,
  UpdateIssueStoreInput,
  UpdateIssueStoreResult,
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
  viewerAccountId: string,
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

  const subRows = await tx.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "public"."issue_subscribers"
      WHERE "issue_id" = ${row.id}::uuid AND "account_id" = ${viewerAccountId}::uuid
    ) AS "exists"
  `;

  const base = serializeIssueListItem(row);
  return {
    ...base,
    description: row.description,
    parent: row.parent && row.parent.deletedAt === null ? serializeIssueReference(row.parent) : null,
    children: row.children.map((child) => serializeIssueReference(child)),
    relations,
    isSubscribed: subRows[0]?.exists === true,
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
type LockedState = { id: string; name: string; category: WorkflowStateCategory };

async function lockActiveState(
  tx: Tx,
  teamId: string,
  stateId: string,
  mode: "SHARE" | "UPDATE",
): Promise<LockedState | null> {
  const lock = mode === "SHARE" ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`;
  const rows = await tx.$queryRaw<LockedState[]>`
    SELECT "id"::text AS "id", "name", "category"::text AS "category"
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
      SELECT "id"::text AS "id", "name", "category"::text AS "category"
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

/** Blokuje FOR SHARE aktywne etykiety zespołu i zwraca ich listę (`id`, `name`). */
async function lockActiveLabels(
  tx: Tx,
  teamId: string,
  labelIds: readonly string[],
): Promise<{ id: string; name: string }[]> {
  if (labelIds.length === 0) return [];
  return tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT "id"::text AS "id", "name"
    FROM "public"."labels"
    WHERE "id" = ANY(${[...labelIds]}::uuid[]) AND "team_id" = ${teamId}::uuid AND "archived_at" IS NULL
    ORDER BY "name" ASC, "id" ASC
    FOR SHARE
  `;
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

// ── Wspólne pomocniki zapisu historii, obserwujących, komentarzy i skrzynki ─

interface PendingIssueEventRow {
  organizationId: string;
  teamId: string;
  issueId: string;
  actorAccountId: string;
  type: IssueEventType;
  before: IssueEventPayload;
  after: IssueEventPayload;
  createdAt: Date;
}

async function insertIssueEvents(tx: Tx, events: readonly PendingIssueEventRow[]): Promise<void> {
  if (events.length === 0) return;

  const ids: string[] = [];
  const orgIds: string[] = [];
  const teamIds: string[] = [];
  const issueIds: string[] = [];
  const actorIds: string[] = [];
  const types: string[] = [];
  const befores: (string | null)[] = [];
  const afters: (string | null)[] = [];
  const createdAts: string[] = [];

  for (const event of events) {
    ids.push(uuidv7(event.createdAt.getTime()));
    orgIds.push(event.organizationId);
    teamIds.push(event.teamId);
    issueIds.push(event.issueId);
    actorIds.push(event.actorAccountId);
    types.push(event.type);
    befores.push(event.before === null ? null : JSON.stringify(event.before));
    afters.push(event.after === null ? null : JSON.stringify(event.after));
    createdAts.push(event.createdAt.toISOString());
  }

  await tx.$executeRaw`
    INSERT INTO "public"."issue_events"
      ("id", "organization_id", "team_id", "issue_id", "actor_account_id", "type", "before", "after", "created_at")
    SELECT u."id", u."organization_id", u."team_id", u."issue_id", u."actor_account_id",
           u."type"::"public"."IssueEventType", u."before"::jsonb, u."after"::jsonb, u."created_at"
    FROM unnest(
      ${ids}::uuid[],
      ${orgIds}::uuid[],
      ${teamIds}::uuid[],
      ${issueIds}::uuid[],
      ${actorIds}::uuid[],
      ${types}::text[],
      ${befores}::text[],
      ${afters}::text[],
      ${createdAts}::timestamptz(3)[]
    ) AS u(
      "id", "organization_id", "team_id", "issue_id", "actor_account_id",
      "type", "before", "after", "created_at"
    )
  `;
}

async function ensureIssueSubscribers(
  tx: Tx,
  params: { organizationId: string; issueId: string; accountIds: readonly string[]; createdAt: Date },
): Promise<void> {
  const unique = [...new Set(params.accountIds)];
  if (unique.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO "public"."issue_subscribers" ("issue_id", "account_id", "organization_id", "created_at")
    SELECT ${params.issueId}::uuid, u."account_id", ${params.organizationId}::uuid, ${params.createdAt}
    FROM unnest(${unique}::uuid[]) AS u("account_id")
    ON CONFLICT ("issue_id", "account_id") DO NOTHING
  `;
}

async function insertCommentMentions(
  tx: Tx,
  params: { organizationId: string; commentId: string; accountIds: readonly string[]; createdAt: Date },
): Promise<void> {
  const unique = [...new Set(params.accountIds)];
  if (unique.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO "public"."comment_mentions" ("comment_id", "account_id", "organization_id", "created_at")
    SELECT ${params.commentId}::uuid, u."account_id", ${params.organizationId}::uuid, ${params.createdAt}
    FROM unnest(${unique}::uuid[]) AS u("account_id")
    ON CONFLICT ("comment_id", "account_id") DO NOTHING
  `;
}

async function insertInboxItems(
  tx: Tx,
  items: readonly {
    organizationId: string;
    recipientAccountId: string;
    kind: InboxItemKind;
    issueId: string;
    actorAccountId: string;
    commentId: string | null;
    createdAt: Date;
  }[],
): Promise<void> {
  const filtered = items.filter((item) => item.recipientAccountId.toLowerCase() !== item.actorAccountId.toLowerCase());
  if (filtered.length === 0) return;

  const ids: string[] = [];
  const orgIds: string[] = [];
  const recipientIds: string[] = [];
  const kinds: string[] = [];
  const issueIds: string[] = [];
  const actorIds: string[] = [];
  const commentIds: (string | null)[] = [];
  const createdAts: string[] = [];

  for (const item of filtered) {
    ids.push(uuidv7(item.createdAt.getTime()));
    orgIds.push(item.organizationId);
    recipientIds.push(item.recipientAccountId);
    kinds.push(item.kind);
    issueIds.push(item.issueId);
    actorIds.push(item.actorAccountId);
    commentIds.push(item.commentId);
    createdAts.push(item.createdAt.toISOString());
  }

  await tx.$executeRaw`
    INSERT INTO "public"."inbox_items"
      ("id", "organization_id", "recipient_account_id", "kind", "issue_id", "actor_account_id", "comment_id", "created_at")
    SELECT u."id", u."organization_id", u."recipient_account_id", u."kind"::"public"."InboxItemKind",
           u."issue_id", u."actor_account_id", u."comment_id", u."created_at"
    FROM unnest(
      ${ids}::uuid[],
      ${orgIds}::uuid[],
      ${recipientIds}::uuid[],
      ${kinds}::text[],
      ${issueIds}::uuid[],
      ${actorIds}::uuid[],
      ${commentIds}::uuid[],
      ${createdAts}::timestamptz(3)[]
    ) AS u(
      "id", "organization_id", "recipient_account_id", "kind",
      "issue_id", "actor_account_id", "comment_id", "created_at"
    )
  `;
}

interface RawCommentRow {
  id: string;
  organizationId: string;
  teamId: string;
  issueId: string;
  authorAccountId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

interface RawEventRow {
  id: string;
  organizationId: string;
  teamId: string;
  issueId: string;
  actorAccountId: string;
  type: IssueEventType;
  before: IssueEventPayload;
  after: IssueEventPayload;
  createdAt: Date;
}

interface RawInboxRow {
  id: string;
  organizationId: string;
  recipientAccountId: string;
  kind: InboxItemKind;
  issueId: string;
  actorAccountId: string;
  commentId: string | null;
  commentBody: string | null;
  commentDeletedAt: Date | null;
  createdAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
  issueTeamId: string;
  issueNumber: number;
  issueTitle: string;
  teamKey: string;
  stateId: string;
  stateName: string;
  stateCategory: WorkflowStateCategory;
  stateColor: string;
  statePosition: number;
}

async function hydrateComments(
  tx: Tx,
  rows: readonly RawCommentRow[],
  viewerAccountId: string,
): Promise<IssueComment[]> {
  if (rows.length === 0) return [];
  const activeIds = rows.filter((row) => row.deletedAt === null).map((row) => row.id);

  const mentionsByComment = new Map<string, string[]>();
  const reactionsByComment = new Map<string, { emoji: string; accountId: string }[]>();

  if (activeIds.length > 0) {
    const [mentionRows, reactionRows] = await Promise.all([
      tx.$queryRaw<{ commentId: string; accountId: string }[]>`
        SELECT "comment_id"::text AS "commentId", "account_id"::text AS "accountId"
        FROM "public"."comment_mentions"
        WHERE "comment_id" = ANY(${activeIds}::uuid[])
        ORDER BY "created_at" ASC, "account_id" ASC
      `,
      tx.$queryRaw<{ commentId: string; accountId: string; emoji: string }[]>`
        SELECT "comment_id"::text AS "commentId", "account_id"::text AS "accountId", "emoji"
        FROM "public"."comment_reactions"
        WHERE "comment_id" = ANY(${activeIds}::uuid[])
      `,
    ]);

    for (const row of mentionRows) {
      const list = mentionsByComment.get(row.commentId);
      if (list) list.push(row.accountId);
      else mentionsByComment.set(row.commentId, [row.accountId]);
    }
    for (const row of reactionRows) {
      const list = reactionsByComment.get(row.commentId);
      if (list) list.push({ emoji: row.emoji, accountId: row.accountId });
      else reactionsByComment.set(row.commentId, [{ emoji: row.emoji, accountId: row.accountId }]);
    }
  }

  return rows.map((row) => {
    const deleted = row.deletedAt !== null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      teamId: row.teamId,
      issueId: row.issueId,
      authorAccountId: row.authorAccountId,
      authorName: null,
      body: deleted ? null : row.body,
      deleted,
      mentionedAccountIds: deleted ? [] : (mentionsByComment.get(row.id) ?? []),
      reactions: deleted ? [] : aggregateCommentReactions(reactionsByComment.get(row.id) ?? [], viewerAccountId),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    };
  });
}

function serializeIssueEvent(row: RawEventRow): IssueEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    teamId: row.teamId,
    issueId: row.issueId,
    actorAccountId: row.actorAccountId,
    actorName: null,
    type: row.type,
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function hydrateInboxRows(tx: Tx, rows: readonly RawInboxRow[]): Promise<InboxItem[]> {
  if (rows.length === 0) return [];

  const activeCommentIds = [
    ...new Set(
      rows
        .filter((row) => row.commentId !== null && row.commentDeletedAt === null)
        .map((row) => row.commentId as string),
    ),
  ];

  const mentionsByComment = new Map<string, string[]>();
  if (activeCommentIds.length > 0) {
    const mentionRows = await tx.$queryRaw<{ commentId: string; accountId: string }[]>`
      SELECT "comment_id"::text AS "commentId", "account_id"::text AS "accountId"
      FROM "public"."comment_mentions"
      WHERE "comment_id" = ANY(${activeCommentIds}::uuid[])
    `;
    for (const row of mentionRows) {
      const list = mentionsByComment.get(row.commentId);
      if (list) list.push(row.accountId);
      else mentionsByComment.set(row.commentId, [row.accountId]);
    }
  }

  return rows.map((row) => {
    const excerpt =
      row.commentId && row.commentDeletedAt === null
        ? buildCommentExcerpt(row.commentBody, mentionsByComment.get(row.commentId) ?? [])
        : null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      recipientAccountId: row.recipientAccountId,
      kind: row.kind,
      issueId: row.issueId,
      issue: {
        id: row.issueId,
        teamId: row.issueTeamId,
        identifier: formatIssueIdentifier(row.teamKey, row.issueNumber),
        number: row.issueNumber,
        title: row.issueTitle,
        state: {
          id: row.stateId,
          name: row.stateName,
          category: row.stateCategory,
          color: row.stateColor as ColorToken,
          position: row.statePosition,
        },
      },
      actorAccountId: row.actorAccountId,
      actorName: null,
      commentId: row.commentId,
      commentExcerpt: excerpt,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt ? row.readAt.toISOString() : null,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    };
  });
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
      const lockedLabels = await lockActiveLabels(tx, input.teamId, uniqueLabelIds);
      if (lockedLabels.length !== uniqueLabelIds.length) {
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
      const allocated = await tx.$queryRaw<{ number: number; key: string }[]>`
        UPDATE "public"."teams"
        SET "next_issue_number" = "next_issue_number" + 1,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${input.teamId}::uuid
          AND "archived_at" IS NULL
        RETURNING ("next_issue_number" - 1) AS "number", "key"
      `;
      if (allocated.length === 0) {
        throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zespołu");
      }
      const number = allocated[0]!.number;
      const teamKey = allocated[0]!.key;

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

      // 5. Historia, automatyczni obserwujący oraz powiadomienie o przypisaniu w tej samej transakcji
      await insertIssueEvents(tx, [
        {
          organizationId: actor.organizationId,
          teamId: input.teamId,
          issueId: id,
          actorAccountId: actor.accountId,
          type: "CREATED",
          before: null,
          after: {
            identifier: formatIssueIdentifier(teamKey, number),
            title: input.title,
            stateId: state.id,
            stateName: state.name,
            priority: input.priority,
            assigneeAccountId: input.assigneeAccountId,
          },
          createdAt: now,
        },
      ]);

      await ensureIssueSubscribers(tx, {
        organizationId: actor.organizationId,
        issueId: id,
        accountIds: input.assigneeAccountId
          ? [input.creatorAccountId, input.assigneeAccountId]
          : [input.creatorAccountId],
        createdAt: now,
      });

      const assignedRecipients = computeAssignmentInboxRecipients({
        previousAssigneeAccountId: null,
        nextAssigneeAccountId: input.assigneeAccountId,
        actorAccountId: actor.accountId,
      });
      if (assignedRecipients.length > 0) {
        await insertInboxItems(
          tx,
          assignedRecipients.map((recipientAccountId) => ({
            organizationId: actor.organizationId,
            recipientAccountId,
            kind: "ASSIGNED",
            issueId: id,
            actorAccountId: actor.accountId,
            commentId: null,
            createdAt: now,
          })),
        );
      }

      const detail = await hydrateIssueDetail(tx, id, "ALL", actor.accountId);
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
      return hydrateIssueDetail(tx, targetId, readableTeamIds, actor.accountId);
    });
  },

  async updateIssue(
    actor,
    issueId,
    input: UpdateIssueStoreInput,
    readableTeamIds: TeamFilterScope,
  ): Promise<UpdateIssueStoreResult | null> {
    return withUser(getDb(), actor, async (tx) => {
      // Przy zmianie rodzica najpierw bierzemy blokadę hierarchii zespołu (ta sama kolejność co w softDeleteIssue),
      // aby uniknąć zakleszczenia między blokadą doradczą a blokadą wiersza FOR UPDATE.
      if (input.parentId !== undefined && input.parentId !== null) {
        const pre = await tx.$queryRaw<{ teamId: string }[]>`
          SELECT i."team_id"::text AS "teamId"
          FROM "public"."issues" i
          JOIN "public"."teams" t ON t."id" = i."team_id"
          WHERE i."id" = ${issueId}::uuid AND i."deleted_at" IS NULL AND t."archived_at" IS NULL
        `;
        if (pre.length === 0) return null;
        await lockTeamIssueHierarchy(tx, pre[0]!.teamId);
      }

      // Blokada wiersza FOR UPDATE serializuje równoległe aktualizacje i miękkie usunięcie tego samego zadania;
      // różnicę historii, zmiany etykiet oraz fan-out ASSIGNED liczymy wyłącznie z zablokowanego wiersza.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT i."id"::text AS "id"
        FROM "public"."issues" i
        JOIN "public"."teams" t ON t."id" = i."team_id"
        WHERE i."id" = ${issueId}::uuid AND i."deleted_at" IS NULL AND t."archived_at" IS NULL
        FOR UPDATE OF i
      `;
      if (locked.length === 0) return null;

      const existing = await tx.issue.findFirst({
        where: { id: issueId, deletedAt: null, team: { archivedAt: null } },
        include: {
          state: { select: { id: true, name: true, category: true } },
          parent: { select: { id: true, number: true, deletedAt: true, team: { select: { key: true } } } },
          issueLabels: {
            where: { label: { archivedAt: null } },
            include: { label: { select: { id: true, name: true } } },
            orderBy: { label: { name: "asc" } },
          },
        },
      });
      if (!existing) return null;

      const now = new Date();
      let nextStateSnapshot = { id: existing.state.id, name: existing.state.name };
      let nextTimestamps: { startedAt: Date | null; completedAt: Date | null; canceledAt: Date | null } | undefined;
      if (input.stateId !== undefined && input.stateId !== existing.stateId) {
        const targetState = await lockActiveState(tx, existing.teamId, input.stateId, "SHARE");
        if (!targetState) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "stateId", message: "Wybrany status nie należy do tego zespołu" },
          ]);
        }
        nextStateSnapshot = { id: targetState.id, name: targetState.name };
        if (targetState.category !== existing.state.category) {
          nextTimestamps = computeStateTimestamps(
            targetState.category,
            {
              startedAt: existing.startedAt,
              completedAt: existing.completedAt,
              canceledAt: existing.canceledAt,
            },
            now,
          );
        }
      }

      const existingParentSnapshot =
        existing.parent && existing.parent.deletedAt === null
          ? {
              id: existing.parent.id,
              identifier: formatIssueIdentifier(existing.parent.team.key, existing.parent.number),
            }
          : null;
      let nextParentSnapshot = existingParentSnapshot;

      if (input.parentId !== undefined) {
        if (input.parentId === null) {
          nextParentSnapshot = null;
        } else {
          if (input.parentId === issueId) {
            throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
              { field: "parentId", message: "Zadanie nie może być swoim własnym zadaniem nadrzędnym" },
            ]);
          }
          const parent = await tx.issue.findFirst({
            where: { id: input.parentId, teamId: existing.teamId, deletedAt: null },
            select: { id: true, number: true, team: { select: { key: true } } },
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
          nextParentSnapshot = {
            id: parent.id,
            identifier: formatIssueIdentifier(parent.team.key, parent.number),
          };
        }
      }

      const existingLabelsSnapshot = existing.issueLabels.map((item) => ({
        id: item.label.id,
        name: item.label.name,
      }));
      let nextLabelsSnapshot = existingLabelsSnapshot;

      if (input.labelIds !== undefined) {
        const uniqueLabelIds = [...new Set(input.labelIds)];
        const lockedLabels = await lockActiveLabels(tx, existing.teamId, uniqueLabelIds);
        if (lockedLabels.length !== uniqueLabelIds.length) {
          throw LABELS_OUTSIDE_TEAM;
        }
        nextLabelsSnapshot = lockedLabels;
        await tx.issueLabel.deleteMany({ where: { issueId } });
        if (uniqueLabelIds.length > 0) {
          await tx.issueLabel.createMany({
            data: uniqueLabelIds.map((labelId) => ({
              issueId,
              labelId,
              organizationId: actor.organizationId,
              teamId: existing.teamId,
            })),
            skipDuplicates: true,
          });
        }
      }

      const existingDueDate = formatDateOnly(existing.dueDate);
      const nextDueDate = input.dueDate !== undefined ? input.dueDate : existingDueDate;

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

      const pendingEvents = buildIssueUpdateEvents(
        {
          title: existing.title,
          description: existing.description,
          state: { id: existing.state.id, name: existing.state.name },
          priority: existing.priority,
          assigneeAccountId: existing.assigneeAccountId,
          labels: existingLabelsSnapshot,
          dueDate: existingDueDate,
          estimate: existing.estimate,
          parent: existingParentSnapshot,
        },
        {
          title: input.title !== undefined ? input.title : existing.title,
          description: input.description !== undefined ? input.description : existing.description,
          state: nextStateSnapshot,
          priority: input.priority !== undefined ? input.priority : existing.priority,
          assigneeAccountId:
            input.assigneeAccountId !== undefined ? input.assigneeAccountId : existing.assigneeAccountId,
          labels: nextLabelsSnapshot,
          dueDate: nextDueDate,
          estimate: input.estimate !== undefined ? input.estimate : existing.estimate,
          parent: nextParentSnapshot,
        },
      );

      await insertIssueEvents(
        tx,
        pendingEvents.map((event) => ({
          organizationId: actor.organizationId,
          teamId: existing.teamId,
          issueId,
          actorAccountId: actor.accountId,
          type: event.type,
          before: event.before,
          after: event.after,
          createdAt: now,
        })),
      );

      if (input.assigneeAccountId !== undefined) {
        if (input.assigneeAccountId !== null && input.assigneeAccountId !== existing.assigneeAccountId) {
          await ensureIssueSubscribers(tx, {
            organizationId: actor.organizationId,
            issueId,
            accountIds: [input.assigneeAccountId],
            createdAt: now,
          });
        }
        const assignedRecipients = computeAssignmentInboxRecipients({
          previousAssigneeAccountId: existing.assigneeAccountId,
          nextAssigneeAccountId: input.assigneeAccountId,
          actorAccountId: actor.accountId,
        });
        if (assignedRecipients.length > 0) {
          await insertInboxItems(
            tx,
            assignedRecipients.map((recipientAccountId) => ({
              organizationId: actor.organizationId,
              recipientAccountId,
              kind: "ASSIGNED",
              issueId,
              actorAccountId: actor.accountId,
              commentId: null,
              createdAt: now,
            })),
          );
        }
      }

      const detail = await hydrateIssueDetail(tx, issueId, readableTeamIds, actor.accountId);
      return detail ? { issue: detail, previousAssigneeAccountId: existing.assigneeAccountId } : null;
    });
  },

  async softDeleteIssue(actor, issueId) {
    return withUser(getDb(), actor, async (tx) => {
      const target = await tx.issue.findFirst({
        where: { id: issueId, deletedAt: null },
        select: { teamId: true, number: true, team: { select: { key: true } } },
      });
      if (!target) return false;
      // Pod blokadą hierarchii: podzadania stają się zadaniami głównymi, a usunięte zadanie traci rodzica,
      // więc nie zostają odwołania do usuniętych zadań ani ukryte cykle
      await lockTeamIssueHierarchy(tx, target.teamId);
      const now = new Date();
      const children = await tx.issue.findMany({
        where: { parentId: issueId, deletedAt: null },
        select: { id: true, teamId: true },
      });
      const updated = await tx.issue.updateMany({
        where: { id: issueId, deletedAt: null },
        data: { deletedAt: now, parentId: null },
      });
      if (updated.count === 0) return false;

      const eventsToInsert: PendingIssueEventRow[] = [];
      if (children.length > 0) {
        const deletedIdentifier = formatIssueIdentifier(target.team.key, target.number);
        await tx.issue.updateMany({
          where: { parentId: issueId, deletedAt: null },
          data: { parentId: null },
        });
        for (const child of children) {
          eventsToInsert.push({
            organizationId: actor.organizationId,
            teamId: child.teamId,
            issueId: child.id,
            actorAccountId: actor.accountId,
            type: "PARENT_CHANGED",
            before: { parentId: issueId, parentIdentifier: deletedIdentifier },
            after: { parentId: null, parentIdentifier: null },
            createdAt: now,
          });
        }
      }
      eventsToInsert.push({
        organizationId: actor.organizationId,
        teamId: target.teamId,
        issueId,
        actorAccountId: actor.accountId,
        type: "DELETED",
        before: { deletedAt: null },
        after: { deletedAt: now.toISOString() },
        createdAt: now,
      });
      await insertIssueEvents(tx, eventsToInsert);
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

        const now = new Date();
        const created = await tx.issueRelation.create({
          data: {
            id: uuidv7(now.getTime()),
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

        const sourceIdentifier = formatIssueIdentifier(created.issue.team.key, created.issue.number);
        const targetIdentifier = formatIssueIdentifier(created.relatedIssue.team.key, created.relatedIssue.number);
        const inverseType = created.type === "BLOCKS" ? "BLOCKED_BY" : created.type;

        await insertIssueEvents(tx, [
          {
            organizationId: actor.organizationId,
            teamId: created.issue.teamId,
            issueId: created.issue.id,
            actorAccountId: actor.accountId,
            type: "RELATION_ADDED",
            before: null,
            after: {
              relationId: created.id,
              type: created.type,
              relatedIssueId: created.relatedIssue.id,
              relatedIssueTeamId: created.relatedIssue.teamId,
              relatedIssueIdentifier: targetIdentifier,
            },
            createdAt: now,
          },
          {
            organizationId: actor.organizationId,
            teamId: created.relatedIssue.teamId,
            issueId: created.relatedIssue.id,
            actorAccountId: actor.accountId,
            type: "RELATION_ADDED",
            before: null,
            after: {
              relationId: created.id,
              type: inverseType,
              relatedIssueId: created.issue.id,
              relatedIssueTeamId: created.issue.teamId,
              relatedIssueIdentifier: sourceIdentifier,
            },
            createdAt: now,
          },
        ]);

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
      const existing = await tx.issueRelation.findUnique({
        where: { id: relationId },
        include: {
          issue: { select: { id: true, teamId: true, number: true, team: { select: { key: true } } } },
          relatedIssue: { select: { id: true, teamId: true, number: true, team: { select: { key: true } } } },
        },
      });
      if (!existing) return false;
      const deleted = await tx.issueRelation.deleteMany({ where: { id: relationId } });
      if (deleted.count === 0) return false;

      const now = new Date();
      const sourceIdentifier = formatIssueIdentifier(existing.issue.team.key, existing.issue.number);
      const targetIdentifier = formatIssueIdentifier(existing.relatedIssue.team.key, existing.relatedIssue.number);
      const inverseType = existing.type === "BLOCKS" ? "BLOCKED_BY" : existing.type;

      await insertIssueEvents(tx, [
        {
          organizationId: actor.organizationId,
          teamId: existing.issue.teamId,
          issueId: existing.issue.id,
          actorAccountId: actor.accountId,
          type: "RELATION_REMOVED",
          before: {
            relationId: existing.id,
            type: existing.type,
            relatedIssueId: existing.relatedIssue.id,
            relatedIssueTeamId: existing.relatedIssue.teamId,
            relatedIssueIdentifier: targetIdentifier,
          },
          after: null,
          createdAt: now,
        },
        {
          organizationId: actor.organizationId,
          teamId: existing.relatedIssue.teamId,
          issueId: existing.relatedIssue.id,
          actorAccountId: actor.accountId,
          type: "RELATION_REMOVED",
          before: {
            relationId: existing.id,
            type: inverseType,
            relatedIssueId: existing.issue.id,
            relatedIssueTeamId: existing.issue.teamId,
            relatedIssueIdentifier: sourceIdentifier,
          },
          after: null,
          createdAt: now,
        },
      ]);

      return true;
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

  // ── Komentarze i reakcje ──────────────────────────────────────────────────

  async listIssueComments(actor, params: ListIssueCommentsStoreParams): Promise<PaginatedResult<IssueComment>> {
    return withUser(getDb(), actor, async (tx) => {
      const conditions: Prisma.Sql[] = [Prisma.sql`c."issue_id" = ${params.issueId}::uuid`];
      if (params.cursor) {
        const ts = new Date(params.cursor.t);
        conditions.push(
          Prisma.sql`(c."created_at" > ${ts} OR (c."created_at" = ${ts} AND c."id" > ${params.cursor.id}::uuid))`,
        );
      }
      const whereSql = Prisma.join(conditions, " AND ");
      const take = params.limit + 1;

      const rows = await tx.$queryRaw<RawCommentRow[]>`
        SELECT c."id"::text AS "id",
               c."organization_id"::text AS "organizationId",
               c."team_id"::text AS "teamId",
               c."issue_id"::text AS "issueId",
               c."author_account_id"::text AS "authorAccountId",
               c."body",
               c."created_at" AS "createdAt",
               c."updated_at" AS "updatedAt",
               c."edited_at" AS "editedAt",
               c."deleted_at" AS "deletedAt"
        FROM "public"."issue_comments" c
        WHERE ${whereSql}
        ORDER BY c."created_at" ASC, c."id" ASC
        LIMIT ${take}
      `;

      const hasMore = rows.length > params.limit;
      const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
      const items = await hydrateComments(tx, pageRows, actor.accountId);
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeTimeIdCursor({ t: last.createdAt, id: last.id }) : null;
      return { items, nextCursor };
    });
  },

  async findCommentLocation(actor, issueId, commentId): Promise<CommentLocation | null> {
    return withUser(getDb(), actor, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          issueId: string;
          teamId: string;
          authorAccountId: string;
          deletedAt: Date | null;
        }[]
      >`
        SELECT c."id"::text AS "id",
               c."issue_id"::text AS "issueId",
               c."team_id"::text AS "teamId",
               c."author_account_id"::text AS "authorAccountId",
               c."deleted_at" AS "deletedAt"
        FROM "public"."issue_comments" c
        WHERE c."id" = ${commentId}::uuid AND c."issue_id" = ${issueId}::uuid
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        issueId: row.issueId,
        teamId: row.teamId,
        authorAccountId: row.authorAccountId,
        deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      };
    });
  },

  async createIssueComment(actor, input) {
    return withUser(getDb(), actor, async (tx) => {
      const activeIssue = await lockActiveIssue(tx, input.issueId);
      if (!activeIssue || activeIssue.teamId !== input.teamId) {
        throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
      }

      const existingSubRows = await tx.$queryRaw<{ accountId: string }[]>`
        SELECT "account_id"::text AS "accountId"
        FROM "public"."issue_subscribers"
        WHERE "issue_id" = ${input.issueId}::uuid
      `;
      const subscriberAccountIds = existingSubRows.map((row) => row.accountId);

      const now = new Date();
      const commentId = uuidv7(now.getTime());

      const inserted = await tx.$queryRaw<RawCommentRow[]>`
        INSERT INTO "public"."issue_comments"
          ("id", "organization_id", "team_id", "issue_id", "author_account_id", "body", "created_at", "updated_at")
        VALUES
          (${commentId}::uuid, ${actor.organizationId}::uuid, ${input.teamId}::uuid, ${input.issueId}::uuid,
           ${actor.accountId}::uuid, ${input.body}, ${now}, ${now})
        RETURNING "id"::text AS "id",
                  "organization_id"::text AS "organizationId",
                  "team_id"::text AS "teamId",
                  "issue_id"::text AS "issueId",
                  "author_account_id"::text AS "authorAccountId",
                  "body",
                  "created_at" AS "createdAt",
                  "updated_at" AS "updatedAt",
                  "edited_at" AS "editedAt",
                  "deleted_at" AS "deletedAt"
      `;

      await insertCommentMentions(tx, {
        organizationId: actor.organizationId,
        commentId,
        accountIds: input.mentionedAccountIds,
        createdAt: now,
      });

      // Autor oraz wspomniane osoby stają się obserwującymi zadania w tej samej transakcji
      await ensureIssueSubscribers(tx, {
        organizationId: actor.organizationId,
        issueId: input.issueId,
        accountIds: [actor.accountId, ...input.mentionedAccountIds],
        createdAt: now,
      });

      const fanout = computeCommentInboxFanout({
        authorAccountId: actor.accountId,
        mentionedAccountIds: input.mentionedAccountIds,
        subscriberAccountIds,
      });

      await insertInboxItems(tx, [
        ...fanout.mentionedRecipients.map((recipientAccountId) => ({
          organizationId: actor.organizationId,
          recipientAccountId,
          kind: "MENTIONED" as const,
          issueId: input.issueId,
          actorAccountId: actor.accountId,
          commentId,
          createdAt: now,
        })),
        ...fanout.commentedRecipients.map((recipientAccountId) => ({
          organizationId: actor.organizationId,
          recipientAccountId,
          kind: "COMMENTED" as const,
          issueId: input.issueId,
          actorAccountId: actor.accountId,
          commentId,
          createdAt: now,
        })),
      ]);

      const [hydrated] = await hydrateComments(tx, inserted, actor.accountId);
      if (!hydrated) {
        throw new ApiFailure(500, "INTERNAL_ERROR", "Nie udało się odczytać utworzonego komentarza");
      }
      return hydrated;
    });
  },

  async updateIssueComment(actor, input) {
    return withUser(getDb(), actor, async (tx) => {
      const existingRows = await tx.$queryRaw<RawCommentRow[]>`
        SELECT c."id"::text AS "id",
               c."organization_id"::text AS "organizationId",
               c."team_id"::text AS "teamId",
               c."issue_id"::text AS "issueId",
               c."author_account_id"::text AS "authorAccountId",
               c."body",
               c."created_at" AS "createdAt",
               c."updated_at" AS "updatedAt",
               c."edited_at" AS "editedAt",
               c."deleted_at" AS "deletedAt"
        FROM "public"."issue_comments" c
        WHERE c."id" = ${input.commentId}::uuid
          AND c."issue_id" = ${input.issueId}::uuid
          AND c."deleted_at" IS NULL
        FOR UPDATE
      `;
      const existing = existingRows[0];
      if (!existing) return null;

      const prevMentionRows = await tx.$queryRaw<{ accountId: string }[]>`
        SELECT "account_id"::text AS "accountId"
        FROM "public"."comment_mentions"
        WHERE "comment_id" = ${input.commentId}::uuid
      `;
      const prevMentioned = prevMentionRows.map((row) => row.accountId);

      const now = new Date();
      let updatedRow = existing;
      if (input.body !== existing.body) {
        const updatedRows = await tx.$queryRaw<RawCommentRow[]>`
          UPDATE "public"."issue_comments"
          SET "body" = ${input.body},
              "edited_at" = ${now},
              "updated_at" = ${now}
          WHERE "id" = ${input.commentId}::uuid AND "deleted_at" IS NULL
          RETURNING "id"::text AS "id",
                    "organization_id"::text AS "organizationId",
                    "team_id"::text AS "teamId",
                    "issue_id"::text AS "issueId",
                    "author_account_id"::text AS "authorAccountId",
                    "body",
                    "created_at" AS "createdAt",
                    "updated_at" AS "updatedAt",
                    "edited_at" AS "editedAt",
                    "deleted_at" AS "deletedAt"
        `;
        if (updatedRows[0]) {
          updatedRow = updatedRows[0];
        }
      }

      await tx.$executeRaw`
        DELETE FROM "public"."comment_mentions"
        WHERE "comment_id" = ${input.commentId}::uuid
      `;
      await insertCommentMentions(tx, {
        organizationId: actor.organizationId,
        commentId: input.commentId,
        accountIds: input.mentionedAccountIds,
        createdAt: now,
      });

      if (input.mentionedAccountIds.length > 0) {
        await ensureIssueSubscribers(tx, {
          organizationId: actor.organizationId,
          issueId: input.issueId,
          accountIds: input.mentionedAccountIds,
          createdAt: now,
        });
      }

      const newlyMentioned = computeCommentEditMentionRecipients({
        authorAccountId: actor.accountId,
        previousMentionedAccountIds: prevMentioned,
        nextMentionedAccountIds: input.mentionedAccountIds,
      });
      if (newlyMentioned.length > 0) {
        await insertInboxItems(
          tx,
          newlyMentioned.map((recipientAccountId) => ({
            organizationId: actor.organizationId,
            recipientAccountId,
            kind: "MENTIONED" as const,
            issueId: input.issueId,
            actorAccountId: actor.accountId,
            commentId: input.commentId,
            createdAt: now,
          })),
        );
      }

      const [hydrated] = await hydrateComments(tx, [updatedRow], actor.accountId);
      return hydrated ?? null;
    });
  },

  async softDeleteIssueComment(actor, issueId, commentId) {
    return withUser(getDb(), actor, async (tx) => {
      const now = new Date();
      const updated = await tx.$executeRaw`
        UPDATE "public"."issue_comments"
        SET "deleted_at" = ${now},
            "updated_at" = ${now}
        WHERE "id" = ${commentId}::uuid
          AND "issue_id" = ${issueId}::uuid
          AND "deleted_at" IS NULL
      `;
      return updated > 0;
    });
  },

  async addCommentReaction(actor, input): Promise<CommentReactionsResult | null> {
    return withUser(getDb(), actor, async (tx) => {
      const exists = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"::text AS "id"
        FROM "public"."issue_comments"
        WHERE "id" = ${input.commentId}::uuid
          AND "issue_id" = ${input.issueId}::uuid
          AND "deleted_at" IS NULL
        FOR SHARE
      `;
      if (exists.length === 0) return null;

      const now = new Date();
      const reactionId = uuidv7(now.getTime());
      await tx.$executeRaw`
        INSERT INTO "public"."comment_reactions"
          ("id", "organization_id", "comment_id", "account_id", "emoji", "created_at")
        VALUES
          (${reactionId}::uuid, ${actor.organizationId}::uuid, ${input.commentId}::uuid,
           ${actor.accountId}::uuid, ${input.emoji}, ${now})
        ON CONFLICT ("comment_id", "account_id", "emoji") DO NOTHING
      `;

      const reactionRows = await tx.$queryRaw<{ emoji: string; accountId: string }[]>`
        SELECT "emoji", "account_id"::text AS "accountId"
        FROM "public"."comment_reactions"
        WHERE "comment_id" = ${input.commentId}::uuid
      `;
      return {
        commentId: input.commentId,
        reactions: aggregateCommentReactions(reactionRows, actor.accountId),
      };
    });
  },

  async removeCommentReaction(actor, input): Promise<boolean> {
    return withUser(getDb(), actor, async (tx) => {
      const exists = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"::text AS "id"
        FROM "public"."issue_comments"
        WHERE "id" = ${input.commentId}::uuid
          AND "issue_id" = ${input.issueId}::uuid
          AND "deleted_at" IS NULL
        FOR SHARE
      `;
      if (exists.length === 0) return false;

      await tx.$executeRaw`
        DELETE FROM "public"."comment_reactions"
        WHERE "comment_id" = ${input.commentId}::uuid
          AND "account_id" = ${actor.accountId}::uuid
          AND "emoji" = ${input.emoji}
      `;
      return true;
    });
  },

  // ── Aktywność zadania (historia + komentarze chronologicznie, najstarsze pierwsze) ──

  async listIssueActivity(actor, params: ListIssueActivityStoreParams): Promise<PaginatedResult<IssueActivityItem>> {
    if (params.readableTeamIds !== "ALL" && params.readableTeamIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    return withUser(getDb(), actor, async (tx) => {
      const cursorWhere = params.cursor
        ? (() => {
            const ts = new Date(params.cursor.t);
            return Prisma.sql`WHERE (
              a."created_at" > ${ts}
              OR (a."created_at" = ${ts} AND a."sort_rank" > ${params.cursor.r})
              OR (a."created_at" = ${ts} AND a."sort_rank" = ${params.cursor.r} AND a."id" > ${params.cursor.id}::uuid)
            )`;
          })()
        : Prisma.empty;

      const take = params.limit + 1;
      const entries = await tx.$queryRaw<
        { kind: "event" | "comment"; id: string; sortRank: number; createdAt: Date }[]
      >`
        SELECT a."kind", a."id"::text AS "id", a."sort_rank" AS "sortRank", a."created_at" AS "createdAt"
        FROM (
          SELECT 'event'::text AS "kind", e."id", 0 AS "sort_rank", e."created_at"
          FROM "public"."issue_events" e
          WHERE e."issue_id" = ${params.issueId}::uuid
          UNION ALL
          SELECT 'comment'::text AS "kind", c."id", 1 AS "sort_rank", c."created_at"
          FROM "public"."issue_comments" c
          WHERE c."issue_id" = ${params.issueId}::uuid
        ) AS a
        ${cursorWhere}
        ORDER BY a."created_at" ASC, a."sort_rank" ASC, a."id" ASC
        LIMIT ${take}
      `;

      const hasMore = entries.length > params.limit;
      const pageEntries = hasMore ? entries.slice(0, params.limit) : entries;
      const eventIds = pageEntries.filter((entry) => entry.kind === "event").map((entry) => entry.id);
      const commentIds = pageEntries.filter((entry) => entry.kind === "comment").map((entry) => entry.id);

      const eventsById = new Map<string, IssueEvent>();
      if (eventIds.length > 0) {
        type RawActivityEventRow = RawEventRow & {
          resolvedRelatedTeamId: string | null;
          resolvedParentBeforeTeamId: string | null;
          resolvedParentAfterTeamId: string | null;
        };
        const eventRows = await tx.$queryRaw<RawActivityEventRow[]>`
          SELECT e."id"::text AS "id",
                 e."organization_id"::text AS "organizationId",
                 e."team_id"::text AS "teamId",
                 e."issue_id"::text AS "issueId",
                 e."actor_account_id"::text AS "actorAccountId",
                 e."type"::text AS "type",
                 e."before",
                 e."after",
                 e."created_at" AS "createdAt",
                 rel_i."team_id"::text AS "resolvedRelatedTeamId",
                 pb_i."team_id"::text AS "resolvedParentBeforeTeamId",
                 pa_i."team_id"::text AS "resolvedParentAfterTeamId"
          FROM "public"."issue_events" e
          LEFT JOIN "public"."issues" rel_i
            ON e."type" IN ('RELATION_ADDED'::"public"."IssueEventType", 'RELATION_REMOVED'::"public"."IssueEventType")
           AND rel_i."id" = NULLIF(COALESCE(e."after"->>'relatedIssueId', e."before"->>'relatedIssueId'), '')::uuid
          LEFT JOIN "public"."issues" pb_i
            ON e."type" = 'PARENT_CHANGED'::"public"."IssueEventType"
           AND pb_i."id" = NULLIF(e."before"->>'parentId', '')::uuid
          LEFT JOIN "public"."issues" pa_i
            ON e."type" = 'PARENT_CHANGED'::"public"."IssueEventType"
           AND pa_i."id" = NULLIF(e."after"->>'parentId', '')::uuid
          WHERE e."id" = ANY(${eventIds}::uuid[])
        `;
        for (const row of eventRows) {
          const event = redactIssueEvent(serializeIssueEvent(row), params.readableTeamIds, {
            relatedIssueTeamId: row.resolvedRelatedTeamId,
            parentBeforeTeamId: row.resolvedParentBeforeTeamId,
            parentAfterTeamId: row.resolvedParentAfterTeamId,
          });
          eventsById.set(row.id, event);
        }
      }

      const commentsById = new Map<string, IssueComment>();
      if (commentIds.length > 0) {
        const commentRows = await tx.$queryRaw<RawCommentRow[]>`
          SELECT "id"::text AS "id",
                 "organization_id"::text AS "organizationId",
                 "team_id"::text AS "teamId",
                 "issue_id"::text AS "issueId",
                 "author_account_id"::text AS "authorAccountId",
                 "body",
                 "created_at" AS "createdAt",
                 "updated_at" AS "updatedAt",
                 "edited_at" AS "editedAt",
                 "deleted_at" AS "deletedAt"
          FROM "public"."issue_comments"
          WHERE "id" = ANY(${commentIds}::uuid[])
        `;
        const hydrated = await hydrateComments(tx, commentRows, actor.accountId);
        for (const comment of hydrated) {
          commentsById.set(comment.id, comment);
        }
      }

      const items: IssueActivityItem[] = [];
      for (const entry of pageEntries) {
        if (entry.kind === "event") {
          const event = eventsById.get(entry.id);
          if (event) {
            items.push({ kind: "event", id: event.id, createdAt: event.createdAt, event });
          }
        } else {
          const comment = commentsById.get(entry.id);
          if (comment) {
            items.push({ kind: "comment", id: comment.id, createdAt: comment.createdAt, comment });
          }
        }
      }

      const lastEntry = pageEntries[pageEntries.length - 1];
      const nextCursor =
        hasMore && lastEntry
          ? encodeActivityCursor({
              t: lastEntry.createdAt.toISOString(),
              r: lastEntry.sortRank === 0 ? 0 : 1,
              id: lastEntry.id,
            })
          : null;

      return { items, nextCursor };
    });
  },

  // ── Obserwowanie zadania ──────────────────────────────────────────────────

  async subscribeIssue(actor, issueId): Promise<IssueSubscription | null> {
    return withUser(getDb(), actor, async (tx) => {
      const active = await lockActiveIssue(tx, issueId);
      if (!active) return null;
      await ensureIssueSubscribers(tx, {
        organizationId: actor.organizationId,
        issueId,
        accountIds: [actor.accountId],
        createdAt: new Date(),
      });
      return { issueId, isSubscribed: true };
    });
  },

  async unsubscribeIssue(actor, issueId): Promise<boolean> {
    return withUser(getDb(), actor, async (tx) => {
      const active = await lockActiveIssue(tx, issueId);
      if (!active) return false;
      await tx.$executeRaw`
        DELETE FROM "public"."issue_subscribers"
        WHERE "issue_id" = ${issueId}::uuid AND "account_id" = ${actor.accountId}::uuid
      `;
      return true;
    });
  },

  // ── Skrzynka powiadomień ──────────────────────────────────────────────────

  async listInboxItems(actor, params: ListInboxStoreParams): Promise<PaginatedResult<InboxItem>> {
    if (params.readableTeamIds !== "ALL" && params.readableTeamIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    return withUser(getDb(), actor, async (tx) => {
      const conditions: Prisma.Sql[] = [
        Prisma.sql`ii."recipient_account_id" = ${actor.accountId}::uuid`,
        Prisma.sql`ii."archived_at" IS NULL`,
        Prisma.sql`i."deleted_at" IS NULL`,
        Prisma.sql`t."archived_at" IS NULL`,
        Prisma.sql`(ii."comment_id" IS NULL OR c."deleted_at" IS NULL)`,
      ];
      if (params.readableTeamIds !== "ALL") {
        conditions.push(Prisma.sql`i."team_id" = ANY(${params.readableTeamIds}::uuid[])`);
      }
      if (params.filter === "unread") {
        conditions.push(Prisma.sql`ii."read_at" IS NULL`);
      }
      if (params.cursor) {
        const ts = new Date(params.cursor.t);
        conditions.push(
          Prisma.sql`(ii."created_at" < ${ts} OR (ii."created_at" = ${ts} AND ii."id" < ${params.cursor.id}::uuid))`,
        );
      }

      const whereSql = Prisma.join(conditions, " AND ");
      const take = params.limit + 1;

      const rows = await tx.$queryRaw<RawInboxRow[]>`
        SELECT ii."id"::text AS "id",
               ii."organization_id"::text AS "organizationId",
               ii."recipient_account_id"::text AS "recipientAccountId",
               ii."kind"::text AS "kind",
               ii."issue_id"::text AS "issueId",
               ii."actor_account_id"::text AS "actorAccountId",
               ii."comment_id"::text AS "commentId",
               c."body" AS "commentBody",
               c."deleted_at" AS "commentDeletedAt",
               ii."created_at" AS "createdAt",
               ii."read_at" AS "readAt",
               ii."archived_at" AS "archivedAt",
               i."team_id"::text AS "issueTeamId",
               i."number" AS "issueNumber",
               i."title" AS "issueTitle",
               t."key" AS "teamKey",
               s."id"::text AS "stateId",
               s."name" AS "stateName",
               s."category"::text AS "stateCategory",
               s."color" AS "stateColor",
               s."position" AS "statePosition"
        FROM "public"."inbox_items" ii
        JOIN "public"."issues" i ON i."id" = ii."issue_id"
        JOIN "public"."teams" t ON t."id" = i."team_id"
        JOIN "public"."workflow_states" s ON s."id" = i."state_id"
        LEFT JOIN "public"."issue_comments" c ON c."id" = ii."comment_id"
        WHERE ${whereSql}
        ORDER BY ii."created_at" DESC, ii."id" DESC
        LIMIT ${take}
      `;

      const hasMore = rows.length > params.limit;
      const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
      const items = await hydrateInboxRows(tx, pageRows);
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeTimeIdCursor({ t: last.createdAt, id: last.id }) : null;
      return { items, nextCursor };
    });
  },

  async getInboxUnreadCount(actor, readableTeamIds): Promise<number> {
    if (readableTeamIds !== "ALL" && readableTeamIds.length === 0) {
      return 0;
    }
    return withUser(getDb(), actor, async (tx) => {
      const teamFilter =
        readableTeamIds === "ALL" ? Prisma.sql`TRUE` : Prisma.sql`i."team_id" = ANY(${readableTeamIds}::uuid[])`;
      const rows = await tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS "count"
        FROM "public"."inbox_items" ii
        JOIN "public"."issues" i ON i."id" = ii."issue_id"
        JOIN "public"."teams" t ON t."id" = i."team_id"
        LEFT JOIN "public"."issue_comments" c ON c."id" = ii."comment_id"
        WHERE ii."recipient_account_id" = ${actor.accountId}::uuid
          AND ii."read_at" IS NULL
          AND ii."archived_at" IS NULL
          AND i."deleted_at" IS NULL
          AND t."archived_at" IS NULL
          AND (ii."comment_id" IS NULL OR c."deleted_at" IS NULL)
          AND ${teamFilter}
      `;
      return rows[0]?.count ?? 0;
    });
  },

  async updateInboxItem(actor, params: UpdateInboxItemStoreParams): Promise<InboxItem | null> {
    if (params.readableTeamIds !== "ALL" && params.readableTeamIds.length === 0) {
      return null;
    }
    return withUser(getDb(), actor, async (tx) => {
      const teamFilter =
        params.readableTeamIds === "ALL"
          ? Prisma.sql`TRUE`
          : Prisma.sql`i."team_id" = ANY(${params.readableTeamIds}::uuid[])`;
      const existingRows = await tx.$queryRaw<RawInboxRow[]>`
        SELECT ii."id"::text AS "id",
               ii."organization_id"::text AS "organizationId",
               ii."recipient_account_id"::text AS "recipientAccountId",
               ii."kind"::text AS "kind",
               ii."issue_id"::text AS "issueId",
               ii."actor_account_id"::text AS "actorAccountId",
               ii."comment_id"::text AS "commentId",
               c."body" AS "commentBody",
               c."deleted_at" AS "commentDeletedAt",
               ii."created_at" AS "createdAt",
               ii."read_at" AS "readAt",
               ii."archived_at" AS "archivedAt",
               i."team_id"::text AS "issueTeamId",
               i."number" AS "issueNumber",
               i."title" AS "issueTitle",
               t."key" AS "teamKey",
               s."id"::text AS "stateId",
               s."name" AS "stateName",
               s."category"::text AS "stateCategory",
               s."color" AS "stateColor",
               s."position" AS "statePosition"
        FROM "public"."inbox_items" ii
        JOIN "public"."issues" i ON i."id" = ii."issue_id"
        JOIN "public"."teams" t ON t."id" = i."team_id"
        JOIN "public"."workflow_states" s ON s."id" = i."state_id"
        LEFT JOIN "public"."issue_comments" c ON c."id" = ii."comment_id"
        WHERE ii."id" = ${params.itemId}::uuid
          AND ii."recipient_account_id" = ${actor.accountId}::uuid
          AND i."deleted_at" IS NULL
          AND t."archived_at" IS NULL
          AND (ii."comment_id" IS NULL OR c."deleted_at" IS NULL)
          AND ${teamFilter}
        FOR UPDATE OF ii
      `;
      const existing = existingRows[0];
      if (!existing) return null;

      const now = new Date();
      const nextReadAt =
        params.read === true ? (existing.readAt ?? now) : params.read === false ? null : existing.readAt;
      const nextArchivedAt =
        params.archived === true
          ? (existing.archivedAt ?? now)
          : params.archived === false
            ? null
            : existing.archivedAt;

      await tx.$executeRaw`
        UPDATE "public"."inbox_items"
        SET "read_at" = ${nextReadAt},
            "archived_at" = ${nextArchivedAt}
        WHERE "id" = ${params.itemId}::uuid
          AND "recipient_account_id" = ${actor.accountId}::uuid
      `;

      const [hydrated] = await hydrateInboxRows(tx, [{ ...existing, readAt: nextReadAt, archivedAt: nextArchivedAt }]);
      return hydrated ?? null;
    });
  },

  async markAllInboxRead(actor, readableTeamIds): Promise<number> {
    if (readableTeamIds !== "ALL" && readableTeamIds.length === 0) {
      return 0;
    }
    return withUser(getDb(), actor, async (tx) => {
      const teamFilter =
        readableTeamIds === "ALL" ? Prisma.sql`TRUE` : Prisma.sql`i."team_id" = ANY(${readableTeamIds}::uuid[])`;
      const now = new Date();
      const updated = await tx.$executeRaw`
        UPDATE "public"."inbox_items" ii
        SET "read_at" = ${now}
        FROM "public"."issues" i, "public"."teams" t
        WHERE ii."issue_id" = i."id"
          AND i."team_id" = t."id"
          AND ii."recipient_account_id" = ${actor.accountId}::uuid
          AND ii."read_at" IS NULL
          AND ii."archived_at" IS NULL
          AND i."deleted_at" IS NULL
          AND t."archived_at" IS NULL
          AND (
            ii."comment_id" IS NULL
            OR EXISTS (
              SELECT 1 FROM "public"."issue_comments" c
              WHERE c."id" = ii."comment_id" AND c."deleted_at" IS NULL
            )
          )
          AND ${teamFilter}
      `;
      return updated;
    });
  },

  // ── Załączniki i zużycie miejsca firmy (etap 2b) ──────────────────────────

  async listIssueAttachments(
    actor,
    params: ListIssueAttachmentsStoreParams,
  ): Promise<PaginatedResult<AttachmentRecord>> {
    return withUser(getDb(), actor, async (tx) => {
      const conditions: Prisma.Sql[] = [
        Prisma.sql`a."issue_id" = ${params.issueId}::uuid`,
        Prisma.sql`a."deleted_at" IS NULL`,
        Prisma.sql`i."deleted_at" IS NULL`,
        Prisma.sql`t."archived_at" IS NULL`,
      ];
      if (params.cursor) {
        const ts = new Date(params.cursor.t);
        conditions.push(
          Prisma.sql`(a."created_at" < ${ts} OR (a."created_at" = ${ts} AND a."id" < ${params.cursor.id}::uuid))`,
        );
      }

      const whereSql = Prisma.join(conditions, " AND ");
      const take = params.limit + 1;

      const rows = await tx.$queryRaw<
        {
          id: string;
          organizationId: string;
          teamId: string;
          issueId: string;
          uploaderAccountId: string;
          fileName: string;
          contentType: string;
          sizeBytes: number;
          sha256: string;
          storageKey: string;
          createdAt: Date;
        }[]
      >`
        SELECT a."id"::text AS "id",
               a."organization_id"::text AS "organizationId",
               a."team_id"::text AS "teamId",
               a."issue_id"::text AS "issueId",
               a."uploader_account_id"::text AS "uploaderAccountId",
               a."file_name" AS "fileName",
               a."content_type" AS "contentType",
               a."size_bytes" AS "sizeBytes",
               a."sha256",
               a."storage_key" AS "storageKey",
               a."created_at" AS "createdAt"
        FROM "public"."issue_attachments" a
        JOIN "public"."issues" i ON i."id" = a."issue_id"
        JOIN "public"."teams" t ON t."id" = i."team_id"
        WHERE ${whereSql}
        ORDER BY a."created_at" DESC, a."id" DESC
        LIMIT ${take}
      `;

      const hasMore = rows.length > params.limit;
      const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
      const items: AttachmentRecord[] = pageRows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        teamId: row.teamId,
        issueId: row.issueId,
        uploaderAccountId: row.uploaderAccountId,
        fileName: row.fileName,
        contentType: row.contentType as AttachmentContentType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        storageKey: row.storageKey,
        createdAt: row.createdAt.toISOString(),
      }));
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeTimeIdCursor({ t: last.createdAt, id: last.id }) : null;
      return { items, nextCursor };
    });
  },

  async createIssueAttachment(actor, input: CreateIssueAttachmentStoreInput): Promise<AttachmentRecord> {
    return withUser(getDb(), actor, async (tx) => {
      // 1. Blokada wiersza zadania FOR UPDATE (zadanie nadal istnieje i nie jest usunięte)
      const issueRows = await tx.$queryRaw<{ id: string; teamId: string }[]>`
        SELECT i."id"::text AS "id", i."team_id"::text AS "teamId"
        FROM "public"."issues" i
        JOIN "public"."teams" t ON t."id" = i."team_id"
        WHERE i."id" = ${input.issueId}::uuid
          AND i."deleted_at" IS NULL
          AND t."archived_at" IS NULL
        FOR UPDATE OF i
      `;
      const lockedIssue = issueRows[0];
      if (!lockedIssue || lockedIssue.teamId !== input.teamId) {
        throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
      }

      // 2. Blokada doradcza na firmę serializuje sprawdzenie limitu miejsca przy równoległych uploadach
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('kivotasks:storage:' || ${actor.organizationId}::uuid::text, 0))
      `;

      // 3. Aktualne zużycie miejsca firmy (korzysta z indeksu częściowego issue_attachments_active_usage_idx)
      const usageRows = await tx.$queryRaw<{ usedBytes: bigint }[]>`
        SELECT COALESCE(SUM("size_bytes"), 0)::bigint AS "usedBytes"
        FROM "public"."issue_attachments"
        WHERE "organization_id" = ${actor.organizationId}::uuid
          AND "deleted_at" IS NULL
      `;
      const usedBytes = Number(usageRows[0]?.usedBytes ?? 0n);
      if (usedBytes + input.sizeBytes > input.quotaBytes) {
        throw new ApiFailure(409, "STORAGE_QUOTA_EXCEEDED", "Brak miejsca na pliki firmy");
      }

      const now = new Date();
      const inserted = await tx.$queryRaw<
        {
          id: string;
          organizationId: string;
          teamId: string;
          issueId: string;
          uploaderAccountId: string;
          fileName: string;
          contentType: string;
          sizeBytes: number;
          sha256: string;
          storageKey: string;
          createdAt: Date;
        }[]
      >`
        INSERT INTO "public"."issue_attachments"
          ("id", "organization_id", "team_id", "issue_id", "uploader_account_id",
           "file_name", "content_type", "size_bytes", "sha256", "storage_key", "created_at")
        VALUES
          (${input.id}::uuid, ${actor.organizationId}::uuid, ${input.teamId}::uuid, ${input.issueId}::uuid,
           ${actor.accountId}::uuid, ${input.fileName}, ${input.contentType}, ${input.sizeBytes},
           ${input.sha256}, ${input.storageKey}, ${now})
        RETURNING "id"::text AS "id",
                  "organization_id"::text AS "organizationId",
                  "team_id"::text AS "teamId",
                  "issue_id"::text AS "issueId",
                  "uploader_account_id"::text AS "uploaderAccountId",
                  "file_name" AS "fileName",
                  "content_type" AS "contentType",
                  "size_bytes" AS "sizeBytes",
                  "sha256",
                  "storage_key" AS "storageKey",
                  "created_at" AS "createdAt"
      `;
      const row = inserted[0];
      if (!row) {
        throw new ApiFailure(500, "INTERNAL_ERROR", "Nie udało się zapisać załącznika");
      }

      await insertIssueEvents(tx, [
        {
          organizationId: actor.organizationId,
          teamId: input.teamId,
          issueId: input.issueId,
          actorAccountId: actor.accountId,
          type: "ATTACHMENT_ADDED",
          before: null,
          after: {
            attachmentId: row.id,
            fileName: row.fileName,
            sizeBytes: row.sizeBytes,
            contentType: row.contentType,
          },
          createdAt: now,
        },
      ]);

      return {
        id: row.id,
        organizationId: row.organizationId,
        teamId: row.teamId,
        issueId: row.issueId,
        uploaderAccountId: row.uploaderAccountId,
        fileName: row.fileName,
        contentType: row.contentType as AttachmentContentType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        storageKey: row.storageKey,
        createdAt: row.createdAt.toISOString(),
      };
    });
  },

  async findAttachmentById(actor, attachmentId): Promise<AttachmentRecord | null> {
    return withUser(getDb(), actor, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          organizationId: string;
          teamId: string;
          issueId: string;
          uploaderAccountId: string;
          fileName: string;
          contentType: string;
          sizeBytes: number;
          sha256: string;
          storageKey: string;
          createdAt: Date;
        }[]
      >`
        SELECT a."id"::text AS "id",
               a."organization_id"::text AS "organizationId",
               a."team_id"::text AS "teamId",
               a."issue_id"::text AS "issueId",
               a."uploader_account_id"::text AS "uploaderAccountId",
               a."file_name" AS "fileName",
               a."content_type" AS "contentType",
               a."size_bytes" AS "sizeBytes",
               a."sha256",
               a."storage_key" AS "storageKey",
               a."created_at" AS "createdAt"
        FROM "public"."issue_attachments" a
        JOIN "public"."issues" i ON i."id" = a."issue_id"
        JOIN "public"."teams" t ON t."id" = i."team_id"
        WHERE a."id" = ${attachmentId}::uuid
          AND a."deleted_at" IS NULL
          AND i."deleted_at" IS NULL
          AND t."archived_at" IS NULL
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        organizationId: row.organizationId,
        teamId: row.teamId,
        issueId: row.issueId,
        uploaderAccountId: row.uploaderAccountId,
        fileName: row.fileName,
        contentType: row.contentType as AttachmentContentType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        storageKey: row.storageKey,
        createdAt: row.createdAt.toISOString(),
      };
    });
  },

  async softDeleteIssueAttachment(actor, attachmentId): Promise<{ storageKey: string } | null> {
    return withUser(getDb(), actor, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          teamId: string;
          issueId: string;
          fileName: string;
          contentType: string;
          sizeBytes: number;
          storageKey: string;
        }[]
      >`
        SELECT a."id"::text AS "id",
               a."team_id"::text AS "teamId",
               a."issue_id"::text AS "issueId",
               a."file_name" AS "fileName",
               a."content_type" AS "contentType",
               a."size_bytes" AS "sizeBytes",
               a."storage_key" AS "storageKey"
        FROM "public"."issue_attachments" a
        JOIN "public"."issues" i ON i."id" = a."issue_id"
        JOIN "public"."teams" t ON t."id" = i."team_id"
        WHERE a."id" = ${attachmentId}::uuid
          AND a."deleted_at" IS NULL
          AND i."deleted_at" IS NULL
          AND t."archived_at" IS NULL
        FOR UPDATE OF a
      `;
      const row = rows[0];
      if (!row) return null;

      const now = new Date();
      await tx.$executeRaw`
        UPDATE "public"."issue_attachments"
        SET "deleted_at" = ${now}
        WHERE "id" = ${row.id}::uuid
          AND "deleted_at" IS NULL
      `;

      await insertIssueEvents(tx, [
        {
          organizationId: actor.organizationId,
          teamId: row.teamId,
          issueId: row.issueId,
          actorAccountId: actor.accountId,
          type: "ATTACHMENT_REMOVED",
          before: {
            attachmentId: row.id,
            fileName: row.fileName,
            sizeBytes: row.sizeBytes,
            contentType: row.contentType,
          },
          after: null,
          createdAt: now,
        },
      ]);

      return { storageKey: row.storageKey };
    });
  },

  async getOrganizationStorageUsedBytes(actor): Promise<number> {
    return withUser(getDb(), actor, async (tx) => {
      const rows = await tx.$queryRaw<{ usedBytes: bigint }[]>`
        SELECT COALESCE(SUM("size_bytes"), 0)::bigint AS "usedBytes"
        FROM "public"."issue_attachments"
        WHERE "organization_id" = ${actor.organizationId}::uuid
          AND "deleted_at" IS NULL
      `;
      return Number(rows[0]?.usedBytes ?? 0n);
    });
  },
};
