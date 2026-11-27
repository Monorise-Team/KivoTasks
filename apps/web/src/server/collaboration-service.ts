import "server-only";
import {
  CreateIssueCommentInput,
  InboxListQuery,
  IssueActivityQuery,
  IssueCommentsQuery,
  UpdateInboxItemInput,
  UpdateIssueCommentInput,
  type CommentReactionsResult,
  type InboxItem,
  type InboxReadAllResult,
  type InboxUnreadCount,
  type IssueActivityItem,
  type IssueComment,
  type IssueSubscription,
  type PaginatedResult,
} from "@kivotasks/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import {
  decodeActivityCursor,
  decodeTimeIdCursor,
  extractMentionAccountIds,
  filterValidMentionAccountIds,
  parseReactionEmojiParam,
} from "./collaboration-helpers";
import { listTeamMembersWithAccount, tryResolveOrganizationMemberNames, UNKNOWN_PERSON_NAME } from "./core-directory";
import { getIssuesStore, type IssueLocation } from "./issues-store";
import { canManageTeam, canReadTeamIssues, readableIssueTeamsFilter, requireAuthorizedSnapshot } from "./permissions";

function queryParamsToRecord(searchParams: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    record[key] = value;
  }
  return record;
}

async function resolveVisibleIssue(
  caller: Caller,
  issueId: string,
): Promise<{
  snapshot: Awaited<ReturnType<typeof requireAuthorizedSnapshot>>;
  issue: IssueLocation;
}> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const issue = await getIssuesStore().findIssueLocationById(caller, issueId);
  // 404 przed 403 dla zadań spoza zasięgu osoby
  if (!issue || !canReadTeamIssues(snapshot, issue.teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
  return { snapshot, issue };
}

async function resolveValidMentions(organizationId: string, teamId: string, body: string): Promise<string[]> {
  const candidates = extractMentionAccountIds(body);
  if (candidates.length === 0) return [];
  const members = await listTeamMembersWithAccount(organizationId, teamId);
  const allowedIds = new Set(members.map((member) => member.accountId));
  return filterValidMentionAccountIds(candidates, allowedIds);
}

function resolveDisplayName(accountId: string, names: ReadonlyMap<string, string>, caller: Caller): string {
  const key = accountId.toLowerCase();
  const fromDir = names.get(key);
  if (fromDir && fromDir !== UNKNOWN_PERSON_NAME) {
    return fromDir;
  }
  if (key === caller.accountId.toLowerCase()) {
    const fromSession = caller.session?.profile.name?.trim();
    if (fromSession) return fromSession;
  }
  return fromDir ?? UNKNOWN_PERSON_NAME;
}

function attachAuthorName(comment: IssueComment, names: ReadonlyMap<string, string>, caller: Caller): IssueComment {
  return { ...comment, authorName: resolveDisplayName(comment.authorAccountId, names, caller) };
}

// ── Komentarze i reakcje ────────────────────────────────────────────────────

export async function listIssueComments(
  caller: Caller,
  issueId: string,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<IssueComment>> {
  await resolveVisibleIssue(caller, issueId);
  const parsed = IssueCommentsQuery.parse(queryParamsToRecord(searchParams));
  const cursor = parsed.cursor ? decodeTimeIdCursor(parsed.cursor) : undefined;

  const page = await getIssuesStore().listIssueComments(caller, {
    issueId,
    limit: parsed.limit,
    cursor,
  });

  const neededIds = new Set(page.items.map((comment) => comment.authorAccountId));
  const names = await tryResolveOrganizationMemberNames(caller.organizationId, neededIds);
  return {
    items: page.items.map((comment) => attachAuthorName(comment, names, caller)),
    nextCursor: page.nextCursor,
  };
}

export async function createIssueComment(caller: Caller, issueId: string, rawInput: unknown): Promise<IssueComment> {
  const { issue } = await resolveVisibleIssue(caller, issueId);
  const input = CreateIssueCommentInput.parse(rawInput);
  const mentionedAccountIds = await resolveValidMentions(caller.organizationId, issue.teamId, input.body);

  const created = await getIssuesStore().createIssueComment(caller, {
    issueId: issue.id,
    teamId: issue.teamId,
    body: input.body,
    mentionedAccountIds,
  });

  const names = await tryResolveOrganizationMemberNames(caller.organizationId, new Set([created.authorAccountId]));
  return attachAuthorName(created, names, caller);
}

export async function updateIssueComment(
  caller: Caller,
  issueId: string,
  commentId: string,
  rawInput: unknown,
): Promise<IssueComment> {
  const { issue } = await resolveVisibleIssue(caller, issueId);
  const store = getIssuesStore();
  const existing = await store.findCommentLocation(caller, issue.id, commentId);
  if (!existing || existing.deletedAt !== null) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono komentarza");
  }
  if (existing.authorAccountId !== caller.accountId) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Tylko autor może edytować swój komentarz");
  }

  const input = UpdateIssueCommentInput.parse(rawInput);
  const mentionedAccountIds = await resolveValidMentions(caller.organizationId, issue.teamId, input.body);

  const updated = await store.updateIssueComment(caller, {
    issueId: issue.id,
    commentId: existing.id,
    body: input.body,
    mentionedAccountIds,
  });
  if (!updated) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono komentarza");
  }

  const names = await tryResolveOrganizationMemberNames(caller.organizationId, new Set([updated.authorAccountId]));
  return attachAuthorName(updated, names, caller);
}

