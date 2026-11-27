/**
 * Testy tras zadań, relacji i wyszukiwania na prawdziwych handlerach Next.js z atrapą `createFakeCore`
 * na prawdziwym PostgreSQL z RLS (`prismaIssuesStore`, baza testowa z `vitest.config.ts`).
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
import * as issueByIdRoute from "@/app/api/v1/issues/[issueId]/route";
import * as relationsRoute from "@/app/api/v1/issues/[issueId]/relations/route";
import * as relationByIdRoute from "@/app/api/v1/issues/[issueId]/relations/[relationId]/route";
import * as issuesRoute from "@/app/api/v1/issues/route";
import * as searchRoute from "@/app/api/v1/search/route";
import * as teamByIdRoute from "@/app/api/v1/teams/[teamId]/route";
import * as labelsRoute from "@/app/api/v1/teams/[teamId]/labels/route";
import * as statesRoute from "@/app/api/v1/teams/[teamId]/states/route";
import * as stateByIdRoute from "@/app/api/v1/teams/[teamId]/states/[stateId]/route";
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
import {
  buildAssignmentNotificationIdempotencyKey,
  KIVOTASKS_ASSIGNMENT_NOTIFICATION_CATEGORY,
} from "@/server/notifications";
import { invalidatePermissionCache } from "@/server/permissions";
import {
  createFakeCoreWithUnitsFetch,
  type CapturedNotificationRequest,
  type NotificationFault,
} from "./helpers/fake-core-units";

const API = "http://kivo.localhost:3500";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.issues.test";
const CLIENT_ID = "kivotasks-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- w testach czytamy odpowiedzi API swobodnie
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
let capturedNotifications: CapturedNotificationRequest[] = [];
let notificationFault: NotificationFault | null = null;

let unitMagazynId: string;
let unitFinanseId: string;

let owner: CreatedEmployeeWithAccount;
let anna: CreatedEmployeeWithAccount;
let jan: CreatedEmployeeWithAccount;
let gosc: CreatedEmployeeWithAccount;
let finanseOnly: CreatedEmployeeWithAccount;

let ownerToken: string;
let annaToken: string;
let goscToken: string;

async function setupSession(employee: CreatedEmployeeWithAccount) {
  const coreToken = await acme.signUserToken(employee.accountId, { audience: fakeCore.coreApiUrl });
  const context = {
    accountId: employee.accountId,
    organizationId: acme.id,
    employeeId: employee.employeeId,
    sessionId: "sesja-issues-test",
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
  const spy = vi.spyOn(getAuth(), "authenticate").mockResolvedValue(authenticated);
  return () => spy.mockRestore();
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
  process.env.KIVOTASKS_APP_URL = "http://kivotasks.localhost:3500";
  delete process.env.KIVOTASKS_CORE_JWKS;
});

beforeEach(async () => {
  fakeCore.reset();
  capturedNotifications = [];
  notificationFault = null;
  setCoreRetryForTests(false);
  invalidatePermissionCache();
  resetMachineCoreTokenCache();

  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("kivotasks");

  const magazyn = acme.addUnit({ name: "Magazyn", type: "TEAM" });
  const finanse = acme.addUnit({ name: "Finanse", type: "TEAM" });
  unitMagazynId = magazyn.id;
  unitFinanseId = finanse.id;

  const memberRoleId = acme.addRole({
    name: "Członek KivoTasks",
    product: "kivotasks",
    permissions: [KIVOTASKS_PERMISSIONS.keys["issues.read"], KIVOTASKS_PERMISSIONS.keys["issues.write"]],
  }).id;
  const guestRoleId = acme.addRole({
    name: "Gość",
    product: "kivotasks",
    permissions: [KIVOTASKS_PERMISSIONS.keys["issues.read"]],
  }).id;

  owner = acme.addEmployee({
    firstName: "Ola",
    lastName: "Właścicielka",
    isOwner: true,
    unitIds: [unitMagazynId, unitFinanseId],
  });
  anna = acme.addEmployee({
    firstName: "Anna",
    lastName: "Nowak",
    products: ["kivotasks"],
    unitIds: [unitMagazynId],
  });
  jan = acme.addEmployee({
    firstName: "Jan",
    lastName: "Kowalski",
    products: ["kivotasks"],
    unitIds: [unitMagazynId],
  });
  gosc = acme.addEmployee({
    firstName: "Gość",
    lastName: "Magazynowy",
    products: ["kivotasks"],
    unitIds: [unitMagazynId],
  });
  finanseOnly = acme.addEmployee({
    firstName: "Ferdynand",
    lastName: "Faktura",
    products: ["kivotasks"],
    unitIds: [unitFinanseId],
  });

  // Anna ma write w Magazynie i tylko read w Finansach
  acme.assignRole({ accountId: anna.accountId, roleId: memberRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });
  acme.assignRole({ accountId: anna.accountId, roleId: guestRoleId, scope: { type: "UNIT", unitId: unitFinanseId } });

  // Gość ma tylko read w Magazynie (brak dostępu do Finansów)
  acme.assignRole({ accountId: gosc.accountId, roleId: guestRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });

  // Ferdynand ma write w Finansach
  acme.assignRole({
    accountId: finanseOnly.accountId,
    roleId: memberRoleId,
    scope: { type: "UNIT", unitId: unitFinanseId },
  });

  vi.spyOn(globalThis, "fetch").mockImplementation(
    createFakeCoreWithUnitsFetch(fakeCore, {
      onNotification: (captured) => capturedNotifications.push(captured),
      getNotificationFault: () => notificationFault,
    }),
  );

  // Zakładamy dwa zespoły: MAG i FIN
  const restore = await setupSession(owner);
  await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });
  await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "FIN" } });
  restore();

  ownerToken = await acme.signUserToken(owner.accountId, { audience: API });
  annaToken = await acme.signUserToken(anna.accountId, { audience: API });
  goscToken = await acme.signUserToken(gosc.accountId, { audience: API });
});

afterEach(() => {
  vi.restoreAllMocks();
  setCoreRetryForTests();
});

afterAll(() => {
  vi.restoreAllMocks();
  setCoreRetryForTests();
});

describe("zadania: numeracja, statusy domyślne, znaczniki czasu, przypisanie i identyfikatory", () => {
  it("przydziela kolejne numery, wybiera domyślny status (BACKLOG -> UNSTARTED), waliduje przypisanie i aktualizuje identyfikator po zmianie klucza", async () => {
    // 1. Tworzenie zadania bez stateId trafia w pierwszy BACKLOG
    const first = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: {
        teamId: unitMagazynId,
        title: "Przegląd strefy przyjęć",
        description: "Sprawdzić bramę numer 2",
        priority: 2,
        assigneeAccountId: jan.accountId,
        dueDate: "2026-12-05",
        estimate: 3,
      },
      token: annaToken,
    });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      identifier: "MAG-1",
      number: 1,
      title: "Przegląd strefy przyjęć",
      assigneeAccountId: jan.accountId,
      creatorAccountId: anna.accountId,
      dueDate: "2026-12-05",
      estimate: 3,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
    });
    expect(first.body.data.state.category).toBe("BACKLOG");

    // 2. Walidacja assignee: osoba spoza zespołu oraz pracownik bez konta -> 422 VALIDATION_FAILED
    const wrongMember = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Błędny assignee", assigneeAccountId: finanseOnly.accountId },
      token: annaToken,
    });
    expect(wrongMember.status).toBe(422);
    expect(wrongMember.body.error.code).toBe("VALIDATION_FAILED");

    acme.addEmployee({ firstName: "Bez", lastName: "Konta", createAccount: false, unitIds: [unitMagazynId] });
    const fakeAccountId = "019a0000-0000-7000-8000-000000001111";
    const unknownAccount = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Nieznane konto", assigneeAccountId: fakeAccountId },
      token: annaToken,
    });
    expect(unknownAccount.status).toBe(422);

    // 3. Odczyt po identyfikatorze bez rozróżniania wielkości liter i po UUID
    const byIdLower = await call(issueByIdRoute.GET, "/issues/mag-1", { token: goscToken }, { issueId: "mag-1" });
    expect(byIdLower.status).toBe(200);
    expect(byIdLower.body.data.id).toBe(first.body.data.id);

    // 4. Przejścia statusów automatycznie ustawiają i czyszczą startedAt / completedAt / canceledAt
    const magStates = (
      await call(statesRoute.GET, `/teams/${unitMagazynId}/states`, { token: ownerToken }, { teamId: unitMagazynId })
    ).body.data.states as { id: string; category: string; name: string }[];
    const backlog = magStates.find((s) => s.category === "BACKLOG")!;
    const todo = magStates.find((s) => s.category === "UNSTARTED")!;
    const inProgress = magStates.find((s) => s.name === "W toku")!;
    const done = magStates.find((s) => s.category === "COMPLETED")!;
    const canceled = magStates.find((s) => s.category === "CANCELED")!;

    const started = await call(
      issueByIdRoute.PATCH,
      `/issues/${first.body.data.id}`,
      { method: "PATCH", body: { stateId: inProgress.id }, token: annaToken },
      { issueId: first.body.data.id },
    );
    expect(started.body.data.startedAt).not.toBeNull();
    expect(started.body.data.completedAt).toBeNull();

    const finished = await call(
      issueByIdRoute.PATCH,
      `/issues/${first.body.data.id}`,
      { method: "PATCH", body: { stateId: done.id }, token: annaToken },
      { issueId: first.body.data.id },
    );
    expect(finished.body.data.startedAt).toBe(started.body.data.startedAt);
    expect(finished.body.data.completedAt).not.toBeNull();
    expect(finished.body.data.canceledAt).toBeNull();

    const cancelled = await call(
      issueByIdRoute.PATCH,
      `/issues/${first.body.data.id}`,
      { method: "PATCH", body: { stateId: canceled.id }, token: annaToken },
      { issueId: first.body.data.id },
    );
    expect(cancelled.body.data.completedAt).toBeNull();
    expect(cancelled.body.data.canceledAt).not.toBeNull();

    const resetToTodo = await call(
      issueByIdRoute.PATCH,
      `/issues/${first.body.data.id}`,
      { method: "PATCH", body: { stateId: todo.id }, token: annaToken },
      { issueId: first.body.data.id },
    );
    expect(resetToTodo.body.data).toMatchObject({ startedAt: null, completedAt: null, canceledAt: null });

    // 5. Po usunięciu statusu BACKLOG domyślnym statusem staje się pierwszy UNSTARTED
    expect(
      (
        await call(
          stateByIdRoute.DELETE,
          `/teams/${unitMagazynId}/states/${backlog.id}`,
          { method: "DELETE", token: ownerToken },
          { teamId: unitMagazynId, stateId: backlog.id },
        )
      ).status,
    ).toBe(204);

    const second = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Drugie zadanie" },
      token: annaToken,
    });
    expect(second.status).toBe(201);
    expect(second.body.data.identifier).toBe("MAG-2");
    expect(second.body.data.state.id).toBe(todo.id);

    // 6. Przeniesienie zadania do innego zespołu zwraca 422 VALIDATION_FAILED
    const moveTeam = await call(
      issueByIdRoute.PATCH,
      `/issues/${second.body.data.id}`,
      { method: "PATCH", body: { teamId: unitFinanseId }, token: ownerToken },
      { issueId: second.body.data.id },
    );
    expect(moveTeam.status).toBe(422);
    expect(moveTeam.body.error.code).toBe("VALIDATION_FAILED");

    // 7. Zmiana klucza zespołu z MAG na LOG aktualizuje identyfikatory zadań
    await call(
      teamByIdRoute.PATCH,
      `/teams/${unitMagazynId}`,
      { method: "PATCH", body: { key: "LOG" }, token: ownerToken },
      { teamId: unitMagazynId },
    );
    expect((await call(issueByIdRoute.GET, "/issues/log-2", { token: annaToken }, { issueId: "log-2" })).status).toBe(
      200,
    );
    expect((await call(issueByIdRoute.GET, "/issues/mag-2", { token: annaToken }, { issueId: "mag-2" })).status).toBe(
      404,
    );
  });

  it("wymusza uprawnienia na zespołach i zwraca 404 przed 403 dla zadań spoza zasięgu", async () => {
    const finIssue = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitFinanseId, title: "Poufny raport finansowy" },
      token: ownerToken,
    });
    const magIssue = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Inwentaryzacja" },
      token: ownerToken,
    });

    // Gość widzi Magazyn (brak write -> 403), nie widzi Finansów (404 przed 403)
    expect(
      (
        await call(
          issueByIdRoute.PATCH,
          `/issues/${magIssue.body.data.id}`,
          { method: "PATCH", body: { title: "Zmiana" }, token: goscToken },
          { issueId: magIssue.body.data.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          issueByIdRoute.PATCH,
          `/issues/${finIssue.body.data.id}`,
          { method: "PATCH", body: { title: "Zmiana" }, token: goscToken },
          { issueId: finIssue.body.data.id },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(issuesRoute.POST, "/issues", {
          method: "POST",
          body: { teamId: unitFinanseId, title: "Próba utworzenia" },
          token: goscToken,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(issuesRoute.POST, "/issues", {
          method: "POST",
          body: { teamId: unitMagazynId, title: "Próba utworzenia" },
          token: goscToken,
        })
      ).status,
    ).toBe(403);
  });

  it("osoba z samym issues.write widzi i czyta zadania ze swojego zespołu, a dla obcego dostaje 404", async () => {
    const writerRoleId = acme.addRole({
      name: "Tylko zapis",
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
    const piotrToken = await acme.signUserToken(piotr.accountId, { audience: API });

    const finIssue = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitFinanseId, title: "Poufne palety finansowe" },
        token: ownerToken,
      })
    ).body.data;

    const created = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Wymiana palet" },
      token: piotrToken,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.identifier).toBe("MAG-1");

    const updated = await call(
      issueByIdRoute.PATCH,
      `/issues/${created.body.data.id}`,
      { method: "PATCH", body: { title: "Wymiana palet w strefie B" }, token: piotrToken },
      { issueId: created.body.data.id },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe("Wymiana palet w strefie B");

    // GET /issues?teamId=... zwraca zadania Magazynu (200), bez Finansów
    const listed = await call(issuesRoute.GET, `/issues?teamId=${unitMagazynId}`, { token: piotrToken });
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((item: { id: string }) => item.id)).toEqual([created.body.data.id]);

    // GET /issues/MAG-1 -> 200; GET /issues/FIN-1 -> 404
    const fetched = await call(issueByIdRoute.GET, "/issues/MAG-1", { token: piotrToken }, { issueId: "MAG-1" });
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.id).toBe(created.body.data.id);

    expect((await call(issueByIdRoute.GET, "/issues/FIN-1", { token: piotrToken }, { issueId: "FIN-1" })).status).toBe(
      404,
    );
    expect(
      (await call(issueByIdRoute.GET, `/issues/${finIssue.id}`, { token: piotrToken }, { issueId: finIssue.id }))
        .status,
    ).toBe(404);

    // GET /search -> 200 i zawiera tylko zadania z Magazynu
    const searched = await call(searchRoute.GET, "/search?q=palet", { token: piotrToken });
    expect(searched.status).toBe(200);
    expect(searched.body.data.issues.map((item: { id: string }) => item.id)).toEqual([created.body.data.id]);
  });
});

describe("podzadania, cykle i relacje między zadaniami", () => {
  it("usunięcie zadania nadrzędnego odpina jego podzadania, które wracają na listę zadań głównych", async () => {
    const parent = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Remont rampy" },
        token: ownerToken,
      })
    ).body.data;
    const child = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Zamówić beton", parentId: parent.id },
        token: ownerToken,
      })
    ).body.data;

    const deleted = await call(
      issueByIdRoute.DELETE,
      `/issues/${parent.id}`,
      { method: "DELETE", token: ownerToken },
      { issueId: parent.id },
    );
    expect(deleted.status).toBe(204);

    const fetched = await call(issueByIdRoute.GET, `/issues/${child.id}`, { token: ownerToken }, { issueId: child.id });
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.parentId).toBeNull();
    expect(fetched.body.data.parent).toBeNull();

    const topLevel = await call(issuesRoute.GET, `/issues?teamId=${unitMagazynId}&parentId=none`, {
      token: ownerToken,
    });
    expect(topLevel.status).toBe(200);
    expect(topLevel.body.data.map((issue: { id: string }) => issue.id)).toContain(child.id);
  });

  it("obsługuje podzadania w tym samym zespole oraz blokuje podzadania między zespołami i cykle", async () => {
    const a = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Zadanie A" },
        token: ownerToken,
      })
    ).body.data;
    const b = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Zadanie B", parentId: a.id },
        token: ownerToken,
      })
    ).body.data;
    const c = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Zadanie C", parentId: b.id },
        token: ownerToken,
      })
    ).body.data;
    const fin = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitFinanseId, title: "Zadanie Finanse" },
        token: ownerToken,
      })
    ).body.data;

    // Szczegóły A zawierają dziecko B; szczegóły B zawierają rodzica A i dziecko C
    const detailB = (await call(issueByIdRoute.GET, `/issues/${b.id}`, { token: annaToken }, { issueId: b.id })).body
      .data;
    expect(detailB.parent.id).toBe(a.id);
    expect(detailB.children.map((child: { id: string }) => child.id)).toEqual([c.id]);

    // Rodzic z innego zespołu -> 422
    expect(
      (
        await call(issuesRoute.POST, "/issues", {
          method: "POST",
          body: { teamId: unitMagazynId, title: "Zły rodzic", parentId: fin.id },
          token: ownerToken,
        })
      ).status,
    ).toBe(422);

    // Self-parent -> 422
    expect(
      (
        await call(
          issueByIdRoute.PATCH,
          `/issues/${a.id}`,
          { method: "PATCH", body: { parentId: a.id }, token: ownerToken },
          { issueId: a.id },
        )
      ).status,
    ).toBe(422);

    // Cykl 3-elementowy A -> B -> C -> A -> 409 CONFLICT
    const cycleRes = await call(
      issueByIdRoute.PATCH,
      `/issues/${a.id}`,
      { method: "PATCH", body: { parentId: c.id }, token: ownerToken },
      { issueId: a.id },
    );
    expect(cycleRes.status).toBe(409);
    expect(cycleRes.body.error.code).toBe("CONFLICT");
  });

  it("obsługuje relacje BLOCKS/BLOCKED_BY, RELATED, DUPLICATE oraz uprawnienia relacji między zespołami", async () => {
    const mag = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Przygotowanie magazynu" },
        token: ownerToken,
      })
    ).body.data;
    const fin = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitFinanseId, title: "Zatwierdzenie budżetu" },
        token: ownerToken,
      })
    ).body.data;

    // Self-relation -> 422
    expect(
      (
        await call(
          relationsRoute.POST,
          `/issues/${mag.id}/relations`,
          { method: "POST", body: { relatedIssueId: mag.id, type: "BLOCKS" }, token: ownerToken },
          { issueId: mag.id },
        )
      ).status,
    ).toBe(422);

    // Anna ma write w Magazynie, ale tylko read w Finansach -> relacja między zespołami daje 403
    expect(
      (
        await call(
          relationsRoute.POST,
          `/issues/${mag.id}/relations`,
          { method: "POST", body: { relatedIssueId: fin.id, type: "BLOCKS" }, token: annaToken },
          { issueId: mag.id },
        )
      ).status,
    ).toBe(403);

    // Gość nie widzi Finansów -> 404 przed 403
    expect(
      (
        await call(
          relationsRoute.POST,
          `/issues/${mag.id}/relations`,
          { method: "POST", body: { relatedIssueId: fin.id, type: "BLOCKS" }, token: goscToken },
          { issueId: mag.id },
        )
      ).status,
    ).toBe(404);

    // Owner ma write w obu zespołach -> dodaje relację FIN BLOCKS MAG (przez BLOCKED_BY z perspektywy MAG)
    const rel = await call(
      relationsRoute.POST,
      `/issues/${mag.id}/relations`,
      { method: "POST", body: { relatedIssueId: fin.id, type: "BLOCKED_BY" }, token: ownerToken },
      { issueId: mag.id },
    );
    expect(rel.status).toBe(201);
    expect(rel.body.data).toMatchObject({ type: "BLOCKED_BY", direction: "INCOMING" });
    expect(rel.body.data.relatedIssue.id).toBe(fin.id);

    // Duplikat tej samej relacji (jako BLOCKS od strony FIN) -> 409 CONFLICT
    expect(
      (
        await call(
          relationsRoute.POST,
          `/issues/${fin.id}/relations`,
          { method: "POST", body: { relatedIssueId: mag.id, type: "BLOCKS" }, token: ownerToken },
          { issueId: fin.id },
        )
      ).status,
    ).toBe(409);

    // Z perspektywy FIN relacja jest BLOCKS (OUTGOING), a z perspektywy MAG: BLOCKED_BY (INCOMING)
    const finDetail = (await call(issueByIdRoute.GET, `/issues/${fin.id}`, { token: ownerToken }, { issueId: fin.id }))
      .body.data;
    expect(finDetail.relations).toHaveLength(1);
    expect(finDetail.relations[0]).toMatchObject({ type: "BLOCKS", direction: "OUTGOING" });

    // Gość nie widzi zespołu FIN, więc relacja do zadania z FIN nie wycieka w szczegółach zadania MAG
    const goscMagDetail = (
      await call(issueByIdRoute.GET, `/issues/${mag.id}`, { token: goscToken }, { issueId: mag.id })
    ).body.data;
    expect(goscMagDetail.relations).toEqual([]);

    // Symetryczna relacja RELATED odrzuca duplikat w drugą stronę (409)
    const related = await call(
      relationsRoute.POST,
      `/issues/${mag.id}/relations`,
      { method: "POST", body: { relatedIssueId: fin.id, type: "RELATED" }, token: ownerToken },
      { issueId: mag.id },
    );
    expect(related.status).toBe(201);
    expect(
      (
        await call(
          relationsRoute.POST,
          `/issues/${fin.id}/relations`,
          { method: "POST", body: { relatedIssueId: mag.id, type: "RELATED" }, token: ownerToken },
          { issueId: fin.id },
        )
      ).status,
    ).toBe(409);

    // Usunięcie relacji wymaga write w obu zespołach: Anna dostaje 403, Owner usuwa 204
    expect(
      (
        await call(
          relationByIdRoute.DELETE,
          `/issues/${mag.id}/relations/${rel.body.data.id}`,
          { method: "DELETE", token: annaToken },
          { issueId: mag.id, relationId: rel.body.data.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          relationByIdRoute.DELETE,
          `/issues/${mag.id}/relations/${rel.body.data.id}`,
          { method: "DELETE", token: ownerToken },
          { issueId: mag.id, relationId: rel.body.data.id },
        )
      ).status,
    ).toBe(204);
  });
});

describe("filtrowanie, sortowanie, stronicowanie kursorowe i ranking wyszukiwania", () => {
  it("filtruje listę zadań, obsługuje includeCompleted, wszystkie 5 sortowań i spójne stronicowanie kursorowe", async () => {
    const magStates = (
      await call(statesRoute.GET, `/teams/${unitMagazynId}/states`, { token: ownerToken }, { teamId: unitMagazynId })
    ).body.data.states as { id: string; category: string }[];
    const doneState = magStates.find((s) => s.category === "COMPLETED")!;
    const startedState = magStates.find((s) => s.category === "STARTED")!;

    const labelUrgent = (
      await call(
        labelsRoute.POST,
        `/teams/${unitMagazynId}/labels`,
        { method: "POST", body: { name: "Bramy", color: "red" }, token: ownerToken },
        { teamId: unitMagazynId },
      )
    ).body.data;

    // 4 otwarte zadania w Magazynie + 1 ukończone w Magazynie + 1 otwarte w Finansach
    const i1 = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: {
          teamId: unitMagazynId,
          title: "Brak priorytetu",
          priority: 0,
          dueDate: null,
          assigneeAccountId: anna.accountId,
        },
        token: ownerToken,
      })
    ).body.data;
    const i2 = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: {
          teamId: unitMagazynId,
          title: "Pilna naprawa bramy",
          priority: 1,
          stateId: startedState.id,
          dueDate: "2026-12-01",
          labelIds: [labelUrgent.id],
          assigneeAccountId: jan.accountId,
        },
        token: ownerToken,
      })
    ).body.data;
    const i3 = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: {
          teamId: unitMagazynId,
          title: "Średni przegląd",
          priority: 3,
          dueDate: "2026-12-10",
          parentId: i2.id,
        },
        token: ownerToken,
      })
    ).body.data;
    const i4 = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Wysoki priorytet", priority: 2, dueDate: "2026-12-03" },
        token: ownerToken,
      })
    ).body.data;
    const iDone = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Zakończone zadanie", stateId: doneState.id, priority: 1 },
        token: ownerToken,
      })
    ).body.data;
    const iFin = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitFinanseId, title: "Faktura roczna", priority: 1 },
        token: ownerToken,
      })
    ).body.data;

    // Ręczna kolejność na tablicy (manual)
    await call(
      issueByIdRoute.PATCH,
      `/issues/${i4.id}`,
      { method: "PATCH", body: { sortOrder: 500 }, token: ownerToken },
      { issueId: i4.id },
    );

    // Gość widzi tylko Magazyn (4 otwarte, bez iDone i bez iFin)
    const guestDefault = await call(issuesRoute.GET, "/issues", { token: goscToken });
    expect(guestDefault.status).toBe(200);
    expect(guestDefault.body.data).toHaveLength(4);
    expect(guestDefault.body.data.some((item: { id: string }) => item.id === iFin.id || item.id === iDone.id)).toBe(
      false,
    );

    // includeCompleted=true oraz jawny filtr stateCategory=COMPLETED dołączają ukończone
    expect((await call(issuesRoute.GET, "/issues?includeCompleted=true", { token: goscToken })).body.data).toHaveLength(
      5,
    );
    expect(
      (await call(issuesRoute.GET, "/issues?stateCategory=COMPLETED", { token: goscToken })).body.data.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([iDone.id]);

    // Filtry: assignee=me, assignee=none, labelId, priority, parentId
    expect(
      (await call(issuesRoute.GET, "/issues?assignee=me", { token: annaToken })).body.data.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([i1.id]);
    expect(
      (await call(issuesRoute.GET, `/issues?teamId=${unitMagazynId}&assignee=none`, { token: ownerToken })).body.data
        .length,
    ).toBe(2);
    expect(
      (await call(issuesRoute.GET, `/issues?labelId=${labelUrgent.id}`, { token: ownerToken })).body.data.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([i2.id]);
    expect(
      (await call(issuesRoute.GET, `/issues?parentId=${i2.id}`, { token: ownerToken })).body.data.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([i3.id]);

    // Sortowanie priority (1 -> 2 -> 3 -> 0) ze stronicowaniem kursorowym limit=2
    const seenPriority: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor
        ? `/issues?teamId=${unitMagazynId}&sort=priority&limit=2&cursor=${encodeURIComponent(cursor)}`
        : `/issues?teamId=${unitMagazynId}&sort=priority&limit=2`;
      const page = await call(issuesRoute.GET, qs, { token: ownerToken });
      expect(page.status).toBe(200);
      seenPriority.push(...page.body.data.map((x: { id: string }) => x.id));
      cursor = (page.body.meta.nextCursor as string | null) ?? null;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(2);
    expect(seenPriority).toEqual([i2.id, i4.id, i3.id, i1.id]);

    // Sortowanie dueDate (najwcześniejsze najpierw, null na końcu) ze stronicowaniem
    const dueIds: string[] = [];
    cursor = null;
    do {
      const qs: string = cursor
        ? `/issues?teamId=${unitMagazynId}&sort=dueDate&limit=2&cursor=${encodeURIComponent(cursor)}`
        : `/issues?teamId=${unitMagazynId}&sort=dueDate&limit=2`;
      const page = await call(issuesRoute.GET, qs, { token: ownerToken });
      dueIds.push(...page.body.data.map((x: { id: string }) => x.id));
      cursor = (page.body.meta.nextCursor as string | null) ?? null;
    } while (cursor !== null);
    expect(dueIds).toEqual([i2.id, i4.id, i3.id, i1.id]);

    // Sortowanie manual: i4 (sortOrder 500) przed i1 (1000), i2 (2000), i3 (3000)
    const manualRes = await call(issuesRoute.GET, `/issues?teamId=${unitMagazynId}&sort=manual`, { token: ownerToken });
    expect(manualRes.body.data.map((x: { id: string }) => x.id)).toEqual([i4.id, i1.id, i2.id, i3.id]);

    // Kursor z innego sortowania -> 422 VALIDATION_FAILED
    const firstPage = await call(issuesRoute.GET, `/issues?teamId=${unitMagazynId}&sort=updated&limit=1`, {
      token: ownerToken,
    });
    const wrongSort = await call(
      issuesRoute.GET,
      `/issues?teamId=${unitMagazynId}&sort=priority&cursor=${encodeURIComponent(firstPage.body.meta.nextCursor)}`,
      { token: ownerToken },
    );
    expect(wrongSort.status).toBe(422);
  });

  it("GET /api/v1/search stawia dokładny identyfikator na 1. miejscu, a dalej wyniki pełnotekstowe (tytuł przed opisem, maks. 20)", async () => {
    // MAG-1: tytuł zawiera słowo "brama"
    const m1 = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Naprawa bramy głównej", description: "Szczegóły techniczne" },
        token: ownerToken,
      })
    ).body.data;
    // MAG-2: zadanie docelowe dla identyfikatora MAG-2
    const m2 = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: {
          teamId: unitMagazynId,
          title: "Kontrola regałów",
          description: "Brama wjazdowa z tyłu wymaga smarowania",
        },
        token: ownerToken,
      })
    ).body.data;
    // MAG-3: wspomina "MAG-2" w tytule — mimo to przy szukaniu "mag-2" MAG-2 musi być pierwsze!
    const m3 = (
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: "Zależne od MAG-2 działanie", description: "Kontynuacja" },
        token: ownerToken,
      })
    ).body.data;
    // FIN-1: zawiera słowo "bramy", ale Gość nie ma dostępu do Finansów
    await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitFinanseId, title: "Kosztorys bramy" },
      token: ownerToken,
    });

    // 1. Dokładny identyfikator (case-insensitive) zawsze na 1. pozycji
    const byIdentifier = await call(searchRoute.GET, "/search?q=mag-2", { token: goscToken });
    expect(byIdentifier.status).toBe(200);
    expect(byIdentifier.body.data.issues.map((i: { id: string }) => i.id)).toEqual([m2.id, m3.id]);

    // 2. Wyszukiwanie pełnotekstowe: trafienie w tytule (MAG-1) przed trafieniem wyłącznie w opisie (MAG-2)
    // oraz brak wyników z niedostępnego zespołu FIN
    const byText = await call(searchRoute.GET, "/search?q=bram", { token: goscToken });
    expect(byText.status).toBe(200);
    expect(byText.body.data.issues.map((i: { id: string }) => i.id)).toEqual([m1.id, m2.id]);

    // 3. Limit 20 wyników
    for (let i = 0; i < 24; i++) {
      await call(issuesRoute.POST, "/issues", {
        method: "POST",
        body: { teamId: unitMagazynId, title: `Inwentaryzacja strefy ${i}` },
        token: ownerToken,
      });
    }
    const capped = await call(searchRoute.GET, "/search?q=inwentaryzacja", { token: goscToken });
    expect(capped.status).toBe(200);
    expect(capped.body.data.issues).toHaveLength(20);
  });
});

describe("powiadomienia e-mail o przypisaniu zadania (Core notifications)", () => {
  it("wysyła jedno powiadomienie po utworzeniu zadania z osobą przypisaną i po zmianie osoby przypisanej", async () => {
    const created = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: {
        teamId: unitMagazynId,
        title: "Przegląd wózków widłowych",
        assigneeAccountId: jan.accountId,
      },
      token: annaToken,
    });
    expect(created.status).toBe(201);
    expect(capturedNotifications).toHaveLength(1);
    expect(capturedNotifications[0]).toMatchObject({
      organizationId: acme.id,
      idempotencyKey: buildAssignmentNotificationIdempotencyKey({
        issueId: created.body.data.id,
        assigneeAccountId: jan.accountId,
        updatedAt: created.body.data.updatedAt,
      }),
      body: {
        recipientAccountId: jan.accountId,
        category: KIVOTASKS_ASSIGNMENT_NOTIFICATION_CATEGORY,
        title: "Nowe zadanie dla Ciebie: MAG-1",
        body: "Zadanie „Przegląd wózków widłowych” w zespole Magazyn. Przypisanie: Anna Nowak.",
        actionUrl: "http://kivotasks.localhost:3500/issue/MAG-1",
      },
    });

    // Ponowne przypisanie do nowej osoby (Anna przez Ownera) wysyła jedno powiadomienie do Anny
    const reassigned = await call(
      issueByIdRoute.PATCH,
      `/issues/${created.body.data.id}`,
      {
        method: "PATCH",
        body: { assigneeAccountId: anna.accountId },
        token: ownerToken,
      },
      { issueId: created.body.data.id },
    );
    expect(reassigned.status).toBe(200);
    expect(capturedNotifications).toHaveLength(2);
    expect(capturedNotifications[1]).toMatchObject({
      organizationId: acme.id,
      idempotencyKey: buildAssignmentNotificationIdempotencyKey({
        issueId: reassigned.body.data.id,
        assigneeAccountId: anna.accountId,
        updatedAt: reassigned.body.data.updatedAt,
      }),
      body: {
        recipientAccountId: anna.accountId,
        category: KIVOTASKS_ASSIGNMENT_NOTIFICATION_CATEGORY,
        title: "Nowe zadanie dla Ciebie: MAG-1",
        body: "Zadanie „Przegląd wózków widłowych” w zespole Magazyn. Przypisanie: Ola Właścicielka.",
        actionUrl: "http://kivotasks.localhost:3500/issue/MAG-1",
      },
    });
    expect(capturedNotifications[1]?.idempotencyKey).not.toBe(capturedNotifications[0]?.idempotencyKey);
  });

  it("nie wysyła powiadomienia przy przypisaniu sobie, braku zmiany osoby przypisanej, odpięciu ani błędzie zapisu", async () => {
    // 1. Utworzenie zadania bez assignee
    const unassigned = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Zadanie bez przypisania" },
      token: annaToken,
    });
    expect(unassigned.status).toBe(201);
    expect(capturedNotifications).toHaveLength(0);

    // 2. Utworzenie zadania z przypisaniem sobie
    const selfCreated = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Moje własne zadanie", assigneeAccountId: anna.accountId },
      token: annaToken,
    });
    expect(selfCreated.status).toBe(201);
    expect(capturedNotifications).toHaveLength(0);

    // 3. Przypisanie sobie przez PATCH
    const selfUpdated = await call(
      issueByIdRoute.PATCH,
      `/issues/${unassigned.body.data.id}`,
      { method: "PATCH", body: { assigneeAccountId: anna.accountId }, token: annaToken },
      { issueId: unassigned.body.data.id },
    );
    expect(selfUpdated.status).toBe(200);
    expect(capturedNotifications).toHaveLength(0);

    // 4. PATCH z tą samą osobą przypisaną (nawet przez kogoś innego)
    const sameAssignee = await call(
      issueByIdRoute.PATCH,
      `/issues/${unassigned.body.data.id}`,
      { method: "PATCH", body: { assigneeAccountId: anna.accountId }, token: ownerToken },
      { issueId: unassigned.body.data.id },
    );
    expect(sameAssignee.status).toBe(200);
    expect(capturedNotifications).toHaveLength(0);

    // 5. PATCH bez pola assigneeAccountId (zmiana samego tytułu)
    const titleOnly = await call(
      issueByIdRoute.PATCH,
      `/issues/${unassigned.body.data.id}`,
      { method: "PATCH", body: { title: "Nowy tytuł" }, token: ownerToken },
      { issueId: unassigned.body.data.id },
    );
    expect(titleOnly.status).toBe(200);
    expect(capturedNotifications).toHaveLength(0);

    // 6. Odpięcie osoby przypisanej (null)
    const cleared = await call(
      issueByIdRoute.PATCH,
      `/issues/${unassigned.body.data.id}`,
      { method: "PATCH", body: { assigneeAccountId: null }, token: ownerToken },
      { issueId: unassigned.body.data.id },
    );
    expect(cleared.status).toBe(200);
    expect(capturedNotifications).toHaveLength(0);

    // 7. Błąd zapisu w bazie (nieistniejący status) mimo poprawnego assignee -> brak powiadomienia
    const failedDb = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: {
        teamId: unitMagazynId,
        title: "Nieudany zapis",
        stateId: "019a0000-0000-7000-8000-000000009999",
        assigneeAccountId: jan.accountId,
      },
      token: annaToken,
    });
    expect(failedDb.status).toBe(422);
    expect(capturedNotifications).toHaveLength(0);
  });

  it("pomija zdanie o osobie przypisującej, gdy nie ma jej imienia ani w sesji, ani w katalogu zespołu", async () => {
    const outsideAdminRoleId = acme.addRole({
      name: "Admin firmy",
      product: "kivotasks",
      permissions: [KIVOTASKS_PERMISSIONS.keys["issues.read"], KIVOTASKS_PERMISSIONS.keys["issues.write"]],
    }).id;
    const outsideAdmin = acme.addEmployee({
      firstName: "Karol",
      lastName: "Spoza",
      products: ["kivotasks"],
      unitIds: [unitFinanseId],
    });
    acme.assignRole({
      accountId: outsideAdmin.accountId,
      roleId: outsideAdminRoleId,
      scope: { type: "ORGANIZATION" },
    });
    const outsideToken = await acme.signUserToken(outsideAdmin.accountId, { audience: API });

    const created = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Audyt regałów", assigneeAccountId: jan.accountId },
      token: outsideToken,
    });
    expect(created.status).toBe(201);
    expect(capturedNotifications).toHaveLength(1);
    expect(capturedNotifications[0]?.body.body).toBe("Zadanie „Audyt regałów” w zespole Magazyn.");

    // Gdy ta sama osoba spoza zespołu przypisuje przez sesję BFF, nazwa pochodzi z profilu sesji
    const restoreSession = await setupSession(outsideAdmin);
    try {
      const reassigned = await call(
        issueByIdRoute.PATCH,
        `/issues/${created.body.data.id}`,
        { method: "PATCH", body: { assigneeAccountId: anna.accountId } },
        { issueId: created.body.data.id },
      );
      expect(reassigned.status).toBe(200);
      expect(capturedNotifications).toHaveLength(2);
      expect(capturedNotifications[1]?.body.body).toBe(
        "Zadanie „Audyt regałów” w zespole Magazyn. Przypisanie: Karol Spoza.",
      );
    } finally {
      restoreSession();
    }
  });

  it("nie przerywa utworzenia ani aktualizacji zadania, gdy Core zwróci 500 albo błąd sieci", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 1. Core 500 przy tworzeniu zadania
    notificationFault = { status: 500 };
    const created = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Awaria powiadomień 500", assigneeAccountId: jan.accountId },
      token: annaToken,
    });
    expect(created.status).toBe(201);
    expect(capturedNotifications).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain("Anna Nowak");
    expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain(CLIENT_SECRET);

    // 2. Błąd sieci przy zmianie osoby przypisanej
    notificationFault = { networkError: true };
    const updated = await call(
      issueByIdRoute.PATCH,
      `/issues/${created.body.data.id}`,
      { method: "PATCH", body: { assigneeAccountId: anna.accountId }, token: ownerToken },
      { issueId: created.body.data.id },
    );
    expect(updated.status).toBe(200);
    expect(capturedNotifications).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1]?.[0])).not.toContain("Ola Właścicielka");
  });
});
