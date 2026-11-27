import "server-only";
import {
  CreateIssueInput,
  CreateIssueRelationInput,
  IssueListQuery,
  SearchIssuesQuery,
  UpdateIssueInput,
  type IssueDetail,
  type IssueListItem,
  type IssueRelationView,
  type PaginatedResult,
  type SearchIssuesResult,
  type TeamMember,
} from "@kivotasks/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { listTeamMembersWithAccount } from "./core-directory";
import {
  buildPrefixTsQuery,
  decodeIssueCursor,
  isUuid,
  normalizeRelationForStorage,
  parseIssueIdentifier,
} from "./issue-helpers";
import { getIssuesStore, type AssigneeStoreFilter, type IssueLookup, type ParentStoreFilter } from "./issues-store";
import { notifyIssueAssigned, resolveAssignmentActorName, shouldNotifyIssueAssignment } from "./notifications";
import {
  canReadTeam,
  canReadTeamIssues,
  canWriteTeamIssues,
  PERMISSION_DENIED_MESSAGE,
  readableIssueTeamsFilter,
  requireAuthorizedSnapshot,
  resolveReadableIssuesFilter,
} from "./permissions";

const SEARCH_MAX_RESULTS = 20;

async function assertAssigneeIsTeamMember(
  organizationId: string,
  teamId: string,
  accountId: string,
): Promise<TeamMember[]> {
  const members = await listTeamMembersWithAccount(organizationId, teamId);
  const found = members.some((member) => member.accountId === accountId);
  if (!found) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      {
        field: "assigneeAccountId",
        message: "Osoba przypisana musi być członkiem zespołu z aktywnym kontem",
      },
    ]);
  }
  return members;
}

function queryParamsToRecord(searchParams: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    record[key] = value;
  }
  return record;
}

export async function listIssues(
  caller: Caller,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<IssueListItem>> {
  const readableTeamIds = await resolveReadableIssuesFilter(caller);
  const parsed = IssueListQuery.parse(queryParamsToRecord(searchParams));
  const cursor = parsed.cursor ? decodeIssueCursor(parsed.cursor, parsed.sort) : undefined;

  let assignee: AssigneeStoreFilter | undefined;
  if (parsed.assignee === "me") {
    assignee = { type: "account", accountId: caller.accountId };
  } else if (parsed.assignee === "none") {
    assignee = { type: "none" };
  } else if (parsed.assignee !== undefined) {
    assignee = { type: "account", accountId: parsed.assignee };
  }

  let parentId: ParentStoreFilter | undefined;
  if (parsed.parentId === "none") {
    parentId = { type: "none" };
  } else if (parsed.parentId !== undefined) {
    parentId = { type: "issue", issueId: parsed.parentId };
  }

  const trimmedQuery = parsed.q && parsed.q.length > 0 ? parsed.q : undefined;
  const identifier = trimmedQuery ? parseIssueIdentifier(trimmedQuery) : null;
  const tsQuery = trimmedQuery ? buildPrefixTsQuery(trimmedQuery) : null;

  return getIssuesStore().listIssues(caller, {
    readableTeamIds,
    teamId: parsed.teamId,
    stateId: parsed.stateId,
    stateCategory: parsed.stateCategory,
    assignee,
    labelId: parsed.labelId,
    priority: parsed.priority,
    parentId,
    q: trimmedQuery,
    identifier,
    tsQuery,
    includeCompleted: parsed.includeCompleted ?? false,
    sort: parsed.sort,
    limit: parsed.limit,
    cursor,
  });
}

export async function createIssue(caller: Caller, rawInput: unknown): Promise<IssueDetail> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const input = CreateIssueInput.parse(rawInput);

  // 404 przed 403 dla zespołów spoza zasięgu osoby
  if (!canReadTeam(snapshot, input.teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zespołu");
  }
  const team = await getIssuesStore().findTeamById(caller, input.teamId);
  if (!team) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zespołu");
  }
  if (!canWriteTeamIssues(snapshot, input.teamId)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }

  let teamMembers: TeamMember[] = [];
  if (input.assigneeAccountId) {
    teamMembers = await assertAssigneeIsTeamMember(caller.organizationId, input.teamId, input.assigneeAccountId);
  }

  const created = await getIssuesStore().createIssue(caller, {
    teamId: input.teamId,
    title: input.title,
    description: input.description ?? null,
    stateId: input.stateId,
    priority: input.priority ?? 0,
    assigneeAccountId: input.assigneeAccountId ?? null,
    creatorAccountId: caller.accountId,
    labelIds: input.labelIds ?? [],
    dueDate: input.dueDate ?? null,
    estimate: input.estimate ?? null,
    parentId: input.parentId ?? null,
  });

  if (
    created.assigneeAccountId &&
    shouldNotifyIssueAssignment({
      previousAssigneeAccountId: null,
      nextAssigneeAccountId: created.assigneeAccountId,
      actorAccountId: caller.accountId,
    })
  ) {
    await notifyIssueAssigned({
      organizationId: caller.organizationId,
      recipientAccountId: created.assigneeAccountId,
      issue: created,
      teamName: team.name,
      actorName: resolveAssignmentActorName(caller, teamMembers),
    });
  }

  return created;
}

