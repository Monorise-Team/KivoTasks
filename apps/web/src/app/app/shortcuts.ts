import type { ShortcutHelpCategory } from "@monorise-team/ui";

export type AppShortcutAction =
  | { readonly type: "new-issue" }
  | { readonly type: "focus-search" }
  | { readonly type: "go-my-issues" }
  | { readonly type: "go-teams" }
  | { readonly type: "go-board"; readonly teamKey: string }
  | { readonly type: "go-appearance" }
  | { readonly type: "list-next" }
  | { readonly type: "list-prev" }
  | { readonly type: "list-open" }
  | { readonly type: "open-help" };

export interface ShortcutResolutionContext {
  readonly canWriteIssues: boolean;
  readonly hasTeams: boolean;
  readonly currentTeamKey: string | null;
  readonly isEditingInput: boolean;
  readonly isModalOpen: boolean;
  readonly listLength?: number;
  readonly selectedListIndex?: number;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Sprawdza (bez zależności od DOM), czy focus jest w polu tekstowym lub edytowalnym. */
export function isEditableElementInfo(tagName: string | null | undefined, isContentEditable = false): boolean {
  if (isContentEditable) return true;
  if (!tagName) return false;
  return EDITABLE_TAGS.has(tagName.toUpperCase());
}

/**
 * Czysta mapa skrótów KivoTasks:
 * - ignoruje zdarzenia podczas pisania w polach tekstowych oraz przy otwartym oknie modalnym,
 * - respektuje uprawnienia (`canWriteIssues`) i bieżący zespół (`currentTeamKey`).
 */
export function resolveShortcutAction(
  normalizedShortcut: string,
  context: ShortcutResolutionContext,
): AppShortcutAction | null {
  if (context.isEditingInput || context.isModalOpen) {
    return null;
  }

  switch (normalizedShortcut.trim().toLowerCase()) {
    case "c":
      return context.canWriteIssues && context.hasTeams ? { type: "new-issue" } : null;
    case "/":
      return { type: "focus-search" };
    case "g i":
      return { type: "go-my-issues" };
    case "g t":
      return { type: "go-teams" };
    case "g b":
      return context.currentTeamKey ? { type: "go-board", teamKey: context.currentTeamKey } : null;
    case "g w":
      return { type: "go-appearance" };
    case "j":
      return (context.listLength ?? 0) > 0 ? { type: "list-next" } : null;
    case "k":
      return (context.listLength ?? 0) > 0 ? { type: "list-prev" } : null;
    case "enter": {
      const length = context.listLength ?? 0;
      const selected = context.selectedListIndex ?? -1;
      return length > 0 && selected >= 0 && selected < length ? { type: "list-open" } : null;
    }
    case "?":
    case "shift+?":
      return { type: "open-help" };
    default:
      return null;
  }
}

/** Wylicza kolejny indeks podświetlonego wiersza listy po naciśnięciu `j` lub `k`. */
export function resolveListCursorIndex(currentIndex: number, direction: "next" | "prev", length: number): number {
  if (length <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= length) {
    return direction === "next" ? 0 : length - 1;
  }
  if (direction === "next") {
    return Math.min(length - 1, currentIndex + 1);
  }
  return Math.max(0, currentIndex - 1);
}

/** Kategorie pomocy skrótów klawiszowych dla komponentu `ShortcutsHelp`. */
export function buildShortcutHelpCategories(options: {
  readonly canWriteIssues: boolean;
  readonly hasBoardTarget: boolean;
}): ShortcutHelpCategory[] {
  const generalItems = [
    { label: "Paleta poleceń i wyszukiwanie", shortcut: "mod+k" },
    { label: "Fokus na polu szukania lub filtrowania", shortcut: "/" },
    ...(options.canWriteIssues ? [{ label: "Nowe zadanie", shortcut: "c" }] : []),
    { label: "Skróty klawiszowe", shortcut: "shift+?" },
  ];

  const navigationItems = [
    { label: "Moje zadania", shortcut: "g i" },
    { label: "Zespoły", shortcut: "g t" },
    ...(options.hasBoardTarget ? [{ label: "Tablica bieżącego zespołu", shortcut: "g b" }] : []),
    { label: "Wygląd", shortcut: "g w" },
  ];

  const listItems = [
    { label: "Następne zadanie na liście", shortcut: "j" },
    { label: "Poprzednie zadanie na liście", shortcut: "k" },
    { label: "Otwórz zaznaczone zadanie", shortcut: "enter" },
  ];

  return [
    { category: "Ogólne", items: generalItems },
    { category: "Przejdź do", items: navigationItems },
    { category: "Lista zadań", items: listItems },
  ];
}
