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
  - `getMachineCoreClient()`: token maszynowy OAuth 2.1 (`client_credentials`, zakresy `core:permissions.read core:directory.read core:events.read core:notifications.send`), buforowany do 30 s przed wygaśnięciem z pojedynczym odświeżaniem w locie (`single-flight`).
  - Oba klienty ponawiają żądania przy krótkich błędach sieci i statusach `429`, `502`, `503`, `504` (`DEFAULT_CORE_RETRY`: 3 próby, 200 do 2000 ms). Przy trwałej awarii serwer odmawia bezpiecznie kodem `503` (fail-closed), z wyjątkiem wywołań best-effort (odświeżanie nazw zespołów i powiadomienia e-mail).
- **Powiadomienia e-mail (`src/server/notifications.ts`, ADR-0048):**
  - Po zapisaniu nowego zadania z osobą przypisaną (`POST /api/v1/issues`) albo zmianie osoby przypisanej na inną (`PATCH /api/v1/issues/{issueId}`), jeśli przypisana osoba nie jest sprawcą zmiany, serwer zleca w Core powiadomienie `POST /core/v1/organizations/{organizationId}/notifications` (`sendNotification` w `@monorise-team/sdk`) w kategorii `kivotasks.assignments`.
  - Link `actionUrl` budowany jest na originie `config.appUrl` (`KIVOTASKS_APP_URL`), np. `${origin}/issue/MAG-3`. Nazwa osoby przypisującej pochodzi z sesji BFF lub katalogu zespołu pobranego przy walidacji; bez niej zdanie o osobie przypisującej jest pomijane.
  - Wywołanie działa best-effort z krótkim limitem czasu (`DEFAULT_NOTIFICATION_TIMEOUT_MS = 3000` ms), deterministycznym nagłówkiem `Idempotency-Key` (`kivotasks:issue-assigned:<issueId>:<assigneeAccountId>:<updatedAt>`) i polityką ponawiania SDK; błędy są logowane jako ostrzeżenie bez danych osobowych ani tokenów i nie przerywają żądania użytkownika.

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

## Magazyn plików i załączniki (etap 2b, ADR-0103)

