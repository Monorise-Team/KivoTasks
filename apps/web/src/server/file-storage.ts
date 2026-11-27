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

interface CachedS3Client {
  readonly signature: string;
  readonly client: S3Client;
}

const processGlobal = globalThis as typeof globalThis & {
  __kivotasksS3Client?: CachedS3Client;
};

function currentClientSignature(): string {
  return JSON.stringify([
    config.s3Endpoint,
    config.s3Region,
    config.s3ForcePathStyle,
    config.s3AccessKeyId,
    config.s3SecretAccessKey,
  ]);
}

function getS3Client(): S3Client {
  const signature = currentClientSignature();
  if (processGlobal.__kivotasksS3Client?.signature === signature) {
    return processGlobal.__kivotasksS3Client.client;
  }

  processGlobal.__kivotasksS3Client?.client.destroy();

  const clientConfig: S3ClientConfig = {
    region: config.s3Region,
    forcePathStyle: config.s3ForcePathStyle,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
  };

  if (config.s3AccessKeyId && config.s3SecretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    };
  }

  const client = new S3Client(clientConfig);
  processGlobal.__kivotasksS3Client = { signature, client };
  return client;
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

function describeStorageError(error: unknown): string {
  if (!error || typeof error !== "object") return "UnknownError";
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof record.name === "string" && record.name ? record.name : "StorageError";
  const httpStatus = record.$metadata?.httpStatusCode;
  return typeof httpStatus === "number" ? `${name} (HTTP ${httpStatus})` : name;
}

function mapStorageError(operation: string, error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  console.warn(`[kivotasks.storage] Błąd operacji ${operation} (${describeStorageError(error)}).`);
  return new ApiFailure(503, "INTERNAL_ERROR", STORAGE_UNAVAILABLE_MESSAGE);
}

/** Zapisuje obiekt w magazynie S3 pod zadanym kluczem. */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: config.s3Bucket,
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
export async function getObject(key: string): Promise<StoredObjectStream> {
  try {
    const response = await getS3Client().send(
      new GetObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
      }),
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
    throw mapStorageError("getObject", error);
  }
}

/** Usuwa obiekt z magazynu S3 pod wskazanym kluczem. */
export async function deleteObject(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
      }),
    );
  } catch (error) {
    throw mapStorageError("deleteObject", error);
  }
}
