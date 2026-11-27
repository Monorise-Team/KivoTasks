import {
  COMMENT_REACTION_EMOJIS,
  CommentReactionEmoji,
  type CommentReactionSummary,
  type IssueEventPayload,
  type IssueEventType,
} from "@kivotasks/contracts";
import { z } from "zod";
import { ApiFailure } from "./api";

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const IsoDateTimeSchema = z.iso.datetime();

/**
 * Wzorzec tokenu wzmianki wstawianego przez edytor: `@[Anna Nowak](<accountId UUID>)`.
 */
export const MENTION_TOKEN_REGEX =
  /@\[([^\]\r\n]{1,120})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_SPAN_REGEX = /`[^`\r\n]*`/g;

/**
 * Usuwa fragmenty kodu (bloki ``` i kod śródliniowy `...`) przed wyłuskiwaniem wzmianek,
 * aby przykłady techniczne nie wyzwalały powiadomień.
 */
function stripCodeForMentions(markdown: string): string {
  return markdown.replace(FENCED_CODE_BLOCK_REGEX, " ").replace(INLINE_CODE_SPAN_REGEX, " ");
}

/**
 * Wyłuskuje z treści komentarza unikalne identyfikatory kont z tokenów `@[Imię Nazwisko](<uuid>)`
 * z zachowaniem kolejności występowania (z pominięciem bloków i fragmentów kodu).
 */
export function extractMentionAccountIds(body: string): string[] {
  const cleaned = stripCodeForMentions(body);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of cleaned.matchAll(MENTION_TOKEN_REGEX)) {
    const accountId = match[2]?.toLowerCase();
    if (accountId && !seen.has(accountId)) {
      seen.add(accountId);
      result.push(accountId);
    }
  }
  return result;
}

/**
 * Zostawia wyłącznie identyfikatory kont należące do aktywnych członków zespołu (katalog Core).
 */
