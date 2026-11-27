import type { IssueListItem, Team, WorkflowState } from "@kivotasks/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BOARD_SORT_STEP,
  applyBoardMove,
  buildBoardColumns,
  computeBoardMove,
  computeBoardMoveToStateEnd,
  computeKeyboardBoardStep,
  resolveDropSiblingIndex,
} from "@/app/app/board-logic";
import { LabelPill, PriorityIcon, TeamHeader } from "@/app/app/components/IssueBadges";
import {
  DEFAULT_ISSUE_LIST_FILTERS,
  computeStateReorderUpdates,
  flattenGroupedIssues,
  groupIssuesByCategory,
  groupIssuesByState,
  isIssueOverdue,
  orderPaletteSearchResults,
  parseIssueListFilters,
  serializeIssueListFilters,
  toApiIssueListQuery,
} from "@/app/app/issue-ui";
import {
  buildShortcutHelpCategories,
  isEditableElementInfo,
  resolveListCursorIndex,
  resolveShortcutAction,
} from "@/app/app/shortcuts";

const ORG_ID = "01950000-0000-7000-8000-000000000001";
const TEAM_ID = "01950000-0000-7000-8000-000000000010";

function makeState(
  id: string,
  name: string,
  category: WorkflowState["category"],
  position: number,
  color: WorkflowState["color"] = "gray",
): WorkflowState {
  return {
    id,
    organizationId: ORG_ID,
    teamId: TEAM_ID,
    name,
    category,
    color,
    position,
    createdAt: `2026-11-26T10:00:0${position}.000Z`,
    updatedAt: `2026-11-26T10:00:0${position}.000Z`,
  };
}

const STATE_BACKLOG = makeState("01950000-0000-7000-8000-000000000101", "Backlog", "BACKLOG", 0, "gray");
const STATE_TODO = makeState("01950000-0000-7000-8000-000000000102", "Do zrobienia", "UNSTARTED", 1, "blue");
const STATE_PROGRESS = makeState("01950000-0000-7000-8000-000000000103", "W toku", "STARTED", 2, "yellow");
const STATE_REVIEW = makeState("01950000-0000-7000-8000-000000000104", "Do przeglądu", "STARTED", 3, "purple");
const STATE_DONE = makeState("01950000-0000-7000-8000-000000000105", "Zrobione", "COMPLETED", 4, "green");
const STATE_CANCELED = makeState("01950000-0000-7000-8000-000000000106", "Anulowane", "CANCELED", 5, "red");

const ALL_STATES: WorkflowState[] = [
  STATE_BACKLOG,
  STATE_TODO,
  STATE_PROGRESS,
  STATE_REVIEW,
  STATE_DONE,
  STATE_CANCELED,
];

function makeIssue(overrides: {
  id: string;
  number: number;
  title: string;
  state: WorkflowState;
  sortOrder?: number;
  priority?: number;
  dueDate?: string | null;
  identifier?: string;
}): IssueListItem {
  return {
    id: overrides.id,
    organizationId: ORG_ID,
    teamId: overrides.state.teamId,
    identifier: overrides.identifier ?? `MAG-${overrides.number}`,
    number: overrides.number,
    title: overrides.title,
    stateId: overrides.state.id,
    state: {
      id: overrides.state.id,
      name: overrides.state.name,
      category: overrides.state.category,
      color: overrides.state.color,
      position: overrides.state.position,
    },
    priority: overrides.priority ?? 0,
    assigneeAccountId: null,
    creatorAccountId: "01950000-0000-7000-8000-000000000900",
    dueDate: overrides.dueDate ?? null,
    estimate: null,
    parentId: null,
    sortOrder: overrides.sortOrder ?? overrides.number * 1000,
    labels: [],
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: "2026-11-26T10:00:00.000Z",
    updatedAt: "2026-11-26T10:00:00.000Z",
  };
}

