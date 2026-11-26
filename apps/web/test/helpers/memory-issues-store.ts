import {
  DEFAULT_WORKFLOW_STATES,
  type ColorToken,
  type IssueDetail,
  type IssueListItem,
  type IssueReference,
  type IssueRelationType,
  type IssueRelationView,
  type IssueSort,
  type Label,
  type PaginatedResult,
  type Team,
  type WorkflowState,
  type WorkflowStateCategory,
} from "@kivotasks/contracts";
import { uuidv7 } from "@kivotasks/db";
import { ApiFailure } from "@/server/api";
import {
  buildIssueCursorPayload,
  computeStateTimestamps,
  encodeIssueCursor,
  formatIssueIdentifier,
  prioritySortRank,
  toIssueRelationView,
  wouldCreateParentCycle,
  type IssueCursorPayload,
} from "@/server/issue-helpers";
import type { IssuesStore, ListIssuesStoreParams, SearchIssuesStoreParams } from "@/server/issues-store";
import type { TeamFilterScope } from "@/server/permissions";

interface TeamRec {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  nextIssueNumber: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

interface StateRec {
  id: string;
  organizationId: string;
  teamId: string;
  name: string;
  category: WorkflowStateCategory;
  color: ColorToken;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

interface LabelRec {
  id: string;
  organizationId: string;
  teamId: string;
  name: string;
  color: ColorToken;
  createdAt: Date;
  archivedAt: Date | null;
}

interface IssueRec {
  id: string;
  organizationId: string;
  teamId: string;
  number: number;
  title: string;
  description: string | null;
  stateId: string;
  priority: number;
  assigneeAccountId: string | null;
  creatorAccountId: string;
  dueDate: string | null;
  estimate: number | null;
  parentId: string | null;
  sortOrder: number;
  startedAt: Date | null;
  completedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface RelationRec {
  id: string;
  organizationId: string;
  issueId: string;
  relatedIssueId: string;
  type: IssueRelationType;
  createdAt: Date;
}

function teamAllowed(scope: TeamFilterScope, teamId: string): boolean {
  return scope === "ALL" || scope.includes(teamId);
}

function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function parsePrefixTokens(tsQuery: string): string[] {
  return tsQuery
    .split("&")
    .map((part) => part.trim().replace(/:\*$/, ""))
    .filter(Boolean);
}

function computeFtsScore(issue: IssueRec, tsQuery: string): number {
  const queryTokens = parsePrefixTokens(tsQuery);
  if (queryTokens.length === 0) return 0;
  const titleTokens = tokenize(issue.title);
  const descTokens = tokenize(issue.description);

  let score = 0;
  for (const qt of queryTokens) {
    const inTitle = titleTokens.some((token) => token.startsWith(qt));
    const inDesc = descTokens.some((token) => token.startsWith(qt));
    if (!inTitle && !inDesc) return 0;
    if (inTitle) score += 1.0;
    if (inDesc) score += 0.4;
  }
  return score;
}

function compareDescStr(a: string, b: string): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

function compareAscStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIssuesBySort(a: IssueRec, b: IssueRec, sort: IssueSort): number {
  switch (sort) {
    case "updated": {
      const byUpdated = b.updatedAt.getTime() - a.updatedAt.getTime();
      return byUpdated !== 0 ? byUpdated : compareDescStr(a.id, b.id);
    }
    case "created": {
      const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
      return byCreated !== 0 ? byCreated : compareDescStr(a.id, b.id);
    }
    case "priority": {
      const byRank = prioritySortRank(a.priority) - prioritySortRank(b.priority);
      if (byRank !== 0) return byRank;
      const byUpdated = b.updatedAt.getTime() - a.updatedAt.getTime();
      return byUpdated !== 0 ? byUpdated : compareDescStr(a.id, b.id);
    }
    case "dueDate": {
      if (a.dueDate !== b.dueDate) {
        if (a.dueDate === null) return 1;
        if (b.dueDate === null) return -1;
        return compareAscStr(a.dueDate, b.dueDate);
      }
      const byUpdated = b.updatedAt.getTime() - a.updatedAt.getTime();
      return byUpdated !== 0 ? byUpdated : compareDescStr(a.id, b.id);
    }
    case "manual": {
      const byOrder = a.sortOrder - b.sortOrder;
      return byOrder !== 0 ? byOrder : compareAscStr(a.id, b.id);
    }
  }
}

function passesCursor(issue: IssueRec, cursor: IssueCursorPayload): boolean {
  const updatedMs = issue.updatedAt.getTime();
  const createdMs = issue.createdAt.getTime();
  switch (cursor.s) {
    case "updated": {
      const cursorMs = Date.parse(cursor.u);
      return updatedMs < cursorMs || (updatedMs === cursorMs && issue.id < cursor.id);
    }
    case "created": {
      const cursorMs = Date.parse(cursor.c);
      return createdMs < cursorMs || (createdMs === cursorMs && issue.id < cursor.id);
    }
    case "priority": {
      const rank = prioritySortRank(issue.priority);
      const cursorMs = Date.parse(cursor.u);
      return (
        rank > cursor.p ||
        (rank === cursor.p && updatedMs < cursorMs) ||
        (rank === cursor.p && updatedMs === cursorMs && issue.id < cursor.id)
      );
    }
    case "dueDate": {
      const cursorMs = Date.parse(cursor.u);
      if (cursor.d === null) {
        return issue.dueDate === null && (updatedMs < cursorMs || (updatedMs === cursorMs && issue.id < cursor.id));
      }
      return (
        issue.dueDate === null ||
        issue.dueDate > cursor.d ||
        (issue.dueDate === cursor.d && updatedMs < cursorMs) ||
        (issue.dueDate === cursor.d && updatedMs === cursorMs && issue.id < cursor.id)
      );
    }
    case "manual":
      return issue.sortOrder > cursor.o || (issue.sortOrder === cursor.o && issue.id > cursor.id);
  }
}

/**
 * Pamięciowa implementacja `IssuesStore` do testów jednostkowych i tras bez PostgreSQL.
 * Zachowuje pełną separację firm (`actor.organizationId`) i identyczne reguły biznesowe jak wariant Prisma.
 */
export function createMemoryIssuesStore(): IssuesStore & { reset(): void } {
  const teams = new Map<string, TeamRec>();
  const states = new Map<string, StateRec>();
  const labels = new Map<string, LabelRec>();
  const issues = new Map<string, IssueRec>();
  const issueLabels = new Map<string, Set<string>>();
  const relations = new Map<string, RelationRec>();

  let clockMs = Date.parse("2026-11-26T12:00:00.000Z");
  const nextNow = () => {
    clockMs += 10;
    return new Date(clockMs);
  };

  function toTeam(rec: TeamRec): Team {
    return {
      id: rec.id,
      organizationId: rec.organizationId,
      key: rec.key,
      name: rec.name,
      nextIssueNumber: rec.nextIssueNumber,
      createdAt: rec.createdAt.toISOString(),
      updatedAt: rec.updatedAt.toISOString(),
      archivedAt: rec.archivedAt ? rec.archivedAt.toISOString() : null,
    };
  }

  function toState(rec: StateRec): WorkflowState {
    return {
      id: rec.id,
      organizationId: rec.organizationId,
      teamId: rec.teamId,
      name: rec.name,
      category: rec.category,
      color: rec.color,
      position: rec.position,
      createdAt: rec.createdAt.toISOString(),
      updatedAt: rec.updatedAt.toISOString(),
    };
  }

  function toLabel(rec: LabelRec): Label {
    return {
      id: rec.id,
      organizationId: rec.organizationId,
      teamId: rec.teamId,
      name: rec.name,
      color: rec.color,
      createdAt: rec.createdAt.toISOString(),
    };
  }

  function toReference(rec: IssueRec): IssueReference {
    const team = teams.get(rec.teamId)!;
    const state = states.get(rec.stateId)!;
    return {
      id: rec.id,
      teamId: rec.teamId,
      identifier: formatIssueIdentifier(team.key, rec.number),
      number: rec.number,
      title: rec.title,
      priority: rec.priority,
      state: {
        id: state.id,
        name: state.name,
        category: state.category,
        color: state.color,
        position: state.position,
      },
      assigneeAccountId: rec.assigneeAccountId,
    };
  }

  function toListItem(rec: IssueRec): IssueListItem {
    const team = teams.get(rec.teamId)!;
    const state = states.get(rec.stateId)!;
    const attached = [...(issueLabels.get(rec.id) ?? [])]
      .map((labelId) => labels.get(labelId))
      .filter((label): label is LabelRec => Boolean(label && label.archivedAt === null))
      .sort((a, b) => a.name.localeCompare(b.name, "pl"))
      .map((label) => ({ id: label.id, name: label.name, color: label.color }));

    return {
      id: rec.id,
      organizationId: rec.organizationId,
      teamId: rec.teamId,
      identifier: formatIssueIdentifier(team.key, rec.number),
      number: rec.number,
      title: rec.title,
      stateId: rec.stateId,
      state: {
        id: state.id,
        name: state.name,
        category: state.category,
        color: state.color,
        position: state.position,
      },
      priority: rec.priority,
      assigneeAccountId: rec.assigneeAccountId,
      creatorAccountId: rec.creatorAccountId,
      dueDate: rec.dueDate,
      estimate: rec.estimate,
      parentId: rec.parentId,
      sortOrder: rec.sortOrder,
      labels: attached,
      startedAt: rec.startedAt ? rec.startedAt.toISOString() : null,
      completedAt: rec.completedAt ? rec.completedAt.toISOString() : null,
      canceledAt: rec.canceledAt ? rec.canceledAt.toISOString() : null,
      createdAt: rec.createdAt.toISOString(),
      updatedAt: rec.updatedAt.toISOString(),
    };
  }

  function toDetail(rec: IssueRec, readableTeamIds: TeamFilterScope): IssueDetail | null {
    if (rec.deletedAt !== null || !teamAllowed(readableTeamIds, rec.teamId)) return null;
    const team = teams.get(rec.teamId);
    if (!team || team.archivedAt !== null) return null;

    const parentRec = rec.parentId ? issues.get(rec.parentId) : null;
    const parent = parentRec && parentRec.deletedAt === null ? toReference(parentRec) : null;

    const children = [...issues.values()]
      .filter(
        (item) => item.organizationId === rec.organizationId && item.parentId === rec.id && item.deletedAt === null,
      )
      .sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.number - b.number))
      .map(toReference);

