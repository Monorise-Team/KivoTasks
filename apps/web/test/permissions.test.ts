/**
 * Testy uprawnień KivoTasks z migawki Core, ról (Członek KivoTasks, Administrator KivoTasks, Gość, Owner),
 * zakresów (ORGANIZATION, UNIT z poddrzewem, RESOURCE) oraz odświeżania pamięci podręcznej po `authz_rev`
 * bez bazy PostgreSQL i bez gniazd TCP (atrapa `createFakeCore` podpięta pod `globalThis.fetch`).
 */
import { createFakeCore, type FakeCore, type FakeOrganizationBuilder } from "@monorise-team/testing";
import { KIVOTASKS_PERMISSIONS } from "@kivotasks/contracts";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, route } from "@/server/api";
import type { Caller } from "@/server/auth";
import { resetMachineCoreTokenCache } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_NOTIFICATIONS_SEND_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import {
  assertPermission,
  assertPermissionScope,
  canReadTeam,
  canReadTeamIssues,
  getPermissionSnapshot,
  getUserCapabilities,
  invalidatePermissionCache,
  PRODUCT_ACCESS_REQUIRED_MESSAGE,
  resolveReadableIssuesFilter,
  resolveReadableTeamsFilter,
} from "@/server/permissions";

const FAKE_CORE_URL = "http://core.local.test";
const CLIENT_ID = "kivotasks-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

