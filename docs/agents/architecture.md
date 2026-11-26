# Architektura KivoTasks

KivoTasks jest produktem Monorise do zarządzania zadaniami i projektami w przeglądarce, wzorowanym zakresem funkcji na Linear (ADR-0103). Działa wyłącznie w przeglądarce, bez aplikacji mobilnej i desktopowej. Układ repozytorium powtarza TimoTime (ADR-0096).

## Układ przestrzeni roboczej

| Katalog                      | Rola                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                   | Jedna aplikacja Next.js (lokalnie port `3500`): strona produktu i API `/api/v1` na `kivo.*`, aplikacja w przeglądarce na `kivotasks.*`.                                     |
| `packages/contracts`         | Schematy Zod, typy odpowiedzi API (`{ data, meta, error }`, `Capabilities`, `Me`), manifest uprawnień (`KIVOTASKS_PERMISSIONS`) i gotowe role (`KIVOTASKS_ROLE_TEMPLATES`). |
| `packages/client`            | Typowany klient HTTP API KivoTasks dla przeglądarki (`createClient`, `ApiError`).                                                                                           |
| `packages/db`                | Schemat Prisma 7, migracje PostgreSQL, klient bazy (`createDb`), `uuidv7` i pomocnik RLS `withUser`.                                                                        |
| `openapi/kivotasks-api.json` | Opis OpenAPI 3.1 generowany deterministycznie z katalogu ścieżek i schematów Zod.                                                                                           |

## Routing według hosta (`apps/web/src/proxy.ts` i `src/lib/hosts.ts`)

- `kivo.monorise.studio` (lokalnie `kivo.localhost:3500`): wyświetla stronę produktu (`src/app/(site)/`) oraz udostępnia API `/api/v1/*`. Ścieżki `/app` i `/app/*` na tym hoście zwracają `404`.
- `kivotasks.monorise.studio` (lokalnie `kivotasks.localhost:3500`): przepisuje wszystkie ścieżki poza `/api/*` pod `/app/*` (`src/app/app/`). Lista hostów aplikacji może być nadpisana zmienną `KIVOTASKS_APP_HOSTS`.
- Żądania wstępne CORS (`OPTIONS /api/*`) przepuszczają wyłącznie adresy z `KIVOTASKS_ALLOWED_ORIGINS`.

## Logowanie i integracja z MonoriseCore

- **Sesja przeglądarki (BFF, ADR-0050):** `apps/web/src/server/auth.ts` tworzy instancję `createWebAuth` z `@monorise-team/auth/next` dla klienta `kivotasks-web` i obu zasobów (`KIVOTASKS_API_URL` oraz `CORE_API_URL`). Sesje trafiają do `auth.sessions` (`src/server/sessions.ts`), a tokeny są zaszyfrowane kluczem `KIVOTASKS_SESSION_SECRET`.
- **Trasy logowania:** `/api/auth/sign-in`, `/api/auth/callback`, `/api/auth/sign-out`.
- **Tożsamość żądania:** wyłącznie `requireUser(request)` w `src/server/auth.ts`. Zwraca `Caller` (`organizationId`, `accountId`, `employeeId`, `context`, `session`, `token`).
- **Klient Core SDK (`src/server/core.ts` i `src/server/core-machine.ts`):**
  - `createUserCoreClient(session)`: wywołania w imieniu zalogowanej osoby (`GET /core/v1/me` dla `GET /api/v1/me`).
  - `getMachineCoreClient()`: token maszynowy OAuth 2.1 (`client_credentials`, zakresy `core:permissions.read core:directory.read core:events.read`), buforowany do 30 s przed wygaśnięciem z pojedynczym odświeżaniem w locie (`single-flight`).
  - Oba klienty ponawiają żądania przy krótkich błędach sieci i statusach `429`, `502`, `503`, `504` (`DEFAULT_CORE_RETRY`: 3 próby, 200 do 2000 ms). Przy trwałej awarii serwer odmawia bezpiecznie kodem `503` (fail-closed).

## Uprawnienia, role i kanał zdarzeń

- **Deklaracja:** `packages/contracts/src/permissions.ts` (`definePermissions("kivotasks", ...)`):
  - `kivotasks.issues.read`, `kivotasks.issues.write`, `kivotasks.teams.manage`, `kivotasks.projects.manage`.
  - Gotowe role: `kivotasks.member` (Członek KivoTasks), `kivotasks.admin` (Administrator KivoTasks), `kivotasks.guest` (Gość).
- **Rejestracja w Core:** `pnpm permissions:register` (`apps/web/scripts/register-permissions.mjs` i `src/server/core-registration.ts`, zakres `core:permissions.register`). Wysyła idempotentnie najpierw manifest uprawnień, potem szablony ról.
- **Sprawdzanie po stronie serwera (`src/server/permissions.ts`):**
  - Pamięć podręczna `createPermissionCache` (maks. 5 minut, jedna instancja na proces w `globalThis.__kivotasksPermissionCache`, odświeżana natychmiast po wzroście `authz_rev`).
  - `assertProductAccess` zwraca `403 PRODUCT_ACCESS_REQUIRED`, gdy `"kivotasks"` nie ma w `snapshot.products`.
  - `assertPermission` i `assertPermissionScope` sprawdzają dostęp do produktu oraz uprawnienie lub jego efektywny zakres (`ORGANIZATION` albo `LIMITED` z `unitIds` i `resourceIds`).
  - `capabilitiesFromSnapshot` wylicza `Capabilities` dla `GET /api/v1/me`.
