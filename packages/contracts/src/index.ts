/**
 * Kontrakt API KivoTasks (`https://kivo.monorise.studio/api/v1`): schematy i typy wspólne dla serwera
 * i przeglądarki. Format odpowiedzi jak w standardzie API Monorise: `{ data, meta, error }`.
 */
import { z } from "zod";

export const API_PREFIX = "/api/v1";

// ── Odpowiedzi, błędy i stronicowanie ───────────────────────────────────────

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "PRODUCT_ACCESS_REQUIRED",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "STORAGE_QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorDetail = z.object({
  field: z.string().optional(),
  message: z.string(),
});
export type ApiErrorDetail = z.infer<typeof ApiErrorDetail>;

export const ApiErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.array(ApiErrorDetail),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const ApiMeta = z.object({
  requestId: z.string(),
});
export type ApiMeta = z.infer<typeof ApiMeta>;

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export const PageLimit = z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT);
export const PageCursor = z.string().min(1).max(256);

export const ApiListMeta = ApiMeta.extend({
  nextCursor: z.string().nullable(),
});
export type ApiListMeta = z.infer<typeof ApiListMeta>;

/** Koperta udanej odpowiedzi API KivoTasks: `{ data, meta, error: null }` (ADR-0044). */
export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    meta: ApiMeta,
    error: z.null(),
  });
}

/** Koperta udanej odpowiedzi listy ze stronicowaniem kursorowym (`meta.nextCursor`). */
export function apiListSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    meta: ApiListMeta,
    error: z.null(),
  });
}

/** Koperta odpowiedzi błędu API KivoTasks: `{ data: null, meta, error }` (ADR-0044). */
export function apiErrorSchema<T extends z.ZodType = typeof ApiErrorBody>(error?: T) {
  return z.object({
    data: z.null(),
    meta: ApiMeta,
    error: (error ?? ApiErrorBody) as T,
  });
}

export const ApiErrorResponse = apiErrorSchema();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponse>;

export interface ApiResponse<T> {
  data: T | null;
  meta: { requestId?: string; nextCursor?: string | null; [key: string]: unknown };
  error: ApiErrorBody | null;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

export const Health = z.object({
  status: z.literal("ok"),
  version: z.string().nullable(),
});
export type Health = z.infer<typeof Health>;

// ── Zalogowana osoba i firma (z MonoriseCore) ───────────────────────────────

export const Capabilities = z.object({
  hasProductAccess: z.boolean(),
  readIssues: z.boolean(),
  writeIssues: z.boolean(),
  manageTeams: z.boolean(),
  createTeams: z.boolean(),
  manageProjects: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const Me = z.object({
  account: z.object({
    id: z.string(),
    email: z.string(),
  }),
  employee: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string(),
    jobTitle: z.string().nullable(),
  }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
  }),
  capabilities: Capabilities,
});
export type Me = z.infer<typeof Me>;

// ── Wspólne typy domenowe etapu 1a ──────────────────────────────────────────

export const COLOR_TOKENS = [
  "gray",
  "blue",
  "cyan",
  "teal",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
] as const;
export const ColorToken = z.enum(COLOR_TOKENS);
export type ColorToken = z.infer<typeof ColorToken>;

export const TEAM_KEY_REGEX = /^[A-Z]{2,5}$/;
export const TeamKey = z
  .string()
  .trim()
  .regex(TEAM_KEY_REGEX, "Klucz zespołu musi składać się z 2 do 5 wielkich liter A-Z");
export type TeamKey = z.infer<typeof TeamKey>;

