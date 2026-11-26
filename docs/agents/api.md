# API, kontrakty i testy KivoTasks

API KivoTasks działa pod ścieżką `/api/v1/*` na hoście `kivo.monorise.studio` (lokalnie `http://kivo.localhost:3500/api/v1`).

## Standard odpowiedzi i obsługa tras (`apps/web/src/server/api.ts`)

- Każda trasa w `apps/web/src/app/api/v1/**/route.ts` jest opakowana w `route()` z `src/server/api.ts`.
- Każda odpowiedź ustawia `Cache-Control: no-store` i używa koperty `{ data, meta: { requestId }, error }` (ADR-0044); odpowiedzi `204` zwracają puste ciało, a listy stronicowane kursorowo zwracają `paginated(items, nextCursor)` z `meta.nextCursor`.
- Błędy domenowe rzucane są przez `ApiFailure(status, code, message, details)` ze stałymi kodami `ERROR_CODES` z `@kivotasks/contracts` (m.in. `UNAUTHENTICATED`, `PRODUCT_ACCESS_REQUIRED`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`).
- Błędy `ZodError`, `AuthError`, `PermissionError`, `CoreApiError` i `CoreMachineTokenError` są automatycznie mapowane na spójne kody HTTP i polskie komunikaty.
- Żądania mutujące z ciasteczkiem sesji (bez nagłówka `Authorization`) przechodzą kontrolę `assertSameOrigin` (CSRF).

## Autoryzacja w aplikacji (`apps/web/src/server/permissions.ts`)

Uprawnienie obejmuje zespół, gdy efektywny zakres (`scopeOf` z `@monorise-team/permissions`) ma typ `ORGANIZATION` (w tym Owner firmy) albo `LIMITED` zawierający identyfikator jednostki zespołu (Core rozwija poddrzewa jednostek automatycznie).

- Odczyt zadań, statusów, etykiet lub relacji zespołu: `kivotasks.issues.read` albo `kivotasks.issues.write` na zespole (kto może pisać, ten też widzi; dla listy zespołów, członków, statusów i etykiet wystarcza również `kivotasks.teams.manage`).
- Tworzenie, edycja i usuwanie zadań oraz relacji: `kivotasks.issues.write` na zespole (dla relacji między zespołami na obu zespołach).
- Ustawienia zespołu (klucz, statusy, etykiety): `kivotasks.teams.manage` na zespole.
- Tworzenie zespołu z jednostki Core i lista kandydatów: `kivotasks.teams.manage` w zakresie `ORGANIZATION`.
- Zespoły i zadania spoza zasięgu odczytu osoby zwracają `404 NOT_FOUND` przed `403 PERMISSION_DENIED`, żeby nie ujawniać ich istnienia. Konta bez żadnych uprawnień KivoTasks dostają `403 PERMISSION_DENIED` przed warstwą bazy.

## Katalog tras (`/api/v1`)

### System i sesja

| Metoda i ścieżka     | Uwierzytelnienie            | Opis                                                                                                                                                                                                                                         |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health` | Publiczna                   | Zwraca `{ status: "ok", version }` bez odpytywania bazy i Core.                                                                                                                                                                              |
| `GET /api/v1/me`     | Sesja BFF (`sessionCookie`) | Pobiera profil osoby i firmy z Core (`GET /core/v1/me`) oraz `capabilities` (`hasProductAccess`, `readIssues`, `writeIssues`, `manageTeams`, `createTeams`, `manageProjects`). Wywołania z tokenem `Bearer` dostają `403 PERMISSION_DENIED`. |

Trasy logowania BFF (poza `/api/v1`, bez koperty JSON): `GET /api/auth/sign-in`, `GET /api/auth/callback`, `POST /api/auth/sign-out`.

### Zespoły, statusy obiegu i etykiety (etap 1a)

| Metoda i ścieżka                                 | Uwierzytelnienie | Opis                                                                                                                                                                 |
| ------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/teams`                              | `user`           | Lista zespołów dostępnych dla osoby (`issues.read`, `issues.write` lub `teams.manage`). W sesji BFF odświeża buforowane nazwy z Core w jednym wywołaniu best-effort. |
| `POST /api/v1/teams`                             | `session`        | Tworzy zespół z aktywnej jednostki Core (`{ unitId, key }`, `teams.manage` w zakresie `ORGANIZATION`) wraz z 6 domyślnymi statusami obiegu.                          |
| `GET /api/v1/teams/candidates`                   | `session`        | Aktywne jednostki Core, które nie są jeszcze zespołami (`teams.manage` w zakresie `ORGANIZATION`).                                                                   |
| `PATCH /api/v1/teams/{teamId}`                   | `user`           | Zmienia klucz zespołu (`teams.manage`); identyfikatory zadań zmieniają się wraz z kluczem.                                                                           |
| `GET /api/v1/teams/{teamId}/members`             | `user`           | Aktywni członkowie jednostki Core posiadający konto (`accountId`, `employeeId`, `firstName`, `lastName`) z katalogu produktu Core (`core:directory.read`).           |
| `GET /api/v1/teams/{teamId}/states`              | `user`           | Lista aktywnych statusów obiegu zespołu posortowanych po `position`.                                                                                                 |
| `POST /api/v1/teams/{teamId}/states`             | `user`           | Dodaje status obiegu do zespołu (`teams.manage`).                                                                                                                    |
| `PATCH /api/v1/teams/{teamId}/states/{stateId}`  | `user`           | Edytuje status obiegu (`teams.manage`); blokuje opuszczenie ostatniego statusu `BACKLOG`/`UNSTARTED` kodem `409 CONFLICT`.                                           |
| `DELETE /api/v1/teams/{teamId}/states/{stateId}` | `user`           | Usuwa status obiegu (`204`); zwraca `409 CONFLICT`, gdy używają go aktywne zadania lub jest ostatnim statusem `BACKLOG`/`UNSTARTED`.                                 |
| `GET /api/v1/teams/{teamId}/labels`              | `user`           | Lista aktywnych etykiet zespołu.                                                                                                                                     |
| `POST /api/v1/teams/{teamId}/labels`             | `user`           | Dodaje etykietę (`teams.manage`); unikalność nazwy bez rozróżniania wielkości liter w obrębie zespołu (`409 CONFLICT`).                                              |
| `PATCH /api/v1/teams/{teamId}/labels/{labelId}`  | `user`           | Edytuje etykietę zespołu (`teams.manage`).                                                                                                                           |
| `DELETE /api/v1/teams/{teamId}/labels/{labelId}` | `user`           | Usuwa etykietę i odpina ją od zadań (`204`).                                                                                                                         |

### Zadania, relacje i wyszukiwanie (etap 1a)

| Metoda i ścieżka                                         | Uwierzytelnienie | Opis                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/issues`                                     | `user`           | Stronicowana kursorowo (`limit` 1–100, `cursor`, `meta.nextCursor`) lista zadań z dostępnych zespołów. Filtry: `teamId`, `stateId`, `stateCategory`, `assignee=me\|none\|<accountId>`, `labelId`, `priority`, `parentId`, `q`, `includeCompleted`. Sortowanie: `priority`, `updated`, `created`, `dueDate`, `manual`. |
| `POST /api/v1/issues`                                    | `user`           | Tworzy zadanie z atomowym numerem (`KEY-number`), domyślnym statusem (`BACKLOG`, inaczej `UNSTARTED`) i walidacją przypisanego członka zespołu w Core Directory.                                                                                                                                                      |
| `GET /api/v1/issues/{issueId}`                           | `user`           | Pobiera szczegóły zadania po UUID lub identyfikatorze (np. `MAG-12`, bez rozróżniania wielkości liter) z etykietami, rodzicem, podzadaniami i relacjami w obie strony (`BLOCKED_BY` jako odwrotny widok `BLOCKS`).                                                                                                    |
| `PATCH /api/v1/issues/{issueId}`                         | `user`           | Częściowa aktualizacja pól zadania oraz `sortOrder`; automatycznie ustawia/czyści `startedAt`/`completedAt`/`canceledAt`. Zmiana zespołu zwraca `422 VALIDATION_FAILED`, a cykl `parentId` zwraca `409 CONFLICT`.                                                                                                     |
| `DELETE /api/v1/issues/{issueId}`                        | `user`           | Miękkie usunięcie zadania (`deletedAt`, zwraca `204`).                                                                                                                                                                                                                                                                |
| `POST /api/v1/issues/{issueId}/relations`                | `user`           | Dodaje relację (`BLOCKS`, `BLOCKED_BY`, `RELATED`, `DUPLICATE`), także między zespołami w firmie (wymaga `issues.write` w obu zespołach).                                                                                                                                                                             |
| `DELETE /api/v1/issues/{issueId}/relations/{relationId}` | `user`           | Usuwa relację (`204`, wymaga `issues.write` w obu zespołach).                                                                                                                                                                                                                                                         |
| `GET /api/v1/search?q=`                                  | `user`           | Zwraca do 20 zadań z dostępnych zespołów: dokładne dopasowanie identyfikatora na 1. miejscu, dalej wyniki pełnotekstowe (`tsvector`, tytuł waga `A`, opis waga `B`).                                                                                                                                                  |

## Katalog tras i OpenAPI 3.1

- Jednym źródłem prawdy dla OpenAPI jest `apps/web/src/server/routes.ts` połączony ze schematami Zod z `packages/contracts/src/index.ts`.
- `apps/web/src/server/openapi.ts` generuje deterministyczny dokument OpenAPI 3.1.0 zapisywany w `openapi/kivotasks-api.json`.
- Po każdej zmianie tras albo schematów uruchom `pnpm openapi`; CI sprawdza aktualność pliku przez `pnpm openapi:check`.
- Testy w `apps/web/test/contract.test.ts` pilnują, aby `openapi/kivotasks-api.json` pokrywał dokładnie wszystkie pliki `route.ts` pod `apps/web/src/app/api/v1/`, nie miał zerwanych ani nieużywanych schematów i spełniał `checkOpenApiDocument` z `@monorise-team/testing`.

## Kontrakty i klient

- `packages/contracts`: wspólne schematy Zod, `ApiErrorResponse`, `ApiListMeta`, `apiSuccessSchema`, `apiListSuccessSchema`, `Health`, `Capabilities`, `Me`, schematy zespołów, statusów, etykiet, zadań, relacji i wyszukiwania oraz `permissions.ts` (`KIVOTASKS_PERMISSIONS`, `KIVOTASKS_PERMISSION_MANIFEST`, `KIVOTASKS_ROLE_TEMPLATES`).
- `packages/client`: `createClient({ baseUrl, getToken, fetch })` z modułami `session`, `teams`, `states`, `labels`, `issues` i `search`, rzucający `ApiError` przy odpowiedziach błędów i błędach sieci.

## Zestawy testów

Testy bez bazy danych (działają z atrapą `createFakeCore` z `@monorise-team/testing`, bez gniazd TCP):

- `packages/contracts/test/contracts.test.ts`: manifest uprawnień, gotowe role, schematy kopert i domeny etapu 1a.
- `packages/client/test/client.test.ts`: klient HTTP, stronicowanie kursorowe, obsługa `204`, nagłówki, ciasteczka i mapowanie `ApiError`.
- `apps/web/test/contract.test.ts`: kontrakt produktu Monorise (`defineProductContractTests` dla wszystkich tras `/api/v1/*`, spójność OpenAPI 3.1).
- `apps/web/test/api.test.ts`: `/health`, `/me`, `capabilities`, błędy Core, PKCE `/api/auth/sign-in`, ochrona CSRF i odświeżanie po `authz_rev`.
- `apps/web/test/permissions.test.ts`: role (`Członek KivoTasks`, `Administrator KivoTasks`, `Gość`, `Owner`), zakresy `ORGANIZATION`/`UNIT`/`RESOURCE`, `createTeams`, `PRODUCT_ACCESS_REQUIRED`, pamięć podręczna i 503.
- `apps/web/test/issue-helpers.test.ts`: parsowanie identyfikatorów, automatyczne znaczniki czasu kategorii statusów, kolejność priorytetów, budowanie `tsquery`, wykrywanie cykli, relacje i kursory stronicowania.
- `apps/web/test/teams-api.test.ts`: zespoły, kandydaci, best-effort odświeżanie nazw, członkowie z Core Directory, statusy (w tym domyślne i strażniki `409`), etykiety oraz reguła `404` przed `403`.
- `apps/web/test/issues-api.test.ts`: zadania, numeracja, zmiana klucza zespołu, walidacja przypisania, podzadania i cykle, relacje (w tym między zespołami i `BLOCKED_BY`), filtry, 5 sortowań, stronicowanie kursorowe i ranking wyszukiwania.
- `apps/web/test/core-machine.test.ts`, `core-registration.test.ts`, `core-resilience.test.ts`: token maszynowy, rejestracja manifestu i ról, ponawianie żądań i stronicowanie katalogu.
- `apps/web/test/event-feed.test.ts`: odbiór zdarzeń z Core, deduplikacja, kursor i konfiguracja `KIVOTASKS_EVENT_FEED_INTERVAL_MS`.
- `apps/web/test/hosts.test.ts`, `app-views.test.ts`: routing po hoście, parsowanie hashów i logika dostępu w powłoce.

Testy wymagające PostgreSQL: `packages/db/test/rls.test.ts` oraz `apps/web/test/tenant-isolation.test.ts`.
