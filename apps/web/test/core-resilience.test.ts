/**
 * Testy odporności serwera KivoTasks na krótkie awarie MonoriseCore (ponawianie w `@monorise-team/sdk`,
 * bezpieczna odmowa 503 po wyczerpaniu prób) oraz wielostronicowego katalogu Core (`directoryPageSize`).
 *
 * Testy działają na trasie `/api/v1/me` oraz kliencie maszynowym `getMachineCoreClient()` z atrapą
 * `createFakeCore` podpiętą pod `globalThis.fetch`, bez bazy PostgreSQL i bez gniazd TCP.
 */
import type { Authenticated, Session } from "@monorise-team/auth/next";
import { paginate } from "@monorise-team/sdk";
import {
  checkErrorEnvelope,
  createFakeCore,
  type CreatedEmployeeWithAccount,
  type FakeCore,
  type FakeOrganizationBuilder,
} from "@monorise-team/testing";
import { KIVOTASKS_PERMISSIONS } from "@kivotasks/contracts";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as me from "@/app/api/v1/me/route";
import { getAuth } from "@/server/auth";
import {
  DEFAULT_CORE_RETRY,
  getMachineCoreClient,
  resetMachineCoreTokenCache,
  setCoreRetryForTests,
} from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import { invalidatePermissionCache } from "@/server/permissions";

const API = "http://kivo.localhost:3500";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.resilience.test";
const CLIENT_ID = "kivotasks-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";
const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 } as const;

