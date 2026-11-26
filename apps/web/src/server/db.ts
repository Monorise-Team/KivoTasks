import "server-only";
import { createDb, type PrismaClient } from "@kivotasks/db";
import { config } from "./config";

const globalForDb = globalThis as unknown as { kivotasksDb?: PrismaClient };

/**
 * Baza kivo_tasks (PostgreSQL, ADR-0096, ADR-0103). Serwer łączy się rolą kivo_tasks_app, więc tabele
 * domenowe z RLS są dostępne wyłącznie przez withUser z @kivotasks/db (ADR-0037). Jedna pula połączeń
 * na proces, także po przeładowaniu modułów w trybie deweloperskim.
 */
export function getDb(): PrismaClient {
  if (!config.databaseUrl) throw new Error("Brak DATABASE_URL (lokalnie: pnpm setup:env, pnpm db:up, pnpm db:migrate)");
  globalForDb.kivotasksDb ??= createDb(config.databaseUrl);
  return globalForDb.kivotasksDb;
}
