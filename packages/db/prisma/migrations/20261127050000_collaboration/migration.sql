-- Migracja etapu 2a KivoTasks (KivoTasks#19, ADR-0037, ADR-0103):
-- tabele komentarzy, wzmianek (@mentions), reakcji emoji, historii zmian zadania, obserwujących
-- oraz skrzynki powiadomień w aplikacji wraz ze złożonymi kluczami obcymi w obrębie firmy i zespołu,
-- ograniczeniami CHECK oraz wymuszonym RLS (ENABLE + FORCE ROW LEVEL SECURITY).

-- CreateEnum
CREATE TYPE "public"."IssueEventType" AS ENUM (
    'CREATED',
    'TITLE_CHANGED',
    'DESCRIPTION_CHANGED',
    'STATE_CHANGED',
    'PRIORITY_CHANGED',
    'ASSIGNEE_CHANGED',
    'LABELS_CHANGED',
    'DUE_DATE_CHANGED',
    'ESTIMATE_CHANGED',
    'PARENT_CHANGED',
    'RELATION_ADDED',
    'RELATION_REMOVED',
    'DELETED'
);

-- CreateEnum
CREATE TYPE "public"."InboxItemKind" AS ENUM ('ASSIGNED', 'MENTIONED', 'COMMENTED');

-- CreateTable
CREATE TABLE "public"."issue_comments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "issue_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_comments_body_length_check" CHECK (char_length("body") BETWEEN 1 AND 10000)
);

-- CreateTable
CREATE TABLE "public"."comment_mentions" (
    "comment_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_mentions_pkey" PRIMARY KEY ("comment_id", "account_id")
);

-- CreateTable
CREATE TABLE "public"."comment_reactions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "comment_reactions_emoji_check" CHECK ("emoji" IN ('👍', '❤️', '🎉', '😄', '👀', '🚀'))
);

-- CreateTable
CREATE TABLE "public"."issue_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "type" "public"."IssueEventType" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."issue_subscribers" (
    "issue_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_subscribers_pkey" PRIMARY KEY ("issue_id", "account_id")
);

-- CreateTable
CREATE TABLE "public"."inbox_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recipient_account_id" UUID NOT NULL,
    "kind" "public"."InboxItemKind" NOT NULL,
    "issue_id" UUID NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "comment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "inbox_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inbox_items_no_self_notification_check" CHECK ("recipient_account_id" <> "actor_account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issue_comments_organization_id_id_key" ON "public"."issue_comments"("organization_id", "id");
CREATE UNIQUE INDEX "issue_comments_organization_id_issue_id_id_key" ON "public"."issue_comments"("organization_id", "issue_id", "id");
CREATE INDEX "issue_comments_org_issue_created_idx" ON "public"."issue_comments"("organization_id", "issue_id", "created_at", "id");
CREATE INDEX "issue_comments_organization_id_team_id_idx" ON "public"."issue_comments"("organization_id", "team_id");

