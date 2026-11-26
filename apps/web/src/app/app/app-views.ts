import type { Capabilities } from "@kivotasks/client";

export type AppView = "my-issues" | "teams" | "appearance";

export const VIEW_HASHES: Record<AppView, string> = {
  "my-issues": "#moje-zadania",
  teams: "#zespoly",
  appearance: "#wyglad",
};

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
