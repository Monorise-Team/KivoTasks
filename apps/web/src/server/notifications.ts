import "server-only";
import { CoreApiError, type CoreClient } from "@monorise-team/sdk";
import type { IssueDetail, TeamMember } from "@kivotasks/contracts";
import type { Caller } from "./auth";
import { config } from "./config";
import { getMachineCoreClient } from "./core";
import { CoreMachineTokenError } from "./core-machine";

/** Kategoria powiadomień e-mail MonoriseCore o przypisaniu zadania w KivoTasks (ADR-0048). */
export const KIVOTASKS_ASSIGNMENT_NOTIFICATION_CATEGORY = "kivotasks.assignments" as const;

/** Krótki limit czasu dla best-effort zlecenia powiadomienia do MonoriseCore (ms). */
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 3_000;

export interface AssignmentNotificationMessageInput {
  identifier: string;
  issueTitle: string;
  teamName: string;
  actorName?: string | null;
}

export interface AssignmentNotificationMessage {
  title: string;
  body: string;
}

/**
 * Buduje neutralną płciowo polską treść powiadomienia o przypisaniu zadania.
 * Pomija zdanie z osobą przypisującą, gdy jej imię i nazwisko nie są dostępne.
 */
export function buildAssignmentNotificationMessage(
  input: AssignmentNotificationMessageInput,
): AssignmentNotificationMessage {
  const identifier = input.identifier.trim();
  const issueTitle = input.issueTitle.trim();
  const teamName = input.teamName.trim();
  const actorName = input.actorName?.trim() ?? "";

  const title = `Nowe zadanie dla Ciebie: ${identifier}`;
  const mainSentence = teamName ? `Zadanie „${issueTitle}” w zespole ${teamName}.` : `Zadanie „${issueTitle}”.`;
  const body = actorName ? `${mainSentence} Przypisanie: ${actorName}.` : mainSentence;

  return { title, body };
}

/**
 * Buduje adres zadania na originie aplikacji KivoTasks (`KIVOTASKS_APP_URL`), np.
 * `http://kivotasks.localhost:3500/issue/MAG-3`. Zwraca `null`, gdy adres bazowy jest niepoprawny.
 */
export function buildIssueActionUrl(appUrl: string, identifier: string): string | null {
  try {
    const parsed = new URL(appUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const normalizedIdentifier = identifier.trim();
    if (!normalizedIdentifier) {
      return null;
    }
    return `${parsed.origin}/issue/${encodeURIComponent(normalizedIdentifier)}`;
  } catch {
    return null;
  }
}

/**
 * Deterministyczny klucz idempotencji (`Idempotency-Key`, 1–255 drukowalnych znaków ASCII)
 * dla zlecenia powiadomienia o przypisaniu zadania, dzięki czemu ponowienia żądania nie wyślą duplikatu.
 */
export function buildAssignmentNotificationIdempotencyKey(params: {
  issueId: string;
  assigneeAccountId: string;
  updatedAt: string;
}): string {
  return `kivotasks:issue-assigned:${params.issueId}:${params.assigneeAccountId}:${params.updatedAt}`;
}

/**
 * Rozstrzyga, czy należy wysłać powiadomienie o przypisaniu: tylko dla nowej osoby innej niż sprawca zmiany.
 */
export function shouldNotifyIssueAssignment(params: {
  previousAssigneeAccountId: string | null;
  nextAssigneeAccountId: string | null;
  actorAccountId: string;
}): boolean {
  if (!params.nextAssigneeAccountId) return false;
  if (params.nextAssigneeAccountId === params.previousAssigneeAccountId) return false;
  if (params.nextAssigneeAccountId === params.actorAccountId) return false;
  return true;
}

/**
 * Odczytuje imię i nazwisko osoby przypisującej z danych już dostępnych w żądaniu
 * (profil sesji BFF albo lista członków zespołu pobrana z Core Directory).
 */
export function resolveAssignmentActorName(
  caller: Pick<Caller, "accountId" | "session">,
  teamMembers: readonly TeamMember[],
): string | null {
  const fromSession = caller.session?.profile.name?.trim();
  if (fromSession) return fromSession;

  const member = teamMembers.find((item) => item.accountId === caller.accountId);
  if (member) {
    const fullName = `${member.firstName} ${member.lastName}`.trim();
    if (fullName) return fullName;
  }

  return null;
}

function describeNotificationError(error: unknown): string {
  if (error instanceof CoreApiError) {
    return `CoreApiError (HTTP ${error.status}, ${error.code}, requestId=${error.requestId})`;
  }
  if (error instanceof CoreMachineTokenError) {
    const parts = [error.status !== undefined ? `HTTP ${error.status}` : null, error.code ?? null].filter(Boolean);
    return parts.length > 0 ? `CoreMachineTokenError (${parts.join(", ")})` : "CoreMachineTokenError";
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "UnknownError";
}

export interface NotifyIssueAssignedParams {
  organizationId: string;
  recipientAccountId: string;
  issue: Pick<IssueDetail, "id" | "identifier" | "title" | "updatedAt">;
  teamName: string;
  actorName?: string | null;
}

export interface NotifyIssueAssignedOptions {
  core?: Pick<CoreClient, "sendNotification">;
  appUrl?: string;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

/**
 * Zleca powiadomienie e-mail o przypisaniu zadania przez MonoriseCore (`kivotasks.assignments`)
 * w trybie best-effort: z krótkim limitem czasu, polityką ponawiania SDK i deterministycznym
 * nagłówkiem `Idempotency-Key`. Błąd Core nigdy nie przerywa żądania użytkownika i nie trafia
 * do logów z danymi osobowymi ani tokenami.
 */
export async function notifyIssueAssigned(
  params: NotifyIssueAssignedParams,
  options: NotifyIssueAssignedOptions = {},
): Promise<void> {
  const core = options.core ?? getMachineCoreClient();
  const appUrl = options.appUrl ?? config.appUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const { title, body } = buildAssignmentNotificationMessage({
    identifier: params.issue.identifier,
    issueTitle: params.issue.title,
    teamName: params.teamName,
    actorName: params.actorName,
  });
  const actionUrl = buildIssueActionUrl(appUrl, params.issue.identifier);
  const idempotencyKey = buildAssignmentNotificationIdempotencyKey({
    issueId: params.issue.id,
    assigneeAccountId: params.recipientAccountId,
    updatedAt: params.issue.updatedAt,
  });

  try {
    await core.sendNotification({
      path: { organizationId: params.organizationId },
      body: {
        recipientAccountId: params.recipientAccountId,
        category: KIVOTASKS_ASSIGNMENT_NOTIFICATION_CATEGORY,
        title,
        body,
        ...(actionUrl ? { actionUrl } : {}),
      },
      headers: { "Idempotency-Key": idempotencyKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    warn(
      `[kivotasks.notifications] Nie udało się wysłać powiadomienia o przypisaniu zadania ${params.issue.identifier} (${describeNotificationError(error)}).`,
    );
  }
}
