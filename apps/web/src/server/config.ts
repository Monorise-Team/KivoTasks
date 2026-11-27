import "server-only";
import { MULTIPART_CONTENT_LENGTH_OVERHEAD_BYTES } from "./attachment-helpers";

const list = (value: string | undefined, fallback = "") =>
  (value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseEventFeedIntervalMs = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const trimmed = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 0;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
};

const parsePositiveSafeInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Limit bufora treści w `apps/web/next.config.ts` (`experimental.proxyClientMaxBodySize: "27mb"`,
 * czyli 27 MiB = 28 311 552 B). Maksymalny rozmiar pliku nie może przekroczyć tej wartości
 * pomniejszonej o narzut nagłówków `multipart/form-data`.
 */
export const PROXY_CLIENT_MAX_BODY_SIZE_BYTES = 27 * 1024 * 1024; // 28_311_552

/** Maksymalny bezpieczny limit pojedynczego załącznika w ramach limitu proxy Next.js. */
export const MAX_ALLOWED_ATTACHMENT_MAX_BYTES =
  PROXY_CLIENT_MAX_BODY_SIZE_BYTES - MULTIPART_CONTENT_LENGTH_OVERHEAD_BYTES;

/** Domyślny maksymalny rozmiar pojedynczego załącznika: 25 MB. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 26_214_400;

/** Domyślny limit miejsca na załączniki firmy: 1 GB (do czasu limitów planów w Core, ADR-0058). */
export const DEFAULT_STORAGE_QUOTA_BYTES = 1_073_741_824;

let attachmentMaxBytesClampWarned = false;

/** Resetuje jednorazowe ostrzeżenie o obcięciu `KIVOTASKS_ATTACHMENT_MAX_BYTES` (do testów). */
export function resetConfigWarningsForTests(): void {
  attachmentMaxBytesClampWarned = false;
}

/** Ustawienia serwera ze zmiennych środowiskowych (lokalnie `.env.local`, tworzy go `pnpm setup:env`). */
export const config = {
  /** Baza kivo_tasks, rola aplikacji kivo_tasks_app (bez omijania RLS). */
  get databaseUrl() {
    return process.env.DATABASE_URL ?? "";
  },
  /** Dodatkowe adresy aplikacji, które mogą wołać API z tokenem. */
  get allowedOrigins() {
    return list(process.env.KIVOTASKS_ALLOWED_ORIGINS);
  },

  // ── Logowanie przez MonoriseCore (ADR-0103) ────────────────────────────────────────────────────────
  /** Serwer logowania Core (wystawca tokenów), np. https://auth.monorise.studio. */
  get coreAuthUrl() {
    return process.env.CORE_AUTH_URL ?? "http://localhost:3100";
  },
  /** Core API, np. https://api.monorise.studio. */
  get coreApiUrl() {
    return process.env.CORE_API_URL ?? "http://localhost:3200";
  },
  /** Aplikacja w przeglądarce (BFF), np. https://kivotasks.monorise.studio. */
  get appUrl() {
    return process.env.KIVOTASKS_APP_URL ?? "http://kivotasks.localhost:3500";
  },
  /** API KivoTasks, odbiorca tokenów z Core, np. https://kivo.monorise.studio. */
  get apiUrl() {
    return process.env.KIVOTASKS_API_URL ?? "http://kivo.localhost:3500";
  },
  get oauthClientId() {
    return process.env.KIVOTASKS_OAUTH_CLIENT_ID ?? "kivotasks-web";
  },
  /** Sekret klienta z Core (lokalnie z `pnpm oauth:seed` w MonoriseCore). */
  get oauthClientSecret() {
    return process.env.KIVOTASKS_OAUTH_CLIENT_SECRET ?? "";
  },
  /** Sekret szyfrujący sesje (co najmniej 32 znaki); przy wymianie „nowy,stary”. */
  get sessionSecrets() {
    return list(process.env.KIVOTASKS_SESSION_SECRET);
  },
  /** Klucze publiczne Core wpisane na stałe (JWKS w JSON) zamiast pobierania z Core: testy. */
  get coreJwks() {
    return process.env.KIVOTASKS_CORE_JWKS ?? "";
  },
  /** Interwał odpytywania kanału zdarzeń Core w ms (0 wyłącza; domyślnie 5000 w development, 0 poza nim). */
  get eventFeedIntervalMs() {
    const fallback = process.env.NODE_ENV === "development" ? 5000 : 0;
    return parseEventFeedIntervalMs(process.env.KIVOTASKS_EVENT_FEED_INTERVAL_MS, fallback);
  },

  // ── Magazyn plików zgodny z S3 (etap 2b, ADR-0103) ────────────────────────────────────────────────
  /** Adres punktu końcowego S3 (pusty = domyślny AWS S3; lokalnie http://127.0.0.1:9036 dla MinIO). */
  get s3Endpoint() {
    return process.env.KIVOTASKS_S3_ENDPOINT?.trim() || "";
  },
  /** Region S3 (domyślnie eu-central-1). */
  get s3Region() {
    return process.env.KIVOTASKS_S3_REGION?.trim() || "eu-central-1";
  },
  /** Nazwa zasobnika (bucket) na załączniki. */
  get s3Bucket() {
    return process.env.KIVOTASKS_S3_BUCKET?.trim() || "kivo-tasks-attachments";
  },
  /** Czy wymuszać adresowanie ścieżkowe S3 (`true` dla lokalnego MinIO, domyślnie `false`). */
  get s3ForcePathStyle() {
    return parseBoolean(process.env.KIVOTASKS_S3_FORCE_PATH_STYLE, false);
  },
  /** Statyczny klucz dostępu S3 (oba puste = domyślny łańcuch poświadczeń AWS, np. rola IAM). */
  get s3AccessKeyId() {
    return process.env.KIVOTASKS_S3_ACCESS_KEY_ID?.trim() || "";
  },
  /** Statyczny sekret dostępu S3 (oba puste = domyślny łańcuch poświadczeń AWS, np. rola IAM). */
  get s3SecretAccessKey() {
    return process.env.KIVOTASKS_S3_SECRET_ACCESS_KEY?.trim() || "";
  },
  /** Maksymalny rozmiar pojedynczego załącznika w bajtach (domyślnie 25 MB; maks. limit proxy minus narzut multipart). */
  get attachmentMaxBytes() {
    const configured = parsePositiveSafeInt(process.env.KIVOTASKS_ATTACHMENT_MAX_BYTES, DEFAULT_ATTACHMENT_MAX_BYTES);
    if (configured > MAX_ALLOWED_ATTACHMENT_MAX_BYTES) {
      if (!attachmentMaxBytesClampWarned) {
        attachmentMaxBytesClampWarned = true;
        console.warn(
          `[kivotasks.config] KIVOTASKS_ATTACHMENT_MAX_BYTES (${configured} B) przekracza limit proxy Next.js (${PROXY_CLIENT_MAX_BODY_SIZE_BYTES} B minus narzut multipart); ograniczono do ${MAX_ALLOWED_ATTACHMENT_MAX_BYTES} B.`,
        );
      }
      return MAX_ALLOWED_ATTACHMENT_MAX_BYTES;
    }
    return configured;
  },
  /** Limit miejsca na załączniki jednej firmy w bajtach (domyślnie 1 GB, ADR-0058). */
  get storageQuotaBytes() {
    return parsePositiveSafeInt(process.env.KIVOTASKS_STORAGE_QUOTA_BYTES, DEFAULT_STORAGE_QUOTA_BYTES);
  },
};