function call(
  handler: (request: NextRequest, context: { params: Promise<Record<string, never>> }) => Promise<Response>,
  path: string,
  init: { token?: string } = {},
) {
  const headers: Record<string, string> = { host: "kivo.localhost:3500" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const request = new NextRequest(`${BASE}${path}`, { method: "GET", headers });
  return handler(request, { params: Promise.resolve({}) });
}

function mockBrowserSession(
  employee: CreatedEmployeeWithAccount,
  organizationId: string,
  coreAccessToken: string,
  authzRevision = employee.account.authzRevision,
) {
  const context = {
    accountId: employee.accountId,
    organizationId,
    employeeId: employee.employeeId,
    sessionId: "sesja-resilience",
    authzRevision,
    methods: [],
    clientId: CLIENT_ID,
    scopes: ["openid", "profile", "email", "offline_access"],
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
  const session: Session = {
    context,
    profile: { email: employee.account.email, name: `${employee.firstName} ${employee.lastName}` },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    accessToken: async () => coreAccessToken,
    setCookies: [],
  };
  const authenticated: Authenticated = { context, via: "session", session, setCookies: [] };
  vi.spyOn(getAuth(), "authenticate").mockResolvedValue(authenticated);
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let anna: CreatedEmployeeWithAccount;
let unitMagazynId: string;
let memberRoleId: string;

function setupDefaultAcme(): void {
  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("kivotasks");

  const magazyn = acme.addUnit({ name: "Magazyn", type: "TEAM" });
  unitMagazynId = magazyn.id;

  memberRoleId = acme.addRole({
    name: "Członek KivoTasks",
    product: "kivotasks",
    permissions: [KIVOTASKS_PERMISSIONS.keys["issues.read"], KIVOTASKS_PERMISSIONS.keys["issues.write"]],
  }).id;

  anna = acme.addEmployee({
    firstName: "Anna",
    lastName: "Nowak",
    email: "anna@acme.test",
    unitIds: [unitMagazynId],
    products: ["kivotasks"],
  });
  acme.assignRole({ accountId: anna.accountId, roleId: memberRoleId, scope: { type: "ORGANIZATION" } });
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
  setupDefaultAcme();
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  invalidatePermissionCache();
  resetMachineCoreTokenCache();
  setCoreRetryForTests(FAST_RETRY);
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeCore.fetch as typeof fetch);
});

afterEach(() => {
  fakeCore.clearFaults();
  fakeCore.resetCalls();
  fakeCore.setDirectoryPageSize(undefined);
  setCoreRetryForTests();
  vi.restoreAllMocks();
});

describe("odporność serwera KivoTasks na krótkie awarie MonoriseCore", () => {
  it("udostępnia domyślną politykę ponawiania (3 próby, 200-2000 ms)", () => {
    expect(DEFAULT_CORE_RETRY).toEqual({
      attempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 2000,
    });
  });

  it("ponawia pojedyncze 503 na permissionSnapshot i kończy żądanie sukcesem", async () => {
    const coreToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(anna, acme.id, coreToken);
    fakeCore.failNext("permissionSnapshot", { status: 503 });

    const response = await call(me.GET, "/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        employee: { firstName: string };
        capabilities: {
          hasProductAccess: boolean;
          readIssues: boolean;
          writeIssues: boolean;
          manageTeams: boolean;
          createTeams: boolean;
          manageProjects: boolean;
        };
      };
      error: null;
    };
    expect(body.error).toBeNull();
    expect(body.data.employee.firstName).toBe("Anna");
    expect(body.data.capabilities).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: true,
      manageTeams: false,
      createTeams: false,
      manageProjects: false,
    });
    expect(fakeCore.calls("permissionSnapshot")).toBe(2);
  });

  it("ponawia pojedynczy błąd sieci na directoryUnitMembers w kliencie maszynowym Core", async () => {
    fakeCore.failNext("directoryUnitMembers", { networkError: true });

    const core = getMachineCoreClient();
    const memberIds: string[] = [];
    for await (const member of paginate(core.listProductDirectoryUnitMembers, {
      path: { productKey: KIVOTASKS_PERMISSIONS.product },
      query: { organizationId: acme.id, unitId: [unitMagazynId], limit: 100 },
    })) {
      memberIds.push(member.employeeId);
    }

    expect(memberIds).toEqual([anna.employeeId]);
    expect(fakeCore.calls("directoryUnitMembers")).toBe(2);
  });

  it("ponawia pojedyncze 429 z Retry-After: 0 na /core/v1/me w GET /api/v1/me", async () => {
    const coreToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(anna, acme.id, coreToken);
    fakeCore.failNext("me", { status: 429, retryAfterSeconds: 0 });

    const response = await call(me.GET, "/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { account: { email: string }; organization: { name: string } };
      error: null;
    };
    expect(body.error).toBeNull();
    expect(body.data.account.email).toBe("anna@acme.test");
    expect(body.data.organization.name).toBe("Acme");
    expect(fakeCore.calls("me")).toBe(2);
  });

  it("zwraca 503 w standardowej kopercie błędu przy trwałym 503 na permissionSnapshot i nie podaje starej migawki", async () => {
    const coreToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(anna, acme.id, coreToken);

    // 1. Trwałe 503 (więcej niż liczba prób) bez wcześniejszej migawki w cache
    fakeCore.failNext("permissionSnapshot", { status: 503 }, { times: FAST_RETRY.attempts + 2 });

    const firstFailure = await call(me.GET, "/me");
    const envelopeCheck = await checkErrorEnvelope(firstFailure.clone(), {
      expectedStatus: 503,
      expectedCode: "INTERNAL_ERROR",
    });
    expect(envelopeCheck.passed, envelopeCheck.violations.join("; ")).toBe(true);
    const firstBody = (await firstFailure.json()) as {
      data: null;
      meta: { requestId: string };
      error: { code: string; message: string; details: unknown[] };
    };
    expect(firstBody).toEqual({
      data: null,
      meta: { requestId: expect.stringMatching(/^req_/) },
      error: {
        code: "INTERNAL_ERROR",
        message: "MonoriseCore jest chwilowo niedostępny",
        details: [],
      },
    });
    expect(fakeCore.calls("permissionSnapshot")).toBe(FAST_RETRY.attempts);

    // 2. Po zapisaniu migawki w cache i wzroście authz_rev trwałe 503 nadal odmawia (fail-closed)
    fakeCore.clearFaults();
    fakeCore.resetCalls();

    const okResponse = await call(me.GET, "/me");
    expect(okResponse.status).toBe(200);
    expect(fakeCore.calls("permissionSnapshot")).toBe(1);

    const nextRev = acme.bumpAuthzRevision(anna.accountId);
    mockBrowserSession(anna, acme.id, coreToken, nextRev);
    fakeCore.failNext("permissionSnapshot", { status: 503 }, { times: FAST_RETRY.attempts + 2 });

    const failClosed = await call(me.GET, "/me");
    const failClosedCheck = await checkErrorEnvelope(failClosed.clone(), {
      expectedStatus: 503,
      expectedCode: "INTERNAL_ERROR",
    });
    expect(failClosedCheck.passed, failClosedCheck.violations.join("; ")).toBe(true);
    expect(fakeCore.calls("permissionSnapshot")).toBe(1 + FAST_RETRY.attempts);
  });

  it("pobiera wszystkie strony katalogu Core przez paginate przy directoryPageSize: 2", async () => {
    fakeCore.setDirectoryPageSize(2);

    const teamMembers = [
      anna,
      acme.addEmployee({ firstName: "Bartek", lastName: "Bąk", unitIds: [unitMagazynId], products: ["kivotasks"] }),
      acme.addEmployee({ firstName: "Celina", lastName: "Cicha", unitIds: [unitMagazynId], products: ["kivotasks"] }),
      acme.addEmployee({ firstName: "Damian", lastName: "Dąb", unitIds: [unitMagazynId], products: ["kivotasks"] }),
      acme.addEmployee({ firstName: "Ewa", lastName: "Eska", unitIds: [unitMagazynId], products: ["kivotasks"] }),
    ];

    const core = getMachineCoreClient();
    const memberIds: string[] = [];
    for await (const member of paginate(core.listProductDirectoryUnitMembers, {
      path: { productKey: KIVOTASKS_PERMISSIONS.product },
      query: { organizationId: acme.id, unitId: [unitMagazynId], limit: 100 },
    })) {
      memberIds.push(member.employeeId);
    }

    expect(memberIds).toHaveLength(5);
    expect(memberIds.sort()).toEqual(teamMembers.map((member) => member.employeeId).sort());
    expect(fakeCore.calls("directoryUnitMembers")).toBe(3);
  });
});
