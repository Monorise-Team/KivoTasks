import "server-only";
import {
  can,
  createPermissionCache,
  scopeOf,
  type AccessScope,
  type PermissionCacheFilter,
  type PermissionSnapshot,
} from "@monorise-team/permissions";
import { KIVOTASKS_PERMISSIONS, type Capabilities, type KivotasksPermissionKey } from "@kivotasks/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getMachineCoreClient } from "./core";

/**
 * Komunikat zwracany, gdy produkt `kivotasks` nie znajduje się w `snapshot.products` (brak dostępu firmy
 * albo brak włączonego KivoTasks na koncie; z samej migawki nie da się tych sytuacji rozróżnić).
 */
export const PRODUCT_ACCESS_REQUIRED_MESSAGE =
  "KivoTasks nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.";

export const PERMISSION_DENIED_MESSAGE = "Brak uprawnienia do tej operacji";

type PermissionCache = ReturnType<typeof createPermissionCache>;

/**
 * Jedna pamięć na proces. Next.js wczytuje `instrumentation.ts` (pobieranie zdarzeń z Core) i trasy API
 * jako osobne kopie modułów, więc zwykła zmienna modułu dałaby dwie różne pamięci: zdarzenie czyściłoby
 * nie tę, z której korzystają trasy.
 */
const processGlobal = globalThis as typeof globalThis & { __kivotasksPermissionCache?: PermissionCache };
const permissionCache = (processGlobal.__kivotasksPermissionCache ??= createPermissionCache({
  load: ({ organizationId, accountId }) =>
    getMachineCoreClient().getProductPermissionSnapshot({
      path: { productKey: KIVOTASKS_PERMISSIONS.product },
      query: { organizationId, accountId },
    }),
}));

/**
 * Pobiera migawkę uprawnień z pamięci podręcznej (5 min, odświeżana od razu przy wyższym `authz_rev`).
 * `organizationId`, `accountId` i `authzRevision` pochodzą wyłącznie ze zweryfikowanego tokenu/sesji.
 */
export function getPermissionSnapshot(caller: Caller): Promise<PermissionSnapshot> {
  return permissionCache.get({
    organizationId: caller.organizationId,
    accountId: caller.accountId,
    authzRevision: caller.context.authzRevision,
  });
}

/** Czyści pamięć podręczną migawek uprawnień (np. w testach lub po zdarzeniu zmiany uprawnień). */
export function invalidatePermissionCache(filter?: PermissionCacheFilter): void {
  permissionCache.invalidate(filter);
}

export function assertProductAccess(snapshot: PermissionSnapshot): void {
  if (!snapshot.products.includes(KIVOTASKS_PERMISSIONS.product)) {
    throw new ApiFailure(403, "PRODUCT_ACCESS_REQUIRED", PRODUCT_ACCESS_REQUIRED_MESSAGE);
  }
}

/**
 * Wylicza możliwości widoczne w interfejsie KivoTasks na podstawie migawki uprawnień z Core.
 */
export function capabilitiesFromSnapshot(snapshot: PermissionSnapshot): Capabilities {
  const manageTeamsScope = scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["teams.manage"]);
  return {
    hasProductAccess: snapshot.products.includes(KIVOTASKS_PERMISSIONS.product),
    readIssues: can(snapshot, KIVOTASKS_PERMISSIONS.keys["issues.read"]),
    writeIssues: can(snapshot, KIVOTASKS_PERMISSIONS.keys["issues.write"]),
    manageTeams: can(snapshot, KIVOTASKS_PERMISSIONS.keys["teams.manage"]),
    createTeams: manageTeamsScope.type === "ORGANIZATION",
    manageProjects: can(snapshot, KIVOTASKS_PERMISSIONS.keys["projects.manage"]),
  };
}

/** Zwraca możliwości zalogowanej osoby dla trasy `GET /api/v1/me`. */
export async function getUserCapabilities(caller: Caller): Promise<Capabilities> {
  const snapshot = await getPermissionSnapshot(caller);
  return capabilitiesFromSnapshot(snapshot);
}

/**
 * Jedyny punkt sprawdzania uprawnień po stronie serwera KivoTasks (ADR-0036).
 * Sprawdza obecność produktu `kivotasks` w migawce (`403 PRODUCT_ACCESS_REQUIRED`)
 * oraz wskazane uprawnienie (`403 PERMISSION_DENIED`).
 */
export async function assertPermission(
  caller: Caller,
  permission: KivotasksPermissionKey,
): Promise<PermissionSnapshot> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  if (!can(snapshot, permission)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }
  return snapshot;
}

/**
 * Zwraca efektywny zakres uprawnienia (`ORGANIZATION` albo `LIMITED`: `unitIds` / `resourceIds`).
 * Brak produktu daje `403 PRODUCT_ACCESS_REQUIRED`, a zakres `NONE` daje `403 PERMISSION_DENIED`.
 */
export async function assertPermissionScope(
  caller: Caller,
  permission: KivotasksPermissionKey,
): Promise<Exclude<AccessScope, { type: "NONE" }>> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const scope = scopeOf(snapshot, permission);
  if (scope.type === "NONE") {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }
  return scope;
}

