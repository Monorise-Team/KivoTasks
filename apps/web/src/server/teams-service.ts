import "server-only";
import {
  CreateLabelInput,
  CreateTeamInput,
  CreateWorkflowStateInput,
  UpdateLabelInput,
  UpdateTeamInput,
  UpdateWorkflowStateInput,
  type Label,
  type LabelsList,
  type Team,
  type TeamCandidatesList,
  type TeamMembersList,
  type TeamsList,
  type WorkflowState,
  type WorkflowStatesList,
} from "@kivotasks/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { listTeamMembersWithAccount, listUserCoreUnits, tryFetchCoreUnitNamesOnce } from "./core-directory";
import { getIssuesStore } from "./issues-store";
import {
  assertOrgTeamManagePermission,
  canManageTeam,
  canReadTeam,
  PERMISSION_DENIED_MESSAGE,
  requireAuthorizedSnapshot,
  resolveReadableTeamsFilter,
} from "./permissions";

/**
 * Zwraca zespoły, które osoba może odczytać (`issues.read` lub `teams.manage` na zespole),
 * i w jednym wywołaniu best-effort odświeża buforowane nazwy z jednostek MonoriseCore.
 */
export async function listTeams(caller: Caller): Promise<TeamsList> {
  const filter = await resolveReadableTeamsFilter(caller);
  const store = getIssuesStore();
  const teams = await store.listTeams(caller, filter);
  if (teams.length === 0) {
    return { teams: [] };
  }

  const coreNames = await tryFetchCoreUnitNamesOnce(caller);
  if (!coreNames) {
    return { teams };
  }

  const updates: { id: string; name: string }[] = [];
  const refreshed = teams.map((team) => {
    const freshName = coreNames.get(team.id);
    if (freshName && freshName !== team.name) {
      updates.push({ id: team.id, name: freshName });
      return { ...team, name: freshName };
    }
    return team;
  });

  if (updates.length > 0) {
    try {
      await store.updateTeamNames(caller, updates);
    } catch {
      // Odświeżenie buforowanych nazw jest best-effort i nie może blokować odczytu listy.
    }
  }

  return { teams: refreshed };
}

/**
 * Zwraca aktywne jednostki MonoriseCore, które nie są jeszcze zespołami KivoTasks.
 * Wymaga `kivotasks.teams.manage` w zakresie całej firmy (`ORGANIZATION`) oraz sesji BFF.
 */
export async function listTeamCandidates(caller: Caller): Promise<TeamCandidatesList> {
  await assertOrgTeamManagePermission(caller);
  const [units, existingIds] = await Promise.all([
    listUserCoreUnits(caller, { status: "ACTIVE" }),
    getIssuesStore().listExistingTeamIds(caller),
  ]);
  const existingSet = new Set(existingIds);
  const candidates = units
    .filter((unit) => unit.status === "ACTIVE" && !existingSet.has(unit.id))
    .map((unit) => ({
      id: unit.id,
      name: unit.name,
      type: unit.type,
      parentId: unit.parentId,
    }));
  return { candidates };
}

/**
 * Tworzy zespół KivoTasks na bazie aktywnej jednostki Core wraz z domyślnymi statusami obiegu.
 * Wymaga `kivotasks.teams.manage` w zakresie całej firmy (`ORGANIZATION`) oraz sesji BFF.
 */
export async function createTeam(caller: Caller, rawInput: unknown): Promise<Team> {
  await assertOrgTeamManagePermission(caller);
  const input = CreateTeamInput.parse(rawInput);

  const units = await listUserCoreUnits(caller);
  const unit = units.find((candidate) => candidate.id === input.unitId);
  if (!unit) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono jednostki organizacyjnej w MonoriseCore");
  }
  if (unit.status !== "ACTIVE") {
    throw new ApiFailure(409, "CONFLICT", "Nie można utworzyć zespołu ze zarchiwizowanej jednostki organizacyjnej");
  }

  return getIssuesStore().createTeamWithDefaultStates(caller, {
    id: unit.id,
    key: input.key,
    name: unit.name,
  });
}

