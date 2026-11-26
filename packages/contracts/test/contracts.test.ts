import { permissionKeySchema, permissionManifestSchema } from "@monorise-team/permissions";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorResponse,
  apiSuccessSchema,
  ERROR_CODES,
  Health,
  KIVOTASKS_PERMISSION_MANIFEST,
  KIVOTASKS_PERMISSIONS,
  KIVOTASKS_ROLE_TEMPLATES,
  Me,
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
  it("waliduje capabilities w Me", () => {
    const meParsed = Me.parse({
      account: { id: "acc-1", email: "anna@acme.test" },
      employee: { id: "emp-1", firstName: "Anna", lastName: "Nowak", fullName: "Anna Nowak", jobTitle: null },
      organization: { id: "org-1", name: "Acme" },
      capabilities: {
        hasProductAccess: true,
        readIssues: true,
        writeIssues: true,
        manageTeams: false,
        manageProjects: false,
      },
    });
    expect(meParsed.capabilities).toEqual({
      hasProductAccess: true,
      readIssues: true,
      writeIssues: true,
      manageTeams: false,
      manageProjects: false,
    });
  });

  it("zawiera PRODUCT_ACCESS_REQUIRED oraz waliduje koperty sukcesu i błędu", () => {
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
  });
});
