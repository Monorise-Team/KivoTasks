# KivoTasks

Zadania i projekty Monorise w przeglądarce, wzorowane zakresem funkcji na Linear (ADR-0103). KivoTasks działa wyłącznie w przeglądarce, bez aplikacji mobilnej i desktopowej. Logowanie, firmy, zespoły (jednostki organizacyjne w Core) oraz uprawnienia pochodzą z MonoriseCore (`@monorise-team/auth`, `@monorise-team/sdk`), a baza danych działa na PostgreSQL z Prismą i RLS (ADR-0096).

## Adresy i części

| Część                                      | Co                                                                                            | Adres                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`apps/web`](apps/web)                     | Next.js: strona produktu i API `/api/v1` oraz pod drugim adresem aplikacja w przeglądarce     | `kivo.monorise.studio` (`kivo.localhost:3500`), `kivotasks.monorise.studio` (`kivotasks.localhost:3500`) |
| [`packages/contracts`](packages/contracts) | typy i schematy API, manifest uprawnień (`definePermissions`) i gotowe role produktu          |                                                                                                          |
| [`packages/client`](packages/client)       | typowany klient API dla przeglądarki                                                          |                                                                                                          |
| [`packages/db`](packages/db)               | baza `kivo_tasks` (PostgreSQL, port 5436): schemat Prisma, migracje, funkcje RLS i `withUser` |                                                                                                          |

## Stan etapów

Pierwsza wersja KivoTasks powstaje w pięciu etapach opisanych w karcie produktu (ADR-0103):

- **Etap 0 (szkielet, gotowy):** układ repozytorium, logowanie przez MonoriseCore (BFF), `GET /api/v1/me` z `capabilities`, rejestracja uprawnień `kivotasks.*` i gotowych ról w Core, sprawdzanie dostępu (`Entitlement` i `AppAccess`), kanał zdarzeń Core (ADR-0100), powłoka aplikacji z paskiem bocznym, paletą `⌘K` i skrótami klawiszowymi z `@monorise-team/ui`, opis OpenAPI 3.1 oraz testy kontraktu i izolacji firm.
- **Etap 1 (zadania, gotowy):**
  - **Etap 1a (model danych i API, gotowy):** zespoły oparte na jednostkach Core z krótkimi kluczami, domyślne i edytowalne statusy obiegu, etykiety zespołów, zadania z atomową numeracją (`KEY-number`), priorytetami, przypisaniem członków zespołu, podzadaniami bez cykli, relacjami (`BLOCKS`/`BLOCKED_BY`, `RELATED`, `DUPLICATE`), stronicowaniem kursorowym, filtrami, sortowaniem i wyszukiwaniem pełnotekstowym (`tsvector` + GIN) z RLS na wszystkich tabelach.
  - **Etap 1b (interfejs, gotowy):** lista zadań zespołu (`/teams/[key]`) i „Moje zadania” (`/my-issues`) z filtrami w URL i stronicowaniem kursorowym, tablica Kanban (`/teams/[key]/board`) z przeciąganiem i menu klawiaturowym „Przenieś do…”, szczegóły zadania (`/issue/[identifier]`) z podzadaniami i relacjami, okno tworzenia zadania, lista i ustawienia zespołów (`/teams`, `/teams/[key]/settings`), paleta `⌘K` z wyszukiwaniem zadań oraz skróty klawiszowe (`c`, `/`, `g i`, `g t`, `g b`, `j`/`k`/`Enter`, `?`).
