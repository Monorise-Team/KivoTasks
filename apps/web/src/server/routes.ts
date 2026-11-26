/**
 * Katalog ścieżek API KivoTasks (`/api/v1/*`): jedno źródło prawdy dla generatora OpenAPI 3.1
 * (`openapi.ts`) i testów zgodności z kontraktem produktu (ADR-0044, ADR-0046).
 *
 * Moduł celowo nie importuje `server-only` i używa wyłącznie składni usuwalnej typów TypeScript,
 * dzięki czemu Node 24 uruchamia generator OpenAPI bez dodatkowego kompilatora.
 */
import {
  API_PREFIX,
  AssigneeFilter,
  CreateIssueInput,
  CreateIssueRelationInput,
  CreateLabelInput,
  CreateTeamInput,
  CreateWorkflowStateInput,
  Health,
  IssueDetail,
  IssueList,
  IssuePriority,
  IssueRelationView,
  IssueSort,
  Label,
  LabelsList,
  Me,
  PageCursor,
  PageLimit,
  ParentFilter,
  SearchIssuesResult,
  Team,
  TeamCandidatesList,
  TeamMembersList,
  TeamsList,
  UpdateIssueInput,
  UpdateLabelInput,
  UpdateTeamInput,
  UpdateWorkflowStateInput,
  WorkflowState,
  WorkflowStateCategory,
  WorkflowStatesList,
  type ErrorCode,
} from "@kivotasks/contracts";
import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteTag = "System" | "Session" | "Teams" | "States" | "Labels" | "Issues" | "Search";

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
  { name: "Teams", description: "Zespoły oparte na jednostkach organizacyjnych MonoriseCore i ich członkowie." },
  { name: "States", description: "Statusy obiegu zadań przypisane do zespołu." },
  { name: "Labels", description: "Etykiety zadań przypisane do zespołu." },
  { name: "Issues", description: "Zadania, podzadania oraz relacje między zadaniami." },
  { name: "Search", description: "Szybkie wyszukiwanie zadań po identyfikatorze i treści." },
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
  /** Ścieżka w formacie OpenAPI (np. `/api/v1/teams/{teamId}`). */
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
  /** Czy odpowiedź używa stronicowania kursorowego (`ApiListMeta` z `nextCursor`). */
  paginated?: boolean;
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

const UuidSchema = z.uuid();
const IssueIdOrIdentifierSchema = z.string().min(1).max(64);
const QueryTextSchema = z.string().max(200);
const BooleanStringParamSchema = z.enum(["true", "false"]);

const TEAM_ID_PARAM: ParameterDefinition = {
  name: "teamId",
  in: "path",
  required: true,
  description: "Identyfikator zespołu (UUID jednostki organizacyjnej z MonoriseCore).",
  schema: UuidSchema,
};

const STATE_ID_PARAM: ParameterDefinition = {
  name: "stateId",
  in: "path",
  required: true,
  description: "Identyfikator statusu obiegu (UUID).",
  schema: UuidSchema,
};

const LABEL_ID_PARAM: ParameterDefinition = {
  name: "labelId",
  in: "path",
  required: true,
  description: "Identyfikator etykiety (UUID).",
  schema: UuidSchema,
};

const ISSUE_UUID_PARAM: ParameterDefinition = {
  name: "issueId",
  in: "path",
  required: true,
  description: "Identyfikator zadania (UUID).",
  schema: UuidSchema,
};