export async function deleteIssueComment(caller: Caller, issueId: string, commentId: string): Promise<void> {
  const { snapshot, issue } = await resolveVisibleIssue(caller, issueId);
  const store = getIssuesStore();
  const existing = await store.findCommentLocation(caller, issue.id, commentId);
  if (!existing || existing.deletedAt !== null) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono komentarza");
  }

  const isAuthor = existing.authorAccountId === caller.accountId;
  if (!isAuthor && !canManageTeam(snapshot, issue.teamId)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do usunięcia tego komentarza");
  }

  const deleted = await store.softDeleteIssueComment(caller, issue.id, existing.id);
  if (!deleted) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono komentarza");
  }
}

export async function addCommentReaction(
  caller: Caller,
  issueId: string,
  commentId: string,
  rawEmoji: string,
): Promise<CommentReactionsResult> {
  const { issue } = await resolveVisibleIssue(caller, issueId);
  const emoji = parseReactionEmojiParam(rawEmoji);
  const result = await getIssuesStore().addCommentReaction(caller, {
    issueId: issue.id,
    commentId,
    emoji,
  });
  if (!result) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono komentarza");
  }
  return result;
}

export async function removeCommentReaction(
  caller: Caller,
  issueId: string,
  commentId: string,
  rawEmoji: string,
): Promise<void> {
  const { issue } = await resolveVisibleIssue(caller, issueId);
  const emoji = parseReactionEmojiParam(rawEmoji);
  const ok = await getIssuesStore().removeCommentReaction(caller, {
    issueId: issue.id,
    commentId,
    emoji,
  });
  if (!ok) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono komentarza");
  }
}

// ── Aktywność (historia + komentarze) ───────────────────────────────────────

export async function listIssueActivity(
  caller: Caller,
  issueId: string,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<IssueActivityItem>> {
  const { snapshot, issue } = await resolveVisibleIssue(caller, issueId);
  const readableTeamIds = readableIssueTeamsFilter(snapshot);
  const parsed = IssueActivityQuery.parse(queryParamsToRecord(searchParams));
  const cursor = parsed.cursor ? decodeActivityCursor(parsed.cursor) : undefined;

  const page = await getIssuesStore().listIssueActivity(caller, {
    issueId: issue.id,
    readableTeamIds,
    limit: parsed.limit,
    cursor,
  });

  const neededIds = new Set<string>();
  for (const item of page.items) {
    if (item.kind === "comment") {
      neededIds.add(item.comment.authorAccountId);
    } else {
      neededIds.add(item.event.actorAccountId);
    }
  }
  const names = await tryResolveOrganizationMemberNames(caller.organizationId, neededIds);

  const enriched: IssueActivityItem[] = page.items.map((item) => {
    if (item.kind === "comment") {
      return { ...item, comment: attachAuthorName(item.comment, names, caller) };
    }
    return {
      ...item,
      event: { ...item.event, actorName: resolveDisplayName(item.event.actorAccountId, names, caller) },
    };
  });

  return { items: enriched, nextCursor: page.nextCursor };
}

// ── Obserwowanie zadania ────────────────────────────────────────────────────

export async function subscribeIssue(caller: Caller, issueId: string): Promise<IssueSubscription> {
  const { issue } = await resolveVisibleIssue(caller, issueId);
  const result = await getIssuesStore().subscribeIssue(caller, issue.id);
  if (!result) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
  return result;
}

export async function unsubscribeIssue(caller: Caller, issueId: string): Promise<void> {
  const { issue } = await resolveVisibleIssue(caller, issueId);
  const ok = await getIssuesStore().unsubscribeIssue(caller, issue.id);
  if (!ok) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
}

// ── Skrzynka powiadomień ────────────────────────────────────────────────────

export async function listInboxItems(
  caller: Caller,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<InboxItem>> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const readableTeamIds = readableIssueTeamsFilter(snapshot);
  const parsed = InboxListQuery.parse(queryParamsToRecord(searchParams));
  const cursor = parsed.cursor ? decodeTimeIdCursor(parsed.cursor) : undefined;

  const page = await getIssuesStore().listInboxItems(caller, {
    readableTeamIds,
    filter: parsed.filter,
    limit: parsed.limit,
    cursor,
  });

  const neededIds = new Set(page.items.map((item) => item.actorAccountId));
  const names = await tryResolveOrganizationMemberNames(caller.organizationId, neededIds);
  const items = page.items.map((item) => ({
    ...item,
    actorName: names.get(item.actorAccountId.toLowerCase()) ?? UNKNOWN_PERSON_NAME,
  }));

  return { items, nextCursor: page.nextCursor };
}

export async function getInboxUnreadCount(caller: Caller): Promise<InboxUnreadCount> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const readableTeamIds = readableIssueTeamsFilter(snapshot);
  const unreadCount = await getIssuesStore().getInboxUnreadCount(caller, readableTeamIds);
  return { unreadCount };
}

export async function updateInboxItem(caller: Caller, itemId: string, rawInput: unknown): Promise<InboxItem> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const readableTeamIds = readableIssueTeamsFilter(snapshot);
  const input = UpdateInboxItemInput.parse(rawInput);

  const updated = await getIssuesStore().updateInboxItem(caller, {
    itemId,
    readableTeamIds,
    read: input.read,
    archived: input.archived,
  });
  if (!updated) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono powiadomienia");
  }

  const names = await tryResolveOrganizationMemberNames(caller.organizationId, new Set([updated.actorAccountId]));
  return {
    ...updated,
    actorName: names.get(updated.actorAccountId.toLowerCase()) ?? UNKNOWN_PERSON_NAME,
  };
}

export async function markAllInboxRead(caller: Caller): Promise<InboxReadAllResult> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const readableTeamIds = readableIssueTeamsFilter(snapshot);
  const updatedCount = await getIssuesStore().markAllInboxRead(caller, readableTeamIds);
  return { updatedCount };
}
