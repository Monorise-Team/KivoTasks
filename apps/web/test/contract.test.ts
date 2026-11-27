/**
 * Testy zgodności KivoTasks z kontraktem produktu Monorise (ADR-0046, ADR-0075) za pomocą
 * `defineProductContractTests` z `@monorise-team/testing` oraz kontrola spójności opisu OpenAPI 3.1.
 *
 * Testy działają bez bazy PostgreSQL i bez gniazd TCP (atrapa `createFakeCore` podpięta pod
 * `globalThis.fetch`; wszystkie odmowy uwierzytelnienia, dostępu do produktu i uprawnień
 * kończą się przed warstwą bazy danych).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFakeCore, defineProductContractTests, type FakeCore } from "@monorise-team/testing";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as attachmentById from "@/app/api/v1/attachments/[attachmentId]/route";
import * as attachmentContent from "@/app/api/v1/attachments/[attachmentId]/content/route";
import * as health from "@/app/api/v1/health/route";
import * as inbox from "@/app/api/v1/inbox/route";
import * as inboxById from "@/app/api/v1/inbox/[itemId]/route";
import * as inboxReadAll from "@/app/api/v1/inbox/read-all/route";
import * as inboxUnreadCount from "@/app/api/v1/inbox/unread-count/route";
import * as issueById from "@/app/api/v1/issues/[issueId]/route";
import * as issueActivity from "@/app/api/v1/issues/[issueId]/activity/route";
import * as issueAttachments from "@/app/api/v1/issues/[issueId]/attachments/route";
import * as issueComments from "@/app/api/v1/issues/[issueId]/comments/route";
import * as issueCommentById from "@/app/api/v1/issues/[issueId]/comments/[commentId]/route";
import * as commentReaction from "@/app/api/v1/issues/[issueId]/comments/[commentId]/reactions/[emoji]/route";
import * as issueRelations from "@/app/api/v1/issues/[issueId]/relations/route";
import * as issueRelationById from "@/app/api/v1/issues/[issueId]/relations/[relationId]/route";
import * as issueSubscription from "@/app/api/v1/issues/[issueId]/subscription/route";
import * as issues from "@/app/api/v1/issues/route";
import * as me from "@/app/api/v1/me/route";
import * as search from "@/app/api/v1/search/route";
import * as storage from "@/app/api/v1/storage/route";
import * as teamById from "@/app/api/v1/teams/[teamId]/route";
import * as teamLabels from "@/app/api/v1/teams/[teamId]/labels/route";
import * as teamLabelById from "@/app/api/v1/teams/[teamId]/labels/[labelId]/route";
import * as teamMembers from "@/app/api/v1/teams/[teamId]/members/route";
import * as teamStates from "@/app/api/v1/teams/[teamId]/states/route";
import * as teamStateById from "@/app/api/v1/teams/[teamId]/states/[stateId]/route";
import * as teamCandidates from "@/app/api/v1/teams/candidates/route";
import * as teams from "@/app/api/v1/teams/route";
import { resetMachineCoreTokenCache } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_NOTIFICATIONS_SEND_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import { buildOpenApiDocument, serializeOpenApiDocument } from "@/server/openapi";
import { invalidatePermissionCache } from "@/server/permissions";
import { ROUTE_LIST } from "@/server/routes";

const API = "http://kivo.localhost:3500";
const FAKE_CORE_URL = "http://core.contract.test";
const CLIENT_ID = "kivotasks-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";
const API_ROUTES_DIR = resolve(import.meta.dirname, "../src/app/api/v1");
const COMMITTED_OPENAPI_PATH = resolve(import.meta.dirname, "../../../openapi/kivotasks-api.json");

const DUMMY_UUID_1 = "019a0000-0000-7000-8000-000000000001";
const DUMMY_UUID_2 = "019a0000-0000-7000-8000-000000000002";

type AnyNextRouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

interface RoutePatternEntry {
  method: string;
  template: string;
  handler: AnyNextRouteHandler;
  regex: RegExp;
  paramNames: string[];
}

function compileTemplate(template: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${escaped}$`), paramNames };
}

function adapt<P>(
  fn: (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>,
): AnyNextRouteHandler {
  return (request, context) => fn(request, context as unknown as { params: Promise<P> });
}

const ROUTE_HANDLERS: Readonly<Record<string, AnyNextRouteHandler>> = {
  "GET /api/v1/health": adapt(health.GET),
  "GET /api/v1/me": adapt(me.GET),
  "GET /api/v1/teams": adapt(teams.GET),
  "POST /api/v1/teams": adapt(teams.POST),
  "GET /api/v1/teams/candidates": adapt(teamCandidates.GET),
  "PATCH /api/v1/teams/{teamId}": adapt(teamById.PATCH),
  "GET /api/v1/teams/{teamId}/members": adapt(teamMembers.GET),
  "GET /api/v1/teams/{teamId}/states": adapt(teamStates.GET),
  "POST /api/v1/teams/{teamId}/states": adapt(teamStates.POST),
  "PATCH /api/v1/teams/{teamId}/states/{stateId}": adapt(teamStateById.PATCH),
  "DELETE /api/v1/teams/{teamId}/states/{stateId}": adapt(teamStateById.DELETE),
  "GET /api/v1/teams/{teamId}/labels": adapt(teamLabels.GET),
  "POST /api/v1/teams/{teamId}/labels": adapt(teamLabels.POST),
  "PATCH /api/v1/teams/{teamId}/labels/{labelId}": adapt(teamLabelById.PATCH),
  "DELETE /api/v1/teams/{teamId}/labels/{labelId}": adapt(teamLabelById.DELETE),
  "GET /api/v1/issues": adapt(issues.GET),
  "POST /api/v1/issues": adapt(issues.POST),
  "GET /api/v1/issues/{issueId}": adapt(issueById.GET),
  "PATCH /api/v1/issues/{issueId}": adapt(issueById.PATCH),
  "DELETE /api/v1/issues/{issueId}": adapt(issueById.DELETE),
  "POST /api/v1/issues/{issueId}/relations": adapt(issueRelations.POST),
  "DELETE /api/v1/issues/{issueId}/relations/{relationId}": adapt(issueRelationById.DELETE),
  "GET /api/v1/issues/{issueId}/comments": adapt(issueComments.GET),
  "POST /api/v1/issues/{issueId}/comments": adapt(issueComments.POST),
  "PATCH /api/v1/issues/{issueId}/comments/{commentId}": adapt(issueCommentById.PATCH),
  "DELETE /api/v1/issues/{issueId}/comments/{commentId}": adapt(issueCommentById.DELETE),
  "PUT /api/v1/issues/{issueId}/comments/{commentId}/reactions/{emoji}": adapt(commentReaction.PUT),
  "DELETE /api/v1/issues/{issueId}/comments/{commentId}/reactions/{emoji}": adapt(commentReaction.DELETE),
  "GET /api/v1/issues/{issueId}/activity": adapt(issueActivity.GET),
  "PUT /api/v1/issues/{issueId}/subscription": adapt(issueSubscription.PUT),
  "DELETE /api/v1/issues/{issueId}/subscription": adapt(issueSubscription.DELETE),
  "GET /api/v1/inbox": adapt(inbox.GET),
  "GET /api/v1/inbox/unread-count": adapt(inboxUnreadCount.GET),
  "PATCH /api/v1/inbox/{itemId}": adapt(inboxById.PATCH),
  "POST /api/v1/inbox/read-all": adapt(inboxReadAll.POST),
  "GET /api/v1/search": adapt(search.GET),
  "GET /api/v1/issues/{issueId}/attachments": adapt(issueAttachments.GET),
  "POST /api/v1/issues/{issueId}/attachments": adapt(issueAttachments.POST),
  "GET /api/v1/attachments/{attachmentId}": adapt(attachmentById.GET),
  "GET /api/v1/attachments/{attachmentId}/content": adapt(attachmentContent.GET),
  "DELETE /api/v1/attachments/{attachmentId}": adapt(attachmentById.DELETE),
  "GET /api/v1/storage": adapt(storage.GET),
};

const COMPILED_ROUTES: RoutePatternEntry[] = Object.entries(ROUTE_HANDLERS)
  // Statyczne ścieżki (np. /teams/candidates) dopasowujemy przed parametrycznymi (/teams/{teamId}).
  .sort(([a], [b]) => (a.includes("{") ? 1 : 0) - (b.includes("{") ? 1 : 0))
  .map(([key, handler]) => {
    const [method, template] = key.split(" ") as [string, string];
    const { regex, paramNames } = compileTemplate(template);
    return { method, template, handler, regex, paramNames };
  });

async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  for (const entry of COMPILED_ROUTES) {
    if (entry.method !== method) continue;
    const match = entry.regex.exec(url.pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < entry.paramNames.length; i++) {
      params[entry.paramNames[i]!] = decodeURIComponent(match[i + 1]!);
    }
    const body = method === "GET" || method === "HEAD" ? undefined : await request.text();
    const nextRequest = new NextRequest(request.url, {
      method,
      headers: request.headers,
      ...(body !== undefined && body.length > 0 ? { body } : {}),
    });
    return entry.handler(nextRequest, { params: Promise.resolve(params) });
  }

  return new Response(
    JSON.stringify({
      data: null,
      meta: { requestId: "req_dispatch_404" },
      error: { code: "NOT_FOUND", message: `Nieznana trasa API: ${method} ${url.pathname}`, details: [] },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

function listRoutePathsOnDisk(dir: string, prefix = "/api/v1"): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const openApiSegment = entry.name.replace(/^\[(.+)\]$/, "{$1}");
      paths.push(...listRoutePathsOnDisk(full, `${prefix}/${openApiSegment}`));
    } else if (entry.isFile() && entry.name === "route.ts") {
      paths.push(prefix);
    }
  }
  return paths.sort();
}

function collectSchemaRefs(value: unknown, refs: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, refs);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") {
      refs.add(entry);
    } else {
      collectSchemaRefs(entry, refs);
    }
  }
}

let fakeCore: FakeCore;

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
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeCore.fetch as typeof fetch);
});

beforeEach(() => {
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  invalidatePermissionCache();
  resetMachineCoreTokenCache();
});

afterAll(() => {
  vi.restoreAllMocks();
});

await defineProductContractTests({
  productKey: "kivotasks",
  baseUrl: API,
  audience: API,
  fakeCore: () => fakeCore,
  handler: dispatch,
  routes: [
    // Trasa BFF `/me` zwraca profil i capabilities nawet przed włączeniem KivoTasks i nie wymaga osobnego uprawnienia
    { method: "GET", path: "/api/v1/me", skipPermissionCheck: true, skipProductAccessCheck: true },
    { method: "GET", path: "/api/v1/teams" },
    { method: "POST", path: "/api/v1/teams", body: { unitId: DUMMY_UUID_1, key: "MAG" } },
    { method: "GET", path: "/api/v1/teams/candidates" },
    { method: "PATCH", path: `/api/v1/teams/${DUMMY_UUID_1}`, body: { key: "LOG" } },
    { method: "GET", path: `/api/v1/teams/${DUMMY_UUID_1}/members` },
    { method: "GET", path: `/api/v1/teams/${DUMMY_UUID_1}/states` },
    {
      method: "POST",
      path: `/api/v1/teams/${DUMMY_UUID_1}/states`,
      body: { name: "Nowy", category: "STARTED", color: "blue" },
    },
    {
      method: "PATCH",
      path: `/api/v1/teams/${DUMMY_UUID_1}/states/${DUMMY_UUID_2}`,
      body: { name: "Zmieniony" },
    },
    { method: "DELETE", path: `/api/v1/teams/${DUMMY_UUID_1}/states/${DUMMY_UUID_2}` },
    { method: "GET", path: `/api/v1/teams/${DUMMY_UUID_1}/labels` },
    { method: "POST", path: `/api/v1/teams/${DUMMY_UUID_1}/labels`, body: { name: "Pilne", color: "red" } },
    { method: "PATCH", path: `/api/v1/teams/${DUMMY_UUID_1}/labels/${DUMMY_UUID_2}`, body: { color: "green" } },
    { method: "DELETE", path: `/api/v1/teams/${DUMMY_UUID_1}/labels/${DUMMY_UUID_2}` },
    { method: "GET", path: "/api/v1/issues" },
    { method: "POST", path: "/api/v1/issues", body: { teamId: DUMMY_UUID_1, title: "Zadanie testowe" } },
    { method: "GET", path: `/api/v1/issues/${DUMMY_UUID_1}` },
    { method: "PATCH", path: `/api/v1/issues/${DUMMY_UUID_1}`, body: { title: "Zmienione" } },
    { method: "DELETE", path: `/api/v1/issues/${DUMMY_UUID_1}` },
    {
      method: "POST",
      path: `/api/v1/issues/${DUMMY_UUID_1}/relations`,
      body: { relatedIssueId: DUMMY_UUID_2, type: "BLOCKS" },
    },
    { method: "DELETE", path: `/api/v1/issues/${DUMMY_UUID_1}/relations/${DUMMY_UUID_2}` },
    { method: "GET", path: `/api/v1/issues/${DUMMY_UUID_1}/comments` },
    { method: "POST", path: `/api/v1/issues/${DUMMY_UUID_1}/comments`, body: { body: "Komentarz testowy" } },
    {
      method: "PATCH",
      path: `/api/v1/issues/${DUMMY_UUID_1}/comments/${DUMMY_UUID_2}`,
      body: { body: "Zmieniony komentarz" },
    },
    { method: "DELETE", path: `/api/v1/issues/${DUMMY_UUID_1}/comments/${DUMMY_UUID_2}` },
    {
      method: "PUT",
      path: `/api/v1/issues/${DUMMY_UUID_1}/comments/${DUMMY_UUID_2}/reactions/${encodeURIComponent("👍")}`,
    },
    {
      method: "DELETE",
      path: `/api/v1/issues/${DUMMY_UUID_1}/comments/${DUMMY_UUID_2}/reactions/${encodeURIComponent("👍")}`,
    },
    { method: "GET", path: `/api/v1/issues/${DUMMY_UUID_1}/activity` },
    { method: "PUT", path: `/api/v1/issues/${DUMMY_UUID_1}/subscription` },
    { method: "DELETE", path: `/api/v1/issues/${DUMMY_UUID_1}/subscription` },
    { method: "GET", path: "/api/v1/inbox" },
    { method: "GET", path: "/api/v1/inbox/unread-count" },
    { method: "PATCH", path: `/api/v1/inbox/${DUMMY_UUID_1}`, body: { read: true } },
    { method: "POST", path: "/api/v1/inbox/read-all" },
    { method: "GET", path: "/api/v1/search?q=test" },
    { method: "GET", path: `/api/v1/issues/${DUMMY_UUID_1}/attachments` },
    { method: "POST", path: `/api/v1/issues/${DUMMY_UUID_1}/attachments` },
    { method: "GET", path: `/api/v1/attachments/${DUMMY_UUID_1}` },
    { method: "GET", path: `/api/v1/attachments/${DUMMY_UUID_1}/content` },
    { method: "DELETE", path: `/api/v1/attachments/${DUMMY_UUID_1}` },
    // Trasa `/storage` zwraca zużycie miejsca firmy po sprawdzeniu dostępu do produktu (bez osobnego uprawnienia roli)
    { method: "GET", path: "/api/v1/storage", skipPermissionCheck: true },
  ],
  openApi: () => buildOpenApiDocument(),
  openApiOptions: {
    rawResponseOperations: ["getAttachmentContent"],
  },
});

describe("OpenAPI KivoTasks API", () => {
  it("pokrywa dokładnie wszystkie pliki route.ts pod /api/v1 i wszystkie trasy w katalogu", () => {
    const document = buildOpenApiDocument();
    const diskPaths = listRoutePathsOnDisk(API_ROUTES_DIR);
    const openApiPaths = Object.keys(document.paths).sort();
    expect(openApiPaths).toEqual(diskPaths);

    const catalogOps = ROUTE_LIST.map((route) => `${route.method} ${route.path}`).sort();
    const dispatchedOps = Object.keys(ROUTE_HANDLERS).sort();
    expect(catalogOps).toEqual(dispatchedOps);
  });

  it("deklaruje schematy bezpieczeństwa bearerAuth i sessionCookie oraz stronicowanie dla GET /api/v1/issues", () => {
    const document = buildOpenApiDocument();
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual(["bearerAuth", "sessionCookie"]);
    expect(document.paths["/api/v1/health"]?.get?.security).toBeUndefined();
    expect(document.paths["/api/v1/me"]?.get?.security).toEqual([{ sessionCookie: [] }]);
    expect(document.paths["/api/v1/teams"]?.post?.security).toEqual([{ sessionCookie: [] }]);
    expect(document.paths["/api/v1/teams/candidates"]?.get?.security).toEqual([{ sessionCookie: [] }]);
    expect(document.paths["/api/v1/issues"]?.get?.security).toEqual([{ bearerAuth: [] }, { sessionCookie: [] }]);

    const issueListParamNames = (document.paths["/api/v1/issues"]?.get?.parameters ?? []).map((p) => p.name);
    expect(issueListParamNames).toEqual(
      expect.arrayContaining([
        "teamId",
        "stateId",
        "stateCategory",
        "assignee",
        "labelId",
        "priority",
        "parentId",
        "q",
        "includeCompleted",
        "sort",
        "limit",
        "cursor",
      ]),
    );
  });

  it("nie ma zerwanych ani nieużywanych schematów w components.schemas i zgadza się z openapi/kivotasks-api.json", () => {
    const document = buildOpenApiDocument();
    const schemaNames = new Set(Object.keys(document.components.schemas));
    const usedRefs = new Set<string>();
    collectSchemaRefs(document.paths, usedRefs);
    collectSchemaRefs(document.components.schemas, usedRefs);

    for (const ref of usedRefs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      expect(schemaNames.has(ref.slice("#/components/schemas/".length)), `Brakujący schemat ${ref}`).toBe(true);
    }
    for (const name of schemaNames) {
      expect(usedRefs.has(`#/components/schemas/${name}`), `Nieużywany schemat ${name}`).toBe(true);
    }

    const committed = readFileSync(COMMITTED_OPENAPI_PATH, "utf8");
    expect(JSON.parse(committed)).toEqual(document);
    expect(committed).toBe(serializeOpenApiDocument(document));
    expect(serializeOpenApiDocument(buildOpenApiDocument())).toBe(committed);
  });
});
