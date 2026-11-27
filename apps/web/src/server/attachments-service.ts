import "server-only";
import {
  IssueAttachmentsQuery,
  type IssueAttachment,
  type PaginatedResult,
  type StorageUsage,
} from "@kivotasks/contracts";
import { uuidv7 } from "@kivotasks/db";
import type { PermissionSnapshot } from "@monorise-team/permissions";
import type { NextRequest } from "next/server";
import { ApiFailure } from "./api";
import {
  attachmentContentUrl,
  buildAttachmentStorageKey,
  buildContentDisposition,
  computeSha256Hex,
  computeStorageUsage,
  detectAttachmentContentType,
  formatMaxFileLimitMessage,
  isInlineAttachmentContentType,
  matchesIfNoneMatch,
  MULTIPART_CONTENT_LENGTH_OVERHEAD_BYTES,
  sanitizeAttachmentFileName,
} from "./attachment-helpers";
import type { Caller } from "./auth";
import { decodeTimeIdCursor } from "./collaboration-helpers";
import { config } from "./config";
import { tryResolveOrganizationMemberNames, UNKNOWN_PERSON_NAME } from "./core-directory";
import { deleteObject, getObject, putObject } from "./file-storage";
import { getIssuesStore, type AttachmentRecord, type IssueLocation } from "./issues-store";
import {
  assertProductAccess,
  canManageTeam,
  canReadTeamIssues,
  canWriteTeamIssues,
  getPermissionSnapshot,
  PERMISSION_DENIED_MESSAGE,
  requireAuthorizedSnapshot,
} from "./permissions";

const CONTENT_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "private, no-cache",
};

function queryParamsToRecord(searchParams: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    record[key] = value;
  }
  return record;
}

function resolveDisplayName(accountId: string, names: ReadonlyMap<string, string>, caller: Caller): string {
  const key = accountId.toLowerCase();
  const fromDir = names.get(key);
  if (fromDir && fromDir !== UNKNOWN_PERSON_NAME) {
    return fromDir;
  }
  if (key === caller.accountId.toLowerCase()) {
    const fromSession = caller.session?.profile.name?.trim();
    if (fromSession) return fromSession;
  }
  return fromDir ?? UNKNOWN_PERSON_NAME;
}

function canDeleteAttachment(
  snapshot: PermissionSnapshot,
  caller: Caller,
  attachment: Pick<AttachmentRecord, "uploaderAccountId" | "teamId">,
): boolean {
  if (canManageTeam(snapshot, attachment.teamId)) {
    return true;
  }
  return attachment.uploaderAccountId === caller.accountId && canWriteTeamIssues(snapshot, attachment.teamId);
}

function toIssueAttachment(
  record: AttachmentRecord,
  names: ReadonlyMap<string, string>,
  caller: Caller,
  snapshot: PermissionSnapshot,
): IssueAttachment {
  return {
    id: record.id,
    issueId: record.issueId,
    fileName: record.fileName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    uploader: {
      accountId: record.uploaderAccountId,
      name: resolveDisplayName(record.uploaderAccountId, names, caller),
    },
    createdAt: record.createdAt,
    contentUrl: attachmentContentUrl(record.id),
    inline: isInlineAttachmentContentType(record.contentType),
    canDelete: canDeleteAttachment(snapshot, caller, record),
  };
}

async function resolveVisibleIssue(
  caller: Caller,
  issueId: string,
): Promise<{ snapshot: PermissionSnapshot; issue: IssueLocation }> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const issue = await getIssuesStore().findIssueLocationById(caller, issueId);
  if (!issue || !canReadTeamIssues(snapshot, issue.teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono zadania");
  }
  return { snapshot, issue };
}

async function resolveVisibleAttachment(
  caller: Caller,
  attachmentId: string,
): Promise<{ snapshot: PermissionSnapshot; attachment: AttachmentRecord }> {
  const snapshot = await requireAuthorizedSnapshot(caller);
  const attachment = await getIssuesStore().findAttachmentById(caller, attachmentId);
  if (!attachment || !canReadTeamIssues(snapshot, attachment.teamId)) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono załącznika");
  }
  return { snapshot, attachment };
}

