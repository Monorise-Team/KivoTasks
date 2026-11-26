import type { IssueListItem, UpdateIssueInput, WorkflowState } from "@kivotasks/client";

export const BOARD_SORT_STEP = 1000;

export interface BoardColumn {
  readonly state: WorkflowState;
  readonly issues: readonly IssueListItem[];
}

export interface BoardMovePlan {
  readonly issueId: string;
  readonly fromStateId: string;
  readonly toStateId: string;
  readonly nextSortOrder: number;
  readonly patch: UpdateIssueInput;
}

function compareBoardIssues(a: IssueListItem, b: IssueListItem): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id.localeCompare(b.id);
}

/** Układa kolumny tablicy według `position` aktywnych statusów, a karty w kolumnach po `sortOrder ASC, id ASC`. */
export function buildBoardColumns(states: readonly WorkflowState[], issues: readonly IssueListItem[]): BoardColumn[] {
  const orderedStates = [...states].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  const byState = new Map<string, IssueListItem[]>();
  for (const state of orderedStates) {
    byState.set(state.id, []);
  }

  for (const issue of issues) {
    const bucket = byState.get(issue.stateId);
    if (bucket) {
      bucket.push(issue);
    }
  }

  return orderedStates.map((state) => {
    const columnIssues = byState.get(state.id) ?? [];
    columnIssues.sort(compareBoardIssues);
    return { state, issues: columnIssues };
  });
}

/**
 * Wylicza nowy `sortOrder` (punkt środkowy między sąsiadami) oraz ewentualną zmianę `stateId`
 * dla przeniesienia karty na docelowy indeks w docelowej kolumnie.
 * Zwraca `null`, gdy zadanie nie istnieje lub pozycja nie ulega zmianie.
 */
export function computeBoardMove(
  issues: readonly IssueListItem[],
  issueId: string,
  targetStateId: string,
  targetIndex: number,
): BoardMovePlan | null {
  const moving = issues.find((issue) => issue.id === issueId);
  if (!moving) return null;

  const currentColumn = issues.filter((issue) => issue.stateId === moving.stateId).sort(compareBoardIssues);
  const currentIndex = currentColumn.findIndex((issue) => issue.id === issueId);

  const siblings = issues
    .filter((issue) => issue.stateId === targetStateId && issue.id !== issueId)
    .sort(compareBoardIssues);

  const clampedIndex = Math.max(0, Math.min(targetIndex, siblings.length));

  if (moving.stateId === targetStateId && currentIndex === clampedIndex) {
    return null;
  }

  const prev = clampedIndex > 0 ? siblings[clampedIndex - 1] : undefined;
  const next = clampedIndex < siblings.length ? siblings[clampedIndex] : undefined;

  let nextSortOrder: number;
  if (!prev && !next) {
    nextSortOrder = Number.isFinite(moving.sortOrder) && moving.sortOrder > 0 ? moving.sortOrder : BOARD_SORT_STEP;
  } else if (!prev && next) {
    nextSortOrder = next.sortOrder - BOARD_SORT_STEP;
  } else if (prev && !next) {
    nextSortOrder = prev.sortOrder + BOARD_SORT_STEP;
  } else if (prev && next) {
    if (prev.sortOrder === next.sortOrder) {
      nextSortOrder = prev.sortOrder + 0.5;
    } else {
      const midpoint = (prev.sortOrder + next.sortOrder) / 2;
      nextSortOrder = midpoint === prev.sortOrder || midpoint === next.sortOrder ? prev.sortOrder + 0.5 : midpoint;
    }
  } else {
    nextSortOrder = BOARD_SORT_STEP;
  }

  const stateChanged = moving.stateId !== targetStateId;
  const patch: UpdateIssueInput = stateChanged
    ? { stateId: targetStateId, sortOrder: nextSortOrder }
    : { sortOrder: nextSortOrder };

  return {
    issueId,
    fromStateId: moving.stateId,
    toStateId: targetStateId,
    nextSortOrder,
    patch,
  };
}

/** Wylicza ruch o jedną pozycję w górę lub w dół w tej samej kolumnie (alternatywa klawiaturowa dla przeciągania). */
export function computeKeyboardBoardStep(
  issues: readonly IssueListItem[],
  issueId: string,
  direction: "up" | "down",
): BoardMovePlan | null {
  const moving = issues.find((issue) => issue.id === issueId);
  if (!moving) return null;

  const column = issues.filter((issue) => issue.stateId === moving.stateId).sort(compareBoardIssues);
  const currentIndex = column.findIndex((issue) => issue.id === issueId);
  if (currentIndex === -1) return null;

  const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= column.length) return null;

  return computeBoardMove(issues, issueId, moving.stateId, nextIndex);
}

/** Wylicza przeniesienie karty na koniec wskazanej kolumny (np. z menu „Przenieś do…”). */
export function computeBoardMoveToStateEnd(
  issues: readonly IssueListItem[],
  issueId: string,
  targetStateId: string,
): BoardMovePlan | null {
  const targetCount = issues.filter((issue) => issue.stateId === targetStateId && issue.id !== issueId).length;
  return computeBoardMove(issues, issueId, targetStateId, targetCount);
}

/**
 * Zamienia indeks szczeliny w widocznej kolumnie (`0..columnIssues.length`) na indeks w liście
 * sąsiadów bez przeciąganej karty, aby upuszczenie w tej samej kolumnie po pierwotnej pozycji nie przesuwało o 1.
 */
export function resolveDropSiblingIndex(
  columnIssues: readonly Pick<IssueListItem, "id">[],
  draggingId: string,
  rawSlotIndex: number,
): number {
  const draggedIndex = columnIssues.findIndex((item) => item.id === draggingId);
  if (draggedIndex !== -1 && rawSlotIndex > draggedIndex) {
    return rawSlotIndex - 1;
  }
  return rawSlotIndex;
}

/** Optymistycznie nakłada plan przeniesienia na lokalną listę zadań. */
export function applyBoardMove(
  issues: readonly IssueListItem[],
  plan: BoardMovePlan,
  states: readonly WorkflowState[],
): IssueListItem[] {
  const targetState = states.find((state) => state.id === plan.toStateId);
  return issues.map((issue) => {
    if (issue.id !== plan.issueId) return issue;
    return {
      ...issue,
      stateId: plan.toStateId,
      sortOrder: plan.nextSortOrder,
      state: targetState
        ? {
            id: targetState.id,
            name: targetState.name,
            category: targetState.category,
            color: targetState.color,
            position: targetState.position,
          }
        : issue.state,
    };
  });
}
