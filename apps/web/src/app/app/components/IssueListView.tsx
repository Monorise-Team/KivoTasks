"use client";

import {
  ISSUE_SORT_OPTIONS,
  WORKFLOW_STATE_CATEGORIES,
  type IssueListItem,
  type IssueSort,
  type Label,
  type Team,
  type TeamMember,
  type WorkflowState,
  type WorkflowStateCategory,
} from "@kivotasks/client";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  EmptyState,
  SearchField,
  Select,
  Skeleton,
  cn,
  useHotkeys,
} from "@monorise-team/ui";
import { Calendar, ListTodo, Plus, RefreshCw, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APP_PATHS, findTeamByKey, formatApiError, legacyHashToPath } from "../app-views";
import {
  DEFAULT_ISSUE_LIST_FILTERS,
  ISSUE_SORT_LABELS,
  PRIORITY_FILTER_OPTIONS,
  WORKFLOW_CATEGORY_LABELS,
  flattenGroupedIssues,
  formatDueDate,
  formatMemberName,
  formatPriorityLabel,
  groupIssuesByCategory,
  groupIssuesByState,
  hasActiveIssueFilters,
  isIssueOverdue,
  parseIssueListFilters,
  serializeIssueListFilters,
  toApiIssueListQuery,
  type IssueListFilters,
} from "../issue-ui";
import { useKivoTasks } from "../KivoTasksContext";
import { resolveListCursorIndex } from "../shortcuts";
import { LabelPill, PriorityIcon, StateIcon, TeamHeader } from "./IssueBadges";

export function MyIssuesView({ handleLegacyHash = false }: { handleLegacyHash?: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!handleLegacyHash) return;
    const redirectPath = legacyHashToPath(window.location.hash);
    if (redirectPath && redirectPath !== APP_PATHS.myIssues) {
      router.replace(redirectPath);
    }
  }, [handleLegacyHash, router]);

  return <IssueListSurface mode="my-issues" />;
}

