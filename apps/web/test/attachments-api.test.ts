/**
 * Testy tras załączników i limitu miejsca firmy etapu 2b na prawdziwych handlerach Next.js,
 * prawdziwym PostgreSQL z wymuszonym RLS oraz prawdziwym magazynie S3 (lokalnie MinIO: `pnpm storage:up`).
 *
 * Bez kopii magazynu w pamięci i bez atrap S3; jedyną atrapą jest `createFakeCore` z `@monorise-team/testing`.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
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
import * as attachmentByIdRoute from "@/app/api/v1/attachments/[attachmentId]/route";
import * as attachmentContentRoute from "@/app/api/v1/attachments/[attachmentId]/content/route";
import * as issueByIdRoute from "@/app/api/v1/issues/[issueId]/route";
import * as issueActivityRoute from "@/app/api/v1/issues/[issueId]/activity/route";
import * as issueAttachmentsRoute from "@/app/api/v1/issues/[issueId]/attachments/route";
import * as issuesRoute from "@/app/api/v1/issues/route";
import * as storageRoute from "@/app/api/v1/storage/route";
import * as teamsRoute from "@/app/api/v1/teams/route";
import { buildAttachmentStorageKey } from "@/server/attachment-helpers";
import { getAuth } from "@/server/auth";
import { resetMachineCoreTokenCache, setCoreRetryForTests } from "@/server/core";
import { invalidateDirectoryNamesCache } from "@/server/core-directory";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_NOTIFICATIONS_SEND_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import { getDb } from "@/server/db";
import { resetFileStorageClient } from "@/server/file-storage";
import { invalidatePermissionCache } from "@/server/permissions";
import { createFakeCoreWithUnitsFetch } from "./helpers/fake-core-units";

const API = "http://kivo.localhost:3500";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.attachments.test";
const CLIENT_ID = "kivotasks-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

const TEST_S3_ENDPOINT = process.env.KIVOTASKS_TEST_S3_ENDPOINT ?? "http://127.0.0.1:9036";
const TEST_S3_REGION = process.env.KIVOTASKS_TEST_S3_REGION ?? "eu-central-1";
const TEST_S3_BUCKET = process.env.KIVOTASKS_TEST_S3_BUCKET ?? "kivo-tasks-attachments-test";
const TEST_S3_ACCESS_KEY = process.env.KIVOTASKS_TEST_S3_ACCESS_KEY_ID ?? "kivo_tasks_storage";
const TEST_S3_SECRET_KEY = process.env.KIVOTASKS_TEST_S3_SECRET_ACCESS_KEY ?? "kivo_tasks_storage_local";

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- w testach czytamy odpowiedzi API swobodnie
type TestEnvelope = { data: any; meta: any; error: any };

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

let testS3: S3Client;
let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let globex: FakeOrganizationBuilder;

let unitMagazynId: string;
let unitFinanseId: string;

let owner: CreatedEmployeeWithAccount;
let anna: CreatedEmployeeWithAccount;
let jan: CreatedEmployeeWithAccount;
let gosc: CreatedEmployeeWithAccount;
let teamLead: CreatedEmployeeWithAccount;
let finanseOnly: CreatedEmployeeWithAccount;
let productOnly: CreatedEmployeeWithAccount;
let celinaGlobex: CreatedEmployeeWithAccount;
let guestRoleId: string;
let annaMemberAssignmentId: string;

let annaToken: string;
let janToken: string;
let goscToken: string;
let teamLeadToken: string;
let finanseToken: string;
let productOnlyToken: string;
let celinaToken: string;

function makePngBytes(totalLength = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(PNG_HEADER.length, totalLength));
  bytes.set(PNG_HEADER, 0);
  for (let i = PNG_HEADER.length; i < bytes.length; i++) {
    bytes[i] = i % 251;
  }
  return bytes;
}

function callJson<P>(
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
    headers: response.headers,
    body:
      response.status === 204 || response.status === 304
        ? ({ data: null, meta: null, error: null } as TestEnvelope)
        : ((await response.json()) as TestEnvelope),
  }));
}

function callUpload(
  issueId: string,
  options: {
    file?: { bytes: Uint8Array; name: string; type?: string };
    formData?: FormData;
    rawBody?: BodyInit;
    token?: string;
    headers?: Record<string, string>;
    omitDefaultOrigin?: boolean;
  },
) {
  const headers: Record<string, string> = { host: "kivo.localhost:3500", ...options.headers };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  } else if (!options.omitDefaultOrigin) {
    headers.origin ??= API;
  }

  let body: BodyInit | undefined = options.rawBody;
  if (options.formData) {
    body = options.formData;
  } else if (options.file) {
    const fd = new FormData();
    const copy = new Uint8Array(options.file.bytes);
    fd.append("file", new File([copy], options.file.name, { type: options.file.type ?? "application/octet-stream" }));
    body = fd;
  }

  const request = new NextRequest(`${BASE}/issues/${issueId}/attachments`, {
    method: "POST",
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  return issueAttachmentsRoute.POST(request, { params: Promise.resolve({ issueId }) }).then(async (response) => ({
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as TestEnvelope,
  }));
}

function callContent(attachmentId: string, options: { token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "kivo.localhost:3500", ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const request = new NextRequest(`${BASE}/attachments/${attachmentId}/content`, {
    method: "GET",
    headers,
  });
  return attachmentContentRoute.GET(request, { params: Promise.resolve({ attachmentId }) });
}

async function ensureTestBucket(): Promise<void> {
  try {
    await testS3.send(new HeadBucketCommand({ Bucket: TEST_S3_BUCKET }));
  } catch {
    try {
      await testS3.send(new CreateBucketCommand({ Bucket: TEST_S3_BUCKET }));
    } catch (error) {
      const code = (error as { name?: string; Code?: string })?.name ?? (error as { Code?: string })?.Code;
      if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") {
        throw error;
      }
    }
  }
}

async function cleanupS3Prefix(organizationId: string): Promise<void> {
  const prefix = `organizations/${organizationId}/`;
  let continuationToken: string | undefined;
  do {
    const listed = await testS3.send(
      new ListObjectsV2Command({
        Bucket: TEST_S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of listed.Contents ?? []) {
      if (item.Key) {
        await testS3.send(new DeleteObjectCommand({ Bucket: TEST_S3_BUCKET, Key: item.Key }));
      }
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function objectExistsInS3(key: string): Promise<boolean> {
  try {
    await testS3.send(new HeadObjectCommand({ Bucket: TEST_S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function setupSession(org: FakeOrganizationBuilder, employee: CreatedEmployeeWithAccount) {
  const coreToken = await org.signUserToken(employee.accountId, { audience: fakeCore.coreApiUrl });
  const context = {
    accountId: employee.accountId,
    organizationId: org.id,
    employeeId: employee.employeeId,
    sessionId: "sesja-attachments-test",
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
    await tx.$executeRaw`DELETE FROM "public"."issue_attachments"`;
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
  await cleanupS3Prefix(organizationId);
}

async function createMagazynIssue(title = "Zadanie z załącznikami"): Promise<string> {
  const res = await callJson(issuesRoute.POST, "/issues", {
    method: "POST",
    body: { teamId: unitMagazynId, title },
    token: annaToken,
  });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

beforeAll(async () => {
  testS3 = new S3Client({
    endpoint: TEST_S3_ENDPOINT,
    region: TEST_S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: TEST_S3_ACCESS_KEY, secretAccessKey: TEST_S3_SECRET_KEY },
  });
  await ensureTestBucket();

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
});

beforeEach(async () => {
  process.env = {
    ...originalEnv,
    CORE_AUTH_URL: FAKE_CORE_URL,
    CORE_API_URL: FAKE_CORE_URL,
    KIVOTASKS_APP_URL: "http://kivotasks.localhost:3500",
    KIVOTASKS_S3_ENDPOINT: TEST_S3_ENDPOINT,
    KIVOTASKS_S3_REGION: TEST_S3_REGION,
    KIVOTASKS_S3_BUCKET: TEST_S3_BUCKET,
    KIVOTASKS_S3_FORCE_PATH_STYLE: "true",
    KIVOTASKS_S3_ACCESS_KEY_ID: TEST_S3_ACCESS_KEY,
    KIVOTASKS_S3_SECRET_ACCESS_KEY: TEST_S3_SECRET_KEY,
    KIVOTASKS_ATTACHMENT_MAX_BYTES: "4096",
    KIVOTASKS_STORAGE_QUOTA_BYTES: "10000",
  };
  delete process.env.KIVOTASKS_CORE_JWKS;

  fakeCore.reset();
  setCoreRetryForTests(false);
  invalidatePermissionCache();
  invalidateDirectoryNamesCache();
  resetMachineCoreTokenCache();
  resetFileStorageClient();

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
  guestRoleId = acme.addRole({
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
  productOnly = acme.addEmployee({
    firstName: "Bez",
    lastName: "Roli",
    products: ["kivotasks"],
  });

  annaMemberAssignmentId = acme.assignRole({
    accountId: anna.accountId,
    roleId: memberRoleId,
    scope: { type: "UNIT", unitId: unitMagazynId },
  }).id;
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

  globex = fakeCore.organization({ name: "Globex", domain: "globex.test" });
  globex.grantEntitlement("kivotasks");
  const globexUnit = globex.addUnit({ name: "Operacje", type: "TEAM" });
  celinaGlobex = globex.addEmployee({
    firstName: "Celina",
    lastName: "Obca",
    isOwner: true,
    unitIds: [globexUnit.id],
  });

  const coreFetch = createFakeCoreWithUnitsFetch(fakeCore);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (rawUrl.startsWith(FAKE_CORE_URL)) {
      return coreFetch(input, init);
    }
    return originalFetch(input, init);
  });

  const restore = await setupSession(acme, owner);
  await callJson(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitMagazynId, key: "MAG" } });
  await callJson(teamsRoute.POST, "/teams", { method: "POST", body: { unitId: unitFinanseId, key: "FIN" } });
  restore();

  annaToken = await acme.signUserToken(anna.accountId, { audience: API });
  janToken = await acme.signUserToken(jan.accountId, { audience: API });
  goscToken = await acme.signUserToken(gosc.accountId, { audience: API });
  teamLeadToken = await acme.signUserToken(teamLead.accountId, { audience: API });
  finanseToken = await acme.signUserToken(finanseOnly.accountId, { audience: API });
  productOnlyToken = await acme.signUserToken(productOnly.accountId, { audience: API });
  celinaToken = await globex.signUserToken(celinaGlobex.accountId, { audience: API });
});

afterEach(async () => {
  await cleanupOrg(acme.id, owner.accountId);
  await cleanupOrg(globex.id, celinaGlobex.accountId);
  vi.restoreAllMocks();
  setCoreRetryForTests();
  resetFileStorageClient();
  process.env = { ...originalEnv };
});

afterAll(async () => {
  vi.restoreAllMocks();
  setCoreRetryForTests();
  resetFileStorageClient();
  testS3.destroy();
  await getDb().$disconnect();
});

describe("wysyłanie, detekcja MIME, nagłówki bezpieczeństwa i If-None-Match", () => {
  it("zapisuje PNG z nagłówkami inline, a HTML udający PNG oraz SVG jako application/octet-stream (attachment)", async () => {
    const issueId = await createMagazynIssue();
    const pngBytes = makePngBytes(128);

    // 1. Prawdziwy PNG -> inline
    const pngUpload = await callUpload(issueId, {
      file: { bytes: pngBytes, name: "zrzut.png", type: "application/octet-stream" },
      token: annaToken,
    });
    expect(pngUpload.status).toBe(201);
    const pngAtt = pngUpload.body.data;
    expect(pngAtt).toMatchObject({
      issueId,
      fileName: "zrzut.png",
      contentType: "image/png",
      sizeBytes: pngBytes.byteLength,
      uploader: { accountId: anna.accountId, name: "Anna Nowak" },
      contentUrl: `/api/v1/attachments/${pngAtt.id}/content`,
      inline: true,
      canDelete: true,
    });

    const pngContent = await callContent(pngAtt.id, { token: annaToken });
    expect(pngContent.status).toBe(200);
    expect(pngContent.headers.get("content-type")).toBe("image/png");
    expect(pngContent.headers.get("content-length")).toBe(String(pngBytes.byteLength));
    expect(pngContent.headers.get("content-disposition")).toBe(
      `inline; filename="zrzut.png"; filename*=UTF-8''zrzut.png`,
    );
    expect(pngContent.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pngContent.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(pngContent.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(pngContent.headers.get("cache-control")).toBe("private, no-cache");
    expect(pngContent.headers.get("etag")).toBe(`"${pngAtt.id}"`);
    expect(pngContent.headers.get("x-request-id")).toMatch(/^req_/);
    expect(new Uint8Array(await pngContent.arrayBuffer())).toEqual(pngBytes);

    // If-None-Match -> 304 bez ciała
    const notModified = await callContent(pngAtt.id, {
      token: annaToken,
      headers: { "if-none-match": `"${pngAtt.id}"` },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(`"${pngAtt.id}"`);
    expect(await notModified.text()).toBe("");

    // 2. HTML zadeklarowany jako image/png -> application/octet-stream + attachment
    const htmlBytes = new TextEncoder().encode("<html><body><script>alert(1)</script></body></html>");
    const htmlUpload = await callUpload(issueId, {
      file: { bytes: htmlBytes, name: "podstępny.png", type: "image/png" },
      token: annaToken,
    });
    expect(htmlUpload.status).toBe(201);
    expect(htmlUpload.body.data).toMatchObject({
      contentType: "application/octet-stream",
      inline: false,
    });
    const htmlContent = await callContent(htmlUpload.body.data.id, { token: annaToken });
    expect(htmlContent.status).toBe(200);
    expect(htmlContent.headers.get("content-type")).toBe("application/octet-stream");
    expect(htmlContent.headers.get("content-disposition")?.startsWith("attachment;")).toBe(true);

    // 3. SVG -> application/octet-stream + attachment + nazwa z polskimi znakami i cudzysłowami
    const svgBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const trickyName = `zażółć "ikona".svg`;
    const svgUpload = await callUpload(issueId, {
      file: { bytes: svgBytes, name: trickyName, type: "image/svg+xml" },
      token: annaToken,
    });
    expect(svgUpload.status).toBe(201);
    expect(svgUpload.body.data).toMatchObject({
      fileName: trickyName,
      contentType: "application/octet-stream",
      inline: false,
    });
    const svgContent = await callContent(svgUpload.body.data.id, { token: annaToken });
    expect(svgContent.status).toBe(200);
    expect(svgContent.headers.get("content-type")).toBe("application/octet-stream");
    expect(svgContent.headers.get("content-disposition")).toBe(
      `attachment; filename="za____ _ikona_.svg"; filename*=UTF-8''${encodeURIComponent(trickyName)}`,
    );

    // 4. Lista załączników zwraca od najnowszych i obsługuje stronicowanie kursorowe
    const page1 = await callJson(
      issueAttachmentsRoute.GET,
      `/issues/${issueId}/attachments?limit=2`,
      { token: annaToken },
      { issueId },
    );
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.nextCursor).toBeTruthy();

    const page2 = await callJson(
      issueAttachmentsRoute.GET,
      `/issues/${issueId}/attachments?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`,
      { token: annaToken },
      { issueId },
    );
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta.nextCursor).toBeNull();
    expect(page2.body.data[0].id).toBe(pngAtt.id);
  });
});

describe("walidacja rozmiaru, pustego/brakującego pliku, limit miejsca i wyścig równoległy", () => {
  it("odrzuca 413 po Content-Length oraz po rozmiarze pliku, a pusty i brakujący plik kodem 422", async () => {
    process.env.KIVOTASKS_ATTACHMENT_MAX_BYTES = "1024";
    const issueId = await createMagazynIssue();

    // 413 przez Content-Length (przed odczytem treści)
    const tooLargeHeader = await callUpload(issueId, {
      rawBody: "x",
      token: annaToken,
      headers: {
        "content-type": "multipart/form-data; boundary=---test",
        "content-length": String(1024 + 64 * 1024 + 1),
      },
    });
    expect(tooLargeHeader.status).toBe(413);
    expect(tooLargeHeader.body.error.code).toBe("PAYLOAD_TOO_LARGE");

    // 413 przez faktyczny rozmiar pliku (Content-Length poniżej 1024 + 64 KiB, ale plik ma 1025 B)
    const tooLargeFile = await callUpload(issueId, {
      file: { bytes: makePngBytes(1025), name: "duzy.png", type: "image/png" },
      token: annaToken,
    });
    expect(tooLargeFile.status).toBe(413);
    expect(tooLargeFile.body.error.code).toBe("PAYLOAD_TOO_LARGE");

    // 413 dla strumieniowego body bez Content-Length (chunked / HTTP/2) przekraczającego limit + narzut multipart
    const chunkSize = 16 * 1024;
    const totalChunks = 16; // 256 KiB > 1024 + 64 KiB
    let chunksPulled = 0;
    const streamedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksPulled >= totalChunks) {
          controller.close();
          return;
        }
        chunksPulled += 1;
        controller.enqueue(new Uint8Array(chunkSize));
      },
    });
    const streamedReq = new NextRequest(`${BASE}/issues/${issueId}/attachments`, {
      method: "POST",
      headers: {
        host: "kivo.localhost:3500",
        authorization: `Bearer ${annaToken}`,
        "content-type": "multipart/form-data; boundary=---stream-test",
      },
      body: streamedBody,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });
    expect(streamedReq.headers.get("content-length")).toBeNull();
    const streamedRes = await issueAttachmentsRoute.POST(streamedReq, { params: Promise.resolve({ issueId }) });
    const streamedJson = (await streamedRes.json()) as TestEnvelope;
    expect(streamedRes.status).toBe(413);
    expect(streamedJson.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(chunksPulled).toBeLessThan(totalChunks);

    // Pusty plik -> 422
    const emptyFile = await callUpload(issueId, {
      file: { bytes: new Uint8Array(0), name: "pusty.txt" },
      token: annaToken,
    });
    expect(emptyFile.status).toBe(422);
    expect(emptyFile.body.error.code).toBe("VALIDATION_FAILED");

    // Brak części file -> 422
    const missingPart = new FormData();
    missingPart.append("other", new File([new Uint8Array([1, 2, 3])], "inny.txt"));
    const noFile = await callUpload(issueId, { formData: missingPart, token: annaToken });
    expect(noFile.status).toBe(422);
    expect(noFile.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("pilnuje limitu miejsca (409), serializuje równoległe wysyłki i raportuje stany OK/WARNING/FULL w /storage", async () => {
    process.env.KIVOTASKS_ATTACHMENT_MAX_BYTES = "1024";
    process.env.KIVOTASKS_STORAGE_QUOTA_BYTES = "1000";
    const issueId = await createMagazynIssue();

    // GET /api/v1/storage działa dla konta z samym dostępem do produktu (bez roli)
    const initialStorage = await callJson(storageRoute.GET, "/storage", { token: productOnlyToken });
    expect(initialStorage.status).toBe(200);
    expect(initialStorage.body.data).toEqual({
      usedBytes: 0,
      quotaBytes: 1000,
      maxFileBytes: 1024,
      usedRatio: 0,
      state: "OK",
    });

    // Dwa równoległe uploady po 600 B przy limicie 1000 B -> dokładnie jeden 201 i jeden 409
    const [r1, r2] = await Promise.all([
      callUpload(issueId, { file: { bytes: makePngBytes(600), name: "pierwszy.png" }, token: annaToken }),
      callUpload(issueId, { file: { bytes: makePngBytes(600), name: "drugi.png" }, token: janToken }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const rejected = r1.status === 409 ? r1 : r2;
    expect(rejected.body.error.code).toBe("STORAGE_QUOTA_EXCEEDED");

    const afterConcurrent = await callJson(storageRoute.GET, "/storage", { token: annaToken });
    expect(afterConcurrent.status).toBe(200);
    expect(afterConcurrent.body.data).toMatchObject({
      usedBytes: 600,
      quotaBytes: 1000,
      state: "OK",
    });

    // Odrzucony upload posprzątał swój obiekt z S3 (został dokładnie 1 obiekt dla firmy)
    const listedObjects = await testS3.send(
      new ListObjectsV2Command({ Bucket: TEST_S3_BUCKET, Prefix: `organizations/${acme.id}/` }),
    );
    expect(listedObjects.Contents ?? []).toHaveLength(1);

    // Kolejne 200 B -> 800/1000 = 0.8 -> WARNING
    const warningUpload = await callUpload(issueId, {
      file: { bytes: makePngBytes(200), name: "warning.png" },
      token: annaToken,
    });
    expect(warningUpload.status).toBe(201);
    const warningStorage = await callJson(storageRoute.GET, "/storage", { token: annaToken });
    expect(warningStorage.body.data).toMatchObject({
      usedBytes: 800,
      usedRatio: 0.8,
      state: "WARNING",
    });

    // Kolejne 200 B -> 1000/1000 -> FULL
    const fullUpload = await callUpload(issueId, {
      file: { bytes: makePngBytes(200), name: "full.png" },
      token: annaToken,
    });
    expect(fullUpload.status).toBe(201);
    const fullStorage = await callJson(storageRoute.GET, "/storage", { token: annaToken });
    expect(fullStorage.body.data).toMatchObject({
      usedBytes: 1000,
      usedRatio: 1,
      state: "FULL",
    });

    // Następny upload (nawet 10 B) -> 409 STORAGE_QUOTA_EXCEEDED
    const overQuota = await callUpload(issueId, {
      file: { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), name: "nadmiar.bin" },
      token: annaToken,
    });
    expect(overQuota.status).toBe(409);
    expect(overQuota.body.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });
});

describe("uprawnienia, izolacja zespołów i firm, usuwanie, historia aktywności i CSRF", () => {
  it("sprawdza role (Gość, autor, kierownik, inna osoba), izolację zespołów (404) i firm (404) oraz CSRF (403)", async () => {
    const issueId = await createMagazynIssue();

    // Gość (issues.read bez issues.write) nie może wysyłać -> 403
    const guestUpload = await callUpload(issueId, {
      file: { bytes: makePngBytes(64), name: "gosc.png" },
      token: goscToken,
    });
    expect(guestUpload.status).toBe(403);
    expect(guestUpload.body.error.code).toBe("PERMISSION_DENIED");

    // Cross-site POST bez zgodnego Origin (sesja z ciasteczka, bez Bearer) -> 403 CSRF
    const restoreAnnaSession = await setupSession(acme, anna);
    const csrfBlocked = await callUpload(issueId, {
      file: { bytes: makePngBytes(64), name: "csrf.png" },
      headers: { cookie: "monorise-session=x", origin: "https://zla-strona.example" },
    });
    expect(csrfBlocked.status).toBe(403);
    expect(csrfBlocked.body.error.code).toBe("PERMISSION_DENIED");

    const missingOrigin = await callUpload(issueId, {
      file: { bytes: makePngBytes(64), name: "no-origin.png" },
      headers: { cookie: "monorise-session=x" },
      omitDefaultOrigin: true,
    });
    expect(missingOrigin.status).toBe(403);

    const nullOrigin = await callUpload(issueId, {
      file: { bytes: makePngBytes(64), name: "null-origin.png" },
      headers: { cookie: "monorise-session=x", origin: "null" },
    });
    expect(nullOrigin.status).toBe(403);
    expect(nullOrigin.body.error.code).toBe("PERMISSION_DENIED");
    restoreAnnaSession();

    // Anna wysyła dwa pliki
    const up1 = await callUpload(issueId, {
      file: { bytes: makePngBytes(100), name: "jeden.png" },
      token: annaToken,
    });
    const up2 = await callUpload(issueId, {
      file: { bytes: makePngBytes(150), name: "dwa.png" },
      token: annaToken,
    });
    expect(up1.status).toBe(201);
    expect(up2.status).toBe(201);
    const att1Id = up1.body.data.id as string;
    const att2Id = up2.body.data.id as string;

    // Gość może listować, czytać metadane i pobierać treść, ale widzi canDelete: false i dostaje 403 przy usuwaniu
    const guestList = await callJson(
      issueAttachmentsRoute.GET,
      `/issues/${issueId}/attachments`,
      { token: goscToken },
      { issueId },
    );
    expect(guestList.status).toBe(200);
    expect(guestList.body.data).toHaveLength(2);
    expect(guestList.body.data[0].canDelete).toBe(false);

    const guestMeta = await callJson(
      attachmentByIdRoute.GET,
      `/attachments/${att1Id}`,
      { token: goscToken },
      { attachmentId: att1Id },
    );
    expect(guestMeta.status).toBe(200);
    expect(guestMeta.body.data.canDelete).toBe(false);

    const guestDownload = await callContent(att1Id, { token: goscToken });
    expect(guestDownload.status).toBe(200);

    // Jan (inny członek z issues.write, nie jest autorem ani kierownikiem) -> 403 przy usuwaniu
    const janDelete = await callJson(
      attachmentByIdRoute.DELETE,
      `/attachments/${att1Id}`,
      { method: "DELETE", token: janToken },
      { attachmentId: att1Id },
    );
    expect(janDelete.status).toBe(403);

    // Osoba z innego zespołu (Finanse) -> 404 na wszystkich trasach (w tym z If-None-Match)
    expect(
      (
        await callJson(
          issueAttachmentsRoute.GET,
          `/issues/${issueId}/attachments`,
          { token: finanseToken },
          { issueId },
        )
      ).status,
    ).toBe(404);
    expect(
      (await callUpload(issueId, { file: { bytes: makePngBytes(32), name: "obcy.png" }, token: finanseToken })).status,
    ).toBe(404);
    expect(
      (
        await callJson(
          attachmentByIdRoute.GET,
          `/attachments/${att1Id}`,
          { token: finanseToken },
          { attachmentId: att1Id },
        )
      ).status,
    ).toBe(404);
    expect(
      (await callContent(att1Id, { token: finanseToken, headers: { "if-none-match": `"${att1Id}"` } })).status,
    ).toBe(404);
    expect(
      (
        await callJson(
          attachmentByIdRoute.DELETE,
          `/attachments/${att1Id}`,
          { method: "DELETE", token: finanseToken },
          { attachmentId: att1Id },
        )
      ).status,
    ).toBe(404);

    // Osoba z innej firmy (Celina z Globex) -> 404 (izolacja firm RLS)
    expect(
      (await callJson(issueAttachmentsRoute.GET, `/issues/${issueId}/attachments`, { token: celinaToken }, { issueId }))
        .status,
    ).toBe(404);
    expect(
      (
        await callJson(
          attachmentByIdRoute.GET,
          `/attachments/${att1Id}`,
          { token: celinaToken },
          { attachmentId: att1Id },
        )
      ).status,
    ).toBe(404);
    expect((await callContent(att1Id, { token: celinaToken })).status).toBe(404);
    expect(
      (
        await callJson(
          attachmentByIdRoute.DELETE,
          `/attachments/${att1Id}`,
          { method: "DELETE", token: celinaToken },
          { attachmentId: att1Id },
        )
      ).status,
    ).toBe(404);

    // Autorka (Anna z issues.write) usuwa att1 -> 204, znika z listy, spada zużycie, obiekt znika z MinIO
    const att1Key = buildAttachmentStorageKey({ organizationId: acme.id, issueId, attachmentId: att1Id });
    expect(await objectExistsInS3(att1Key)).toBe(true);

    const annaDelete = await callJson(
      attachmentByIdRoute.DELETE,
      `/attachments/${att1Id}`,
      { method: "DELETE", token: annaToken },
      { attachmentId: att1Id },
    );
    expect(annaDelete.status).toBe(204);
    expect(await objectExistsInS3(att1Key)).toBe(false);

    expect(
      (
        await callJson(
          attachmentByIdRoute.GET,
          `/attachments/${att1Id}`,
          { token: annaToken },
          { attachmentId: att1Id },
        )
      ).status,
    ).toBe(404);
    expect((await callContent(att1Id, { token: annaToken })).status).toBe(404);

    const listAfterOneDelete = await callJson(
      issueAttachmentsRoute.GET,
      `/issues/${issueId}/attachments`,
      { token: annaToken },
      { issueId },
    );
    expect(listAfterOneDelete.body.data.map((a: { id: string }) => a.id)).toEqual([att2Id]);

    const usageAfterDelete = await callJson(storageRoute.GET, "/storage", { token: annaToken });
    expect(usageAfterDelete.body.data.usedBytes).toBe(150);

    // Kierownik zespołu (Marek z teams.manage) usuwa cudzy załącznik att2 -> 204
    const managerDelete = await callJson(
      attachmentByIdRoute.DELETE,
      `/attachments/${att2Id}`,
      { method: "DELETE", token: teamLeadToken },
      { attachmentId: att2Id },
    );
    expect(managerDelete.status).toBe(204);

    const usageEmpty = await callJson(storageRoute.GET, "/storage", { token: annaToken });
    expect(usageEmpty.body.data.usedBytes).toBe(0);

    // Zdarzenia ATTACHMENT_ADDED i ATTACHMENT_REMOVED pojawiają się w /activity
    const activity = await callJson(
      issueActivityRoute.GET,
      `/issues/${issueId}/activity`,
      { token: annaToken },
      { issueId },
    );
    expect(activity.status).toBe(200);
    const events = (activity.body.data as { kind: string; event?: { type: string; before: unknown; after: unknown } }[])
      .filter((item) => item.kind === "event")
      .map((item) => item.event!);

    const addedEvents = events.filter((e) => e.type === "ATTACHMENT_ADDED");
    const removedEvents = events.filter((e) => e.type === "ATTACHMENT_REMOVED");
    expect(addedEvents).toHaveLength(2);
    expect(removedEvents).toHaveLength(2);
    expect(addedEvents[0]?.after).toEqual({
      attachmentId: att1Id,
      fileName: "jeden.png",
      sizeBytes: 100,
      contentType: "image/png",
    });
    expect(removedEvents[0]?.before).toEqual({
      attachmentId: att1Id,
      fileName: "jeden.png",
      sizeBytes: 100,
      contentType: "image/png",
    });
  });

  it("przy miękkim usunięciu zadania zwalnia miejsce firmy, usuwa obiekty z MinIO, zwraca 404 i nie rusza załączników odpiętych podzadań", async () => {
    const issueId = await createMagazynIssue("Zadanie do usunięcia");
    const subIssueRes = await callJson(issuesRoute.POST, "/issues", {
      method: "POST",
      body: { teamId: unitMagazynId, title: "Podzadanie zachowane", parentId: issueId },
      token: annaToken,
    });
    expect(subIssueRes.status).toBe(201);
    const subIssueId = subIssueRes.body.data.id as string;

    const up1 = await callUpload(issueId, {
      file: { bytes: makePngBytes(80), name: "plik1.png" },
      token: annaToken,
    });
    const up2 = await callUpload(issueId, {
      file: { bytes: makePngBytes(120), name: "plik2.png" },
      token: annaToken,
    });
    const subUp = await callUpload(subIssueId, {
      file: { bytes: makePngBytes(50), name: "podzadanie.png" },
      token: annaToken,
    });
    expect(up1.status).toBe(201);
    expect(up2.status).toBe(201);
    expect(subUp.status).toBe(201);

    const att1Id = up1.body.data.id as string;
    const att2Id = up2.body.data.id as string;
    const subAttId = subUp.body.data.id as string;
    const att1Key = buildAttachmentStorageKey({ organizationId: acme.id, issueId, attachmentId: att1Id });
    const att2Key = buildAttachmentStorageKey({ organizationId: acme.id, issueId, attachmentId: att2Id });
    const subAttKey = buildAttachmentStorageKey({
      organizationId: acme.id,
      issueId: subIssueId,
      attachmentId: subAttId,
    });

    expect((await callJson(storageRoute.GET, "/storage", { token: annaToken })).body.data.usedBytes).toBe(250);
    expect(await objectExistsInS3(att1Key)).toBe(true);
    expect(await objectExistsInS3(att2Key)).toBe(true);
    expect(await objectExistsInS3(subAttKey)).toBe(true);

    const delIssue = await callJson(
      issueByIdRoute.DELETE,
      `/issues/${issueId}`,
      { method: "DELETE", token: annaToken },
      { issueId },
    );
    expect(delIssue.status).toBe(204);

    // Załączniki usuniętego zadania zwracają 404, nie liczą się do limitu firmy i zniknęły z MinIO
    expect(
      (
        await callJson(
          attachmentByIdRoute.GET,
          `/attachments/${att1Id}`,
          { token: annaToken },
          { attachmentId: att1Id },
        )
      ).status,
    ).toBe(404);
    expect((await callContent(att1Id, { token: annaToken })).status).toBe(404);
    expect((await callContent(att2Id, { token: annaToken })).status).toBe(404);
    expect(await objectExistsInS3(att1Key)).toBe(false);
    expect(await objectExistsInS3(att2Key)).toBe(false);

    // Podzadanie zostało odpięte (nie usunięte), więc jego załącznik i zużycie 50 B pozostają aktywne
    expect((await callJson(storageRoute.GET, "/storage", { token: annaToken })).body.data.usedBytes).toBe(50);
    expect(await objectExistsInS3(subAttKey)).toBe(true);
    expect((await callContent(subAttId, { token: annaToken })).status).toBe(200);
  });

  it("odmawia (403) usunięcia własnego załącznika osobie, która utraciła uprawnienie kivotasks.issues.write", async () => {
    const issueId = await createMagazynIssue("Zadanie po degradacji roli");
    const uploaded = await callUpload(issueId, {
      file: { bytes: makePngBytes(64), name: "wlasny.png" },
      token: annaToken,
    });
    expect(uploaded.status).toBe(201);
    const attachmentId = uploaded.body.data.id as string;

    // Zdejmujemy rolę Członek KivoTasks i nadajemy wyłącznie Gość (issues.read) + podbijamy authz_rev
    acme.revokeRoleAssignment(annaMemberAssignmentId);
    acme.assignRole({ accountId: anna.accountId, roleId: guestRoleId, scope: { type: "UNIT", unitId: unitMagazynId } });
    const nextRev = acme.bumpAuthzRevision(anna.accountId);
    const downgradedToken = await acme.signUserToken(anna.accountId, { audience: API, authzRevision: nextRev });

    const meta = await callJson(
      attachmentByIdRoute.GET,
      `/attachments/${attachmentId}`,
      { token: downgradedToken },
      { attachmentId },
    );
    expect(meta.status).toBe(200);
    expect(meta.body.data.canDelete).toBe(false);

    const delRes = await callJson(
      attachmentByIdRoute.DELETE,
      `/attachments/${attachmentId}`,
      { method: "DELETE", token: downgradedToken },
      { attachmentId },
    );
    expect(delRes.status).toBe(403);
    expect(delRes.body.error.code).toBe("PERMISSION_DENIED");
  });
});
