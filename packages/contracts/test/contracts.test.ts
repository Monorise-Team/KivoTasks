import { permissionKeySchema, permissionManifestSchema } from "@monorise-team/permissions";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorResponse,
  ApiListMeta,
  apiListSuccessSchema,
  apiSuccessSchema,
  ATTACHMENT_CONTENT_TYPES,
  COMMENT_REACTION_EMOJIS,
  CommentReactionEmoji,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreateIssueRelationInput,
  CreateLabelInput,
  CreateTeamInput,
  CreateWorkflowStateInput,
  DEFAULT_WORKFLOW_STATES,
  ERROR_CODES,
  Health,
  INBOX_ITEM_KINDS,
  InboxListQuery,
  ISSUE_EVENT_TYPES,
  IssueAttachment,
  IssueAttachmentEventPayload,
  IssueAttachmentsQuery,
  IssueList,
  IssueListQuery,
  KIVOTASKS_PERMISSION_MANIFEST,
  KIVOTASKS_PERMISSIONS,
  KIVOTASKS_ROLE_TEMPLATES,
  Me,
  STORAGE_USAGE_STATES,
  StorageUsage,
  TeamKey,
  UpdateInboxItemInput,
  UpdateIssueCommentInput,
} from "../src/index.js";

/** Minimalny schemat żądania `PUT /core/v1/products/{productKey}/role-templates` zgodny z MonoriseCore. */
const CoreRoleTemplateKey = z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/);
const CoreRoleTemplateEntry = z.object({
  key: CoreRoleTemplateKey,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).nullable().optional(),
  permissions: z
    .array(permissionKeySchema)
    .min(1)
    .max(200)
    .refine((keys) => new Set(keys).size === keys.length, "Zduplikowane klucze uprawnień w roli"),
});
const CoreRegisterRoleTemplatesRequest = z
  .array(CoreRoleTemplateEntry)
  .max(100)
  .refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length, "Zduplikowane klucze ról");

const SAMPLE_UUID = "019a0000-0000-7000-8000-000000000001";

describe("manifest uprawnień KivoTasks", () => {
  it("spełnia schemat manifestu z @monorise-team/permissions", () => {
    const parsed = permissionManifestSchema.parse(KIVOTASKS_PERMISSION_MANIFEST);
    expect(parsed).toHaveLength(4);
    expect(KIVOTASKS_PERMISSIONS.product).toBe("kivotasks");
  });

  it("zawiera wszystkie uprawnienia KivoTasks i opisy po polsku", () => {
    expect(Object.values(KIVOTASKS_PERMISSIONS.keys)).toEqual([
      "kivotasks.issues.read",
      "kivotasks.issues.write",
      "kivotasks.teams.manage",
      "kivotasks.projects.manage",
    ]);
    for (const entry of KIVOTASKS_PERMISSION_MANIFEST) {
      expect(entry.key.startsWith("kivotasks.")).toBe(true);
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });
});

describe("gotowe role (szablony) KivoTasks", () => {
  it("spełniają schemat żądania MonoriseCore i mają prefiks kivotasks.", () => {
    const parsed = CoreRegisterRoleTemplatesRequest.parse(KIVOTASKS_ROLE_TEMPLATES);
    expect(parsed).toHaveLength(3);
    for (const template of parsed) {
      expect(template.key.startsWith("kivotasks.")).toBe(true);
    }
  });

  it("odwołują się wyłącznie do uprawnień z manifestu KivoTasks", () => {
    const manifestKeys = new Set<string>(KIVOTASKS_PERMISSION_MANIFEST.map((entry) => entry.key));
    for (const template of KIVOTASKS_ROLE_TEMPLATES) {
      for (const permission of template.permissions) {
        expect(manifestKeys.has(permission)).toBe(true);
      }
    }
  });

  it("definiują role Członek KivoTasks, Administrator KivoTasks i Gość z oczekiwanymi uprawnieniami", () => {
    const byKey = new Map<string, (typeof KIVOTASKS_ROLE_TEMPLATES)[number]>(
      KIVOTASKS_ROLE_TEMPLATES.map((template) => [template.key, template]),
    );

    expect(byKey.get("kivotasks.member")).toEqual({
      key: "kivotasks.member",
      name: "Członek KivoTasks",
      description: "Przegląda, tworzy i edytuje zadania we własnych zespołach",
      permissions: ["kivotasks.issues.read", "kivotasks.issues.write"],
    });

    expect(byKey.get("kivotasks.admin")).toEqual({
      key: "kivotasks.admin",
      name: "Administrator KivoTasks",
      description: "Zarządza zespołami, obiegami statusów, etykietami, projektami oraz zadaniami",
      permissions: [
        "kivotasks.issues.read",
        "kivotasks.issues.write",
        "kivotasks.teams.manage",
        "kivotasks.projects.manage",
      ],
    });

    expect(byKey.get("kivotasks.guest")).toEqual({
      key: "kivotasks.guest",
      name: "Gość",
      description: "Przegląda zadania w udostępnionych projektach",
      permissions: ["kivotasks.issues.read"],
    });
  });
});

describe("schematy kopert API i profilu Me", () => {
  it("waliduje capabilities w Me wraz z createTeams", () => {
    const meParsed = Me.parse({
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
    });
    expect(meParsed.capabilities).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: true,
      manageTeams: false,
      createTeams: false,
      manageProjects: false,
    });
  });

  it("zawiera PRODUCT_ACCESS_REQUIRED oraz waliduje koperty sukcesu, listy i błędu", () => {
    expect(ERROR_CODES).toContain("PRODUCT_ACCESS_REQUIRED");
    expect(
      ApiErrorResponse.parse({
        data: null,
        meta: { requestId: "req_123" },
        error: { code: "PRODUCT_ACCESS_REQUIRED", message: "Brak dostępu", details: [] },
      }).error.code,
    ).toBe("PRODUCT_ACCESS_REQUIRED");

    const healthEnvelope = apiSuccessSchema(Health).parse({
      data: { status: "ok", version: "0.0.0" },
      meta: { requestId: "req_123" },
      error: null,
    });
    expect(healthEnvelope.data.status).toBe("ok");

    const listEnvelope = apiListSuccessSchema(IssueList).parse({
      data: [],
      meta: ApiListMeta.parse({ requestId: "req_456", nextCursor: null }),
      error: null,
    });
    expect(listEnvelope.meta.nextCursor).toBeNull();
  });
});

