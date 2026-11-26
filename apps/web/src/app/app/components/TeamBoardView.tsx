"use client";

import {
  ApiError,
  type IssueListItem,
  type Label,
  type Team,
  type TeamMember,
  type WorkflowState,
} from "@kivotasks/client";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  SearchField,
  Select,
  Skeleton,
  cn,
  useToast,
} from "@monorise-team/ui";
import { ArrowDown, ArrowRightLeft, ArrowUp, Calendar, Check, GripVertical, Plus, Users, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { APP_PATHS, findTeamByKey, formatApiError } from "../app-views";
import {
  applyBoardMove,
  buildBoardColumns,
  computeBoardMove,
  computeBoardMoveToStateEnd,
  computeKeyboardBoardStep,
  resolveDropSiblingIndex,
  type BoardMovePlan,
} from "../board-logic";
import {
  PRIORITY_FILTER_OPTIONS,
  formatDueDate,
  formatMemberName,
  formatPriorityLabel,
  isIssueOverdue,
} from "../issue-ui";
import { useKivoTasks } from "../KivoTasksContext";
import { LabelPill, PriorityIcon, StateIcon, TeamHeader } from "./IssueBadges";

export function TeamBoardView({ teamKey }: { teamKey: string }) {
  const { teams, teamsLoading } = useKivoTasks();
  const team = useMemo(() => findTeamByKey(teams, teamKey), [teams, teamKey]);

  if (teamsLoading && !team) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Wczytywanie tablicy zespołu">
        <Skeleton className="h-10 w-72" />
        <div className="flex gap-3 overflow-x-auto pb-2">
          {[0, 1, 2, 3].map((idx) => (
            <Skeleton key={idx} className="h-96 w-72 shrink-0" />
          ))}
        </div>
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

  return <TeamBoardSurface key={team.id} team={team} />;
}

interface DropIndicator {
  readonly stateId: string;
  readonly slotIndex: number;
}

function TeamBoardSurface({ team }: { team: Team }) {
  const { toast } = useToast();
  const {
    client,
    me,
    canRead,
    canWriteTeam,
    canManageTeamById,
    markTeamWriteDenied,
    issuesRevision,
    openCreateIssue,
    registerSearchFocus,
  } = useKivoTasks();

  const [states, setStates] = useState<WorkflowState[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [issues, setIssues] = useState<IssueListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Filtry lokalne na tablicy
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");

  // Stan przeciągania i operacji w toku
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  const searchInputRef = useRef<HTMLInputElement>(null);

  const canWrite = canWriteTeam(team.id);
  const canManage = canManageTeamById(team.id);

  useEffect(() => {
    registerSearchFocus(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => registerSearchFocus(null);
  }, [registerSearchFocus]);

  useEffect(() => {
    const trimmed = searchDraft.trim();
    if (trimmed === searchQuery) return;
    const timer = window.setTimeout(() => setSearchQuery(trimmed), 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft, searchQuery]);

  // Metadane zespołu
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([client.states.list(team.id), client.labels.list(team.id), client.teams.members(team.id)]).then(
      ([statesRes, labelsRes, membersRes]) => {
        if (cancelled) return;
        if (statesRes.status === "fulfilled") {
          setStates(statesRes.value.states);
        } else {
          setError(formatApiError(statesRes.reason, "Nie udało się pobrać statusów obiegu zespołu."));
        }
        setLabels(labelsRes.status === "fulfilled" ? labelsRes.value.labels : []);
        setMembers(membersRes.status === "fulfilled" ? membersRes.value.members : []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, team.id, issuesRevision]);

  const buildQuery = useCallback(
    (cursor?: string) => ({
      teamId: team.id,
      sort: "manual" as const,
      includeCompleted: true,
      limit: 100,
      ...(assigneeFilter ? { assignee: assigneeFilter } : {}),
      ...(labelFilter ? { labelId: labelFilter } : {}),
      ...(priorityFilter !== "" ? { priority: Number(priorityFilter) } : {}),
      ...(searchQuery ? { q: searchQuery } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    [team.id, assigneeFilter, labelFilter, priorityFilter, searchQuery],
  );

  const boardFetchKey = useMemo(
    () => `${JSON.stringify(buildQuery())}#${issuesRevision}`,
    [buildQuery, issuesRevision],
  );

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    client.issues
      .list(buildQuery())
      .then((result) => {
        if (cancelled) return;
        setIssues(result.items);
        setNextCursor(result.nextCursor);
        setError(null);
        setLoadedKey(boardFetchKey);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(formatApiError(err, "Nie udało się pobrać zadań dla tablicy."));
        setLoadedKey(boardFetchKey);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, client, buildQuery, boardFetchKey]);

  const loading = canRead && loadedKey !== boardFetchKey;

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await client.issues.list(buildQuery(nextCursor));
      setIssues((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...result.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(formatApiError(err, "Nie udało się wczytać kolejnych zadań."));
    } finally {
      setLoadingMore(false);
    }
  };

  const columns = useMemo(() => buildBoardColumns(states, issues), [states, issues]);

  const memberNameByAccountId = useMemo(() => {
    const map = new Map<string, string>();
    map.set(me.account.id, me.employee.fullName);
    for (const member of members) {
      map.set(member.accountId, formatMemberName(member));
    }
    return map;
  }, [me.account.id, me.employee.fullName, members]);

  const executeMove = useCallback(
    async (plan: BoardMovePlan | null) => {
      if (!plan || !canWrite) return;
      const previous = issues.find((item) => item.id === plan.issueId);
      if (!previous) return;

      setMoveError(null);
      setIssues((prev) => applyBoardMove(prev, plan, states));
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.add(plan.issueId);
        return next;
      });

      try {
        const updated = await client.issues.update(plan.issueId, plan.patch);
        setIssues((prev) =>
          prev.map((item) =>
            item.id === updated.id
              ? {
                  ...item,
                  stateId: updated.stateId,
                  state: updated.state,
                  sortOrder: updated.sortOrder,
                  startedAt: updated.startedAt,
                  completedAt: updated.completedAt,
                  canceledAt: updated.canceledAt,
                  updatedAt: updated.updatedAt,
                }
              : item,
          ),
        );
      } catch (err) {
        // Wycofanie optymistycznej zmiany dla przenoszonego zadania
        setIssues((prev) => prev.map((item) => (item.id === previous.id ? previous : item)));
        if (err instanceof ApiError && err.status === 403 && err.code === "PERMISSION_DENIED") {
          markTeamWriteDenied(team.id);
        }
        const message = formatApiError(err, "Nie udało się przenieść zadania.");
        setMoveError(message);
        toast({
          title: `Nie udało się przenieść zadania ${previous.identifier}`,
          description: message,
          tone: "danger",
        });
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(plan.issueId);
          return next;
        });
      }
    },
    [canWrite, issues, states, client, markTeamWriteDenied, team.id, toast],
  );

  const handleCardDragStart = (event: DragEvent<HTMLDivElement>, issueId: string) => {
    if (!canWrite || pendingIds.has(issueId)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", issueId);
    setDraggingId(issueId);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDropIndicator(null);
  };

  const handleCardDragOver = (event: DragEvent<HTMLDivElement>, stateId: string, cardIndex: number) => {
    if (!canWrite || !draggingId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const isBottomHalf = event.clientY > rect.top + rect.height / 2;
    const slotIndex = isBottomHalf ? cardIndex + 1 : cardIndex;
    setDropIndicator((prev) =>
      prev && prev.stateId === stateId && prev.slotIndex === slotIndex ? prev : { stateId, slotIndex },
    );
  };

  const handleColumnDragOver = (event: DragEvent<HTMLElement>, stateId: string, columnLength: number) => {
    if (!canWrite || !draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropIndicator((prev) =>
      prev && prev.stateId === stateId && prev.slotIndex === columnLength ? prev : { stateId, slotIndex: columnLength },
    );
  };

  const handleDropOnColumn = (
    event: DragEvent<HTMLElement>,
    stateId: string,
    columnIssues: readonly IssueListItem[],
  ) => {
    event.preventDefault();
    if (!canWrite) return;
    const issueId = draggingId || event.dataTransfer.getData("text/plain");
    const rawSlot = dropIndicator && dropIndicator.stateId === stateId ? dropIndicator.slotIndex : columnIssues.length;

    setDraggingId(null);
    setDropIndicator(null);
    if (!issueId) return;

    const siblingIndex = resolveDropSiblingIndex(columnIssues, issueId, rawSlot);
    const plan = computeBoardMove(issues, issueId, stateId, siblingIndex);
    void executeMove(plan);
  };

  const hasFilters = Boolean(searchQuery || assigneeFilter || labelFilter || priorityFilter !== "");

  if (!canRead) {
    return (
      <div className="flex flex-col gap-5">
        <TeamHeader team={team} activeTab="board" canWrite={false} canManage={canManage} onNewIssue={() => {}} />
        <Banner tone="warning" message="Twoja rola nie obejmuje podglądu zadań w tym zespole." />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <TeamHeader
        team={team}
        activeTab="board"
        canWrite={canWrite}
        canManage={canManage}
        onNewIssue={() => openCreateIssue({ teamId: team.id })}
      />

      {/* Pasek filtrów tablicy */}
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-border-primary bg-bg-secondary/50 p-3">
        <SearchField
          ref={searchInputRef}
          value={searchDraft}
          shortcut="/"
          placeholder="Filtruj karty na tablicy…"
          aria-label="Filtruj karty na tablicy"
          className="min-w-48 flex-1"
          onChange={(event) => setSearchDraft(event.target.value)}
        />

        <div className="w-44">
          <Select
            aria-label="Filtr osoby przypisanej"
            value={assigneeFilter}
            onChange={(event) => setAssigneeFilter(event.target.value)}
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

        {labels.length > 0 ? (
          <div className="w-40">
            <Select
              aria-label="Filtr etykiety"
              value={labelFilter}
              onChange={(event) => setLabelFilter(event.target.value)}
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

        <div className="w-36">
          <Select
            aria-label="Filtr priorytetu"
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value)}
          >
            <option value="">Każdy priorytet</option>
            {PRIORITY_FILTER_OPTIONS.map((value) => (
              <option key={value} value={String(value)}>
                {formatPriorityLabel(value)}
              </option>
            ))}
          </Select>
        </div>

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<X aria-hidden />}
            onClick={() => {
              setSearchDraft("");
              setSearchQuery("");
              setAssigneeFilter("");
              setLabelFilter("");
              setPriorityFilter("");
            }}
          >
            Wyczyść
          </Button>
        ) : null}
      </div>

      {error ? <Banner tone="danger" message={error} onDismiss={() => setError(null)} /> : null}
      {moveError ? <Banner tone="danger" message={moveError} onDismiss={() => setMoveError(null)} /> : null}

      {loading && states.length === 0 ? (
        <div className="flex gap-3 overflow-x-auto pb-2" aria-busy="true" aria-label="Wczytywanie tablicy">
          {[0, 1, 2, 3].map((idx) => (
            <Skeleton key={idx} className="h-96 w-72 shrink-0" />
          ))}
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto pb-4"
          role="region"
          aria-label={`Tablica zadań zespołu ${team.name}`}
        >
          {columns.map((column) => {
            const isColumnDropTarget = dropIndicator?.stateId === column.state.id;
            return (
              <section
                key={column.state.id}
                aria-labelledby={`board-col-${column.state.id}`}
                onDragOver={(event) => handleColumnDragOver(event, column.state.id, column.issues.length)}
                onDrop={(event) => handleDropOnColumn(event, column.state.id, column.issues)}
                className={cn(
                  "flex w-76 shrink-0 flex-col gap-2 rounded-card border bg-bg-secondary/50 p-3 transition-colors",
                  isColumnDropTarget ? "border-accent bg-bg-selected/40" : "border-border-primary",
                )}
              >
                <div className="flex items-center justify-between gap-2 px-1 pb-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <StateIcon category={column.state.category} color={column.state.color} />
                    <h2
                      id={`board-col-${column.state.id}`}
                      className="truncate text-sm font-semibold text-text-primary"
                    >
                      {column.state.name}
                    </h2>
                    <Badge tone="neutral">{column.issues.length}</Badge>
                  </div>
                  {canWrite ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      aria-label={`Dodaj zadanie w statusie ${column.state.name}`}
                      onClick={() => openCreateIssue({ teamId: team.id, stateId: column.state.id })}
                    >
                      <Plus aria-hidden />
                    </Button>
                  ) : null}
                </div>

                <div className="flex min-h-24 flex-col gap-2">
                  {column.issues.length === 0 ? (
                    <div
                      className={cn(
                        "flex min-h-20 items-center justify-center rounded-row border border-dashed px-3 py-4 text-center text-xs text-text-tertiary",
                        isColumnDropTarget ? "border-accent text-accent-strong" : "border-border-secondary",
                      )}
                    >
                      {isColumnDropTarget ? "Upuść tutaj" : "Brak zadań w tym statusie"}
                    </div>
                  ) : (
                    column.issues.map((issue, cardIndex) => {
                      const isDragging = draggingId === issue.id;
                      const isPending = pendingIds.has(issue.id);
                      const showTopLine =
                        dropIndicator?.stateId === column.state.id && dropIndicator.slotIndex === cardIndex;
                      const showBottomLine =
                        dropIndicator?.stateId === column.state.id &&
                        dropIndicator.slotIndex === cardIndex + 1 &&
                        cardIndex === column.issues.length - 1;
                      const assigneeName = issue.assigneeAccountId
                        ? (memberNameByAccountId.get(issue.assigneeAccountId) ?? "Przypisana osoba")
                        : null;
                      const overdue = isIssueOverdue(issue);

                      return (
                        <div key={issue.id} className="flex flex-col gap-1.5">
                          {showTopLine ? <div className="h-0.5 rounded-full bg-accent" aria-hidden /> : null}
                          <div
                            draggable={canWrite && !isPending}
                            onDragStart={(event) => handleCardDragStart(event, issue.id)}
                            onDragEnd={handleDragEnd}
                            onDragOver={(event) => handleCardDragOver(event, column.state.id, cardIndex)}
                            onDrop={(event) => {
                              event.stopPropagation();
                              handleDropOnColumn(event, column.state.id, column.issues);
                            }}
                            className={cn(
                              "flex flex-col gap-2 rounded-row border border-border-primary bg-bg-primary/90 p-3 shadow-xs transition-colors",
                              canWrite && !isPending && "cursor-grab active:cursor-grabbing hover:border-accent/45",
                              isDragging && "opacity-45",
                              isPending && "opacity-65",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                {canWrite ? <GripVertical className="size-3.5 text-text-tertiary" aria-hidden /> : null}
                                <PriorityIcon priority={issue.priority} />
                                <span className="font-mono text-xs font-medium text-text-tertiary tabular-nums">
                                  {issue.identifier}
                                </span>
                              </div>

                              {canWrite ? (
                                <Menu>
                                  <MenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="xs"
                                      iconOnly
                                      disabled={isPending}
                                      aria-label={`Przenieś zadanie ${issue.identifier}`}
                                      title="Przenieś do…"
                                    >
                                      <ArrowRightLeft aria-hidden />
                                    </Button>
                                  </MenuTrigger>
                                  <MenuContent align="end">
                                    <MenuLabel>Przenieś do…</MenuLabel>
                                    {columns.map((targetCol) => {
                                      const isCurrent = targetCol.state.id === issue.stateId;
                                      return (
                                        <MenuItem
                                          key={targetCol.state.id}
                                          disabled={isCurrent}
                                          icon={
                                            isCurrent ? (
                                              <Check aria-hidden />
                                            ) : (
                                              <StateIcon
                                                category={targetCol.state.category}
                                                color={targetCol.state.color}
                                              />
                                            )
                                          }
                                          onSelect={() => {
                                            const plan = computeBoardMoveToStateEnd(
                                              issues,
                                              issue.id,
                                              targetCol.state.id,
                                            );
                                            void executeMove(plan);
                                          }}
                                        >
                                          {targetCol.state.name}
                                        </MenuItem>
                                      );
                                    })}
                                    <MenuSeparator />
                                    <MenuLabel>Kolejność w kolumnie</MenuLabel>
                                    <MenuItem
                                      disabled={cardIndex === 0}
                                      icon={<ArrowUp aria-hidden />}
                                      onSelect={() => {
                                        const plan = computeKeyboardBoardStep(issues, issue.id, "up");
                                        void executeMove(plan);
                                      }}
                                    >
                                      Przenieś wyżej
                                    </MenuItem>
                                    <MenuItem
                                      disabled={cardIndex === column.issues.length - 1}
                                      icon={<ArrowDown aria-hidden />}
                                      onSelect={() => {
                                        const plan = computeKeyboardBoardStep(issues, issue.id, "down");
                                        void executeMove(plan);
                                      }}
                                    >
                                      Przenieś niżej
                                    </MenuItem>
                                  </MenuContent>
                                </Menu>
                              ) : null}
                            </div>

                            <Link
                              href={APP_PATHS.issueDetail(issue.identifier)}
                              className="line-clamp-2 text-sm leading-snug font-medium text-text-primary hover:text-link hover:underline"
                            >
                              {issue.title}
                            </Link>

                            {issue.labels.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {issue.labels.map((label) => (
                                  <LabelPill key={label.id} label={label} />
                                ))}
                              </div>
                            ) : null}

                            {issue.dueDate || assigneeName ? (
                              <div className="flex items-center justify-between gap-2 pt-0.5">
                                {issue.dueDate ? (
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1 text-xs tabular-nums",
                                      overdue ? "font-medium text-danger" : "text-text-tertiary",
                                    )}
                                  >
                                    <Calendar className="size-3" aria-hidden />
                                    {formatDueDate(issue.dueDate)}
                                  </span>
                                ) : (
                                  <span />
                                )}

                                {assigneeName ? (
                                  <Avatar
                                    name={assigneeName}
                                    seed={issue.assigneeAccountId ?? assigneeName}
                                    size="sm"
                                    title={assigneeName}
                                  />
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          {showBottomLine ? <div className="h-0.5 rounded-full bg-accent" aria-hidden /> : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {nextCursor ? (
        <div className="flex justify-center pt-1">
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void handleLoadMore()}>
            {loadingMore ? "Wczytywanie…" : "Wczytaj więcej zadań"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