- **Etap 2 (współpraca):**
  - **Etap 2a (komentarze, historia i skrzynka, gotowy):** komentarze Markdown z `@wzmiankami` członków zespołu (autouzupełnianie klawiaturą, walidacja przez Core Directory) i reakcjami emoji (`👍 ❤️ 🎉 😄 👀 🚀`), automatyczna historia zmian zadania (`issue_events`) połączona chronologicznie z komentarzami, obserwowanie zadań (automatyczne i ręczne) oraz skrzynka powiadomień (`/inbox`, licznik nieprzeczytanych w pasku bocznym, skrót `g n`, wpis „Skrzynka” w `⌘K`).
  - **Etap 2b (załączniki, gotowy):** załączniki plików w zadaniach przechowywane w magazynie zgodnym z S3 (lokalnie MinIO, w produkcji Amazon S3), wysyłane i pobierane wyłącznie przez serwer KivoTasks z rozpoznawaniem typu po zawartości, nagłówkami bezpieczeństwa, limitem pojedynczego pliku (25 MB) i limitem miejsca firmy (1 GB), podglądem obrazów oraz wstawianiem w opisie zadania i komentarzach.
- **Etap 3 (planowanie):** projekty ponad zespołami, cykle, triage, własne widoki, oś czasu.
- **Etap 4 (przegląd):** mapy drogowe, inicjatywy, statystyki, szablony zadań, SLA, archiwum, import i integracje.

## Uruchomienie lokalne

