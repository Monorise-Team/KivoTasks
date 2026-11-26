"use client";

import {
  ApiError,
  WORKFLOW_STATE_CATEGORIES,
  type ColorToken,
  type Label,
  type WorkflowState,
  type WorkflowStateCategory,
} from "@kivotasks/client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Select,
  SettingSection,
  SettingsLayout,
  Skeleton,
  TextField,
  useToast,
} from "@monorise-team/ui";
import { ArrowDown, ArrowUp, CircleDot, KeyRound, Pencil, Plus, Tag, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { APP_PATHS, findTeamByKey, formatApiError, isValidTeamKey, normalizeTeamKeyInput } from "../app-views";
import { WORKFLOW_CATEGORY_LABELS, computeStateReorderUpdates } from "../issue-ui";
import { useKivoTasks } from "../KivoTasksContext";
import { ColorPicker, LabelPill, StateIcon, TeamHeader } from "./IssueBadges";

type SettingsTabId = "general" | "states" | "labels";

export function TeamSettingsView({ teamKey }: { teamKey: string }) {
  const { teams, teamsLoading } = useKivoTasks();
  const team = useMemo(() => findTeamByKey(teams, teamKey), [teams, teamKey]);

  if (teamsLoading && !team) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Wczytywanie ustawień zespołu">
        <Skeleton className="h-10 w-72" />
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

  return <TeamSettingsBody key={`${team.id}:${team.key}`} team={team} />;
}

function TeamSettingsBody({ team }: { team: NonNullable<ReturnType<typeof findTeamByKey>> }) {
  const router = useRouter();
  const { toast } = useToast();
  const {
    client,
    canWriteTeam,
    canManageTeamById,
    markTeamManageDenied,
    upsertTeam,
    openCreateIssue,
    bumpIssuesRevision,
  } = useKivoTasks();

  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");

  // Team key form
  const [teamKeyInput, setTeamKeyInput] = useState(team.key);
  const [teamKeyError, setTeamKeyError] = useState<string | null>(null);
  const [teamKeySubmitError, setTeamKeySubmitError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);

  // Workflow states
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [loadedTeamId, setLoadedTeamId] = useState<string | null>(null);
  const [statesError, setStatesError] = useState<string | null>(null);
  const [stateBusyId, setStateBusyId] = useState<string | null>(null);

  const [editingStateId, setEditingStateId] = useState<string | null>(null);
  const [editStateName, setEditStateName] = useState("");
  const [editStateCategory, setEditStateCategory] = useState<WorkflowStateCategory>("STARTED");
  const [editStateColor, setEditStateColor] = useState<ColorToken>("blue");

  const [newStateName, setNewStateName] = useState("");
  const [newStateCategory, setNewStateCategory] = useState<WorkflowStateCategory>("STARTED");
  const [newStateColor, setNewStateColor] = useState<ColorToken>("blue");
  const [addingState, setAddingState] = useState(false);
  const [archiveStateTarget, setArchiveStateTarget] = useState<WorkflowState | null>(null);

  // Labels
  const [labels, setLabels] = useState<Label[]>([]);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [labelBusyId, setLabelBusyId] = useState<string | null>(null);

  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editLabelName, setEditLabelName] = useState("");
  const [editLabelColor, setEditLabelColor] = useState<ColorToken>("blue");

  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState<ColorToken>("blue");
  const [addingLabel, setAddingLabel] = useState(false);
  const [archiveLabelTarget, setArchiveLabelTarget] = useState<Label | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([client.states.list(team.id), client.labels.list(team.id)]).then(([statesRes, labelsRes]) => {
      if (cancelled) return;
      if (statesRes.status === "fulfilled") {
        setStates(statesRes.value.states);
        setStatesError(null);
      } else {
        setStatesError(formatApiError(statesRes.reason, "Nie udało się pobrać statusów obiegu."));
      }

      if (labelsRes.status === "fulfilled") {
        setLabels(labelsRes.value.labels);
        setLabelsError(null);
      } else {
        setLabelsError(formatApiError(labelsRes.reason, "Nie udało się pobrać etykiet zespołu."));
      }
      setLoadedTeamId(team.id);
    });
    return () => {
      cancelled = true;
    };
  }, [client, team.id]);

  const statesLoading = loadedTeamId !== team.id;
  const labelsLoading = loadedTeamId !== team.id;

  const canWrite = canWriteTeam(team.id);
  const canManage = canManageTeamById(team.id);

  if (!canManage) {
    return (
      <div className="flex flex-col gap-5">
        <TeamHeader
          team={team}
          activeTab="settings"
          canWrite={canWrite}
          canManage={false}
          onNewIssue={() => openCreateIssue({ teamId: team.id })}
        />
        <Banner
          tone="warning"
          message="Nie masz uprawnień do zarządzania ustawieniami tego zespołu. Wymagane jest uprawnienie zarządzania zespołami."
        />
        <div>
          <Button asChild variant="secondary">
            <Link href={APP_PATHS.teamIssues(team.key)}>Wróć do zadań zespołu</Link>
          </Button>
        </div>
      </div>
    );
  }

  const handlePermissionError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 403 && error.code === "PERMISSION_DENIED") {
      markTeamManageDenied(team.id);
    }
  };

  // ── Klucz zespołu ──────────────────────────────────────────────────────────

  const handleSaveTeamKey = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeTeamKeyInput(teamKeyInput);
    if (!isValidTeamKey(normalized)) {
      setTeamKeyError("Klucz zespołu musi składać się z 2 do 5 wielkich liter A-Z.");
      return;
    }
    if (normalized === team.key) {
      return;
    }

    setTeamKeyError(null);
    setTeamKeySubmitError(null);
    setSavingKey(true);
    try {
      const updated = await client.teams.update(team.id, { key: normalized });
      upsertTeam(updated);
      bumpIssuesRevision();
      toast({
        title: `Zmieniono klucz zespołu na ${updated.key}`,
        description: "Identyfikatory wszystkich zadań w zespole zostały zaktualizowane.",
        tone: "success",
      });
      router.replace(APP_PATHS.teamSettings(updated.key));
    } catch (error) {
      handlePermissionError(error);
      setTeamKeySubmitError(formatApiError(error, "Nie udało się zmienić klucza zespołu."));
    } finally {
      setSavingKey(false);
    }
  };

  // ── Statusy obiegu ─────────────────────────────────────────────────────────

  const orderedStates = [...states].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));

  const startEditState = (state: WorkflowState) => {
    setEditingStateId(state.id);
    setEditStateName(state.name);
    setEditStateCategory(state.category);
    setEditStateColor(state.color);
    setStatesError(null);
  };

  const handleSaveStateEdit = async (event: FormEvent, stateId: string) => {
    event.preventDefault();
    const trimmed = editStateName.trim();
    if (!trimmed || trimmed.length > 40) {
      setStatesError("Nazwa statusu musi mieć od 1 do 40 znaków.");
      return;
    }
    setStateBusyId(stateId);
    setStatesError(null);
    try {
      const updated = await client.states.update(team.id, stateId, {
        name: trimmed,
        category: editStateCategory,
        color: editStateColor,
      });
      setStates((prev) => prev.map((item) => (item.id === stateId ? updated : item)));
      setEditingStateId(null);
      bumpIssuesRevision();
      toast({ title: `Zapisano status „${updated.name}”`, tone: "success" });
    } catch (error) {
      handlePermissionError(error);
      setStatesError(formatApiError(error, "Nie udało się zaktualizować statusu."));
    } finally {
      setStateBusyId(null);
    }
  };

  const handleReorderState = async (stateId: string, direction: "up" | "down") => {
    const updates = computeStateReorderUpdates(orderedStates, stateId, direction);
    if (updates.length === 0) return;

    setStateBusyId(stateId);
    setStatesError(null);
    try {
      const updatedById = new Map<string, WorkflowState>();
      for (const update of updates) {
        const res = await client.states.update(team.id, update.stateId, { position: update.position });
        updatedById.set(res.id, res);
      }
      setStates((prev) => prev.map((item) => updatedById.get(item.id) ?? item));
      bumpIssuesRevision();
    } catch (error) {
      handlePermissionError(error);
      setStatesError(formatApiError(error, "Nie udało się zmienić kolejności statusów."));
    } finally {
      setStateBusyId(null);
    }
  };

  const handleAddState = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newStateName.trim();
    if (!trimmed || trimmed.length > 40) {
      setStatesError("Nazwa statusu musi mieć od 1 do 40 znaków.");
      return;
    }
    setAddingState(true);
    setStatesError(null);
    try {
      const created = await client.states.create(team.id, {
        name: trimmed,
        category: newStateCategory,
        color: newStateColor,
      });
      setStates((prev) => [...prev, created]);
      setNewStateName("");
      bumpIssuesRevision();
      toast({ title: `Dodano status „${created.name}”`, tone: "success" });
    } catch (error) {
      handlePermissionError(error);
      setStatesError(formatApiError(error, "Nie udało się dodać statusu."));
    } finally {
      setAddingState(false);
    }
  };

  const handleConfirmArchiveState = async () => {
    if (!archiveStateTarget) return;
    const target = archiveStateTarget;
    setStateBusyId(target.id);
    setStatesError(null);
    try {
      await client.states.delete(team.id, target.id);
      setStates((prev) => prev.filter((item) => item.id !== target.id));
      if (editingStateId === target.id) setEditingStateId(null);
      bumpIssuesRevision();
      toast({ title: `Zarchiwizowano status „${target.name}”`, tone: "success" });
    } catch (error) {
      handlePermissionError(error);
      const message = formatApiError(error, "Nie udało się zarchiwizować statusu.");
      setStatesError(message);
      toast({ title: "Nie udało się zarchiwizować statusu", description: message, tone: "danger" });
    } finally {
      setStateBusyId(null);
      setArchiveStateTarget(null);
    }
  };

  // ── Etykiety ───────────────────────────────────────────────────────────────

  const startEditLabel = (label: Label) => {
    setEditingLabelId(label.id);
    setEditLabelName(label.name);
    setEditLabelColor(label.color);
    setLabelsError(null);
  };

  const handleSaveLabelEdit = async (event: FormEvent, labelId: string) => {
    event.preventDefault();
    const trimmed = editLabelName.trim();
    if (!trimmed || trimmed.length > 40) {
      setLabelsError("Nazwa etykiety musi mieć od 1 do 40 znaków.");
      return;
    }
    setLabelBusyId(labelId);
    setLabelsError(null);
    try {
      const updated = await client.labels.update(team.id, labelId, {
        name: trimmed,
        color: editLabelColor,
      });
      setLabels((prev) =>
        prev.map((item) => (item.id === labelId ? updated : item)).sort((a, b) => a.name.localeCompare(b.name, "pl")),
      );
      setEditingLabelId(null);
      bumpIssuesRevision();
      toast({ title: `Zapisano etykietę „${updated.name}”`, tone: "success" });
    } catch (error) {
      handlePermissionError(error);
      setLabelsError(formatApiError(error, "Nie udało się zaktualizować etykiety."));
    } finally {
      setLabelBusyId(null);
    }
  };

  const handleAddLabel = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newLabelName.trim();
    if (!trimmed || trimmed.length > 40) {
      setLabelsError("Nazwa etykiety musi mieć od 1 do 40 znaków.");
      return;
    }
    setAddingLabel(true);
    setLabelsError(null);
    try {
      const created = await client.labels.create(team.id, {
        name: trimmed,
        color: newLabelColor,
      });
      setLabels((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, "pl")));
      setNewLabelName("");
      bumpIssuesRevision();
      toast({ title: `Dodano etykietę „${created.name}”`, tone: "success" });
    } catch (error) {
      handlePermissionError(error);
      setLabelsError(formatApiError(error, "Nie udało się dodać etykiety."));
    } finally {
      setAddingLabel(false);
    }
  };

  const handleConfirmArchiveLabel = async () => {
    if (!archiveLabelTarget) return;
    const target = archiveLabelTarget;
    setLabelBusyId(target.id);
    setLabelsError(null);
    try {
      await client.labels.delete(team.id, target.id);
      setLabels((prev) => prev.filter((item) => item.id !== target.id));
      if (editingLabelId === target.id) setEditingLabelId(null);
      bumpIssuesRevision();
      toast({ title: `Zarchiwizowano etykietę „${target.name}”`, tone: "success" });
    } catch (error) {
      handlePermissionError(error);
      const message = formatApiError(error, "Nie udało się zarchiwizować etykiety.");
      setLabelsError(message);
      toast({ title: "Nie udało się zarchiwizować etykiety", description: message, tone: "danger" });
    } finally {
      setLabelBusyId(null);
      setArchiveLabelTarget(null);
    }
  };

  const navItems = [
    { id: "general", label: "Ogólne", icon: <KeyRound aria-hidden /> },
    { id: "states", label: "Statusy obiegu", icon: <CircleDot aria-hidden /> },
    { id: "labels", label: "Etykiety", icon: <Tag aria-hidden /> },
  ];

  return (
    <div className="flex flex-col gap-5">
      <TeamHeader
        team={team}
        activeTab="settings"
        canWrite={canWrite}
        canManage={canManage}
        onNewIssue={() => openCreateIssue({ teamId: team.id })}
      />

      <SettingsLayout
        title={`Ustawienia zespołu ${team.name}`}
        surface="middle"
        items={navItems}
        activeId={activeTab}
        onActiveChange={(id) => setActiveTab(id as SettingsTabId)}
        navLabel="Sekcje ustawień zespołu"
      >
        {activeTab === "general" ? (
          <SettingSection
            title="Klucz zespołu"
            description="Klucz służy do tworzenia identyfikatorów zadań (np. MAG-1). Zmiana klucza natychmiast aktualizuje identyfikatory wszystkich zadań tego zespołu."
          >
            {teamKeySubmitError ? <Banner tone="danger" message={teamKeySubmitError} /> : null}
            <form onSubmit={(event) => void handleSaveTeamKey(event)} className="flex max-w-md flex-col gap-4">
              <TextField
                label="Klucz zespołu"
                value={teamKeyInput}
                maxLength={5}
                error={teamKeyError}
                hint="Od 2 do 5 wielkich liter A-Z."
                disabled={savingKey}
                onChange={(event) => {
                  setTeamKeyInput(normalizeTeamKeyInput(event.target.value));
                  setTeamKeyError(null);
                  setTeamKeySubmitError(null);
                }}
              />
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  disabled={savingKey || normalizeTeamKeyInput(teamKeyInput) === team.key}
                >
                  {savingKey ? "Zapisywanie…" : "Zapisz klucz"}
                </Button>
              </div>
            </form>
          </SettingSection>
        ) : activeTab === "states" ? (
          <>
            <SettingSection
              title="Aktywne statusy obiegu"
              description="Kolejność statusów określa układ kolumn na tablicy. Zespół musi zawsze zachować co najmniej jeden status w kategorii Backlog lub Do zrobienia."
            >
              {statesError ? (
                <Banner tone="danger" message={statesError} onDismiss={() => setStatesError(null)} />
              ) : null}

              {statesLoading ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {orderedStates.map((state, index) => {
                    const isEditing = editingStateId === state.id;
                    const busyRow = stateBusyId === state.id;

                    if (isEditing) {
                      return (
                        <form
                          key={state.id}
                          onSubmit={(event) => void handleSaveStateEdit(event, state.id)}
                          className="flex flex-col gap-3 rounded-row border border-accent/50 bg-bg-secondary p-4"
                        >
                          <div className="grid gap-3 sm:grid-cols-2">
                            <TextField
                              label="Nazwa statusu"
                              value={editStateName}
                              maxLength={40}
                              disabled={busyRow}
                              onChange={(event) => setEditStateName(event.target.value)}
                              required
                            />
                            <Select
                              label="Kategoria"
                              value={editStateCategory}
                              disabled={busyRow}
                              onChange={(event) => setEditStateCategory(event.target.value as WorkflowStateCategory)}
                            >
                              {WORKFLOW_STATE_CATEGORIES.map((category) => (
                                <option key={category} value={category}>
                                  {WORKFLOW_CATEGORY_LABELS[category]}
                                </option>
                              ))}
                            </Select>
                          </div>

                          <div className="flex flex-col gap-1.5">
                            <span className="text-sm text-text-secondary">Kolor</span>
                            <ColorPicker
                              value={editStateColor}
                              onChange={setEditStateColor}
                              disabled={busyRow}
                              ariaLabel={`Kolor statusu ${state.name}`}
                            />
                          </div>

                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={busyRow}
                              onClick={() => setEditingStateId(null)}
                            >
                              Anuluj
                            </Button>
                            <Button type="submit" variant="primary" size="sm" disabled={busyRow}>
                              {busyRow ? "Zapisywanie…" : "Zapisz"}
                            </Button>
                          </div>
                        </form>
                      );
                    }

                    return (
                      <div
                        key={state.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-row border border-border-primary bg-bg-secondary/60 px-3.5 py-2.5"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <StateIcon category={state.category} color={state.color} />
                          <span className="truncate text-sm font-medium text-text-primary">{state.name}</span>
                          <Badge tone="neutral">{WORKFLOW_CATEGORY_LABELS[state.category]}</Badge>
                        </div>

                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            iconOnly
                            aria-label={`Przesuń status ${state.name} wyżej`}
                            disabled={busyRow || index === 0}
                            onClick={() => void handleReorderState(state.id, "up")}
                          >
                            <ArrowUp aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            iconOnly
                            aria-label={`Przesuń status ${state.name} niżej`}
                            disabled={busyRow || index === orderedStates.length - 1}
                            onClick={() => void handleReorderState(state.id, "down")}
                          >
                            <ArrowDown aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            icon={<Pencil aria-hidden />}
                            disabled={busyRow}
                            onClick={() => startEditState(state)}
                          >
                            Edytuj
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            icon={<Trash2 aria-hidden />}
                            disabled={busyRow}
                            onClick={() => setArchiveStateTarget(state)}
                          >
                            Archiwizuj
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SettingSection>

            <SettingSection title="Dodaj nowy status" description="Nowy status pojawi się na końcu tablicy zespołu.">
              <form
                onSubmit={(event) => void handleAddState(event)}
                className="flex flex-col gap-3 rounded-row border border-border-primary bg-bg-secondary/50 p-4"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField
                    label="Nazwa statusu"
                    placeholder="Np. W testach"
                    value={newStateName}
                    maxLength={40}
                    disabled={addingState}
                    onChange={(event) => setNewStateName(event.target.value)}
                    required
                  />
                  <Select
                    label="Kategoria"
                    value={newStateCategory}
                    disabled={addingState}
                    onChange={(event) => setNewStateCategory(event.target.value as WorkflowStateCategory)}
                  >
                    {WORKFLOW_STATE_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {WORKFLOW_CATEGORY_LABELS[category]}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-text-secondary">Kolor</span>
                  <ColorPicker
                    value={newStateColor}
                    onChange={setNewStateColor}
                    disabled={addingState}
                    ariaLabel="Kolor nowego statusu"
                  />
                </div>

                <div>
                  <Button type="submit" variant="primary" size="sm" icon={<Plus aria-hidden />} disabled={addingState}>
                    {addingState ? "Dodawanie…" : "Dodaj status"}
                  </Button>
                </div>
              </form>
            </SettingSection>
          </>
        ) : (
          <>
            <SettingSection
              title="Etykiety zespołu"
              description="Etykiety pozwalają porządkować i filtrować zadania w obrębie zespołu."
            >
              {labelsError ? (
                <Banner tone="danger" message={labelsError} onDismiss={() => setLabelsError(null)} />
              ) : null}

              {labelsLoading ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                  <Skeleton className="h-11 w-full" />
                  <Skeleton className="h-11 w-full" />
                </div>
              ) : labels.length === 0 ? (
                <p className="text-sm text-text-secondary">Ten zespół nie ma jeszcze żadnych etykiet.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {labels.map((label) => {
                    const isEditing = editingLabelId === label.id;
                    const busyRow = labelBusyId === label.id;

                    if (isEditing) {
                      return (
                        <form
                          key={label.id}
                          onSubmit={(event) => void handleSaveLabelEdit(event, label.id)}
                          className="flex flex-col gap-3 rounded-row border border-accent/50 bg-bg-secondary p-4"
                        >
                          <TextField
                            label="Nazwa etykiety"
                            value={editLabelName}
                            maxLength={40}
                            disabled={busyRow}
                            onChange={(event) => setEditLabelName(event.target.value)}
                            required
                          />
                          <div className="flex flex-col gap-1.5">
                            <span className="text-sm text-text-secondary">Kolor</span>
                            <ColorPicker
                              value={editLabelColor}
                              onChange={setEditLabelColor}
                              disabled={busyRow}
                              ariaLabel={`Kolor etykiety ${label.name}`}
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={busyRow}
                              onClick={() => setEditingLabelId(null)}
                            >
                              Anuluj
                            </Button>
                            <Button type="submit" variant="primary" size="sm" disabled={busyRow}>
                              {busyRow ? "Zapisywanie…" : "Zapisz"}
                            </Button>
                          </div>
                        </form>
                      );
                    }

                    return (
                      <div
                        key={label.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-row border border-border-primary bg-bg-secondary/60 px-3.5 py-2.5"
                      >
                        <LabelPill label={label} />
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            icon={<Pencil aria-hidden />}
                            disabled={busyRow}
                            onClick={() => startEditLabel(label)}
                          >
                            Edytuj
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            icon={<Trash2 aria-hidden />}
                            disabled={busyRow}
                            onClick={() => setArchiveLabelTarget(label)}
                          >
                            Archiwizuj
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SettingSection>

            <SettingSection title="Dodaj etykietę" description="Nazwy etykiet są unikalne w obrębie zespołu.">
              <form
                onSubmit={(event) => void handleAddLabel(event)}
                className="flex flex-col gap-3 rounded-row border border-border-primary bg-bg-secondary/50 p-4"
              >
                <TextField
                  label="Nazwa etykiety"
                  placeholder="Np. Błąd, Pilne, Magazyn"
                  value={newLabelName}
                  maxLength={40}
                  disabled={addingLabel}
                  onChange={(event) => setNewLabelName(event.target.value)}
                  required
                />
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-text-secondary">Kolor</span>
                  <ColorPicker
                    value={newLabelColor}
                    onChange={setNewLabelColor}
                    disabled={addingLabel}
                    ariaLabel="Kolor nowej etykiety"
                  />
                </div>
                <div>
                  <Button type="submit" variant="primary" size="sm" icon={<Plus aria-hidden />} disabled={addingLabel}>
                    {addingLabel ? "Dodawanie…" : "Dodaj etykietę"}
                  </Button>
                </div>
              </form>
            </SettingSection>
          </>
        )}
      </SettingsLayout>

      <ConfirmDialog
        open={archiveStateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveStateTarget(null);
        }}
        title={archiveStateTarget ? `Zarchiwizować status „${archiveStateTarget.name}”?` : "Zarchiwizować status?"}
        description="Status przestanie być dostępny przy tworzeniu i edycji zadań. Jeśli używają go aktywne zadania lub jest to ostatni status początkowy, operacja zostanie zablokowana."
        confirmLabel="Archiwizuj"
        danger
        onConfirm={() => void handleConfirmArchiveState()}
      />

      <ConfirmDialog
        open={archiveLabelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveLabelTarget(null);
        }}
        title={archiveLabelTarget ? `Zarchiwizować etykietę „${archiveLabelTarget.name}”?` : "Zarchiwizować etykietę?"}
        description="Etykieta zostanie odpięta od wszystkich zadań w zespole i zniknie z listy dostępnych etykiet."
        confirmLabel="Archiwizuj"
        danger
        onConfirm={() => void handleConfirmArchiveLabel()}
      />
    </div>
  );
}
