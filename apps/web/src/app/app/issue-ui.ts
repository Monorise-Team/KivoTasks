import {
  COLOR_TOKENS,
  ISSUE_PRIORITIES,
  ISSUE_PRIORITY_LABELS,
  ISSUE_SORT_OPTIONS,
  WORKFLOW_STATE_CATEGORIES,
  type ColorToken,
  type CoreUnitType,
  type IssueListItem,
  type IssueListQuery,
  type IssuePriorityValue,
  type IssueRelationViewType,
  type IssueSort,
  type TeamMember,
  type WorkflowState,
  type WorkflowStateCategory,
} from "@kivotasks/client";

export const WORKFLOW_CATEGORY_ORDER: Record<WorkflowStateCategory, number> = {
  BACKLOG: 0,
  UNSTARTED: 1,
  STARTED: 2,
  COMPLETED: 3,
  CANCELED: 4,
};

export const WORKFLOW_CATEGORY_LABELS: Record<WorkflowStateCategory, string> = {
  BACKLOG: "Backlog",
  UNSTARTED: "Do zrobienia",
  STARTED: "W toku",
  COMPLETED: "Zrobione",
  CANCELED: "Anulowane",
};

export const ISSUE_SORT_LABELS: Record<IssueSort, string> = {
  updated: "Ostatnio zmienione",
  created: "Najnowsze",
  priority: "Priorytet",
  dueDate: "Termin",
  manual: "Kolejność ręczna",
};

export const ISSUE_RELATION_LABELS: Record<IssueRelationViewType, string> = {
  BLOCKS: "Blokuje",
  BLOCKED_BY: "Blokowane przez",
  RELATED: "Powiązane z",
  DUPLICATE: "Duplikat",
};

export const CORE_UNIT_TYPE_LABELS: Record<CoreUnitType, string> = {
  BRANCH: "Oddział",
  DEPARTMENT: "Dział",
  TEAM: "Zespół",
};

/** Kolejność priorytetów zgodna z Linear (0 brak, 1 pilny, 2 wysoki, 3 średni, 4 niski). */
export const LINEAR_PRIORITY_OPTIONS: readonly IssuePriorityValue[] = ISSUE_PRIORITIES;

export const PRIORITY_FILTER_OPTIONS: readonly IssuePriorityValue[] = [1, 2, 3, 4, 0];

export function formatPriorityLabel(priority: number): string {
  return ISSUE_PRIORITY_LABELS[priority as IssuePriorityValue] ?? ISSUE_PRIORITY_LABELS[0];
}

export const COLOR_TOKEN_LABELS: Record<ColorToken, string> = {
  gray: "Szary",
  blue: "Niebieski",
  cyan: "Błękitny",
  teal: "Morski",
  green: "Zielony",
  yellow: "Żółty",
  orange: "Pomarańczowy",
  red: "Czerwony",
  pink: "Różowy",
  purple: "Fioletowy",
};

export interface ColorTokenStyle {
  readonly dot: string;
  readonly text: string;
  readonly badge: string;
}

/**
 * Mapowanie nazwanych tokenów kolorów (`ColorToken`) na klasy Tailwind i zmienne motywu `@monorise-team/tokens`,
 * bez wpisywania kolorów szesnastkowych na sztywno.
 */