export function filterValidMentionAccountIds(
  candidateAccountIds: readonly string[],
  activeMemberAccountIds: ReadonlySet<string>,
): string[] {
  const normalizedAllowed = new Set<string>();
  for (const id of activeMemberAccountIds) {
    normalizedAllowed.add(id.toLowerCase());
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawId of candidateAccountIds) {
    const id = rawId.toLowerCase();
    if (normalizedAllowed.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * Rozstrzyga odbiorców wpisu `ASSIGNED` w skrzynce powiadomień:
 * trafia wyłącznie do nowej osoby przypisanej i nigdy do sprawcy zmiany.
 */
export function computeAssignmentInboxRecipients(params: {
  previousAssigneeAccountId: string | null;
  nextAssigneeAccountId: string | null;
  actorAccountId: string;
}): string[] {
  if (!params.nextAssigneeAccountId) return [];
  if (params.nextAssigneeAccountId === params.previousAssigneeAccountId) return [];
  if (params.nextAssigneeAccountId === params.actorAccountId) return [];
  return [params.nextAssigneeAccountId];
}

export interface CommentInboxFanout {
  readonly mentionedRecipients: string[];
  readonly commentedRecipients: string[];
}

/**
 * Wylicza odbiorców wpisów w skrzynce dla nowego komentarza:
 * - `MENTIONED` dla każdej wspomnianej osoby poza autorem,
 * - `COMMENTED` dla każdego obserwującego zadanie poza autorem i poza osobami, które dostały `MENTIONED`.
 */
export function computeCommentInboxFanout(params: {
  authorAccountId: string;
  mentionedAccountIds: readonly string[];
  subscriberAccountIds: readonly string[];
}): CommentInboxFanout {
  const author = params.authorAccountId.toLowerCase();

  const mentionedSet = new Set<string>();
  const mentionedRecipients: string[] = [];
  for (const rawId of params.mentionedAccountIds) {
    const id = rawId.toLowerCase();
    if (id === author || mentionedSet.has(id)) continue;
    mentionedSet.add(id);
    mentionedRecipients.push(rawId);
  }

  const commentedSet = new Set<string>();
  const commentedRecipients: string[] = [];
  for (const rawId of params.subscriberAccountIds) {
    const id = rawId.toLowerCase();
    if (id === author || mentionedSet.has(id) || commentedSet.has(id)) continue;
    commentedSet.add(id);
    commentedRecipients.push(rawId);
  }

  return { mentionedRecipients, commentedRecipients };
}

/**
 * Wylicza odbiorców nowych wzmianek po edycji komentarza (wyłącznie osoby nowo wspomniane, bez autora).
 */
export function computeCommentEditMentionRecipients(params: {
  authorAccountId: string;
  previousMentionedAccountIds: readonly string[];
  nextMentionedAccountIds: readonly string[];
}): string[] {
  const author = params.authorAccountId.toLowerCase();
  const previous = new Set(params.previousMentionedAccountIds.map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const rawId of params.nextMentionedAccountIds) {
    const id = rawId.toLowerCase();
    if (id === author || previous.has(id) || seen.has(id)) continue;
    seen.add(id);
    recipients.push(rawId);
  }
  return recipients;
}

/**
 * Buduje krótką, bezpieczną zajawkę tekstową komentarza do skrzynki powiadomień.
 * Zweryfikowane wzmianki zamienia na `@Imię Nazwisko`, pozostałe tokeny zostawia jako zwykły tekst.
 */
export function buildCommentExcerpt(
  body: string | null,
  mentionedAccountIds: readonly string[],
  maxLength = 140,
): string | null {
  if (!body) return null;
  const mentionedSet = new Set(mentionedAccountIds.map((id) => id.toLowerCase()));
  const withMentions = body.replace(MENTION_TOKEN_REGEX, (full, label: string, id: string) =>
    mentionedSet.has(id.toLowerCase()) ? `@${label}` : full,
  );
  const plain = withMentions
    .replace(FENCED_CODE_BLOCK_REGEX, (block) => block.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""))
    .replace(/(?<!@)!?\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!plain) return null;
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/**
 * Grupuje wiersze reakcji komentarza według stałego porządku `COMMENT_REACTION_EMOJIS`.
 */
export function aggregateCommentReactions(
  rows: readonly { emoji: string; accountId: string }[],
  viewerAccountId: string,
): CommentReactionSummary[] {
  const viewer = viewerAccountId.toLowerCase();
  const counts = new Map<CommentReactionEmoji, { count: number; reactedByMe: boolean }>();

  for (const row of rows) {
    const parsed = CommentReactionEmoji.safeParse(row.emoji);
    if (!parsed.success) continue;
    const current = counts.get(parsed.data) ?? { count: 0, reactedByMe: false };
    current.count += 1;
    if (row.accountId.toLowerCase() === viewer) {
      current.reactedByMe = true;
    }
    counts.set(parsed.data, current);
  }

  const summaries: CommentReactionSummary[] = [];
  for (const emoji of COMMENT_REACTION_EMOJIS) {
    const entry = counts.get(emoji);
    if (entry && entry.count > 0) {
      summaries.push({ emoji, count: entry.count, reactedByMe: entry.reactedByMe });
    }
  }
  return summaries;
}

/**
 * Dekoduje i waliduje parametr ścieżki `{emoji}` dla reakcji komentarza.
 */
export function parseReactionEmojiParam(raw: string): CommentReactionEmoji {
  let decoded = raw;
  if (raw.includes("%")) {
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
        { field: "emoji", message: "Nieprawidłowe kodowanie emoji" },
      ]);
    }
  }
  const parsed = CommentReactionEmoji.safeParse(decoded);
  if (!parsed.success) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      {
        field: "emoji",
        message: `Dozwolone reakcje to: ${COMMENT_REACTION_EMOJIS.join(" ")}`,
      },
    ]);
  }
  return parsed.data;
}

// ── Budowanie wpisów historii zmian zadania (`issue_events`) ────────────────

export interface IssueEventLabelSnapshot {
  readonly id: string;
  readonly name: string;
}

export interface IssueEventStateSnapshot {
  readonly id: string;
  readonly name: string;
}

export interface IssueEventParentSnapshot {
  readonly id: string;
  readonly identifier: string;
}

export interface IssueEventDiffSnapshot {
  readonly title: string;
  readonly description: string | null;
  readonly state: IssueEventStateSnapshot;
  readonly priority: number;
  readonly assigneeAccountId: string | null;
  readonly labels: readonly IssueEventLabelSnapshot[];
  readonly dueDate: string | null;
  readonly estimate: number | null;
  readonly parent: IssueEventParentSnapshot | null;
}

export interface PendingIssueEvent {
  readonly type: IssueEventType;
  readonly before: IssueEventPayload;
  readonly after: IssueEventPayload;
}

