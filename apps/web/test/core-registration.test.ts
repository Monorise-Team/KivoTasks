import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCore } from "@monorise-team/testing";
import { KIVOTASKS_PERMISSION_MANIFEST, KIVOTASKS_ROLE_TEMPLATES } from "@kivotasks/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CORE_PERMISSIONS_REGISTER_SCOPE,
  CoreRegistrationError,
  formatRegistrationStep,
  parseDotEnv,
  registerWithCore,
  resolveRegistrationConfig,
  type RegistrationStepEvent,
} from "@/server/core-registration";

const BASE_CONFIG = {
  coreAuthUrl: "http://core-auth.test/",
  coreApiUrl: "http://core-api.test/",
  clientId: "kivotasks-web",
  clientSecret: "tajny-sekret-klienta-tylko-do-testow",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("rejestracja uprawnień i gotowych ról w MonoriseCore", () => {
  it("pobiera token maszynowy, rejestruje manifest uprawnień, a potem gotowe role w tej kolejności", async () => {
    const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
    const permissionsSummary = {
      added: ["kivotasks.issues.read"],
      updated: [],
      deprecated: [],
      restored: [],
      unchanged: 3,
    };
    const roleTemplatesSummary = {
      added: ["kivotasks.member", "kivotasks.admin", "kivotasks.guest"],
      updated: [],
      archived: [],
      restored: [],
      unchanged: 0,
    };

    const fakeFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, method: init?.method ?? "GET", headers, body });

      if (calls.length === 1) {
        return jsonResponse({ access_token: "token-maszynowy-test", expires_in: 300, token_type: "Bearer" });
      }
      if (calls.length === 2) {
        return jsonResponse({ data: permissionsSummary, meta: { requestId: "req_perm" }, error: null });
      }
      return jsonResponse({ data: roleTemplatesSummary, meta: { requestId: "req_roles" }, error: null });
    });

    const events: RegistrationStepEvent[] = [];
    const result = await registerWithCore({
      ...BASE_CONFIG,
      fetch: fakeFetch,
      onStep: (event) => events.push(event),
    });

    expect(result).toEqual({
      permissions: permissionsSummary,
      roleTemplates: roleTemplatesSummary,
    });
    expect(calls).toHaveLength(3);

    // 1. Token maszynowy
    const tokenCall = calls[0]!;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.url).toBe("http://core-auth.test/api/auth/oauth2/token");
    expect(tokenCall.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const tokenParams = new URLSearchParams(tokenCall.body);
    expect(tokenParams.get("grant_type")).toBe("client_credentials");
    expect(tokenParams.get("client_id")).toBe("kivotasks-web");
    expect(tokenParams.get("client_secret")).toBe(BASE_CONFIG.clientSecret);
    expect(tokenParams.get("resource")).toBe("http://core-api.test");
    expect(tokenParams.get("scope")).toBe(CORE_PERMISSIONS_REGISTER_SCOPE);

    // 2. Manifest uprawnień (musi pójść przed gotowymi rolami)
    const permissionsCall = calls[1]!;
    expect(permissionsCall.method).toBe("PUT");
    expect(permissionsCall.url).toBe("http://core-api.test/core/v1/products/kivotasks/permissions");
    expect(permissionsCall.headers.get("authorization")).toBe("Bearer token-maszynowy-test");
    expect(permissionsCall.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(permissionsCall.body)).toEqual(KIVOTASKS_PERMISSION_MANIFEST);

    // 3. Gotowe role (szablony)
    const templatesCall = calls[2]!;
    expect(templatesCall.method).toBe("PUT");
    expect(templatesCall.url).toBe("http://core-api.test/core/v1/products/kivotasks/role-templates");
    expect(templatesCall.headers.get("authorization")).toBe("Bearer token-maszynowy-test");
    expect(templatesCall.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(templatesCall.body)).toEqual(KIVOTASKS_ROLE_TEMPLATES);

    // Podsumowania kroków są po polsku i nigdy nie ujawniają sekretu ani tokenu
    const lines = events.map(formatRegistrationStep);
    expect(lines).toEqual([
      "1/3 Token maszynowy pobrany dla klienta kivotasks-web.",
      "2/3 Uprawnienia (kivotasks): dodano 1 (kivotasks.issues.read), zaktualizowano 0, wycofano 0, przywrócono 0, bez zmian 3.",
      "3/3 Gotowe role (kivotasks): dodano 3 (kivotasks.member, kivotasks.admin, kivotasks.guest), zaktualizowano 0, zarchiwizowano 0, przywrócono 0, bez zmian 0.",
    ]);
    for (const line of lines) {
      expect(line).not.toContain(BASE_CONFIG.clientSecret);
      expect(line).not.toContain("token-maszynowy-test");
    }
  });

  it("zwraca czytelny błąd po odrzuceniu prośby o token i nie ujawnia sekretu", async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse(
        {
          error: "invalid_client",
          error_description: "Nieprawidłowe dane uwierzytelniające klienta",
        },
        401,
      ),
    );

    const error = await registerWithCore({ ...BASE_CONFIG, fetch: fakeFetch }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CoreRegistrationError);
    const regError = error as CoreRegistrationError;
    expect(regError.step).toBe("token");
    expect(regError.status).toBe(401);
    expect(regError.code).toBe("invalid_client");
    expect(regError.message).toContain("HTTP 401");
    expect(regError.message).toContain("invalid_client");
    expect(regError.message).toContain("Nieprawidłowe dane uwierzytelniające klienta");
    expect(regError.message).not.toContain(BASE_CONFIG.clientSecret);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("zwraca status, kod, komunikat i szczegóły przy błędzie 422 z Core API", async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-maszynowy-test", expires_in: 300 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { added: [], updated: [], deprecated: [], restored: [], unchanged: 4 },
          meta: { requestId: "req_perm" },
          error: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            data: null,
            meta: { requestId: "req_err" },
            error: {
              code: "VALIDATION_FAILED",
              message: "Nieznane lub wycofane uprawnienie w szablonie roli",
              details: [
                {
                  field: "1.permissions.0",
                  message: 'Uprawnienie "kivotasks.nieistniejace" nie jest zarejestrowane',
                },
              ],
            },
          },
          422,
        ),
      );

    const error = await registerWithCore({ ...BASE_CONFIG, fetch: fakeFetch }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CoreRegistrationError);
    const regError = error as CoreRegistrationError;
    expect(regError.step).toBe("roleTemplates");
    expect(regError.status).toBe(422);
    expect(regError.code).toBe("VALIDATION_FAILED");
    expect(regError.details).toEqual([
      {
        field: "1.permissions.0",
        message: 'Uprawnienie "kivotasks.nieistniejace" nie jest zarejestrowane',
      },
    ]);
    expect(regError.message).toContain("HTTP 422");
    expect(regError.message).toContain("VALIDATION_FAILED");
    expect(regError.message).toContain("Nieznane lub wycofane uprawnienie w szablonie roli");
    expect(regError.message).toContain("1.permissions.0");
    expect(regError.message).toContain('Uprawnienie "kivotasks.nieistniejace" nie jest zarejestrowane');
    expect(regError.message).not.toContain("token-maszynowy-test");
    expect(regError.message).not.toContain(BASE_CONFIG.clientSecret);
  });

  it("przerywa po błędzie rejestracji uprawnień i nie wysyła gotowych ról", async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-maszynowy-test", expires_in: 300 }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            data: null,
            meta: { requestId: "req_denied" },
            error: {
              code: "PERMISSION_DENIED",
              message: "Ten klient nie może rejestrować uprawnień wskazanego produktu",
              details: [],
            },
          },
          403,
        ),
      );

    const error = await registerWithCore({ ...BASE_CONFIG, fetch: fakeFetch }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CoreRegistrationError);
    expect((error as CoreRegistrationError).step).toBe("permissions");
    expect((error as CoreRegistrationError).status).toBe(403);
    expect((error as CoreRegistrationError).code).toBe("PERMISSION_DENIED");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("zgłasza brakujące zmienne środowiskowe bez wywoływania fetch", async () => {
    const fakeFetch = vi.fn<typeof fetch>();
    const config = resolveRegistrationConfig({});

    const error = await registerWithCore({ ...config, fetch: fakeFetch }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CoreRegistrationError);
    const regError = error as CoreRegistrationError;
    expect(regError.step).toBe("config");
    expect(regError.message).toContain("CORE_AUTH_URL");
    expect(regError.message).toContain("CORE_API_URL");
    expect(regError.message).toContain("KIVOTASKS_OAUTH_CLIENT_ID");
    expect(regError.message).toContain("KIVOTASKS_OAUTH_CLIENT_SECRET");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("czyta fallback z pliku .env.local, ale daje pierwszeństwo zmiennym środowiskowym", () => {
    const dir = mkdtempSync(join(tmpdir(), "kivotasks-reg-"));
    try {
      const envFilePath = join(dir, ".env.local");
      writeFileSync(
        envFilePath,
        [
          "# Komentarz",
          "CORE_AUTH_URL=http://localhost:3100",
          'CORE_API_URL="http://localhost:3200"',
          "KIVOTASKS_OAUTH_CLIENT_ID=kivotasks-web",
          "KIVOTASKS_OAUTH_CLIENT_SECRET=sekret=z=równością",
          "",
        ].join("\n"),
      );

      expect(parseDotEnv("export FOO='bar'\n# skip\nEMPTY=")).toEqual({ FOO: "bar", EMPTY: "" });

      const fromFile = resolveRegistrationConfig({}, { envFilePath });
      expect(fromFile).toEqual({
        coreAuthUrl: "http://localhost:3100",
        coreApiUrl: "http://localhost:3200",
        clientId: "kivotasks-web",
        clientSecret: "sekret=z=równością",
      });

      const overridden = resolveRegistrationConfig(
        {
          CORE_API_URL: "https://api.example.test",
          KIVOTASKS_OAUTH_CLIENT_SECRET: "sekret-ze-srodowiska",
        },
        { envFilePath },
      );
      expect(overridden).toEqual({
        coreAuthUrl: "http://localhost:3100",
        coreApiUrl: "https://api.example.test",
        clientId: "kivotasks-web",
        clientSecret: "sekret-ze-srodowiska",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejestruje manifest i gotowe role idempotentnie w atrapie MonoriseCore (createFakeCore)", async () => {
    const fakeCore = await createFakeCore({
      issuer: "http://core-auth.test",
      coreApiUrl: "http://core-api.test",
      products: [{ key: "kivotasks", clientId: BASE_CONFIG.clientId, clientSecret: BASE_CONFIG.clientSecret }],
    });

    const first = await registerWithCore({ ...BASE_CONFIG, fetch: fakeCore.fetch });
    expect(first.permissions.added).toHaveLength(KIVOTASKS_PERMISSION_MANIFEST.length);
    expect(first.permissions.unchanged).toBe(0);
    expect(first.roleTemplates.added).toEqual(["kivotasks.admin", "kivotasks.guest", "kivotasks.member"]);
    expect(fakeCore.registrations.permissions).toHaveLength(1);
    expect(fakeCore.registrations.roleTemplates).toHaveLength(1);

    const second = await registerWithCore({ ...BASE_CONFIG, fetch: fakeCore.fetch });
    expect(second.permissions.added).toEqual([]);
    expect(second.permissions.unchanged).toBe(KIVOTASKS_PERMISSION_MANIFEST.length);
    expect(second.roleTemplates.added).toEqual([]);
    expect(second.roleTemplates.unchanged).toBe(KIVOTASKS_ROLE_TEMPLATES.length);
  });
});
