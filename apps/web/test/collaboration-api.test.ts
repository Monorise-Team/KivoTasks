/**
 * Testy tras współpracy etapu 2a (komentarze, @wzmianki, reakcje, historia zmian, aktywność,
 * obserwowanie zadania i skrzynka powiadomień) na prawdziwych handlerach Next.js z atrapą `createFakeCore`
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
import { withUser } from "@kivotasks/db";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as inboxRoute from "@/app/api/v1/inbox/route";
import * as inboxItemRoute from "@/app/api/v1/inbox/[itemId]/route";
import * as inboxReadAllRoute from "@/app/api/v1/inbox/read-all/route";
import * as inboxUnreadCountRoute from "@/app/api/v1/inbox/unread-count/route";
import * as issueByIdRoute from "@/app/api/v1/issues/[issueId]/route";
import * as issueActivityRoute from "@/app/api/v1/issues/[issueId]/activity/route";
import * as commentsRoute from "@/app/api/v1/issues/[issueId]/comments/route";
import * as commentByIdRoute from "@/app/api/v1/issues/[issueId]/comments/[commentId]/route";
import * as reactionRoute from "@/app/api/v1/issues/[issueId]/comments/[commentId]/reactions/[emoji]/route";
import * as relationsRoute from "@/app/api/v1/issues/[issueId]/relations/route";
import * as relationByIdRoute from "@/app/api/v1/issues/[issueId]/relations/[relationId]/route";
import * as subscriptionRoute from "@/app/api/v1/issues/[issueId]/subscription/route";
import * as issuesRoute from "@/app/api/v1/issues/route";
import * as labelsRoute from "@/app/api/v1/teams/[teamId]/labels/route";
import * as statesRoute from "@/app/api/v1/teams/[teamId]/states/route";
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
import { getDb } from "@/server/db";
import { invalidatePermissionCache } from "@/server/permissions";
import { createFakeCoreWithUnitsFetch, type CapturedNotificationRequest } from "./helpers/fake-core-units";

const API = "http://kivo.localhost:3500";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.collaboration.test";
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

let unitMagazynId: string;
let unitFinanseId: string;

let owner: CreatedEmployeeWithAccount;
let anna: CreatedEmployeeWithAccount;
let jan: CreatedEmployeeWithAccount;
let gosc: CreatedEmployeeWithAccount;
let teamLead: CreatedEmployeeWithAccount;
let finanseOnly: CreatedEmployeeWithAccount;

let ownerToken: string;
let annaToken: string;
let janToken: string;
let goscToken: string;
let teamLeadToken: string;
let finanseToken: string;

async function setupSession(employee: CreatedEmployeeWithAccount) {
  const coreToken = await acme.signUserToken(employee.accountId, { audience: fakeCore.coreApiUrl });
  const context = {
    accountId: employee.accountId,
    organizationId: acme.id,
    employeeId: employee.employeeId,
    sessionId: "sesja-collab-test",
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

async function cleanupOrg(organizationId: string, accountId: string) {
  await withUser(getDb(), { organizationId, accountId }, async (tx) => {
    await tx.$executeRaw`DELETE FROM "public"."inbox_items"`;
    await tx.$executeRaw`DELETE FROM "public"."comment_reactions"`;
    await tx.$executeRaw`DELETE FROM "public"."comment_mentions"`;
    await tx.$executeRaw`DELETE FROM "public"."issue_comments"`;
    await tx.$executeRaw`DELETE FROM "public"."issue_events"`;
    await tx.$executeRaw`DELETE FROM "public"."issue_subscribers"`;
    await tx.issueRelation.deleteMany({});
    await tx.issueLabel.deleteMany({});
    await tx.issue.updateMany({ where: { parentId: { not: null } }, data: { parentId: null } });
    await tx.issue.deleteMany({});
    await tx.label.deleteMany({});
    await tx.workflowState.deleteMany({});
    await tx.team.deleteMany({});
  });
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
  const teamManagerRoleId = acme.addRole({
    name: "Kierownik zespołu",
    product: "kivotasks",
    permissions: [
      KIVOTASKS_PERMISSIONS.keys["issues.read"],
      KIVOTASKS_PERMISSIONS.keys["issues.write"],
      KIVOTASKS_PERMISSIONS.keys["teams.manage"],
    ],
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
  teamLead = acme.addEmployee({
    firstName: "Marek",
    lastName: "Lider",
    products: ["kivotasks"],
    unitIds: [unitMagazynId],
  });
  finanseOnly = acme.addEmployee({
    firstName: "Ferdynand",
    lastName: "Faktura",
    products: ["kivotasks"],
    unitIds: [unitFinanseId],
  });

  acme.assignRole({ accountId: anna.accountId, roleId: memberRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });
  acme.assignRole({ accountId: jan.accountId, roleId: memberRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });
  acme.assignRole({ accountId: gosc.accountId, roleId: guestRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });
  acme.assignRole({
    accountId: teamLead.accountId,
    roleId: teamManagerRoleId,
    scope: { type: "UNIT", unitId: unitMagazynId },
  });
  acme.assignRole({
    accountId: finanseOnly.accountId,
    roleId: memberRoleId,
    scope: { type: "UNIT", unitId: unitFinanseId },
  });

  vi.spyOn(globalThis, "fetch").mockImplementation(
    createFakeCoreWithUnitsFetch(fakeCore, {
      onNotification: (captured) => capturedNotifications.push(captured),
    }),
  );

  const restore = await setupSession(owner);
  await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });
  await call(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "FIN" } });
  restore();

  ownerToken = await acme.signUserToken(owner.accountId, { audience: API });
  annaToken = await acme.signUserToken(anna.accountId, { audience: API });
  janToken = await acme.signUserToken(jan.accountId, { audience: API });
  goscToken = await acme.signUserToken(gosc.accountId, { audience: API });
  teamLeadToken = await acme.signUserToken(teamLead.accountId, { audience: API });
  finanseToken = await acme.signUserToken(finanseOnly.accountId, { audience: API });
});

afterEach(async () => {
  await cleanupOrg(acme.id, owner.accountId);
  vi.restoreAllMocks();
  setCoreRetryForTests();
});

afterAll(async () => {
  vi.restoreAllMocks();
  setCoreRetryForTests();
  await getDb().$disconnect();
});

describe("komentarze, role, reakcje i 404 przed 403", () => {
  it("pozwala roli Gość komentować i reagować, blokuje edycję nie-autorowi, pozwala teams.manage usunąć cudzy komentarz", async () => {
    const issueRes = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Kontrola rampy" },
      token: annaToken,
    });
    expect(issueRes.status).toBe(201);
    const issueId = issueRes.body.data.id as string;

    // 1. Gość (tylko issues.read) może dodać komentarz i reakcję
    const guestComment = await call(
      commentsRoute.POST,
      `/issues/${issueId}/comments`,
      { method: "POST", body: { body: "Sprawdziłem rampę numer 1." }, token: goscToken },
      { issueId },
    );
    expect(guestComment.status).toBe(201);
    expect(guestComment.body.data).toMatchObject({
      authorAccountId: gosc.accountId,
      body: "Sprawdziłem rampę numer 1.",
      deleted: false,
      editedAt: null,
    });
    const commentId = guestComment.body.data.id as string;

    const reactRes = await call(
      reactionRoute.PUT,
      `/issues/${issueId}/comments/${commentId}/reactions/${encodeURIComponent("👍")}`,
      { method: "PUT", token: goscToken },
      { issueId, commentId, emoji: encodeURIComponent("👍") },
    );
    expect(reactRes.status).toBe(200);
    expect(reactRes.body.data.reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);

    // Niepoprawne emoji -> 422 VALIDATION_FAILED
    const badEmoji = await call(
      reactionRoute.PUT,
      `/issues/${issueId}/comments/${commentId}/reactions/${encodeURIComponent("🔥")}`,
      { method: "PUT", token: annaToken },
      { issueId, commentId, emoji: encodeURIComponent("🔥") },
    );
    expect(badEmoji.status).toBe(422);

    // 2. Nie-autor (zarówno Anna z issues.write, jak i lider z teams.manage) nie może edytować cudzego komentarza -> 403
    const annaEdit = await call(
      commentByIdRoute.PATCH,
      `/issues/${issueId}/comments/${commentId}`,
      { method: "PATCH", body: { body: "Próba przejęcia" }, token: annaToken },
      { issueId, commentId },
    );
    expect(annaEdit.status).toBe(403);

    const leadEdit = await call(
      commentByIdRoute.PATCH,
      `/issues/${issueId}/comments/${commentId}`,
      { method: "PATCH", body: { body: "Edycja lidera" }, token: teamLeadToken },
      { issueId, commentId },
    );
    expect(leadEdit.status).toBe(403);

    // 3. Autor (Gość) może edytować swój komentarz -> ustawia editedAt
    const guestEdit = await call(
      commentByIdRoute.PATCH,
      `/issues/${issueId}/comments/${commentId}`,
      { method: "PATCH", body: { body: "Sprawdzenie rampy numer 1 zakończone." }, token: goscToken },
      { issueId, commentId },
    );
    expect(guestEdit.status).toBe(200);
    expect(guestEdit.body.data.body).toBe("Sprawdzenie rampy numer 1 zakończone.");
    expect(guestEdit.body.data.editedAt).not.toBeNull();

    // 4. Nie-autor bez teams.manage (Anna) nie może usunąć cudzego komentarza -> 403
    const annaDelete = await call(
      commentByIdRoute.DELETE,
      `/issues/${issueId}/comments/${commentId}`,
      { method: "DELETE", token: annaToken },
      { issueId, commentId },
    );
    expect(annaDelete.status).toBe(403);

    // 5. Osoba spoza zespołu (Finanse) dostaje 404 przed 403
    const outsiderGet = await call(
      commentsRoute.GET,
      `/issues/${issueId}/comments`,
      { token: finanseToken },
      { issueId },
    );
    expect(outsiderGet.status).toBe(404);
    const outsiderDelete = await call(
      commentByIdRoute.DELETE,
      `/issues/${issueId}/comments/${commentId}`,
      { method: "DELETE", token: finanseToken },
      { issueId, commentId },
    );
    expect(outsiderDelete.status).toBe(404);

    // 6. Osoba z teams.manage na zespole (Marek) usuwa cudzy komentarz -> 204, treść ukryta
    const leadDelete = await call(
      commentByIdRoute.DELETE,
      `/issues/${issueId}/comments/${commentId}`,
      { method: "DELETE", token: teamLeadToken },
      { issueId, commentId },
    );
    expect(leadDelete.status).toBe(204);

    const listAfterDelete = await call(
      commentsRoute.GET,
      `/issues/${issueId}/comments`,
      { token: annaToken },
      { issueId },
    );
    expect(listAfterDelete.status).toBe(200);
    expect(listAfterDelete.body.data).toHaveLength(1);
    expect(listAfterDelete.body.data[0]).toMatchObject({
      id: commentId,
      deleted: true,
      body: null,
      mentionedAccountIds: [],
      reactions: [],
    });

    // Reakcja na usunięty komentarz -> 404
    const reactDeleted = await call(
      reactionRoute.PUT,
      `/issues/${issueId}/comments/${commentId}/reactions/${encodeURIComponent("❤️")}`,
      { method: "PUT", token: annaToken },
      { issueId, commentId, emoji: encodeURIComponent("❤️") },
    );
    expect(reactDeleted.status).toBe(404);
  });
});

describe("@wzmianki, obserwujący i skrzynka powiadomień (fan-out oraz izolacja)", () => {
  it("ignoruje wzmiankę osoby spoza zespołu, nie tworzy wpisu dla sprawcy, wysyła MENTIONED bez duplikatu COMMENTED i izoluje skrzynki", async () => {
    // Anna tworzy zadanie przypisane do siebie (brak wpisu ASSIGNED dla sprawcy)
    const selfAssigned = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Przegląd wózków", assigneeAccountId: anna.accountId },
      token: annaToken,
    });
    expect(selfAssigned.status).toBe(201);
    expect(selfAssigned.body.data.isSubscribed).toBe(true);
    const issueId = selfAssigned.body.data.id as string;

    const annaUnreadAfterSelf = await call(inboxUnreadCountRoute.GET, "/inbox/unread-count", { token: annaToken });
    expect(annaUnreadAfterSelf.body.data.unreadCount).toBe(0);

    // Anna przypisuje zadanie Janowi -> Jan zostaje obserwatorem i dostaje ASSIGNED (+ e-mail z etapu 1)
    const assignedToJan = await call(
      issueByIdRoute.PATCH,
      `/issues/${issueId}`,
      { method: "PATCH", body: { assigneeAccountId: jan.accountId }, token: annaToken },
      { issueId },
    );
    expect(assignedToJan.status).toBe(200);
    expect(capturedNotifications).toHaveLength(1);

    const janDetail = await call(issueByIdRoute.GET, `/issues/${issueId}`, { token: janToken }, { issueId });
    expect(janDetail.body.data.isSubscribed).toBe(true);

    // Gość ręcznie zaczyna obserwować zadanie
    const guestSub = await call(
      subscriptionRoute.PUT,
      `/issues/${issueId}/subscription`,
      { method: "PUT", token: goscToken },
      { issueId },
    );
    expect(guestSub.status).toBe(200);
    expect(guestSub.body.data).toEqual({ issueId, isSubscribed: true });

    // Anna komentuje ze wzmiankami:
    // - Jan (członek zespołu i już obserwujący -> ma dostać MENTIONED bez duplikatu COMMENTED),
    // - Marek (członek zespołu, nie obserwował -> zostaje wspomniany i automatycznie subskrybowany),
    // - Ferdynand (spoza zespołu Magazyn -> ignorowany!),
    // - Anna (sama siebie -> brak wpisu w skrzynce).
    // Gość (obserwujący bez wzmianki) -> ma dostać COMMENTED.
    const commentRes = await call(
      commentsRoute.POST,
      `/issues/${issueId}/comments`,
      {
        method: "POST",
        body: {
          body: `Proszę o weryfikację @[Jan Kowalski](${jan.accountId}), @[Marek Lider](${teamLead.accountId}), @[Ferdynand](${finanseOnly.accountId}) oraz @[Anna Nowak](${anna.accountId}).`,
        },
        token: annaToken,
      },
      { issueId },
    );
    expect(commentRes.status).toBe(201);
    expect([...commentRes.body.data.mentionedAccountIds].sort()).toEqual(
      [jan.accountId, teamLead.accountId, anna.accountId].sort(),
    );
    // Wzmianki nie wysyłają e-maila przez Core (nadal tylko 1 e-mail z przypisania)
    expect(capturedNotifications).toHaveLength(1);

    // 1. Anna (sprawca) nadal ma 0 wpisów w skrzynce
    const annaInbox = await call(inboxRoute.GET, "/inbox?filter=all", { token: annaToken });
    expect(annaInbox.body.data).toHaveLength(0);

    // 2. Jan ma dokładnie 2 wpisy: MENTIONED oraz ASSIGNED, BEZ duplikatu COMMENTED
    const janInbox = await call(inboxRoute.GET, "/inbox?filter=unread", { token: janToken });
    expect(janInbox.status).toBe(200);
    expect(janInbox.body.data).toHaveLength(2);
    expect(new Set(janInbox.body.data.map((item: { kind: string }) => item.kind))).toEqual(
      new Set(["MENTIONED", "ASSIGNED"]),
    );
    expect(janInbox.body.data[0].issue.identifier).toBe("MAG-1");

    // 3. Marek został wspomniany -> ma 1 wpis MENTIONED i jest obserwatorem zadania
    const leadInbox = await call(inboxRoute.GET, "/inbox?filter=unread", { token: teamLeadToken });
    expect(leadInbox.body.data).toHaveLength(1);
    expect(leadInbox.body.data[0].kind).toBe("MENTIONED");
    const leadDetail = await call(issueByIdRoute.GET, `/issues/${issueId}`, { token: teamLeadToken }, { issueId });
    expect(leadDetail.body.data.isSubscribed).toBe(true);

    // 4. Gość (obserwujący bez wzmianki) ma 1 wpis COMMENTED
    const guestInbox = await call(inboxRoute.GET, "/inbox?filter=unread", { token: goscToken });
    expect(guestInbox.body.data).toHaveLength(1);
    expect(guestInbox.body.data[0].kind).toBe("COMMENTED");

    // 5. Ferdynand (spoza zespołu) nie dostał żadnego wpisu mimo tokenu wzmianki
    const finInbox = await call(inboxRoute.GET, "/inbox?filter=all", { token: finanseToken });
    expect(finInbox.body.data).toHaveLength(0);

    // 6. Izolacja skrzynki między osobami: Anna próbuje zmienić wpis Jana -> 404 NOT_FOUND
    const janItemId = janInbox.body.data[0].id as string;
    const crossPersonPatch = await call(
      inboxItemRoute.PATCH,
      `/inbox/${janItemId}`,
      { method: "PATCH", body: { read: true }, token: annaToken },
      { itemId: janItemId },
    );
    expect(crossPersonPatch.status).toBe(404);

    // 7. Jan oznacza jeden wpis jako przeczytany, sprawdza unread-count, a potem read-all i archiwizuje
    const markOneRead = await call(
      inboxItemRoute.PATCH,
      `/inbox/${janItemId}`,
      { method: "PATCH", body: { read: true }, token: janToken },
      { itemId: janItemId },
    );
    expect(markOneRead.status).toBe(200);
    expect(markOneRead.body.data.readAt).not.toBeNull();

    const janCountAfterOne = await call(inboxUnreadCountRoute.GET, "/inbox/unread-count", { token: janToken });
    expect(janCountAfterOne.body.data.unreadCount).toBe(1);

    const readAllRes = await call(inboxReadAllRoute.POST, "/inbox/read-all", { method: "POST", token: janToken });
    expect(readAllRes.status).toBe(200);
    expect(readAllRes.body.data.updatedCount).toBe(1);

    const janUnreadZero = await call(inboxUnreadCountRoute.GET, "/inbox/unread-count", { token: janToken });
    expect(janUnreadZero.body.data.unreadCount).toBe(0);

    const archiveRes = await call(
      inboxItemRoute.PATCH,
      `/inbox/${janItemId}`,
      { method: "PATCH", body: { archived: true }, token: janToken },
      { itemId: janItemId },
    );
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.archivedAt).not.toBeNull();

    const janAllAfterArchive = await call(inboxRoute.GET, "/inbox?filter=all", { token: janToken });
    expect(janAllAfterArchive.body.data).toHaveLength(1);

    // 8. Gość przestaje obserwować -> kolejny komentarz Anny nie trafia do skrzynki Gościa
    const unsubRes = await call(
      subscriptionRoute.DELETE,
      `/issues/${issueId}/subscription`,
      { method: "DELETE", token: goscToken },
      { issueId },
    );
    expect(unsubRes.status).toBe(204);

    await call(
      commentsRoute.POST,
      `/issues/${issueId}/comments`,
      { method: "POST", body: { body: "Kolejna aktualizacja" }, token: annaToken },
      { issueId },
    );
    const guestCountAfterUnsub = await call(inboxUnreadCountRoute.GET, "/inbox/unread-count", { token: goscToken });
    expect(guestCountAfterUnsub.body.data.unreadCount).toBe(1);
  });
});

describe("historia zmian zadania (issue_events) i chronologiczny strumień aktywności", () => {
  it("zapisuje zdarzenia dla każdego zmienionego pola, nic dla no-op, relacje i usunięcie oraz stronicuje aktywność", async () => {
    const statesRes = await call(
      statesRoute.GET,
      `/teams/${unitMagazynId}/states`,
      { token: ownerToken },
      { teamId: unitMagazynId },
    );
    const states = statesRes.body.data.states as { id: string; name: string }[];
    const inProgress = states.find((s) => s.name === "W toku")!;

    const labelRes = await call(
      labelsRoute.POST,
      `/teams/${unitMagazynId}/labels`,
      { method: "POST", body: { name: "Pilne", color: "red" }, token: teamLeadToken },
      { teamId: unitMagazynId },
    );
    const labelId = labelRes.body.data.id as string;

    const parentIssue = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Zadanie nadrzędne" },
      token: annaToken,
    });
    const parentId = parentIssue.body.data.id as string;

    const otherIssue = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Zadanie powiązane" },
      token: annaToken,
    });
    const otherId = otherIssue.body.data.id as string;

    // 1. Tworzenie zadania -> CREATED
    const created = await call(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Tytuł początkowy" },
      token: annaToken,
    });
    const issueId = created.body.data.id as string;
    await new Promise((resolve) => setTimeout(resolve, 5));

    // 2. Aktualizacja no-op (ten sam tytuł + samo sortOrder) -> ZERO nowych zdarzeń
    await call(
      issueByIdRoute.PATCH,
      `/issues/${issueId}`,
      { method: "PATCH", body: { title: "Tytuł początkowy", sortOrder: 1500 }, token: annaToken },
      { issueId },
    );
    const afterNoOp = await call(
      issueActivityRoute.GET,
      `/issues/${issueId}/activity`,
      { token: annaToken },
      { issueId },
    );
    expect(afterNoOp.body.data).toHaveLength(1);
    expect(afterNoOp.body.data[0].event.type).toBe("CREATED");

    // 3. Zmiana wszystkich rejestrowanych pól naraz
    const secretDescription = "Długi poufny opis zadania, który nie może pojawić się w issue_events";
    await call(
      issueByIdRoute.PATCH,
      `/issues/${issueId}`,
      {
        method: "PATCH",
        body: {
          title: "Tytuł zmieniony",
          description: secretDescription,
          stateId: inProgress.id,
          priority: 1,
          assigneeAccountId: jan.accountId,
          labelIds: [labelId],
          dueDate: "2026-12-20",
          estimate: 8,
          parentId,
        },
        token: annaToken,
      },
      { issueId },
    );

    // 4. Relacja dodana i usunięta
    const rel = await call(
      relationsRoute.POST,
      `/issues/${issueId}/relations`,
      { method: "POST", body: { relatedIssueId: otherId, type: "BLOCKS" }, token: annaToken },
      { issueId },
    );
    const relationId = rel.body.data.id as string;

    await call(
      relationByIdRoute.DELETE,
      `/issues/${issueId}/relations/${relationId}`,
      { method: "DELETE", token: annaToken },
      { issueId, relationId },
    );

    // 5. Komentarz na końcu strumienia
    await new Promise((resolve) => setTimeout(resolve, 5));
    await call(
      commentsRoute.POST,
      `/issues/${issueId}/comments`,
      { method: "POST", body: { body: "Podsumowanie zmian" }, token: annaToken },
      { issueId },
    );

    // 6. Stronicowanie kursorowe strumienia aktywności (po 5 pozycji) zbiera wszystko chronologicznie
    const collected: { kind: string; id: string; event?: { type: string; before: unknown; after: unknown } }[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `?limit=5&cursor=${encodeURIComponent(cursor)}` : "?limit=5";
      const page: { status: number; body: TestEnvelope } = await call(
        issueActivityRoute.GET,
        `/issues/${issueId}/activity${qs}`,
        { token: annaToken },
        { issueId },
      );
      expect(page.status).toBe(200);
      collected.push(...page.body.data);
      cursor = (page.body.meta.nextCursor as string | null) ?? null;
    } while (cursor);

    const eventTypes = collected.filter((i) => i.kind === "event").map((i) => i.event!.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "CREATED",
        "TITLE_CHANGED",
        "DESCRIPTION_CHANGED",
        "STATE_CHANGED",
        "PRIORITY_CHANGED",
        "ASSIGNEE_CHANGED",
        "LABELS_CHANGED",
        "DUE_DATE_CHANGED",
        "ESTIMATE_CHANGED",
        "PARENT_CHANGED",
        "RELATION_ADDED",
        "RELATION_REMOVED",
      ]),
    );
    expect(collected[0]?.kind).toBe("event");
    expect(collected[0]?.event?.type).toBe("CREATED");
    expect(collected[collected.length - 1]?.kind).toBe("comment");

    // Opis w DESCRIPTION_CHANGED ma wyłącznie flagę, nigdy pełnego tekstu
    const descItem = collected.find((i) => i.event?.type === "DESCRIPTION_CHANGED");
    expect(descItem?.event?.before).toEqual({ hasDescription: false });
    expect(descItem?.event?.after).toEqual({ hasDescription: true });
    expect(JSON.stringify(collected)).not.toContain(secretDescription);

    // 7. Miękkie usunięcie zadania zapisuje zdarzenie DELETED w tej samej transakcji
    const delRes = await call(
      issueByIdRoute.DELETE,
      `/issues/${issueId}`,
      { method: "DELETE", token: annaToken },
      { issueId },
    );
    expect(delRes.status).toBe(204);

    const deletedEvents = await withUser(
      getDb(),
      { organizationId: acme.id, accountId: anna.accountId },
      (tx) =>
        tx.$queryRaw<{ type: string }[]>`
        SELECT "type"::text AS "type"
        FROM "public"."issue_events"
        WHERE "issue_id" = ${issueId}::uuid AND "type" = 'DELETED'::"public"."IssueEventType"
      `,
    );
    expect(deletedEvents).toHaveLength(1);
  });
});
