import { describe, expect, it } from "vitest";
import { ApiError, createClient, type Me } from "../src/index.js";

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