- **Kanał zdarzeń Core (`src/server/event-feed.ts` i `src/instrumentation.ts`, ADR-0100):**
  - W środowisku Node.js `register()` uruchamia `startCoreEventPolling()`, gdy `KIVOTASKS_EVENT_FEED_INTERVAL_MS > 0` (domyślnie `5000` w `development`, `0` poza nim).
  - Po odebraniu `organization.permissions.changed` natychmiast wywołuje `invalidatePermissionCache({ organizationId, accountId })`.
  - Ograniczenie: pamięć podręczna uprawnień działa w pamięci pojedynczego procesu; przed skalowaniem na wiele instancji potrzebna będzie wspólna pamięć podręczna albo kursor na instancję.

## Powłoka aplikacji i widoki zadań (`apps/web/src/app/app/`)

- Korzysta wyłącznie z `@monorise-team/ui` i tokenów `@monorise-team/tokens` (ADR-0091), w tym mapowania nazwanych kolorów etykiet i statusów (`gray`, `blue`, `cyan`, `teal`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`) na zmienne motywu i paletę Tailwind bez wpisanych na sztywno kolorów.
- `layout.tsx` i `KivoTasksApp.tsx`: utrzymują wspólną sesję BFF (`LoadingView`, `SignedOutView`, `LoadErrorView`, `NoAccessView`), kontekst `KivoTasksContext` (profil `me`, `capabilities`, lista zespołów, odświeżanie widoków) oraz wspólne okno tworzenia zadania `CreateIssueDialog`.
- `KivoTasksShell.tsx`: `AppShell`, zwijany `SidebarShell` z listą zespołów, paleta poleceń `⌘K` (`CommandPalette` z asynchronicznym wyszukiwaniem `/api/v1/search` z pierwszeństwem trafień identyfikatora oraz poleceniami nawigacji, tworzenia zadania i przełączania trybu motywu) oraz `ShortcutsHelp` pod `?`.
- Trasy aplikacji pod `kivotasks.*` (przepisywane na `src/app/app/*`):
  - `/` i `/my-issues`: „Moje zadania” (zadania przypisane do zalogowanej osoby, ze wsparciem starszych fragmentów `#zespoly` i `#wyglad` z etapu 0),
  - `/teams`: lista zespołów z oknem „Utwórz zespół” z jednostek Core (`createTeams`),
  - `/teams/[key]`: lista zadań zespołu pogrupowana według kolejności kategorii statusów (`BACKLOG`, `UNSTARTED`, `STARTED`, `COMPLETED`, `CANCELED`), z filtrami w zapytaniu URL (status, osoba przypisana, etykieta, priorytet, wyszukiwanie, 5 trybów sortowania, „Pokaż zakończone”) i stronicowaniem kursorowym („Wczytaj więcej”),
  - `/teams/[key]/board`: tablica Kanban z jedną kolumną na aktywny status obiegu (`position`), przeciąganiem między kolumnami (`stateId`) i w kolumnie (`sortOrder` jako punkt środkowy sąsiadów), optymistyczną aktualizacją z wycofaniem przy błędzie oraz alternatywą klawiaturową w menu „Przenieś do…”,
  - `/teams/[key]/settings`: ustawienia zespołu dostępne z `manageTeams` (`SettingsLayout`: zmiana klucza zespołu, dodawanie/edycja/kolejność/archiwizacja statusów obiegu z zachowaniem komunikatów `409` z API oraz etykiety),
  - `/issue/[identifier]`: szczegóły zadania z edycją tytułu i opisu, panelem bocznym (status, priorytet w kolejności Linear `0..4`, osoba przypisana z członków zespołu, wiele etykiet, termin, wycena, zadanie nadrzędne), podzadaniami („Dodaj podzadanie”), powiązaniami (`BLOCKS`, `BLOCKED_BY`, `RELATED`, `DUPLICATE`) i usuwaniem z potwierdzeniem,
  - `/appearance`: ustawienia wyglądu (`AppearanceView` i `AppearanceControls`).
- Skróty klawiszowe (`shortcuts.ts`, ignorowane w polach tekstowych i oknach modalnych): `⌘K` / `Ctrl+K` (paleta poleceń), `c` (nowe zadanie, gdy `writeIssues`), `/` (fokus pola szukania/filtra), `g i` (Moje zadania), `g t` (Zespoły), `g b` (tablica bieżącego zespołu), `g w` (Wygląd), na liście `j` / `k` (poruszanie po wierszach) i `Enter` (otwarcie zadania), `?` (pomoc skrótów).
- Czysta logika widoków jest wydzielona do modułów `app-views.ts`, `issue-ui.ts`, `board-logic.ts` i `shortcuts.ts` oraz pokryta testami jednostkowymi w `apps/web/test/app-views.test.ts` i `apps/web/test/issue-views.test.ts`.

## Polecenia robocze

```bash
pnpm install && pnpm setup:env && pnpm db:up && pnpm db:migrate
pnpm permissions:register # rejestracja uprawnień i gotowych ról w MonoriseCore
pnpm openapi              # generowanie openapi/kivotasks-api.json
pnpm openapi:check        # weryfikacja aktualności openapi/kivotasks-api.json
pnpm dev                  # kivo.localhost:3500 i kivotasks.localhost:3500
pnpm check                # pełne kontrole (wymaga lokalnego PostgreSQL)
pnpm test                 # testy we wszystkich paczkach
pnpm shared:update        # aktualizacja paczek @monorise-team/* do jednej wersji
```