export async function deleteObjectBestEffort(storageKey: string, attachmentId: string): Promise<void> {
  try {
    await deleteObject(storageKey);
  } catch (error) {
    const label = error instanceof Error ? error.name : "UnknownError";
    console.warn(`[kivotasks.attachments] Nie udało się usunąć obiektu załącznika ${attachmentId} (${label}).`);
  }
}

/** Usuwa best-effort listę obiektów załączników po zatwierdzeniu transakcji (np. po usunięciu zadania). */
export async function deleteAttachmentObjectsBestEffort(storageKeys: readonly string[]): Promise<void> {
  for (const storageKey of storageKeys) {
    const attachmentId = storageKey.split("/").pop() ?? "unknown";
    await deleteObjectBestEffort(storageKey, attachmentId);
  }
}

export async function readBoundedMultipartBody(
  request: NextRequest,
  maxBodyBytes: number,
  maxFileBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = request.body;
  if (!body) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawna treść multipart/form-data");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiFailure(413, "PAYLOAD_TOO_LARGE", formatMaxFileLimitMessage(maxFileBytes));
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawna treść multipart/form-data");
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export async function listIssueAttachments(
  caller: Caller,
  issueId: string,
  searchParams: URLSearchParams,
): Promise<PaginatedResult<IssueAttachment>> {
  const { snapshot, issue } = await resolveVisibleIssue(caller, issueId);
  const parsed = IssueAttachmentsQuery.parse(queryParamsToRecord(searchParams));
  const cursor = parsed.cursor ? decodeTimeIdCursor(parsed.cursor) : undefined;

  const page = await getIssuesStore().listIssueAttachments(caller, {
    issueId: issue.id,
    limit: parsed.limit,
    cursor,
  });

  const neededIds = new Set(page.items.map((item) => item.uploaderAccountId));
  const names = await tryResolveOrganizationMemberNames(caller.organizationId, neededIds);
  return {
    items: page.items.map((item) => toIssueAttachment(item, names, caller, snapshot)),
    nextCursor: page.nextCursor,
  };
}

export async function uploadIssueAttachment(
  caller: Caller,
  issueId: string,
  request: NextRequest,
): Promise<IssueAttachment> {
  // 1. Uwierzytelnienie i uprawnienia (404 przed 403 dla zadania spoza zasięgu odczytu)
  const { snapshot, issue } = await resolveVisibleIssue(caller, issueId);
  if (!canWriteTeamIssues(snapshot, issue.teamId)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
  }

  const maxBytes = config.attachmentMaxBytes;
  const quotaBytes = config.storageQuotaBytes;
  const maxBodyBytes = maxBytes + MULTIPART_CONTENT_LENGTH_OVERHEAD_BYTES;

  // 2. Wstępna kontrola Content-Length przed wczytaniem treści żądania
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength !== null) {
    const parsedLength = Number(rawContentLength.trim());
    if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
      throw new ApiFailure(413, "PAYLOAD_TOO_LARGE", formatMaxFileLimitMessage(maxBytes));
    }
  }

  // 3. Odczyt multipart/form-data z licznikiem bajtów (chroni także żądania chunked / HTTP/2 bez Content-Length)
  const rawContentType = request.headers.get("content-type") ?? "";
  if (!rawContentType.toLowerCase().includes("multipart/form-data")) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Oczekiwano żądania multipart/form-data");
  }

  const bodyBytes = await readBoundedMultipartBody(request, maxBodyBytes, maxBytes);

  let formData: FormData;
  try {
    formData = await new Response(bodyBytes, { headers: { "content-type": rawContentType } }).formData();
  } catch {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawna treść multipart/form-data");
  }

  const allEntries = [...formData.entries()];
  const fileEntries = allEntries.filter(([name]) => name === "file");
  if (fileEntries.length !== 1 || allEntries.length !== 1) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      { field: "file", message: "Żądanie musi zawierać dokładnie jedną część o nazwie file" },
    ]);
  }

  const filePart = fileEntries[0]![1];
  if (typeof filePart === "string" || typeof filePart.arrayBuffer !== "function") {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      { field: "file", message: "Pole file musi zawierać plik" },
    ]);
  }

  if (filePart.size <= 0) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      { field: "file", message: "Plik nie może być pusty" },
    ]);
  }
  if (filePart.size > maxBytes) {
    throw new ApiFailure(413, "PAYLOAD_TOO_LARGE", formatMaxFileLimitMessage(maxBytes));
  }

  // 4. Odczyt bajtów, detekcja typu, nazwa pliku, SHA-256
  const bytes = new Uint8Array(await filePart.arrayBuffer());
  if (bytes.byteLength <= 0) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawne dane", [
      { field: "file", message: "Plik nie może być pusty" },
    ]);
  }
  if (bytes.byteLength > maxBytes) {
    throw new ApiFailure(413, "PAYLOAD_TOO_LARGE", formatMaxFileLimitMessage(maxBytes));
  }

  const detectedType = detectAttachmentContentType(bytes);
  const rawFileName = "name" in filePart && typeof filePart.name === "string" ? filePart.name : "";
  const fileName = sanitizeAttachmentFileName(rawFileName);
  const sha256 = computeSha256Hex(bytes);

  // 5. Szybkie wstępne sprawdzenie limitu miejsca przed zapisem do S3
  const store = getIssuesStore();
  const currentUsedBytes = await store.getOrganizationStorageUsedBytes(caller);
  if (currentUsedBytes + bytes.byteLength > quotaBytes) {
    throw new ApiFailure(409, "STORAGE_QUOTA_EXCEEDED", "Brak miejsca na pliki firmy");
  }

  // 6. Zapis obiektu do S3 pod wygenerowanym wcześniej UUID v7
  const attachmentId = uuidv7();
  const storageKey = buildAttachmentStorageKey({
    organizationId: caller.organizationId,
    issueId: issue.id,
    attachmentId,
  });

  await putObject(storageKey, bytes, detectedType);

  // 7. Atomowy zapis w bazie pod blokadą wiersza zadania i blokadą doradczą limitu firmy
  let created: AttachmentRecord;
  try {
    created = await store.createIssueAttachment(caller, {
      id: attachmentId,
      issueId: issue.id,
      teamId: issue.teamId,
      fileName,
      contentType: detectedType,
      sizeBytes: bytes.byteLength,
      sha256,
      storageKey,
      quotaBytes,
    });
  } catch (error) {
    await deleteObjectBestEffort(storageKey, attachmentId);
    throw error;
  }

  const names = await tryResolveOrganizationMemberNames(caller.organizationId, new Set([created.uploaderAccountId]));
  return toIssueAttachment(created, names, caller, snapshot);
}

