/**
 * Testy tras zespołów, statusów obiegu i etykiet na prawdziwych handlerach Next.js z atrapą
 * `createFakeCore` + adapterem `GET /core/v1/units`, na prawdziwym PostgreSQL z RLS (`prismaIssuesStore`).
 */
import type { Authenticated, Session } from "@monorise-team/auth/next";
import {
  createFakeCore,
  type CreatedEmployeeWithAccount,
  type FakeCore,
  type FakeOrganizationBuilder,
} from "@monorise-team/testing";
import { KIVOTASKS_PERMISSIONS } from "@kivotasks/contracts";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as issuesRoute from "@/app/api/v1/issues/route";
import * as issueByIdRoute from "@/app/api/v1/issues/[issueId]/route";
import * as teamByIdRoute from "@/app/api/v1/teams/[teamId]/route";
import * as labelsRoute from "@/app/api/v1/teams/[teamId]/labels/route";
import * as labelByIdRoute from "@/app/api/v1/teams/[teamId]/labels/[labelId]/route";
import * as membersRoute from "@/app/api/v1/teams/[teamId]/members/route";
import * as statesRoute from "@/app/api/v1/teams/[teamId]/states/route";
import * as stateByIdRoute from "@/app/api/v1/teams/[teamId]/states/[stateId]/route";
import * as candidatesRoute from "@/app/api/v1/teams/candidates/route";
import * as teamsRoute from "@/app/api/v1/teams/route";
import { getAuth } from "@/server/auth";
import { resetMachineCoreTokenCache, setCoreRetryForTests } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_NOTIFICATIONS_SEND_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import { invalidatePermissionCache } from "@/server/permissions";
import { createFakeCoreWithUnitsFetch } from "./helpers/fake-core-units";

const API = "http://kivo.localhost:3500";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.teams.test";
const CLIENT_ID = "kivotasks-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- w testach czytamy kopertę JSON swobodnie
type TestEnvelope = { data: any; meta: any; error: any };

