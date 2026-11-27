import { paginated, parseUuidParam, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { listIssueActivity } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const GET = route<{ issueId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
  const page = await listIssueActivity(caller, issueId, request.nextUrl.searchParams);
  return paginated(page.items, page.nextCursor);
});
