import "server-only";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { ApiFailure } from "./api";
import { config } from "./config";

export const STORAGE_UNAVAILABLE_MESSAGE = "Magazyn plików jest chwilowo niedostępny";

/** Limit nawiązania połączenia z S3/MinIO w ms. */
export const S3_CONNECTION_TIMEOUT_MS = 3_000;

/** Limit czasu pojedynczego żądania S3/MinIO w ms. */
export const S3_REQUEST_TIMEOUT_MS = 60_000;

/** Maksymalna liczba prób SDK przy operacjach S3/MinIO. */
export const S3_MAX_ATTEMPTS = 2;

/** Limit czasu best-effort usuwania obiektu S3/MinIO w ms. */
export const S3_DELETE_TIMEOUT_MS = 5_000;

export interface RawS3ConfigInput {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly bucketExplicitlySet: boolean;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly nodeEnv: string | undefined;
}

export type S3ConfigDecision =
  | {
      readonly ok: true;
      readonly bucket: string;
      readonly clientConfig: S3ClientConfig;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * Waliduje konfigurację S3 i buduje opcje `S3Client`:
 * - odrzuca częściowo ustawione poświadczenia statyczne (tylko klucz albo tylko sekret),
 * - w produkcji (`NODE_ENV === "production"`) wymaga jawnie ustawionego `KIVOTASKS_S3_BUCKET`,
 * - ustawia limity czasu połączenia i żądania oraz liczbę prób.
 */
export function resolveS3RuntimeConfig(input: RawS3ConfigInput): S3ConfigDecision {
  const hasAccessKey = input.accessKeyId.length > 0;
  const hasSecretKey = input.secretAccessKey.length > 0;
  if (hasAccessKey !== hasSecretKey) {
    return {
      ok: false,
      reason:
        "Ustawiono tylko jedną ze zmiennych KIVOTASKS_S3_ACCESS_KEY_ID / KIVOTASKS_S3_SECRET_ACCESS_KEY; ustaw obie albo pozostaw obie puste dla domyślnego łańcucha poświadczeń.",
    };
  }

  if (input.nodeEnv === "production" && (!input.bucketExplicitlySet || input.bucket.length === 0)) {
    return {
      ok: false,
      reason: "W środowisku produkcyjnym zmienna KIVOTASKS_S3_BUCKET musi być jawnie ustawiona.",
    };
  }

  const clientConfig: S3ClientConfig = {
    region: input.region,
    forcePathStyle: input.forcePathStyle,
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
    },
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(hasAccessKey && hasSecretKey
      ? {
          credentials: {
            accessKeyId: input.accessKeyId,
            secretAccessKey: input.secretAccessKey,
          },
        }
      : {}),
  };

  return { ok: true, bucket: input.bucket, clientConfig };
}

interface CachedS3Client {
  readonly signature: string;
  readonly client: S3Client;
}

const processGlobal = globalThis as typeof globalThis & {
  __kivotasksS3Client?: CachedS3Client;
};

function currentClientSignature(input: RawS3ConfigInput): string {
  return JSON.stringify([
    input.endpoint,
    input.region,
    input.bucket,
    input.bucketExplicitlySet,
    input.forcePathStyle,
    input.accessKeyId,
    input.secretAccessKey,
    input.nodeEnv ?? "",
  ]);
}

function getS3ClientAndBucket(): { client: S3Client; bucket: string } {
  const rawInput: RawS3ConfigInput = {
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    bucketExplicitlySet: Boolean(process.env.KIVOTASKS_S3_BUCKET?.trim()),
    forcePathStyle: config.s3ForcePathStyle,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    nodeEnv: process.env.NODE_ENV,
  };

  const decision = resolveS3RuntimeConfig(rawInput);
  if (!decision.ok) {
    console.error(`[kivotasks.storage] Błąd konfiguracji S3: ${decision.reason}`);
    throw new ApiFailure(503, "INTERNAL_ERROR", STORAGE_UNAVAILABLE_MESSAGE);
  }

  const signature = currentClientSignature(rawInput);
  if (processGlobal.__kivotasksS3Client?.signature === signature) {
    return { client: processGlobal.__kivotasksS3Client.client, bucket: decision.bucket };
  }

  processGlobal.__kivotasksS3Client?.client.destroy();

  const client = new S3Client(decision.clientConfig);
  processGlobal.__kivotasksS3Client = { signature, client };
  return { client, bucket: decision.bucket };
}

/** Zamyka i resetuje buforowanego klienta S3 (np. przy sprzątaniu w testach). */
export function resetFileStorageClient(): void {
  processGlobal.__kivotasksS3Client?.client.destroy();
  delete processGlobal.__kivotasksS3Client;
}

function isNotFoundS3Error(error: unknown): boolean {
  if (error instanceof NoSuchKey) return true;
  if (!error || typeof error !== "object") return false;
  const record = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (record.name === "NoSuchKey" || record.name === "NotFound") return true;
  if (record.Code === "NoSuchKey" || record.Code === "NotFound") return true;
  if (record.$metadata?.httpStatusCode === 404) return true;
  return false;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function describeStorageError(error: unknown): string {
  if (!error || typeof error !== "object") return "UnknownError";
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof record.name === "string" && record.name ? record.name : "StorageError";
  const httpStatus = record.$metadata?.httpStatusCode;
  return typeof httpStatus === "number" ? `${name} (HTTP ${httpStatus})` : name;
}

function mapStorageError(operation: string, error: unknown, quiet = false): ApiFailure {
  if (error instanceof ApiFailure) return error;
  if (!quiet) {
    console.warn(`[kivotasks.storage] Błąd operacji ${operation} (${describeStorageError(error)}).`);
  }
  return new ApiFailure(503, "INTERNAL_ERROR", STORAGE_UNAVAILABLE_MESSAGE);
}

/** Zapisuje obiekt w magazynie S3 pod zadanym kluczem. */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  try {
    const { client, bucket } = getS3ClientAndBucket();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  } catch (error) {
    throw mapStorageError("putObject", error);
  }
}

export interface StoredObjectStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength: number | null;
}

/** Pobiera strumień bajtów obiektu z magazynu S3; brak obiektu zwraca `404 NOT_FOUND`. */
export async function getObject(
  key: string,
  options?: { readonly abortSignal?: AbortSignal },
): Promise<StoredObjectStream> {
  try {
    const { client, bucket } = getS3ClientAndBucket();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
      options?.abortSignal ? { abortSignal: options.abortSignal } : undefined,
    );
    if (!response.Body) {
      throw new ApiFailure(503, "INTERNAL_ERROR", STORAGE_UNAVAILABLE_MESSAGE);
    }
    const stream = response.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    const contentLength = typeof response.ContentLength === "number" ? response.ContentLength : null;
    return { body: stream, contentLength };
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if (isNotFoundS3Error(error)) {
      throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono załącznika");
    }
    const clientAborted = Boolean(options?.abortSignal?.aborted && isAbortError(error));
    throw mapStorageError("getObject", error, clientAborted);
  }
}

/** Usuwa obiekt z magazynu S3 pod wskazanym kluczem (z krótkim limitem czasu dla operacji best-effort). */
export async function deleteObject(key: string): Promise<void> {
  try {
    const { client, bucket } = getS3ClientAndBucket();
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
      { abortSignal: AbortSignal.timeout(S3_DELETE_TIMEOUT_MS) },
    );
  } catch (error) {
    throw mapStorageError("deleteObject", error);
  }
}
