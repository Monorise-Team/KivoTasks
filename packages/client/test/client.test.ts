import { describe, expect, it } from "vitest";
import { ApiError, attachmentContentUrl, createClient, type Me } from "../src/index.js";

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    if (status === 204) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

const SAMPLE_ME: Me = {
  account: { id: "acc-1", email: "anna@acme.test" },
  employee: { id: "emp-1", firstName: "Anna", lastName: "Nowak", fullName: "Anna Nowak", jobTitle: null },
  organization: { id: "org-1", name: "Acme" },
  capabilities: {
    hasProductAccess: true,
    readIssues: true,
    writeIssues: true,
    manageTeams: false,
    createTeams: false,
    manageProjects: false,
  },
};

describe("klient API KivoTasks", () => {
  it("w przeglądarce dokleja /api/v1 i wysyła ciasteczko sesji bez nagłówka Authorization", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({ fetch: fakeFetch(200, { data: SAMPLE_ME, meta: {}, error: null }, seen) });
    expect(await client.session.me()).toEqual(SAMPLE_ME);
    expect(seen.url).toBe("/api/v1/me");
    expect(seen.init?.credentials).toBe("same-origin");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("przy podanym getToken wysyła nagłówek Authorization i pomija ciasteczka", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({
      baseUrl: "https://kivo.monorise.studio",
      getToken: () => "tajny-token",
      fetch: fakeFetch(200, { data: SAMPLE_ME, meta: {}, error: null }, seen),
    });
    expect(await client.session.me()).toEqual(SAMPLE_ME);
    expect(seen.url).toBe("https://kivo.monorise.studio/api/v1/me");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer tajny-token");
    expect(seen.init?.credentials).toBe("omit");
  });

  it("wylogowanie wysyła POST /api/auth/sign-out z ciasteczkiem i bez śledzenia przekierowań", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({
      baseUrl: "https://kivotasks.monorise.studio",
      fetch: fakeFetch(302, null, seen),
    });
    await client.session.signOut();
    expect(seen.url).toBe("https://kivotasks.monorise.studio/api/auth/sign-out");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.credentials).toBe("same-origin");
    expect(seen.init?.redirect).toBe("manual");
  });

  it("obsługuje zespoły, statusy, etykiety, zadania ze stronicowaniem kursorowym, 204 i wyszukiwanie", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const teamClient = createClient({
      fetch: fakeFetch(201, { data: { id: "u-1", key: "MAG", name: "Magazyn" }, meta: {}, error: null }, seen),
    });
    await teamClient.teams.create({ unitId: "019a0000-0000-7000-8000-000000000001", key: "MAG" });
    expect(seen.url).toBe("/api/v1/teams");
    expect(seen.init?.method).toBe("POST");

    const listClient = createClient({
      fetch: fakeFetch(
        200,
        {
          data: [{ id: "i-1", identifier: "MAG-1", title: "Test" }],
          meta: { requestId: "req_1", nextCursor: "abc123" },
          error: null,
        },
        seen,
      ),
    });
    const page = await listClient.issues.list({
      teamId: "019a0000-0000-7000-8000-000000000001",
      assignee: "me",
      priority: 1,
      includeCompleted: true,
      sort: "priority",
      limit: 20,
      cursor: "prev",
    });
    expect(page).toEqual({
      items: [{ id: "i-1", identifier: "MAG-1", title: "Test" }],
      nextCursor: "abc123",
    });
    expect(seen.url).toBe(
      "/api/v1/issues?teamId=019a0000-0000-7000-8000-000000000001&assignee=me&priority=1&includeCompleted=true&sort=priority&limit=20&cursor=prev",
    );

    const deleteClient = createClient({ fetch: fakeFetch(204, null, seen) });
    await expect(deleteClient.issues.delete("i-1")).resolves.toBeUndefined();
    expect(seen.url).toBe("/api/v1/issues/i-1");
    expect(seen.init?.method).toBe("DELETE");

    const searchClient = createClient({
      fetch: fakeFetch(200, { data: { issues: [] }, meta: { requestId: "req_2" }, error: null }, seen),
    });
    await expect(searchClient.search.issues("MAG-12")).resolves.toEqual({ issues: [] });
    expect(seen.url).toBe("/api/v1/search?q=MAG-12");
  });

  it("obsługuje komentarze, reakcje z kodowaniem emoji, aktywność, obserwowanie i skrzynkę powiadomień", async () => {
    const seen: { url?: string; init?: RequestInit } = {};

    const createCommentClient = createClient({
      fetch: fakeFetch(201, { data: { id: "c-1", body: "Hej" }, meta: {}, error: null }, seen),
    });
    await createCommentClient.issues.createComment("i-1", { body: "Hej" });
    expect(seen.url).toBe("/api/v1/issues/i-1/comments");
    expect(seen.init?.method).toBe("POST");

    const reactClient = createClient({
      fetch: fakeFetch(
        200,
        {
          data: { commentId: "c-1", reactions: [{ emoji: "👍", count: 1, reactedByMe: true }] },
          meta: {},
          error: null,
        },
        seen,
      ),
    });
    await reactClient.issues.addReaction("i-1", "c-1", "👍");
    expect(seen.url).toBe(`/api/v1/issues/i-1/comments/c-1/reactions/${encodeURIComponent("👍")}`);
    expect(seen.init?.method).toBe("PUT");

    const removeReactClient = createClient({ fetch: fakeFetch(204, null, seen) });
    await expect(removeReactClient.issues.removeReaction("i-1", "c-1", "🚀")).resolves.toBeUndefined();
    expect(seen.url).toBe(`/api/v1/issues/i-1/comments/c-1/reactions/${encodeURIComponent("🚀")}`);
    expect(seen.init?.method).toBe("DELETE");

    const activityClient = createClient({
      fetch: fakeFetch(200, { data: [], meta: { nextCursor: "cur-2" }, error: null }, seen),
    });
    expect(await activityClient.issues.listActivity("i-1", { limit: 25, cursor: "cur-1" })).toEqual({
      items: [],
      nextCursor: "cur-2",
    });
    expect(seen.url).toBe("/api/v1/issues/i-1/activity?limit=25&cursor=cur-1");

    const subClient = createClient({
      fetch: fakeFetch(200, { data: { issueId: "i-1", isSubscribed: true }, meta: {}, error: null }, seen),
    });
    expect(await subClient.issues.subscribe("i-1")).toEqual({ issueId: "i-1", isSubscribed: true });
    expect(seen.url).toBe("/api/v1/issues/i-1/subscription");
    expect(seen.init?.method).toBe("PUT");

    const unsubClient = createClient({ fetch: fakeFetch(204, null, seen) });
    await expect(unsubClient.issues.unsubscribe("i-1")).resolves.toBeUndefined();
    expect(seen.url).toBe("/api/v1/issues/i-1/subscription");
    expect(seen.init?.method).toBe("DELETE");

    const inboxClient = createClient({
      fetch: fakeFetch(200, { data: [], meta: { nextCursor: null }, error: null }, seen),
    });
    await inboxClient.inbox.list({ filter: "unread", limit: 30, cursor: "c0" });
    expect(seen.url).toBe("/api/v1/inbox?filter=unread&limit=30&cursor=c0");

    const unreadClient = createClient({
      fetch: fakeFetch(200, { data: { unreadCount: 4 }, meta: {}, error: null }, seen),
    });
    expect(await unreadClient.inbox.unreadCount()).toEqual({ unreadCount: 4 });
    expect(seen.url).toBe("/api/v1/inbox/unread-count");

    const patchInboxClient = createClient({
      fetch: fakeFetch(200, { data: { id: "n-1", readAt: "2026-11-27T04:00:00.000Z" }, meta: {}, error: null }, seen),
    });
    await patchInboxClient.inbox.update("n-1", { read: true });
    expect(seen.url).toBe("/api/v1/inbox/n-1");
    expect(seen.init?.method).toBe("PATCH");

    const readAllClient = createClient({
      fetch: fakeFetch(200, { data: { updatedCount: 4 }, meta: {}, error: null }, seen),
    });
    expect(await readAllClient.inbox.markAllRead()).toEqual({ updatedCount: 4 });
    expect(seen.url).toBe("/api/v1/inbox/read-all");
    expect(seen.init?.method).toBe("POST");
  });

  it("obsługuje załączniki (lista, multipart bez ręcznego Content-Type, pobranie, usunięcie, URL treści) oraz zużycie miejsca", async () => {
    const seen: { url?: string; init?: RequestInit } = {};

    const listClient = createClient({
      fetch: fakeFetch(200, { data: [], meta: { nextCursor: "att-2" }, error: null }, seen),
    });
    expect(await listClient.attachments.list("i-1", { limit: 10, cursor: "att-1" })).toEqual({
      items: [],
      nextCursor: "att-2",
    });
    expect(seen.url).toBe("/api/v1/issues/i-1/attachments?limit=10&cursor=att-1");
    expect(seen.init?.method).toBe("GET");

    const uploadClient = createClient({
      fetch: fakeFetch(201, { data: { id: "att-1", fileName: "zrzut.png" }, meta: {}, error: null }, seen),
    });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    await uploadClient.attachments.upload("i-1", blob, "zrzut.png");
    expect(seen.url).toBe("/api/v1/issues/i-1/attachments");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBeInstanceOf(FormData);
    expect((seen.init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const sentPart = (seen.init?.body as FormData).get("file");
    expect(sentPart).toBeInstanceOf(File);
    expect((sentPart as File).name).toBe("zrzut.png");

    const getClient = createClient({
      fetch: fakeFetch(200, { data: { id: "att-1" }, meta: {}, error: null }, seen),
    });
    await getClient.attachments.get("att-1");
    expect(seen.url).toBe("/api/v1/attachments/att-1");
    expect(seen.init?.method).toBe("GET");

    const deleteClient = createClient({ fetch: fakeFetch(204, null, seen) });
    await expect(deleteClient.attachments.delete("att-1")).resolves.toBeUndefined();
    expect(seen.url).toBe("/api/v1/attachments/att-1");
    expect(seen.init?.method).toBe("DELETE");

    const storageClient = createClient({
      baseUrl: "https://kivo.monorise.studio",
      fetch: fakeFetch(
        200,
        {
          data: { usedBytes: 100, quotaBytes: 1000, maxFileBytes: 200, usedRatio: 0.1, state: "OK" },
          meta: {},
          error: null,
        },
        seen,
      ),
    });
    expect(await storageClient.storage.get()).toEqual({
      usedBytes: 100,
      quotaBytes: 1000,
      maxFileBytes: 200,
      usedRatio: 0.1,
      state: "OK",
    });
    expect(seen.url).toBe("https://kivo.monorise.studio/api/v1/storage");
    expect(storageClient.attachments.contentUrl("att-1")).toBe(
      "https://kivo.monorise.studio/api/v1/attachments/att-1/content",
    );
    expect(attachmentContentUrl("att-1")).toBe("/api/v1/attachments/att-1/content");
  });

  it("zamienia błąd API oraz błąd sieci na ApiError z kodem", async () => {
    const productDeniedClient = createClient({
      fetch: fakeFetch(403, {
        data: null,
        meta: { requestId: "req_123" },
        error: {
          code: "PRODUCT_ACCESS_REQUIRED",
          message: "KivoTasks nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.",
          details: [],
        },
      }),
    });
    const denied = await productDeniedClient.session.me().catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ApiError);
    expect(denied).toMatchObject({ code: "PRODUCT_ACCESS_REQUIRED", status: 403 });

    const offlineClient = createClient({
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const networkError = await offlineClient.session.me().catch((e: unknown) => e);
    expect(networkError).toBeInstanceOf(ApiError);
    expect(networkError).toMatchObject({ code: "INTERNAL_ERROR", status: 0 });
  });
});