    const viewRelations: IssueRelationView[] = [];
    for (const rel of relations.values()) {
      if (rel.organizationId !== rec.organizationId) continue;
      if (rel.issueId !== rec.id && rel.relatedIssueId !== rec.id) continue;
      const otherId = rel.issueId === rec.id ? rel.relatedIssueId : rel.issueId;
      const other = issues.get(otherId);
      if (!other || other.deletedAt !== null) continue;
      if (!teamAllowed(readableTeamIds, other.teamId)) continue;
      viewRelations.push(toIssueRelationView(rec.id, rel, toReference(other)));
    }
    viewRelations.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id),
    );

    return {
      ...toListItem(rec),
      description: rec.description,
      parent,
      children,
      relations: viewRelations,
    };
  }

  return {
    reset() {
      teams.clear();
      states.clear();
      labels.clear();
      issues.clear();
      issueLabels.clear();
      relations.clear();
      clockMs = Date.parse("2026-11-26T12:00:00.000Z");
    },

    async listTeams(actor, scope) {
      if (scope !== "ALL" && scope.length === 0) return [];
      return [...teams.values()]
        .filter(
          (team) =>
            team.organizationId === actor.organizationId && team.archivedAt === null && teamAllowed(scope, team.id),
        )
        .sort((a, b) => a.name.localeCompare(b.name, "pl") || a.key.localeCompare(b.key))
        .map(toTeam);
    },

    async findTeamById(actor, teamId) {
      const team = teams.get(teamId);
      if (!team || team.organizationId !== actor.organizationId || team.archivedAt !== null) return null;
      return toTeam(team);
    },

    async listExistingTeamIds(actor) {
      return [...teams.values()].filter((team) => team.organizationId === actor.organizationId).map((team) => team.id);
    },

    async createTeamWithDefaultStates(actor, input) {
      if (teams.has(input.id)) {
        throw new ApiFailure(409, "CONFLICT", "Ta jednostka organizacyjna jest już zespołem w KivoTasks");
      }
      for (const existing of teams.values()) {
        if (existing.organizationId === actor.organizationId && existing.key === input.key) {
          throw new ApiFailure(409, "CONFLICT", "Zespół o tym kluczu już istnieje w firmie");
        }
      }
      const now = nextNow();
      const team: TeamRec = {
        id: input.id,
        organizationId: actor.organizationId,
        key: input.key,
        name: input.name,
        nextIssueNumber: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      teams.set(team.id, team);
      for (const def of DEFAULT_WORKFLOW_STATES) {
        const stateNow = nextNow();
        const state: StateRec = {
          id: uuidv7(stateNow.getTime()),
          organizationId: actor.organizationId,
          teamId: team.id,
          name: def.name,
          category: def.category,
          color: def.color,
          position: def.position,
          createdAt: stateNow,
          updatedAt: stateNow,
          archivedAt: null,
        };
        states.set(state.id, state);
      }
      return toTeam(team);
    },

    async updateTeamKey(actor, teamId, key) {
      const team = teams.get(teamId);
      if (!team || team.organizationId !== actor.organizationId || team.archivedAt !== null) return null;
      if (team.key !== key) {
        for (const other of teams.values()) {
          if (other.organizationId === actor.organizationId && other.id !== teamId && other.key === key) {
            throw new ApiFailure(409, "CONFLICT", "Zespół o tym kluczu już istnieje w firmie");
          }
        }
        team.key = key;
        team.updatedAt = nextNow();
      }
      return toTeam(team);
    },

    async updateTeamNames(actor, updates) {
      for (const update of updates) {
        const team = teams.get(update.id);
        if (team && team.organizationId === actor.organizationId && team.archivedAt === null) {
          team.name = update.name;
          team.updatedAt = nextNow();
        }
      }
    },

    async listWorkflowStates(actor, teamId) {
      return [...states.values()]
        .filter(
          (state) =>
            state.organizationId === actor.organizationId && state.teamId === teamId && state.archivedAt === null,
        )
        .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())
        .map(toState);
    },

    async createWorkflowState(actor, input) {
      const teamStates = [...states.values()].filter(
        (s) => s.organizationId === actor.organizationId && s.teamId === input.teamId && s.archivedAt === null,
      );
      const maxPos = teamStates.reduce((acc, s) => Math.max(acc, s.position), -1);
      const now = nextNow();
      const rec: StateRec = {
        id: uuidv7(now.getTime()),
        organizationId: actor.organizationId,
        teamId: input.teamId,
        name: input.name,
        category: input.category,
        color: input.color,
        position: input.position ?? maxPos + 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      states.set(rec.id, rec);
      return toState(rec);
    },

    async updateWorkflowState(actor, teamId, stateId, input) {
      const rec = states.get(stateId);
      if (!rec || rec.organizationId !== actor.organizationId || rec.teamId !== teamId || rec.archivedAt !== null) {
        return null;
      }
      const leavingInitial =
        (rec.category === "BACKLOG" || rec.category === "UNSTARTED") &&
        input.category !== undefined &&
        input.category !== "BACKLOG" &&
        input.category !== "UNSTARTED";
      if (leavingInitial) {
        const remaining = [...states.values()].filter(
          (s) =>
            s.organizationId === actor.organizationId &&
            s.teamId === teamId &&
            s.archivedAt === null &&
            s.id !== stateId &&
            (s.category === "BACKLOG" || s.category === "UNSTARTED"),
        );
        if (remaining.length === 0) {
          throw new ApiFailure(
            409,
            "CONFLICT",
            "Zespół musi zachować co najmniej jeden status w kategorii Backlog lub Do zrobienia",
          );
        }
      }
      if (input.name !== undefined) rec.name = input.name;
      if (input.category !== undefined) rec.category = input.category;
      if (input.color !== undefined) rec.color = input.color;
      if (input.position !== undefined) rec.position = input.position;
      rec.updatedAt = nextNow();
      return toState(rec);
    },

    async deleteWorkflowState(actor, teamId, stateId) {
      const rec = states.get(stateId);
      if (!rec || rec.organizationId !== actor.organizationId || rec.teamId !== teamId || rec.archivedAt !== null) {
        return false;
      }
      const inUse = [...issues.values()].some(
        (issue) =>
          issue.organizationId === actor.organizationId &&
          issue.teamId === teamId &&
          issue.stateId === stateId &&
          issue.deletedAt === null,
      );
      if (inUse) {
        throw new ApiFailure(409, "CONFLICT", "Nie można usunąć statusu używanego przez aktywne zadania");
      }
      if (rec.category === "BACKLOG" || rec.category === "UNSTARTED") {
        const remaining = [...states.values()].filter(
          (s) =>
            s.organizationId === actor.organizationId &&
            s.teamId === teamId &&
            s.archivedAt === null &&
            s.id !== stateId &&
            (s.category === "BACKLOG" || s.category === "UNSTARTED"),
        );
        if (remaining.length === 0) {
          throw new ApiFailure(
            409,
            "CONFLICT",
            "Zespół musi zachować co najmniej jeden status w kategorii Backlog lub Do zrobienia",
          );
        }
      }
      rec.archivedAt = nextNow();
      return true;
    },

    async listLabels(actor, teamId) {
      return [...labels.values()]
        .filter((l) => l.organizationId === actor.organizationId && l.teamId === teamId && l.archivedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name, "pl"))
        .map(toLabel);
    },

    async createLabel(actor, input) {
      const lower = input.name.toLowerCase();
      for (const existing of labels.values()) {
        if (
          existing.organizationId === actor.organizationId &&
          existing.teamId === input.teamId &&
          existing.archivedAt === null &&
          existing.name.toLowerCase() === lower
        ) {
          throw new ApiFailure(409, "CONFLICT", "Etykieta o tej nazwie już istnieje w zespole");
        }
      }
      const now = nextNow();
      const rec: LabelRec = {
        id: uuidv7(now.getTime()),
        organizationId: actor.organizationId,
        teamId: input.teamId,
        name: input.name,
        color: input.color,
        createdAt: now,
        archivedAt: null,
      };
      labels.set(rec.id, rec);
      return toLabel(rec);
    },

    async updateLabel(actor, teamId, labelId, input) {
      const rec = labels.get(labelId);
      if (!rec || rec.organizationId !== actor.organizationId || rec.teamId !== teamId || rec.archivedAt !== null) {
        return null;
      }
      if (input.name !== undefined) {
        const lower = input.name.toLowerCase();
        for (const existing of labels.values()) {
          if (
            existing.organizationId === actor.organizationId &&
            existing.teamId === teamId &&
            existing.archivedAt === null &&
            existing.id !== labelId &&
            existing.name.toLowerCase() === lower
          ) {
            throw new ApiFailure(409, "CONFLICT", "Etykieta o tej nazwie już istnieje w zespole");
          }
        }
        rec.name = input.name;
      }
      if (input.color !== undefined) rec.color = input.color;
      return toLabel(rec);
    },

    async deleteLabel(actor, teamId, labelId) {
      const rec = labels.get(labelId);
      if (!rec || rec.organizationId !== actor.organizationId || rec.teamId !== teamId || rec.archivedAt !== null) {
        return false;
      }
      rec.archivedAt = nextNow();
      for (const attached of issueLabels.values()) {
        attached.delete(labelId);
      }
      return true;
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

      const hideClosed =
        !params.includeCompleted &&
        !params.stateId &&
        params.stateCategory !== "COMPLETED" &&
        params.stateCategory !== "CANCELED";

      const matching = [...issues.values()]
        .filter((issue) => {
          if (issue.organizationId !== actor.organizationId || issue.deletedAt !== null) return false;
          const team = teams.get(issue.teamId);
          if (!team || team.archivedAt !== null) return false;
          if (!teamAllowed(params.readableTeamIds, issue.teamId)) return false;
          if (params.teamId && issue.teamId !== params.teamId) return false;
          if (params.stateId && issue.stateId !== params.stateId) return false;
          const state = states.get(issue.stateId);
          if (!state) return false;
          if (params.stateCategory && state.category !== params.stateCategory) return false;
          if (hideClosed && (state.category === "COMPLETED" || state.category === "CANCELED")) return false;
          if (params.assignee) {
            if (params.assignee.type === "none" && issue.assigneeAccountId !== null) return false;
            if (params.assignee.type === "account" && issue.assigneeAccountId !== params.assignee.accountId) {
              return false;
            }
          }
          if (params.labelId) {
            const attached = issueLabels.get(issue.id);
            const label = labels.get(params.labelId);
            if (!attached || !attached.has(params.labelId) || !label || label.archivedAt !== null) return false;
          }
          if (params.priority !== undefined && issue.priority !== params.priority) return false;
          if (params.parentId) {
            if (params.parentId.type === "none" && issue.parentId !== null) return false;
            if (params.parentId.type === "issue" && issue.parentId !== params.parentId.issueId) return false;
          }
          if (params.identifier || params.tsQuery) {
            const idMatch =
              params.identifier !== null &&
              params.identifier !== undefined &&
              team.key === params.identifier.key &&
              issue.number === params.identifier.number;
            const ftsMatch = params.tsQuery ? computeFtsScore(issue, params.tsQuery) > 0 : false;
            if (!idMatch && !ftsMatch) return false;
          }
          if (params.cursor && !passesCursor(issue, params.cursor)) return false;
          return true;
        })
        .sort((a, b) => compareIssuesBySort(a, b, params.sort));

      const hasMore = matching.length > params.limit;
      const page = (hasMore ? matching.slice(0, params.limit) : matching).map(toListItem);
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeIssueCursor(buildIssueCursorPayload(params.sort, last)) : null;

      return { items: page, nextCursor };
    },

    async createIssue(actor, input) {
      const team = teams.get(input.teamId);
      if (!team || team.organizationId !== actor.organizationId || team.archivedAt !== null) {
        throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zespołu");
      }

      let state: StateRec | undefined;
      if (input.stateId) {
        const candidate = states.get(input.stateId);
        if (
          !candidate ||
          candidate.organizationId !== actor.organizationId ||
          candidate.teamId !== input.teamId ||
          candidate.archivedAt !== null
        ) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "stateId", message: "Wybrany status nie należy do tego zespołu" },
          ]);
        }
        state = candidate;
      } else {
        const teamStates = [...states.values()]
          .filter(
            (s) => s.organizationId === actor.organizationId && s.teamId === input.teamId && s.archivedAt === null,
          )
          .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
        state = teamStates.find((s) => s.category === "BACKLOG") ?? teamStates.find((s) => s.category === "UNSTARTED");
        if (!state) {
          throw new ApiFailure(409, "CONFLICT", "Zespół nie ma domyślnego statusu dla nowych zadań");
        }
      }

      const uniqueLabels = [...new Set(input.labelIds)];
      for (const labelId of uniqueLabels) {
        const label = labels.get(labelId);
        if (
          !label ||
          label.organizationId !== actor.organizationId ||
          label.teamId !== input.teamId ||
          label.archivedAt !== null
        ) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "labelIds", message: "Wszystkie etykiety muszą należeć do tego samego zespołu" },
          ]);
        }
      }

      if (input.parentId !== null) {
        const parent = issues.get(input.parentId);
        if (
          !parent ||
          parent.organizationId !== actor.organizationId ||
          parent.teamId !== input.teamId ||
          parent.deletedAt !== null
        ) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "parentId", message: "Zadanie nadrzędne musi istnieć w tym samym zespole" },
          ]);
        }
      }

      const number = team.nextIssueNumber;
      team.nextIssueNumber += 1;
      const now = nextNow();
      team.updatedAt = now;

      const timestamps = computeStateTimestamps(
        state.category,
        { startedAt: null, completedAt: null, canceledAt: null },
        now,
      );
      const id = uuidv7(now.getTime());
      const rec: IssueRec = {
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
        dueDate: input.dueDate,
        estimate: input.estimate,
        parentId: input.parentId,
        sortOrder: number * 1000,
        startedAt: timestamps.startedAt,
        completedAt: timestamps.completedAt,
        canceledAt: timestamps.canceledAt,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      issues.set(id, rec);
      issueLabels.set(id, new Set(uniqueLabels));
      return toDetail(rec, "ALL")!;
    },

    async findIssueLocationById(actor, issueId) {
      const rec = issues.get(issueId);
      if (!rec || rec.organizationId !== actor.organizationId || rec.deletedAt !== null) return null;
      const team = teams.get(rec.teamId);
      if (!team || team.archivedAt !== null) return null;
      return { id: rec.id, teamId: rec.teamId, assigneeAccountId: rec.assigneeAccountId };
    },

    async findIssueDetail(actor, lookup, readableTeamIds) {
      if (readableTeamIds !== "ALL" && readableTeamIds.length === 0) return null;
      let rec: IssueRec | undefined;
      if (lookup.type === "id") {
        rec = issues.get(lookup.id);
        if (rec && rec.organizationId !== actor.organizationId) rec = undefined;
      } else {
        const team = [...teams.values()].find(
          (t) => t.organizationId === actor.organizationId && t.key === lookup.key && t.archivedAt === null,
        );
        if (!team || !teamAllowed(readableTeamIds, team.id)) return null;
        rec = [...issues.values()].find(
          (i) => i.organizationId === actor.organizationId && i.teamId === team.id && i.number === lookup.number,
        );
      }
      if (!rec) return null;
      return toDetail(rec, readableTeamIds);
    },

    async updateIssue(actor, issueId, input, readableTeamIds) {
      const rec = issues.get(issueId);
      if (!rec || rec.organizationId !== actor.organizationId || rec.deletedAt !== null) return null;

      const currentState = states.get(rec.stateId)!;
      if (input.stateId !== undefined && input.stateId !== rec.stateId) {
        const targetState = states.get(input.stateId);
        if (
          !targetState ||
          targetState.organizationId !== actor.organizationId ||
          targetState.teamId !== rec.teamId ||
          targetState.archivedAt !== null
        ) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "stateId", message: "Wybrany status nie należy do tego zespołu" },
          ]);
        }
        if (targetState.category !== currentState.category) {
          const ts = computeStateTimestamps(
            targetState.category,
            { startedAt: rec.startedAt, completedAt: rec.completedAt, canceledAt: rec.canceledAt },
            nextNow(),
          );
          rec.startedAt = ts.startedAt;
          rec.completedAt = ts.completedAt;
          rec.canceledAt = ts.canceledAt;
        }
        rec.stateId = targetState.id;
      }

      if (input.parentId !== undefined && input.parentId !== null) {
        if (input.parentId === issueId) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "parentId", message: "Zadanie nie może być swoim własnym zadaniem nadrzędnym" },
          ]);
        }
        const parent = issues.get(input.parentId);
        if (
          !parent ||
          parent.organizationId !== actor.organizationId ||
          parent.teamId !== rec.teamId ||
          parent.deletedAt !== null
        ) {
          throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
            { field: "parentId", message: "Zadanie nadrzędne musi istnieć w tym samym zespole" },
          ]);
        }
        const createsCycle = await wouldCreateParentCycle(issueId, input.parentId, async (id) => {
          const node = issues.get(id);
          if (!node || node.organizationId !== actor.organizationId || node.deletedAt !== null) return null;
          return node.parentId;
        });
        if (createsCycle) {
          throw new ApiFailure(409, "CONFLICT", "Wybrane zadanie nadrzędne tworzy cykl w hierarchii zadań");
        }
      }

      if (input.labelIds !== undefined) {
        const uniqueLabels = [...new Set(input.labelIds)];
        for (const labelId of uniqueLabels) {
          const label = labels.get(labelId);
          if (
            !label ||
            label.organizationId !== actor.organizationId ||
            label.teamId !== rec.teamId ||
            label.archivedAt !== null
          ) {
            throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
              { field: "labelIds", message: "Wszystkie etykiety muszą należeć do tego samego zespołu" },
            ]);
          }
        }
        issueLabels.set(issueId, new Set(uniqueLabels));
      }

      if (input.title !== undefined) rec.title = input.title;
      if (input.description !== undefined) rec.description = input.description;
      if (input.priority !== undefined) rec.priority = input.priority;
      if (input.assigneeAccountId !== undefined) rec.assigneeAccountId = input.assigneeAccountId;
      if (input.dueDate !== undefined) rec.dueDate = input.dueDate;
      if (input.estimate !== undefined) rec.estimate = input.estimate;
      if (input.parentId !== undefined) rec.parentId = input.parentId;
      if (input.sortOrder !== undefined) rec.sortOrder = input.sortOrder;
      rec.updatedAt = nextNow();

      return toDetail(rec, readableTeamIds);
    },

    async softDeleteIssue(actor, issueId) {
      const rec = issues.get(issueId);
      if (!rec || rec.organizationId !== actor.organizationId || rec.deletedAt !== null) return false;
      rec.deletedAt = nextNow();
      return true;
    },

    async createIssueRelation(actor, input) {
      for (const existing of relations.values()) {
        if (existing.organizationId !== actor.organizationId) continue;
        if (
          input.storedType === "RELATED" &&
          existing.type === "RELATED" &&
          ((existing.issueId === input.storedIssueId && existing.relatedIssueId === input.storedRelatedIssueId) ||
            (existing.issueId === input.storedRelatedIssueId && existing.relatedIssueId === input.storedIssueId))
        ) {
          throw new ApiFailure(409, "CONFLICT", "Taka relacja między zadaniami już istnieje");
        }
        if (
          existing.issueId === input.storedIssueId &&
          existing.relatedIssueId === input.storedRelatedIssueId &&
          existing.type === input.storedType
        ) {
          throw new ApiFailure(409, "CONFLICT", "Taka relacja między zadaniami już istnieje");
        }
      }

      const now = nextNow();
      const rec: RelationRec = {
        id: uuidv7(now.getTime()),
        organizationId: actor.organizationId,
        issueId: input.storedIssueId,
        relatedIssueId: input.storedRelatedIssueId,
        type: input.storedType,
        createdAt: now,
      };
      relations.set(rec.id, rec);

      const otherId = rec.issueId === input.viewerIssueId ? rec.relatedIssueId : rec.issueId;
      return toIssueRelationView(input.viewerIssueId, rec, toReference(issues.get(otherId)!));
    },

    async findIssueRelation(actor, issueId, relationId) {
      const rel = relations.get(relationId);
      if (!rel || rel.organizationId !== actor.organizationId) return null;
      if (rel.issueId !== issueId && rel.relatedIssueId !== issueId) return null;
      const a = issues.get(rel.issueId);
      const b = issues.get(rel.relatedIssueId);
      if (!a || !b || a.deletedAt !== null || b.deletedAt !== null) return null;
      return {
        id: rel.id,
        issueId: rel.issueId,
        relatedIssueId: rel.relatedIssueId,
        issueTeamId: a.teamId,
        relatedIssueTeamId: b.teamId,
      };
    },

    async deleteIssueRelation(actor, relationId) {
      const rel = relations.get(relationId);
      if (!rel || rel.organizationId !== actor.organizationId) return false;
      relations.delete(relationId);
      return true;
    },

    async searchIssues(actor, params: SearchIssuesStoreParams) {
      if (params.readableTeamIds !== "ALL" && params.readableTeamIds.length === 0) return [];
      if (!params.identifier && !params.tsQuery) return [];

      const candidates = [...issues.values()].filter((issue) => {
        if (issue.organizationId !== actor.organizationId || issue.deletedAt !== null) return false;
        const team = teams.get(issue.teamId);
        if (!team || team.archivedAt !== null) return false;
        return teamAllowed(params.readableTeamIds, issue.teamId);
      });

      const results: IssueRec[] = [];
      let exactId: string | null = null;
      if (params.identifier) {
        const exact = candidates.find((issue) => {
          const team = teams.get(issue.teamId)!;
          return team.key === params.identifier!.key && issue.number === params.identifier!.number;
        });
        if (exact) {
          results.push(exact);
          exactId = exact.id;
        }
      }

      const remaining = params.limit - results.length;
      if (remaining > 0 && params.tsQuery) {
        const fts = candidates
          .filter((issue) => issue.id !== exactId)
          .map((issue) => ({ issue, score: computeFtsScore(issue, params.tsQuery!) }))
          .filter((entry) => entry.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.issue.updatedAt.getTime() - a.issue.updatedAt.getTime() ||
              compareDescStr(a.issue.id, b.issue.id),
          )
          .slice(0, remaining);
        for (const entry of fts) {
          results.push(entry.issue);
        }
      }

      return results.map(toListItem);
    },
  };
}
