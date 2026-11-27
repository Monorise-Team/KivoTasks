import type { CommentReactionEmoji, InboxItemKind, IssueEvent } from "@kivotasks/client";
import { ISSUE_RELATION_LABELS, formatDueDate, formatPriorityLabel } from "./issue-ui";

export const COMMENT_DELETED_LABEL = "Komentarz usunięty";

export const REACTION_EMOJI_LABELS: Record<CommentReactionEmoji, string> = {
  "👍": "Kciuk w górę",
  "❤️": "Serce",
  "🎉": "Świętowanie",
  "😄": "Uśmiech",
  "👀": "Oczy",
  "🚀": "Rakieta",
};

function readString(obj: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(obj: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = obj?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(obj: Record<string, unknown> | null | undefined, key: string): boolean | null {
  const value = obj?.[key];
  return typeof value === "boolean" ? value : null;
}

function readLabels(obj: Record<string, unknown> | null | undefined): { id: string; name: string }[] {
  const raw = obj?.labels;
  if (!Array.isArray(raw)) return [];
  const result: { id: string; name: string }[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { name?: unknown }).name === "string"
    ) {
      result.push({ id: (item as { id: string }).id, name: (item as { name: string }).name });
    }
  }
  return result;
}

function resolvePersonName(
  accountId: string | null,
  explicitName: string | null | undefined,
  memberNames: ReadonlyMap<string, string>,
): string {
  if (explicitName && explicitName.trim()) return explicitName.trim();
  if (accountId) {
    const found = memberNames.get(accountId) ?? memberNames.get(accountId.toLowerCase());
    if (found) return found;
  }
  return "Członek zespołu";
}

/**
 * Formatuje wpis historii zadania w krótkiej, neutralnej płciowo polszczyźnie w czasie teraźniejszym
 * (np. „Anna Nowak zmienia status na W toku”).
 */
export function formatIssueEventText(event: IssueEvent, memberNames: ReadonlyMap<string, string>): string {
  const actor = resolvePersonName(event.actorAccountId, event.actorName, memberNames);
  const before = event.before;
  const after = event.after;

  switch (event.type) {
    case "CREATED":
      return `${actor} tworzy zadanie`;
    case "TITLE_CHANGED": {
      const nextTitle = readString(after, "title");
      return nextTitle ? `${actor} zmienia tytuł na „${nextTitle}”` : `${actor} zmienia tytuł zadania`;
    }
    case "DESCRIPTION_CHANGED": {
      const had = readBoolean(before, "hasDescription");
      const has = readBoolean(after, "hasDescription");
      if (had === false && has === true) return `${actor} dodaje opis`;
      if (had === true && has === false) return `${actor} usuwa opis`;
      return `${actor} zmienia opis`;
    }
    case "STATE_CHANGED": {
      const stateName = readString(after, "stateName");
      return stateName ? `${actor} zmienia status na ${stateName}` : `${actor} zmienia status zadania`;
    }
    case "PRIORITY_CHANGED": {
      const priority = readNumber(after, "priority");
      return priority !== null
        ? `${actor} zmienia priorytet na ${formatPriorityLabel(priority)}`
        : `${actor} zmienia priorytet zadania`;
    }
    case "ASSIGNEE_CHANGED": {
      const nextAssignee = readString(after, "assigneeAccountId");
      if (!nextAssignee) {
        return `${actor} usuwa przypisanie zadania`;
      }
      const assigneeName = resolvePersonName(nextAssignee, null, memberNames);
      return `${actor} przypisuje zadanie do ${assigneeName}`;
    }
    case "LABELS_CHANGED": {
      const prevLabels = readLabels(before);
      const nextLabels = readLabels(after);
      const prevIds = new Set(prevLabels.map((l) => l.id));
      const nextIds = new Set(nextLabels.map((l) => l.id));
      const added = nextLabels.filter((l) => !prevIds.has(l.id));
      const removed = prevLabels.filter((l) => !nextIds.has(l.id));
      if (added.length > 0 && removed.length === 0) {
        const names = added.map((l) => l.name).join(", ");
        return `${actor} dodaje ${added.length === 1 ? "etykietę" : "etykiety"}: ${names}`;
      }
      if (removed.length > 0 && added.length === 0) {
        const names = removed.map((l) => l.name).join(", ");
        return `${actor} usuwa ${removed.length === 1 ? "etykietę" : "etykiety"}: ${names}`;
      }
      return `${actor} zmienia etykiety zadania`;
    }
    case "DUE_DATE_CHANGED": {
      const nextDue = readString(after, "dueDate");
      return nextDue ? `${actor} ustawia termin na ${formatDueDate(nextDue)}` : `${actor} usuwa termin`;
    }
    case "ESTIMATE_CHANGED": {
      const nextEstimate = readNumber(after, "estimate");
      return nextEstimate !== null ? `${actor} ustawia szacunek na ${nextEstimate}` : `${actor} usuwa szacunek`;
    }
    case "PARENT_CHANGED": {
      const nextParent = readString(after, "parentIdentifier");
      return nextParent ? `${actor} ustawia zadanie nadrzędne ${nextParent}` : `${actor} odpina zadanie nadrzędne`;
    }
    case "RELATION_ADDED": {
      const relType = readString(after, "type") as keyof typeof ISSUE_RELATION_LABELS | null;
      const relatedId = readString(after, "relatedIssueIdentifier");
      const label = relType && ISSUE_RELATION_LABELS[relType] ? ISSUE_RELATION_LABELS[relType].toLowerCase() : null;
      if (label && relatedId) {
        return `${actor} dodaje powiązanie ${label} ${relatedId}`;
      }
      return relatedId ? `${actor} dodaje powiązanie z ${relatedId}` : `${actor} dodaje powiązanie`;
    }
    case "RELATION_REMOVED": {
      const relatedId = readString(before, "relatedIssueIdentifier");
      return relatedId ? `${actor} usuwa powiązanie z ${relatedId}` : `${actor} usuwa powiązanie`;
    }
    case "DELETED":
      return `${actor} usuwa zadanie`;
  }
}

/**
 * Formatuje opis zdarzenia w skrzynce powiadomień (neutralnie płciowo po polsku).
 */
export function formatInboxKindText(kind: InboxItemKind, actorName: string | null): string {
  const actor = actorName && actorName.trim() ? actorName.trim() : "Członek zespołu";
  switch (kind) {
    case "ASSIGNED":
      return `${actor} przypisuje Ci zadanie`;
    case "MENTIONED":
      return `${actor} wspomina o Tobie w komentarzu`;
    case "COMMENTED":
      return `${actor} dodaje komentarz w obserwowanym zadaniu`;
  }
}
