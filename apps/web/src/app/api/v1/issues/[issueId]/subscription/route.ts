import { parseUuidParam, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { subscribeIssue, unsubscribeIssue } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const PUT = route<{ issueId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
  return subscribeIssue(caller, issueId);
});

export const DELETE = route<{ issueId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
    await unsubscribeIssue(caller, issueId);
  },
  { status: 204 },
);
