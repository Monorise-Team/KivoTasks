import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { deleteIssue, getIssue, updateIssue } from "@/server/issues-service";

export const dynamic = "force-dynamic";

export const GET = route<{ issueId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  return getIssue(caller, params.issueId);
});

export const PATCH = route<{ issueId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
  return updateIssue(caller, issueId, await readJson(request));
});

export const DELETE = route<{ issueId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
    await deleteIssue(caller, issueId);
  },
  { status: 204 },
);
