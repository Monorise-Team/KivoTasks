-- Migracja etapu 1a KivoTasks (KivoTasks#9, ADR-0037, ADR-0103):
-- tabele zespołów, statusów obiegu, etykiet, zadań, etykiet zadań i relacji między zadaniami
-- wraz z indeksem pełnotekstowym GIN, złożonymi kluczami obcymi w obrębie firmy i zespołu
-- oraz wymuszonym RLS (ENABLE + FORCE ROW LEVEL SECURITY).

-- CreateEnum
CREATE TYPE "public"."WorkflowStateCategory" AS ENUM ('BACKLOG', 'UNSTARTED', 'STARTED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "public"."IssueRelationType" AS ENUM ('BLOCKS', 'RELATED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "public"."teams" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "next_issue_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "teams_key_format_check" CHECK ("key" ~ '^[A-Z]{2,5}$'),
    CONSTRAINT "teams_next_issue_number_check" CHECK ("next_issue_number" >= 1)
);

-- CreateTable
CREATE TABLE "public"."workflow_states" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "public"."WorkflowStateCategory" NOT NULL,
    "color" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "workflow_states_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_states_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 40),
    CONSTRAINT "workflow_states_position_check" CHECK ("position" >= 0)
);

-- CreateTable
CREATE TABLE "public"."labels" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "labels_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 40)
);

-- CreateTable
CREATE TABLE "public"."issues" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "state_id" UUID NOT NULL,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "assignee_account_id" UUID,
    "creator_account_id" UUID NOT NULL,
    "due_date" DATE,
    "estimate" SMALLINT,
    "parent_id" UUID,
    "sort_order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "canceled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    -- Znaki interpunkcyjne ASCII zamieniamy na spacje, żeby baza dzieliła tekst na słowa tak samo jak zapytanie
    -- (litery i cyfry). Bez tego parser czyta „MAG-2” jako słowo „mag” i liczbę „-2”, a „anna@acme.test” jako
    -- jeden adres, więc wyszukiwanie po fragmentach nie trafia.
    "search_vector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', translate(coalesce("title", ''), '!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~', '                                ')), 'A') ||
        setweight(to_tsvector('simple', translate(coalesce("description", ''), '!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~', '                                ')), 'B')
    ) STORED NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issues_number_check" CHECK ("number" >= 1),
    CONSTRAINT "issues_title_length_check" CHECK (char_length("title") BETWEEN 1 AND 255),
    CONSTRAINT "issues_description_length_check" CHECK ("description" IS NULL OR char_length("description") <= 50000),
    CONSTRAINT "issues_priority_check" CHECK ("priority" BETWEEN 0 AND 4),
    CONSTRAINT "issues_estimate_check" CHECK ("estimate" IS NULL OR ("estimate" BETWEEN 0 AND 100)),
    CONSTRAINT "issues_no_self_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);

-- CreateTable
CREATE TABLE "public"."issue_labels" (
    "issue_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,

    CONSTRAINT "issue_labels_pkey" PRIMARY KEY ("issue_id", "label_id")
);

-- CreateTable
CREATE TABLE "public"."issue_relations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "related_issue_id" UUID NOT NULL,
    "type" "public"."IssueRelationType" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_relations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_relations_no_self_check" CHECK ("issue_id" <> "related_issue_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_organization_id_id_key" ON "public"."teams"("organization_id", "id");
