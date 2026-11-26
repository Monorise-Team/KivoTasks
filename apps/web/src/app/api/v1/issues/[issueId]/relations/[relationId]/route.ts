import { parseUuidParam, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { deleteIssueRelation } from "@/server/issues-service";

export const dynamic = "force-dynamic";

export const DELETE = route<{ issueId: string; relationId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
    const relationId = parseUuidParam(params.relationId, "relationId", "Niepoprawny identyfikator relacji");
    await deleteIssueRelation(caller, issueId, relationId);
  },
  { status: 204 },
);
