import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "./generated/prisma/client.js";

export { IssueRelationType, Prisma, PrismaClient, WorkflowStateCategory } from "./generated/prisma/client.js";
export type * from "./generated/prisma/models.js";
export { uuidv7 } from "./ids.js";

/** Klient transakcji: to samo API co PrismaClient, bez metod sterujących połączeniem. */
export type Tx = Prisma.TransactionClient;

export interface CreateDbOptions {
  /** Maksymalna liczba połączeń w puli `pg.Pool` (domyślnie jak w `pg`). */
  max?: number;
}

/**
 * Klient bazy kivo_tasks. Serwer łączy się rolą kivo_tasks_app (bez uprawnień właściciela tabel i bez
 * BYPASSRLS), więc tabele domenowe z RLS są dostępne wyłącznie przez withUser (ADR-0037).
 */
export function createDb(connectionString: string, options?: CreateDbOptions): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      ...(options?.max !== undefined ? { max: options.max } : {}),
    }),
  });
}

/** Kto działa: konto Monorise i jego firma, zawsze z tokenu albo sesji Core, nigdy z treści żądania. */
export interface Actor {
  organizationId: string;
  accountId: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): string {
  if (!UUID_REGEX.test(value)) {
    throw new Error(`Nieprawidłowy UUID w ${label}`);
  }
  return value;
}

/**
 * Działanie w imieniu osoby z firmy. Ustawia zmienne transakcji `app.organization_id` i `app.account_id`,
 * z których korzystają polityki RLS; po transakcji wartości znikają, więc nie przeciekają między
 * połączeniami z puli.
 */
export async function withUser<T>(db: PrismaClient, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const organizationId = assertUuid(actor.organizationId, "actor.organizationId");
  const accountId = assertUuid(actor.accountId, "actor.accountId");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true),
                                set_config('app.account_id', ${accountId}, true)`;
    return fn(tx);
  });
}