function call<P>(
  handler: (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>,
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
  params = {} as P,
) {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { host: "kivo.localhost:3500", ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) {
    headers.authorization = `Bearer ${init.token}`;
  } else if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.origin ??= API;
  }
  const request = new NextRequest(`${BASE}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return handler(request, { params: Promise.resolve(params) }).then(async (response) => ({
    status: response.status,
    body:
      response.status === 204
        ? ({ data: null, meta: null, error: null } as TestEnvelope)
        : ((await response.json()) as TestEnvelope),
  }));
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let unitsFaultStatus: number | null = null;

let branchKrakowId: string;
let unitMagazynId: string;
let unitFinanseId: string;
let unitArchivedId: string;

let memberRoleId: string;
let adminRoleId: string;
let guestRoleId: string;

let owner: CreatedEmployeeWithAccount;
let anna: CreatedEmployeeWithAccount;
let branchAdmin: CreatedEmployeeWithAccount;
let guest: CreatedEmployeeWithAccount;
let noPerm: CreatedEmployeeWithAccount;

function mockSession(employee: CreatedEmployeeWithAccount, coreToken: string) {
  const context = {
    accountId: employee.accountId,
    organizationId: acme.id,
    employeeId: employee.employeeId,
    sessionId: "sesja-teams-test",
    authzRevision: employee.account.authzRevision,
    methods: [],
    clientId: CLIENT_ID,
    scopes: ["openid", "profile", "email", "offline_access"],
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
  const session: Session = {
    context,
    profile: { email: employee.account.email, name: `${employee.firstName} ${employee.lastName}` },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    accessToken: async () => coreToken,
    setCookies: [],
  };
  const authenticated: Authenticated = { context, via: "session", session, setCookies: [] };
  vi.spyOn(getAuth(), "authenticate").mockResolvedValue(authenticated);
}

async function asSession(employee: CreatedEmployeeWithAccount) {
  const coreToken = await acme.signUserToken(employee.accountId, { audience: fakeCore.coreApiUrl });
  mockSession(employee, coreToken);
}

async function tokenFor(employee: CreatedEmployeeWithAccount) {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(
    createFakeCoreWithUnitsFetch(fakeCore, { getUnitsFaultStatus: () => unitsFaultStatus }),
  );
  return acme.signUserToken(employee.accountId, { audience: API });
}

beforeAll(async () => {
  fakeCore = await createFakeCore({
    issuer: FAKE_CORE_URL,
    coreApiUrl: FAKE_CORE_URL,
    products: [
      {
        key: "kivotasks",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        scopes: [
          CORE_PERMISSIONS_REGISTER_SCOPE,
          CORE_PERMISSIONS_READ_SCOPE,
          CORE_DIRECTORY_READ_SCOPE,
          CORE_EVENTS_READ_SCOPE,
          CORE_NOTIFICATIONS_SEND_SCOPE,
        ],
      },
    ],
  });
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  delete process.env.KIVOTASKS_CORE_JWKS;
});

beforeEach(() => {
  fakeCore.reset();
  fakeCore.setDirectoryPageSize(undefined);
  unitsFaultStatus = null;
  setCoreRetryForTests(false);
  invalidatePermissionCache();
  resetMachineCoreTokenCache();

  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("kivotasks");

  const krakow = acme.addUnit({ name: "Oddział Kraków", type: "BRANCH" });
  const magazyn = acme.addUnit({ name: "Magazyn", type: "TEAM", parentId: krakow.id });
  const finanse = acme.addUnit({ name: "Finanse", type: "TEAM" });
  const archived = acme.addUnit({ name: "Stary Zespół", type: "TEAM", status: "ARCHIVED" });
  branchKrakowId = krakow.id;
  unitMagazynId = magazyn.id;
  unitFinanseId = finanse.id;
  unitArchivedId = archived.id;

  memberRoleId = acme.addRole({
    name: "Członek KivoTasks",
    product: "kivotasks",
    permissions: [KIVOTASKS_PERMISSIONS.keys["issues.read"], KIVOTASKS_PERMISSIONS.keys["issues.write"]],
  }).id;
  adminRoleId = acme.addRole({
    name: "Administrator KivoTasks",
    product: "kivotasks",
    permissions: [
      KIVOTASKS_PERMISSIONS.keys["issues.read"],
      KIVOTASKS_PERMISSIONS.keys["issues.write"],
      KIVOTASKS_PERMISSIONS.keys["teams.manage"],
      KIVOTASKS_PERMISSIONS.keys["projects.manage"],
    ],
  }).id;
  guestRoleId = acme.addRole({
    name: "Gość",
    product: "kivotasks",
    permissions: [KIVOTASKS_PERMISSIONS.keys["issues.read"]],
  }).id;

  owner = acme.addEmployee({ firstName: "Ola", lastName: "Właścicielka", isOwner: true, unitIds: [unitMagazynId] });
  anna = acme.addEmployee({
    firstName: "Anna",
    lastName: "Nowak",
    products: ["kivotasks"],
    unitIds: [unitMagazynId],
  });
  branchAdmin = acme.addEmployee({
    firstName: "Ewa",
    lastName: "Kowalczyk",
    products: ["kivotasks"],
    unitIds: [branchKrakowId],
  });
  guest = acme.addEmployee({
    firstName: "Jan",
    lastName: "Kowalski",
    products: ["kivotasks"],
    unitIds: [unitMagazynId],
  });
  noPerm = acme.addEmployee({ firstName: "Bez", lastName: "Roli", products: ["kivotasks"] });

  acme.assignRole({ accountId: anna.accountId, roleId: memberRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });
  acme.assignRole({
    accountId: branchAdmin.accountId,
    roleId: adminRoleId,
    scope: { type: "UNIT", unitId: branchKrakowId },
  });
  acme.assignRole({ accountId: guest.accountId, roleId: guestRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });

  vi.spyOn(globalThis, "fetch").mockImplementation(
    createFakeCoreWithUnitsFetch(fakeCore, { getUnitsFaultStatus: () => unitsFaultStatus }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  setCoreRetryForTests();
});

afterAll(() => {
  vi.restoreAllMocks();
  setCoreRetryForTests();
});

describe("API zespołów, kandydatów i członków", () => {
  it("Owner tworzy zespół z aktywnej jednostki Core, zakłada 6 domyślnych statusów i odrzuca zarchiwizowaną/nieznaną/duplikaty", async () => {
    await asSession(owner);

    const candidatesBefore = await call(candidatesRoute.GET, "/teams/candidates");
    expect(candidatesBefore.status).toBe(200);
    expect(candidatesBefore.body.data.candidates.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([branchKrakowId, unitMagazynId, unitFinanseId]),
    );
    expect(candidatesBefore.body.data.candidates.some((c: { id: string }) => c.id === unitArchivedId)).toBe(false);

    const created = await call(teamsRoute.POST, "/teams", {
      method: "POST",
      body: { unitId: unitMagazynId, key: "MAG" },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      id: unitMagazynId,
      organizationId: acme.id,
      key: "MAG",
      name: "Magazyn",
      nextIssueNumber: 1,
    });

    // Domyślne 6 statusów w oczekiwanej kolejności
    const statesRes = await call(statesRoute.GET, `/teams/${unitMagazynId}/states`, {}, { teamId: unitMagazynId });
    expect(statesRes.status).toBe(200);
    expect(
      statesRes.body.data.states.map((s: { name: string; category: string; color: string; position: number }) => [
        s.name,
        s.category,
        s.color,
        s.position,
      ]),
    ).toEqual([
      ["Backlog", "BACKLOG", "gray", 0],
      ["Do zrobienia", "UNSTARTED", "blue", 1],
      ["W toku", "STARTED", "yellow", 2],
      ["Do przeglądu", "STARTED", "purple", 3],
      ["Zrobione", "COMPLETED", "green", 4],
      ["Anulowane", "CANCELED", "red", 5],
    ]);

    // Zespół zniknął z kandydatów
    const candidatesAfter = await call(candidatesRoute.GET, "/teams/candidates");
    expect(candidatesAfter.body.data.candidates.some((c: { id: string }) => c.id === unitMagazynId)).toBe(false);

    // Zarchiwizowana jednostka -> 409 CONFLICT
    const archivedRes = await call(teamsRoute.POST, "/teams", {
      method: "POST",
      body: { unitId: unitArchivedId, key: "OLD" },
    });
    expect(archivedRes.status).toBe(409);
    expect(archivedRes.body.error.code).toBe("CONFLICT");

    // Nieistniejąca jednostka -> 404 NOT_FOUND
    const missingRes = await call(teamsRoute.POST, "/teams", {
      method: "POST",
      body: { unitId: "019a0000-0000-7000-8000-000000009999", key: "BRAK" },
    });
    expect(missingRes.status).toBe(404);

    // Duplikat jednostki i duplikat klucza -> 409 CONFLICT
    expect(
      (await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "LOG" } })).status,
    ).toBe(409);
    expect(
      (await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "MAG" } })).status,
    ).toBe(409);

    // Administrator z zakresem LIMITED (UNIT) nie może tworzyć zespołu ani czytać kandydatów
    await asSession(branchAdmin);
    expect(
      (await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "FIN" } })).status,
    ).toBe(403);
    expect((await call(candidatesRoute.GET, "/teams/candidates")).status).toBe(403);
  });

  it("GET /api/v1/teams filtruje po zasięgu (w tym poddrzewo jednostek) i odświeża nazwy best-effort", async () => {
    await asSession(owner);
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "FIN" } });

    // Zmieniamy nazwę jednostki w Core: GET /teams w sesji BFF odświeża ją w jednym wywołaniu
    acme.data.units.get(unitMagazynId)!.name = "Magazyn Centralny";
    await asSession(branchAdmin);
    const branchList = await call(teamsRoute.GET, "/teams");
    expect(branchList.status).toBe(200);
    // branchAdmin ma zakres Oddział Kraków -> widzi podjednostkę Magazyn, nie widzi Finansów
    expect(branchList.body.data.teams.map((t: { id: string; name: string }) => [t.id, t.name])).toEqual([
      [unitMagazynId, "Magazyn Centralny"],
    ]);

    // Awaria /core/v1/units nie blokuje odczytu — zwracana jest buforowana nazwa
    unitsFaultStatus = 500;
    const fallbackList = await call(teamsRoute.GET, "/teams");
    expect(fallbackList.status).toBe(200);
    expect(fallbackList.body.data.teams[0].name).toBe("Magazyn Centralny");

    // Osoba bez żadnych uprawnień dostaje 403 PERMISSION_DENIED
    const noPermToken = await tokenFor(noPerm);
    expect((await call(teamsRoute.GET, "/teams", { token: noPermToken })).status).toBe(403);
  });

  it("wymusza 404 przed 403 dla zespołów spoza zasięgu przy PATCH zespołu, statusach i etykietach", async () => {
    await asSession(owner);
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "FIN" } });

    // Anna ma issues.read + issues.write na Magazynie (brak teams.manage), brak dostępu do Finansów
    const annaToken = await tokenFor(anna);

    // Finanse (spoza zasięgu): 404 zamiast 403
    expect(
      (
        await call(
          teamByIdRoute.PATCH,
          `/teams/${unitFinanseId}`,
          { method: "PATCH", body: { key: "XXX" }, token: annaToken },
          { teamId: unitFinanseId },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          statesRoute.POST,
          `/teams/${unitFinanseId}/states`,
          { method: "POST", body: { name: "Test", category: "STARTED", color: "blue" }, token: annaToken },
          { teamId: unitFinanseId },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          labelsRoute.POST,
          `/teams/${unitFinanseId}/labels`,
          { method: "POST", body: { name: "Pilne", color: "red" }, token: annaToken },
          { teamId: unitFinanseId },
        )
      ).status,
    ).toBe(404);

    // Magazyn (w zasięgu odczytu, brak teams.manage): 403 PERMISSION_DENIED
    const deniedKey = await call(
      teamByIdRoute.PATCH,
      `/teams/${unitMagazynId}`,
      { method: "PATCH", body: { key: "LOG" }, token: annaToken },
      { teamId: unitMagazynId },
    );
    expect(deniedKey.status).toBe(403);
    expect(deniedKey.body.error.code).toBe("PERMISSION_DENIED");

    // branchAdmin ma teams.manage na Oddziale Kraków -> może zmienić klucz Magazynu, a dla Finansów dostaje 404
    const branchToken = await tokenFor(branchAdmin);
    const updated = await call(
      teamByIdRoute.PATCH,
      `/teams/${unitMagazynId}`,
      { method: "PATCH", body: { key: "LOG" }, token: branchToken },
      { teamId: unitMagazynId },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data.key).toBe("LOG");

    const branchFinanse = await call(
      teamByIdRoute.PATCH,
      `/teams/${unitFinanseId}`,
      { method: "PATCH", body: { key: "FNS" }, token: branchToken },
      { teamId: unitFinanseId },
    );
    expect(branchFinanse.status).toBe(404);
  });

  it("osoba z samym issues.write widzi zespół (lista, statusy, etykiety, członkowie), dostaje 403 przy ustawieniach i 404 dla Finansów", async () => {
    await asSession(owner);
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "FIN" } });

    const writerRoleId = acme.addRole({
      name: "Tylko zapis zadań",
      product: "kivotasks",
      permissions: [KIVOTASKS_PERMISSIONS.keys["issues.write"]],
    }).id;
    const piotr = acme.addEmployee({
      firstName: "Piotr",
      lastName: "Zapisujący",
      products: ["kivotasks"],
      unitIds: [unitMagazynId],
    });
    acme.assignRole({
      accountId: piotr.accountId,
      roleId: writerRoleId,
      scope: { type: "UNIT", unitId: unitMagazynId },
    });
    const piotrToken = await tokenFor(piotr);

    // Odczyt zespołu Magazyn, statusów, etykiet i członków -> 200
    const teamsRes = await call(teamsRoute.GET, "/teams", { token: piotrToken });
    expect(teamsRes.status).toBe(200);
    expect(teamsRes.body.data.teams.map((t: { key: string }) => t.key)).toEqual(["MAG"]);

    expect(
      (await call(statesRoute.GET, `/teams/${unitMagazynId}/states`, { token: piotrToken }, { teamId: unitMagazynId }))
        .status,
    ).toBe(200);
    expect(
      (await call(labelsRoute.GET, `/teams/${unitMagazynId}/labels`, { token: piotrToken }, { teamId: unitMagazynId }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(
          membersRoute.GET,
          `/teams/${unitMagazynId}/members`,
          { token: piotrToken },
          { teamId: unitMagazynId },
        )
      ).status,
    ).toBe(200);

    // Zarządzanie zespołem Magazyn (widocznym, ale bez teams.manage) -> 403, nie 404
    expect(
      (
        await call(
          teamByIdRoute.PATCH,
          `/teams/${unitMagazynId}`,
          { method: "PATCH", body: { key: "LOG" }, token: piotrToken },
          { teamId: unitMagazynId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          statesRoute.POST,
          `/teams/${unitMagazynId}/states`,
          { method: "POST", body: { name: "Test", category: "STARTED", color: "blue" }, token: piotrToken },
          { teamId: unitMagazynId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          labelsRoute.POST,
          `/teams/${unitMagazynId}/labels`,
          { method: "POST", body: { name: "Pilne", color: "red" }, token: piotrToken },
          { teamId: unitMagazynId },
        )
      ).status,
    ).toBe(403);

    // Finanse (spoza zasięgu) -> 404 na odczycie i mutacjach
    expect(
      (await call(statesRoute.GET, `/teams/${unitFinanseId}/states`, { token: piotrToken }, { teamId: unitFinanseId }))
        .status,
    ).toBe(404);
    expect(
      (await call(labelsRoute.GET, `/teams/${unitFinanseId}/labels`, { token: piotrToken }, { teamId: unitFinanseId }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          membersRoute.GET,
          `/teams/${unitFinanseId}/members`,
          { token: piotrToken },
          { teamId: unitFinanseId },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          teamByIdRoute.PATCH,
          `/teams/${unitFinanseId}`,
          { method: "PATCH", body: { key: "FNS" }, token: piotrToken },
          { teamId: unitFinanseId },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          statesRoute.POST,
          `/teams/${unitFinanseId}/states`,
          { method: "POST", body: { name: "Test", category: "STARTED", color: "blue" }, token: piotrToken },
          { teamId: unitFinanseId },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          labelsRoute.POST,
          `/teams/${unitFinanseId}/labels`,
          { method: "POST", body: { name: "Pilne", color: "red" }, token: piotrToken },
          { teamId: unitFinanseId },
        )
      ).status,
    ).toBe(404);
  });

  it("GET /api/v1/teams/{teamId}/members zwraca wyłącznie aktywnych członków z kontem (także wielostronicowo)", async () => {
    await asSession(owner);
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });

    // Pracownik bez konta oraz były pracownik nie trafiają na listę członków z kontem
    acme.addEmployee({
      firstName: "Bez",
      lastName: "Konta",
      createAccount: false,
      unitIds: [unitMagazynId],
    });
    acme.addEmployee({
      firstName: "Były",
      lastName: "Pracownik",
      status: "FORMER",
      unitIds: [unitMagazynId],
    });
    const extra = acme.addEmployee({
      firstName: "Damian",
      lastName: "Dąb",
      products: ["kivotasks"],
      unitIds: [unitMagazynId],
    });

    fakeCore.setDirectoryPageSize(2);
    const annaToken = await tokenFor(anna);
    const res = await call(
      membersRoute.GET,
      `/teams/${unitMagazynId}/members`,
      { token: annaToken },
      { teamId: unitMagazynId },
    );
    expect(res.status).toBe(200);
    const accountIds = res.body.data.members.map((m: { accountId: string }) => m.accountId);
    expect(accountIds.sort()).toEqual([owner.accountId, anna.accountId, guest.accountId, extra.accountId].sort());
    expect(res.body.data.members[0]).toMatchObject({
      accountId: expect.any(String),
      employeeId: expect.any(String),
      firstName: expect.any(String),
      lastName: expect.any(String),
    });
  });
});

describe("API statusów obiegu i etykiet zespołu", () => {
  it("chroni status używany przez aktywne zadanie (409) oraz ostatni status BACKLOG/UNSTARTED (409)", async () => {
    await asSession(owner);
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });

    const branchToken = await tokenFor(branchAdmin);
    const statesBefore = (
      await call(statesRoute.GET, `/teams/${unitMagazynId}/states`, { token: branchToken }, { teamId: unitMagazynId })
    ).body.data.states as { id: string; category: string; name: string }[];

    const backlog = statesBefore.find((s) => s.category === "BACKLOG")!;
    const todo = statesBefore.find((s) => s.category === "UNSTARTED")!;
    const inProgress = statesBefore.find((s) => s.name === "W toku")!;

    // Tworzymy zadanie w statusie „W toku”
    const issue = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Zadanie blokujące usunięcie statusu", stateId: inProgress.id },
      token: branchToken,
    });
    expect(issue.status).toBe(201);

    // Próba usunięcia używanego statusu -> 409 CONFLICT
    const deleteInUse = await call(
      stateByIdRoute.DELETE,
      `/teams/${unitMagazynId}/states/${inProgress.id}`,
      { method: "DELETE", token: branchToken },
      { teamId: unitMagazynId, stateId: inProgress.id },
    );
    expect(deleteInUse.status).toBe(409);
    expect(deleteInUse.body.error.code).toBe("CONFLICT");

    // Po miękkim usunięciu zadania można usunąć status
    expect(
      (
        await call(
          issueByIdRoute.DELETE,
          `/issues/${issue.body.data.id}`,
          { method: "DELETE", token: branchToken },
          { issueId: issue.body.data.id },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await call(
          stateByIdRoute.DELETE,
          `/teams/${unitMagazynId}/states/${inProgress.id}`,
          { method: "DELETE", token: branchToken },
          { teamId: unitMagazynId, stateId: inProgress.id },
        )
      ).status,
    ).toBe(204);

    // Usunięcie Backlog udaje się, bo zostaje Do zrobienia (UNSTARTED)
    expect(
      (
        await call(
          stateByIdRoute.DELETE,
          `/teams/${unitMagazynId}/states/${backlog.id}`,
          { method: "DELETE", token: branchToken },
          { teamId: unitMagazynId, stateId: backlog.id },
        )
      ).status,
    ).toBe(204);

    // Próba usunięcia ostatniego statusu UNSTARTED albo zmiany jego kategorii na STARTED -> 409 CONFLICT
    expect(
      (
        await call(
          stateByIdRoute.DELETE,
          `/teams/${unitMagazynId}/states/${todo.id}`,
          { method: "DELETE", token: branchToken },
          { teamId: unitMagazynId, stateId: todo.id },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          stateByIdRoute.PATCH,
          `/teams/${unitMagazynId}/states/${todo.id}`,
          { method: "PATCH", body: { category: "STARTED" }, token: branchToken },
          { teamId: unitMagazynId, stateId: todo.id },
        )
      ).status,
    ).toBe(409);
  });

  it("obsługuje CRUD etykiet z unikalnością bez rozróżniania wielkości liter per zespół", async () => {
    await asSession(owner);
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });
    await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "FIN" } });

    const ownerToken = await tokenFor(owner);
    // Pozycja statusu ma górną granicę (kolumna INTEGER), więc zbyt duża daje 422, a nie błąd bazy
    const tooFar = await call(
      statesRoute.POST,
      `/teams/${unitMagazynId}/states`,
      {
        method: "POST",
        body: { name: "Daleko", category: "STARTED", color: "blue", position: 3_000_000_000 },
        token: ownerToken,
      },
      { teamId: unitMagazynId },
    );
    expect(tooFar.status).toBe(422);

    const created = await call(
      labelsRoute.POST,
      `/teams/${unitMagazynId}/labels`,
      { method: "POST", body: { name: "Pilne", color: "red" }, token: ownerToken },
      { teamId: unitMagazynId },
    );
    expect(created.status).toBe(201);

    // Duplikat różniący się wielkością liter w tym samym zespole -> 409 CONFLICT
    const duplicate = await call(
      labelsRoute.POST,
      `/teams/${unitMagazynId}/labels`,
      { method: "POST", body: { name: "pilne", color: "orange" }, token: ownerToken },
      { teamId: unitMagazynId },
    );
    expect(duplicate.status).toBe(409);

    // Ta sama nazwa w innym zespole jest dozwolona
    const otherTeam = await call(
      labelsRoute.POST,
      `/teams/${unitFinanseId}/labels`,
      { method: "POST", body: { name: "pilne", color: "red" }, token: ownerToken },
      { teamId: unitFinanseId },
    );
    expect(otherTeam.status).toBe(201);

    // Edycja i usunięcie etykiety zwalniają nazwę do ponownego użycia
    const updated = await call(
      labelByIdRoute.PATCH,
      `/teams/${unitMagazynId}/labels/${created.body.data.id}`,
      { method: "PATCH", body: { name: "Krytyczne", color: "pink" }, token: ownerToken },
      { teamId: unitMagazynId, labelId: created.body.data.id },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ name: "Krytyczne", color: "pink" });

    expect(
      (
        await call(
          labelByIdRoute.DELETE,
          `/teams/${unitMagazynId}/labels/${created.body.data.id}`,
          { method: "DELETE", token: ownerToken },
          { teamId: unitMagazynId, labelId: created.body.data.id },
        )
      ).status,
    ).toBe(204);

    const recreated = await call(
      labelsRoute.POST,
      `/teams/${unitMagazynId}/labels`,
      { method: "POST", body: { name: "Krytyczne", color: "red" }, token: ownerToken },
      { teamId: unitMagazynId },
    );
    expect(recreated.status).toBe(201);
  });
});
