import { ApiError, type Capabilities, type Team } from "@kivotasks/client";
import { TEAM_KEY_REGEX } from "@kivotasks/contracts";

export type AppView = "my-issues" | "teams" | "appearance";

export const VIEW_HASHES: Record<AppView, string> = {
  "my-issues": "#moje-zadania",
  teams: "#zespoly",
  appearance: "#wyglad",
};

export const APP_PATHS = {
  root: "/",
  inbox: "/inbox",
  myIssues: "/my-issues",
  teams: "/teams",
  appearance: "/appearance",
  teamIssues: (key: string) => `/teams/${encodeURIComponent(key.toUpperCase())}`,
  teamBoard: (key: string) => `/teams/${encodeURIComponent(key.toUpperCase())}/board`,
  teamSettings: (key: string) => `/teams/${encodeURIComponent(key.toUpperCase())}/settings`,
  issueDetail: (identifier: string) => `/issue/${encodeURIComponent(identifier.toUpperCase())}`,
} as const;

export type AppRouteMatch =
  | { kind: "inbox" }
  | { kind: "my-issues" }
  | { kind: "teams" }
  | { kind: "team-issues"; teamKey: string }
  | { kind: "team-board"; teamKey: string }
  | { kind: "team-settings"; teamKey: string }
  | { kind: "issue-detail"; identifier: string }
  | { kind: "appearance" }
  | { kind: "unknown" };

export const DEFAULT_NO_ACCESS_MESSAGE = "KivoTasks nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.";

export const DEFAULT_NO_ROLE_MESSAGE =
  "Twoje konto nie ma jeszcze przypisanej roli w KivoTasks. Poproś administratora firmy o nadanie dostępu.";

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  expired: "Sesja logowania wygasła. Spróbuj zalogować się ponownie.",
  denied: "Logowanie zostało przerwane.",
  unavailable: "Serwer logowania Monorise jest chwilowo niedostępny.",
  failed: "Nie udało się dokończyć logowania. Spróbuj ponownie.",
};

/**
 * Zwraca komunikat blokady, gdy konto nie ma dostępu do produktu ani żadnego uprawnienia w KivoTasks.
 * Zwraca `null`, gdy osoba może korzystać z aplikacji.
 */
export function resolveAccessDenialMessage(capabilities: Capabilities): string | null {
  if (!capabilities.hasProductAccess) {
    return DEFAULT_NO_ACCESS_MESSAGE;
  }
  const hasAnyPermission =
    capabilities.readIssues || capabilities.writeIssues || capabilities.manageTeams || capabilities.manageProjects;
  if (!hasAnyPermission) {
    return DEFAULT_NO_ROLE_MESSAGE;
  }
  return null;
}

/**
 * Zamienia fragment adresu (`#moje-zadania`, `#zespoly`, `#wyglad`) na aktywny widok aplikacji.
 * Nieznany albo pusty fragment wraca do widoku „Moje zadania”.
 */
export function parseViewFromHash(hash: string): AppView {
  const normalized = hash.trim().toLowerCase();
  if (normalized === VIEW_HASHES.appearance) return "appearance";
  if (normalized === VIEW_HASHES.teams) return "teams";
  return "my-issues";
}

/** Zwraca ścieżkę docelową dla starszego fragmentu URL z etapu 0 lub `null`, gdy fragment nie wymaga przekierowania. */
export function legacyHashToPath(hash: string): string | null {
  const normalized = hash.trim().toLowerCase();
  if (normalized === VIEW_HASHES.teams) return APP_PATHS.teams;
  if (normalized === VIEW_HASHES.appearance) return APP_PATHS.appearance;
  if (normalized === VIEW_HASHES["my-issues"]) return APP_PATHS.myIssues;
  return null;
}

