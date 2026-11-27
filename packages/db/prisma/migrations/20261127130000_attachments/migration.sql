-- Etap 2b KivoTasks (ADR-0103): załączniki do zadań w magazynie zgodnym z S3.

-- AlterEnum (nowe wartości nie są używane w tej samej transakcji)
ALTER TYPE "public"."IssueEventType" ADD VALUE 'ATTACHMENT_ADDED';
ALTER TYPE "public"."IssueEventType" ADD VALUE 'ATTACHMENT_REMOVED';

-- CreateTable
CREATE TABLE "public"."issue_attachments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "uploader_account_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "issue_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_attachments_size_check" CHECK ("size_bytes" > 0),
    CONSTRAINT "issue_attachments_file_name_check" CHECK (char_length("file_name") BETWEEN 1 AND 255),
    CONSTRAINT "issue_attachments_content_type_check" CHECK (
        "content_type" IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream')
    ),
    CONSTRAINT "issue_attachments_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE UNIQUE INDEX "issue_attachments_storage_key_key" ON "public"."issue_attachments"("storage_key");
CREATE UNIQUE INDEX "issue_attachments_organization_id_id_key" ON "public"."issue_attachments"("organization_id", "id");
CREATE INDEX "issue_attachments_org_issue_created_idx" ON "public"."issue_attachments"("organization_id", "issue_id", "created_at", "id");
CREATE INDEX "issue_attachments_organization_id_team_id_idx" ON "public"."issue_attachments"("organization_id", "team_id");
-- Suma zużycia miejsca firmy bez czytania tabeli (tylko nieusunięte pliki)
CREATE INDEX "issue_attachments_active_usage_idx"
    ON "public"."issue_attachments"("organization_id") INCLUDE ("size_bytes")
    WHERE "deleted_at" IS NULL;

-- AddForeignKey (złożony klucz obcy wiąże plik z firmą, zespołem i zadaniem, bo sprawdzanie FK omija RLS)
ALTER TABLE "public"."issue_attachments" ADD CONSTRAINT "issue_attachments_organization_id_team_id_issue_id_fkey"
    FOREIGN KEY ("organization_id", "team_id", "issue_id") REFERENCES "public"."issues"("organization_id", "team_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Uprawnienia roli aplikacji ─────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."issue_attachments" TO kivo_tasks_app;

-- ── Separacja firm przez RLS (ADR-0037) ────────────────────────────────────────────────────────────
ALTER TABLE "public"."issue_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."issue_attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON "public"."issue_attachments"
    USING ("organization_id" = "public"."current_organization_id"())
    WITH CHECK ("organization_id" = "public"."current_organization_id"());
