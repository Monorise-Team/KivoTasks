/**
 * Typowany klient API KivoTasks dla przeglądarki (sesja BFF w ciasteczku HttpOnly, ADR-0050)
 * oraz wywołań z tokenem Bearer (`getToken`).
 */
import {
  API_PREFIX,
  type ApiErrorBody,
  type ApiResponse,
  type CommentReactionEmoji,
  type CommentReactionsResult,
  type CreateIssueCommentInput,
  type CreateIssueInput,
  type CreateIssueRelationInput,
  type CreateLabelInput,
  type CreateTeamInput,
  type CreateWorkflowStateInput,
  type ErrorCode,
  type InboxItem,
  type InboxListQuery,
  type InboxReadAllResult,
  type InboxUnreadCount,
  type IssueActivityItem,
  type IssueActivityQuery,
  type IssueAttachment,
  type IssueAttachmentsQuery,
  type IssueComment,
  type IssueCommentsQuery,
  type IssueDetail,
  type IssueListItem,
  type IssueListQuery,
  type IssueRelationView,
  type IssueSubscription,
  type Label,
  type LabelsList,
  type Me,
  type PaginatedResult,
  type SearchIssuesResult,
  type StorageUsage,
  type Team,
  type TeamCandidatesList,
  type TeamMembersList,
  type TeamsList,
  type UpdateInboxItemInput,
  type UpdateIssueCommentInput,
  type UpdateIssueInput,
  type UpdateLabelInput,
  type UpdateTeamInput,
  type UpdateWorkflowStateInput,
  type WorkflowState,
  type WorkflowStatesList,
} from "@kivotasks/contracts";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ApiErrorBody["details"];

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

