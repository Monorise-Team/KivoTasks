import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { createIssueRelation } from "@/server/issues-service";

export const dynamic = "force-dynamic";

export const POST = route<{ issueId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
    return createIssueRelation(caller, issueId, await readJson(request));
  },
  { status: 201 },
);