describe("schematy etapu 1a: zespoły, statusy, etykiety i zadania", () => {
  it("waliduje klucz zespołu (2-5 wielkich liter A-Z)", () => {
    expect(TeamKey.parse("MAG")).toBe("MAG");
    expect(TeamKey.parse("AB")).toBe("AB");
    expect(TeamKey.parse("ABCDE")).toBe("ABCDE");
    expect(() => TeamKey.parse("A")).toThrow();
    expect(() => TeamKey.parse("ABCDEF")).toThrow();
    expect(() => TeamKey.parse("mag")).toThrow();
    expect(() => TeamKey.parse("MA1")).toThrow();
  });

  it("definiuje 6 domyślnych statusów obiegu w oczekiwanej kolejności", () => {
    expect(DEFAULT_WORKFLOW_STATES.map((s) => [s.name, s.category, s.color])).toEqual([
      ["Backlog", "BACKLOG", "gray"],
      ["Do zrobienia", "UNSTARTED", "blue"],
      ["W toku", "STARTED", "yellow"],
      ["Do przeglądu", "STARTED", "purple"],
      ["Zrobione", "COMPLETED", "green"],
      ["Anulowane", "CANCELED", "red"],
    ]);
  });

  it("waliduje dane wejściowe tworzenia zespołu, statusu, etykiety, zadania i relacji", () => {
    expect(CreateTeamInput.parse({ unitId: SAMPLE_UUID, key: "MAG" })).toEqual({
      unitId: SAMPLE_UUID,
      key: "MAG",
    });
    expect(CreateWorkflowStateInput.parse({ name: "Testy", category: "STARTED", color: "cyan" })).toMatchObject({
      name: "Testy",
      category: "STARTED",
      color: "cyan",
    });
    expect(CreateLabelInput.parse({ name: "Błąd", color: "red" })).toEqual({ name: "Błąd", color: "red" });

    expect(
      CreateIssueInput.parse({
        teamId: SAMPLE_UUID,
        title: "Przegląd strefy przyjęć",
        priority: 1,
        dueDate: "2026-12-04",
        estimate: 5,
      }),
    ).toMatchObject({
      teamId: SAMPLE_UUID,
      title: "Przegląd strefy przyjęć",
      priority: 1,
      dueDate: "2026-12-04",
      estimate: 5,
    });

    // Odrzuca nieistniejącą datę kalendarzową i błędne zakresy priorytetu/szacunku
    expect(() => CreateIssueInput.parse({ teamId: SAMPLE_UUID, title: "X", dueDate: "2026-02-31" })).toThrow();
    expect(() => CreateIssueInput.parse({ teamId: SAMPLE_UUID, title: "X", priority: 5 })).toThrow();
    expect(() => CreateIssueInput.parse({ teamId: SAMPLE_UUID, title: "X", estimate: 101 })).toThrow();

    expect(CreateIssueRelationInput.parse({ relatedIssueId: SAMPLE_UUID, type: "BLOCKED_BY" })).toEqual({
      relatedIssueId: SAMPLE_UUID,
      type: "BLOCKED_BY",
    });
  });

  it("waliduje parametry filtrowania, sortowania i stronicowania listy zadań", () => {
    const defaults = IssueListQuery.parse({});
    expect(defaults.sort).toBe("updated");
    expect(defaults.limit).toBe(50);

    const parsed = IssueListQuery.parse({
      teamId: SAMPLE_UUID,
      assignee: "me",
      priority: "1",
      includeCompleted: "true",
      sort: "priority",
      limit: "25",
    });
    expect(parsed).toMatchObject({
      teamId: SAMPLE_UUID,
      assignee: "me",
      priority: 1,
      includeCompleted: true,
      sort: "priority",
      limit: 25,
    });

    expect(() => IssueListQuery.parse({ assignee: "invalid-assignee" })).toThrow();
    expect(() => IssueListQuery.parse({ limit: 101 })).toThrow();
  });
});

