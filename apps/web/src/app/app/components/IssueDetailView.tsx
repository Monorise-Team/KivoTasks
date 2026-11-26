"use client";

import {
  ApiError,
  ISSUE_RELATION_VIEW_TYPES,
  type IssueDetail,
  type IssueListItem,
  type IssueRelationViewType,
  type Label,
  type TeamMember,
  type UpdateIssueInput,
  type WorkflowState,
} from "@kivotasks/client";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuLabel,
  MenuTrigger,
  SearchField,
  Select,
  Separator,
  Skeleton,
  TextArea,
  TextField,
  cn,
  useToast,
} from "@monorise-team/ui";
import { ArrowLeft, ChevronRight, Copy, GitBranch, Link2, ListTodo, Plus, Tag, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { APP_PATHS, formatApiError } from "../app-views";
import {
  ISSUE_RELATION_LABELS,
  LINEAR_PRIORITY_OPTIONS,
  formatDateTime,
  formatMemberName,
  formatPriorityLabel,
  isIssueOverdue,
  orderPaletteSearchResults,
} from "../issue-ui";
import { useKivoTasks } from "../KivoTasksContext";
import { ColorDot, LabelPill, PriorityIcon, StateIcon } from "./IssueBadges";

export function IssueDetailView({ identifier }: { identifier: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const {
    client,
    me,
    teams,
    canRead,
    canWriteTeam,
    canManageTeamById,
    markTeamWriteDenied,
    setActiveIssueTeamKey,
    bumpIssuesRevision,
  } = useKivoTasks();

  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [loadedIdentifier, setLoadedIdentifier] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [states, setStates] = useState<WorkflowState[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);

  // Edycja tytułu i opisu
  const [titleDraft, setTitleDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [estimateDraft, setEstimateDraft] = useState("");
  const [savingField, setSavingField] = useState<string | null>(null);

  // Podzadanie
  const [subIssueFormOpen, setSubIssueFormOpen] = useState(false);
  const [subIssueTitle, setSubIssueTitle] = useState("");
  const [subIssuePriority, setSubIssuePriority] = useState(0);
  const [creatingSubIssue, setCreatingSubIssue] = useState(false);

  // Wybór rodzica
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [parentQuery, setParentQuery] = useState("");
  const [parentSearchResult, setParentSearchResult] = useState<{
    readonly query: string;
    readonly items: readonly IssueListItem[];
  } | null>(null);

  // Dodawanie powiązania
  const [relationFormOpen, setRelationFormOpen] = useState(false);
  const [relationType, setRelationType] = useState<IssueRelationViewType>("BLOCKS");
  const [relationQuery, setRelationQuery] = useState("");
  const [relationSearchResult, setRelationSearchResult] = useState<{
    readonly query: string;
    readonly items: readonly IssueListItem[];
  } | null>(null);
  const [relationBusy, setRelationBusy] = useState(false);

  // Usuwanie zadania
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    client.issues
      .get(identifier)
      .then((detail) => {
        if (cancelled) return;
        setIssue(detail);
        setTitleDraft(detail.title);
        setDescriptionDraft(detail.description ?? "");
        setEstimateDraft(detail.estimate !== null ? String(detail.estimate) : "");
        setLoadError(null);
        setActionError(null);
        setLoadedIdentifier(identifier);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = error instanceof ApiError ? error.status : 500;
        setIssue(null);
        setLoadError({
          status,
          message: formatApiError(error, "Nie udało się wczytać szczegółów zadania."),
        });
        setLoadedIdentifier(identifier);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, client, identifier]);

  const loading = canRead && loadedIdentifier !== identifier;
  const effectiveLoadError = !canRead ? { status: 403, message: "Nie masz uprawnień do podglądu zadań." } : loadError;

  const team = useMemo(() => (issue ? (teams.find((item) => item.id === issue.teamId) ?? null) : null), [issue, teams]);

  useEffect(() => {
    if (team) {
      setActiveIssueTeamKey(team.key);
    } else if (issue) {
      const prefix = issue.identifier.split("-")[0];
      setActiveIssueTeamKey(prefix ?? null);
    }
    return () => setActiveIssueTeamKey(null);
  }, [team, issue, setActiveIssueTeamKey]);

  const issueTeamId = issue?.teamId ?? null;

  // Metadane zespołu (statusy, etykiety, członkowie)
  useEffect(() => {
    if (!issueTeamId) return;
    let cancelled = false;
    Promise.allSettled([
      client.states.list(issueTeamId),
      client.labels.list(issueTeamId),
      client.teams.members(issueTeamId),
    ]).then(([statesRes, labelsRes, membersRes]) => {
      if (cancelled) return;
      setStates(statesRes.status === "fulfilled" ? statesRes.value.states : []);
      setLabels(labelsRes.status === "fulfilled" ? labelsRes.value.labels : []);
      setMembers(membersRes.status === "fulfilled" ? membersRes.value.members : []);
    });
    return () => {
      cancelled = true;
    };
  }, [client, issueTeamId]);

  const trimmedParentQuery = parentQuery.trim();
  // Wyszukiwanie kandydatów na zadanie nadrzędne (ten sam zespół)
  useEffect(() => {
    if (!parentPickerOpen || !issue || !trimmedParentQuery) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      client.search
        .issues(trimmedParentQuery)
        .then((res) => {
          if (cancelled) return;
          const ordered = orderPaletteSearchResults(res.issues, trimmedParentQuery).filter(
            (candidate) => candidate.teamId === issue.teamId && candidate.id !== issue.id,
          );
          setParentSearchResult({ query: trimmedParentQuery, items: ordered });
        })
        .catch(() => {
          if (!cancelled) setParentSearchResult({ query: trimmedParentQuery, items: [] });
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [parentPickerOpen, trimmedParentQuery, issue, client]);

  const parentSettled =
    parentPickerOpen && trimmedParentQuery && parentSearchResult?.query === trimmedParentQuery
      ? parentSearchResult
      : null;
  const parentSearching = Boolean(parentPickerOpen && trimmedParentQuery && !parentSettled);
  const parentCandidates = parentSettled?.items ?? [];

  const trimmedRelationQuery = relationQuery.trim();
  // Wyszukiwanie kandydatów na powiązane zadanie (wszystkie dostępne zespoły)
  useEffect(() => {
    if (!relationFormOpen || !issue || !trimmedRelationQuery) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      client.search
        .issues(trimmedRelationQuery)
        .then((res) => {
          if (cancelled) return;
          const ordered = orderPaletteSearchResults(res.issues, trimmedRelationQuery).filter(
            (candidate) => candidate.id !== issue.id,
          );
          setRelationSearchResult({ query: trimmedRelationQuery, items: ordered });
        })
        .catch(() => {
          if (!cancelled) setRelationSearchResult({ query: trimmedRelationQuery, items: [] });
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [relationFormOpen, trimmedRelationQuery, issue, client]);

  const relationSettled =
    relationFormOpen && trimmedRelationQuery && relationSearchResult?.query === trimmedRelationQuery
      ? relationSearchResult
      : null;
  const relationSearching = Boolean(relationFormOpen && trimmedRelationQuery && !relationSettled);
  const relationCandidates = relationSettled?.items ?? [];

  const memberNameByAccountId = useMemo(() => {
    const map = new Map<string, string>();
    map.set(me.account.id, me.employee.fullName);
    for (const member of members) {
      map.set(member.accountId, formatMemberName(member));
    }
    return map;
  }, [me.account.id, me.employee.fullName, members]);

  const applyPatch = useCallback(
    async (fieldName: string, patch: UpdateIssueInput, successToast?: string): Promise<boolean> => {
      if (!issue) return false;
      setSavingField(fieldName);
      setActionError(null);
      try {
        const updated = await client.issues.update(issue.id, patch);
        setIssue(updated);
        setTitleDraft(updated.title);
        setDescriptionDraft(updated.description ?? "");
        setEstimateDraft(updated.estimate !== null ? String(updated.estimate) : "");
        bumpIssuesRevision();
        if (successToast) {
          toast({ title: successToast, tone: "success" });
        }
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 403 && error.code === "PERMISSION_DENIED") {
          markTeamWriteDenied(issue.teamId);
        }
        const message = formatApiError(error, "Nie udało się zapisać zmian w zadaniu.");
        setActionError(message);
        toast({ title: "Nie udało się zapisać zmiany", description: message, tone: "danger" });
        return false;
      } finally {
        setSavingField(null);
      }
    },
    [issue, client, bumpIssuesRevision, toast, markTeamWriteDenied],
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Wczytywanie szczegółów zadania">
        <Skeleton className="h-8 w-52" />
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (effectiveLoadError || !issue) {
    return (
      <Card surface="middle" className="p-8">
        <EmptyState
          icon={<ListTodo aria-hidden />}
          title={effectiveLoadError?.status === 404 ? "Nie znaleziono zadania" : "Nie udało się otworzyć zadania"}
          description={
            effectiveLoadError?.message ?? "Zadanie mogło zostać usunięte albo nie masz uprawnień do jego odczytu."
          }
          action={
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="primary">
                <Link href={APP_PATHS.myIssues}>Moje zadania</Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href={APP_PATHS.teams}>Zespoły</Link>
              </Button>
            </div>
          }
        />
      </Card>
    );
  }

  const canWrite = canWriteTeam(issue.teamId);
  const canManage = canManageTeamById(issue.teamId);
  const teamKey = team?.key ?? issue.identifier.split("-")[0] ?? "";
  const descriptionDirty = descriptionDraft !== (issue.description ?? "");
  const overdue = isIssueOverdue(issue);

  const handleSaveTitle = async () => {
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setTitleDraft(issue.title);
      return;
    }
    if (trimmed === issue.title) return;
    if (trimmed.length > 255) {
      setActionError("Tytuł zadania może mieć najwyżej 255 znaków.");
      return;
    }
    await applyPatch("title", { title: trimmed });
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setTitleDraft(issue.title);
      event.currentTarget.blur();
    }
  };

  const handleSaveDescription = async () => {
    if (!descriptionDirty) return;
    if (descriptionDraft.length > 50_000) {
      setActionError("Opis może mieć najwyżej 50 000 znaków.");
      return;
    }
    await applyPatch(
      "description",
      { description: descriptionDraft.trim().length > 0 ? descriptionDraft : null },
      "Zapisano opis zadania",
    );
  };

  const handleDescriptionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSaveDescription();
    }
  };

  const handleSaveEstimate = async () => {
    const trimmed = estimateDraft.trim();
    if (!trimmed) {
      if (issue.estimate !== null) {
        await applyPatch("estimate", { estimate: null });
      }
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setActionError("Wycena musi być liczbą całkowitą od 0 do 100.");
      setEstimateDraft(issue.estimate !== null ? String(issue.estimate) : "");
      return;
    }
    if (parsed === issue.estimate) return;
    await applyPatch("estimate", { estimate: parsed });
  };

  const handleToggleLabel = async (labelId: string, checked: boolean) => {
    const currentIds = issue.labels.map((label) => label.id);
    const nextIds = checked ? [...new Set([...currentIds, labelId])] : currentIds.filter((id) => id !== labelId);
    await applyPatch("labels", { labelIds: nextIds });
  };

  const handleCreateSubIssue = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = subIssueTitle.trim();
    if (!trimmed) return;
    setCreatingSubIssue(true);
    setActionError(null);
    try {
      const created = await client.issues.create({
        teamId: issue.teamId,
        parentId: issue.id,
        title: trimmed,
        priority: subIssuePriority,
      });
      setSubIssueTitle("");
      setSubIssuePriority(0);
      setSubIssueFormOpen(false);
      const refreshed = await client.issues.get(issue.id);
      setIssue(refreshed);
      bumpIssuesRevision();
      toast({
        title: `Dodano podzadanie ${created.identifier}`,
        description: created.title,
        tone: "success",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && error.code === "PERMISSION_DENIED") {
        markTeamWriteDenied(issue.teamId);
      }
      setActionError(formatApiError(error, "Nie udało się utworzyć podzadania."));
    } finally {
      setCreatingSubIssue(false);
    }
  };

  const handleSelectParent = async (candidate: IssueListItem) => {
    const ok = await applyPatch(
      "parent",
      { parentId: candidate.id },
      `Ustawiono zadanie nadrzędne ${candidate.identifier}`,
    );
    if (ok) {
      setParentPickerOpen(false);
      setParentQuery("");
    }
  };

  const handleAddRelation = async (target: IssueListItem) => {
    setRelationBusy(true);
    setActionError(null);
    try {
      const created = await client.issues.addRelation(issue.id, {
        relatedIssueId: target.id,
        type: relationType,
      });
      setIssue((prev) => (prev ? { ...prev, relations: [...prev.relations, created] } : prev));
      setRelationFormOpen(false);
      setRelationQuery("");
      toast({
        title: `Dodano powiązanie z ${target.identifier}`,
        tone: "success",
      });
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się dodać powiązania."));
    } finally {
      setRelationBusy(false);
    }
  };

  const handleDeleteRelation = async (relationId: string, relatedIdentifier: string) => {
    setRelationBusy(true);
    setActionError(null);
    try {
      await client.issues.deleteRelation(issue.id, relationId);
      setIssue((prev) => (prev ? { ...prev, relations: prev.relations.filter((rel) => rel.id !== relationId) } : prev));
      toast({ title: `Usunięto powiązanie z ${relatedIdentifier}`, tone: "neutral" });
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się usunąć powiązania."));
    } finally {
      setRelationBusy(false);
    }
  };

  const handleDeleteIssue = async () => {
    setDeleting(true);
    setActionError(null);
    try {
      await client.issues.delete(issue.id);
      bumpIssuesRevision();
      toast({
        title: `Usunięto zadanie ${issue.identifier}`,
        description: issue.title,
        tone: "neutral",
      });
      router.push(teamKey ? APP_PATHS.teamIssues(teamKey) : APP_PATHS.myIssues);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && error.code === "PERMISSION_DENIED") {
        markTeamWriteDenied(issue.teamId);
      }
      setActionError(formatApiError(error, "Nie udało się usunąć zadania."));
    } finally {
      setDeleting(false);
    }
  };

  const handleCopyIdentifier = async () => {
    try {
      await navigator.clipboard.writeText(issue.identifier);
      toast({ title: `Skopiowano identyfikator ${issue.identifier}`, tone: "neutral" });
    } catch {
      toast({ title: issue.identifier, description: "Nie udało się skopiować do schowka.", tone: "warning" });
    }
  };

  const assigneeMissingFromMembers =
    Boolean(issue.assigneeAccountId) && !members.some((member) => member.accountId === issue.assigneeAccountId);

  return (
    <div className="flex flex-col gap-5">
      {/* Pasek nawigacji i akcji */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-primary pb-3">
        <nav aria-label="Ścieżka zadania" className="flex flex-wrap items-center gap-1.5 text-sm">
          <Button asChild variant="ghost" size="xs" icon={<ArrowLeft aria-hidden />}>
            <Link href={teamKey ? APP_PATHS.teamIssues(teamKey) : APP_PATHS.myIssues}>
              {team ? `${team.key} · ${team.name}` : teamKey || "Zadania"}
            </Link>
          </Button>
          <ChevronRight className="size-3.5 text-text-tertiary" aria-hidden />
          <Badge tone="accent" className="px-2 font-mono text-xs">
            {issue.identifier}
          </Badge>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label={`Kopiuj identyfikator ${issue.identifier}`}
            title="Kopiuj identyfikator"
            onClick={() => void handleCopyIdentifier()}
          >
            <Copy aria-hidden />
          </Button>
        </nav>

        {canWrite ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 aria-hidden />}
            disabled={deleting}
            className="text-danger hover:text-danger"
            onClick={() => setDeleteOpen(true)}
          >
            Usuń zadanie
          </Button>
        ) : null}
      </div>

      {actionError ? <Banner tone="danger" message={actionError} onDismiss={() => setActionError(null)} /> : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Główna kolumna treści */}
        <div className="flex min-w-0 flex-col gap-6">
          {/* Tytuł */}
          <div className="flex flex-col gap-2">
            {issue.parent ? (
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <span>Zadanie nadrzędne:</span>
                <Link
                  href={APP_PATHS.issueDetail(issue.parent.identifier)}
                  className="inline-flex items-center gap-1 font-medium text-link hover:underline"
                >
                  <span className="font-mono">{issue.parent.identifier}</span>
                  <span className="truncate">{issue.parent.title}</span>
                </Link>
              </div>
            ) : null}

            {canWrite ? (
              <input
                type="text"
                aria-label="Tytuł zadania"
                value={titleDraft}
                maxLength={255}
                disabled={savingField === "title"}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void handleSaveTitle()}
                onKeyDown={handleTitleKeyDown}
                className="w-full rounded-control border border-transparent bg-transparent px-2 py-1.5 text-2xl font-semibold text-text-primary outline-none transition-colors hover:border-border-primary focus:border-accent focus:bg-bg-tertiary/60"
              />
            ) : (
              <h1 className="px-1 text-2xl font-semibold text-text-primary">{issue.title}</h1>
            )}
          </div>

          {/* Opis */}
          <section aria-labelledby="issue-desc-heading" className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 id="issue-desc-heading" className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                Opis
              </h2>
              {savingField === "description" ? <span className="text-xs text-text-tertiary">Zapisywanie…</span> : null}
            </div>

            {canWrite ? (
              <div className="flex flex-col gap-2">
                <TextArea
                  aria-label="Opis zadania"
                  placeholder="Dodaj opis zadania…"
                  value={descriptionDraft}
                  rows={6}
                  maxLength={50_000}
                  disabled={savingField === "description"}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  onKeyDown={handleDescriptionKeyDown}
                />
                {descriptionDirty ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-text-tertiary">Naciśnij ⌘+Enter lub Ctrl+Enter, aby zapisać.</span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={savingField === "description"}
                        onClick={() => setDescriptionDraft(issue.description ?? "")}
                      >
                        Anuluj
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={savingField === "description"}
                        onClick={() => void handleSaveDescription()}
                      >
                        {savingField === "description" ? "Zapisywanie…" : "Zapisz opis"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : issue.description ? (
              <div className="rounded-card border border-border-primary bg-bg-secondary/45 p-4 text-sm leading-relaxed whitespace-pre-wrap text-text-primary">
                {issue.description}
              </div>
            ) : (
              <p className="text-sm text-text-tertiary">Brak opisu.</p>
            )}
          </section>

          <Separator />

          {/* Podzadania */}
          <section aria-labelledby="sub-issues-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 text-text-tertiary" aria-hidden />
                <h2 id="sub-issues-heading" className="text-sm font-semibold text-text-primary">
                  Podzadania
                </h2>
                <Badge tone="neutral">{issue.children.length}</Badge>
              </div>

              {canWrite ? (
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Plus aria-hidden />}
                  onClick={() => setSubIssueFormOpen((prev) => !prev)}
                >
                  Dodaj podzadanie
                </Button>
              ) : null}
            </div>

            {subIssueFormOpen && canWrite ? (
              <form
                onSubmit={(event) => void handleCreateSubIssue(event)}
                className="flex flex-col gap-3 rounded-card border border-border-primary bg-bg-secondary/60 p-3.5"
              >
                <div className="grid gap-2.5 sm:grid-cols-[1fr_10rem]">
                  <TextField
                    label="Tytuł podzadania"
                    placeholder="Np. Dodać testy walidacji formularza"
                    value={subIssueTitle}
                    maxLength={255}
                    disabled={creatingSubIssue}
                    onChange={(event) => setSubIssueTitle(event.target.value)}
                    required
                  />
                  <Select
                    label="Priorytet"
                    value={String(subIssuePriority)}
                    disabled={creatingSubIssue}
                    onChange={(event) => setSubIssuePriority(Number(event.target.value))}
                  >
                    {LINEAR_PRIORITY_OPTIONS.map((value) => (
                      <option key={value} value={String(value)}>
                        {formatPriorityLabel(value)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={creatingSubIssue}
                    onClick={() => setSubIssueFormOpen(false)}
                  >
                    Anuluj
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={creatingSubIssue || !subIssueTitle.trim()}
                  >
                    {creatingSubIssue ? "Dodawanie…" : "Utwórz podzadanie"}
                  </Button>
                </div>
              </form>
            ) : null}

            {issue.children.length === 0 ? (
              <p className="text-sm text-text-tertiary">To zadanie nie ma jeszcze podzadań.</p>
            ) : (
              <div className="flex flex-col divide-y divide-border-secondary overflow-hidden rounded-card border border-border-primary bg-bg-secondary/45">
                {issue.children.map((child) => {
                  const childAssignee = child.assigneeAccountId
                    ? (memberNameByAccountId.get(child.assigneeAccountId) ?? "Przypisana osoba")
                    : null;
                  return (
                    <div
                      key={child.id}
                      className="flex items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-row-hover"
                    >
                      <StateIcon category={child.state.category} color={child.state.color} />
                      <PriorityIcon priority={child.priority} />
                      <span className="shrink-0 font-mono text-xs text-text-tertiary">{child.identifier}</span>
                      <Link
                        href={APP_PATHS.issueDetail(child.identifier)}
                        className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary hover:text-link hover:underline"
                      >
                        {child.title}
                      </Link>
                      {childAssignee ? (
                        <Avatar
                          name={childAssignee}
                          seed={child.assigneeAccountId ?? childAssignee}
                          size="sm"
                          title={childAssignee}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <Separator />

          {/* Powiązania (relacje) */}
          <section aria-labelledby="relations-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Link2 className="size-4 text-text-tertiary" aria-hidden />
                <h2 id="relations-heading" className="text-sm font-semibold text-text-primary">
                  Powiązania
                </h2>
                <Badge tone="neutral">{issue.relations.length}</Badge>
              </div>

              {canWrite ? (
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Plus aria-hidden />}
                  onClick={() => setRelationFormOpen((prev) => !prev)}
                >
                  Dodaj powiązanie
                </Button>
              ) : null}
            </div>

            {relationFormOpen && canWrite ? (
              <div className="flex flex-col gap-3 rounded-card border border-border-primary bg-bg-secondary/60 p-3.5">
                <div className="grid gap-2.5 sm:grid-cols-[12rem_1fr]">
                  <Select
                    label="Rodzaj powiązania"
                    value={relationType}
                    disabled={relationBusy}
                    onChange={(event) => setRelationType(event.target.value as IssueRelationViewType)}
                  >
                    {ISSUE_RELATION_VIEW_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {ISSUE_RELATION_LABELS[type]}
                      </option>
                    ))}
                  </Select>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="relation-search-input" className="text-sm text-text-secondary">
                      Wyszukaj zadanie
                    </label>
                    <SearchField
                      id="relation-search-input"
                      value={relationQuery}
                      placeholder="Wpisz identyfikator (np. MAG-4) lub fragment tytułu…"
                      aria-label="Wyszukaj zadanie do powiązania"
                      onChange={(event) => setRelationQuery(event.target.value)}
                    />
                  </div>
                </div>

                {relationQuery.trim() ? (
                  <div className="flex max-h-48 flex-col divide-y divide-border-secondary overflow-y-auto rounded-row border border-border-primary bg-bg-primary/80">
                    {relationSearching ? (
                      <p className="px-3 py-2.5 text-xs text-text-tertiary">Szukanie zadań…</p>
                    ) : relationCandidates.length === 0 ? (
                      <p className="px-3 py-2.5 text-xs text-text-tertiary">Nie znaleziono pasujących zadań.</p>
                    ) : (
                      relationCandidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          disabled={relationBusy}
                          onClick={() => void handleAddRelation(candidate)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-hover disabled:opacity-50"
                        >
                          <StateIcon category={candidate.state.category} color={candidate.state.color} />
                          <span className="shrink-0 font-mono text-xs text-text-tertiary">{candidate.identifier}</span>
                          <span className="min-w-0 flex-1 truncate text-text-primary">{candidate.title}</span>
                          <span className="text-xs font-medium text-accent-strong">Wybierz</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}

                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setRelationFormOpen(false);
                      setRelationQuery("");
                    }}
                  >
                    Zamknij
                  </Button>
                </div>
              </div>
            ) : null}

            {issue.relations.length === 0 ? (
              <p className="text-sm text-text-tertiary">Brak powiązanych zadań.</p>
            ) : (
              <div className="flex flex-col divide-y divide-border-secondary overflow-hidden rounded-card border border-border-primary bg-bg-secondary/45">
                {issue.relations.map((relation) => (
                  <div
                    key={relation.id}
                    className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-row-hover"
                  >
                    <Badge
                      tone={
                        relation.type === "BLOCKS" || relation.type === "BLOCKED_BY"
                          ? "warning"
                          : relation.type === "DUPLICATE"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {ISSUE_RELATION_LABELS[relation.type]}
                    </Badge>
                    <StateIcon
                      category={relation.relatedIssue.state.category}
                      color={relation.relatedIssue.state.color}
                    />
                    <span className="shrink-0 font-mono text-xs text-text-tertiary">
                      {relation.relatedIssue.identifier}
                    </span>
                    <Link
                      href={APP_PATHS.issueDetail(relation.relatedIssue.identifier)}
                      className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary hover:text-link hover:underline"
                    >
                      {relation.relatedIssue.title}
                    </Link>
                    {canWrite ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        disabled={relationBusy}
                        aria-label={`Usuń powiązanie z ${relation.relatedIssue.identifier}`}
                        onClick={() => void handleDeleteRelation(relation.id, relation.relatedIssue.identifier)}
                      >
                        <X aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Panel boczny szczegółów */}
        <Card surface="middle" className="flex flex-col gap-4 p-4">
          <h2 className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">Szczegóły zadania</h2>

          {/* Status */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-sm text-text-secondary">
              <StateIcon category={issue.state.category} color={issue.state.color} className="size-3.5" />
              <label htmlFor="detail-state-select">Status</label>
            </div>
            {canWrite && states.length > 0 ? (
              <Select
                id="detail-state-select"
                value={issue.stateId}
                disabled={savingField === "stateId"}
                onChange={(event) => void applyPatch("stateId", { stateId: event.target.value })}
              >
                {states.map((state) => (
                  <option key={state.id} value={state.id}>
                    {state.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm font-medium text-text-primary">{issue.state.name}</p>
            )}
          </div>

          {/* Priorytet */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-sm text-text-secondary">
              <PriorityIcon priority={issue.priority} />
              <label htmlFor="detail-priority-select">Priorytet</label>
            </div>
            {canWrite ? (
              <Select
                id="detail-priority-select"
                value={String(issue.priority)}
                disabled={savingField === "priority"}
                onChange={(event) => void applyPatch("priority", { priority: Number(event.target.value) })}
              >
                {LINEAR_PRIORITY_OPTIONS.map((value) => (
                  <option key={value} value={String(value)}>
                    {formatPriorityLabel(value)}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm font-medium text-text-primary">{formatPriorityLabel(issue.priority)}</p>
            )}
          </div>

          {/* Osoba przypisana */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="detail-assignee-select" className="text-sm text-text-secondary">
              Osoba przypisana
            </label>
            {canWrite ? (
              <Select
                id="detail-assignee-select"
                value={issue.assigneeAccountId ?? ""}
                disabled={savingField === "assignee"}
                onChange={(event) =>
                  void applyPatch("assignee", {
                    assigneeAccountId: event.target.value || null,
                  })
                }
              >
                <option value="">Nieprzypisane</option>
                {assigneeMissingFromMembers && issue.assigneeAccountId ? (
                  <option value={issue.assigneeAccountId}>
                    {memberNameByAccountId.get(issue.assigneeAccountId) ?? "Przypisana osoba spoza listy"}
                  </option>
                ) : null}
                {members.map((member) => (
                  <option key={member.accountId} value={member.accountId}>
                    {formatMemberName(member)}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm font-medium text-text-primary">
                {issue.assigneeAccountId
                  ? (memberNameByAccountId.get(issue.assigneeAccountId) ?? "Przypisana osoba")
                  : "Nieprzypisane"}
              </p>
            )}
          </div>

          {/* Etykiety (wiele) */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text-secondary">Etykiety</span>
              {canWrite && labels.length > 0 ? (
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="xs" icon={<Tag aria-hidden />} disabled={savingField === "labels"}>
                      Zmień
                    </Button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuLabel>Etykiety zespołu</MenuLabel>
                    {labels.map((label) => {
                      const isChecked = issue.labels.some((item) => item.id === label.id);
                      return (
                        <MenuCheckboxItem
                          key={label.id}
                          checked={isChecked}
                          onCheckedChange={(checked) => void handleToggleLabel(label.id, checked === true)}
                        >
                          <span className="inline-flex items-center gap-2">
                            <ColorDot color={label.color} />
                            <span>{label.name}</span>
                          </span>
                        </MenuCheckboxItem>
                      );
                    })}
                  </MenuContent>
                </Menu>
              ) : null}
            </div>

            {issue.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {issue.labels.map((label) => (
                  <LabelPill key={label.id} label={label} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-tertiary">
                Brak etykiet.
                {labels.length === 0 && canManage && teamKey ? (
                  <>
                    {" "}
                    <Link href={APP_PATHS.teamSettings(teamKey)} className="text-link hover:underline">
                      Dodaj w ustawieniach zespołu
                    </Link>
                  </>
                ) : null}
              </p>
            )}
          </div>

          {/* Termin */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="detail-due-date" className="text-sm text-text-secondary">
                Termin
              </label>
              {canWrite && issue.dueDate ? (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={savingField === "dueDate"}
                  onClick={() => void applyPatch("dueDate", { dueDate: null })}
                >
                  Wyczyść
                </Button>
              ) : null}
            </div>
            {canWrite ? (
              <TextField
                id="detail-due-date"
                type="date"
                value={issue.dueDate ?? ""}
                disabled={savingField === "dueDate"}
                onChange={(event) => void applyPatch("dueDate", { dueDate: event.target.value || null })}
              />
            ) : (
              <p className={cn("text-sm font-medium", overdue ? "text-danger" : "text-text-primary")}>
                {issue.dueDate ?? "Brak terminu"}
              </p>
            )}
            {overdue ? <p className="text-xs text-danger">Termin realizacji już minął.</p> : null}
          </div>

          {/* Wycena */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="detail-estimate" className="text-sm text-text-secondary">
                Wycena (od 0 do 100)
              </label>
              {canWrite && issue.estimate !== null ? (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={savingField === "estimate"}
                  onClick={() => void applyPatch("estimate", { estimate: null })}
                >
                  Wyczyść
                </Button>
              ) : null}
            </div>
            {canWrite ? (
              <TextField
                id="detail-estimate"
                type="number"
                min={0}
                max={100}
                step={1}
                placeholder="Brak"
                value={estimateDraft}
                disabled={savingField === "estimate"}
                onChange={(event) => setEstimateDraft(event.target.value)}
                onBlur={() => void handleSaveEstimate()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <p className="text-sm font-medium text-text-primary">
                {issue.estimate !== null ? String(issue.estimate) : "Brak"}
              </p>
            )}
          </div>

          {/* Zadanie nadrzędne */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text-secondary">Zadanie nadrzędne</span>
              {canWrite ? (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="xs" onClick={() => setParentPickerOpen((prev) => !prev)}>
                    {issue.parent ? "Zmień" : "Ustaw"}
                  </Button>
                  {issue.parent ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={savingField === "parent"}
                      onClick={() => void applyPatch("parent", { parentId: null }, "Odpięto zadanie nadrzędne")}
                    >
                      Odepnij
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {issue.parent ? (
              <Link
                href={APP_PATHS.issueDetail(issue.parent.identifier)}
                className="flex items-center gap-2 rounded-row border border-border-primary bg-bg-tertiary/60 px-2.5 py-2 text-xs transition-colors hover:bg-bg-hover"
              >
                <StateIcon
                  category={issue.parent.state.category}
                  color={issue.parent.state.color}
                  className="size-3.5"
                />
                <span className="shrink-0 font-mono text-text-tertiary">{issue.parent.identifier}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{issue.parent.title}</span>
              </Link>
            ) : (
              <p className="text-xs text-text-tertiary">Brak zadania nadrzędnego.</p>
            )}

            {parentPickerOpen && canWrite ? (
              <div className="flex flex-col gap-2 rounded-row border border-border-primary bg-bg-secondary p-2.5">
                <SearchField
                  value={parentQuery}
                  placeholder="Szukaj w tym zespole…"
                  aria-label="Szukaj zadania nadrzędnego"
                  onChange={(event) => setParentQuery(event.target.value)}
                />
                {parentQuery.trim() ? (
                  <div className="flex max-h-40 flex-col divide-y divide-border-secondary overflow-y-auto rounded-control border border-border-secondary bg-bg-primary/80">
                    {parentSearching ? (
                      <p className="px-2.5 py-2 text-xs text-text-tertiary">Szukanie…</p>
                    ) : parentCandidates.length === 0 ? (
                      <p className="px-2.5 py-2 text-xs text-text-tertiary">Brak pasujących zadań w tym zespole.</p>
                    ) : (
                      parentCandidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          disabled={savingField === "parent"}
                          onClick={() => void handleSelectParent(candidate)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-bg-hover"
                        >
                          <span className="shrink-0 font-mono text-text-tertiary">{candidate.identifier}</span>
                          <span className="min-w-0 flex-1 truncate text-text-primary">{candidate.title}</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <Separator />

          {/* Znaczniki czasu */}
          <dl className="flex flex-col gap-1.5 text-xs text-text-tertiary">
            <div className="flex justify-between gap-2">
              <dt>Utworzono</dt>
              <dd className="text-text-secondary tabular-nums">{formatDateTime(issue.createdAt)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Zmieniono</dt>
              <dd className="text-text-secondary tabular-nums">{formatDateTime(issue.updatedAt)}</dd>
            </div>
            {issue.startedAt ? (
              <div className="flex justify-between gap-2">
                <dt>Rozpoczęto</dt>
                <dd className="text-text-secondary tabular-nums">{formatDateTime(issue.startedAt)}</dd>
              </div>
            ) : null}
            {issue.completedAt ? (
              <div className="flex justify-between gap-2">
                <dt>Zakończono</dt>
                <dd className="text-text-secondary tabular-nums">{formatDateTime(issue.completedAt)}</dd>
              </div>
            ) : null}
            {issue.canceledAt ? (
              <div className="flex justify-between gap-2">
                <dt>Anulowano</dt>
                <dd className="text-text-secondary tabular-nums">{formatDateTime(issue.canceledAt)}</dd>
              </div>
            ) : null}
          </dl>
        </Card>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Usunąć zadanie ${issue.identifier}?`}
        description="Zadanie zniknie z listy i tablicy zespołu. Jeśli ma podzadania, zostaną one odpięte i pozostaną samodzielnymi zadaniami."
        confirmLabel="Usuń zadanie"
        danger
        onConfirm={() => void handleDeleteIssue()}
      />
    </div>
  );
}
