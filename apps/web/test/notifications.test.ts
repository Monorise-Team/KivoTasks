/**
 * Testy jednostkowe i integracyjne (z atrapą Core, bez PostgreSQL) powiadomień e-mail
 * o przypisaniu zadania (`apps/web/src/server/notifications.ts`).
 */
import type { Session } from "@monorise-team/auth/next";
import { createFakeCore, type FakeCore, type FakeOrganizationBuilder } from "@monorise-team/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  buildAssignmentNotificationMessage,
  buildIssueActionUrl,
  KIVOTASKS_ASSIGNMENT_NOTIFICATION_CATEGORY,
  notifyIssueAssigned,
  resolveAssignmentActorName,
  shouldNotifyIssueAssignment,
} from "@/server/notifications";
import {
  createFakeCoreWithUnitsFetch,
  type CapturedNotificationRequest,
  type NotificationFault,
} from "./helpers/fake-core-units";

const FAKE_CORE_URL = "http://core.notifications.test";
const CLIENT_ID = "kivotasks-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";
const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 } as const;

const ISSUE_ID = "019a0000-0000-7000-8000-000000000101";
const ANNA_ID = "019a0000-0000-7000-8000-000000000201";
const JAN_ID = "019a0000-0000-7000-8000-000000000202";

describe("pomocniki powiadomień o przypisaniu zadania (notifications)", () => {
  it("buduje neutralną płciowo treść po polsku z osobą przypisującą i bez niej", () => {
    expect(
      buildAssignmentNotificationMessage({
        identifier: "MAG-3",
        issueTitle: "Przegląd wózków widłowych",
        teamName: "Magazyn Kraków",
        actorName: "Anna Nowak",
      }),
    ).toEqual({
      title: "Nowe zadanie dla Ciebie: MAG-3",
      body: "Zadanie „Przegląd wózków widłowych” w zespole Magazyn Kraków. Przypisanie: Anna Nowak.",
    });

    expect(
      buildAssignmentNotificationMessage({
        identifier: "MAG-3",
        issueTitle: "  Przegląd wózków widłowych  ",
        teamName: "  Magazyn Kraków ",
        actorName: null,
      }),
    ).toEqual({
      title: "Nowe zadanie dla Ciebie: MAG-3",
      body: "Zadanie „Przegląd wózków widłowych” w zespole Magazyn Kraków.",
    });

    expect(
      buildAssignmentNotificationMessage({
        identifier: "MAG-3",
        issueTitle: "Inwentaryzacja",
        teamName: "   ",
        actorName: "   ",
      }),
    ).toEqual({
      title: "Nowe zadanie dla Ciebie: MAG-3",
      body: "Zadanie „Inwentaryzacja”.",
    });
  });

  it("buduje actionUrl na originie aplikacji KivoTasks i odrzuca niepoprawne adresy", () => {
    expect(buildIssueActionUrl("http://kivotasks.localhost:3500", "MAG-3")).toBe(
      "http://kivotasks.localhost:3500/issue/MAG-3",
    );
    expect(buildIssueActionUrl("https://kivotasks.monorise.studio/teams/MAG/", "FIN-42")).toBe(
      "https://kivotasks.monorise.studio/issue/FIN-42",
    );
    expect(buildIssueActionUrl("not-a-url", "MAG-3")).toBeNull();
    expect(buildIssueActionUrl("javascript:alert(1)", "MAG-3")).toBeNull();
    expect(buildIssueActionUrl("http://kivotasks.localhost:3500", "   ")).toBeNull();
  });

  it("generuje deterministyczny, drukowalny klucz Idempotency-Key do 255 znaków ASCII", () => {
    const key1 = buildAssignmentNotificationIdempotencyKey({
      issueId: ISSUE_ID,
      assigneeAccountId: JAN_ID,
      updatedAt: "2026-11-27T01:30:00.123Z",
    });
    const key2 = buildAssignmentNotificationIdempotencyKey({
      issueId: ISSUE_ID,
      assigneeAccountId: JAN_ID,
      updatedAt: "2026-11-27T01:30:00.123Z",
    });
    const keyDifferentAssignee = buildAssignmentNotificationIdempotencyKey({
      issueId: ISSUE_ID,
      assigneeAccountId: ANNA_ID,
      updatedAt: "2026-11-27T01:30:00.123Z",
    });
    const keyDifferentTimestamp = buildAssignmentNotificationIdempotencyKey({
      issueId: ISSUE_ID,
      assigneeAccountId: JAN_ID,
      updatedAt: "2026-11-27T01:31:00.000Z",
    });

    expect(key1).toBe(key2);
    expect(key1).not.toBe(keyDifferentAssignee);
    expect(key1).not.toBe(keyDifferentTimestamp);
    expect(key1.length).toBeGreaterThanOrEqual(1);
    expect(key1.length).toBeLessThanOrEqual(255);
    expect(/^[\x21-\x7E]+$/.test(key1)).toBe(true);
  });

  it("wysyła powiadomienie wyłącznie przy zmianie osoby przypisanej na inną niż sprawca", () => {
    // Nowe przypisanie do innej osoby
    expect(
      shouldNotifyIssueAssignment({
        previousAssigneeAccountId: null,
        nextAssigneeAccountId: JAN_ID,
        actorAccountId: ANNA_ID,
      }),
    ).toBe(true);

    // Przepięcie z jednej osoby na inną
    expect(
      shouldNotifyIssueAssignment({
        previousAssigneeAccountId: ANNA_ID,
        nextAssigneeAccountId: JAN_ID,
        actorAccountId: ANNA_ID,
      }),
    ).toBe(true);

    // Przypisanie sobie przy utworzeniu lub aktualizacji -> brak
    expect(
      shouldNotifyIssueAssignment({
        previousAssigneeAccountId: null,
        nextAssigneeAccountId: ANNA_ID,
        actorAccountId: ANNA_ID,
      }),
    ).toBe(false);
    expect(
      shouldNotifyIssueAssignment({
        previousAssigneeAccountId: JAN_ID,
        nextAssigneeAccountId: ANNA_ID,
        actorAccountId: ANNA_ID,
      }),
    ).toBe(false);

    // Ta sama osoba lub usunięcie przypisania -> brak
    expect(
      shouldNotifyIssueAssignment({
        previousAssigneeAccountId: JAN_ID,
        nextAssigneeAccountId: JAN_ID,
        actorAccountId: ANNA_ID,
      }),
    ).toBe(false);
    expect(
      shouldNotifyIssueAssignment({
        previousAssigneeAccountId: JAN_ID,
        nextAssigneeAccountId: null,
        actorAccountId: ANNA_ID,
      }),
    ).toBe(false);
  });

  it("odczytuje nazwę osoby przypisującej najpierw z sesji BFF, a potem z katalogu członków zespołu", () => {
    const members = [{ accountId: ANNA_ID, employeeId: "emp-1", firstName: "Anna", lastName: "Nowak" }];
    const session = { profile: { name: "Anna z Sesji", email: "anna@acme.test" } } as unknown as Session;

    expect(resolveAssignmentActorName({ accountId: ANNA_ID, session }, members)).toBe("Anna z Sesji");
    expect(resolveAssignmentActorName({ accountId: ANNA_ID, session: null }, members)).toBe("Anna Nowak");
    expect(resolveAssignmentActorName({ accountId: JAN_ID, session: null }, members)).toBeNull();
  });
});

