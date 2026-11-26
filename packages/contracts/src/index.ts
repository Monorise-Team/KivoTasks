/**
 * Kontrakt API KivoTasks (`https://kivo.monorise.studio/api/v1`): schematy i typy wspólne dla serwera
 * i przeglądarki. Format odpowiedzi jak w standardzie API Monorise: `{ data, meta, error }`.
 */
import { z } from "zod";

export const API_PREFIX = "/api/v1";

// ── Odpowiedzi i błędy ──────────────────────────────────────────────────────

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "PRODUCT_ACCESS_REQUIRED",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorDetail = z.object({
  field: z.string().optional(),
  message: z.string(),
});
export type ApiErrorDetail = z.infer<typeof ApiErrorDetail>;

export const ApiErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.array(ApiErrorDetail),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const ApiMeta = z.object({
  requestId: z.string(),
});
export type ApiMeta = z.infer<typeof ApiMeta>;

/** Koperta udanej odpowiedzi API KivoTasks: `{ data, meta, error: null }` (ADR-0044). */
export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    meta: ApiMeta,
    error: z.null(),
  });
}

/** Koperta odpowiedzi błędu API KivoTasks: `{ data: null, meta, error }` (ADR-0044). */
export function apiErrorSchema<T extends z.ZodType = typeof ApiErrorBody>(error?: T) {
  return z.object({
    data: z.null(),
    meta: ApiMeta,
    error: (error ?? ApiErrorBody) as T,
  });
}

export const ApiErrorResponse = apiErrorSchema();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponse>;

export interface ApiResponse<T> {
  data: T | null;
  meta: { requestId?: string; [key: string]: unknown };
  error: ApiErrorBody | null;
}

export const Health = z.object({
  status: z.literal("ok"),
  version: z.string().nullable(),
});
export type Health = z.infer<typeof Health>;

// ── Zalogowana osoba i firma (z MonoriseCore) ───────────────────────────────

export const Capabilities = z.object({
  hasProductAccess: z.boolean(),
  readIssues: z.boolean(),
  writeIssues: z.boolean(),
  manageTeams: z.boolean(),
  manageProjects: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const Me = z.object({
  account: z.object({
    id: z.string(),
    email: z.string(),
  }),
  employee: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string(),
    jobTitle: z.string().nullable(),
  }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
  }),
  capabilities: Capabilities,
});
export type Me = z.infer<typeof Me>;

export * from "./permissions.js";
