import "server-only";
import { AuthError, AuthUnavailableError } from "@monorise-team/auth";
import { PermissionError } from "@monorise-team/permissions";
import {
  CoreApiError,
  CoreApiMissingTokenError,
  CoreApiProtocolError,
  CoreApiUnavailableError,
} from "@monorise-team/sdk";
import type { ApiErrorBody, ErrorCode } from "@kivotasks/contracts";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { config } from "./config";
import { CoreMachineTokenError } from "./core-machine";

/** Błąd API ze stałym kodem (standard API Monorise, ADR-0044). */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: ApiErrorBody["details"] = [],
  ) {
    super(message);
  }
}

const PAGINATED_MARKER = Symbol("kivotasks.paginated");

export interface PaginatedPayload<T> {
  readonly [PAGINATED_MARKER]: true;
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** Oznacza odpowiedź listy ze stronicowaniem kursorowym (`meta.nextCursor`), jak w Core API. */
export function paginated<T>(items: T[], nextCursor: string | null): PaginatedPayload<T> {
  return { [PAGINATED_MARKER]: true, items, nextCursor };
}

function isPaginatedPayload(value: unknown): value is PaginatedPayload<unknown> {
  return typeof value === "object" && value !== null && PAGINATED_MARKER in value;
}

const UuidParamSchema = z.uuid();

export function parseUuidParam(value: string, field: string, message = "Niepoprawny identyfikator UUID"): string {
  const parsed = UuidParamSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [{ field, message }]);
  }
  return parsed.data;
}