export async function getAttachment(caller: Caller, attachmentId: string): Promise<IssueAttachment> {
  const { snapshot, attachment } = await resolveVisibleAttachment(caller, attachmentId);
  const names = await tryResolveOrganizationMemberNames(caller.organizationId, new Set([attachment.uploaderAccountId]));
  return toIssueAttachment(attachment, names, caller, snapshot);
}

export async function getAttachmentContent(
  caller: Caller,
  attachmentId: string,
  request: NextRequest,
): Promise<Response> {
  const { attachment } = await resolveVisibleAttachment(caller, attachmentId);
  const etag = `"${attachment.id}"`;

  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ...CONTENT_SECURITY_HEADERS,
        ETag: etag,
      },
    });
  }

  const object = await getObject(attachment.storageKey, { abortSignal: request.signal });
  const contentLength = object.contentLength ?? attachment.sizeBytes;

  return new Response(object.body, {
    status: 200,
    headers: {
      ...CONTENT_SECURITY_HEADERS,
      "Content-Type": attachment.contentType,
      "Content-Length": String(contentLength),
      "Content-Disposition": buildContentDisposition(attachment.fileName, attachment.contentType),
      ETag: etag,
    },
  });
}

export async function deleteAttachment(caller: Caller, attachmentId: string): Promise<void> {
  const { snapshot, attachment } = await resolveVisibleAttachment(caller, attachmentId);
  if (!canDeleteAttachment(snapshot, caller, attachment)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do usunięcia tego załącznika");
  }

  const deleted = await getIssuesStore().softDeleteIssueAttachment(caller, attachment.id);
  if (!deleted) {
    throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono załącznika");
  }

  await deleteObjectBestEffort(deleted.storageKey, attachment.id);
}

export async function getStorageUsage(caller: Caller): Promise<StorageUsage> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const usedBytes = await getIssuesStore().getOrganizationStorageUsedBytes(caller);
  return computeStorageUsage(usedBytes, config.storageQuotaBytes, config.attachmentMaxBytes);
}
