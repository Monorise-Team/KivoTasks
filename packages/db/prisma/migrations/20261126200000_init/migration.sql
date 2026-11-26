-- Migracja początkowa KivoTasks (etap 0, ADR-0037, ADR-0096, ADR-0100, ADR-0103):
-- schematy, tabele sesji BFF i kanału zdarzeń Core, uprawnienia roli aplikacji oraz funkcje pomocnicze RLS.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "auth"."sessions" (
    "id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "data" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."event_feed_cursors" (
    "id" TEXT NOT NULL,
    "sequence" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_feed_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateIndex
CREATE INDEX "sessions_account_id_idx" ON "auth"."sessions"("account_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "auth"."sessions"("expires_at");

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "public"."processed_events"("processed_at");

-- ── Uprawnienia roli aplikacji (ADR-0037) ──────────────────────────────────────────────────────────
-- kivo_tasks_app pracuje na danych, ale nie jest właścicielem tabel i nie omija RLS.
GRANT USAGE ON SCHEMA "public", "auth" TO kivo_tasks_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public", "auth" TO kivo_tasks_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public", "auth" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kivo_tasks_app;
-- Historia migracji Prismy nie jest dla aplikacji (tabela powstaje przed tą migracją przy prisma migrate).
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON "public"."_prisma_migrations" FROM kivo_tasks_app;
  END IF;
END $$;

-- ── Funkcje pomocnicze RLS ze zmiennych transakcji (withUser w @kivotasks/db) ──────────────────────
--   SELECT set_config('app.organization_id', '<uuid>', true), set_config('app.account_id', '<uuid>', true)
-- Bez nich polityki RLS na tabelach domenowych nie zwracają żadnego wiersza i nie pozwalają nic zapisać.
CREATE FUNCTION "public"."current_organization_id"() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION "public"."current_account_id"() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.account_id', true), '')::uuid $$;

-- Sesje przeglądarki (auth.sessions) są bez RLS: serwer szuka ich po skrócie identyfikatora z ciasteczka,
-- zanim wie, czyja to sesja. Tokeny w sesji są zaszyfrowane kluczem aplikacji (@monorise-team/auth).
-- Tabele kanału zdarzeń (event_feed_cursors, processed_events) nie zawierają danych osób ani firm,
-- więc również pozostają bez RLS.