const requestId = () => `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin && config.allowedOrigins.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
}

function applyCorsHeaders(headers: Headers, request: NextRequest): void {
  const cors = corsHeaders(request);
  if (cors["Access-Control-Allow-Origin"]) {
    headers.set("Access-Control-Allow-Origin", cors["Access-Control-Allow-Origin"]);
  }
  if (cors.Vary) {
    const existingVary = headers.get("Vary");
    if (!existingVary) {
      headers.set("Vary", cors.Vary);
    } else if (
      !existingVary
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .includes("origin")
    ) {
      headers.set("Vary", `${existingVary}, Origin`);
    }
  }
}

function respond(request: NextRequest, status: number, body: unknown, headers: Record<string, string> = {}) {
  const responseHeaders = { "Cache-Control": "no-store", ...corsHeaders(request), ...headers };
  if (status === 204) {
    return new NextResponse(null, { status: 204, headers: responseHeaders });
  }
  return NextResponse.json(body, { status, headers: responseHeaders });
}

function toFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  if (error instanceof ZodError) {
    return new ApiFailure(
      422,
      "VALIDATION_FAILED",
      "Niepoprawne dane",
      error.issues.map((issue) => ({ field: issue.path.join(".") || undefined, message: issue.message })),
    );
  }
  if (error instanceof AuthError) {
    return new ApiFailure(
      error.statusCode,
      error.code,
      error.code === "UNAUTHENTICATED" ? "Zaloguj się kontem Monorise" : "Żądanie spoza KivoTasks",
    );
  }
  if (error instanceof AuthUnavailableError) {
    return new ApiFailure(503, "INTERNAL_ERROR", "Logowanie Monorise jest chwilowo niedostępne");
  }
  if (error instanceof PermissionError) {
    return new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do tej operacji");
  }
  if (error instanceof CoreMachineTokenError) {
    return new ApiFailure(503, "INTERNAL_ERROR", "MonoriseCore jest chwilowo niedostępny");
  }
  if (error instanceof CoreApiMissingTokenError) {
    return new ApiFailure(401, "UNAUTHENTICATED", "Zaloguj się kontem Monorise");
  }
  if (error instanceof CoreApiError) {
    if (error.status === 401) {
      return new ApiFailure(401, "UNAUTHENTICATED", "Sesja w MonoriseCore wygasła lub konto jest nieaktywne");
    }
    if (error.status === 403) {
      return new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnień w MonoriseCore");
    }
    return new ApiFailure(503, "INTERNAL_ERROR", "MonoriseCore jest chwilowo niedostępny");
  }
  if (error instanceof CoreApiUnavailableError || error instanceof CoreApiProtocolError) {
    return new ApiFailure(503, "INTERNAL_ERROR", "MonoriseCore jest chwilowo niedostępny");
  }
  return new ApiFailure(500, "INTERNAL_ERROR", "Wewnętrzny błąd serwera");
}

export interface CookieJar {
  set: (
    name: string,
    value: string,
    options: { expires: Date; httpOnly: boolean; secure: boolean; sameSite: "lax" | "strict"; path: string },
  ) => void;
  delete: (name: string) => void;
}

export interface Context<P> {
  request: NextRequest;
  params: P;
  requestId: string;
  /** Ciasteczka odpowiedzi, dopisywane po wykonaniu trasy. */
  cookies: CookieJar;
}

/**
 * Obsługa trasy API: identyfikator żądania, odpowiedź `{ data, meta, error }` (albo `204`), zamiana błędów
 * na kody, ochrona przed CSRF dla ciasteczka sesji i nagłówki CORS.
 */
export function route<P = Record<string, never>>(
  fn: (context: Context<P>) => Promise<unknown>,
  { status = 200 }: { status?: number } = {},
) {
  return async (request: NextRequest, context: { params: Promise<P> }) => {
    const id = requestId();
    const pending: ((response: NextResponse) => void)[] = [];
    const cookies: CookieJar = {
      set: (name, value, options) => pending.push((response) => response.cookies.set(name, value, options)),
      delete: (name) => pending.push((response) => response.cookies.delete(name)),
    };
    try {
      assertSameOrigin(request);
      const result = await fn({ request, params: await context.params, requestId: id, cookies });
      if (result instanceof Response) {
        let passthrough: NextResponse;
        if (result instanceof NextResponse) {
          passthrough = result;
        } else {
          passthrough = new NextResponse(result.body, {
            status: result.status,
            statusText: result.statusText,
            headers: new Headers(result.headers),
          });
        }
        passthrough.headers.set("X-Request-Id", id);
        applyCorsHeaders(passthrough.headers, request);
        for (const apply of pending) apply(passthrough);
        return passthrough;
      }
      const response =
        status === 204
          ? respond(request, 204, null)
          : isPaginatedPayload(result)
            ? respond(request, status, {
                data: result.items,
                meta: { requestId: id, nextCursor: result.nextCursor },
                error: null,
              })
            : respond(request, status, { data: result ?? null, meta: { requestId: id }, error: null });
      for (const apply of pending) apply(response);
      return response;
    } catch (error) {
      const failure = toFailure(error);
      if (failure.status >= 500) {
        console.error(
          `[${id}] ${request.method} ${request.nextUrl.pathname}: ${failure.code}`,
          process.env.NODE_ENV === "production" ? (error instanceof Error ? error.name : "") : error,
        );
      }
      return respond(request, failure.status, {
        data: null,
        meta: { requestId: id },
        error: { code: failure.code, message: failure.message, details: failure.details },
      });
    }
  };
}

/**
 * Zmiany wysłane z ciasteczkiem sesji muszą pochodzić z tej samej strony (CSRF). Wywołania
 * z tokenem w nagłówku Authorization nie korzystają z ciasteczek sesji, więc ich to nie dotyczy.
 */
function assertSameOrigin(request: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.get("authorization")) return;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Żądanie spoza strony KivoTasks");
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Żądanie spoza strony KivoTasks");
  }
  if (!originHost || originHost !== host) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Żądanie spoza strony KivoTasks");
  }
}

export async function readJson(request: NextRequest): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Oczekiwano JSON (Content-Type: application/json)");
  }
  try {
    return await request.json();
  } catch {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawny JSON");
  }
}
