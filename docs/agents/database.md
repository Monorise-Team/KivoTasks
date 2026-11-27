# Baza danych KivoTasks

KivoTasks korzysta z bazy PostgreSQL 17 i Prisma 7 w paczce `packages/db` (`@kivotasks/db`, ADR-0096). Lokalnie baza działa w Dockerze na porcie `5436` (kontener `kivo-tasks-database`), żeby nie kolidować z Core (`5433`), AvenMail (`5434`) i TimoTime (`5435`).

## Role i bazy (`docker/postgres-init.sql`)

- **`kivo_tasks_owner`**: właściciel baz `kivo_tasks` oraz `kivo_tasks_test`, uruchamia migracje (`packages/db/.env`, `pnpm db:migrate`).
- **`kivo_tasks_app`**: rola aplikacji (`apps/web/.env.local`), nie jest właścicielem tabel, nie ma `SUPERUSER` ani `BYPASSRLS`. Ma `USAGE` na schematach `public` i `auth` oraz `SELECT, INSERT, UPDATE, DELETE` na tabelach (z wyłączeniem `public._prisma_migrations`, na której uprawnienia są cofnięte).

## Tabele i migracje (`packages/db/prisma/schema.prisma`)

### Migracja początkowa (`20261126200000_init`)

| Tabela               | Schemat  | RLS | Przeznaczenie                                                                                                                                |
| -------------------- | -------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`           | `auth`   | Nie | Zaszyfrowane sesje przeglądarki (BFF, `@monorise-team/auth`). Serwer szuka ich po skrócie identyfikatora z ciasteczka przed poznaniem firmy. |
| `event_feed_cursors` | `public` | Nie | Ostatni przetworzony numer `sequence` dla kanału zdarzeń Core (`id = "core"`). Bez danych firmowych.                                         |
| `processed_events`   | `public` | Nie | Deduplikacja zdarzeń `(consumer, event_id)` dla odbiorcy `@monorise-team/events`. Bez danych firmowych.                                      |

### Migracja domeny zadań etapu 1a (`20261126210000_issues_domain`)

Definiuje typy wyliczeniowe `WorkflowStateCategory` (`BACKLOG`, `UNSTARTED`, `STARTED`, `COMPLETED`, `CANCELED`) i `IssueRelationType` (`BLOCKS`, `RELATED`, `DUPLICATE`) oraz sześć tabel domenowych z wymuszonym RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY`):