describe("wysyłka powiadomień o przypisaniu przez MonoriseCore (notifyIssueAssigned)", () => {
  let fakeCore: FakeCore;
  let acme: FakeOrganizationBuilder;
  let captured: CapturedNotificationRequest[];
  let faultQueue: NotificationFault[];

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
  });

  beforeEach(() => {
    fakeCore.reset();
    acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
    acme.grantEntitlement("kivotasks");
    captured = [];
    faultQueue = [];

    process.env.CORE_AUTH_URL = FAKE_CORE_URL;
    process.env.CORE_API_URL = FAKE_CORE_URL;
    process.env.KIVOTASKS_APP_URL = "http://kivotasks.localhost:3500";
    resetMachineCoreTokenCache();
    setCoreRetryForTests(FAST_RETRY);

    vi.spyOn(globalThis, "fetch").mockImplementation(
      createFakeCoreWithUnitsFetch(fakeCore, {
        onNotification: (req) => captured.push(req),
        getNotificationFault: () => faultQueue.shift() ?? null,
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCoreRetryForTests();
    resetMachineCoreTokenCache();
  });

  it("wysyła żądanie z tokenem maszynowym, Idempotency-Key i ponawia chwilowe 503 tym samym kluczem", async () => {
    const warnings: string[] = [];
    faultQueue.push({ status: 503 });

    const issue = {
      id: ISSUE_ID,
      identifier: "MAG-3",
      title: "Przegląd wózków widłowych",
      updatedAt: "2026-11-27T01:30:00.123Z",
    };

    await notifyIssueAssigned(
      {
        organizationId: acme.id,
        recipientAccountId: JAN_ID,
        issue,
        teamName: "Magazyn Kraków",
        actorName: "Anna Nowak",
      },
      { warn: (message) => warnings.push(message) },
    );

    expect(warnings).toEqual([]);
    expect(captured).toHaveLength(2);
    const expectedKey = buildAssignmentNotificationIdempotencyKey({
      issueId: ISSUE_ID,
      assigneeAccountId: JAN_ID,
      updatedAt: issue.updatedAt,
    });
    expect(captured[0]?.idempotencyKey).toBe(expectedKey);
    expect(captured[1]?.idempotencyKey).toBe(expectedKey);
    expect(captured[1]?.organizationId).toBe(acme.id);
    expect(captured[1]?.body).toEqual({
      recipientAccountId: JAN_ID,
      category: KIVOTASKS_ASSIGNMENT_NOTIFICATION_CATEGORY,
      title: "Nowe zadanie dla Ciebie: MAG-3",
      body: "Zadanie „Przegląd wózków widłowych” w zespole Magazyn Kraków. Przypisanie: Anna Nowak.",
      actionUrl: "http://kivotasks.localhost:3500/issue/MAG-3",
    });
  });

  it("przy błędzie 500 albo błędzie sieci nie rzuca wyjątku i loguje ostrzeżenie bez danych osobowych i tokenów", async () => {
    const warnings: string[] = [];
    faultQueue.push({ status: 500 });

    const issue = {
      id: ISSUE_ID,
      identifier: "MAG-7",
      title: "Poufny tytuł zadania",
      updatedAt: "2026-11-27T01:35:00.000Z",
    };

    await notifyIssueAssigned(
      {
        organizationId: acme.id,
        recipientAccountId: JAN_ID,
        issue,
        teamName: "Magazyn Kraków",
        actorName: "Anna Nowak",
      },
      { warn: (message) => warnings.push(message) },
    );

    // 500 nie jest ponawiane przez SDK
    expect(captured).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MAG-7");
    expect(warnings[0]).toContain("HTTP 500");
    expect(warnings[0]).not.toContain("Anna Nowak");
    expect(warnings[0]).not.toContain("Poufny tytuł zadania");
    expect(warnings[0]).not.toContain(JAN_ID);
    expect(warnings[0]).not.toContain(CLIENT_SECRET);
    expect(warnings[0]).not.toContain("Bearer");

    // Trwały błąd sieci (wyczerpuje 3 próby) też kończy się czysto bez wyjątku
    faultQueue.push({ networkError: true }, { networkError: true }, { networkError: true });
    await notifyIssueAssigned(
      {
        organizationId: acme.id,
        recipientAccountId: JAN_ID,
        issue,
        teamName: "Magazyn Kraków",
        actorName: "Anna Nowak",
      },
      { warn: (message) => warnings.push(message) },
    );

    expect(captured).toHaveLength(4);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("MAG-7");
    expect(warnings[1]).not.toContain("Anna Nowak");
    expect(warnings[1]).not.toContain(CLIENT_SECRET);
  });

  it("przerywa wolne wywołanie po krótkim limicie czasu (timeoutMs) i nie rzuca wyjątku", async () => {
    const warnings: string[] = [];

    const hangingCore = {
      sendNotification: ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };

    await notifyIssueAssigned(
      {
        organizationId: acme.id,
        recipientAccountId: JAN_ID,
        issue: {
          id: ISSUE_ID,
          identifier: "MAG-9",
          title: "Wolny Core",
          updatedAt: "2026-11-27T01:40:00.000Z",
        },
        teamName: "Magazyn",
        actorName: "Anna Nowak",
      },
      { core: hangingCore, timeoutMs: 25, warn: (message) => warnings.push(message) },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MAG-9");
    expect(warnings[0]).not.toContain("Anna Nowak");
  });
});
