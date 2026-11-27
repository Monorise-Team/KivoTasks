import "server-only";
import { paginate, type CoreClient, type Unit } from "@monorise-team/sdk";
import { KIVOTASKS_PERMISSIONS, type TeamMember } from "@kivotasks/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { createUserCoreClient, getMachineCoreClient } from "./core";

/** Maksymalna liczba powtarzalnych identyfikatorów `employeeId` w jednym zapytaniu do Core Directory. */
const CORE_DIRECTORY_BATCH_SIZE = 100;

/** Zastępcza etykieta osoby, gdy nie uda się pobrać jej imienia i nazwiska z katalogu Core. */
export const UNKNOWN_PERSON_NAME = "Nieznana osoba";

/** Czas przechowywania mapy nazw osób z katalogu Core w pamięci procesu (60 s). */
export const DIRECTORY_NAMES_TTL_MS = 60 * 1_000;

/** Maksymalna liczba stron (po 100 osób) pobieranych z katalogu Core przy jednym odświeżeniu pamięci. */
export const DIRECTORY_NAMES_MAX_PAGES = 20;

/** Krótki limit czasu dla best-effort pobrania katalogu nazw osób z Core (ms). */
export const DIRECTORY_NAMES_TIMEOUT_MS = 2_000;

/** Maksymalna liczba firm w pamięci podręcznej nazw osób (powyżej usuwamy najstarszy wpis). */
export const DIRECTORY_NAMES_MAX_ORGS = 500;

interface DirectoryNamesCacheEntry {
  readonly names: Map<string, string>;
  readonly expiresAt: number;
}

const processGlobal = globalThis as typeof globalThis & {
  __kivotasksDirectoryNamesCache?: Map<string, DirectoryNamesCacheEntry>;
  __kivotasksDirectoryNamesInFlight?: Map<string, Promise<Map<string, string> | null>>;
};
const directoryNamesCache = (processGlobal.__kivotasksDirectoryNamesCache ??= new Map());
const directoryNamesInFlight = (processGlobal.__kivotasksDirectoryNamesInFlight ??= new Map());

/** Czyści pamięć podręczną nazw osób z katalogu Core oraz aktywne zapytania single-flight (np. w testach). */
export function invalidateDirectoryNamesCache(organizationId?: string): void {
  if (organizationId) {
    directoryNamesCache.delete(organizationId);
    directoryNamesInFlight.delete(organizationId);
  } else {
    directoryNamesCache.clear();
    directoryNamesInFlight.clear();
  }
}

export interface TryResolveMemberNamesOptions {
  readonly core?: Pick<CoreClient, "listProductDirectoryEmployees">;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
  readonly ttlMs?: number;
  readonly maxOrgs?: number;
  readonly now?: () => number;
}

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

/**
 * Best-effort rozwiązuje imiona i nazwiska osób z firmy dla wskazanych `accountId`
 * przez katalog produktu MonoriseCore (`core:directory.read`).
 *
 * - Buforuje nazwy osób per firma w pamięci procesu przez 60 s (maks. 500 firm, usuwa najstarszy wpis).
 * - Deduplikuje równoległe pobrania dla tej samej firmy (single-flight).
 * - Ogranicza pobranie do maks. 20 stron po 100 osób oraz krótkiego limitu czasu i nigdy nie buforuje błędów.
 * - Przy błędzie, przekroczeniu limitu czasu lub braku osoby w katalogu zwraca `"Nieznana osoba"`
 *   bez przerywania żądania użytkownika.
 */
export async function tryResolveOrganizationMemberNames(
  organizationId: string,
  neededAccountIds: ReadonlySet<string>,
  options: TryResolveMemberNamesOptions = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (neededAccountIds.size === 0) {
    return result;
  }

  const wanted = new Set<string>();
  for (const id of neededAccountIds) {
    wanted.add(id.toLowerCase());
  }

  const nowFn = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DIRECTORY_NAMES_TTL_MS;
  const maxPages = options.maxPages ?? DIRECTORY_NAMES_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? DIRECTORY_NAMES_TIMEOUT_MS;
  const maxOrgs = options.maxOrgs ?? DIRECTORY_NAMES_MAX_ORGS;

  const now = nowFn();
  const cached = directoryNamesCache.get(organizationId);
  let orgNames: Map<string, string> | null = cached && cached.expiresAt > now ? cached.names : null;

  if (!orgNames) {
    if (cached && cached.expiresAt <= now) {
      directoryNamesCache.delete(organizationId);
    }

    let inFlight = directoryNamesInFlight.get(organizationId);
    if (!inFlight) {
      inFlight = (async (): Promise<Map<string, string> | null> => {
        const fetched = new Map<string, string>();
        const signal = AbortSignal.timeout(timeoutMs);
        try {
          const core = options.core ?? getMachineCoreClient();
          let cursor: string | undefined;
          for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
            const page = await core.listProductDirectoryEmployees({
              path: { productKey: KIVOTASKS_PERMISSIONS.product },
              query: {
                organizationId,
                limit: CORE_DIRECTORY_BATCH_SIZE,
                ...(cursor ? { cursor } : {}),
              },
              signal,
            });
            for (const employee of page.items) {
              if (employee.accountId === null) continue;
              const fullName = `${employee.firstName} ${employee.lastName}`.trim();
              if (fullName) {
                fetched.set(employee.accountId.toLowerCase(), fullName);
              }
            }
            if (!page.nextCursor) {
              break;
            }
            cursor = page.nextCursor;
          }
        } catch {
          return null;
        }

        directoryNamesCache.delete(organizationId);
        while (directoryNamesCache.size >= maxOrgs) {
          const oldestKey = directoryNamesCache.keys().next().value;
          if (oldestKey === undefined) break;
          directoryNamesCache.delete(oldestKey);
        }
        directoryNamesCache.set(organizationId, {
          names: fetched,
          expiresAt: nowFn() + ttlMs,
        });
        return fetched;
      })().finally(() => {
        if (directoryNamesInFlight.get(organizationId) === inFlight) {
          directoryNamesInFlight.delete(organizationId);
        }
      });

      directoryNamesInFlight.set(organizationId, inFlight);
    }

    orgNames = (await inFlight) ?? new Map<string, string>();
  }

  for (const key of wanted) {
    result.set(key, orgNames?.get(key) ?? UNKNOWN_PERSON_NAME);
  }

  return result;
}
