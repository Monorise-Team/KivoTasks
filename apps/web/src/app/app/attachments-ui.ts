import type { IssueAttachment, StorageUsage } from "@kivotasks/client";

const ONE_KB = 1024;
const ONE_MB = 1024 * 1024;
const ONE_GB = 1024 * 1024 * 1024;

function formatPlNumber(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

/**
 * Formatuje rozmiar pliku po polsku (`pl-PL`), np. `512 B`, `340 kB`, `1,2 MB`, `1 GB`.
 */
export function formatFileSize(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < ONE_KB) {
    return `${Math.round(safe)} B`;
  }
  if (safe < ONE_MB) {
    const kb = safe / ONE_KB;
    return `${formatPlNumber(kb, kb < 10 ? 1 : 0)} kB`;
  }
  if (safe < ONE_GB) {
    return `${formatPlNumber(safe / ONE_MB, 1)} MB`;
  }
  return `${formatPlNumber(safe / ONE_GB, 2)} GB`;
}

export interface StorageBannerInfo {
  readonly tone: "warning" | "danger";
  readonly message: string;
}

/**
 * Buduje komunikat paska ostrzegawczego limitu miejsca firmy (`WARNING` od 80%, `FULL` od 100%).
 */
export function formatStorageBanner(usage: StorageUsage): StorageBannerInfo | null {
  if (usage.state === "FULL") {
    return {
      tone: "danger",
      message:
        "Miejsce na pliki firmy jest pełne. Usuń niepotrzebne pliki albo poproś administratora o więcej miejsca.",
    };
  }
  if (usage.state === "WARNING") {
    const percent = Math.min(100, Math.round(usage.usedRatio * 100));
    return {
      tone: "warning",
      message: `Wykorzystano ${percent}% miejsca na pliki firmy (${formatFileSize(usage.usedBytes)} z ${formatFileSize(usage.quotaBytes)}).`,
    };
  }
  return null;
}

/** Escapuje nawiasy kwadratowe `[` i `]` oraz znaki nowej linii w etykiecie odnośnika/obrazu Markdown. */
export function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "\\$&");
}

/** Buduje fragment Markdown dla przesłanego załącznika (obraz `![...]` albo link `[...]`). */
export function formatAttachmentMarkdown(
  attachment: Pick<IssueAttachment, "fileName" | "contentUrl" | "inline">,
): string {
  const safeName = escapeMarkdownLinkLabel(attachment.fileName);
  return attachment.inline ? `![${safeName}](${attachment.contentUrl})` : `[${safeName}](${attachment.contentUrl})`;
}

/** Wstawia fragment tekstu w miejscu kursora (lub zaznaczenia) i zwraca nowy tekst oraz pozycję kursora. */
export function insertTextAtCursor(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  snippet: string,
): { readonly nextText: string; readonly nextCursorPos: number } {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const nextText = `${before}${snippet}${after}`;
  return {
    nextText,
    nextCursorPos: before.length + snippet.length,
  };
}

/** Wyciąga pierwszy obraz ze schowka (np. zrzut ekranu wklejony przez Ctrl+V / ⌘V). */
export function extractClipboardImageFile(clipboardData: DataTransfer | null): File | null {
  if (!clipboardData) return null;
  if (clipboardData.items && clipboardData.items.length > 0) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item && item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }
  if (clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const file = clipboardData.files[i];
      if (file && file.type.startsWith("image/")) {
        return file;
      }
    }
  }
  return null;
}

/** Buduje domyślną nazwę pliku dla obrazu wklejonego ze schowka, gdy przeglądarka nie podała nazwy. */
export function resolveUploadedFileName(file: File): string {
  const trimmed = file.name?.trim();
  if (trimmed) return trimmed;
  switch (file.type) {
    case "image/png":
      return "zrzut.png";
    case "image/jpeg":
      return "obraz.jpg";
    case "image/gif":
      return "obraz.gif";
    case "image/webp":
      return "obraz.webp";
    default:
      return "plik";
  }
}