| Tabela            | Schemat  | RLS | Przeznaczenie i najważniejsze ograniczenia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | -------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teams`           | `public` | Tak | Zespół oparty na jednostce Core (`id` = UUID jednostki Core), unikalny klucz `key` (`^[A-Z]{2,5}$`) w firmie, buforowana `name`, licznik `next_issue_number` (domyślnie `1`) inkrementowany atomowo.                                                                                                                                                                                                                                                                                                                              |
| `workflow_states` | `public` | Tak | Statusy obiegu zespołu (`name` 1–40, `category`, `color`, `position`, `archived_at`). Nowy zespół otrzymuje 6 domyślnych statusów.                                                                                                                                                                                                                                                                                                                                                                                                |
| `labels`          | `public` | Tak | Etykiety zespołu (`name` 1–40, `color`, `archived_at`). Częściowy indeks unikalny `(team_id, lower(name)) WHERE archived_at IS NULL` pilnuje unikalności bez rozróżniania wielkości liter.                                                                                                                                                                                                                                                                                                                                        |
| `issues`          | `public` | Tak | Zadania zespołu (`id` UUID v7, unikalny `(team_id, number)`, `title` 1–255, `description` do 50 000, `priority` 0–4, `due_date`, `estimate` 0–100, `parent_id`, `sort_order`, `started_at`/`completed_at`/`canceled_at`, miękkie usuwanie `deleted_at`). Zawiera generowaną kolumnę `search_vector` (`tsvector`, konfiguracja `'simple'`, tytuł waga `A`, opis waga `B`, interpunkcja ASCII zamieniona na spacje, żeby „MAG-2” dało słowa `mag` i `2` jak w zapytaniu) z indeksem GIN oraz indeksy pod filtry i sortowanie listy. |
| `issue_labels`    | `public` | Tak | Powiązania M:N zadań z etykietami tego samego zespołu (`PRIMARY KEY (issue_id, label_id)`, kolumna `team_id`, żeby klucz obcy wymuszał ten sam zespół).                                                                                                                                                                                                                                                                                                                                                                           |
| `issue_relations` | `public` | Tak | Relacje między zadaniami w obrębie firmy (`BLOCKS`, `RELATED`, `DUPLICATE`), zakaz autorelacji (`issue_id <> related_issue_id`) i unikalność `(issue_id, related_issue_id, type)`; `RELATED` jest symetryczne, więc osobny indeks unikalny na parze `(LEAST, GREATEST)` blokuje odwrotny duplikat.                                                                                                                                                                                                                                |

Atomowe przydzielanie numeru zadania odbywa się w tej samej transakcji `withUser` przez `UPDATE "public"."teams" SET "next_issue_number" = "next_issue_number" + 1 ... RETURNING ("next_issue_number" - 1) AS "number"`, co eliminuje kolizje i luki przy równoległych żądaniach.

Klucze obce są złożone i zawsze zawierają `organization_id` (sprawdzanie klucza obcego omija RLS, więc jednokolumnowy klucz pozwoliłby wierszowi jednej firmy wskazać wiersz innej). Status, rodzic i etykiety zadania mają też `team_id`, więc baza sama pilnuje, że należą do zespołu zadania. Rodzic ma `ON DELETE RESTRICT`, bo zadania usuwamy tylko miękko.

Blokady przeciw wyścigom (READ COMMITTED):

- Aktualizacja zadania (`updateIssue`) bierze blokadę wiersza `FOR UPDATE OF i` na aktywnym zadaniu przed odczytem stanu „przed” (przy zmianie rodzica poprzedzoną blokadą `issue_hierarchy:<teamId>` w tej samej kolejności co `softDeleteIssue`), dzięki czemu równoległe aktualizacje nie tworzą duplikatów zdarzeń historii, wpisów `ASSIGNED`, e-maili ani konfliktów `issue_labels`, a równolegle usunięte zadanie zwraca `404`.
- Przypisanie statusu lub etykiet (`createIssue`, `updateIssue`) czyta ich wiersze `FOR SHARE` z `archived_at IS NULL`; archiwizacja (`deleteWorkflowState`, `deleteLabel`) bierze `FOR UPDATE` i dopiero potem liczy zadania. Sam klucz obcy bierze tylko `FOR KEY SHARE`, które nie koliduje ze zmianą `archived_at`.
- Zmiany hierarchii (nowe podzadanie, zmiana rodzica, miękkie usunięcie) biorą blokadę doradczą zespołu `issue_hierarchy:<teamId>`; usunięcie zadania odpina jego podzadania (`parent_id = NULL`).
- Nowa relacja blokuje oba zadania `FOR SHARE` w swojej transakcji i zwraca `404`, gdy któreś usunięto w międzyczasie.
- Kolumna `search_vector` zamienia interpunkcję ASCII na spacje, więc dzieli tekst tak samo jak zapytanie (tylko litery i cyfry).

### Migracja współpracy etapu 2a (`20261127050000_collaboration`)

Definiuje typy wyliczeniowe `IssueEventType` (`CREATED`, `TITLE_CHANGED`, `DESCRIPTION_CHANGED`, `STATE_CHANGED`, `PRIORITY_CHANGED`, `ASSIGNEE_CHANGED`, `LABELS_CHANGED`, `DUE_DATE_CHANGED`, `ESTIMATE_CHANGED`, `PARENT_CHANGED`, `RELATION_ADDED`, `RELATION_REMOVED`, `DELETED`) i `InboxItemKind` (`ASSIGNED`, `MENTIONED`, `COMMENTED`) oraz sześć tabel domenowych z wymuszonym RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY`), uprawnieniami dla `kivo_tasks_app` i złożonymi kluczami obcymi. Na końcu migracji znajduje się idempotentny backfill `issue_subscribers` dla istniejących aktywnych zadań (twórca i bieżąca osoba przypisana, z pominięciem `deleted_at IS NOT NULL`), osłonięty tymczasowym `NO FORCE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY` na `issues` i `issue_subscribers`:

| Tabela              | Schemat  | RLS | Przeznaczenie i najważniejsze ograniczenia                                                                                                                                                                                                                                                                      |
| ------------------- | -------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue_comments`    | `public` | Tak | Komentarze Markdown (`id` UUID v7, `body` 1–10 000 znaków, `edited_at`, miękkie usuwanie `deleted_at`). Złożony FK `(organization_id, team_id, issue_id) -> issues(organization_id, team_id, id)` blokuje odwołania między firmami i między zespołami.                                                          |
| `comment_mentions`  | `public` | Tak | Zweryfikowane wzmianki członków zespołu w komentarzach (`PRIMARY KEY (comment_id, account_id)`). Złożony FK `(organization_id, comment_id) -> issue_comments(organization_id, id)`.                                                                                                                             |
| `comment_reactions` | `public` | Tak | Reakcje emoji na komentarzach (`id` UUID v7, `CHECK (emoji IN ('👍', '❤️', '🎉', '😄', '👀', '🚀'))`, unikalne `(comment_id, account_id, emoji)`). Złożony FK `(organization_id, comment_id) -> issue_comments(organization_id, id)`.                                                                           |
| `issue_events`      | `public` | Tak | Historia zmian zadania (`id` UUID v7, `type`, małe obiekty JSONB `before`/`after` — nigdy pełne treści opisu, jedynie flaga `hasDescription`). Złożony FK `(organization_id, team_id, issue_id) -> issues(organization_id, team_id, id)`. Zapisywane w tej samej transakcji.                                    |
| `issue_subscribers` | `public` | Tak | Obserwujący zadanie (`PRIMARY KEY (issue_id, account_id)`). Złożony FK `(organization_id, issue_id) -> issues(organization_id, id)`. Automatycznie dodawani: twórca, osoba przypisana, komentujący i wspomniani.                                                                                                |
| `inbox_items`       | `public` | Tak | Wpisy skrzynki powiadomień (`id` UUID v7, `kind`, `recipient_account_id <> actor_account_id`, `comment_id` opcjonalny, `read_at`, `archived_at`). Złożone FK `(organization_id, issue_id)` i `(organization_id, issue_id, comment_id)` oraz indeksy częściowe dla nieprzeczytanych i aktywnych wpisów odbiorcy. |

## Funkcje pomocnicze RLS i `withUser`

Migracja początkowa definiuje dwie stabilne funkcje SQL odczytujące zmienne lokalne transakcji:

- `public.current_organization_id() RETURNS uuid` (czyta `app.organization_id`),
- `public.current_account_id() RETURNS uuid` (czyta `app.account_id`).

Każda tabela domenowa ma politykę `organization_isolation` z warunkami `USING ("organization_id" = "public"."current_organization_id"())` oraz `WITH CHECK ("organization_id" = "public"."current_organization_id"())`.

Po stronie TypeScript zmienne ustawia wyłącznie `withUser(db, actor, fn)` w `packages/db/src/index.ts`:

- waliduje format UUID w `actor.organizationId` i `actor.accountId` przed otwarciem transakcji,
- uruchamia `SELECT set_config('app.organization_id', ..., true), set_config('app.account_id', ..., true)` wewnątrz `db.$transaction`,
- po zakończeniu transakcji zmienne znikają i nie przeciekają na inne połączenia z puli.

## Zasady dla kolejnych migracji

1. Edytuj `packages/db/prisma/schema.prisma` i wygeneruj nową migrację (`pnpm --filter @kivotasks/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`) do nowego katalogu w `packages/db/prisma/migrations/`.
2. Każda tabela z danymi osób albo firm musi dostać w tej samej migracji `ENABLE` + `FORCE ROW LEVEL SECURITY`, polityki `USING` i `WITH CHECK` korzystające z `public.current_organization_id()` oraz uprawnienia dla roli `kivo_tasks_app`.
3. Dodaj testy izolacji w `packages/db/test/rls.test.ts` i `apps/web/test/tenant-isolation.test.ts` (`checkTenantIsolation` z `@monorise-team/testing`).
4. Zmiany w strukturze bazy scalamy dopiero po zgodzie właściciela projektu.

## Testy bazy

- `packages/db/test/rls.test.ts`: sprawdza uprawnienia roli `kivo_tasks_app`, wymuszone RLS (`relrowsecurity` i `relforcerowsecurity`) oraz izolację odczytu i zapisu na wszystkich 12 tabelach domenowych (etap 1a i etap 2a), równoległe atomowe przydzielanie numerów zadań bez kolizji i luk (także po wycofaniu transakcji), złożone klucze obce (odwołania między firmami, między zespołami i między zadaniami kończą się błędem klucza obcego), ograniczenia `CHECK` (zestaw emoji, zakaz powiadomienia dla sprawcy), indeks pary `RELATED`, tabele techniczne oraz odmowę dostępu do `public._prisma_migrations`.
- `apps/web/test/tenant-isolation.test.ts`: sprawdza separację między firmami na wszystkich 12 tabelach domenowych (etapy 1a i 2a) przez `checkTenantIsolation` z `@monorise-team/testing` oraz równoległą numerację i blokady archiwizacji statusu przez `prismaIssuesStore`. Testy tras (`issues-api`, `teams-api`, `collaboration-api`) też działają na tej bazie, bez magazynu w pamięci.
- Oba pliki wymagają działającego PostgreSQL (`pnpm db:up && pnpm db:migrate`).
