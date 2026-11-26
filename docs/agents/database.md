# Baza danych KivoTasks

KivoTasks korzysta z bazy PostgreSQL 17 i Prisma 7 w paczce `packages/db` (`@kivotasks/db`, ADR-0096). Lokalnie baza działa w Dockerze na porcie `5436` (kontener `kivo-tasks-postgres-1`), żeby nie kolidować z Core (`5433`), AvenMail (`5434`) i TimoTime (`5435`).

## Role i bazy (`docker/postgres-init.sql`)

- **`kivo_tasks_owner`**: właściciel baz `kivo_tasks` oraz `kivo_tasks_test`, uruchamia migracje (`packages/db/.env`, `pnpm db:migrate`).
- **`kivo_tasks_app`**: rola aplikacji (`apps/web/.env.local`), nie jest właścicielem tabel, nie ma `SUPERUSER` ani `BYPASSRLS`. Ma `USAGE` na schematach `public` i `auth` oraz `SELECT, INSERT, UPDATE, DELETE` na tabelach (z wyłączeniem `public._prisma_migrations`, na której uprawnienia są cofnięte).

## Tabele w etapie 0 (`packages/db/prisma/schema.prisma`)

Początkowa migracja (`packages/db/prisma/migrations/20261126200000_init/migration.sql`) zakłada wyłącznie tabele techniczne etapu 0 i infrastrukturę RLS:

| Tabela               | Schemat  | RLS | Przeznaczenie                                                                                                                                |
| -------------------- | -------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`           | `auth`   | Nie | Zaszyfrowane sesje przeglądarki (BFF, `@monorise-team/auth`). Serwer szuka ich po skrócie identyfikatora z ciasteczka przed poznaniem firmy. |
| `event_feed_cursors` | `public` | Nie | Ostatni przetworzony numer `sequence` dla kanału zdarzeń Core (`id = "core"`). Bez danych firmowych.                                         |
| `processed_events`   | `public` | Nie | Deduplikacja zdarzeń `(consumer, event_id)` dla odbiorcy `@monorise-team/events`. Bez danych firmowych.                                      |

## Funkcje pomocnicze RLS i `withUser`

Migracja początkowa definiuje dwie stabilne funkcje SQL odczytujące zmienne lokalne transakcji:

- `public.current_organization_id() RETURNS uuid` (czyta `app.organization_id`),
- `public.current_account_id() RETURNS uuid` (czyta `app.account_id`).

Po stronie TypeScript ustawia je wyłącznie `withUser(db, actor, fn)` w `packages/db/src/index.ts`:

- waliduje format UUID w `actor.organizationId` i `actor.accountId` przed otwarciem transakcji,
- uruchamia `SELECT set_config('app.organization_id', ..., true), set_config('app.account_id', ..., true)` wewnątrz `db.$transaction`,
- po zakończeniu transakcji zmienne znikają i nie przeciekają na inne połączenia z puli.

## Zasady dla nowych tabel (od etapu 1)

1. Edytuj `packages/db/prisma/schema.prisma` i wygeneruj nową migrację (`pnpm --filter @kivotasks/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`) do nowego katalogu w `packages/db/prisma/migrations/`.
2. Każda tabela z danymi osób albo firm musi dostać w tej samej migracji:
   - `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`
   - `ALTER TABLE ... FORCE ROW LEVEL SECURITY;`
   - polityki `USING` i `WITH CHECK` korzystające z `public.current_organization_id()` (oraz ewentualnie `public.current_account_id()` lub zakresu jednostek/zasobów).
3. Dodaj testy izolacji w `packages/db/test/rls.test.ts` i `apps/web/test/tenant-isolation.test.ts` (`checkTenantIsolation` z `@monorise-team/testing`).
4. Zmiany w strukturze bazy scalamy dopiero po zgodzie właściciela projektu.

## Testy bazy

- `packages/db/test/rls.test.ts`: sprawdza uprawnienia roli `kivo_tasks_app`, zachowanie `withUser` i funkcji RLS na tabeli tymczasowej z `ENABLE` + `FORCE ROW LEVEL SECURITY`, tabele techniczne oraz odmowę dostępu do `public._prisma_migrations`.
- `apps/web/test/tenant-isolation.test.ts`: sprawdza separację między firmami przez `checkTenantIsolation` z `@monorise-team/testing`.
- Oba pliki wymagają działającego PostgreSQL (`pnpm db:up && pnpm db:migrate`).