export const COLOR_TOKEN_STYLES: Record<ColorToken, ColorTokenStyle> = {
  gray: {
    dot: "bg-text-tertiary",
    text: "text-text-secondary",
    badge: "border-border-primary bg-bg-tertiary text-text-secondary",
  },
  blue: {
    dot: "bg-blue-600 dark:bg-blue-400",
    text: "text-blue-700 dark:text-blue-300",
    badge: "border-blue-500/30 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  },
  cyan: {
    dot: "bg-cyan-600 dark:bg-cyan-400",
    text: "text-cyan-700 dark:text-cyan-300",
    badge: "border-cyan-500/30 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  },
  teal: {
    dot: "bg-teal-600 dark:bg-teal-400",
    text: "text-teal-700 dark:text-teal-300",
    badge: "border-teal-500/30 bg-teal-500/15 text-teal-700 dark:text-teal-300",
  },
  green: {
    dot: "bg-success",
    text: "text-success",
    badge: "border-success/30 bg-success/15 text-success",
  },
  yellow: {
    dot: "bg-warning",
    text: "text-warning",
    badge: "border-warning/30 bg-warning/15 text-warning",
  },
  orange: {
    dot: "bg-orange-600 dark:bg-orange-400",
    text: "text-orange-700 dark:text-orange-300",
    badge: "border-orange-500/30 bg-orange-500/15 text-orange-700 dark:text-orange-300",
  },
  red: {
    dot: "bg-danger",
    text: "text-danger",
    badge: "border-danger/30 bg-danger/15 text-danger",
  },
  pink: {
    dot: "bg-pink-600 dark:bg-pink-400",
    text: "text-pink-700 dark:text-pink-300",
    badge: "border-pink-500/30 bg-pink-500/15 text-pink-700 dark:text-pink-300",
  },
  purple: {
    dot: "bg-purple-600 dark:bg-purple-400",
    text: "text-purple-700 dark:text-purple-300",
    badge: "border-purple-500/30 bg-purple-500/15 text-purple-700 dark:text-purple-300",
  },
};

export function getColorTokenStyle(color: ColorToken): ColorTokenStyle {
  return COLOR_TOKEN_STYLES[color] ?? COLOR_TOKEN_STYLES.gray;
}

export function isColorToken(value: string): value is ColorToken {
  return (COLOR_TOKENS as readonly string[]).includes(value);
}

// ── Formatowanie dat i osób ──────────────────────────────────────────────────

export function formatMemberName(member: Pick<TeamMember, "firstName" | "lastName">): string {
  return `${member.firstName} ${member.lastName}`.trim();
}

export function todayDateOnlyString(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isIssueOverdue(
  issue: Pick<IssueListItem, "dueDate" | "state">,
  todayYmd = todayDateOnlyString(),
): boolean {
  if (!issue.dueDate) return false;
  if (issue.state.category === "COMPLETED" || issue.state.category === "CANCELED") return false;
  return issue.dueDate < todayYmd;
}

const shortDateFormatter = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const fullDateFormatter = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const dateTimeFormatter = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDueDate(dueDate: string, now = new Date()): string {
  const parsed = new Date(`${dueDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return dueDate;
  return parsed.getUTCFullYear() === now.getUTCFullYear()
    ? shortDateFormatter.format(parsed)
    : fullDateFormatter.format(parsed);
}

export function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return dateTimeFormatter.format(parsed);
}

// ── Filtry listy zadań w zapytaniu URL ───────────────────────────────────────

export interface IssueListFilters {
  readonly teamId: string;
  readonly stateId: string;
  readonly stateCategory: WorkflowStateCategory | "";
  readonly assignee: string;
  readonly labelId: string;
  readonly priority: string;
  readonly q: string;
  readonly includeCompleted: boolean;
  readonly sort: IssueSort;
}

export const DEFAULT_ISSUE_LIST_FILTERS: IssueListFilters = {
  teamId: "",
  stateId: "",
  stateCategory: "",
  assignee: "",
  labelId: "",
  priority: "",
  q: "",
  includeCompleted: false,
  sort: "updated",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidParam(value: string | null): value is string {
  return Boolean(value && UUID_REGEX.test(value));
}

export function parseIssueListFilters(searchParams: URLSearchParams | Readonly<URLSearchParams>): IssueListFilters {
  const rawTeamId = searchParams.get("teamId");
  const rawStateId = searchParams.get("stateId");
  const rawCategory = searchParams.get("stateCategory");
  const rawAssignee = searchParams.get("assignee");
  const rawLabelId = searchParams.get("labelId");
  const rawPriority = searchParams.get("priority");
  const rawQ = searchParams.get("q") ?? "";
  const rawIncludeCompleted = searchParams.get("includeCompleted");
  const rawSort = searchParams.get("sort");

  const stateCategory =
    rawCategory && (WORKFLOW_STATE_CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as WorkflowStateCategory)
      : "";

  const assignee = rawAssignee === "me" || rawAssignee === "none" || isUuidParam(rawAssignee) ? rawAssignee : "";

  const priorityNum = rawPriority !== null && rawPriority !== "" ? Number(rawPriority) : Number.NaN;
  const priority = Number.isInteger(priorityNum) && priorityNum >= 0 && priorityNum <= 4 ? String(priorityNum) : "";

  const sort =
    rawSort && (ISSUE_SORT_OPTIONS as readonly string[]).includes(rawSort) ? (rawSort as IssueSort) : "updated";

  return {
    teamId: isUuidParam(rawTeamId) ? rawTeamId : "",
    stateId: isUuidParam(rawStateId) ? rawStateId : "",
    stateCategory,
    assignee,
    labelId: isUuidParam(rawLabelId) ? rawLabelId : "",
    priority,
    q: rawQ.slice(0, 200),
    includeCompleted: rawIncludeCompleted === "true" || rawIncludeCompleted === "1",
    sort,
  };
}

export function serializeIssueListFilters(filters: IssueListFilters): string {
  const params = new URLSearchParams();
  if (filters.teamId) params.set("teamId", filters.teamId);
  if (filters.stateId) params.set("stateId", filters.stateId);
  if (filters.stateCategory) params.set("stateCategory", filters.stateCategory);
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.labelId) params.set("labelId", filters.labelId);
  if (filters.priority !== "") params.set("priority", filters.priority);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.includeCompleted) params.set("includeCompleted", "true");
  if (filters.sort !== "updated") params.set("sort", filters.sort);
  return params.toString();
}

export function hasActiveIssueFilters(filters: IssueListFilters): boolean {
  return Boolean(
    filters.teamId ||
    filters.stateId ||
    filters.stateCategory ||
    filters.assignee ||
    filters.labelId ||
    filters.priority !== "" ||
    filters.q.trim() ||
    filters.includeCompleted,
  );
}

export function toApiIssueListQuery(
  filters: IssueListFilters,
  overrides: {
    readonly teamId?: string;
    readonly assignee?: IssueListQuery["assignee"];
    readonly limit?: number;
    readonly cursor?: string;
  } = {},
): IssueListQuery {
  const query: IssueListQuery = {
    sort: filters.sort,
    limit: overrides.limit ?? 50,
  };

  const effectiveTeamId = overrides.teamId ?? (filters.teamId || undefined);
  if (effectiveTeamId) query.teamId = effectiveTeamId;
  if (filters.stateId) query.stateId = filters.stateId;
  if (filters.stateCategory) query.stateCategory = filters.stateCategory;

  const effectiveAssignee = overrides.assignee ?? (filters.assignee || undefined);
  if (effectiveAssignee) query.assignee = effectiveAssignee;

  if (filters.labelId) query.labelId = filters.labelId;
  if (filters.priority !== "") query.priority = Number(filters.priority);
  if (filters.q.trim()) query.q = filters.q.trim();
  if (filters.includeCompleted) query.includeCompleted = true;
  if (overrides.cursor) query.cursor = overrides.cursor;

  return query;
}

// ── Grupowanie listy zadań według kolejności kategorii statusów ──────────────

export interface IssueGroup {
  readonly key: string;
  readonly label: string;
  readonly category: WorkflowStateCategory;
  readonly color: ColorToken;
  readonly stateId?: string;
  readonly position: number;
  readonly issues: readonly IssueListItem[];
}

/**
 * Grupuje zadania według statusów obiegu posortowanych w kolejności kategorii
 * (`BACKLOG`, `UNSTARTED`, `STARTED`, `COMPLETED`, `CANCELED`), a następnie po `position` i nazwie.
 * Kolejność samych zadań wewnątrz grupy (z wybranego sortowania API) zostaje zachowana.
 */
export function groupIssuesByState(
  issues: readonly IssueListItem[],
  knownStates: readonly WorkflowState[] = [],
): IssueGroup[] {
  const stateMeta = new Map<
    string,
    { id: string; name: string; category: WorkflowStateCategory; color: ColorToken; position: number }
  >();
  for (const state of knownStates) {
    stateMeta.set(state.id, state);
  }

  const buckets = new Map<string, IssueListItem[]>();
  for (const issue of issues) {
    if (!stateMeta.has(issue.state.id)) {
      stateMeta.set(issue.state.id, issue.state);
    }
    const existing = buckets.get(issue.state.id);
    if (existing) {
      existing.push(issue);
    } else {
      buckets.set(issue.state.id, [issue]);
    }
  }

  const groups: IssueGroup[] = [];
  for (const [stateId, bucketIssues] of buckets.entries()) {
    const meta = stateMeta.get(stateId);
    if (!meta) continue;
    groups.push({
      key: stateId,
      stateId,
      label: meta.name,
      category: meta.category,
      color: meta.color,
      position: meta.position,
      issues: bucketIssues,
    });
  }

  groups.sort((a, b) => {
    const categoryDiff = WORKFLOW_CATEGORY_ORDER[a.category] - WORKFLOW_CATEGORY_ORDER[b.category];
    if (categoryDiff !== 0) return categoryDiff;
    if (a.position !== b.position) return a.position - b.position;
    return a.label.localeCompare(b.label, "pl");
  });

  return groups;
}

const CATEGORY_DEFAULT_COLORS: Record<WorkflowStateCategory, ColorToken> = {
  BACKLOG: "gray",
  UNSTARTED: "blue",
  STARTED: "yellow",
  COMPLETED: "green",
  CANCELED: "red",
};

/**
 * Grupuje zadania przekrojowe (np. „Moje zadania” z wielu zespołów) według kategorii statusu obiegu
 * w ustalonej kolejności (`BACKLOG` -> `UNSTARTED` -> `STARTED` -> `COMPLETED` -> `CANCELED`).
 */
export function groupIssuesByCategory(issues: readonly IssueListItem[]): IssueGroup[] {
  const buckets = new Map<WorkflowStateCategory, IssueListItem[]>();
  for (const issue of issues) {
    const existing = buckets.get(issue.state.category);
    if (existing) {
      existing.push(issue);
    } else {
      buckets.set(issue.state.category, [issue]);
    }
  }

  const groups: IssueGroup[] = [];
  for (const category of WORKFLOW_STATE_CATEGORIES) {
    const bucketIssues = buckets.get(category);
    if (!bucketIssues || bucketIssues.length === 0) continue;
    groups.push({
      key: category,
      label: WORKFLOW_CATEGORY_LABELS[category],
      category,
      color: CATEGORY_DEFAULT_COLORS[category],
      position: WORKFLOW_CATEGORY_ORDER[category],
      issues: bucketIssues,
    });
  }

  return groups;
}

/** Zwraca płaską listę zadań w dokładnej kolejności wyświetlania grup (pod nawigację `j`/`k`/`Enter`). */
export function flattenGroupedIssues(groups: readonly IssueGroup[]): IssueListItem[] {
  const flat: IssueListItem[] = [];
  for (const group of groups) {
    for (const issue of group.issues) {
      flat.push(issue);
    }
  }
  return flat;
}

// ── Porządkowanie wyników palety poleceń ─────────────────────────────────────

/**
 * Porządkuje wyniki wyszukiwania zadań w palecie `⌘K`:
 * 1. dokładne dopasowanie identyfikatora (bez rozróżniania wielkości liter, np. `MAG-1`),
 * 2. dopasowanie prefiksu identyfikatora (np. `MAG-1` przed `MAG-10`),
 * 3. pozostałe trafienia pełnotekstowe w kolejności zwróconej przez API.
 * Usuwa ewentualne duplikaty po `id`.
 */
export function orderPaletteSearchResults(issues: readonly IssueListItem[], rawQuery: string): IssueListItem[] {
  const seen = new Set<string>();
  const unique: IssueListItem[] = [];
  for (const issue of issues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    unique.push(issue);
  }

  const normalized = rawQuery.trim().toUpperCase();
  if (!normalized) return unique;

  const exact: IssueListItem[] = [];
  const prefix: IssueListItem[] = [];
  const rest: IssueListItem[] = [];

  for (const issue of unique) {
    const idUpper = issue.identifier.toUpperCase();
    if (idUpper === normalized) {
      exact.push(issue);
    } else if (idUpper.startsWith(normalized)) {
      prefix.push(issue);
    } else {
      rest.push(issue);
    }
  }

  return [...exact, ...prefix, ...rest];
}

// ── Pomocnik zmiany kolejności statusów obiegu ───────────────────────────────

export interface WorkflowStatePositionUpdate {
  readonly stateId: string;
  readonly position: number;
}

/**
 * Wyznacza minimalną listę zmian `position` potrzebnych do przesunięcia statusu o jedną pozycję
 * w górę lub w dół. Gdy statusy mają zduplikowane pozycje, normalizuje kolejność do `0..N-1`.
 */
export function computeStateReorderUpdates(
  states: readonly WorkflowState[],
  stateId: string,
  direction: "up" | "down",
): WorkflowStatePositionUpdate[] {
  const ordered = [...states].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  const index = ordered.findIndex((state) => state.id === stateId);
  if (index === -1) return [];

  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= ordered.length) return [];

  const swapped = [...ordered];
  const current = swapped[index]!;
  const neighbor = swapped[targetIndex]!;
  swapped[index] = neighbor;
  swapped[targetIndex] = current;

  const updates: WorkflowStatePositionUpdate[] = [];
  for (let i = 0; i < swapped.length; i++) {
    const state = swapped[i]!;
    if (state.position !== i) {
      updates.push({ stateId: state.id, position: i });
    }
  }
  return updates;
}

/** Zwraca domyślny status dla nowego zadania (pierwszy BACKLOG, a bez niego pierwszy UNSTARTED). */
export function resolveDefaultWorkflowStateId(states: readonly WorkflowState[]): string | undefined {
  const ordered = [...states].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  const backlog = ordered.find((state) => state.category === "BACKLOG");
  if (backlog) return backlog.id;
  const unstarted = ordered.find((state) => state.category === "UNSTARTED");
  if (unstarted) return unstarted.id;
  return ordered[0]?.id;
}
