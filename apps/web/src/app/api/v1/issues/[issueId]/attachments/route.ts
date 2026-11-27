import { paginated, parseUuidParam, route } from "@/server/api";
import { listIssueAttachments, uploadIssueAttachment } from "@/server/attachments-service";
import { requireUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export const GET = route<{ issueId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
  const page = await listIssueAttachments(caller, issueId, request.nextUrl.searchParams);
  return paginated(page.items, page.nextCursor);
});

export const POST = route<{ issueId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
    return uploadIssueAttachment(caller, issueId, request);
  },
  { status: 201 },
);
