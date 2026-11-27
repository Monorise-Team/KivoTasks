import { paginated, parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { createIssueComment, listIssueComments } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const GET = route<{ issueId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
  const page = await listIssueComments(caller, issueId, request.nextUrl.searchParams);
  return paginated(page.items, page.nextCursor);
});

export const POST = route<{ issueId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
    return createIssueComment(caller, issueId, await readJson(request));
  },
  { status: 201 },
);
