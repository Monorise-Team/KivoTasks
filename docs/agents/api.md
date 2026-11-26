# API, kontrakty i testy KivoTasks

API KivoTasks działa pod ścieżką `/api/v1/*` na hoście `kivo.monorise.studio` (lokalnie `http://kivo.localhost:3500/api/v1`).

## Standard odpowiedzi i obsługa tras (`apps/web/src/server/api.ts`)

- Każda trasa w `apps/web/src/app/api/v1/**/route.ts` jest opakowana w `route()` z `src/server/api.ts`.
- Każda odpowiedź ma nagłówek `Cache-Control: no-store` i kopertę `{ data, meta: { requestId }, error }` (ADR-0044).
- Błędy domenowe rzucane są przez `ApiFailure(status, code, message, details)` ze stałymi kodami `ERROR_CODES` z `@kivotasks/contracts` (m.in. `UNAUTHENTICATED`, `PRODUCT_ACCESS_REQUIRED`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`).
- Błędy `ZodError`, `AuthError`, `PermissionError`, `CoreApiError` i `CoreMachineTokenError` są automatycznie mapowane na spójne kody HTTP i polskie komunikaty.
- Żądania mutujące z ciasteczkiem sesji (bez nagłówka `Authorization`) przechodzą kontrolę `assertSameOrigin` (CSRF).

## Trasy etapu 0

| Metoda i ścieżka     | Uwierzytelnienie            | Opis                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health` | Publiczna                   | Zwraca `{ status: "ok", version }` bez odpytywania bazy i Core.                                                                                                                                                                                           |
| `GET /api/v1/me`     | Sesja BFF (`sessionCookie`) | Pobiera profil osoby i firmy z Core (`GET /core/v1/me`) oraz wylicza `capabilities` (`hasProductAccess`, `readIssues`, `writeIssues`, `manageTeams`, `manageProjects`) z migawki uprawnień. Wywołania z tokenem `Bearer` dostają `403 PERMISSION_DENIED`. |

Trasy logowania BFF (poza `/api/v1`, bez koperty JSON): `GET /api/auth/sign-in`, `GET /api/auth/callback`, `POST /api/auth/sign-out`.

## Katalog tras i OpenAPI 3.1

- Jednym źródłem prawdy dla OpenAPI jest `apps/web/src/server/routes.ts` połączony ze schematami Zod z `packages/contracts/src/index.ts`.
- `apps/web/src/server/openapi.ts` generuje deterministyczny dokument OpenAPI 3.1.0 zapisywany w `openapi/kivotasks-api.json`.
- Po każdej zmianie tras albo schematów uruchom `pnpm openapi`; CI sprawdza aktualność pliku przez `pnpm openapi:check`.
- Testy w `apps/web/test/contract.test.ts` pilnują, aby `openapi/kivotasks-api.json` pokrywał dokładnie wszystkie pliki `route.ts` pod `apps/web/src/app/api/v1/`, nie miał zerwanych ani nieużywanych schematów i spełniał `checkOpenApiDocument` z `@monorise-team/testing`.

## Kontrakty i klient

- `packages/contracts`: wspólne schematy Zod, `ApiErrorResponse`, `apiSuccessSchema`, `Health`, `Capabilities`, `Me` oraz `permissions.ts` (`KIVOTASKS_PERMISSIONS`, `KIVOTASKS_PERMISSION_MANIFEST`, `KIVOTASKS_ROLE_TEMPLATES`).
- `packages/client`: `createClient({ baseUrl, getToken, fetch })` z metodami `session.me()` i `session.signOut()`, rzucający `ApiError` przy odpowiedziach błędów i błędach sieci.

## Zestawy testów

Testy bez bazy danych (działają z atrapą `createFakeCore` z `@monorise-team/testing`, bez gniazd TCP):

- `packages/contracts/test/contracts.test.ts`: manifest uprawnień, gotowe role i schematy kopert.
- `packages/client/test/client.test.ts`: klient HTTP, nagłówki, ciasteczka i mapowanie `ApiError`.
- `apps/web/test/contract.test.ts`: kontrakt produktu Monorise (`defineProductContractTests`, `checkAuthentication`, `checkProductAccess`, spójność OpenAPI 3.1).
- `apps/web/test/api.test.ts`: `/health`, `/me`, `capabilities`, błędy Core, PKCE `/api/auth/sign-in`, ochrona CSRF i odświeżanie po `authz_rev`.
- `apps/web/test/permissions.test.ts`: role (`Członek KivoTasks`, `Administrator KivoTasks`, `Gość`, `Owner`), zakresy `ORGANIZATION`/`UNIT`/`RESOURCE`, `PRODUCT_ACCESS_REQUIRED`, pamięć podręczna i 503.
- `apps/web/test/core-machine.test.ts`, `core-registration.test.ts`, `core-resilience.test.ts`: token maszynowy, rejestracja manifestu i ról, ponawianie żądań i stronicowanie katalogu.
- `apps/web/test/event-feed.test.ts`: odbiór zdarzeń z Core, deduplikacja, kursor i konfiguracja `KIVOTASKS_EVENT_FEED_INTERVAL_MS`.
- `apps/web/test/hosts.test.ts`, `app-views.test.ts`: routing po hoście, parsowanie hashów i logika dostępu w powłoce.

Testy wymagające PostgreSQL: `packages/db/test/rls.test.ts` oraz `apps/web/test/tenant-isolation.test.ts`.
