/**
 * Testy API na prawdziwych trasach Next.js: atrapa MonoriseCore (`createFakeCore` z `@monorise-team/testing`)
 * udostępniająca JWKS, OAuth `client_credentials`, `/core/v1/me` i migawkę uprawnień
 * (podpięta pod `globalThis.fetch` bez gniazd TCP i bez bazy PostgreSQL).
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
import * as signInRoute from "@/app/api/auth/sign-in/route";
import * as health from "@/app/api/v1/health/route";
import * as me from "@/app/api/v1/me/route";
import { route } from "@/server/api";
import { getAuth, requireUser } from "@/server/auth";
import { resetMachineCoreTokenCache } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import { assertPermission, invalidatePermissionCache, PRODUCT_ACCESS_REQUIRED_MESSAGE } from "@/server/permissions";

const API = "http://kivo.localhost:3500";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.api.test";
const CLIENT_ID = "kivotasks-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

function call<P>(
  handler: (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>,
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
  params = {} as P,
) {
  const headers: Record<string, string> = { host: "kivo.localhost:3500", ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const request = new NextRequest(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return handler(request, { params: Promise.resolve(params) }).then(async (response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- w testach czytamy odpowiedzi API swobodnie
    body: (await response.json()) as { data: any; meta: { requestId: string }; error: any },
    response,
  }));
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let anna: CreatedEmployeeWithAccount;
let unitMagazynId: string;
let memberRoleId: string;
let adminRoleId: string;
let guestRoleId: string;

/** Wstrzykiwanie błędu 500 dla wybranej ścieżki Core w scenariuszach awarii. */
let faultPath: string | null = null;

