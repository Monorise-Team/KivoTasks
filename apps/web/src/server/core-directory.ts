import "server-only";
import { paginate, type Unit } from "@monorise-team/sdk";
import { KIVOTASKS_PERMISSIONS, type TeamMember } from "@kivotasks/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { createUserCoreClient, getMachineCoreClient } from "./core";

/** Maksymalna liczba powtarzalnych identyfikatorów `employeeId` w jednym zapytaniu do Core Directory. */
const CORE_DIRECTORY_BATCH_SIZE = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/**
 * Pobiera wszystkie jednostki firmy zalogowanej osoby z MonoriseCore (`GET /core/v1/units`).
 * Wymaga sesji przeglądarki (BFF), bo token Bearer KivoTasks ma innego odbiorcę niż Core API.
 */
export async function listUserCoreUnits(caller: Caller, options?: { status?: "ACTIVE" | "ARCHIVED" }): Promise<Unit[]> {
  if (!caller.session) {
    throw new ApiFailure(
      403,
      "PERMISSION_DENIED",
      "Ta operacja wymaga sesji przeglądarki (BFF), aby odczytać jednostki z MonoriseCore.",
    );
  }
  const core = createUserCoreClient(caller.session);
  const units: Unit[] = [];
  for await (const unit of paginate(core.listUnits, {
    query: {
      ...(options?.status ? { status: options.status } : {}),
      limit: CORE_DIRECTORY_BATCH_SIZE,
    },
  })) {
    units.push(unit);
  }
  return units;
}

/**
 * Pobiera jedną stronę jednostek z Core (`GET /core/v1/units`) w trybie best-effort na potrzeby odświeżenia
 * buforowanych nazw zespołów. Zwraca `null`, gdy brak sesji BFF lub Core jest chwilowo niedostępny.
 */
export async function tryFetchCoreUnitNamesOnce(caller: Caller): Promise<Map<string, string> | null> {
  if (!caller.session) return null;
  try {
    const core = createUserCoreClient(caller.session);
    const page = await core.listUnits({ query: { limit: CORE_DIRECTORY_BATCH_SIZE } });
    const names = new Map<string, string>();
    for (const unit of page.items) {
      names.set(unit.id, unit.name);
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * Zwraca członków jednostki Core (zespołu), którzy mają aktywne konto Monorise, wraz z imieniem i nazwiskiem.
 * Korzysta z katalogu produktu Core przez klienta maszynowego (`core:directory.read`).
 */
export async function listTeamMembersWithAccount(organizationId: string, teamId: string): Promise<TeamMember[]> {
  const core = getMachineCoreClient();
  const employeeIds = new Set<string>();

  for await (const member of paginate(core.listProductDirectoryUnitMembers, {
    path: { productKey: KIVOTASKS_PERMISSIONS.product },
    query: { organizationId, unitId: [teamId], limit: CORE_DIRECTORY_BATCH_SIZE },
  })) {
    if (member.accountId !== null) {
      employeeIds.add(member.employeeId);
    }
  }

  if (employeeIds.size === 0) {
    return [];
  }

  const members: TeamMember[] = [];
  for (const batch of chunk([...employeeIds], CORE_DIRECTORY_BATCH_SIZE)) {
    for await (const employee of paginate(core.listProductDirectoryEmployees, {
      path: { productKey: KIVOTASKS_PERMISSIONS.product },
      query: { organizationId, employeeId: batch, limit: CORE_DIRECTORY_BATCH_SIZE },
    })) {
      if (employee.accountId !== null && employee.status === "ACTIVE") {
        members.push({
          accountId: employee.accountId,
          employeeId: employee.id,
          firstName: employee.firstName,
          lastName: employee.lastName,
        });
      }
    }
  }

  members.sort((a, b) => {
    const byLast = a.lastName.localeCompare(b.lastName, "pl");
    if (byLast !== 0) return byLast;
    const byFirst = a.firstName.localeCompare(b.firstName, "pl");
    if (byFirst !== 0) return byFirst;
    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
  });

  return members;
}