CREATE UNIQUE INDEX "teams_organization_id_key_key" ON "public"."teams"("organization_id", "key");
CREATE INDEX "teams_organization_id_archived_at_idx" ON "public"."teams"("organization_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_states_organization_id_team_id_id_key" ON "public"."workflow_states"("organization_id", "team_id", "id");
CREATE INDEX "workflow_states_organization_id_team_id_position_idx" ON "public"."workflow_states"("organization_id", "team_id", "position");
CREATE INDEX "workflow_states_team_id_archived_at_idx" ON "public"."workflow_states"("team_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "labels_organization_id_team_id_id_key" ON "public"."labels"("organization_id", "team_id", "id");
CREATE UNIQUE INDEX "labels_team_id_lower_name_key" ON "public"."labels"("team_id", lower("name")) WHERE "archived_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "issues_organization_id_id_key" ON "public"."issues"("organization_id", "id");
CREATE UNIQUE INDEX "issues_organization_id_team_id_id_key" ON "public"."issues"("organization_id", "team_id", "id");
CREATE UNIQUE INDEX "issues_team_id_number_key" ON "public"."issues"("team_id", "number");
CREATE INDEX "issues_organization_id_team_id_deleted_at_idx" ON "public"."issues"("organization_id", "team_id", "deleted_at");
CREATE INDEX "issues_organization_id_state_id_deleted_at_idx" ON "public"."issues"("organization_id", "state_id", "deleted_at");
CREATE INDEX "issues_organization_id_assignee_account_id_deleted_at_idx" ON "public"."issues"("organization_id", "assignee_account_id", "deleted_at");
CREATE INDEX "issues_organization_id_parent_id_deleted_at_idx" ON "public"."issues"("organization_id", "parent_id", "deleted_at");
CREATE INDEX "issues_organization_id_priority_updated_at_idx" ON "public"."issues"("organization_id", "priority", "updated_at");
CREATE INDEX "issues_organization_id_due_date_idx" ON "public"."issues"("organization_id", "due_date");
CREATE INDEX "issues_organization_id_updated_at_idx" ON "public"."issues"("organization_id", "updated_at");
CREATE INDEX "issues_organization_id_created_at_idx" ON "public"."issues"("organization_id", "created_at");
CREATE INDEX "issues_team_id_sort_order_idx" ON "public"."issues"("team_id", "sort_order");
CREATE INDEX "issues_search_vector_idx" ON "public"."issues" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "issue_labels_organization_id_team_id_label_id_idx" ON "public"."issue_labels"("organization_id", "team_id", "label_id");
CREATE INDEX "issue_labels_organization_id_label_id_idx" ON "public"."issue_labels"("organization_id", "label_id");

-- CreateIndex
CREATE UNIQUE INDEX "issue_relations_issue_id_related_issue_id_type_key" ON "public"."issue_relations"("issue_id", "related_issue_id", "type");
CREATE UNIQUE INDEX "issue_relations_related_pair_key"
    ON "public"."issue_relations"(LEAST("issue_id", "related_issue_id"), GREATEST("issue_id", "related_issue_id"))
    WHERE "type" = 'RELATED';
CREATE INDEX "issue_relations_organization_id_issue_id_idx" ON "public"."issue_relations"("organization_id", "issue_id");
CREATE INDEX "issue_relations_organization_id_related_issue_id_idx" ON "public"."issue_relations"("organization_id", "related_issue_id");

-- AddForeignKey (złożone klucze obce wiążą rekordy z firmą i zespołem, bo sprawdzanie FK omija RLS)
ALTER TABLE "public"."workflow_states" ADD CONSTRAINT "workflow_states_organization_id_team_id_fkey"
    FOREIGN KEY ("organization_id", "team_id") REFERENCES "public"."teams"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."labels" ADD CONSTRAINT "labels_organization_id_team_id_fkey"
    FOREIGN KEY ("organization_id", "team_id") REFERENCES "public"."teams"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."issues" ADD CONSTRAINT "issues_organization_id_team_id_fkey"
    FOREIGN KEY ("organization_id", "team_id") REFERENCES "public"."teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."issues" ADD CONSTRAINT "issues_organization_id_team_id_state_id_fkey"
    FOREIGN KEY ("organization_id", "team_id", "state_id") REFERENCES "public"."workflow_states"("organization_id", "team_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."issues" ADD CONSTRAINT "issues_organization_id_team_id_parent_id_fkey"
    FOREIGN KEY ("organization_id", "team_id", "parent_id") REFERENCES "public"."issues"("organization_id", "team_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."issue_labels" ADD CONSTRAINT "issue_labels_organization_id_team_id_issue_id_fkey"
    FOREIGN KEY ("organization_id", "team_id", "issue_id") REFERENCES "public"."issues"("organization_id", "team_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."issue_labels" ADD CONSTRAINT "issue_labels_organization_id_team_id_label_id_fkey"
    FOREIGN KEY ("organization_id", "team_id", "label_id") REFERENCES "public"."labels"("organization_id", "team_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."issue_relations" ADD CONSTRAINT "issue_relations_organization_id_issue_id_fkey"
    FOREIGN KEY ("organization_id", "issue_id") REFERENCES "public"."issues"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."issue_relations" ADD CONSTRAINT "issue_relations_organization_id_related_issue_id_fkey"
    FOREIGN KEY ("organization_id", "related_issue_id") REFERENCES "public"."issues"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Uprawnienia roli aplikacji na nowych tabelach ──────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "public"."teams",
    "public"."workflow_states",
    "public"."labels",
    "public"."issues",
    "public"."issue_labels",
    "public"."issue_relations"
TO kivo_tasks_app;

-- ── Separacja firm przez RLS (ADR-0037) ────────────────────────────────────────────────────────────
ALTER TABLE "public"."teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."teams" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."teams"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."workflow_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflow_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."workflow_states"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."labels" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."labels"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."issues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."issues" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."issues"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."issue_labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."issue_labels" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."issue_labels"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());

ALTER TABLE "public"."issue_relations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."issue_relations" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."issue_relations"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());
