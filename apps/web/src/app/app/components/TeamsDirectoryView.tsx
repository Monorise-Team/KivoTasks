"use client";

import type { TeamCandidate } from "@kivotasks/client";
import {
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  EmptyState,
  Select,
  Skeleton,
  TextField,
  useToast,
} from "@monorise-team/ui";
import { Kanban, ListTodo, Plus, RefreshCw, Settings, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { APP_PATHS, formatApiError, isValidTeamKey, normalizeTeamKeyInput, suggestTeamKey } from "../app-views";
import { CORE_UNIT_TYPE_LABELS } from "../issue-ui";
import { useKivoTasks } from "../KivoTasksContext";

export function TeamsDirectoryView() {
  const { teams, teamsLoading, teamsError, canCreateTeam, canManageTeamById, reloadTeams } = useKivoTasks();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-primary pb-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text-primary">Zespoły</h1>
          <p className="text-sm text-text-secondary">
            Zespoły KivoTasks korzystają z jednostek organizacyjnych firmy w MonoriseCore i mają własne statusy oraz
            etykiety.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw aria-hidden />}
            disabled={teamsLoading}
            onClick={() => void reloadTeams()}
          >
            {teamsLoading ? "Odświeżanie…" : "Odśwież"}
          </Button>
          {canCreateTeam ? (
            <Button variant="primary" size="sm" icon={<Plus aria-hidden />} onClick={() => setCreateOpen(true)}>
              Utwórz zespół
            </Button>
          ) : null}
        </div>
      </div>

      {teamsError ? <Banner tone="danger" message={teamsError} /> : null}

      {teamsLoading && teams.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Wczytywanie zespołów">
          {[0, 1, 2, 3].map((idx) => (
            <Card key={idx} surface="middle" className="flex flex-col gap-3 p-5">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-8 w-full" />
            </Card>
          ))}
        </div>
      ) : teams.length === 0 ? (
        <Card surface="middle" className="p-8">
          <EmptyState
            icon={<Users aria-hidden />}
            title="Brak zespołów w KivoTasks"
            description={
              canCreateTeam
                ? "Utwórz pierwszy zespół na podstawie aktywnej jednostki organizacyjnej firmy, aby rozpocząć pracę z zadaniami."
                : "Nie masz jeszcze dostępu do żadnego zespołu. Poproś administratora firmy o utworzenie zespołu lub nadanie uprawnień."
            }
            action={
              canCreateTeam ? (
                <Button variant="primary" size="md" icon={<Plus aria-hidden />} onClick={() => setCreateOpen(true)}>
                  Utwórz zespół
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {teams.map((team) => {
            const canManage = canManageTeamById(team.id);
            return (
              <Card key={team.id} surface="middle" className="flex flex-col justify-between gap-4 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge tone="accent" className="px-2 font-mono text-xs">
                        {team.key}
                      </Badge>
                    </div>
                    <h2 className="truncate text-base font-semibold text-text-primary">
                      <Link href={APP_PATHS.teamIssues(team.key)} className="hover:underline">
                        {team.name}
                      </Link>
                    </h2>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-border-secondary pt-3">
                  <Button asChild variant="secondary" size="sm" icon={<ListTodo aria-hidden />}>
                    <Link href={APP_PATHS.teamIssues(team.key)}>Lista</Link>
                  </Button>
                  <Button asChild variant="secondary" size="sm" icon={<Kanban aria-hidden />}>
                    <Link href={APP_PATHS.teamBoard(team.key)}>Tablica</Link>
                  </Button>
                  {canManage ? (
                    <Button asChild variant="ghost" size="sm" icon={<Settings aria-hidden />}>
                      <Link href={APP_PATHS.teamSettings(team.key)}>Ustawienia</Link>
                    </Button>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Utwórz zespół"
        description="Wybierz aktywną jednostkę organizacyjną z MonoriseCore i przypisz jej krótki klucz do numeracji zadań."
        className="max-w-md"
      >
        {createOpen && canCreateTeam ? <CreateTeamForm onClose={() => setCreateOpen(false)} /> : null}
      </Dialog>
    </div>
  );
}

function CreateTeamForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const { client, upsertTeam } = useKivoTasks();

  const [candidatesState, setCandidatesState] = useState<{
    readonly candidates: readonly TeamCandidate[];
    readonly error: string | null;
  } | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client.teams
      .candidates()
      .then((result) => {
        if (cancelled) return;
        setCandidatesState({ candidates: result.candidates, error: null });
        const first = result.candidates[0];
        if (first) {
          setSelectedUnitId(first.id);
          setKeyInput(suggestTeamKey(first.name));
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCandidatesState({
          candidates: [],
          error: formatApiError(error, "Nie udało się pobrać listy jednostek organizacyjnych z Core."),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!candidatesState) {
    return (
      <div className="flex flex-col gap-3 py-2" aria-busy="true" aria-label="Wczytywanie jednostek organizacyjnych">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (candidatesState.error) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="danger" message={candidatesState.error} />
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Zamknij
          </Button>
        </div>
      </div>
    );
  }

  if (candidatesState.candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <Banner
          tone="neutral"
          message="Wszystkie aktywne jednostki organizacyjne firmy są już zespołami w KivoTasks. Nową jednostkę można dodać w panelu firmy Monorise."
        />
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Zamknij
          </Button>
        </div>
      </div>
    );
  }

  const handleUnitChange = (unitId: string) => {
    setSelectedUnitId(unitId);
    setSubmitError(null);
    if (!keyTouched) {
      const unit = candidatesState.candidates.find((item) => item.id === unitId);
      setKeyInput(unit ? suggestTeamKey(unit.name) : "");
    }
  };

  const handleKeyChange = (raw: string) => {
    setKeyTouched(true);
    setKeyInput(normalizeTeamKeyInput(raw));
    if (keyError) setKeyError(null);
    if (submitError) setSubmitError(null);
  };

  const handleCreateTeam = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedUnitId) {
      setSubmitError("Wybierz jednostkę organizacyjną z listy.");
      return;
    }
    const normalizedKey = normalizeTeamKeyInput(keyInput);
    if (!isValidTeamKey(normalizedKey)) {
      setKeyError("Klucz zespołu musi mieć od 2 do 5 wielkich liter A-Z.");
      return;
    }

    setKeyError(null);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const created = await client.teams.create({
        unitId: selectedUnitId,
        key: normalizedKey,
      });
      upsertTeam(created);
      onClose();
      toast({
        title: `Utworzono zespół ${created.key}`,
        description: created.name,
        tone: "success",
      });
      router.push(APP_PATHS.teamIssues(created.key));
    } catch (error) {
      setSubmitError(formatApiError(error, "Nie udało się utworzyć zespołu."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void handleCreateTeam(event)} className="flex flex-col gap-4">
      {submitError ? <Banner tone="danger" message={submitError} /> : null}

      <Select
        label="Jednostka organizacyjna"
        value={selectedUnitId}
        disabled={submitting}
        onChange={(event) => handleUnitChange(event.target.value)}
      >
        {candidatesState.candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name} ({CORE_UNIT_TYPE_LABELS[candidate.type]})
          </option>
        ))}
      </Select>

      <TextField
        label="Klucz zespołu"
        placeholder="Np. MAG"
        value={keyInput}
        maxLength={5}
        error={keyError}
        hint="Od 2 do 5 wielkich liter A-Z. Służy do numeracji zadań, np. MAG-1."
        disabled={submitting}
        onChange={(event) => handleKeyChange(event.target.value)}
        required
      />

      <div className="flex justify-end gap-2 border-t border-border-secondary pt-3">
        <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>
          Anuluj
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !selectedUnitId}>
          {submitting ? "Tworzenie…" : "Utwórz zespół"}
        </Button>
      </div>
    </form>
  );
}
