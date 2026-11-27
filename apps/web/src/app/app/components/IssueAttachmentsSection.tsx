"use client";

import { ApiError, type IssueAttachment, type StorageUsage } from "@kivotasks/client";
import { Badge, Banner, Button, ConfirmDialog, Dialog, Skeleton, cn, useToast } from "@monorise-team/ui";
import { Download, FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { formatApiError } from "../app-views";
import { formatFileSize, formatStorageBanner, resolveUploadedFileName } from "../attachments-ui";
import { formatDateTime } from "../issue-ui";
import { useKivoTasks } from "../KivoTasksContext";

export interface IssueAttachmentsSectionProps {
  readonly issueId: string;
  readonly teamId: string;
  readonly canWrite: boolean;
  readonly attachmentsRevision: number;
  readonly storageUsage: StorageUsage | null;
  readonly onAttachmentsChanged: () => void;
}

const ATTACHMENTS_PAGE_LIMIT = 50;

interface UploadingEntry {
  readonly id: string;
  readonly fileName: string;
}

/**
 * Sekcja „Załączniki” na karcie zadania: lista plików z miniaturami obrazów (powiększenie w oknie
 * dialogowym), pobieraniem, usuwaniem z potwierdzeniem, wysyłaniem wielu plików (przycisk oraz
 * przeciągnij i upuść) i komunikatem o limicie miejsca firmy.
 */
export function IssueAttachmentsSection({
  issueId,
  teamId,
  canWrite,
  attachmentsRevision,
  storageUsage,
  onAttachmentsChanged,
}: IssueAttachmentsSectionProps) {
  const { client, markTeamWriteDenied } = useKivoTasks();
  const { toast } = useToast();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const [state, setState] = useState<{
    readonly key: string;
    readonly items: IssueAttachment[];
    readonly nextCursor: string | null;
    readonly error: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [uploadingQueue, setUploadingQueue] = useState<UploadingEntry[]>([]);
  const [draggingOver, setDraggingOver] = useState(false);

  const [previewAttachment, setPreviewAttachment] = useState<IssueAttachment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IssueAttachment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadKey = `${issueId}:${attachmentsRevision}`;

  useEffect(() => {
    let cancelled = false;
    client.issues
      .listAttachments(issueId, { limit: ATTACHMENTS_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        setState({
          key: loadKey,
          items: page.items,
          nextCursor: page.nextCursor,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          key: loadKey,
          items: [],
          nextCursor: null,
          error: formatApiError(error, "Nie udało się wczytać załączników."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, issueId, loadKey]);

  const loading = state === null || (state.key !== loadKey && state.items.length === 0);
  const items = state?.items ?? [];
  const nextCursor = state?.key === loadKey ? state.nextCursor : null;
  const loadError = state?.key === loadKey ? state.error : null;

  const storageFull = storageUsage?.state === "FULL";
  const storageBanner = storageUsage ? formatStorageBanner(storageUsage) : null;
  const uploading = uploadingQueue.length > 0;
  const uploadDisabled = !canWrite || storageFull || uploading;

  const uploadFilesSequentially = async (fileList: readonly File[]) => {
    if (!canWrite || storageFull || fileList.length === 0) return;

    const batch: UploadingEntry[] = fileList.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      fileName: resolveUploadedFileName(file),
    }));

    setActionError(null);
    setUploadingQueue((prev) => [...prev, ...batch]);

    let uploadedAny = false;
    const errors: string[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]!;
      const entry = batch[i]!;
      try {
        const created = await client.issues.uploadAttachment(issueId, file, entry.fileName);
        uploadedAny = true;
        setState((prev) => {
          if (!prev) {
            return { key: loadKey, items: [created], nextCursor: null, error: null };
          }
          const deduped = prev.items.filter((item) => item.id !== created.id);
          return { ...prev, items: [created, ...deduped] };
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 403 && error.code === "PERMISSION_DENIED") {
          markTeamWriteDenied(teamId);
        }
        const message = formatApiError(error, `Nie udało się wysłać pliku ${entry.fileName}.`);
        errors.push(`${entry.fileName}: ${message}`);
      } finally {
        setUploadingQueue((prev) => prev.filter((item) => item.id !== entry.id));
      }
    }

    if (errors.length > 0) {
      setActionError(errors.join(" "));
    }
    if (uploadedAny) {
      onAttachmentsChanged();
    }
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (selected.length > 0) {
      void uploadFilesSequentially(selected);
    }
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!canWrite || storageFull) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!canWrite || storageFull) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!canWrite || storageFull) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDraggingOver(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!canWrite || storageFull) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingOver(false);
    const dropped = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
    if (dropped.length > 0) {
      void uploadFilesSequentially(dropped);
    }
  };

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const page = await client.issues.listAttachments(issueId, {
        limit: ATTACHMENTS_PAGE_LIMIT,
        cursor: nextCursor,
      });
      setState((prev) => {
        if (!prev) return prev;
        const existingIds = new Set(prev.items.map((item) => item.id));
        const appended = page.items.filter((item) => !existingIds.has(item.id));
        return {
          ...prev,
          items: [...prev.items, ...appended],
          nextCursor: page.nextCursor,
        };
      });
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się wczytać kolejnych załączników."));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    setActionError(null);
    try {
      await client.attachments.delete(target.id);
      setState((prev) => (prev ? { ...prev, items: prev.items.filter((item) => item.id !== target.id) } : prev));
      setDeleteTarget(null);
      if (previewAttachment?.id === target.id) {
        setPreviewAttachment(null);
      }
      onAttachmentsChanged();
      toast({ title: `Usunięto załącznik ${target.fileName}`, tone: "neutral" });
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się usunąć załącznika."));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section
      aria-labelledby="attachments-heading"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "flex flex-col gap-3 rounded-card transition-colors",
        draggingOver && "bg-accent/5 p-3 ring-2 ring-accent",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Paperclip className="size-4 text-text-tertiary" aria-hidden />
          <h2 id="attachments-heading" className="text-sm font-semibold text-text-primary">
            Załączniki
          </h2>
          <Badge tone="neutral">{items.length}</Badge>
        </div>

        {canWrite ? (
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              aria-label="Wybierz pliki do załączenia"
              onChange={handleFileInputChange}
            />
            <Button
              type="button"
              variant="secondary"
              size="xs"
              icon={<Upload aria-hidden />}
              disabled={uploadDisabled}
              onClick={() => fileInputRef.current?.click()}
            >
              Dodaj pliki
            </Button>
          </div>
        ) : null}
      </div>

      {storageBanner ? <Banner tone={storageBanner.tone} message={storageBanner.message} /> : null}
      {loadError ? <Banner tone="danger" message={loadError} /> : null}
      {actionError ? <Banner tone="danger" message={actionError} onDismiss={() => setActionError(null)} /> : null}

      {draggingOver ? (
        <p className="text-xs font-medium text-accent-strong">Upuść pliki tutaj, aby dodać je do zadania.</p>
      ) : null}

      {uploadingQueue.length > 0 ? (
        <ul
          aria-label="Trwa wysyłanie załączników"
          className="flex flex-col divide-y divide-border-secondary overflow-hidden rounded-card border border-border-primary bg-bg-secondary/45"
        >
          {uploadingQueue.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
              <span className="min-w-0 truncate text-text-primary">{entry.fileName}</span>
              <span className="shrink-0 text-xs text-text-tertiary">Wysyłanie…</span>
            </li>
          ))}
        </ul>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Wczytywanie załączników">
          <Skeleton className="h-14 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-tertiary">
          {canWrite && !storageFull
            ? "Brak załączników. Kliknij „Dodaj pliki” albo przeciągnij pliki tutaj."
            : "Brak załączników."}
        </p>
      ) : (
        <ul
          aria-label="Lista załączników zadania"
          className="flex flex-col divide-y divide-border-secondary overflow-hidden rounded-card border border-border-primary bg-bg-secondary/45"
        >
          {items.map((attachment) => (
            <li
              key={attachment.id}
              className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-row-hover"
            >
              {attachment.inline ? (
                <button
                  type="button"
                  onClick={() => setPreviewAttachment(attachment)}
                  aria-label={`Powiększ obraz ${attachment.fileName}`}
                  className="shrink-0 overflow-hidden rounded-control border border-border-secondary bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <img
                    src={attachment.contentUrl}
                    alt={attachment.fileName}
                    loading="lazy"
                    decoding="async"
                    className="max-h-24 max-w-24 object-cover"
                  />
                </button>
              ) : (
                <div className="flex size-10 shrink-0 items-center justify-center rounded-control border border-border-secondary bg-bg-tertiary text-text-tertiary">
                  <FileText className="size-4" aria-hidden />
                </div>
              )}

              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-text-primary" title={attachment.fileName}>
                  {attachment.fileName}
                </span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-tertiary">
                  <span className="tabular-nums">{formatFileSize(attachment.sizeBytes)}</span>
                  <span aria-hidden>·</span>
                  <span className="truncate">{attachment.uploader.name}</span>
                  <span aria-hidden>·</span>
                  <time dateTime={attachment.createdAt} className="tabular-nums">
                    {formatDateTime(attachment.createdAt)}
                  </time>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button asChild variant="ghost" size="xs" icon={<Download aria-hidden />}>
                  <a href={attachment.contentUrl} download={attachment.fileName}>
                    Pobierz
                  </a>
                </Button>
                {attachment.canDelete ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon={<Trash2 aria-hidden />}
                    className="text-danger hover:text-danger"
                    onClick={() => setDeleteTarget(attachment)}
                  >
                    Usuń
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void handleLoadMore()}>
            {loadingMore ? "Wczytywanie…" : "Wczytaj więcej załączników"}
          </Button>
        </div>
      ) : null}

      <Dialog
        open={previewAttachment !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewAttachment(null);
        }}
        title={previewAttachment?.fileName ?? "Podgląd obrazu"}
        description={
          previewAttachment
            ? `${formatFileSize(previewAttachment.sizeBytes)} · ${previewAttachment.uploader.name}`
            : undefined
        }
        className="max-w-4xl"
        footer={
          previewAttachment ? (
            <div className="flex justify-end gap-2">
              <Button asChild variant="secondary" size="sm" icon={<Download aria-hidden />}>
                <a href={previewAttachment.contentUrl} download={previewAttachment.fileName}>
                  Pobierz
                </a>
              </Button>
              <Button type="button" variant="primary" size="sm" onClick={() => setPreviewAttachment(null)}>
                Zamknij
              </Button>
            </div>
          ) : null
        }
      >
        {previewAttachment ? (
          <div className="flex max-h-[70vh] items-center justify-center overflow-auto rounded-control bg-bg-tertiary/60 p-2">
            <img
              src={previewAttachment.contentUrl}
              alt={previewAttachment.fileName}
              className="max-h-[66vh] max-w-full object-contain"
            />
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Usunąć załącznik?"
        description={
          deleteTarget
            ? `Plik „${deleteTarget.fileName}” zostanie usunięty z zadania i przestanie być dostępny do pobrania.`
            : ""
        }
        confirmLabel="Usuń załącznik"
        danger
        onConfirm={() => void handleConfirmDelete()}
      />
    </section>
  );
}