export async function getIssue(caller: Caller, idOrIdentifier: string): Promise<IssueDetail> {
  const readableTeamIds = await resolveReadableIssuesFilter(caller);

  let lookup: IssueLookup;
  if (isUuid(idOrIdentifier)) {
    lookup = { type: "id", id: idOrIdentifier };
  } else {
    const parsedIdentifier = parseIssueIdentifier(idOrIdentifier);
    if (!parsedIdentifier) {
      throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
    }
    lookup = { type: "identifier", key: parsedIdentifier.key, number: parsedIdentifier.number };
  }

  const detail = await getIssuesStore().findIssueDetail(caller, lookup, readableTeamIds);
  if (!detail) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
  return detail;
}

export async function updateIssue(caller: Caller, issueId: string, rawInput: unknown): Promise<IssueDetail> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const store = getIssuesStore();
  const existing = await store.findIssueLocationById(caller, issueId);
  if (!existing) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }

  if (!canReadTeamIssues(snapshot, existing.teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
  if (!canWriteTeamIssues(snapshot, existing.teamId)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }

  const input = UpdateIssueInput.parse(rawInput);
  if (input.teamId !== undefined && input.teamId !== existing.teamId) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      { field: "teamId", message: "Przenoszenie zadania do innego zespołu nie jest obsługiwane" },
    ]);
  }

  let teamMembers: TeamMember[] = [];
  if (
    input.assigneeAccountId !== undefined &&
    input.assigneeAccountId !== null &&
    input.assigneeAccountId !== existing.assigneeAccountId
  ) {
    teamMembers = await assertAssigneeIsTeamMember(caller.organizationId, existing.teamId, input.assigneeAccountId);
  }

  const visibleTeams = readableIssueTeamsFilter(snapshot);
  const result = await store.updateIssue(
    caller,
    issueId,
    {
      title: input.title,
      description: input.description,
      stateId: input.stateId,
      priority: input.priority,
      assigneeAccountId: input.assigneeAccountId,
      labelIds: input.labelIds,
      dueDate: input.dueDate,
      estimate: input.estimate,
      parentId: input.parentId,
      sortOrder: input.sortOrder,
    },
    visibleTeams,
  );
  if (!result) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }

  // Porównujemy ze stanem z wiersza zablokowanego FOR UPDATE, żeby równoległe żądania nie wysłały duplikatu e-maila
  if (
    input.assigneeAccountId !== undefined &&
    result.issue.assigneeAccountId &&
    shouldNotifyIssueAssignment({
      previousAssigneeAccountId: result.previousAssigneeAccountId,
      nextAssigneeAccountId: result.issue.assigneeAccountId,
      actorAccountId: caller.accountId,
    })
  ) {
    await notifyIssueAssigned({
      organizationId: caller.organizationId,
      recipientAccountId: result.issue.assigneeAccountId,
      issue: result.issue,
      teamName: existing.teamName,
      actorName: resolveAssignmentActorName(caller, teamMembers),
    });
  }

  return result.issue;
}

export async function deleteIssue(caller: Caller, issueId: string): Promise<void> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const store = getIssuesStore();
  const existing = await store.findIssueLocationById(caller, issueId);
  if (!existing) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }

  if (!canReadTeamIssues(snapshot, existing.teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
  if (!canWriteTeamIssues(snapshot, existing.teamId)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }

  const deleted = await store.softDeleteIssue(caller, issueId);
  if (!deleted) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
}

export async function createIssueRelation(
  caller: Caller,
  issueId: string,
  rawInput: unknown,
): Promise<IssueRelationView> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const input = CreateIssueRelationInput.parse(rawInput);

  if (issueId === input.relatedIssueId) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      { field: "relatedIssueId", message: "Zadanie nie może być powiązane samo ze sobą" },
    ]);
  }

  const store = getIssuesStore();
  const [source, target] = await Promise.all([
    store.findIssueLocationById(caller, issueId),
    store.findIssueLocationById(caller, input.relatedIssueId),
  ]);

  if (!source || !canReadTeamIssues(snapshot, source.teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
  if (!target || !canReadTeamIssues(snapshot, target.teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono powiązanego zadania");
  }

  if (!canWriteTeamIssues(snapshot, source.teamId) || !canWriteTeamIssues(snapshot, target.teamId)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }

  const normalized = normalizeRelationForStorage(issueId, input.relatedIssueId, input.type);
  return store.createIssueRelation(caller, {
    viewerIssueId: issueId,
    ...normalized,
  });
}

export async function deleteIssueRelation(caller: Caller, issueId: string, relationId: string): Promise<void> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const store = getIssuesStore();
  const relation = await store.findIssueRelation(caller, issueId, relationId);
  if (!relation) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono relacji");
  }

  if (!canReadTeamIssues(snapshot, relation.issueTeamId) || !canReadTeamIssues(snapshot, relation.relatedIssueTeamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono relacji");
  }

  if (
    !canWriteTeamIssues(snapshot, relation.issueTeamId) ||
    !canWriteTeamIssues(snapshot, relation.relatedIssueTeamId)
  ) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }

  const deleted = await store.deleteIssueRelation(caller, relation.id);
  if (!deleted) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono relacji");
  }
}

export async function searchIssues(caller: Caller, searchParams: URLSearchParams): Promise<SearchIssuesResult> {
  const readableTeamIds = await resolveReadableIssuesFilter(caller);
  const { q } = SearchIssuesQuery.parse({ q: searchParams.get("q") ?? "" });
  if (q.length === 0) {
    return { issues: [] };
  }

  const identifier = parseIssueIdentifier(q);
  const tsQuery = buildPrefixTsQuery(q);
  const issues = await getIssuesStore().searchIssues(caller, {
    readableTeamIds,
    identifier,
    tsQuery,
    limit: SEARCH_MAX_RESULTS,
  });
  return { issues };
}
