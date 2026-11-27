import { createHash } from "node:crypto";
import type { AttachmentContentType, StorageUsage, StorageUsageState } from "@kivotasks/contracts";

/** Zapas na nagłówki i granice `multipart/form-data` przy wstępnej kontroli `Content-Length` (64 KiB). */
export const MULTIPART_CONTENT_LENGTH_OVERHEAD_BYTES = 64 * 1024;

/** Maksymalna długość nazwy pliku w jednostkach kodu UTF-16 (zgodna z CHECK 1–255 w bazie). */
export const MAX_ATTACHMENT_FILE_NAME_LENGTH = 255;

/** Domyślna nazwa pliku, gdy oczyszczona nazwa okaże się pusta. */
export const FALLBACK_ATTACHMENT_FILE_NAME = "plik";

const INLINE_IMAGE_TYPES = new Set<AttachmentContentType>(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Zwraca `true` wyłącznie dla czterech bezpiecznych formatów obrazów wyświetlanych w linii. */
export function isInlineAttachmentContentType(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.has(contentType as AttachmentContentType);
}

/**
 * Rozpoznaje typ MIME wyłącznie po bajtach magicznych (ignoruje rozszerzenie i typ zadeklarowany przez klienta):
 * PNG, JPEG, GIF87a/GIF89a, WebP; wszystko inne (w tym SVG, HTML, PDF) dostaje `application/octet-stream`.
 */
export function detectAttachmentContentType(bytes: Uint8Array): AttachmentContentType {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF: GIF87a lub GIF89a
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  // WebP: RIFF + 4 bajty rozmiaru + WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return "application/octet-stream";
}

function isDisallowedFileNameChar(code: number): boolean {
  return (
    code <= 0x1f || // C0
    (code >= 0x7f && code <= 0x9f) || // DEL + C1
    code === 0x2028 || // Line Separator
    code === 0x2029 || // Paragraph Separator
    (code >= 0x202a && code <= 0x202e) || // Bidi embeddings/overrides
    (code >= 0x2066 && code <= 0x2069) // Bidi isolates
  );
}

function truncateUtf16Safe(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) return value;
  let end = maxCodeUnits;
  // Nie przecinaj pary surogatów (wysoki surogat: 0xD800–0xDBFF)
  const lastCode = value.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end).trimEnd();
}

/**
 * Oczyszcza nazwę pliku od użytkownika:
 * 1. normalizacja NFC,
 * 2. część po ostatnim `/` lub `\`,
 * 3. usunięcie znaków sterujących (C0, C1, U+2028/2029, bidi U+202A–202E i U+2066–2069),
 * 4. zbicie białych znaków i przycięcie,
 * 5. usunięcie wiodących kropek,
 * 6. przycięcie do 255 jednostek kodu UTF-16 bez rozcinania pary surogatów,
 * 7. domyślna nazwa `plik`, gdy nic nie zostało.
 */
export function sanitizeAttachmentFileName(rawName: string): string {
  let name = rawName.normalize("NFC");
  const lastSeparator = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (lastSeparator !== -1) {
    name = name.slice(lastSeparator + 1);
  }

  let cleaned = "";
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (!isDisallowedFileNameChar(code)) {
      cleaned += name[i]!;
    }
  }

  let result = cleaned.replace(/\s+/g, " ").trim();
  while (result.startsWith(".")) {
    result = result.replace(/^\.+/, "").trim();
  }
  result = truncateUtf16Safe(result, MAX_ATTACHMENT_FILE_NAME_LENGTH);
  return result.length > 0 ? result : FALLBACK_ATTACHMENT_FILE_NAME;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Buduje nagłówek `Content-Disposition`:
 * - `inline` wyłącznie dla PNG, JPEG, GIF i WebP; `attachment` dla pozostałych typów,
 * - `filename="<ASCII z zamianą spoza ASCII, cudzysłowów i ukośników odwrotnych na _>"`,
 * - `filename*=UTF-8''<kodowanie procentowe RFC 5987>`.
 */
export function buildContentDisposition(fileName: string, contentType: AttachmentContentType): string {
  const disposition = isInlineAttachmentContentType(contentType) ? "inline" : "attachment";
  let asciiFallback = "";
  for (const ch of fileName) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e || ch === '"' || ch === "\\") {
      asciiFallback += "_";
    } else {
      asciiFallback += ch;
    }
  }
  if (!asciiFallback) {
    asciiFallback = FALLBACK_ATTACHMENT_FILE_NAME;
  }
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

/** Oblicza skrót SHA-256 (64 małe znaki szesnastkowe) zawartości pliku. */
export function computeSha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Buduje klucz obiektu w magazynie S3 bez nazwy pliku od użytkownika. */
export function buildAttachmentStorageKey(params: {
  organizationId: string;
  issueId: string;
  attachmentId: string;
}): string {
  return `organizations/${params.organizationId}/issues/${params.issueId}/attachments/${params.attachmentId}`;
}

/** Zwraca ścieżkę API do pobierania zawartości załącznika. */
export function attachmentContentUrl(attachmentId: string): string {
  return `/api/v1/attachments/${attachmentId}/content`;
}

/** Wylicza stan zużycia miejsca firmy (`OK`, `WARNING` od 80%, `FULL` od 100%). */
export function computeStorageUsage(usedBytes: number, quotaBytes: number, maxFileBytes: number): StorageUsage {
  const safeUsed = Math.max(0, usedBytes);
  const usedRatio = quotaBytes > 0 ? safeUsed / quotaBytes : 1;
  const state: StorageUsageState = safeUsed >= quotaBytes ? "FULL" : usedRatio >= 0.8 ? "WARNING" : "OK";
  return {
    usedBytes: safeUsed,
    quotaBytes,
    maxFileBytes,
    usedRatio,
    state,
  };
}

/** Formatuje komunikat błędu 413 `PAYLOAD_TOO_LARGE` z limitem rozmiaru pliku w MB. */
export function formatMaxFileLimitMessage(maxFileBytes: number): string {
  const mb = maxFileBytes / (1024 * 1024);
  if (Number.isInteger(mb)) {
    return `Plik jest większy niż ${mb} MB`;
  }
  const formatted = new Intl.NumberFormat("pl-PL", {
    maximumFractionDigits: mb >= 0.1 ? 1 : 3,
  }).format(mb);
  return `Plik jest większy niż ${formatted} MB`;
}

/**
 * Sprawdza nagłówek `If-None-Match` (porównanie słabe RFC 9110: `*`, `"<etag>"`, `W/"<etag>"`, listy po przecinku).
 */
export function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;
  const normalizedTarget = etag.startsWith("W/") ? etag.slice(2) : etag;
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const candidate = part.startsWith("W/") ? part.slice(2) : part;
    if (candidate === normalizedTarget) {
      return true;
    }
  }
  return false;
}