/**
 * Zwraca `true`, gdy efektywny zakres uprawnienia (z rozwiniętymi poddrzewami jednostek z Core)
 * obejmuje wskazany zespół (`unitId`).
 */
export function scopeCoversTeam(scope: AccessScope, teamId: string): boolean {
  if (scope.type === "ORGANIZATION") return true;
  if (scope.type === "LIMITED") return scope.unitIds.includes(teamId);
  return false;
}

/** Zwraca `true`, jeśli konto ma co najmniej jedno aktywne uprawnienie KivoTasks (albo jest Ownerem). */
export function hasAnyKivotasksPermission(snapshot: PermissionSnapshot): boolean {
  return (
    can(snapshot, KIVOTASKS_PERMISSIONS.keys["issues.read"]) ||
    can(snapshot, KIVOTASKS_PERMISSIONS.keys["issues.write"]) ||
    can(snapshot, KIVOTASKS_PERMISSIONS.keys["teams.manage"]) ||
    can(snapshot, KIVOTASKS_PERMISSIONS.keys["projects.manage"])
  );
}

/**
 * Wymaga dostępu do produktu (`403 PRODUCT_ACCESS_REQUIRED`) i co najmniej jednego uprawnienia KivoTasks
 * (`403 PERMISSION_DENIED`), zanim trasa odwoła się do konkretnego zespołu lub zadania (ADR-0046).
 */
export async function requireAuthorizedSnapshot(caller: Caller): Promise<PermissionSnapshot> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  if (!hasAnyKivotasksPermission(snapshot)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }
  return snapshot;
}

export type TeamFilterScope = "ALL" | string[];

/** Zamienia efektywny zakres uprawnienia na filtr `teamId` (`"ALL"` albo lista UUID zespołów). */
export function teamFilterFromScope(scope: AccessScope): TeamFilterScope {
  if (scope.type === "ORGANIZATION") return "ALL";
  if (scope.type === "LIMITED") return [...scope.unitIds];
  return [];
}

/** Suma dwóch filtrów zespołów (np. `issues.read` i `issues.write`, bo zapis też daje wgląd w zadanie). */
export function mergeTeamFilters(a: TeamFilterScope, b: TeamFilterScope): TeamFilterScope {
  if (a === "ALL" || b === "ALL") return "ALL";
  return [...new Set([...a, ...b])];
}

/** Zwraca `true`, gdy osoba ma prawo widzieć zespół (`issues.read` albo `teams.manage` na tym zespole). */
export function canReadTeam(snapshot: PermissionSnapshot, teamId: string): boolean {
  return (
    scopeCoversTeam(scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["issues.read"]), teamId) ||
    scopeCoversTeam(scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["teams.manage"]), teamId)
  );
}

/** Zwraca `true`, gdy osoba ma `issues.read` na tym zespole. */
export function canReadTeamIssues(snapshot: PermissionSnapshot, teamId: string): boolean {
  return scopeCoversTeam(scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["issues.read"]), teamId);
}

/** Zwraca `true`, gdy osoba ma `issues.write` na tym zespole. */
export function canWriteTeamIssues(snapshot: PermissionSnapshot, teamId: string): boolean {
  return scopeCoversTeam(scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["issues.write"]), teamId);
}

/** Zwraca `true`, gdy osoba ma `teams.manage` na tym zespole. */
export function canManageTeam(snapshot: PermissionSnapshot, teamId: string): boolean {
  return scopeCoversTeam(scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["teams.manage"]), teamId);
}

/**
 * Zwraca zbiór zespołów widocznych na liście `GET /api/v1/teams` (`issues.read` lub `teams.manage`).
 * Brak któregokolwiek z tych uprawnień daje `403 PERMISSION_DENIED`.
 */
export async function resolveReadableTeamsFilter(caller: Caller): Promise<TeamFilterScope> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const readScope = scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["issues.read"]);
  const manageScope = scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["teams.manage"]);
  if (readScope.type === "NONE" && manageScope.type === "NONE") {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }
  if (readScope.type === "ORGANIZATION" || manageScope.type === "ORGANIZATION") {
    return "ALL";
  }
  const merged = new Set<string>([
    ...(readScope.type === "LIMITED" ? readScope.unitIds : []),
    ...(manageScope.type === "LIMITED" ? manageScope.unitIds : []),
  ]);
  return [...merged];
}

/** Wymaga `kivotasks.teams.manage` w zakresie całej firmy (`ORGANIZATION`, obejmuje również Ownera). */
export async function assertOrgTeamManagePermission(caller: Caller): Promise<PermissionSnapshot> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const scope = scopeOf(snapshot, KIVOTASKS_PERMISSIONS.keys["teams.manage"]);
  if (scope.type !== "ORGANIZATION") {
    throw new ApiFailure(
      403,
      "PERMISSION_DENIED",
      "Tworzenie zespołu z jednostki firmy wymaga uprawnienia zarządzania zespołami w całej firmie",
    );
  }
  return snapshot;
}