function normalizeLabelSnapshot(labels: readonly IssueEventLabelSnapshot[]): IssueEventLabelSnapshot[] {
  return [...labels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sameLabelSet(a: readonly IssueEventLabelSnapshot[], b: readonly IssueEventLabelSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.id !== b[i]?.id) return false;
  }
  return true;
}

/**
 * Porównuje stan zadania przed i po aktualizacji i zwraca listę wpisów `issue_events`.
 * Zwraca pustą tablicę, gdy żadne z rejestrowanych pól się nie zmieniło.
 * Dla zmiany opisu zapisuje wyłącznie flagę obecności (`hasDescription`), nigdy pełnej treści.
 */
export function buildIssueUpdateEvents(
  before: IssueEventDiffSnapshot,
  after: IssueEventDiffSnapshot,
): PendingIssueEvent[] {
  const events: PendingIssueEvent[] = [];

  if (before.title !== after.title) {
    events.push({
      type: "TITLE_CHANGED",
      before: { title: before.title },
      after: { title: after.title },
    });
  }

  const beforeDesc = before.description === null || before.description === "" ? null : before.description;
  const afterDesc = after.description === null || after.description === "" ? null : after.description;
  if (beforeDesc !== afterDesc) {
    events.push({
      type: "DESCRIPTION_CHANGED",
      before: { hasDescription: beforeDesc !== null },
      after: { hasDescription: afterDesc !== null },
    });
  }

  if (before.state.id !== after.state.id) {
    events.push({
      type: "STATE_CHANGED",
      before: { stateId: before.state.id, stateName: before.state.name },
      after: { stateId: after.state.id, stateName: after.state.name },
    });
  }

  if (before.priority !== after.priority) {
    events.push({
      type: "PRIORITY_CHANGED",
      before: { priority: before.priority },
      after: { priority: after.priority },
    });
  }

  if (before.assigneeAccountId !== after.assigneeAccountId) {
    events.push({
      type: "ASSIGNEE_CHANGED",
      before: { assigneeAccountId: before.assigneeAccountId },
      after: { assigneeAccountId: after.assigneeAccountId },
    });
  }

  const prevLabels = normalizeLabelSnapshot(before.labels);
  const nextLabels = normalizeLabelSnapshot(after.labels);
  if (!sameLabelSet(prevLabels, nextLabels)) {
    events.push({
      type: "LABELS_CHANGED",
      before: { labels: prevLabels.map((item) => ({ id: item.id, name: item.name })) },
      after: { labels: nextLabels.map((item) => ({ id: item.id, name: item.name })) },
    });
  }

  if (before.dueDate !== after.dueDate) {
    events.push({
      type: "DUE_DATE_CHANGED",
      before: { dueDate: before.dueDate },
      after: { dueDate: after.dueDate },
    });
  }

  if (before.estimate !== after.estimate) {
    events.push({
      type: "ESTIMATE_CHANGED",
      before: { estimate: before.estimate },
      after: { estimate: after.estimate },
    });
  }

  if ((before.parent?.id ?? null) !== (after.parent?.id ?? null)) {
    events.push({
      type: "PARENT_CHANGED",
      before: { parentId: before.parent?.id ?? null, parentIdentifier: before.parent?.identifier ?? null },
      after: { parentId: after.parent?.id ?? null, parentIdentifier: after.parent?.identifier ?? null },
    });
  }

  return events;
}

export interface IssueEventTeamRefs {
  readonly relatedIssueTeamId?: string | null;
  readonly parentBeforeTeamId?: string | null;
  readonly parentAfterTeamId?: string | null;
}