const RELATION_ID_PARAM: ParameterDefinition = {
  name: "relationId",
  in: "path",
  required: true,
  description: "Identyfikator relacji między zadaniami (UUID).",
  schema: UuidSchema,
};

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

  // ── Zespoły ───────────────────────────────────────────────────────────────

  listTeams: {
    method: "GET",
    path: `${API_PREFIX}/teams`,
    operationId: "listTeams",
    tag: "Teams",
    summary: "Lista dostępnych zespołów",
    description:
      "Zwraca zespoły, dla których zalogowana osoba ma uprawnienie `kivotasks.issues.read` albo `kivotasks.teams.manage`. " +
      "W sesji przeglądarki odświeża buforowane nazwy z jednostek Core w jednym wywołaniu best-effort.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    dataSchemaName: "TeamsList",
    dataSchema: TeamsList,
    responseSchemaName: "TeamsListResponse",
    responseDescription: "Lista dostępnych zespołów.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  createTeam: {
    method: "POST",
    path: `${API_PREFIX}/teams`,
    operationId: "createTeam",
    tag: "Teams",
    summary: "Utworzenie zespołu z jednostki organizacyjnej Core",
    description:
      "Zamienia aktywną jednostkę organizacyjną z MonoriseCore w zespół KivoTasks z krótkim kluczem (2-5 wielkich liter) " +
      "oraz domyślnym zestawem 6 statusów obiegu. Wymaga `kivotasks.teams.manage` w zakresie całej firmy (`ORGANIZATION`) " +
      "oraz sesji przeglądarki BFF.",
    auth: "session",
    successStatus: 201,
    envelope: true,
    requestBodySchemaName: "CreateTeamInput",
    requestBodySchema: CreateTeamInput,
    requestBodyRequired: true,
    requestBodyDescription: "Identyfikator aktywnej jednostki Core oraz krótki klucz zespołu.",
    dataSchemaName: "Team",
    dataSchema: Team,
    responseSchemaName: "TeamResponse",
    responseDescription: "Utworzony zespół.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  listTeamCandidates: {
    method: "GET",
    path: `${API_PREFIX}/teams/candidates`,
    operationId: "listTeamCandidates",
    tag: "Teams",
    summary: "Aktywne jednostki Core, które nie są jeszcze zespołami",
    description:
      "Pobiera aktywne jednostki organizacyjne firmy z MonoriseCore i odfiltrowuje te, które są już zespołami KivoTasks. " +
      "Wymaga `kivotasks.teams.manage` w zakresie całej firmy (`ORGANIZATION`) oraz sesji przeglądarki BFF.",
    auth: "session",
    successStatus: 200,
    envelope: true,
    dataSchemaName: "TeamCandidatesList",
    dataSchema: TeamCandidatesList,
    responseSchemaName: "TeamCandidatesListResponse",
    responseDescription: "Lista kandydatów na zespoły.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  updateTeam: {
    method: "PATCH",
    path: `${API_PREFIX}/teams/{teamId}`,
    operationId: "updateTeam",
    tag: "Teams",
    summary: "Zmiana klucza zespołu",
    description:
      "Zmienia krótki klucz zespołu (`kivotasks.teams.manage` dla zespołu). Identyfikatory zadań zmieniają się razem z kluczem. " +
      "Zespoły spoza zasięgu odczytu zwracają `404 NOT_FOUND` przed `403`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [TEAM_ID_PARAM],
    requestBodySchemaName: "UpdateTeamInput",
    requestBodySchema: UpdateTeamInput,
    requestBodyRequired: true,
    requestBodyDescription: "Nowy unikalny klucz zespołu (2-5 wielkich liter A-Z).",
    dataSchemaName: "Team",
    dataSchema: Team,
    responseSchemaName: "TeamResponse",
    responseDescription: "Zaktualizowany zespół.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  listTeamMembers: {
    method: "GET",
    path: `${API_PREFIX}/teams/{teamId}/members`,
    operationId: "listTeamMembers",
    tag: "Teams",
    summary: "Członkowie zespołu z aktywnym kontem",
    description:
      "Zwraca członków jednostki Core przypisanych do zespołu, którzy mają aktywne konto Monorise " +
      "(`listProductDirectoryUnitMembers` i `listProductDirectoryEmployees` przez token maszynowy Core).",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [TEAM_ID_PARAM],
    dataSchemaName: "TeamMembersList",
    dataSchema: TeamMembersList,
    responseSchemaName: "TeamMembersListResponse",
    responseDescription: "Lista członków zespołu z kontem.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },

  // ── Statusy obiegu ────────────────────────────────────────────────────────

  listWorkflowStates: {
    method: "GET",
    path: `${API_PREFIX}/teams/{teamId}/states`,
    operationId: "listWorkflowStates",
    tag: "States",
    summary: "Statusy obiegu zadań zespołu",
    description: "Zwraca aktywne statusy obiegu zespołu posortowane według pola `position`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [TEAM_ID_PARAM],
    dataSchemaName: "WorkflowStatesList",
    dataSchema: WorkflowStatesList,
    responseSchemaName: "WorkflowStatesListResponse",
    responseDescription: "Lista statusów obiegu zespołu.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  createWorkflowState: {
    method: "POST",
    path: `${API_PREFIX}/teams/{teamId}/states`,
    operationId: "createWorkflowState",
    tag: "States",
    summary: "Dodanie statusu obiegu zespołu",
    description: "Tworzy nowy status w zespole (`kivotasks.teams.manage` dla zespołu).",
    auth: "user",
    successStatus: 201,
    envelope: true,
    parameters: [TEAM_ID_PARAM],
    requestBodySchemaName: "CreateWorkflowStateInput",
    requestBodySchema: CreateWorkflowStateInput,
    requestBodyRequired: true,
    requestBodyDescription: "Nazwa, kategoria, token koloru i opcjonalna pozycja nowego statusu.",
    dataSchemaName: "WorkflowState",
    dataSchema: WorkflowState,
    responseSchemaName: "WorkflowStateResponse",
    responseDescription: "Utworzony status obiegu.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  updateWorkflowState: {
    method: "PATCH",
    path: `${API_PREFIX}/teams/{teamId}/states/{stateId}`,
    operationId: "updateWorkflowState",
    tag: "States",
    summary: "Edycja statusu obiegu zespołu",
    description:
      "Aktualizuje nazwę, kategorię, kolor lub pozycję statusu (`kivotasks.teams.manage`). " +
      "Zmiana kategorii ostatniego statusu w kategorii `BACKLOG`/`UNSTARTED` kończy się `409 CONFLICT`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [TEAM_ID_PARAM, STATE_ID_PARAM],
    requestBodySchemaName: "UpdateWorkflowStateInput",
    requestBodySchema: UpdateWorkflowStateInput,
    requestBodyRequired: true,
    requestBodyDescription: "Pola statusu do zaktualizowania.",
    dataSchemaName: "WorkflowState",
    dataSchema: WorkflowState,
    responseSchemaName: "WorkflowStateResponse",
    responseDescription: "Zaktualizowany status obiegu.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  deleteWorkflowState: {
    method: "DELETE",
    path: `${API_PREFIX}/teams/{teamId}/states/{stateId}`,
    operationId: "deleteWorkflowState",
    tag: "States",
    summary: "Usunięcie statusu obiegu zespołu",
    description:
      "Usuwa status obiegu (`kivotasks.teams.manage`). Zwraca `409 CONFLICT`, gdy aktywne zadania używają tego statusu " +
      "albo gdy jest to ostatni status zespołu w kategorii `BACKLOG` lub `UNSTARTED`.",
    auth: "user",
    successStatus: 204,
    envelope: false,
    parameters: [TEAM_ID_PARAM, STATE_ID_PARAM],
    responseDescription: "Status został usunięty.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },

  // ── Etykiety ──────────────────────────────────────────────────────────────

  listLabels: {
    method: "GET",
    path: `${API_PREFIX}/teams/{teamId}/labels`,
    operationId: "listLabels",
    tag: "Labels",
    summary: "Etykiety zespołu",
    description: "Zwraca aktywne etykiety należące do zespołu.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [TEAM_ID_PARAM],
    dataSchemaName: "LabelsList",
    dataSchema: LabelsList,
    responseSchemaName: "LabelsListResponse",
    responseDescription: "Lista etykiet zespołu.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  createLabel: {
    method: "POST",
    path: `${API_PREFIX}/teams/{teamId}/labels`,
    operationId: "createLabel",
    tag: "Labels",
    summary: "Utworzenie etykiety zespołu",
    description:
      "Tworzy nową etykietę w zespole (`kivotasks.teams.manage`). Nazwa jest unikalna w zespole bez rozróżniania wielkości liter.",
    auth: "user",
    successStatus: 201,
    envelope: true,
    parameters: [TEAM_ID_PARAM],
    requestBodySchemaName: "CreateLabelInput",
    requestBodySchema: CreateLabelInput,
    requestBodyRequired: true,
    requestBodyDescription: "Nazwa (1-40 znaków) i token koloru etykiety.",
    dataSchemaName: "Label",
    dataSchema: Label,
    responseSchemaName: "LabelResponse",
    responseDescription: "Utworzona etykieta.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  updateLabel: {
    method: "PATCH",
    path: `${API_PREFIX}/teams/{teamId}/labels/{labelId}`,
    operationId: "updateLabel",
    tag: "Labels",
    summary: "Edycja etykiety zespołu",
    description: "Zmienia nazwę lub kolor etykiety (`kivotasks.teams.manage`).",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [TEAM_ID_PARAM, LABEL_ID_PARAM],
    requestBodySchemaName: "UpdateLabelInput",
    requestBodySchema: UpdateLabelInput,
    requestBodyRequired: true,
    requestBodyDescription: "Pola etykiety do zaktualizowania.",
    dataSchemaName: "Label",
    dataSchema: Label,
    responseSchemaName: "LabelResponse",
    responseDescription: "Zaktualizowana etykieta.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  deleteLabel: {
    method: "DELETE",
    path: `${API_PREFIX}/teams/{teamId}/labels/{labelId}`,
    operationId: "deleteLabel",
    tag: "Labels",
    summary: "Usunięcie etykiety zespołu",
    description: "Usuwa etykietę z zespołu i odpina ją od zadań (`kivotasks.teams.manage`).",
    auth: "user",
    successStatus: 204,
    envelope: false,
    parameters: [TEAM_ID_PARAM, LABEL_ID_PARAM],
    responseDescription: "Etykieta została usunięta.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },

  // ── Zadania i relacje ─────────────────────────────────────────────────────

  listIssues: {
    method: "GET",
    path: `${API_PREFIX}/issues`,
    operationId: "listIssues",
    tag: "Issues",
    summary: "Lista zadań z filtrami, sortowaniem i stronicowaniem kursorowym",
    description:
      "Zwraca stronę zadań wyłącznie z zespołów objętych uprawnieniem `kivotasks.issues.read`. " +
      "Domyślnie ukrywa zadania ze statusami kategorii `COMPLETED` i `CANCELED` (chyba że podano `includeCompleted=true`, " +
      "`stateId` lub odpowiadające `stateCategory`). Stronicowanie kursorowe przez `limit` (1-100) i `meta.nextCursor`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    paginated: true,
    parameters: [
      {
        name: "teamId",
        in: "query",
        required: false,
        description: "Filtr po identyfikatorze zespołu (UUID).",
        schema: UuidSchema,
      },
      {
        name: "stateId",
        in: "query",
        required: false,
        description: "Filtr po identyfikatorze statusu obiegu (UUID).",
        schema: UuidSchema,
      },
      {
        name: "stateCategory",
        in: "query",
        required: false,
        description: "Filtr po kategorii statusu (`BACKLOG`, `UNSTARTED`, `STARTED`, `COMPLETED`, `CANCELED`).",
        schema: WorkflowStateCategory,
      },
      {
        name: "assignee",
        in: "query",
        required: false,
        description: "Filtr przypisania: `me`, `none` albo UUID konta osoby.",
        schema: AssigneeFilter,
      },
      {
        name: "labelId",
        in: "query",
        required: false,
        description: "Filtr po identyfikatorze etykiety (UUID).",
        schema: UuidSchema,
      },
      {
        name: "priority",
        in: "query",
        required: false,
        description: "Filtr po priorytecie (0 brak, 1 pilny, 2 wysoki, 3 średni, 4 niski).",
        schema: IssuePriority,
      },
      {
        name: "parentId",
        in: "query",
        required: false,
        description: "Filtr po zadaniu nadrzędnym (`none` dla zadań głównych albo UUID rodzica).",
        schema: ParentFilter,
      },
      {
        name: "q",
        in: "query",
        required: false,
        description: "Fraza wyszukiwania pełnotekstowego lub dokładny identyfikator zadania (np. `MAG-12`).",
        schema: QueryTextSchema,
      },
      {
        name: "includeCompleted",
        in: "query",
        required: false,
        description:
          "Czy dołączyć zadania ze statusami `COMPLETED` i `CANCELED` (`true` albo `false`, domyślnie `false`).",
        schema: BooleanStringParamSchema,
      },
      {
        name: "sort",
        in: "query",
        required: false,
        description: "Sortowanie wyników: `priority`, `updated` (domyślnie), `created`, `dueDate` albo `manual`.",
        schema: IssueSort,
      },
      {
        name: "limit",
        in: "query",
        required: false,
        description: "Liczba zadań na stronie (1-100, domyślnie 50).",
        schema: PageLimit,
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        description: "Nieprzezroczysty kursor następnej strony z pola `meta.nextCursor`.",
        schema: PageCursor,
      },
    ],
    dataSchemaName: "IssueList",
    dataSchema: IssueList,
    responseSchemaName: "IssueListResponse",
    responseDescription: "Strona listy zadań oraz kursor `meta.nextCursor`.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  createIssue: {
    method: "POST",
    path: `${API_PREFIX}/issues`,
    operationId: "createIssue",
    tag: "Issues",
    summary: "Utworzenie zadania",
    description:
      "Tworzy zadanie w zespole z atomowo przydzielonym numerem (`KEY-number`). Wymaga `kivotasks.issues.write` dla zespołu " +
      "(zespoły spoza zasięgu odczytu zwracają `404 NOT_FOUND` przed `403`). Domyślny status to pierwszy `BACKLOG`, " +
      "w przeciwnym razie pierwszy `UNSTARTED`. Osoba przypisana musi być członkiem zespołu z aktywnym kontem.",
    auth: "user",
    successStatus: 201,
    envelope: true,
    requestBodySchemaName: "CreateIssueInput",
    requestBodySchema: CreateIssueInput,
    requestBodyRequired: true,
    requestBodyDescription: "Dane nowego zadania.",
    dataSchemaName: "IssueDetail",
    dataSchema: IssueDetail,
    responseSchemaName: "IssueDetailResponse",
    responseDescription: "Utworzone zadanie ze szczegółami.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  getIssue: {
    method: "GET",
    path: `${API_PREFIX}/issues/{issueId}`,
    operationId: "getIssue",
    tag: "Issues",
    summary: "Szczegóły zadania po UUID lub identyfikatorze",
    description:
      "Pobiera zadanie po UUID albo identyfikatorze (np. `MAG-12`, bez rozróżniania wielkości liter). " +
      "Dołącza etykiety, skrót zadania nadrzędnego, podzadania oraz relacje w obie strony (`BLOCKED_BY` jako odwrotny widok `BLOCKS`).",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [
      {
        name: "issueId",
        in: "path",
        required: true,
        description:
          "UUID zadania albo identyfikator zespołu z numerem (np. `MAG-12`, bez rozróżniania wielkości liter).",
        schema: IssueIdOrIdentifierSchema,
      },
    ],
    dataSchemaName: "IssueDetail",
    dataSchema: IssueDetail,
    responseSchemaName: "IssueDetailResponse",
    responseDescription: "Szczegóły zadania.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  updateIssue: {
    method: "PATCH",
    path: `${API_PREFIX}/issues/{issueId}`,
    operationId: "updateIssue",
    tag: "Issues",
    summary: "Częściowa aktualizacja zadania",
    description:
      "Aktualizuje wybrane pola zadania oraz kolejność `sortOrder` (`kivotasks.issues.write` dla zespołu). " +
      "Automatycznie ustawia albo czyści `startedAt`, `completedAt` i `canceledAt` przy zmianie kategorii statusu. " +
      "Przenoszenie zadania między zespołami zwraca `422 VALIDATION_FAILED`, a cykl w hierarchii `parentId` zwraca `409 CONFLICT`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [ISSUE_UUID_PARAM],
    requestBodySchemaName: "UpdateIssueInput",
    requestBodySchema: UpdateIssueInput,
    requestBodyRequired: true,
    requestBodyDescription: "Pola zadania do aktualizacji.",
    dataSchemaName: "IssueDetail",
    dataSchema: IssueDetail,
    responseSchemaName: "IssueDetailResponse",
    responseDescription: "Zaktualizowane zadanie.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  deleteIssue: {
    method: "DELETE",
    path: `${API_PREFIX}/issues/{issueId}`,
    operationId: "deleteIssue",
    tag: "Issues",
    summary: "Miękkie usunięcie zadania",
    description: "Ustawia `deletedAt` na zadaniu, ukrywając je z list i wyszukiwania (`kivotasks.issues.write`).",
    auth: "user",
    successStatus: 204,
    envelope: false,
    parameters: [ISSUE_UUID_PARAM],
    responseDescription: "Zadanie zostało oznaczone jako usunięte.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  createIssueRelation: {
    method: "POST",
    path: `${API_PREFIX}/issues/{issueId}/relations`,
    operationId: "createIssueRelation",
    tag: "Issues",
    summary: "Dodanie relacji między zadaniami",
    description:
      "Tworzy relację (`BLOCKS`, `BLOCKED_BY`, `RELATED`, `DUPLICATE`) między dwoma zadaniami w obrębie firmy. " +
      "Dla relacji między zespołami wymaga `kivotasks.issues.write` obejmującego oba zespoły.",
    auth: "user",
    successStatus: 201,
    envelope: true,
    parameters: [ISSUE_UUID_PARAM],
    requestBodySchemaName: "CreateIssueRelationInput",
    requestBodySchema: CreateIssueRelationInput,
    requestBodyRequired: true,
    requestBodyDescription: "Powiązane zadanie i typ relacji.",
    dataSchemaName: "IssueRelationView",
    dataSchema: IssueRelationView,
    responseSchemaName: "IssueRelationViewResponse",
    responseDescription: "Utworzona relacja z perspektywy wskazanego zadania.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
  deleteIssueRelation: {
    method: "DELETE",
    path: `${API_PREFIX}/issues/{issueId}/relations/{relationId}`,
    operationId: "deleteIssueRelation",
    tag: "Issues",
    summary: "Usunięcie relacji między zadaniami",
    description: "Usuwa relację między zadaniami. Wymaga `kivotasks.issues.write` dla obu zespołów objętych relacją.",
    auth: "user",
    successStatus: 204,
    envelope: false,
    parameters: [ISSUE_UUID_PARAM, RELATION_ID_PARAM],
    responseDescription: "Relacja została usunięta.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      404: ["NOT_FOUND"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },

  // ── Wyszukiwanie ──────────────────────────────────────────────────────────

  searchIssues: {
    method: "GET",
    path: `${API_PREFIX}/search`,
    operationId: "searchIssues",
    tag: "Search",
    summary: "Wyszukiwanie zadań w dostępnych zespołach",
    description:
      "Zwraca do 20 zadań z zespołów objętych `kivotasks.issues.read`. Dokładne dopasowanie identyfikatora " +
      "(np. `MAG-12`) zawsze trafia na pierwsze miejsce, a za nim dopasowania pełnotekstowe z wagą tytułu przed opisem.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: [
      {
        name: "q",
        in: "query",
        required: false,
        description: "Zapytanie wyszukiwania (identyfikator np. `MAG-12` albo słowa kluczowe z tytułu i opisu).",
        schema: QueryTextSchema,
      },
    ],
    dataSchemaName: "SearchIssuesResult",
    dataSchema: SearchIssuesResult,
    responseSchemaName: "SearchIssuesResultResponse",
    responseDescription: "Do 20 dopasowanych zadań.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL_ERROR"],
      503: ["INTERNAL_ERROR"],
    },
  },
} as const satisfies Record<string, RouteDefinition>;

export const ROUTE_LIST: readonly RouteDefinition[] = Object.values(ROUTES);
