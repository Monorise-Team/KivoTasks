import type { TeamMember } from "@kivotasks/client";
import { formatMemberName } from "./issue-ui";

export interface ActiveMentionQuery {
  /** Pozycja znaku `@` w tekście. */
  readonly start: number;
  /** Bieżąca pozycja kursora. */
  readonly end: number;
  /** Fraza po znaku `@`. */
  readonly query: string;
}

const MAX_MENTION_QUERY_LENGTH = 60;
const WORD_CHAR_REGEX = /[\p{L}\p{N}_]/u;

/**
 * Wykrywa aktywne wpisywanie wzmianki `@...` przed kursorem w polu tekstowym.
 * Ignoruje adresy e-mail (znak literowo-cyfrowy bezpośrednio przed `@`) oraz już wstawione tokeny `@[...](...)`.
 */
export function findActiveMentionQuery(text: string, cursorPos: number): ActiveMentionQuery | null {
  const clamped = Math.max(0, Math.min(cursorPos, text.length));
  const beforeCursor = text.slice(0, clamped);
  const lineStart = beforeCursor.lastIndexOf("\n") + 1;
  const lineSegment = beforeCursor.slice(lineStart);

  const atOffset = lineSegment.lastIndexOf("@");
  if (atOffset === -1) return null;

  const start = lineStart + atOffset;
  if (start > 0 && WORD_CHAR_REGEX.test(text[start - 1]!)) {
    return null;
  }

  const query = text.slice(start + 1, clamped);
  if (query.length > MAX_MENTION_QUERY_LENGTH) return null;
  if (/[[\]()\r\n]/.test(query)) return null;
  // Pozwalamy maksymalnie na jedną spację w zapytaniu (np. „Anna No”), więcej kończy podpowiedź
  if (/\s{2,}/.test(query) || query.startsWith(" ")) return null;

  return { start, end: clamped, query };
}

function normalizeForSearch(value: string): string {
  return value
    .replace(/[łŁ]/g, "l")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Filtruje członków zespołu według wpisanej frazy po `@` (bez rozróżniania wielkości liter i znaków diakrytycznych).
 */
export function filterMentionCandidates(members: readonly TeamMember[], query: string, limit = 8): TeamMember[] {
  const needle = normalizeForSearch(query.trim());
  if (!needle) {
    return members.slice(0, limit);
  }
  const matches: TeamMember[] = [];
  for (const member of members) {
    const fullName = normalizeForSearch(formatMemberName(member));
    const first = normalizeForSearch(member.firstName);
    const last = normalizeForSearch(member.lastName);
    if (fullName.includes(needle) || first.startsWith(needle) || last.startsWith(needle)) {
      matches.push(member);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

/**
 * Zastępuje wpisane `@zapytanie` tokenem `@[Imię Nazwisko](<accountId>) ` i zwraca nową pozycję kursora.
 */
export function insertMentionToken(
  text: string,
  range: Pick<ActiveMentionQuery, "start" | "end">,
  member: Pick<TeamMember, "accountId" | "firstName" | "lastName">,
): { readonly nextText: string; readonly nextCursorPos: number } {
  const displayName =
    formatMemberName(member)
      .replace(/[[\]()\r\n]/g, "")
      .trim() || "Osoba";
  const token = `@[${displayName}](${member.accountId}) `;
  const nextText = `${text.slice(0, range.start)}${token}${text.slice(range.end)}`;
  return {
    nextText,
    nextCursorPos: range.start + token.length,
  };
}