function readTeamIdField(payload: IssueEventPayload, key: string): string | null {
  if (!payload) return null;
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isReadableTeam(teamId: string | null, readableTeamIds: "ALL" | readonly string[]): boolean {
  if (readableTeamIds === "ALL") return true;
  return teamId !== null && readableTeamIds.includes(teamId);
}

function redactRelationPayload(payload: IssueEventPayload): IssueEventPayload {
  if (!payload) return null;
  const redacted: Record<string, unknown> = { ...payload };
  redacted.relatedIssueId = null;
  redacted.relatedIssueTeamId = null;
  redacted.relatedIssueIdentifier = null;
  redacted.relatedIssueTitle = null;
  if ("title" in redacted) {
    redacted.title = null;
  }
  return redacted;
}

function redactParentPayload(payload: IssueEventPayload): IssueEventPayload {
  if (!payload) return null;
  const redacted: Record<string, unknown> = { ...payload };
  redacted.parentId = null;
  redacted.parentTeamId = null;
  redacted.parentIdentifier = null;
  redacted.parentTitle = null;
  redacted.redacted = true;
  if ("title" in redacted) {
    redacted.title = null;
  }
  return redacted;
}

/**
 * Redaguje w zdarzeniu historii odwołania do zadań z zespołów spoza `readableTeamIds`,
 * zamieniając identyfikator, tytuł oraz ID zadania/zespołu na `null` (fail-closed, gdy zespół nieznany).
 */
export function redactIssueEvent<
  T extends { readonly type: IssueEventType; readonly before: IssueEventPayload; readonly after: IssueEventPayload },
>(event: T, readableTeamIds: "ALL" | readonly string[], refs?: IssueEventTeamRefs): T {
  if (readableTeamIds === "ALL") return event;

  if (event.type === "RELATION_ADDED") {
    const teamId = refs?.relatedIssueTeamId ?? readTeamIdField(event.after, "relatedIssueTeamId");
    if (!isReadableTeam(teamId, readableTeamIds)) {
      return { ...event, after: redactRelationPayload(event.after) };
    }
    return event;
  }

  if (event.type === "RELATION_REMOVED") {
    const teamId = refs?.relatedIssueTeamId ?? readTeamIdField(event.before, "relatedIssueTeamId");
    if (!isReadableTeam(teamId, readableTeamIds)) {
      return { ...event, before: redactRelationPayload(event.before) };
    }
    return event;
  }

  if (event.type === "PARENT_CHANGED") {
    let nextBefore = event.before;
    let nextAfter = event.after;
    let changed = false;

    const beforeHasParent = Boolean(
      event.before && (event.before.parentId !== null || event.before.parentIdentifier !== null),
    );
    if (beforeHasParent) {
      const beforeTeamId = refs?.parentBeforeTeamId ?? readTeamIdField(event.before, "parentTeamId");
      if (!isReadableTeam(beforeTeamId, readableTeamIds)) {
        nextBefore = redactParentPayload(event.before);
        changed = true;
      }
    }

    const afterHasParent = Boolean(
      event.after && (event.after.parentId !== null || event.after.parentIdentifier !== null),
    );
    if (afterHasParent) {
      const afterTeamId = refs?.parentAfterTeamId ?? readTeamIdField(event.after, "parentTeamId");
      if (!isReadableTeam(afterTeamId, readableTeamIds)) {
        nextAfter = redactParentPayload(event.after);
        changed = true;
      }
    }

    return changed ? { ...event, before: nextBefore, after: nextAfter } : event;
  }

  return event;
}

// ── Stronicowanie kursorowe (komentarze, aktywność, skrzynka) ───────────────

function invalidCursorError(): ApiFailure {
  return new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
    { field: "cursor", message: "Nieprawidłowy kursor stronicowania" },
  ]);
}

function encodeBase64Json(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeBase64Json<T extends object>(cursor: string, schema: z.ZodType<T>): T {
  if (!BASE64URL_REGEX.test(cursor)) {
    throw invalidCursorError();
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursorError();
  }
  const parsed = schema.safeParse(rawJson);
  if (!parsed.success) {
    throw invalidCursorError();
  }
  if (encodeBase64Json(parsed.data) !== cursor) {
    throw invalidCursorError();
  }
  return parsed.data;
}

const TimeIdCursorSchema = z.object({
  t: IsoDateTimeSchema,
  id: z.uuid(),
});
export type TimeIdCursorPayload = z.infer<typeof TimeIdCursorSchema>;

const ActivityCursorSchema = z.object({
  t: IsoDateTimeSchema,
  r: z.union([z.literal(0), z.literal(1)]),
  id: z.uuid(),
});
export type ActivityCursorPayload = z.infer<typeof ActivityCursorSchema>;

export function encodeTimeIdCursor(payload: TimeIdCursorPayload): string {
  return encodeBase64Json(payload);
}

export function decodeTimeIdCursor(cursor: string): TimeIdCursorPayload {
  return decodeBase64Json(cursor, TimeIdCursorSchema);
}

export function encodeActivityCursor(payload: ActivityCursorPayload): string {
  return encodeBase64Json(payload);
}

export function decodeActivityCursor(cursor: string): ActivityCursorPayload {
  return decodeBase64Json(cursor, ActivityCursorSchema);
}