/**
 * Sprawdza widoczność zespołu (`404 NOT_FOUND` przed `403 PERMISSION_DENIED`),
 * a następnie opcjonalnie wymaga `teams.manage` dla tego zespołu.
 */
async function requireTeamAccess(caller: Caller, teamId: string, mode: "read" | "manage"): Promise<Team> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  if (!canReadTeam(snapshot, teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zespołu");
  }
  const team = await getIssuesStore().findTeamById(caller, teamId);
  if (!team) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zespołu");
  }
  if (mode === "manage" && !canManageTeam(snapshot, teamId)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }
  return team;
}

/** Zmienia klucz zespołu (`teams.manage`); identyfikatory zadań aktualizują się wraz z kluczem. */
export async function updateTeam(caller: Caller, teamId: string, rawInput: unknown): Promise<Team> {
  await requireTeamAccess(caller, teamId, "manage");
  const input = UpdateTeamInput.parse(rawInput);
  const updated = await getIssuesStore().updateTeamKey(caller, teamId, input.key);
  if (!updated) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zespołu");
  }
  return updated;
}

/** Zwraca członków zespołu posiadających aktywne konto (z katalogu produktu MonoriseCore). */
export async function listTeamMembers(caller: Caller, teamId: string): Promise<TeamMembersList> {
  await requireTeamAccess(caller, teamId, "read");
  const members = await listTeamMembersWithAccount(caller.organizationId, teamId);
  return { members };
}

// ── Statusy obiegu zadań ────────────────────────────────────────────────────

export async function listWorkflowStates(caller: Caller, teamId: string): Promise<WorkflowStatesList> {
  await requireTeamAccess(caller, teamId, "read");
  const states = await getIssuesStore().listWorkflowStates(caller, teamId);
  return { states };
}

export async function createWorkflowState(caller: Caller, teamId: string, rawInput: unknown): Promise<WorkflowState> {
  await requireTeamAccess(caller, teamId, "manage");
  const input = CreateWorkflowStateInput.parse(rawInput);
  return getIssuesStore().createWorkflowState(caller, { teamId, ...input });
}

export async function updateWorkflowState(
  caller: Caller,
  teamId: string,
  stateId: string,
  rawInput: unknown,
): Promise<WorkflowState> {
  await requireTeamAccess(caller, teamId, "manage");
  const input = UpdateWorkflowStateInput.parse(rawInput);
  const updated = await getIssuesStore().updateWorkflowState(caller, teamId, stateId, input);
  if (!updated) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono statusu");
  }
  return updated;
}

export async function deleteWorkflowState(caller: Caller, teamId: string, stateId: string): Promise<void> {
  await requireTeamAccess(caller, teamId, "manage");
  const deleted = await getIssuesStore().deleteWorkflowState(caller, teamId, stateId);
  if (!deleted) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono statusu");
  }
}

// ── Etykiety ────────────────────────────────────────────────────────────────

export async function listLabels(caller: Caller, teamId: string): Promise<LabelsList> {
  await requireTeamAccess(caller, teamId, "read");
  const labels = await getIssuesStore().listLabels(caller, teamId);
  return { labels };
}

export async function createLabel(caller: Caller, teamId: string, rawInput: unknown): Promise<Label> {
  await requireTeamAccess(caller, teamId, "manage");
  const input = CreateLabelInput.parse(rawInput);
  return getIssuesStore().createLabel(caller, { teamId, ...input });
}

export async function updateLabel(caller: Caller, teamId: string, labelId: string, rawInput: unknown): Promise<Label> {
  await requireTeamAccess(caller, teamId, "manage");
  const input = UpdateLabelInput.parse(rawInput);
  const updated = await getIssuesStore().updateLabel(caller, teamId, labelId, input);
  if (!updated) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono etykiety");
  }
  return updated;
}

export async function deleteLabel(caller: Caller, teamId: string, labelId: string): Promise<void> {
  await requireTeamAccess(caller, teamId, "manage");
  const deleted = await getIssuesStore().deleteLabel(caller, teamId, labelId);
  if (!deleted) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono etykiety");
  }
}