describe("grupowanie listy zadań i filtry w zapytaniu URL", () => {
  it("grupuje zadania zespołu w kolejności kategorii statusów (Backlog, Do zrobienia, W toku, …) i zachowuje kolejność w grupach", () => {
    const issues = [
      makeIssue({ id: "i-done", number: 5, title: "Zamknięte", state: STATE_DONE }),
      makeIssue({ id: "i-rev", number: 4, title: "Przegląd", state: STATE_REVIEW }),
      makeIssue({ id: "i-prog-1", number: 3, title: "Pierwsze w toku", state: STATE_PROGRESS }),
      makeIssue({ id: "i-backlog", number: 1, title: "Pomysł", state: STATE_BACKLOG }),
      makeIssue({ id: "i-prog-2", number: 6, title: "Drugie w toku", state: STATE_PROGRESS }),
      makeIssue({ id: "i-todo", number: 2, title: "Do zrobienia", state: STATE_TODO }),
      makeIssue({ id: "i-cancel", number: 7, title: "Anulowane", state: STATE_CANCELED }),
    ];

    const groups = groupIssuesByState(issues, ALL_STATES);
    expect(groups.map((group) => group.label)).toEqual([
      "Backlog",
      "Do zrobienia",
      "W toku",
      "Do przeglądu",
      "Zrobione",
      "Anulowane",
    ]);

    const inProgress = groups.find((group) => group.stateId === STATE_PROGRESS.id);
    expect(inProgress?.issues.map((item) => item.id)).toEqual(["i-prog-1", "i-prog-2"]);

    expect(flattenGroupedIssues(groups).map((item) => item.id)).toEqual([
      "i-backlog",
      "i-todo",
      "i-prog-1",
      "i-prog-2",
      "i-rev",
      "i-done",
      "i-cancel",
    ]);
  });

  it("grupuje zadania przekrojowe (Moje zadania) według kategorii statusu", () => {
    const issues = [
      makeIssue({ id: "a", number: 1, title: "W przeglądzie", state: STATE_REVIEW }),
      makeIssue({ id: "b", number: 2, title: "W toku", state: STATE_PROGRESS }),
      makeIssue({ id: "c", number: 3, title: "W backlogu", state: STATE_BACKLOG }),
    ];
    const groups = groupIssuesByCategory(issues);
    expect(groups.map((group) => group.category)).toEqual(["BACKLOG", "STARTED"]);
    expect(groups[1]?.issues.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("parsuje i serializuje filtry listy do URL oraz odrzuca niepoprawne parametry", () => {
    const stateUuid = STATE_PROGRESS.id;
    const labelUuid = "01950000-0000-7000-8000-000000000501";
    const serialized = serializeIssueListFilters({
      ...DEFAULT_ISSUE_LIST_FILTERS,
      stateId: stateUuid,
      assignee: "me",
      labelId: labelUuid,
      priority: "1",
      q: "faktura",
      includeCompleted: true,
      sort: "priority",
    });

    const parsed = parseIssueListFilters(new URLSearchParams(serialized));
    expect(parsed.stateId).toBe(stateUuid);
    expect(parsed.assignee).toBe("me");
    expect(parsed.labelId).toBe(labelUuid);
    expect(parsed.priority).toBe("1");
    expect(parsed.q).toBe("faktura");
    expect(parsed.includeCompleted).toBe(true);
    expect(parsed.sort).toBe("priority");

    const apiQuery = toApiIssueListQuery(parsed, { teamId: TEAM_ID });
    expect(apiQuery).toEqual({
      teamId: TEAM_ID,
      stateId: stateUuid,
      assignee: "me",
      labelId: labelUuid,
      priority: 1,
      q: "faktura",
      includeCompleted: true,
      sort: "priority",
      limit: 50,
    });

    const dirty = parseIssueListFilters(
      new URLSearchParams("stateId=nie-uuid&priority=99&sort=invalid&assignee=unknown"),
    );
    expect(dirty).toEqual(DEFAULT_ISSUE_LIST_FILTERS);
  });

  it("wykrywa przeterminowane zadania tylko dla niezakończonych statusów", () => {
    const activeLate = makeIssue({
      id: "1",
      number: 1,
      title: "Spóźnione",
      state: STATE_PROGRESS,
      dueDate: "2026-11-20",
    });
    const doneLate = makeIssue({ id: "2", number: 2, title: "Gotowe", state: STATE_DONE, dueDate: "2026-11-20" });
    const future = makeIssue({ id: "3", number: 3, title: "Przyszłe", state: STATE_TODO, dueDate: "2026-12-01" });

    expect(isIssueOverdue(activeLate, "2026-11-26")).toBe(true);
    expect(isIssueOverdue(doneLate, "2026-11-26")).toBe(false);
    expect(isIssueOverdue(future, "2026-11-26")).toBe(false);
  });

  it("wylicza aktualizacje pozycji podczas zmiany kolejności statusów obiegu", () => {
    expect(computeStateReorderUpdates([STATE_BACKLOG, STATE_TODO, STATE_PROGRESS], STATE_TODO.id, "up")).toEqual([
      { stateId: STATE_TODO.id, position: 0 },
      { stateId: STATE_BACKLOG.id, position: 1 },
    ]);
    expect(computeStateReorderUpdates([STATE_BACKLOG, STATE_TODO], STATE_BACKLOG.id, "up")).toEqual([]);
    expect(computeStateReorderUpdates([STATE_BACKLOG, STATE_TODO], STATE_TODO.id, "down")).toEqual([]);
  });
});

describe("logika przenoszenia kart na tablicy (sortOrder i zmiana statusu)", () => {
  it("buduje kolumny według position i sortuje karty po sortOrder ASC", () => {
    const a = makeIssue({ id: "a", number: 1, title: "A", state: STATE_TODO, sortOrder: 2000 });
    const b = makeIssue({ id: "b", number: 2, title: "B", state: STATE_TODO, sortOrder: 1000 });
    const columns = buildBoardColumns([STATE_PROGRESS, STATE_TODO], [a, b]);

    expect(columns.map((col) => col.state.id)).toEqual([STATE_TODO.id, STATE_PROGRESS.id]);
    expect(columns[0]?.issues.map((item) => item.id)).toEqual(["b", "a"]);
    expect(columns[1]?.issues).toEqual([]);
  });

  it("wylicza punkt środkowy między sąsiadami przy zmianie kolejności w tej samej kolumnie", () => {
    const first = makeIssue({ id: "i1", number: 1, title: "1", state: STATE_TODO, sortOrder: 1000 });
    const second = makeIssue({ id: "i2", number: 2, title: "2", state: STATE_TODO, sortOrder: 2000 });
    const third = makeIssue({ id: "i3", number: 3, title: "3", state: STATE_TODO, sortOrder: 3000 });
    const issues = [first, second, third];

    const moveBetween = computeBoardMove(issues, "i3", STATE_TODO.id, 1);
    expect(moveBetween).not.toBeNull();
    expect(moveBetween?.nextSortOrder).toBe(1500);
    expect(moveBetween?.patch).toEqual({ sortOrder: 1500 });

    const moveToTop = computeBoardMove(issues, "i3", STATE_TODO.id, 0);
    expect(moveToTop?.nextSortOrder).toBe(1000 - BOARD_SORT_STEP);
    expect(moveToTop?.patch).toEqual({ sortOrder: 0 });

    const moveToBottom = computeBoardMove(issues, "i1", STATE_TODO.id, 2);
    expect(moveToBottom?.nextSortOrder).toBe(3000 + BOARD_SORT_STEP);

    // Upuszczenie w tym samym miejscu nie wysyła żądania
    expect(computeBoardMove(issues, "i2", STATE_TODO.id, 1)).toBeNull();
  });

  it("zmienia stateId oraz wylicza sortOrder przy przeniesieniu do innej kolumny (pustej i niepustej)", () => {
    const todoCard = makeIssue({ id: "i1", number: 1, title: "1", state: STATE_TODO, sortOrder: 1000 });
    const prog1 = makeIssue({ id: "i2", number: 2, title: "2", state: STATE_PROGRESS, sortOrder: 2000 });
    const prog2 = makeIssue({ id: "i3", number: 3, title: "3", state: STATE_PROGRESS, sortOrder: 4000 });
    const issues = [todoCard, prog1, prog2];

    const betweenCols = computeBoardMove(issues, "i1", STATE_PROGRESS.id, 1);
    expect(betweenCols?.patch).toEqual({ stateId: STATE_PROGRESS.id, sortOrder: 3000 });

    const toEmpty = computeBoardMove(issues, "i1", STATE_DONE.id, 0);
    expect(toEmpty?.patch).toEqual({ stateId: STATE_DONE.id, sortOrder: 1000 });

    const toEnd = computeBoardMoveToStateEnd(issues, "i1", STATE_PROGRESS.id);
    expect(toEnd?.patch).toEqual({ stateId: STATE_PROGRESS.id, sortOrder: 5000 });

    const optimistic = applyBoardMove(issues, betweenCols!, ALL_STATES);
    expect(optimistic.find((item) => item.id === "i1")?.stateId).toBe(STATE_PROGRESS.id);
    expect(optimistic.find((item) => item.id === "i1")?.state.name).toBe("W toku");
    expect(optimistic.find((item) => item.id === "i1")?.sortOrder).toBe(3000);
    // Oryginalna tablica pozostaje nietknięta (łatwe wycofanie przy błędzie)
    expect(issues.find((item) => item.id === "i1")?.stateId).toBe(STATE_TODO.id);
  });

  it("obsługuje klawiaturowe przesuwanie w kolumnie i korektę indeksu przy przeciąganiu w dół", () => {
    const a = makeIssue({ id: "a", number: 1, title: "A", state: STATE_TODO, sortOrder: 1000 });
    const b = makeIssue({ id: "b", number: 2, title: "B", state: STATE_TODO, sortOrder: 2000 });
    const c = makeIssue({ id: "c", number: 3, title: "C", state: STATE_TODO, sortOrder: 3000 });
    const issues = [a, b, c];

    expect(resolveDropSiblingIndex(issues, "a", 2)).toBe(1);
    expect(resolveDropSiblingIndex(issues, "c", 0)).toBe(0);

    const stepUp = computeKeyboardBoardStep(issues, "c", "up");
    expect(stepUp?.nextSortOrder).toBe(1500);
    const stepDown = computeKeyboardBoardStep(issues, "a", "down");
    expect(stepDown?.nextSortOrder).toBe(2500);
    expect(computeKeyboardBoardStep(issues, "a", "up")).toBeNull();
    expect(computeKeyboardBoardStep(issues, "c", "down")).toBeNull();
  });
});

describe("obsługa skrótów klawiszowych (czysta mapa skrótów)", () => {
  const baseContext = {
    canWriteIssues: true,
    hasTeams: true,
    currentTeamKey: "MAG",
    isEditingInput: false,
    isModalOpen: false,
    listLength: 3,
    selectedListIndex: 1,
  };

  it("rozpoznaje wszystkie skróty nawigacji, tworzenia, wyszukiwania i listy", () => {
    expect(resolveShortcutAction("c", baseContext)).toEqual({ type: "new-issue" });
    expect(resolveShortcutAction("/", baseContext)).toEqual({ type: "focus-search" });
    expect(resolveShortcutAction("g n", baseContext)).toEqual({ type: "go-inbox" });
    expect(resolveShortcutAction("g i", baseContext)).toEqual({ type: "go-my-issues" });
    expect(resolveShortcutAction("g t", baseContext)).toEqual({ type: "go-teams" });
    expect(resolveShortcutAction("g b", baseContext)).toEqual({ type: "go-board", teamKey: "MAG" });
    expect(resolveShortcutAction("g w", baseContext)).toEqual({ type: "go-appearance" });
    expect(resolveShortcutAction("j", baseContext)).toEqual({ type: "list-next" });
    expect(resolveShortcutAction("k", baseContext)).toEqual({ type: "list-prev" });
    expect(resolveShortcutAction("enter", baseContext)).toEqual({ type: "list-open" });
    expect(resolveShortcutAction("?", baseContext)).toEqual({ type: "open-help" });
  });

  it("ignoruje skróty w polach tekstowych, przy otwartym oknie modalnym oraz bez uprawnień", () => {
    expect(isEditableElementInfo("INPUT")).toBe(true);
    expect(isEditableElementInfo("TEXTAREA")).toBe(true);
    expect(isEditableElementInfo("SELECT")).toBe(true);
    expect(isEditableElementInfo("DIV", true)).toBe(true);
    expect(isEditableElementInfo("DIV", false)).toBe(false);

    expect(resolveShortcutAction("c", { ...baseContext, isEditingInput: true })).toBeNull();
    expect(resolveShortcutAction("g i", { ...baseContext, isModalOpen: true })).toBeNull();
    expect(resolveShortcutAction("c", { ...baseContext, canWriteIssues: false })).toBeNull();
    expect(resolveShortcutAction("g b", { ...baseContext, currentTeamKey: null })).toBeNull();
    expect(resolveShortcutAction("enter", { ...baseContext, selectedListIndex: -1 })).toBeNull();
  });

  it("wylicza przesuwanie zaznaczenia j/k oraz ukrywa niedostępne skróty w pomocy", () => {
    expect(resolveListCursorIndex(-1, "next", 3)).toBe(0);
    expect(resolveListCursorIndex(0, "next", 3)).toBe(1);
    expect(resolveListCursorIndex(2, "next", 3)).toBe(2);
    expect(resolveListCursorIndex(1, "prev", 3)).toBe(0);
    expect(resolveListCursorIndex(0, "prev", 3)).toBe(0);
    expect(resolveListCursorIndex(-1, "prev", 3)).toBe(2);
    expect(resolveListCursorIndex(0, "next", 0)).toBe(-1);

    const readOnlyHelp = buildShortcutHelpCategories({ canWriteIssues: false, hasBoardTarget: false });
    const allShortcuts = readOnlyHelp.flatMap((cat) => cat.items.map((item) => item.shortcut));
    expect(allShortcuts).not.toContain("c");
    expect(allShortcuts).not.toContain("g b");
    expect(allShortcuts).toContain("g n");
    expect(allShortcuts).toContain("g i");
    expect(allShortcuts).toContain("g t");
  });
});

describe("porządkowanie wyników palety ⌘K", () => {
  it("ustawia dokładne dopasowanie identyfikatora na pierwszym miejscu, przed prefiksami i wynikami pełnotekstowymi", () => {
    const ftsHit = makeIssue({ id: "fts", number: 99, title: "Powiązane z MAG-1", state: STATE_TODO });
    const prefixHit = makeIssue({ id: "pref", number: 12, title: "Inne zadanie", state: STATE_TODO });
    const exactHit = makeIssue({ id: "exact", number: 1, title: "Główne zadanie", state: STATE_PROGRESS });

    const ordered = orderPaletteSearchResults([ftsHit, prefixHit, exactHit, exactHit], "mag-1");
    expect(ordered.map((item) => item.identifier)).toEqual(["MAG-1", "MAG-12", "MAG-99"]);
  });
});

describe("renderowanie elementów UI i ukrywanie akcji według uprawnień", () => {
  const sampleTeam: Team = {
    id: TEAM_ID,
    organizationId: ORG_ID,
    key: "MAG",
    name: "Magazyn",
    nextIssueNumber: 5,
    createdAt: "2026-11-26T10:00:00.000Z",
    updatedAt: "2026-11-26T10:00:00.000Z",
    archivedAt: null,
  };

  it("ukrywa przycisk Nowe zadanie i link Ustawienia bez odpowiednich uprawnień", () => {
    const readOnlyHtml = renderToStaticMarkup(
      createElement(TeamHeader, {
        team: sampleTeam,
        activeTab: "list",
        canWrite: false,
        canManage: false,
        onNewIssue: () => {},
      }),
    );
    expect(readOnlyHtml).toContain("Magazyn");
    expect(readOnlyHtml).toContain("Lista");
    expect(readOnlyHtml).toContain("Tablica");
    expect(readOnlyHtml).not.toContain("Nowe zadanie");
    expect(readOnlyHtml).not.toContain("Ustawienia");

    const adminHtml = renderToStaticMarkup(
      createElement(TeamHeader, {
        team: sampleTeam,
        activeTab: "board",
        canWrite: true,
        canManage: true,
        onNewIssue: () => {},
      }),
    );
    expect(adminHtml).toContain("Nowe zadanie");
    expect(adminHtml).toContain("Ustawienia");
  });

  it("renderuje etykiety i ikony priorytetów z dostępnymi opisami po polsku", () => {
    const labelHtml = renderToStaticMarkup(createElement(LabelPill, { label: { name: "Pilne", color: "red" } }));
    expect(labelHtml).toContain("Pilne");
    expect(labelHtml).toContain("text-danger");

    const prioHtml = renderToStaticMarkup(createElement(PriorityIcon, { priority: 1, showLabel: true }));
    expect(prioHtml).toContain("Pilny");
  });
});
