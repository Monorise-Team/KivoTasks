import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { deleteIssueComment, updateIssueComment } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const PATCH = route<{ issueId: string; commentId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
  const commentId = parseUuidParam(params.commentId, "commentId", "Niepoprawny identyfikator komentarza");
  return updateIssueComment(caller, issueId, commentId, await readJson(request));
});

export const DELETE = route<{ issueId: string; commentId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
    const commentId = parseUuidParam(params.commentId, "commentId", "Niepoprawny identyfikator komentarza");
    await deleteIssueComment(caller, issueId, commentId);
  },
  { status: 204 },
);