- **Magazyn zgodny z S3 (`src/server/file-storage.ts`, `@aws-sdk/client-s3`):** jedna instancja `S3Client` na proces (w `globalThis.__kivotasksS3Client`). Lokalnie używa MinIO w Dockerze (`pnpm storage:up`, porty `9036` API i `9037` konsola, zasobniki `kivo-tasks-attachments` i `kivo-tasks-attachments-test`), w produkcji Amazon S3 (pusty `KIVOTASKS_S3_ENDPOINT` i domyślny łańcuch poświadczeń AWS / rola IAM).
- **Klucz obiektu:** wyłącznie `organizations/<organizationId>/issues/<issueId>/attachments/<attachmentId>` (nigdy nazwa pliku od użytkownika). Błędy sieci i S3 mapowane są na `503 INTERNAL_ERROR` („Magazyn plików jest chwilowo niedostępny”), a brak obiektu przy pobraniu na `404 NOT_FOUND`.
- **Wyłącznie przez serwer KivoTasks:** pliki są wysyłane (`POST /api/v1/issues/{issueId}/attachments`) i strumieniowane (`GET /api/v1/attachments/{attachmentId}/content`) wyłącznie przez serwer API z pełnym sprawdzeniem uwierzytelnienia, dostępu do produktu, dostępu do zespołu i aktywności zadania przy każdym pobraniu.
- **Rozpoznawanie typu i bezpieczeństwo nagłówków (`src/server/attachment-helpers.ts`):**
  - Typ MIME jest ustalany wyłącznie po bajtach magicznych (PNG, JPEG, GIF87a/GIF89a, WebP); wszystko inne (w tym SVG, HTML, PDF) dostaje `application/octet-stream`.
  - Nazwy plików przechodzą normalizację NFC, odcięcie ścieżki, usunięcie znaków sterujących i bidi, zbicie białych znaków, usunięcie wiodących kropek i bezpieczne przycięcie do 255 jednostek UTF-16 (domyślnie `plik`).
  - Odpowiedź `/content` ustawia `Content-Disposition` (`inline` wyłącznie dla 4 formatów obrazów, `attachment` dla pozostałych, z `filename` ASCII i `filename*=UTF-8''` RFC 5987), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, no-cache` oraz `ETag: "<attachmentId>"` (`If-None-Match` -> `304`).
- **Limity:** pojedynczy plik maks. `KIVOTASKS_ATTACHMENT_MAX_BYTES` (domyślnie `26214400`, 25 MB; w `apps/web/next.config.ts` ustawiono `experimental.proxyClientMaxBodySize: "27mb"`, powyżej limitu pliku z narzutem multipart), a limit firmy to `KIVOTASKS_STORAGE_QUOTA_BYTES` (domyślnie `1073741824`, 1 GB, do czasu limitów planów w Core, ADR-0058).

## Powłoka aplikacji i widoki zadań (`apps/web/src/app/app/`)

- Korzysta wyłącznie z `@monorise-team/ui` i tokenów `@monorise-team/tokens` (ADR-0091), w tym mapowania nazwanych kolorów etykiet i statusów (`gray`, `blue`, `cyan`, `teal`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`) na zmienne motywu i paletę Tailwind bez wpisanych na sztywno kolorów.
- `layout.tsx` i `KivoTasksApp.tsx`: utrzymują wspólną sesję BFF (`LoadingView`, `SignedOutView`, `LoadErrorView`, `NoAccessView`), kontekst `KivoTasksContext` (profil `me`, `capabilities`, lista zespołów, odświeżanie widoków oraz odpytywanie licznika nieprzeczytanych `/api/v1/inbox/unread-count` co 60 s i po powrocie fokusu okna) oraz wspólne okno tworzenia zadania `CreateIssueDialog`.
- `KivoTasksShell.tsx`: `AppShell`, zwijany `SidebarShell` ze „Skrzynką” (z licznikiem nieprzeczytanych) i listą zespołów, paleta poleceń `⌘K` (`CommandPalette` z asynchronicznym wyszukiwaniem `/api/v1/search` z pierwszeństwem trafień identyfikatora oraz poleceniami nawigacji w tym „Skrzynka”, tworzenia zadania i przełączania trybu motywu) oraz `ShortcutsHelp` pod `?`.
- Trasy aplikacji pod `kivotasks.*` (przepisywane na `src/app/app/*`):
  - `/inbox`: skrzynka powiadomień zalogowanej osoby (`InboxView`: filtr „Nieprzeczytane” / „Wszystkie”, wyróżnienie nieprzeczytanych, akcje otwarcia, oznaczenia jako przeczytane/nieprzeczytane, archiwizacji, „Oznacz wszystkie jako przeczytane” i stronicowanie kursorowe),
  - `/` i `/my-issues`: „Moje zadania” (zadania przypisane do zalogowanej osoby, ze wsparciem starszych fragmentów `#zespoly` i `#wyglad` z etapu 0),
  - `/teams`: lista zespołów z oknem „Utwórz zespół” z jednostek Core (`createTeams`),
  - `/teams/[key]`: lista zadań zespołu pogrupowana według kolejności kategorii statusów (`BACKLOG`, `UNSTARTED`, `STARTED`, `COMPLETED`, `CANCELED`), z filtrami w zapytaniu URL (status, osoba przypisana, etykieta, priorytet, wyszukiwanie, 5 trybów sortowania, „Pokaż zakończone”) i stronicowaniem kursorowym („Wczytaj więcej”),
  - `/teams/[key]/board`: tablica Kanban z jedną kolumną na aktywny status obiegu (`position`), przeciąganiem między kolumnami (`stateId`) i w kolumnie (`sortOrder` jako punkt środkowy sąsiadów), optymistyczną aktualizacją z wycofaniem przy błędzie oraz alternatywą klawiaturową w menu „Przenieś do…”,
  - `/teams/[key]/settings`: ustawienia zespołu dostępne z `manageTeams` (`SettingsLayout`: zmiana klucza zespołu, dodawanie/edycja/kolejność/archiwizacja statusów obiegu z zachowaniem komunikatów `409` z API oraz etykiety),
  - `/issue/[identifier]`: szczegóły zadania z przyciskiem „Obserwuj” / „Przestań obserwować”, edycją tytułu i opisu (z przyciskiem „Załącz plik” i podglądem Markdown), sekcją „Załączniki” (`IssueAttachmentsSection`: lista z miniaturami obrazów powiększanymi w oknie dialogowym, pobieraniem, usuwaniem z potwierdzeniem, przyciskiem „Dodaj pliki”, przeciąganiem i upuszczaniem oraz paskiem limitu miejsca firmy), panelem bocznym (status, priorytet w kolejności Linear `0..4`, osoba przypisana z członków zespołu, wiele etykiet, termin, szacunek, zadanie nadrzędne), podzadaniami („Dodaj podzadanie”), powiązaniami (`BLOCKS`, `BLOCKED_BY`, `RELATED`, `DUPLICATE`), sekcją „Aktywność” (`IssueActivitySection`: historia zdarzeń w tym `ATTACHMENT_ADDED`/`ATTACHMENT_REMOVED` i komentarze Markdown bez surowego HTML, obrazy wyłącznie dla `/api/v1/attachments/<uuid>/content`, linki z `rel="noopener noreferrer"`, edytor `CommentEditor` z autouzupełnianiem `@`, przyciskiem „Załącz plik” i wklejaniem obrazów ze schowka, edycją/usuwaniem komentarzy i reakcjami emoji `👍 ❤️ 🎉 😄 👀 🚀`) oraz usuwaniem zadania z potwierdzeniem,
  - `/appearance`: ustawienia wyglądu (`AppearanceView` i `AppearanceControls`).