-- CreateIndex
CREATE INDEX "comment_mentions_organization_id_comment_id_idx" ON "public"."comment_mentions"("organization_id", "comment_id");
CREATE INDEX "comment_mentions_organization_id_account_id_idx" ON "public"."comment_mentions"("organization_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "comment_reactions_comment_id_account_id_emoji_key" ON "public"."comment_reactions"("comment_id", "account_id", "emoji");
CREATE INDEX "comment_reactions_organization_id_comment_id_idx" ON "public"."comment_reactions"("organization_id", "comment_id");

-- CreateIndex
CREATE INDEX "issue_events_org_issue_created_idx" ON "public"."issue_events"("organization_id", "issue_id", "created_at", "id");
CREATE INDEX "issue_events_organization_id_team_id_idx" ON "public"."issue_events"("organization_id", "team_id");

-- CreateIndex
CREATE INDEX "issue_subscribers_organization_id_issue_id_idx" ON "public"."issue_subscribers"("organization_id", "issue_id");
CREATE INDEX "issue_subscribers_organization_id_account_id_idx" ON "public"."issue_subscribers"("organization_id", "account_id");

-- CreateIndex
CREATE INDEX "inbox_items_recipient_created_idx" ON "public"."inbox_items"("organization_id", "recipient_account_id", "created_at", "id");
CREATE INDEX "inbox_items_unread_recipient_idx"
    ON "public"."inbox_items"("organization_id", "recipient_account_id", "created_at" DESC, "id" DESC)
    WHERE "read_at" IS NULL AND "archived_at" IS NULL;
CREATE INDEX "inbox_items_active_recipient_idx"
    ON "public"."inbox_items"("organization_id", "recipient_account_id", "created_at" DESC, "id" DESC)
    WHERE "archived_at" IS NULL;
CREATE INDEX "inbox_items_organization_id_issue_id_idx" ON "public"."inbox_items"("organization_id", "issue_id");
CREATE INDEX "inbox_items_organization_id_comment_id_idx" ON "public"."inbox_items"("organization_id", "comment_id");

-- AddForeignKey (złożone klucze obce wiążą rekordy z firmą, zespołem i zadaniem, bo sprawdzanie FK omija RLS)
ALTER TABLE "public"."issue_comments" ADD CONSTRAINT "issue_comments_organization_id_team_id_issue_id_fkey"
    FOREIGN KEY ("organization_id", "team_id", "issue_id") REFERENCES "public"."issues"("organization_id", "team_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."comment_mentions" ADD CONSTRAINT "comment_mentions_organization_id_comment_id_fkey"
    FOREIGN KEY ("organization_id", "comment_id") REFERENCES "public"."issue_comments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."comment_reactions" ADD CONSTRAINT "comment_reactions_organization_id_comment_id_fkey"
    FOREIGN KEY ("organization_id", "comment_id") REFERENCES "public"."issue_comments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."issue_events" ADD CONSTRAINT "issue_events_organization_id_team_id_issue_id_fkey"
    FOREIGN KEY ("organization_id", "team_id", "issue_id") REFERENCES "public"."issues"("organization_id", "team_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."issue_subscribers" ADD CONSTRAINT "issue_subscribers_organization_id_issue_id_fkey"
    FOREIGN KEY ("organization_id", "issue_id") REFERENCES "public"."issues"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."inbox_items" ADD CONSTRAINT "inbox_items_organization_id_issue_id_fkey"
    FOREIGN KEY ("organization_id", "issue_id") REFERENCES "public"."issues"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."inbox_items" ADD CONSTRAINT "inbox_items_organization_id_issue_id_comment_id_fkey"
    FOREIGN KEY ("organization_id", "issue_id", "comment_id") REFERENCES "public"."issue_comments"("organization_id", "issue_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Uprawnienia roli aplikacji na nowych tabelach ──────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "public"."issue_comments",
    "public"."comment_mentions",
    "public"."comment_reactions",
    "public"."issue_events",
    "public"."issue_subscribers",
    "public"."inbox_items"
TO kivo_tasks_app;

-- ── Separacja firm przez RLS (ADR-0037) ────────────────────────────────────────────────────────────
ALTER TABLE "public"."issue_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."issue_comments" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."issue_comments"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."comment_mentions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."comment_mentions" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."comment_mentions"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."comment_reactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."comment_reactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."comment_reactions"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."issue_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."issue_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."issue_events"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."issue_subscribers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."issue_subscribers" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."issue_subscribers"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."inbox_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."inbox_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."inbox_items"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

-- ── Uzupełnienie obserwujących dla istniejących zadań (twórca i bieżąca osoba przypisana) ─────────
-- Migracja uruchamiana jest rolą kivo_tasks_owner, a tabele issues i issue_subscribers mają FORCE RLS,
-- więc na czas backfillu tymczasowo wyłączamy FORCE RLS i natychmiast je przywracamy w tej samej transakcji.
ALTER TABLE "public"."issues" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."issue_subscribers" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "public"."issue_subscribers" ("issue_id", "account_id", "organization_id", "created_at")
SELECT "id", "creator_account_id", "organization_id", "created_at"
FROM "public"."issues"
WHERE "deleted_at" IS NULL
ON CONFLICT ("issue_id", "account_id") DO NOTHING;

INSERT INTO "public"."issue_subscribers" ("issue_id", "account_id", "organization_id", "created_at")
SELECT "id", "assignee_account_id", "organization_id", "created_at"
FROM "public"."issues"
WHERE "deleted_at" IS NULL
  AND "assignee_account_id" IS NOT NULL
ON CONFLICT ("issue_id", "account_id") DO NOTHING;

ALTER TABLE "public"."issue_subscribers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."issues" FORCE ROW LEVEL SECURITY;