export const ISSUE_IDENTIFIER_REGEX = /^[A-Za-z]{2,5}-[1-9]\d*$/;

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isRealCalendarDate(value: string): boolean {
  if (!DATE_ONLY_REGEX.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

export const DateOnlyString = z
  .string()
  .regex(DATE_ONLY_REGEX, "Podaj datę w formacie RRRR-MM-DD")
  .refine(isRealCalendarDate, "Podaj poprawną datę kalendarzową");
export type DateOnlyString = z.infer<typeof DateOnlyString>;

/** Górna granica pozycji statusu (kolumna INTEGER w bazie, z zapasem na kolejne statusy). */
export const WORKFLOW_STATE_POSITION_MAX = 1_000_000;

export const WORKFLOW_STATE_CATEGORIES = ["BACKLOG", "UNSTARTED", "STARTED", "COMPLETED", "CANCELED"] as const;
export const WorkflowStateCategory = z.enum(WORKFLOW_STATE_CATEGORIES);
export type WorkflowStateCategory = z.infer<typeof WorkflowStateCategory>;

export interface DefaultWorkflowStateDefinition {
  readonly name: string;
  readonly category: WorkflowStateCategory;
  readonly color: ColorToken;
  readonly position: number;
}

export const DEFAULT_WORKFLOW_STATES = [
  { name: "Backlog", category: "BACKLOG", color: "gray", position: 0 },
  { name: "Do zrobienia", category: "UNSTARTED", color: "blue", position: 1 },
  { name: "W toku", category: "STARTED", color: "yellow", position: 2 },
  { name: "Do przeglądu", category: "STARTED", color: "purple", position: 3 },
  { name: "Zrobione", category: "COMPLETED", color: "green", position: 4 },
  { name: "Anulowane", category: "CANCELED", color: "red", position: 5 },
] as const satisfies readonly DefaultWorkflowStateDefinition[];

export const ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type IssuePriorityValue = (typeof ISSUE_PRIORITIES)[number];
export const IssuePriority = z.number().int().min(0).max(4);
export type IssuePriority = z.infer<typeof IssuePriority>;

export const ISSUE_PRIORITY_LABELS: Record<IssuePriorityValue, string> = {
  0: "Brak",
  1: "Pilny",
  2: "Wysoki",
  3: "Średni",
  4: "Niski",
};

export const ISSUE_RELATION_TYPES = ["BLOCKS", "RELATED", "DUPLICATE"] as const;
export const IssueRelationType = z.enum(ISSUE_RELATION_TYPES);
export type IssueRelationType = z.infer<typeof IssueRelationType>;

export const ISSUE_RELATION_VIEW_TYPES = ["BLOCKS", "BLOCKED_BY", "RELATED", "DUPLICATE"] as const;
export const IssueRelationViewType = z.enum(ISSUE_RELATION_VIEW_TYPES);
export type IssueRelationViewType = z.infer<typeof IssueRelationViewType>;

export const ISSUE_RELATION_DIRECTIONS = ["OUTGOING", "INCOMING"] as const;
export const IssueRelationDirection = z.enum(ISSUE_RELATION_DIRECTIONS);
export type IssueRelationDirection = z.infer<typeof IssueRelationDirection>;

export const ISSUE_SORT_OPTIONS = ["priority", "updated", "created", "dueDate", "manual"] as const;
export const IssueSort = z.enum(ISSUE_SORT_OPTIONS);
export type IssueSort = z.infer<typeof IssueSort>;

// ── Zespoły ─────────────────────────────────────────────────────────────────

export const Team = z.object({
  id: z.string(),
  organizationId: z.string(),
  key: z.string(),
  name: z.string(),
  nextIssueNumber: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type Team = z.infer<typeof Team>;

export const TeamsList = z.object({
  teams: z.array(Team),
});
export type TeamsList = z.infer<typeof TeamsList>;

export const CreateTeamInput = z.object({
  unitId: z.uuid("Podaj poprawny identyfikator jednostki organizacyjnej"),
  key: TeamKey,
});
export type CreateTeamInput = z.input<typeof CreateTeamInput>;

export const UpdateTeamInput = z.object({
  key: TeamKey,
});
export type UpdateTeamInput = z.input<typeof UpdateTeamInput>;

export const CoreUnitType = z.enum(["BRANCH", "DEPARTMENT", "TEAM"]);
export type CoreUnitType = z.infer<typeof CoreUnitType>;

export const TeamCandidate = z.object({
  id: z.string(),
  name: z.string(),
  type: CoreUnitType,
  parentId: z.string().nullable(),
});
export type TeamCandidate = z.infer<typeof TeamCandidate>;

export const TeamCandidatesList = z.object({
  candidates: z.array(TeamCandidate),
});
export type TeamCandidatesList = z.infer<typeof TeamCandidatesList>;

export const TeamMember = z.object({
  accountId: z.string(),
  employeeId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamMembersList = z.object({
  members: z.array(TeamMember),
});
export type TeamMembersList = z.infer<typeof TeamMembersList>;

// ── Statusy obiegu zadań ────────────────────────────────────────────────────

export const WorkflowState = z.object({
  id: z.string(),
  organizationId: z.string(),
  teamId: z.string(),
  name: z.string(),
  category: WorkflowStateCategory,
  color: ColorToken,
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowState = z.infer<typeof WorkflowState>;

export const WorkflowStatesList = z.object({
  states: z.array(WorkflowState),
});
export type WorkflowStatesList = z.infer<typeof WorkflowStatesList>;

export const CreateWorkflowStateInput = z.object({
  name: z.string().trim().min(1, "Nazwa statusu jest wymagana").max(40, "Nazwa statusu może mieć najwyżej 40 znaków"),
  category: WorkflowStateCategory,
  color: ColorToken,
  position: z.number().int().min(0).max(WORKFLOW_STATE_POSITION_MAX).optional(),
});
export type CreateWorkflowStateInput = z.input<typeof CreateWorkflowStateInput>;

export const UpdateWorkflowStateInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nazwa statusu nie może być pusta")
    .max(40, "Nazwa statusu może mieć najwyżej 40 znaków")
    .optional(),
  category: WorkflowStateCategory.optional(),
  color: ColorToken.optional(),
  position: z.number().int().min(0).max(WORKFLOW_STATE_POSITION_MAX).optional(),
});
export type UpdateWorkflowStateInput = z.input<typeof UpdateWorkflowStateInput>;

// ── Etykiety ────────────────────────────────────────────────────────────────

export const Label = z.object({
  id: z.string(),
  organizationId: z.string(),
  teamId: z.string(),
  name: z.string(),
  color: ColorToken,
  createdAt: z.string(),
});
export type Label = z.infer<typeof Label>;

export const LabelsList = z.object({
  labels: z.array(Label),
});
export type LabelsList = z.infer<typeof LabelsList>;

export const CreateLabelInput = z.object({
  name: z.string().trim().min(1, "Nazwa etykiety jest wymagana").max(40, "Nazwa etykiety może mieć najwyżej 40 znaków"),
  color: ColorToken,
});
export type CreateLabelInput = z.input<typeof CreateLabelInput>;

export const UpdateLabelInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nazwa etykiety nie może być pusta")
    .max(40, "Nazwa etykiety może mieć najwyżej 40 znaków")
    .optional(),
  color: ColorToken.optional(),
});
export type UpdateLabelInput = z.input<typeof UpdateLabelInput>;

// ── Zadania, relacje i wyszukiwanie ─────────────────────────────────────────

export const IssueStateSummary = z.object({
  id: z.string(),
  name: z.string(),
  category: WorkflowStateCategory,
  color: ColorToken,
  position: z.number().int(),
});
export type IssueStateSummary = z.infer<typeof IssueStateSummary>;

export const IssueLabelSummary = z.object({
  id: z.string(),
  name: z.string(),
  color: ColorToken,
});
export type IssueLabelSummary = z.infer<typeof IssueLabelSummary>;

export const IssueReference = z.object({
  id: z.string(),
  teamId: z.string(),
  identifier: z.string(),
  number: z.number().int(),
  title: z.string(),
  priority: IssuePriority,
  state: IssueStateSummary,
  assigneeAccountId: z.string().nullable(),
});
export type IssueReference = z.infer<typeof IssueReference>;

export const IssueRelationView = z.object({
  id: z.string(),
  type: IssueRelationViewType,
  direction: IssueRelationDirection,
  relatedIssue: IssueReference,
  createdAt: z.string(),
});
export type IssueRelationView = z.infer<typeof IssueRelationView>;

export const IssueListItem = z.object({
  id: z.string(),
  organizationId: z.string(),
  teamId: z.string(),
  identifier: z.string(),
  number: z.number().int(),
  title: z.string(),
  stateId: z.string(),
  state: IssueStateSummary,
  priority: IssuePriority,
  assigneeAccountId: z.string().nullable(),
  creatorAccountId: z.string(),
  dueDate: z.string().nullable(),
  estimate: z.number().int().nullable(),
  parentId: z.string().nullable(),
  sortOrder: z.number(),
  labels: z.array(IssueLabelSummary),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueListItem = z.infer<typeof IssueListItem>;

export const IssueList = z.array(IssueListItem);
export type IssueList = z.infer<typeof IssueList>;

export const IssueDetail = IssueListItem.extend({
  description: z.string().nullable(),
  parent: IssueReference.nullable(),
  children: z.array(IssueReference),
  relations: z.array(IssueRelationView),
  isSubscribed: z.boolean(),
});
export type IssueDetail = z.infer<typeof IssueDetail>;

export const CreateIssueInput = z.object({
  teamId: z.uuid("Podaj poprawny identyfikator zespołu"),
  title: z
    .string()
    .trim()
    .min(1, "Tytuł zadania jest wymagany")
    .max(255, "Tytuł zadania może mieć najwyżej 255 znaków"),
  description: z.string().max(50_000, "Opis może mieć najwyżej 50 000 znaków").nullable().optional(),
  stateId: z.uuid("Podaj poprawny identyfikator statusu").optional(),
  priority: IssuePriority.optional(),
  assigneeAccountId: z.uuid("Podaj poprawny identyfikator osoby przypisanej").nullable().optional(),
  labelIds: z.array(z.uuid("Podaj poprawny identyfikator etykiety")).max(50).optional(),
  dueDate: DateOnlyString.nullable().optional(),
  estimate: z.number().int().min(0).max(100).nullable().optional(),
  parentId: z.uuid("Podaj poprawny identyfikator zadania nadrzędnego").nullable().optional(),
});
export type CreateIssueInput = z.input<typeof CreateIssueInput>;

export const UpdateIssueInput = z.object({
  teamId: z.uuid("Podaj poprawny identyfikator zespołu").optional(),
  title: z
    .string()
    .trim()
    .min(1, "Tytuł zadania nie może być pusty")
    .max(255, "Tytuł zadania może mieć najwyżej 255 znaków")
    .optional(),
  description: z.string().max(50_000, "Opis może mieć najwyżej 50 000 znaków").nullable().optional(),
  stateId: z.uuid("Podaj poprawny identyfikator statusu").optional(),
  priority: IssuePriority.optional(),
  assigneeAccountId: z.uuid("Podaj poprawny identyfikator osoby przypisanej").nullable().optional(),
  labelIds: z.array(z.uuid("Podaj poprawny identyfikator etykiety")).max(50).optional(),
  dueDate: DateOnlyString.nullable().optional(),
  estimate: z.number().int().min(0).max(100).nullable().optional(),
  parentId: z.uuid("Podaj poprawny identyfikator zadania nadrzędnego").nullable().optional(),
  sortOrder: z.number().finite().optional(),
});
export type UpdateIssueInput = z.input<typeof UpdateIssueInput>;

export const CreateIssueRelationInput = z.object({
  relatedIssueId: z.uuid("Podaj poprawny identyfikator powiązanego zadania"),
  type: IssueRelationViewType,
});
export type CreateIssueRelationInput = z.input<typeof CreateIssueRelationInput>;

export const AssigneeFilter = z.union([
  z.literal("me"),
  z.literal("none"),
  z.uuid("Podaj 'me', 'none' lub poprawny identyfikator konta"),
]);
export type AssigneeFilter = z.infer<typeof AssigneeFilter>;

export const ParentFilter = z.union([
  z.literal("none"),
  z.uuid("Podaj 'none' lub poprawny identyfikator zadania nadrzędnego"),
]);
export type ParentFilter = z.infer<typeof ParentFilter>;

export const BooleanQueryParam = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const IssueListQuery = z.object({
  teamId: z.uuid("Podaj poprawny identyfikator zespołu").optional(),
  stateId: z.uuid("Podaj poprawny identyfikator statusu").optional(),
  stateCategory: WorkflowStateCategory.optional(),
  assignee: AssigneeFilter.optional(),
  labelId: z.uuid("Podaj poprawny identyfikator etykiety").optional(),
  priority: z.coerce.number().int().min(0).max(4).optional(),
  parentId: ParentFilter.optional(),
  q: z.string().trim().max(200).optional(),
  includeCompleted: BooleanQueryParam.optional(),
  sort: IssueSort.default("updated"),
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type IssueListQuery = z.input<typeof IssueListQuery>;
export type ParsedIssueListQuery = z.infer<typeof IssueListQuery>;

export const SearchIssuesQuery = z.object({
  q: z.string().trim().max(200).default(""),
});
export type SearchIssuesQuery = z.input<typeof SearchIssuesQuery>;

export const SearchIssuesResult = z.object({
  issues: z.array(IssueListItem),
});
export type SearchIssuesResult = z.infer<typeof SearchIssuesResult>;

// ── Współpraca etapu 2a: komentarze, reakcje, historia, obserwujący i skrzynka ──

export const COMMENT_REACTION_EMOJIS = ["👍", "❤️", "🎉", "😄", "👀", "🚀"] as const;
export const CommentReactionEmoji = z.enum(COMMENT_REACTION_EMOJIS);
export type CommentReactionEmoji = z.infer<typeof CommentReactionEmoji>;

export const ISSUE_EVENT_TYPES = [
  "CREATED",
  "TITLE_CHANGED",
  "DESCRIPTION_CHANGED",
  "STATE_CHANGED",
  "PRIORITY_CHANGED",
  "ASSIGNEE_CHANGED",
  "LABELS_CHANGED",
  "DUE_DATE_CHANGED",
  "ESTIMATE_CHANGED",
  "PARENT_CHANGED",
  "RELATION_ADDED",
  "RELATION_REMOVED",
  "DELETED",
  "ATTACHMENT_ADDED",
  "ATTACHMENT_REMOVED",
] as const;
export const IssueEventType = z.enum(ISSUE_EVENT_TYPES);
export type IssueEventType = z.infer<typeof IssueEventType>;

export const INBOX_ITEM_KINDS = ["ASSIGNED", "MENTIONED", "COMMENTED"] as const;
export const InboxItemKind = z.enum(INBOX_ITEM_KINDS);
export type InboxItemKind = z.infer<typeof InboxItemKind>;

export const INBOX_FILTERS = ["unread", "all"] as const;
export const InboxFilter = z.enum(INBOX_FILTERS);
export type InboxFilter = z.infer<typeof InboxFilter>;

export const CommentReactionSummary = z.object({
  emoji: CommentReactionEmoji,
  count: z.number().int().min(1),
  reactedByMe: z.boolean(),
});
export type CommentReactionSummary = z.infer<typeof CommentReactionSummary>;

export const IssueComment = z.object({
  id: z.string(),
  organizationId: z.string(),
  teamId: z.string(),
  issueId: z.string(),
  authorAccountId: z.string(),
  authorName: z.string().nullable(),
  body: z.string().nullable(),
  deleted: z.boolean(),
  mentionedAccountIds: z.array(z.string()),
  reactions: z.array(CommentReactionSummary),
  createdAt: z.string(),
  updatedAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type IssueComment = z.infer<typeof IssueComment>;

export const IssueCommentList = z.array(IssueComment);
export type IssueCommentList = z.infer<typeof IssueCommentList>;

export const CreateIssueCommentInput = z.object({
  body: z
    .string()
    .min(1, "Treść komentarza jest wymagana")
    .max(10_000, "Komentarz może mieć najwyżej 10 000 znaków")
    .refine((value) => !value.includes("\u0000"), "Treść komentarza nie może zawierać znaku NUL")
    .refine((value) => value.trim().length > 0, "Treść komentarza jest wymagana"),
});
export type CreateIssueCommentInput = z.input<typeof CreateIssueCommentInput>;

export const UpdateIssueCommentInput = z.object({
  body: z
    .string()
    .min(1, "Treść komentarza nie może być pusta")
    .max(10_000, "Komentarz może mieć najwyżej 10 000 znaków")
    .refine((value) => !value.includes("\u0000"), "Treść komentarza nie może zawierać znaku NUL")
    .refine((value) => value.trim().length > 0, "Treść komentarza nie może być pusta"),
});
export type UpdateIssueCommentInput = z.input<typeof UpdateIssueCommentInput>;

export const CommentReactionsResult = z.object({
  commentId: z.string(),
  reactions: z.array(CommentReactionSummary),
});
export type CommentReactionsResult = z.infer<typeof CommentReactionsResult>;

export const IssueCommentsQuery = z.object({
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type IssueCommentsQuery = z.input<typeof IssueCommentsQuery>;
export type ParsedIssueCommentsQuery = z.infer<typeof IssueCommentsQuery>;

export const IssueEventPayload = z.record(z.string(), z.unknown()).nullable();
export type IssueEventPayload = z.infer<typeof IssueEventPayload>;

export const IssueEvent = z.object({
  id: z.string(),
  organizationId: z.string(),
  teamId: z.string(),
  issueId: z.string(),
  actorAccountId: z.string(),
  actorName: z.string().nullable(),
  type: IssueEventType,
  before: IssueEventPayload,
  after: IssueEventPayload,
  createdAt: z.string(),
});
export type IssueEvent = z.infer<typeof IssueEvent>;

export const IssueActivityCommentItem = z.object({
  kind: z.literal("comment"),
  id: z.string(),
  createdAt: z.string(),
  comment: IssueComment,
});
export type IssueActivityCommentItem = z.infer<typeof IssueActivityCommentItem>;

export const IssueActivityEventItem = z.object({
  kind: z.literal("event"),
  id: z.string(),
  createdAt: z.string(),
  event: IssueEvent,
});
export type IssueActivityEventItem = z.infer<typeof IssueActivityEventItem>;

export const IssueActivityItem = z.discriminatedUnion("kind", [IssueActivityCommentItem, IssueActivityEventItem]);
export type IssueActivityItem = z.infer<typeof IssueActivityItem>;

export const IssueActivityList = z.array(IssueActivityItem);
export type IssueActivityList = z.infer<typeof IssueActivityList>;

export const IssueActivityQuery = z.object({
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type IssueActivityQuery = z.input<typeof IssueActivityQuery>;
export type ParsedIssueActivityQuery = z.infer<typeof IssueActivityQuery>;

export const IssueSubscription = z.object({
  issueId: z.string(),
  isSubscribed: z.boolean(),
});
export type IssueSubscription = z.infer<typeof IssueSubscription>;

export const InboxIssueSummary = z.object({
  id: z.string(),
  teamId: z.string(),
  identifier: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: IssueStateSummary,
});
export type InboxIssueSummary = z.infer<typeof InboxIssueSummary>;

export const InboxItem = z.object({
  id: z.string(),
  organizationId: z.string(),
  recipientAccountId: z.string(),
  kind: InboxItemKind,
  issueId: z.string(),
  issue: InboxIssueSummary,
  actorAccountId: z.string(),
  actorName: z.string().nullable(),
  commentId: z.string().nullable(),
  commentExcerpt: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const InboxItemList = z.array(InboxItem);
export type InboxItemList = z.infer<typeof InboxItemList>;

export const InboxListQuery = z.object({
  filter: InboxFilter.default("all"),
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type InboxListQuery = z.input<typeof InboxListQuery>;
export type ParsedInboxListQuery = z.infer<typeof InboxListQuery>;

export const InboxUnreadCount = z.object({
  unreadCount: z.number().int().min(0),
});
export type InboxUnreadCount = z.infer<typeof InboxUnreadCount>;

export const UpdateInboxItemInput = z
  .object({
    read: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((data) => data.read !== undefined || data.archived !== undefined, "Podaj co najmniej jedno pole do zmiany");
export type UpdateInboxItemInput = z.input<typeof UpdateInboxItemInput>;

export const InboxReadAllResult = z.object({
  updatedCount: z.number().int().min(0),
});
export type InboxReadAllResult = z.infer<typeof InboxReadAllResult>;

// ── Załączniki i limit miejsca (etap 2b) ────────────────────────────────────

export const ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/octet-stream",
] as const;
export const AttachmentContentType = z.enum(ATTACHMENT_CONTENT_TYPES);
export type AttachmentContentType = z.infer<typeof AttachmentContentType>;

export const IssueAttachmentUploader = z.object({
  accountId: z.string(),
  name: z.string(),
});
export type IssueAttachmentUploader = z.infer<typeof IssueAttachmentUploader>;

export const IssueAttachment = z.object({
  id: z.string(),
  issueId: z.string(),
  fileName: z.string(),
  contentType: AttachmentContentType,
  sizeBytes: z.number().int().min(1),
  uploader: IssueAttachmentUploader,
  createdAt: z.string(),
  contentUrl: z.string(),
  inline: z.boolean(),
  canDelete: z.boolean(),
});
export type IssueAttachment = z.infer<typeof IssueAttachment>;

export const IssueAttachmentList = z.array(IssueAttachment);
export type IssueAttachmentList = z.infer<typeof IssueAttachmentList>;

export const IssueAttachmentsQuery = z.object({
  limit: PageLimit,
  cursor: PageCursor.optional(),
});
export type IssueAttachmentsQuery = z.input<typeof IssueAttachmentsQuery>;
export type ParsedIssueAttachmentsQuery = z.infer<typeof IssueAttachmentsQuery>;

export const IssueAttachmentEventPayload = z.object({
  attachmentId: z.string(),
  fileName: z.string(),
  sizeBytes: z.number().int().min(1),
  contentType: AttachmentContentType,
});
export type IssueAttachmentEventPayload = z.infer<typeof IssueAttachmentEventPayload>;

export const STORAGE_USAGE_STATES = ["OK", "WARNING", "FULL"] as const;
export const StorageUsageState = z.enum(STORAGE_USAGE_STATES);
export type StorageUsageState = z.infer<typeof StorageUsageState>;

export const StorageUsage = z.object({
  usedBytes: z.number().int().min(0),
  quotaBytes: z.number().int().min(1),
  maxFileBytes: z.number().int().min(1),
  usedRatio: z.number().min(0),
  state: StorageUsageState,
});
export type StorageUsage = z.infer<typeof StorageUsage>;

export * from "./permissions.js";
