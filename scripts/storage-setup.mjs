#!/usr/bin/env node
/**
 * Czeka na gotowość lokalnego magazynu plików MinIO (`/minio/health/ready`, maks. ~30 s)
 * i tworzy brakujące zasobniki (bucket): deweloperski oraz testowy (`kivo-tasks-attachments-test`).
 * Odczytuje ustawienia ze zmiennych środowiskowych albo `apps/web/.env.local` z lokalnymi wartościami domyślnymi.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const requireFromWeb = createRequire(join(root, "apps/web/package.json"));
const { CreateBucketCommand, S3Client } = requireFromWeb("@aws-sdk/client-s3");

function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const fileEnv = readEnvFile(join(root, "apps/web/.env.local"));
const env = (key, fallback) => {
  const value = process.env[key]?.trim() || fileEnv[key]?.trim();
  return value || fallback;
};

const endpoint = env("KIVOTASKS_S3_ENDPOINT", "http://127.0.0.1:9036").replace(/\/+$/, "");
const region = env("KIVOTASKS_S3_REGION", "eu-central-1");
const devBucket = env("KIVOTASKS_S3_BUCKET", "kivo-tasks-attachments");
const testBucket = env("KIVOTASKS_TEST_S3_BUCKET", "kivo-tasks-attachments-test");
const accessKeyId = env("KIVOTASKS_S3_ACCESS_KEY_ID", "kivo_tasks_storage");
const secretAccessKey = env("KIVOTASKS_S3_SECRET_ACCESS_KEY", "kivo_tasks_storage_local");
const forcePathStyle = env("KIVOTASKS_S3_FORCE_PATH_STYLE", "true").toLowerCase() !== "false";

async function waitForReady(healthUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // MinIO wciąż się uruchamia
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`MinIO nie odpowiedział na ${healthUrl} w ciągu ${Math.round(timeoutMs / 1000)} s.`);
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Utworzono zasobnik: ${bucket}`);
  } catch (error) {
    const code = error?.name ?? error?.Code ?? "";
    if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") {
      console.log(`Zasobnik już istnieje: ${bucket}`);
      return;
    }
    throw error;
  }
}

await waitForReady(`${endpoint}/minio/health/ready`);

const client = new S3Client({
  endpoint,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
});

try {
  const buckets = [...new Set([devBucket, testBucket])];
  for (const bucket of buckets) {
    await ensureBucket(client, bucket);
  }
} finally {
  client.destroy();
}