describe("schematy etapu 2a: komentarze, reakcje, historia i skrzynka", () => {
  it("definiuje stały zestaw 6 emoji reakcji, 13 typów zdarzeń historii i 3 rodzaje wpisów skrzynki", () => {
    expect(COMMENT_REACTION_EMOJIS).toEqual(["👍", "❤️", "🎉", "😄", "👀", "🚀"]);
    expect(CommentReactionEmoji.parse("🚀")).toBe("🚀");
    expect(() => CommentReactionEmoji.parse("🔥")).toThrow();

    expect(ISSUE_EVENT_TYPES).toHaveLength(15);
    expect(ISSUE_EVENT_TYPES).toContain("CREATED");
    expect(ISSUE_EVENT_TYPES).toContain("DESCRIPTION_CHANGED");
    expect(ISSUE_EVENT_TYPES).toContain("RELATION_REMOVED");
    expect(ISSUE_EVENT_TYPES).toContain("DELETED");
    expect(ISSUE_EVENT_TYPES).toContain("ATTACHMENT_ADDED");
    expect(ISSUE_EVENT_TYPES).toContain("ATTACHMENT_REMOVED");

    expect(INBOX_ITEM_KINDS).toEqual(["ASSIGNED", "MENTIONED", "COMMENTED"]);
  });

  it("waliduje kody błędów i schematy etapu 2b (załączniki i zużycie miejsca firmy)", () => {
    expect(ERROR_CODES).toContain("PAYLOAD_TOO_LARGE");
    expect(ERROR_CODES).toContain("STORAGE_QUOTA_EXCEEDED");
    expect(ATTACHMENT_CONTENT_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/octet-stream",
    ]);
    expect(STORAGE_USAGE_STATES).toEqual(["OK", "WARNING", "FULL"]);

    const attachment = IssueAttachment.parse({
      id: SAMPLE_UUID,
      issueId: SAMPLE_UUID,
      fileName: "zrzut.png",
      contentType: "image/png",
      sizeBytes: 2048,
      uploader: { accountId: SAMPLE_UUID, name: "Anna Nowak" },
      createdAt: "2026-11-27T12:00:00.000Z",
      contentUrl: `/api/v1/attachments/${SAMPLE_UUID}/content`,
      inline: true,
      canDelete: true,
    });
    expect(attachment.inline).toBe(true);
    expect(() => IssueAttachment.parse({ ...attachment, sizeBytes: 0 })).toThrow();
    expect(() => IssueAttachment.parse({ ...attachment, contentType: "image/svg+xml" })).toThrow();

    expect(
      IssueAttachmentEventPayload.parse({
        attachmentId: SAMPLE_UUID,
        fileName: "raport.pdf",
        sizeBytes: 1234,
        contentType: "application/octet-stream",
      }),
    ).toMatchObject({ fileName: "raport.pdf", contentType: "application/octet-stream" });

    expect(IssueAttachmentsQuery.parse({})).toEqual({ limit: 50 });
    expect(IssueAttachmentsQuery.parse({ limit: "20", cursor: "abc" })).toEqual({ limit: 20, cursor: "abc" });

    const usage = StorageUsage.parse({
      usedBytes: 800,
      quotaBytes: 1000,
      maxFileBytes: 256,
      usedRatio: 0.8,
      state: "WARNING",
    });
    expect(usage.state).toBe("WARNING");
    expect(() => StorageUsage.parse({ ...usage, quotaBytes: 0 })).toThrow();
  });

  it("waliduje treść komentarza (1-10 000 znaków, bez znaku NUL i nie same spacje) oraz parametry skrzynki", () => {
    expect(CreateIssueCommentInput.parse({ body: "Gotowe do przeglądu" })).toEqual({ body: "Gotowe do przeglądu" });
    expect(() => CreateIssueCommentInput.parse({ body: "" })).toThrow();
    expect(() => CreateIssueCommentInput.parse({ body: "   \n\t " })).toThrow();
    expect(() => CreateIssueCommentInput.parse({ body: "a".repeat(10_001) })).toThrow();
    expect(() => CreateIssueCommentInput.parse({ body: "Tekst ze znakiem \u0000 NUL" })).toThrow();
    expect(() => UpdateIssueCommentInput.parse({ body: "   " })).toThrow();
    expect(() => UpdateIssueCommentInput.parse({ body: "Edycja \u0000 NUL" })).toThrow();

    expect(InboxListQuery.parse({})).toEqual({ filter: "all", limit: 50 });
    expect(InboxListQuery.parse({ filter: "unread", limit: "20" })).toEqual({ filter: "unread", limit: 20 });
    expect(() => InboxListQuery.parse({ filter: "archived" })).toThrow();

    expect(UpdateInboxItemInput.parse({ read: true })).toEqual({ read: true });
    expect(UpdateInboxItemInput.parse({ archived: true })).toEqual({ archived: true });
    expect(() => UpdateInboxItemInput.parse({})).toThrow();
  });
});
