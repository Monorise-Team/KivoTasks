import {
  ISSUE_SORT_OPTIONS,
  type IssueReference,
  type IssueRelationType,
  type IssueRelationView,
  type IssueRelationViewType,
  type IssueSort,
  type WorkflowStateCategory,
} from "@kivotasks/contracts";
import { z } from "zod";
import { ApiFailure } from "./api";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_PARSE_REGEX = /^([A-Za-z]{2,5})-([1-9]\d*)$/;
const MAX_PG_INT4 = 2_147_483_647;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const MAX_PARENT_DEPTH = 500;

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/** Parsuje identyfikator zadania np. `MAG-12` lub `mag-12` na `{ key: "MAG", number: 12 }`. */
export function parseIssueIdentifier(raw: string): { key: string; number: number } | null {
  const match = IDENTIFIER_PARSE_REGEX.exec(raw.trim());
  if (!match) return null;
  const key = match[1]!.toUpperCase();
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PG_INT4) return null;
  return { key, number };
}

export function formatIssueIdentifier(teamKey: string, number: number): string {
  return `${teamKey}-${number}`;
}

export interface IssueLifecycleTimestamps {
  startedAt: Date | null;
  completedAt: Date | null;
  canceledAt: Date | null;
}

/**
 * Wylicza automatyczne znaczniki czasu `startedAt`, `completedAt` i `canceledAt` na podstawie
 * kategorii statusu obiegu. Przy powrocie do `BACKLOG`/`UNSTARTED` wszystkie trzy pola są zerowane.
 */
export function computeStateTimestamps(
  category: WorkflowStateCategory,
  current: IssueLifecycleTimestamps,
  now = new Date(),
): IssueLifecycleTimestamps {
  switch (category) {
    case "BACKLOG":
    case "UNSTARTED":
      return { startedAt: null, completedAt: null, canceledAt: null };
    case "STARTED":
      return { startedAt: current.startedAt ?? now, completedAt: null, canceledAt: null };
    case "COMPLETED":
      return { startedAt: current.startedAt, completedAt: current.completedAt ?? now, canceledAt: null };
    case "CANCELED":
      return { startedAt: current.startedAt, completedAt: null, canceledAt: current.canceledAt ?? now };
  }
}

/**
 * Kolejność sortowania priorytetu w Linear: Pilny (1) -> Wysoki (2) -> Średni (3) -> Niski (4) -> Brak (0).
 */
export function prioritySortRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

export function formatDateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Buduje bezpieczne zapytanie prefiksowe dla PostgreSQL `to_tsquery('simple', ...)`.
 * Wyciąga wyłącznie tokeny literowo-cyfrowe (Unicode), dzięki czemu żadne znaki specjalne nie powodują błędu składni.
 */
export function buildPrefixTsQuery(raw: string): string | null {
  const matches = raw
    .trim()
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!matches || matches.length === 0) return null;
  const uniqueTokens = [...new Set(matches)].slice(0, 20);
  return uniqueTokens.map((token) => `${token}:*`).join(" & ");
}

/**
 * Wykrywa, czy ustawienie `candidateParentId` jako rodzica `issueId` utworzyłoby cykl w hierarchii zadań.
 */
export async function wouldCreateParentCycle(
  issueId: string,
  candidateParentId: string,
  getParentId: (id: string) => Promise<string | null>,
): Promise<boolean> {
  if (candidateParentId === issueId) return true;
  const visited = new Set<string>([issueId]);
  let current: string | null = candidateParentId;
  let steps = 0;

  while (current !== null && steps < MAX_PARENT_DEPTH) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = await getParentId(current);
    steps += 1;
  }

  return steps >= MAX_PARENT_DEPTH;
}

/**
 * Normalizuje kierunek relacji przy zapisie: `BLOCKED_BY` na zadaniu A względem B
 * zapisujemy jako pojedynczy wiersz `(issueId: B, relatedIssueId: A, type: BLOCKS)`.
 */
export function normalizeRelationForStorage(
  issueId: string,
  relatedIssueId: string,
  type: IssueRelationViewType,
): { storedIssueId: string; storedRelatedIssueId: string; storedType: IssueRelationType } {
  if (type === "BLOCKED_BY") {
    return { storedIssueId: relatedIssueId, storedRelatedIssueId: issueId, storedType: "BLOCKS" };
  }
  return { storedIssueId: issueId, storedRelatedIssueId: relatedIssueId, storedType: type };
}

/**
 * Zamienia wiersz z `issue_relations` na widok relacji z perspektywy `viewerIssueId`
 * (odwrotny widok `BLOCKS` to `BLOCKED_BY`).
 */
export function toIssueRelationView(
  viewerIssueId: string,
  row: { id: string; issueId: string; relatedIssueId: string; type: IssueRelationType; createdAt: Date },
  relatedIssue: IssueReference,
): IssueRelationView {
  const isOutgoing = row.issueId === viewerIssueId;
  return {
    id: row.id,
    type: !isOutgoing && row.type === "BLOCKS" ? "BLOCKED_BY" : row.type,
    direction: isOutgoing ? "OUTGOING" : "INCOMING",
    relatedIssue,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── Stronicowanie kursorowe dla wszystkich trybów sortowania ────────────────

const IsoDateTimeSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Nieprawidłowy znacznik czasu");
const DateYmdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const IssueCursorSchema = z.discriminatedUnion("s", [
  z.object({ s: z.literal("updated"), u: IsoDateTimeSchema, id: z.uuid() }),
  z.object({ s: z.literal("created"), c: IsoDateTimeSchema, id: z.uuid() }),
  z.object({ s: z.literal("priority"), p: z.number().int().min(1).max(5), u: IsoDateTimeSchema, id: z.uuid() }),
  z.object({ s: z.literal("dueDate"), d: DateYmdSchema.nullable(), u: IsoDateTimeSchema, id: z.uuid() }),
  z.object({ s: z.literal("manual"), o: z.number().finite(), id: z.uuid() }),
]);

export type IssueCursorPayload = z.infer<typeof IssueCursorSchema>;

export function buildIssueCursorPayload(
  sort: IssueSort,
  item: {
    id: string;
    priority: number;
    dueDate: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  },
): IssueCursorPayload {
  switch (sort) {
    case "updated":
      return { s: "updated", u: item.updatedAt, id: item.id };
    case "created":
      return { s: "created", c: item.createdAt, id: item.id };
    case "priority":
      return { s: "priority", p: prioritySortRank(item.priority), u: item.updatedAt, id: item.id };
    case "dueDate":
      return { s: "dueDate", d: item.dueDate, u: item.updatedAt, id: item.id };
    case "manual":
      return { s: "manual", o: item.sortOrder, id: item.id };
  }
}

export function encodeIssueCursor(payload: IssueCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function invalidCursorError(): ApiFailure {
  return new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
    { field: "cursor", message: "Nieprawidłowy kursor stronicowania" },
  ]);
}

export function decodeIssueCursor(cursor: string, expectedSort: IssueSort): IssueCursorPayload {
  if (!BASE64URL_REGEX.test(cursor) || !ISSUE_SORT_OPTIONS.includes(expectedSort)) {
    throw invalidCursorError();
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursorError();
  }
  const parsed = IssueCursorSchema.safeParse(rawJson);
  if (!parsed.success || parsed.data.s !== expectedSort) {
    throw invalidCursorError();
  }
  if (encodeIssueCursor(parsed.data) !== cursor) {
    throw invalidCursorError();
  }
  return parsed.data;
}