function makeCaller(organizationId: string, accountId: string, employeeId: string, authzRevision = 0): Caller {
  return {
    organizationId,
    accountId,
    employeeId,
    session: null,
    token: null,
    context: {
      accountId,
      organizationId,
      employeeId,
      sessionId: "sesja-test",
      authzRevision,
      methods: [],
      clientId: CLIENT_ID,
      scopes: ["openid"],
      expiresAt: new Date(Date.now() + 60_000),
    },
  };
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let unitKrakowId: string;
let unitMagazynId: string;
let memberRoleId: string;
let adminRoleId: string;
let guestRoleId: string;
let snapshotFault: "none" | "server-error" | "network-error" = "none";

async function coreFetchAdapter(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);

  if (url.pathname === "/core/v1/products/kivotasks/permission-snapshot") {
    if (snapshotFault === "network-error") {
      throw new TypeError("connect ECONNREFUSED");
    }
    if (snapshotFault === "server-error") {
      return new Response(
        JSON.stringify({
          data: null,
          meta: { requestId: "req_500" },
          error: { code: "INTERNAL_ERROR", message: "Core failure", details: [] },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  return fakeCore.fetch(input, init);
}

beforeEach(async () => {
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  snapshotFault = "none";

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

  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("kivotasks");

  const krakow = acme.addUnit({ name: "Oddział Kraków", type: "BRANCH" });
  const magazyn = acme.addUnit({ name: "Magazyn", type: "TEAM", parentId: krakow.id });
  unitKrakowId = krakow.id;
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

  invalidatePermissionCache();
  resetMachineCoreTokenCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(coreFetchAdapter as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uprawnienia KivoTasks z migawki MonoriseCore i pamięć podręczna", () => {
  it("odmawia dostępu (403 PRODUCT_ACCESS_REQUIRED), gdy migawka nie zawiera produktu kivotasks, nawet dla Ownera", async () => {
    const noPlanOrg = fakeCore.organization({ name: "BezPlanu", domain: "bezplanu.test" });
    const owner = noPlanOrg.addEmployee({ firstName: "Anna", lastName: "Nowak", isOwner: true });

    const caller = makeCaller(noPlanOrg.id, owner.accountId, owner.employeeId);
    const error = await assertPermission(caller, KIVOTASKS_PERMISSIONS.keys["issues.read"]).catch((e) => e);
    expect(error).toBeInstanceOf(ApiFailure);
    expect((error as ApiFailure).status).toBe(403);
    expect((error as ApiFailure).code).toBe("PRODUCT_ACCESS_REQUIRED");
    expect((error as ApiFailure).message).toBe(PRODUCT_ACCESS_REQUIRED_MESSAGE);

    expect(await getUserCapabilities(caller)).toEqual({
      hasProductAccess: false,
      readIssues: false,
      writeIssues: false,
      manageTeams: false,
      createTeams: false,
      manageProjects: false,
    });
  });

  it("Członek KivoTasks ma issues.read i issues.write, a nie ma teams.manage ani projects.manage", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["kivotasks"] });
    acme.assignRole({
      accountId: anna.accountId,
      roleId: memberRoleId,
      scope: { type: "UNIT", unitId: unitMagazynId },
    });

    const caller = makeCaller(acme.id, anna.accountId, anna.employeeId);
    await expect(assertPermission(caller, KIVOTASKS_PERMISSIONS.keys["issues.read"])).resolves.toBeDefined();
    await expect(assertPermission(caller, KIVOTASKS_PERMISSIONS.keys["issues.write"])).resolves.toBeDefined();
    expect(await getUserCapabilities(caller)).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: true,
      manageTeams: false,
      createTeams: false,
      manageProjects: false,
    });

    const teamsError = await assertPermissionScope(caller, KIVOTASKS_PERMISSIONS.keys["teams.manage"]).catch((e) => e);
    expect(teamsError).toBeInstanceOf(ApiFailure);
    expect((teamsError as ApiFailure).status).toBe(403);
    expect((teamsError as ApiFailure).code).toBe("PERMISSION_DENIED");

    // Wszystkie wywołania korzystały z jednej migawki w cache i jednego tokenu maszynowego
    expect(fakeCore.calls.permissionSnapshot).toBe(1);
    expect(fakeCore.calls.token).toBe(1);
  });

  it("Gość w zakresie RESOURCE ma wyłącznie issues.read z resourceIds, a Administrator w UNIT obejmuje poddrzewo", async () => {
    const gosc = acme.addEmployee({ firstName: "Jan", lastName: "Kowalski", products: ["kivotasks"] });
    acme.assignRole({
      accountId: gosc.accountId,
      roleId: guestRoleId,
      scope: { type: "RESOURCE", resourceId: "project-przeprowadzka" },
    });

    const guestCaller = makeCaller(acme.id, gosc.accountId, gosc.employeeId);
    expect(await assertPermissionScope(guestCaller, KIVOTASKS_PERMISSIONS.keys["issues.read"])).toEqual({
      type: "LIMITED",
      unitIds: [],
      resourceIds: ["project-przeprowadzka"],
    });
    await expect(assertPermission(guestCaller, KIVOTASKS_PERMISSIONS.keys["issues.write"])).rejects.toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED",
    });

    const admin = acme.addEmployee({ firstName: "Ewa", lastName: "Kowalczyk", products: ["kivotasks"] });
    acme.assignRole({
      accountId: admin.accountId,
      roleId: adminRoleId,
      scope: { type: "UNIT", unitId: unitKrakowId },
    });

    const adminCaller = makeCaller(acme.id, admin.accountId, admin.employeeId);
    const scope = await assertPermissionScope(adminCaller, KIVOTASKS_PERMISSIONS.keys["teams.manage"]);
    expect(scope.type).toBe("LIMITED");
    if (scope.type === "LIMITED") {
      expect(scope.unitIds).toEqual(expect.arrayContaining([unitKrakowId, unitMagazynId]));
    }
    expect(await getUserCapabilities(adminCaller)).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: true,
      manageTeams: true,
      createTeams: false,
      manageProjects: true,
    });

    const owner = acme.addEmployee({ firstName: "Ola", lastName: "Właścicielka", isOwner: true });
    const ownerCaller = makeCaller(acme.id, owner.accountId, owner.employeeId);
    expect(await assertPermissionScope(ownerCaller, KIVOTASKS_PERMISSIONS.keys["projects.manage"])).toEqual({
      type: "ORGANIZATION",
    });
    expect(await getUserCapabilities(ownerCaller)).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: true,
      manageTeams: true,
      createTeams: true,
      manageProjects: true,
    });
  });

  it("osoba z samym issues.write ma readIssues w capabilities oraz widzi zespół i zadania w swoim zakresie", async () => {
    const writerRoleId = acme.addRole({
      name: "Tylko zapis zadań",
      product: "kivotasks",
      permissions: [KIVOTASKS_PERMISSIONS.keys["issues.write"]],
    }).id;
    const projectOnlyRoleId = acme.addRole({
      name: "Tylko projekty",
      product: "kivotasks",
      permissions: [KIVOTASKS_PERMISSIONS.keys["projects.manage"]],
    }).id;

    const piotr = acme.addEmployee({ firstName: "Piotr", lastName: "Zapisujący", products: ["kivotasks"] });
    acme.assignRole({
      accountId: piotr.accountId,
      roleId: writerRoleId,
      scope: { type: "UNIT", unitId: unitMagazynId },
    });
    const piotrCaller = makeCaller(acme.id, piotr.accountId, piotr.employeeId);
    const snapshot = await getPermissionSnapshot(piotrCaller);

    expect(await getUserCapabilities(piotrCaller)).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: true,
      manageTeams: false,
      createTeams: false,
      manageProjects: false,
    });
    expect(canReadTeam(snapshot, unitMagazynId)).toBe(true);
    expect(canReadTeamIssues(snapshot, unitMagazynId)).toBe(true);
    expect(canReadTeam(snapshot, unitKrakowId)).toBe(false);
    expect(canReadTeamIssues(snapshot, unitKrakowId)).toBe(false);
    expect(await resolveReadableIssuesFilter(piotrCaller)).toEqual([unitMagazynId]);
    expect(await resolveReadableTeamsFilter(piotrCaller)).toEqual([unitMagazynId]);

    // Osoba z samym projects.manage ma NONE dla issues.read, issues.write i teams.manage -> 403
    const marek = acme.addEmployee({ firstName: "Marek", lastName: "Projektowy", products: ["kivotasks"] });
    acme.assignRole({
      accountId: marek.accountId,
      roleId: projectOnlyRoleId,
      scope: { type: "ORGANIZATION" },
    });
    const marekCaller = makeCaller(acme.id, marek.accountId, marek.employeeId);
    await expect(resolveReadableIssuesFilter(marekCaller)).rejects.toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED",
    });
    await expect(resolveReadableTeamsFilter(marekCaller)).rejects.toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED",
    });
  });

  it("natychmiast odświeża migawkę w pamięci podręcznej, gdy rośnie authz_rev w tokenie", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: [] });

    await expect(
      assertPermission(
        makeCaller(acme.id, anna.accountId, anna.employeeId, 0),
        KIVOTASKS_PERMISSIONS.keys["issues.read"],
      ),
    ).rejects.toMatchObject({ status: 403, code: "PRODUCT_ACCESS_REQUIRED" });
    expect(fakeCore.calls.permissionSnapshot).toBe(1);

    // Owner włącza KivoTasks i nadaje rolę Członek KivoTasks (authz_rev rośnie do 1)
    acme.grantAppAccess(anna.accountId, "kivotasks");
    acme.assignRole({ accountId: anna.accountId, roleId: memberRoleId, scope: { type: "ORGANIZATION" } });
    const nextRev = acme.bumpAuthzRevision(anna.accountId);
    expect(nextRev).toBe(1);

    // Stary token (authz_rev = 0) nadal dostaje wynik z cache
    await expect(
      assertPermission(
        makeCaller(acme.id, anna.accountId, anna.employeeId, 0),
        KIVOTASKS_PERMISSIONS.keys["issues.read"],
      ),
    ).rejects.toMatchObject({ status: 403, code: "PRODUCT_ACCESS_REQUIRED" });
    expect(fakeCore.calls.permissionSnapshot).toBe(1);

    // Nowy token (authz_rev = 1) od razu odświeża migawkę bez czekania 5 minut
    await expect(
      assertPermission(
        makeCaller(acme.id, anna.accountId, anna.employeeId, nextRev),
        KIVOTASKS_PERMISSIONS.keys["issues.read"],
      ),
    ).resolves.toBeDefined();
    expect(fakeCore.calls.permissionSnapshot).toBe(2);
  });

  it("zwraca 503 przez route(), gdy Core API jest niedostępne lub zwraca 500", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["kivotasks"] });
    const handler = route(async () => {
      await assertPermission(
        makeCaller(acme.id, anna.accountId, anna.employeeId),
        KIVOTASKS_PERMISSIONS.keys["issues.read"],
      );
      return { ok: true };
    });

    snapshotFault = "server-error";
    const req1 = new NextRequest("http://kivo.localhost:3500/api/v1/me");
    const res1 = await handler(req1, { params: Promise.resolve({}) });
    expect(res1.status).toBe(503);

    snapshotFault = "network-error";
    const req2 = new NextRequest("http://kivo.localhost:3500/api/v1/me");
    const res2 = await handler(req2, { params: Promise.resolve({}) });
    expect(res2.status).toBe(503);
  });
});