export interface ClientOptions {
  /** Adres serwera, np. `https://kivo.monorise.studio`; pusty w przeglądarce (ten sam adres). */
  baseUrl?: string;
  /** Opcjonalny token Bearer; przeglądarka go nie używa (korzysta z ciasteczka sesji BFF). */
  getToken?: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

export type KivoTasksClient = ReturnType<typeof createClient>;

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/** Zwraca względny lub pełny adres pobierania zawartości załącznika. */
export function attachmentContentUrl(attachmentId: string, baseUrl = ""): string {
  return `${baseUrl}${API_PREFIX}/attachments/${encodeSegment(attachmentId)}/content`;
}

function buildIssueListQuery(query?: IssueListQuery): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.teamId !== undefined) params.set("teamId", query.teamId);
  if (query.stateId !== undefined) params.set("stateId", query.stateId);
  if (query.stateCategory !== undefined) params.set("stateCategory", query.stateCategory);
  if (query.assignee !== undefined) params.set("assignee", query.assignee);
  if (query.labelId !== undefined) params.set("labelId", query.labelId);
  if (query.priority !== undefined) params.set("priority", String(query.priority));
  if (query.parentId !== undefined) params.set("parentId", query.parentId);
  if (query.q !== undefined) params.set("q", query.q);
  if (query.includeCompleted !== undefined) params.set("includeCompleted", String(query.includeCompleted));
  if (query.sort !== undefined) params.set("sort", query.sort);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function buildCursorQuery(query?: { limit?: unknown; cursor?: string }): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function buildInboxQuery(query?: InboxListQuery): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.filter !== undefined) params.set("filter", query.filter);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function createClient({ baseUrl = "", getToken, fetch: fetchImpl = fetch }: ClientOptions = {}) {
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isFormData) {
      headers["Content-Type"] = "application/json";
    }
    const token = getToken ? await getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await fetchImpl(`${baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
        credentials: getToken ? "omit" : "same-origin",
      });
    } catch {
      throw new ApiError(0, { code: "INTERNAL_ERROR", message: "Brak połączenia z serwerem KivoTasks", details: [] });
    }
  }

  async function requestEnvelope<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const response = await send(method, path, body);
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload || payload.error) {
      throw new ApiError(
        response.status,
        payload?.error ?? { code: "INTERNAL_ERROR", message: `Błąd serwera (${response.status})`, details: [] },
      );
    }
    return payload;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = await requestEnvelope<T>(method, path, body);
    return payload.data as T;
  }

  async function requestPaginated<T>(method: string, path: string): Promise<PaginatedResult<T>> {
    const payload = await requestEnvelope<T[]>(method, path);
    return {
      items: payload.data ?? [],
      nextCursor: typeof payload.meta.nextCursor === "string" ? payload.meta.nextCursor : null,
    };
  }

  async function requestVoid(method: string, path: string): Promise<void> {
    const response = await send(method, path);
    if (response.status === 204) return;
    const payload = (await response.json().catch(() => null)) as ApiResponse<unknown> | null;
    if (!response.ok || payload?.error) {
      throw new ApiError(
        response.status,
        payload?.error ?? { code: "INTERNAL_ERROR", message: `Błąd serwera (${response.status})`, details: [] },
      );
    }
  }

  return {
    session: {
      me: () => request<Me>("GET", "/me"),
      /**
       * Wylogowanie w przeglądarce (BFF): serwer kończy sesję i unieważnia token w Core. Odpowiedź to
       * przekierowanie, którego nie śledzimy; potem wystarczy ponownie zapytać o `me`.
       */
      signOut: async () => {
        await fetchImpl(`${baseUrl}/api/auth/sign-out`, {
          method: "POST",
          credentials: "same-origin",
          redirect: "manual",
        });
      },
    },
    teams: {
      list: () => request<TeamsList>("GET", "/teams"),
      candidates: () => request<TeamCandidatesList>("GET", "/teams/candidates"),
      create: (input: CreateTeamInput) => request<Team>("POST", "/teams", input),
      update: (teamId: string, input: UpdateTeamInput) =>
        request<Team>("PATCH", `/teams/${encodeSegment(teamId)}`, input),
      members: (teamId: string) => request<TeamMembersList>("GET", `/teams/${encodeSegment(teamId)}/members`),
    },
    states: {
      list: (teamId: string) => request<WorkflowStatesList>("GET", `/teams/${encodeSegment(teamId)}/states`),
      create: (teamId: string, input: CreateWorkflowStateInput) =>
        request<WorkflowState>("POST", `/teams/${encodeSegment(teamId)}/states`, input),
      update: (teamId: string, stateId: string, input: UpdateWorkflowStateInput) =>
        request<WorkflowState>("PATCH", `/teams/${encodeSegment(teamId)}/states/${encodeSegment(stateId)}`, input),
      delete: (teamId: string, stateId: string) =>
        requestVoid("DELETE", `/teams/${encodeSegment(teamId)}/states/${encodeSegment(stateId)}`),
    },
    labels: {
      list: (teamId: string) => request<LabelsList>("GET", `/teams/${encodeSegment(teamId)}/labels`),
      create: (teamId: string, input: CreateLabelInput) =>
        request<Label>("POST", `/teams/${encodeSegment(teamId)}/labels`, input),
      update: (teamId: string, labelId: string, input: UpdateLabelInput) =>
        request<Label>("PATCH", `/teams/${encodeSegment(teamId)}/labels/${encodeSegment(labelId)}`, input),
      delete: (teamId: string, labelId: string) =>
        requestVoid("DELETE", `/teams/${encodeSegment(teamId)}/labels/${encodeSegment(labelId)}`),
    },
    issues: {
      list: (query?: IssueListQuery) => requestPaginated<IssueListItem>("GET", `/issues${buildIssueListQuery(query)}`),
      create: (input: CreateIssueInput) => request<IssueDetail>("POST", "/issues", input),
      get: (idOrIdentifier: string) => request<IssueDetail>("GET", `/issues/${encodeSegment(idOrIdentifier)}`),
      update: (issueId: string, input: UpdateIssueInput) =>
        request<IssueDetail>("PATCH", `/issues/${encodeSegment(issueId)}`, input),
      delete: (issueId: string) => requestVoid("DELETE", `/issues/${encodeSegment(issueId)}`),
      addRelation: (issueId: string, input: CreateIssueRelationInput) =>
        request<IssueRelationView>("POST", `/issues/${encodeSegment(issueId)}/relations`, input),
      deleteRelation: (issueId: string, relationId: string) =>
        requestVoid("DELETE", `/issues/${encodeSegment(issueId)}/relations/${encodeSegment(relationId)}`),
      listComments: (issueId: string, query?: IssueCommentsQuery) =>
        requestPaginated<IssueComment>("GET", `/issues/${encodeSegment(issueId)}/comments${buildCursorQuery(query)}`),
      createComment: (issueId: string, input: CreateIssueCommentInput) =>
        request<IssueComment>("POST", `/issues/${encodeSegment(issueId)}/comments`, input),
      updateComment: (issueId: string, commentId: string, input: UpdateIssueCommentInput) =>
        request<IssueComment>("PATCH", `/issues/${encodeSegment(issueId)}/comments/${encodeSegment(commentId)}`, input),
      deleteComment: (issueId: string, commentId: string) =>
        requestVoid("DELETE", `/issues/${encodeSegment(issueId)}/comments/${encodeSegment(commentId)}`),
      addReaction: (issueId: string, commentId: string, emoji: CommentReactionEmoji) =>
        request<CommentReactionsResult>(
          "PUT",
          `/issues/${encodeSegment(issueId)}/comments/${encodeSegment(commentId)}/reactions/${encodeSegment(emoji)}`,
        ),
      removeReaction: (issueId: string, commentId: string, emoji: CommentReactionEmoji) =>
        requestVoid(
          "DELETE",
          `/issues/${encodeSegment(issueId)}/comments/${encodeSegment(commentId)}/reactions/${encodeSegment(emoji)}`,
        ),
      listActivity: (issueId: string, query?: IssueActivityQuery) =>
        requestPaginated<IssueActivityItem>(
          "GET",
          `/issues/${encodeSegment(issueId)}/activity${buildCursorQuery(query)}`,
        ),
      subscribe: (issueId: string) =>
        request<IssueSubscription>("PUT", `/issues/${encodeSegment(issueId)}/subscription`),
      unsubscribe: (issueId: string) => requestVoid("DELETE", `/issues/${encodeSegment(issueId)}/subscription`),
      listAttachments: (issueId: string, query?: IssueAttachmentsQuery) =>
        requestPaginated<IssueAttachment>(
          "GET",
          `/issues/${encodeSegment(issueId)}/attachments${buildCursorQuery(query)}`,
        ),
      uploadAttachment: (issueId: string, file: Blob, fileName: string) => {
        const formData = new FormData();
        formData.append("file", file, fileName);
        return request<IssueAttachment>("POST", `/issues/${encodeSegment(issueId)}/attachments`, formData);
      },
    },
    attachments: {
      list: (issueId: string, query?: IssueAttachmentsQuery) =>
        requestPaginated<IssueAttachment>(
          "GET",
          `/issues/${encodeSegment(issueId)}/attachments${buildCursorQuery(query)}`,
        ),
      upload: (issueId: string, file: Blob, fileName: string) => {
        const formData = new FormData();
        formData.append("file", file, fileName);
        return request<IssueAttachment>("POST", `/issues/${encodeSegment(issueId)}/attachments`, formData);
      },
      get: (attachmentId: string) => request<IssueAttachment>("GET", `/attachments/${encodeSegment(attachmentId)}`),
      delete: (attachmentId: string) => requestVoid("DELETE", `/attachments/${encodeSegment(attachmentId)}`),
      contentUrl: (attachmentId: string) => attachmentContentUrl(attachmentId, baseUrl),
    },
    storage: {
      get: () => request<StorageUsage>("GET", "/storage"),
    },
    inbox: {
      list: (query?: InboxListQuery) => requestPaginated<InboxItem>("GET", `/inbox${buildInboxQuery(query)}`),
      unreadCount: () => request<InboxUnreadCount>("GET", "/inbox/unread-count"),
      update: (itemId: string, input: UpdateInboxItemInput) =>
        request<InboxItem>("PATCH", `/inbox/${encodeSegment(itemId)}`, input),
      markAllRead: () => request<InboxReadAllResult>("POST", "/inbox/read-all"),
    },
    search: {
      issues: (q: string) => request<SearchIssuesResult>("GET", `/search?q=${encodeURIComponent(q)}`),
    },
  };
}

export {
  ATTACHMENT_CONTENT_TYPES,
  COLOR_TOKENS,
  COMMENT_REACTION_EMOJIS,
  DEFAULT_WORKFLOW_STATES,
  INBOX_FILTERS,
  INBOX_ITEM_KINDS,
  ISSUE_EVENT_TYPES,
  ISSUE_PRIORITIES,
  ISSUE_PRIORITY_LABELS,
  ISSUE_RELATION_DIRECTIONS,
  ISSUE_RELATION_TYPES,
  ISSUE_RELATION_VIEW_TYPES,
  ISSUE_SORT_OPTIONS,
  STORAGE_USAGE_STATES,
  WORKFLOW_STATE_CATEGORIES,
  type AttachmentContentType,
  type Capabilities,
  type ColorToken,
  type CommentReactionEmoji,
  type CommentReactionSummary,
  type CommentReactionsResult,
  type CoreUnitType,
  type CreateIssueCommentInput,
  type CreateIssueInput,
  type CreateIssueRelationInput,
  type CreateLabelInput,
  type CreateTeamInput,
  type CreateWorkflowStateInput,
  type InboxFilter,
  type InboxIssueSummary,
  type InboxItem,
  type InboxItemKind,
  type InboxListQuery,
  type InboxReadAllResult,
  type InboxUnreadCount,
  type IssueActivityCommentItem,
  type IssueActivityEventItem,
  type IssueActivityItem,
  type IssueActivityQuery,
  type IssueAttachment,
  type IssueAttachmentEventPayload,
  type IssueAttachmentUploader,
  type IssueAttachmentsQuery,
  type IssueComment,
  type IssueCommentsQuery,
  type IssueDetail,
  type IssueEvent,
  type IssueEventPayload,
  type IssueEventType,
  type IssueLabelSummary,
  type IssueListItem,
  type IssueListQuery,
  type IssuePriority,
  type IssuePriorityValue,
  type IssueReference,
  type IssueRelationDirection,
  type IssueRelationType,
  type IssueRelationView,
  type IssueRelationViewType,
  type IssueSort,
  type IssueStateSummary,
  type IssueSubscription,
  type Label,
  type LabelsList,
  type Me,
  type PaginatedResult,
  type SearchIssuesResult,
  type StorageUsage,
  type StorageUsageState,
  type Team,
  type TeamCandidate,
  type TeamCandidatesList,
  type TeamMember,
  type TeamMembersList,
  type TeamsList,
  type UpdateInboxItemInput,
  type UpdateIssueCommentInput,
  type UpdateIssueInput,
  type UpdateLabelInput,
  type UpdateTeamInput,
  type UpdateWorkflowStateInput,
  type WorkflowState,
  type WorkflowStateCategory,
  type WorkflowStatesList,
} from "@kivotasks/contracts";