/** Usuwa wewnętrzny prefiks `/app` (powstający przy bezpośrednim wejściu zamiast przepisania przez proxy). */
export function normalizeAppPathname(pathname: string): string {
  const clean = pathname.split("?")[0]?.split("#")[0] ?? "/";
  if (clean === "/app" || clean === "/app/") return "/";
  if (clean.startsWith("/app/")) return clean.slice(4);
  return clean || "/";
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Rozpoznaje bieżącą trasę aplikacji na podstawie ścieżki URL. */
export function parseAppRoute(pathname: string): AppRouteMatch {
  const normalized = normalizeAppPathname(pathname).replace(/\/+$/, "") || "/";
  if (normalized === "/" || normalized === "/my-issues") {
    return { kind: "my-issues" };
  }
  if (normalized === "/inbox") {
    return { kind: "inbox" };
  }
  if (normalized === "/teams") {
    return { kind: "teams" };
  }
  if (normalized === "/appearance") {
    return { kind: "appearance" };
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments[0] === "teams" && segments[1]) {
    const teamKey = safeDecodeSegment(segments[1]).toUpperCase();
    if (segments.length === 2) {
      return { kind: "team-issues", teamKey };
    }
    if (segments.length === 3 && segments[2] === "board") {
      return { kind: "team-board", teamKey };
    }
    if (segments.length === 3 && segments[2] === "settings") {
      return { kind: "team-settings", teamKey };
    }
  }

  if (segments[0] === "issue" && segments[1] && segments.length === 2) {
    return { kind: "issue-detail", identifier: safeDecodeSegment(segments[1]) };
  }

  return { kind: "unknown" };
}

/** Wyszukuje zespół po kluczu bez rozróżniania wielkości liter. */
export function findTeamByKey(teams: readonly Team[], rawKey: string): Team | null {
  const needle = rawKey.trim().toUpperCase();
  if (!needle) return null;
  return teams.find((team) => team.key.toUpperCase() === needle) ?? null;
}

/** Proponuje krótki klucz zespołu (2 do 5 wielkich liter ASCII) na podstawie nazwy jednostki w Core. */
export function suggestTeamKey(unitName: string): string {
  const ascii = unitName
    .replace(/[łŁ]/g, "L")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase();
  const words = ascii.match(/[A-Z]+/g) ?? [];
  if (words.length === 0) return "";
  if (words.length === 1) {
    const word = words[0]!;
    return word.length >= 2 ? word.slice(0, 3) : `${word}A`;
  }
  const initials = words
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 5);
  return initials.length >= 2 ? initials : words.join("").slice(0, 3);
}

/** Normalizuje wpisywany klucz zespołu: usuwa niedozwolone znaki i zamienia litery na wielkie (maks. 5). */
export function normalizeTeamKeyInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 5);
}

export function isValidTeamKey(key: string): boolean {
  return TEAM_KEY_REGEX.test(key);
}

// ── Sprawdzanie uprawnień w interfejsie ──────────────────────────────────────

export interface TeamCapabilityOverrides {
  /** Zespoły, dla których serwer zwrócił 403 przy próbie zapisu zadań (przy ograniczonej roli na jednostkę). */
  readonly deniedWriteTeamIds?: ReadonlySet<string>;
  /** Zespoły, dla których serwer zwrócił 403 przy próbie zarządzania zespołem. */
  readonly deniedManageTeamIds?: ReadonlySet<string>;
}

export function canReadIssues(capabilities: Capabilities): boolean {
  return capabilities.hasProductAccess && (capabilities.readIssues || capabilities.writeIssues);
}

export function canWriteIssues(
  capabilities: Capabilities,
  teamId?: string | null,
  overrides?: TeamCapabilityOverrides,
): boolean {
  if (!capabilities.hasProductAccess || !capabilities.writeIssues) return false;
  if (teamId && overrides?.deniedWriteTeamIds?.has(teamId)) return false;
  return true;
}

export function canManageTeam(
  capabilities: Capabilities,
  teamId?: string | null,
  overrides?: TeamCapabilityOverrides,
): boolean {
  if (!capabilities.hasProductAccess || !capabilities.manageTeams) return false;
  if (teamId && overrides?.deniedManageTeamIds?.has(teamId)) return false;
  return true;
}

export function canCreateTeams(capabilities: Capabilities): boolean {
  return capabilities.hasProductAccess && capabilities.createTeams;
}

/** Buduje bezpieczny parametr `returnTo` do logowania (tylko ścieżka względna tej samej aplikacji). */
export function sanitizeReturnTo(pathname: string, search = ""): string {
  const normalized = normalizeAppPathname(pathname);
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    return "/";
  }
  return search ? `${normalized}${search.startsWith("?") ? search : `?${search}`}` : normalized;
}

/**
 * Zamienia błąd klienta API na zrozumiały komunikat po polsku.
 * Komunikaty `409 CONFLICT` z serwera zawsze zwraca bez modyfikacji.
 */
export function formatApiError(error: unknown, fallback = "Nie udało się wykonać operacji."): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return error.message || "Operacja jest w konflikcie z bieżącym stanem danych.";
    }
    if (error.status === 422) {
      const detailMessages = error.details.map((detail) => detail.message).filter(Boolean);
      if (detailMessages.length > 0) {
        return detailMessages.join(". ");
      }
      return error.message || "Sprawdź poprawność wprowadzonych danych.";
    }
    if (error.status === 403) {
      if (error.code === "PRODUCT_ACCESS_REQUIRED") {
        return error.message || DEFAULT_NO_ACCESS_MESSAGE;
      }
      return error.message || "Nie masz uprawnień do wykonania tej operacji.";
    }
    if (error.status === 404) {
      return error.message || "Nie znaleziono zasobu lub nie masz do niego dostępu.";
    }
    if (error.message) {
      return error.message;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
