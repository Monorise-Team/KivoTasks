"use client";

import { ApiError, type IssueDetail, type Label, type TeamMember, type WorkflowState } from "@kivotasks/client";
import { Banner, Button, Checkbox, Dialog, Select, TextArea, TextField, cn, useToast } from "@monorise-team/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { APP_PATHS, formatApiError } from "../app-views";
import {
  LINEAR_PRIORITY_OPTIONS,
  formatMemberName,
  formatPriorityLabel,
  getColorTokenStyle,
  resolveDefaultWorkflowStateId,
} from "../issue-ui";
import { useKivoTasks, type CreateIssueDefaults } from "../KivoTasksContext";
import { ColorDot } from "./IssueBadges";

export interface CreateIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults: CreateIssueDefaults;
  onCreated?: (issue: IssueDetail) => void;
}

export function CreateIssueDialog({ open, onOpenChange, defaults, onCreated }: CreateIssueDialogProps) {
  const { teams, canCreateTeam } = useKivoTasks();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Nowe zadanie"
      description={
        teams.length === 0
          ? "Aby tworzyć zadania, najpierw potrzebny jest zespół KivoTasks."
          : "Wypełnij podstawowe informacje o zadaniu. Numer zadania zostanie przydzielony automatycznie."
      }
      className="max-w-xl"
    >
      {!open ? null : teams.length === 0 ? (
        <div className="flex flex-col gap-4">
          <Banner
            tone="warning"
            message="Nie masz jeszcze dostępu do żadnego zespołu. Zespół tworzy się z jednostki organizacyjnej firmy."
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Zamknij
            </Button>
            {canCreateTeam ? (
              <Button asChild variant="primary" onClick={() => onOpenChange(false)}>
                <Link href={APP_PATHS.teams}>Przejdź do zespołów</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <CreateIssueForm defaults={defaults} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
    </Dialog>
  );
}

interface TeamMetaState {
  readonly teamId: string;
  readonly states: readonly WorkflowState[];
  readonly labels: readonly Label[];
  readonly members: readonly TeamMember[];
  readonly error: string | null;
}

function CreateIssueForm({
  defaults,
  onOpenChange,
  onCreated,
}: {
  defaults: CreateIssueDefaults;
  onOpenChange: (open: boolean) => void;
  onCreated?: (issue: IssueDetail) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { client, me, teams, markTeamWriteDenied, bumpIssuesRevision } = useKivoTasks();

  const initialTeamId = useMemo(() => {
    if (defaults.teamId && teams.some((team) => team.id === defaults.teamId)) {
      return defaults.teamId;
    }
    return teams[0]?.id ?? "";
  }, [defaults.teamId, teams]);

  const [teamId, setTeamId] = useState(initialTeamId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stateId, setStateId] = useState(defaults.stateId ?? "");
  const [priority, setPriority] = useState<number>(0);
  const [assigneeAccountId, setAssigneeAccountId] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [openAfterCreate, setOpenAfterCreate] = useState(false);

  const [meta, setMeta] = useState<TeamMetaState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);

  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;

    Promise.all([client.states.list(teamId), client.labels.list(teamId), client.teams.members(teamId)])
      .then(([statesRes, labelsRes, membersRes]) => {
        if (cancelled) return;
        setMeta({
          teamId,
          states: statesRes.states,
          labels: labelsRes.labels,
          members: membersRes.members,
          error: null,
        });
        setStateId((prev) => {
          if (prev && statesRes.states.some((item) => item.id === prev)) return prev;
          return resolveDefaultWorkflowStateId(statesRes.states) ?? "";
        });
        setSelectedLabelIds((prev) => prev.filter((id) => labelsRes.labels.some((label) => label.id === id)));
        setAssigneeAccountId((prev) => {
          if (prev && membersRes.members.some((member) => member.accountId === prev)) return prev;
          if (defaults.defaultAssignToMe && membersRes.members.some((member) => member.accountId === me.account.id)) {
            return me.account.id;
          }
          return "";
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMeta({
          teamId,
          states: [],
          labels: [],
          members: [],
          error: formatApiError(error, "Nie udało się wczytać statusów, etykiet i członków zespołu."),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [teamId, client, defaults.defaultAssignToMe, me.account.id]);

  const currentMeta = meta?.teamId === teamId ? meta : null;
  const metaLoading = Boolean(teamId) && !currentMeta;
  const states = currentMeta?.states ?? [];
  const labels = currentMeta?.labels ?? [];
  const members = currentMeta?.members ?? [];
  const metaError = currentMeta?.error ?? null;

  const toggleLabel = (labelId: string) => {
    setSelectedLabelIds((prev) => (prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId]));
  };

  const handleTeamChange = (nextTeamId: string) => {
    setTeamId(nextTeamId);
    setStateId("");
    setAssigneeAccountId("");
    setSelectedLabelIds([]);
    setSubmitError(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setTitleError("Podaj tytuł zadania.");
      titleInputRef.current?.focus();
      return;
    }
    if (trimmedTitle.length > 255) {
      setTitleError("Tytuł zadania może mieć najwyżej 255 znaków.");
      return;
    }
    if (!teamId) {
      setSubmitError("Wybierz zespół, do którego należy zadanie.");
      return;
    }

    setTitleError(null);
    setSubmitError(null);
    setSubmitting(true);

    try {
      const created = await client.issues.create({
        teamId,
        title: trimmedTitle,
        description: description.trim().length > 0 ? description : null,
        stateId: stateId || undefined,
        priority,
        assigneeAccountId: assigneeAccountId || null,
        labelIds: selectedLabelIds,
        dueDate: dueDate || null,
        parentId: defaults.parentId ?? null,
      });

      bumpIssuesRevision();
      onCreated?.(created);
      onOpenChange(false);

      if (openAfterCreate) {
        toast({
          title: `Utworzono zadanie ${created.identifier}`,
          description: created.title,
          tone: "success",
        });
        router.push(APP_PATHS.issueDetail(created.identifier));
      } else {
        toast({
          title: `Utworzono zadanie ${created.identifier}`,
          description: created.title,
          tone: "success",
          action: {
            label: "Otwórz",
            onClick: () => router.push(APP_PATHS.issueDetail(created.identifier)),
          },
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && error.code === "PERMISSION_DENIED") {
        markTeamWriteDenied(teamId);
      }
      setSubmitError(formatApiError(error, "Nie udało się utworzyć zadania."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
      {submitError ? <Banner tone="danger" message={submitError} /> : null}
      {metaError ? <Banner tone="warning" message={metaError} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Zespół"
          value={teamId}
          disabled={submitting || Boolean(defaults.parentId)}
          onChange={(event) => handleTeamChange(event.target.value)}
        >
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.key} · {team.name}
            </option>
          ))}
        </Select>

        <Select
          label="Status"
          value={stateId}
          disabled={submitting || metaLoading || states.length === 0}
          onChange={(event) => setStateId(event.target.value)}
        >
          {states.length === 0 ? <option value="">Domyślny status zespołu</option> : null}
          {states.map((state) => (
            <option key={state.id} value={state.id}>
              {state.name}
            </option>
          ))}
        </Select>
      </div>

      <TextField
        ref={titleInputRef}
        label="Tytuł"
        placeholder="Np. Poprawić eksport zestawienia do CSV"
        value={title}
        maxLength={255}
        error={titleError}
        disabled={submitting}
        onChange={(event) => {
          setTitle(event.target.value);
          if (titleError) setTitleError(null);
        }}
        required
      />

      <TextArea
        label="Opis"
        placeholder="Dodaj kontekst, kroki odtworzenia lub kryteria odbioru (opcjonalnie)."
        value={description}
        rows={4}
        maxLength={50_000}
        disabled={submitting}
        onChange={(event) => setDescription(event.target.value)}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          label="Priorytet"
          value={String(priority)}
          disabled={submitting}
          onChange={(event) => setPriority(Number(event.target.value))}
        >
          {LINEAR_PRIORITY_OPTIONS.map((value) => (
            <option key={value} value={String(value)}>
              {formatPriorityLabel(value)}
            </option>
          ))}
        </Select>

        <Select
          label="Osoba przypisana"
          value={assigneeAccountId}
          disabled={submitting || metaLoading}
          onChange={(event) => setAssigneeAccountId(event.target.value)}
        >
          <option value="">Nieprzypisane</option>
          {members.map((member) => (
            <option key={member.accountId} value={member.accountId}>
              {formatMemberName(member)}
            </option>
          ))}
        </Select>

        <TextField
          label="Termin"
          type="date"
          value={dueDate}
          disabled={submitting}
          onChange={(event) => setDueDate(event.target.value)}
        />
      </div>

      {labels.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-text-secondary">Etykiety</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Etykiety zadania">
            {labels.map((label) => {
              const active = selectedLabelIds.includes(label.id);
              const style = getColorTokenStyle(label.color);
              return (
                <button
                  key={label.id}
                  type="button"
                  aria-pressed={active}
                  disabled={submitting}
                  onClick={() => toggleLabel(label.id)}
                  className={cn(
                    "mr-press mr-no-text-shadow inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    active
                      ? style.badge
                      : "border-border-primary bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                  )}
                >
                  <ColorDot color={label.color} className="size-2" />
                  <span>{label.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-secondary pt-3">
        <Checkbox
          label="Otwórz zadanie po utworzeniu"
          checked={openAfterCreate}
          disabled={submitting}
          onCheckedChange={(checked) => setOpenAfterCreate(checked === true)}
        />

        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" disabled={submitting} onClick={() => onOpenChange(false)}>
            Anuluj
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || metaLoading}>
            {submitting ? "Tworzenie…" : "Utwórz zadanie"}
          </Button>
        </div>
      </div>
    </form>
  );
}