Potrzebne: Node.js 24 (`.nvmrc`), pnpm 11, Docker (lokalna baza PostgreSQL i magazyn plików MinIO) oraz działający lokalnie [MonoriseCore](https://github.com/Monorise-Team/MonoriseCore) (logowanie na `localhost:3100` i Core API na `localhost:3200`).

```bash
# raz: dostęp do paczek @monorise-team/* w GitHub Packages
gh auth refresh -h github.com -s read:packages
export GITHUB_PACKAGES_TOKEN=$(gh auth token)

# raz, w MonoriseCore: klient OAuth kivotasks-web i sekrety (apps/auth/.data/oauth-clients.json)
pnpm oauth:seed

pnpm install && pnpm setup:env && pnpm db:up && pnpm db:migrate && pnpm storage:up
pnpm permissions:register # rejestracja uprawnień kivotasks.* i gotowych ról w MonoriseCore
pnpm dev                  # http://kivo.localhost:3500 (strona i API) i http://kivotasks.localhost:3500 (aplikacja)
```

Jeśli repozytorium albo git worktree nie leży obok katalogu `MonoriseCore`, wskaż plik z sekretami OAuth Core zmienną `CORE_OAUTH_SECRETS_FILE`:

```bash
CORE_OAUTH_SECRETS_FILE=/sciezka/do/MonoriseCore/apps/auth/.data/oauth-clients.json pnpm setup:env
```

Logowanie: KivoTasks korzysta z kont Monorise (BFF w ciasteczku `HttpOnly`), więc obok musi działać MonoriseCore.

## Uprawnienia, role i dostęp

KivoTasks deklaruje uprawnienia w `packages/contracts/src/permissions.ts` (`definePermissions("kivotasks", ...)`):

- `kivotasks.issues.read`: podgląd zadań w dostępnych zespołach i projektach,
- `kivotasks.issues.write`: tworzenie i edycja zadań w dostępnych zespołach,
- `kivotasks.teams.manage`: ustawienia zespołów (klucze, statusy i etykiety),
- `kivotasks.projects.manage`: tworzenie i zarządzanie projektami.

Gotowe role (`KIVOTASKS_ROLE_TEMPLATES`, zakresy `UNIT`, `ORGANIZATION` albo `RESOURCE` w Core):

- **Członek KivoTasks** (`kivotasks.member`): `kivotasks.issues.read`, `kivotasks.issues.write`,
- **Administrator KivoTasks** (`kivotasks.admin`): wszystkie cztery uprawnienia,
- **Gość** (`kivotasks.guest`): `kivotasks.issues.read`.

Aby korzystać z KivoTasks, firma potrzebuje aktywnego dostępu do produktu (`Entitlement`), konto pracownika włączonej aplikacji (`AppAccess`), a osoba odpowiedniej roli (Owner firmy ma pełny dostęp po włączeniu `Entitlement`). Brak produktu w migawce Core daje `403 PRODUCT_ACCESS_REQUIRED`, a brak konkretnego uprawnienia `403 PERMISSION_DENIED`.

### Konfiguracja lokalna w MonoriseCore

Po `pnpm oauth:seed` i uruchomieniu MonoriseCore oraz `pnpm permissions:register` w KivoTasks:

```bash
# W MonoriseCore: przyznaj firmie dostęp do produktu kivotasks
pnpm entitlement:grant -- --organization acme.test --product kivotasks
```

Następnie w Core API (`http://localhost:3200/core/v1`, z tokenem Ownera firmy) włącz aplikację osobie (`POST /core/v1/app-access` z `{ "accountId": "<uuid>", "product": "kivotasks" }`), sprawdź role (`GET /core/v1/roles?product=kivotasks`) i przypisz rolę (`POST /core/v1/role-assignments`).

### Kanał zdarzeń Core i baza danych

- **Kanał zdarzeń Core (ADR-0100):** `apps/web/src/instrumentation.ts` uruchamia odpytywanie `GET /core/v1/products/kivotasks/events` (`KIVOTASKS_EVENT_FEED_INTERVAL_MS`, domyślnie `5000` ms w `development`, `0` poza nim). Zdarzenie `organization.permissions.changed` natychmiast unieważnia pamięć podręczną uprawnień dla wskazanej firmy i konta.
- **Baza danych i magazyn plików:** PostgreSQL na porcie `5436` (kontener `kivo-tasks-database`) oraz MinIO zgodny z S3 na portach `9036` (API) i `9037` (konsola, kontener `kivo-tasks-file-storage`, `pnpm storage:up`). Baza zawiera tabele techniczne (`auth.sessions`, `public.event_feed_cursors`, `public.processed_events`), funkcje pomocnicze RLS (`public.current_organization_id()`, `public.current_account_id()`), tabele domenowe etapu 1a (`teams`, `workflow_states`, `labels`, `issues`, `issue_labels`, `issue_relations`), tabele współpracy etapu 2a (`issue_comments`, `comment_mentions`, `comment_reactions`, `issue_events`, `issue_subscribers`, `inbox_items`) oraz tabelę załączników etapu 2b (`issue_attachments`) z wymuszonym RLS (`ENABLE` + `FORCE`), złożonymi kluczami obcymi i testami separacji firm.

## Polecenia i kontrole

```bash
pnpm install && pnpm setup:env && pnpm db:up && pnpm db:migrate && pnpm storage:up
pnpm permissions:register # rejestracja manifestu uprawnień i gotowych ról w MonoriseCore
pnpm dev                  # lokalny serwer na kivo.localhost:3500 i kivotasks.localhost:3500
pnpm openapi              # generuje openapi/kivotasks-api.json z kodu
pnpm openapi:check        # sprawdza aktualność openapi/kivotasks-api.json
pnpm check                # formatowanie, zgodność wersji, OpenAPI, lint, typy, testy i build (wymaga pnpm db:up i pnpm storage:up)
pnpm test                 # testy wszystkich paczek i aplikacji
```

## Wersje

Jedna wersja wszystkich części (ADR-0087): Release Please wylicza ją z commitów i aktualizuje `package.json` wszystkich części, a `pnpm check:versions` odrzuca rozbieżności. Paczki `@monorise-team/*` mają zawsze jedną, dokładną wersję (aktualizacja: Renovate albo `pnpm shared:update`).

Szczegóły techniczne dla agentów i programistów: [`docs/agents/architecture.md`](docs/agents/architecture.md), [`docs/agents/database.md`](docs/agents/database.md), [`docs/agents/api.md`](docs/agents/api.md). Zasady współpracy: [CONTRIBUTING.md organizacji](https://github.com/Monorise-Team/.github/blob/main/CONTRIBUTING.md).