async function coreFetchAdapter(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);

  if (url.origin !== FAKE_CORE_URL) {
    throw new TypeError(`connect ECONNREFUSED ${url.host}`);
  }

  if (faultPath !== null && url.pathname === faultPath) {
    return new Response(
      JSON.stringify({
        data: null,
        meta: { requestId: "req_core_500" },
        error: { code: "INTERNAL_ERROR", message: "Core failure", details: [] },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  return fakeCore.fetch(input, init);
}

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

  anna = acme.addEmployee({
    firstName: "Anna",
    lastName: "Nowak",
    email: "anna@acme.test",
    jobTitle: "Specjalistka logistyki",
    products: ["kivotasks"],
  });
  acme.assignRole({ accountId: anna.accountId, roleId: memberRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });
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
  setupDefaultAcme();
  faultPath = null;
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  invalidatePermissionCache();
  resetMachineCoreTokenCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(coreFetchAdapter as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

/** Sesja przeglądarki (BFF) udająca `getAuth().authenticate` z dostępem do tokenu Core API. */
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
    sessionId: "sesja-core",
    authzRevision,
    methods: [],
    clientId: CLIENT_ID,
    scopes: ["openid", "profile", "email", "offline_access"],
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
  const requestedResources: (string | undefined)[] = [];
  const session: Session = {
    context,
    profile: { email: employee.account.email, name: `${employee.firstName} ${employee.lastName}` },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    accessToken: async (resource?: string) => {
      requestedResources.push(resource);
      return coreAccessToken;
    },
    setCookies: [],
  };
  const authenticated: Authenticated = { context, via: "session", session, setCookies: [] };
  vi.spyOn(getAuth(), "authenticate").mockResolvedValue(authenticated);
  return { requestedResources };
}

describe("API: sesja, Core SDK, uprawnienia i ochrona CSRF", () => {
  it("health odpowiada ok w formacie { data, meta, error }", async () => {
    const { status, body } = await call(health.GET, "/health");
    expect(status).toBe(200);
    expect(body.data.status).toBe("ok");
    expect(body.error).toBeNull();
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it("bez sesji odpowiada UNAUTHENTICATED w formacie { data, meta, error }", async () => {
    const { status, body } = await call(me.GET, "/me");
    expect(status).toBe(401);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it("GET /api/v1/me z sesją przeglądarki (BFF) pobiera osobę, firmę i capabilities z Core", async () => {
    const coreApiToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    const { requestedResources } = mockBrowserSession(anna, acme.id, coreApiToken);

    const { status, body } = await call(me.GET, "/me");
    expect(status).toBe(200);
    expect(requestedResources).toEqual([fakeCore.coreApiUrl]);
    expect(body.data).toMatchObject({
      account: { id: anna.accountId, email: "anna@acme.test" },
      employee: {
        id: anna.employeeId,
        firstName: "Anna",
        lastName: "Nowak",
        fullName: "Anna Nowak",
        jobTitle: "Specjalistka logistyki",
      },
      organization: { id: acme.id, name: "Acme" },
      capabilities: {
        hasProductAccess: true,
        readIssues: true,
        writeIssues: true,
        manageTeams: false,
        manageProjects: false,
      },
    });

    // Po nadaniu roli Administrator KivoTasks i podbiciu authz_rev pamięć podręczna odświeża capabilities
    acme.assignRole({
      accountId: anna.accountId,
      roleId: adminRoleId,
      scope: { type: "ORGANIZATION" },
    });
    const nextRev = acme.bumpAuthzRevision(anna.accountId);
    mockBrowserSession(anna, acme.id, coreApiToken, nextRev);
    const refreshed = await call(me.GET, "/me");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.capabilities).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: true,
      manageTeams: true,
      manageProjects: true,
    });
    expect(fakeCore.calls.permissionSnapshot).toBe(2);
    // Token maszynowy został pobrany raz i użyty ponownie z cache
    expect(fakeCore.calls.token).toBe(1);
  });

  it("GET /api/v1/me odzwierciedla rolę Gość oraz brak dostępu do produktu", async () => {
    const gosc = acme.addEmployee({ firstName: "Jan", lastName: "Kowalski", products: ["kivotasks"] });
    acme.assignRole({
      accountId: gosc.accountId,
      roleId: guestRoleId,
      scope: { type: "RESOURCE", resourceId: "project-1" },
    });
    const guestToken = await acme.signUserToken(gosc.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(gosc, acme.id, guestToken);

    const guestRes = await call(me.GET, "/me");
    expect(guestRes.status).toBe(200);
    expect(guestRes.body.data.capabilities).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: false,
      manageTeams: false,
      manageProjects: false,
    });

    const blocked = acme.addEmployee({ firstName: "Zablokowana", lastName: "Osoba", products: [] });
    const blockedToken = await acme.signUserToken(blocked.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(blocked, acme.id, blockedToken);

    const blockedRes = await call(me.GET, "/me");
    expect(blockedRes.status).toBe(200);
    expect(blockedRes.body.data.capabilities).toEqual({
      hasProductAccess: false,
      readIssues: false,
      writeIssues: false,
      manageTeams: false,
      manageProjects: false,
    });
  });

  it("GET /api/v1/me odrzuca token Bearer (403 PERMISSION_DENIED) zamiast przekazywać go do Core", async () => {
    const token = await acme.signUserToken(anna.accountId, { audience: API });
    const { status, body } = await call(me.GET, "/me", { token });
    expect(status).toBe(403);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(body.error.message).toMatch(/Core API/);
  });

  it("mapuje błędy Core API na 401 i 503 dla sesji BFF i niedostępności migawki", async () => {
    const expiredCoreToken = await fakeCore.issuer.invalid.expired({
      accountId: anna.accountId,
      organizationId: acme.id,
      employeeId: anna.employeeId,
      audience: fakeCore.coreApiUrl,
    });
    mockBrowserSession(anna, acme.id, expiredCoreToken);

    const unauth = await call(me.GET, "/me");
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe("UNAUTHENTICATED");

    const validCoreToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(anna, acme.id, validCoreToken);

    faultPath = "/core/v1/me";
    const failed = await call(me.GET, "/me");
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("INTERNAL_ERROR");

    faultPath = "/core/v1/products/kivotasks/permission-snapshot";
    const snapFailed = await call(me.GET, "/me");
    expect(snapFailed.status).toBe(503);
    expect(snapFailed.body.error.code).toBe("INTERNAL_ERROR");

    faultPath = null;
    process.env.CORE_API_URL = "http://127.0.0.1:1";
    const unavailable = await call(me.GET, "/me");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("chroniona trasa zwraca 403 PRODUCT_ACCESS_REQUIRED bez dostępu i odświeża cache po wzroście authz_rev", async () => {
    const protectedHandler = route(async ({ request }) => {
      const caller = await requireUser(request);
      await assertPermission(caller, KIVOTASKS_PERMISSIONS.keys["issues.read"]);
      return { ok: true };
    });

    const newPerson = acme.addEmployee({ firstName: "Nowa", lastName: "Osoba", products: [] });
    const tokenRev0 = await acme.signUserToken(newPerson.accountId, { audience: API });
    const denied = await call(protectedHandler, "/probe", { token: tokenRev0 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PRODUCT_ACCESS_REQUIRED");
    expect(denied.body.error.message).toBe(PRODUCT_ACCESS_REQUIRED_MESSAGE);

    acme.grantAppAccess(newPerson.accountId, "kivotasks");
    acme.assignRole({ accountId: newPerson.accountId, roleId: memberRoleId, scope: { type: "ORGANIZATION" } });
    const nextRev = acme.bumpAuthzRevision(newPerson.accountId);
    const tokenRev1 = await acme.signUserToken(newPerson.accountId, { audience: API, authzRevision: nextRev });

    const allowed = await call(protectedHandler, "/probe", { token: tokenRev1 });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toEqual({ ok: true });
  });

  it("odrzuca token dla innego API i token po terminie", async () => {
    const base = {
      accountId: anna.accountId,
      organizationId: acme.id,
      employeeId: anna.employeeId,
      audience: API,
    };
    const otherApi = await fakeCore.issuer.invalid.wrongAudience(base, "http://localhost:3200");
    expect((await call(me.GET, "/me", { token: otherApi })).status).toBe(401);
    const expired = await fakeCore.issuer.invalid.expired(base);
    expect((await call(me.GET, "/me", { token: expired })).body.error.code).toBe("UNAUTHENTICATED");
  });

  it("logowanie w przeglądarce przekierowuje do Core z PKCE i oboma API", async () => {
    const response = await signInRoute.GET(new Request("http://kivotasks.localhost:3500/api/auth/sign-in?returnTo=/"));
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(`${target.origin}${target.pathname}`).toBe(`${fakeCore.issuerUrl}/api/auth/oauth2/authorize`);
    expect(target.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(target.searchParams.get("redirect_uri")).toBe("http://kivotasks.localhost:3500/api/auth/callback");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.getAll("resource")).toEqual([API, fakeCore.coreApiUrl]);
    expect(response.headers.get("set-cookie")).toMatch(/^monorise-oauth=.*HttpOnly; SameSite=Lax/);
  });

  it("odrzuca zmianę z ciasteczkiem spoza strony (CSRF)", async () => {
    const mutatingHandler = route(async () => ({ ok: true }));
    const { status, body } = await call(mutatingHandler, "/csrf-probe", {
      method: "POST",
      body: {},
      headers: { cookie: "monorise-session=x", origin: "https://zla-strona.example" },
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe("PERMISSION_DENIED");
  });
});