export function TeamIssuesView({ teamKey }: { teamKey: string }) {
  const { teams, teamsLoading } = useKivoTasks();
  const team = useMemo(() => findTeamByKey(teams, teamKey), [teams, teamKey]);

  if (teamsLoading && !team) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Wczytywanie zespołu">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!team) {
    return (
      <Card surface="middle" className="p-8">
        <EmptyState
          icon={<Users aria-hidden />}
          title="Nie znaleziono zespołu"
          description="Zespół o podanym kluczu nie istnieje albo nie masz do niego dostępu."
          action={
            <Button asChild variant="primary">
              <Link href={APP_PATHS.teams}>Wróć do listy zespołów</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  return <IssueListSurface key={team.id} mode="team" team={team} />;
}

type IssueListSurfaceProps = { mode: "my-issues"; team?: undefined } | { mode: "team"; team: Team };

function IssueListSurface({ mode, team }: IssueListSurfaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    client,
    me,
    teams,
    canRead,
    canWriteTeam,
    canManageTeamById,
    issuesRevision,
    openCreateIssue,
    registerSearchFocus,
  } = useKivoTasks();

  const filters = useMemo(() => parseIssueListFilters(searchParams), [searchParams]);
  const [searchDraftState, setSearchDraftState] = useState<{ syncedQ: string; value: string }>({
    syncedQ: filters.q,
    value: filters.q,
  });
  const searchDraft = searchDraftState.syncedQ === filters.q ? searchDraftState.value : filters.q;
  const setSearchDraft = useCallback(
    (value: string) => setSearchDraftState({ syncedQ: filters.q, value }),
    [filters.q],
  );

  const [teamMeta, setTeamMeta] = useState<{
    readonly teamId: string;
    readonly states: readonly WorkflowState[];
    readonly labels: readonly Label[];
    readonly members: readonly TeamMember[];
  } | null>(null);

  const [manualRefreshCount, setManualRefreshCount] = useState(0);
  const [listState, setListState] = useState<{
    readonly key: string;
    readonly items: IssueListItem[];
    readonly nextCursor: string | null;
    readonly error: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const updateFilters = useCallback(
    (patch: Partial<IssueListFilters>) => {
      const next: IssueListFilters = { ...filters, ...patch };
      const serialized = serializeIssueListFilters(next);
      const basePath = pathname === "/app" ? "/" : pathname.startsWith("/app/") ? pathname.slice(4) : pathname;
      router.replace(serialized ? `${basePath}?${serialized}` : basePath, { scroll: false });
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    registerSearchFocus(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => registerSearchFocus(null);
  }, [registerSearchFocus]);

  // Debounce wpisu wyszukiwania do zapytania URL
  useEffect(() => {
    const trimmedDraft = searchDraft.trim();
    if (trimmedDraft === filters.q.trim()) return;
    const timer = window.setTimeout(() => {
      updateFilters({ q: trimmedDraft });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft, filters.q, updateFilters]);

  // Metadane zespołu (statusy, etykiety, członkowie) dla widoku zespołu
  useEffect(() => {
    if (mode !== "team" || !team) return;
    let cancelled = false;
    Promise.allSettled([client.states.list(team.id), client.labels.list(team.id), client.teams.members(team.id)]).then(
      ([statesRes, labelsRes, membersRes]) => {
        if (cancelled) return;
        setTeamMeta({
          teamId: team.id,
          states: statesRes.status === "fulfilled" ? statesRes.value.states : [],
          labels: labelsRes.status === "fulfilled" ? labelsRes.value.labels : [],
          members: membersRes.status === "fulfilled" ? membersRes.value.members : [],
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [mode, team, client, issuesRevision]);

  const states = useMemo(
    () => (mode === "team" && team && teamMeta?.teamId === team.id ? teamMeta.states : []),
    [mode, team, teamMeta],
  );
  const labels = useMemo(
    () => (mode === "team" && team && teamMeta?.teamId === team.id ? teamMeta.labels : []),
    [mode, team, teamMeta],
  );
  const members = useMemo(
    () => (mode === "team" && team && teamMeta?.teamId === team.id ? teamMeta.members : []),
    [mode, team, teamMeta],
  );

  const apiQuery = useMemo(
    () =>
      toApiIssueListQuery(filters, {
        teamId: mode === "team" ? team.id : undefined,
        assignee: mode === "my-issues" ? "me" : undefined,
      }),
    [filters, mode, team],
  );

  const fetchKey = useMemo(
    () => `${JSON.stringify(apiQuery)}#${issuesRevision}#${manualRefreshCount}`,
    [apiQuery, issuesRevision, manualRefreshCount],
  );

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    client.issues
      .list(apiQuery)
      .then((result) => {
        if (cancelled) return;
        setListState({
          key: fetchKey,
          items: result.items,
          nextCursor: result.nextCursor,
          error: null,
        });
        setPaginationError(null);
        setSelectedIndex(-1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setListState({
          key: fetchKey,
          items: [],
          nextCursor: null,
          error: formatApiError(err, "Nie udało się pobrać listy zadań."),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [canRead, client, apiQuery, fetchKey]);

  const settledList = listState?.key === fetchKey ? listState : null;
  const loading = canRead && !settledList;
  const issues = useMemo(() => settledList?.items ?? [], [settledList]);
  const nextCursor = settledList?.nextCursor ?? null;
  const error = paginationError ?? settledList?.error ?? null;

  const clearError = () => {
    setPaginationError(null);
    setListState((prev) => (prev ? { ...prev, error: null } : prev));
  };

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setPaginationError(null);
    try {
      const query = toApiIssueListQuery(filters, {
        teamId: mode === "team" ? team.id : undefined,
        assignee: mode === "my-issues" ? "me" : undefined,
        cursor: nextCursor,
      });
      const result = await client.issues.list(query);
      setListState((prev) => {
        if (!prev || prev.key !== fetchKey) return prev;
        const seen = new Set(prev.items.map((item) => item.id));
        const appended = result.items.filter((item) => !seen.has(item.id));
        return {
          ...prev,
          items: [...prev.items, ...appended],
          nextCursor: result.nextCursor,
        };
      });
    } catch (err) {
      setPaginationError(formatApiError(err, "Nie udało się wczytać kolejnych zadań."));
    } finally {
      setLoadingMore(false);
    }
  };

  const groups = useMemo(
    () => (mode === "team" ? groupIssuesByState(issues, states) : groupIssuesByCategory(issues)),
    [mode, issues, states],
  );

  const flatIssues = useMemo(() => flattenGroupedIssues(groups), [groups]);

  const memberNameByAccountId = useMemo(() => {
    const map = new Map<string, string>();
    map.set(me.account.id, me.employee.fullName);
    for (const member of members) {
      map.set(member.accountId, formatMemberName(member));
    }
    return map;
  }, [me.account.id, me.employee.fullName, members]);

  const selectedIssue = selectedIndex >= 0 && selectedIndex < flatIssues.length ? flatIssues[selectedIndex] : null;

  useEffect(() => {
    if (!selectedIssue) return;
    const node = rowRefs.current.get(selectedIssue.id);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIssue]);

  const listHotkeys = useMemo(
    () => [
      {
        shortcut: "j",
        enabled: flatIssues.length > 0,
        handler: () => {
          setSelectedIndex((prev) => resolveListCursorIndex(prev, "next", flatIssues.length));
        },
      },
      {
        shortcut: "k",
        enabled: flatIssues.length > 0,
        handler: () => {
          setSelectedIndex((prev) => resolveListCursorIndex(prev, "prev", flatIssues.length));
        },
      },
      {
        shortcut: "enter",
        enabled: Boolean(selectedIssue),
        preventDefault: false,
        handler: (event: KeyboardEvent) => {
          if (!selectedIssue) return;
          if (
            event.target instanceof Element &&
            event.target.closest('a, button, input, select, textarea, [role="button"], [role="menuitem"]')
          ) {
            return;
          }
          event.preventDefault();
          router.push(APP_PATHS.issueDetail(selectedIssue.identifier));
        },
      },
    ],
    [flatIssues.length, selectedIssue, router],
  );

  useHotkeys(listHotkeys, { ignoreWhenModalOpen: true });

  const canWrite = mode === "team" ? canWriteTeam(team.id) : canWriteTeam() && teams.length > 0;
  const canManage = mode === "team" ? canManageTeamById(team.id) : false;
  const filtersActive = hasActiveIssueFilters(filters);

  if (!canRead) {
    return (
      <div className="flex flex-col gap-5">
        {mode === "team" ? (
          <TeamHeader team={team} activeTab="list" canWrite={false} canManage={canManage} onNewIssue={() => {}} />
        ) : (
          <h1 className="text-xl font-semibold text-text-primary">Moje zadania</h1>
        )}
        <Banner
          tone="warning"
          message="Twoja rola nie obejmuje podglądu zadań. Jeśli zarządzasz zespołami, przejdź do sekcji Zespoły."
        />
        <div>
          <Button asChild variant="secondary">
            <Link href={APP_PATHS.teams}>Przejdź do zespołów</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {mode === "team" ? (
        <TeamHeader
          team={team}
          activeTab="list"
          canWrite={canWrite}
          canManage={canManage}
          onNewIssue={() => openCreateIssue({ teamId: team.id })}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-primary pb-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold text-text-primary">Moje zadania</h1>
            <p className="text-sm text-text-secondary">
              Zadania przypisane do Ciebie we wszystkich dostępnych zespołach.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw aria-hidden />}
              disabled={loading}
              onClick={() => setManualRefreshCount((prev) => prev + 1)}
            >
              Odśwież
            </Button>
            {canWrite ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Plus aria-hidden />}
                onClick={() => openCreateIssue({ defaultAssignToMe: true })}
              >
                Nowe zadanie
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {/* Pasek filtrów i sortowania */}
      <div className="flex flex-col gap-3 rounded-card border border-border-primary bg-bg-secondary/50 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            ref={searchInputRef}
            value={searchDraft}
            shortcut="/"
            placeholder="Szukaj po tytule, opisie lub identyfikatorze…"
            aria-label="Filtruj listę zadań"
            className="min-w-56 flex-1"
            onChange={(event) => setSearchDraft(event.target.value)}
          />

          <div className="w-48 shrink-0">
            <Select
              aria-label="Sortowanie zadań"
              value={filters.sort}
              onChange={(event) => updateFilters({ sort: event.target.value as IssueSort })}
            >
              {ISSUE_SORT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  Sortuj: {ISSUE_SORT_LABELS[option]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {mode === "team" ? (
            <div className="w-44">
              <Select
                aria-label="Filtr statusu"
                value={filters.stateId}
                onChange={(event) => updateFilters({ stateId: event.target.value })}
              >
                <option value="">Wszystkie statusy</option>
                {states.map((state) => (
                  <option key={state.id} value={state.id}>
                    {state.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <>
              <div className="w-44">
                <Select
                  aria-label="Filtr kategorii statusu"
                  value={filters.stateCategory}
                  onChange={(event) =>
                    updateFilters({ stateCategory: event.target.value as WorkflowStateCategory | "" })
                  }
                >
                  <option value="">Wszystkie statusy</option>
                  {WORKFLOW_STATE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {WORKFLOW_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </Select>
              </div>
              {teams.length > 1 ? (
                <div className="w-48">
                  <Select
                    aria-label="Filtr zespołu"
                    value={filters.teamId}
                    onChange={(event) => updateFilters({ teamId: event.target.value })}
                  >
                    <option value="">Wszystkie zespoły</option>
                    {teams.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.key} · {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
            </>
          )}

          {mode === "team" ? (
            <div className="w-48">
              <Select
                aria-label="Filtr osoby przypisanej"
                value={filters.assignee}
                onChange={(event) => updateFilters({ assignee: event.target.value })}
              >
                <option value="">Wszyscy przypisani</option>
                <option value="me">Przypisane do mnie</option>
                <option value="none">Nieprzypisane</option>
                {members.map((member) => (
                  <option key={member.accountId} value={member.accountId}>
                    {formatMemberName(member)}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {mode === "team" && labels.length > 0 ? (
            <div className="w-44">
              <Select
                aria-label="Filtr etykiety"
                value={filters.labelId}
                onChange={(event) => updateFilters({ labelId: event.target.value })}
              >
                <option value="">Wszystkie etykiety</option>
                {labels.map((label) => (
                  <option key={label.id} value={label.id}>
                    {label.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          <div className="w-40">
            <Select
              aria-label="Filtr priorytetu"
              value={filters.priority}
              onChange={(event) => updateFilters({ priority: event.target.value })}
            >
              <option value="">Każdy priorytet</option>
              {PRIORITY_FILTER_OPTIONS.map((value) => (
                <option key={value} value={String(value)}>
                  {formatPriorityLabel(value)}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex items-center px-1">
            <Checkbox
              label="Pokaż zakończone"
              checked={filters.includeCompleted}
              onCheckedChange={(checked) => updateFilters({ includeCompleted: checked === true })}
            />
          </div>

          {filtersActive ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<X aria-hidden />}
              onClick={() => {
                setSearchDraft("");
                updateFilters({ ...DEFAULT_ISSUE_LIST_FILTERS, sort: filters.sort });
              }}
            >
              Wyczyść filtry
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <Banner tone="danger" message={error} onDismiss={clearError} /> : null}

      {loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Wczytywanie listy zadań">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <Card surface="middle" className="p-8">
          <EmptyState
            icon={<ListTodo aria-hidden />}
            title={filtersActive ? "Brak zadań pasujących do filtrów" : "Brak aktywnych zadań"}
            description={
              filtersActive
                ? "Zmień lub wyczyść filtry albo włącz opcję „Pokaż zakończone”, aby zobaczyć więcej wyników."
                : mode === "team"
                  ? "W tym zespole nie ma jeszcze otwartych zadań. Możesz utworzyć pierwsze zadanie przyciskiem powyżej lub klawiszem C."
                  : "Nie masz obecnie otwartych zadań przypisanych do siebie."
            }
            action={
              filtersActive ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearchDraft("");
                    updateFilters({ ...DEFAULT_ISSUE_LIST_FILTERS, sort: filters.sort });
                  }}
                >
                  Wyczyść filtry
                </Button>
              ) : canWrite ? (
                <Button
                  variant="primary"
                  icon={<Plus aria-hidden />}
                  onClick={() => openCreateIssue(mode === "team" ? { teamId: team.id } : { defaultAssignToMe: true })}
                >
                  Nowe zadanie
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-5" role="region" aria-label="Lista zadań pogrupowana według statusów">
          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`group-heading-${group.key}`} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 px-1">
                <StateIcon category={group.category} color={group.color} />
                <h2 id={`group-heading-${group.key}`} className="text-sm font-semibold text-text-primary">
                  {group.label}
                </h2>
                <Badge tone="neutral">{group.issues.length}</Badge>
              </div>

              <div className="flex flex-col divide-y divide-border-secondary overflow-hidden rounded-card border border-border-primary bg-bg-secondary/45">
                {group.issues.map((issue) => {
                  const isSelected = selectedIssue?.id === issue.id;
                  const assigneeName = issue.assigneeAccountId
                    ? (memberNameByAccountId.get(issue.assigneeAccountId) ?? "Przypisana osoba")
                    : null;
                  const overdue = isIssueOverdue(issue);

                  return (
                    <div
                      key={issue.id}
                      ref={(node) => {
                        if (node) rowRefs.current.set(issue.id, node);
                        else rowRefs.current.delete(issue.id);
                      }}
                      data-selected={isSelected ? "true" : undefined}
                      onMouseEnter={() => {
                        const idx = flatIssues.findIndex((item) => item.id === issue.id);
                        if (idx !== -1) setSelectedIndex(idx);
                      }}
                      className={cn(
                        "flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5 transition-colors sm:flex-nowrap",
                        isSelected ? "bg-bg-selected" : "hover:bg-row-hover",
                      )}
                    >
                      <div className="flex shrink-0 items-center gap-2">
                        <PriorityIcon priority={issue.priority} />
                        <span className="w-18 shrink-0 font-mono text-xs font-medium text-text-tertiary tabular-nums">
                          {issue.identifier}
                        </span>
                      </div>

                      <Link
                        href={APP_PATHS.issueDetail(issue.identifier)}
                        className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary hover:text-link hover:underline"
                      >
                        {issue.title}
                      </Link>

                      {mode === "my-issues" && issue.state.name !== group.label ? (
                        <Badge tone="neutral" className="shrink-0">
                          {issue.state.name}
                        </Badge>
                      ) : null}

                      {issue.labels.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1">
                          {issue.labels.slice(0, 3).map((label) => (
                            <LabelPill key={label.id} label={label} />
                          ))}
                          {issue.labels.length > 3 ? <Badge tone="neutral">+{issue.labels.length - 3}</Badge> : null}
                        </div>
                      ) : null}

                      <div className="ml-auto flex shrink-0 items-center gap-3">
                        {issue.dueDate ? (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 text-xs tabular-nums",
                              overdue ? "font-medium text-danger" : "text-text-tertiary",
                            )}
                            title={overdue ? `Termin minął: ${issue.dueDate}` : `Termin: ${issue.dueDate}`}
                          >
                            <Calendar className="size-3.5" aria-hidden />
                            {formatDueDate(issue.dueDate)}
                          </span>
                        ) : null}

                        {assigneeName ? (
                          <span
                            className="inline-flex items-center gap-1.5 text-xs text-text-secondary"
                            title={`Osoba przypisana: ${assigneeName}`}
                          >
                            <Avatar name={assigneeName} seed={issue.assigneeAccountId ?? assigneeName} size="sm" />
                            <span className="hidden max-w-28 truncate md:inline">{assigneeName}</span>
                          </span>
                        ) : (
                          <span
                            className="hidden w-24 text-right text-xs text-text-tertiary md:inline"
                            aria-label="Nieprzypisane"
                          >
                            Nieprzypisane
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {nextCursor ? (
            <div className="flex justify-center pt-2">
              <Button variant="secondary" size="md" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                {loadingMore ? "Wczytywanie…" : "Wczytaj więcej"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