- Skróty klawiszowe (`shortcuts.ts`, ignorowane w polach tekstowych i oknach modalnych): `⌘K` / `Ctrl+K` (paleta poleceń), `c` (nowe zadanie, gdy `writeIssues`), `/` (fokus pola szukania/filtra), `g n` (Skrzynka), `g i` (Moje zadania), `g t` (Zespoły), `g b` (tablica bieżącego zespołu), `g w` (Wygląd), na liście `j` / `k` (poruszanie po wierszach) i `Enter` (otwarcie zadania), `?` (pomoc skrótów).
- Czysta logika widoków jest wydzielona do modułów `app-views.ts`, `issue-ui.ts`, `board-logic.ts`, `shortcuts.ts`, `markdown.ts`, `mention-autocomplete.ts`, `activity-ui.ts` i `attachments-ui.ts` oraz pokryta testami jednostkowymi w `apps/web/test/app-views.test.ts`, `apps/web/test/issue-views.test.ts`, `apps/web/test/collaboration-helpers.test.ts` i `apps/web/test/attachments-helpers.test.ts`.

## Polecenia robocze

```bash
pnpm install && pnpm setup:env && pnpm db:up && pnpm db:migrate && pnpm storage:up
pnpm permissions:register # rejestracja uprawnień i gotowych ról w MonoriseCore
pnpm openapi              # generowanie openapi/kivotasks-api.json
pnpm openapi:check        # sprawdza aktualność openapi/kivotasks-api.json
pnpm dev                  # kivo.localhost:3500 i kivotasks.localhost:3500
pnpm check                # pełne kontrole (wymaga lokalnego PostgreSQL i MinIO)
pnpm test                 # testy we wszystkich paczkach
pnpm shared:update        # aktualizacja paczek @monorise-team/* do jednej wersji
```
