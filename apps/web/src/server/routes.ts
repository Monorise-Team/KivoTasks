/**
 * Katalog ścieżek API KivoTasks (`/api/v1/*`): jedno źródło prawdy dla generatora OpenAPI 3.1
 * (`openapi.ts`) i testów zgodności z kontraktem produktu (ADR-0044, ADR-0046).
 *
 * Moduł celowo nie importuje `server-only` i używa wyłącznie składni usuwalnej typów TypeScript,
 * dzięki czemu Node 24 uruchamia generator OpenAPI bez dodatkowego kompilatora.
 */
import { API_PREFIX, Health, Me, type ErrorCode } from "@kivotasks/contracts";
import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteTag = "System" | "Session";

/**
 * Wymagane uwierzytelnienie trasy:
 * - `false`: publiczna (bez tokenu i bez sesji),
 * - `"session"`: wyłącznie sesja BFF przeglądarki w ciasteczku `HttpOnly`,
 * - `"user"`: token użytkownika `Bearer` albo sesja BFF przeglądarki.
 */
export type RouteAuth = false | "session" | "user";

export interface TagDefinition {
  name: RouteTag;
  description: string;
}

export const TAGS: readonly TagDefinition[] = [
  { name: "System", description: "Stan usługi KivoTasks." },
  { name: "Session", description: "Dane zalogowanej osoby, firmy i możliwości widoczne w przeglądarce (BFF)." },
];

export type SuccessStatus = 200 | 201 | 204;
export type ErrorStatus = 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
export type RouteErrors = Partial<Record<ErrorStatus, readonly ErrorCode[]>>;

export interface ParameterDefinition {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  schema: z.ZodType;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** Ścieżka w formacie OpenAPI (np. `/api/v1/me`). */
  path: string;
  operationId: string;
  tag: RouteTag;
  summary: string;
  description?: string;
  auth: RouteAuth;
  /** Kod odpowiedzi sukcesu. */
  successStatus: SuccessStatus;
  /** Czy odpowiedź sukcesu jest owinięta w kopertę `{ data, meta, error }` (nie dotyczy 204). */
  envelope: boolean;
  /** Parametry ścieżki (`path`) i zapytania (`query`). */
  parameters?: readonly ParameterDefinition[];
  /** Nazwa i schemat treści żądania (dla POST/PUT/PATCH). */
  requestBodySchemaName?: string;
  requestBodySchema?: z.ZodType;
  requestBodyRequired?: boolean;
  requestBodyDescription?: string;
  /** Nazwa schematu danych w `components/schemas` (brak przy 204). */
  dataSchemaName?: string;
  dataSchema?: z.ZodType;
  /** Nazwa schematu odpowiedzi w `components/schemas` dla odpowiedzi z kopertą (np. `MeResponse`). */
  responseSchemaName?: string;
  responseDescription: string;
  errors: RouteErrors;
}

export const ROUTES = {
  getHealth: {
    method: "GET",
    path: `${API_PREFIX}/health`,
    operationId: "getHealth",
    tag: "System",
    summary: "Stan usługi KivoTasks",
    description: "Publiczna kontrola zdrowia serwera API bez sprawdzania bazy danych i MonoriseCore.",
    auth: false,
    successStatus: 200,
    envelope: true,
    dataSchemaName: "Health",
    dataSchema: Health,
    responseSchemaName: "HealthResponse",
    responseDescription: "Usługa działa.",
    errors: {
      500: ["INTERNAL_ERROR"],
    },
  },
  getMe: {
    method: "GET",
    path: `${API_PREFIX}/me`,
    operationId: "getMe",
    tag: "Session",
    summary: "Zalogowana osoba, firma i możliwości w KivoTasks",
    description:
      "Zwraca profil osoby i firmy pobrany z MonoriseCore (`GET /core/v1/me`) oraz pole `capabilities` wyliczone " +
      "z migawki uprawnień produktu `kivotasks`. Dostępne wyłącznie przez sesję BFF przeglądarki (ciasteczko); " +
      "wywołania z tokenem Bearer otrzymują `403 PERMISSION_DENIED`, bo profil osoby i firmy pobierają bezpośrednio z Core API.",
    auth: "session",
    successStatus: 200,
    envelope: true,
    dataSchemaName: "Me",
    dataSchema: Me,
    responseSchemaName: "MeResponse",
    responseDescription: "Profil zalogowanej osoby, firma i możliwości w interfejsie.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PERMISSION_DENIED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
} as const satisfies Record<string, RouteDefinition>;

export const ROUTE_LIST: readonly RouteDefinition[] = Object.values(ROUTES);
