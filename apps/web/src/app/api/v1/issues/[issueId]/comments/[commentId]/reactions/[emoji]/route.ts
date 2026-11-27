import { parseUuidParam, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { addCommentReaction, removeCommentReaction } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const PUT = route<{ issueId: string; commentId: string; emoji: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
  const commentId = parseUuidParam(params.commentId, "commentId", "Niepoprawny identyfikator komentarza");
  return addCommentReaction(caller, issueId, commentId, params.emoji);
});

export const DELETE = route<{ issueId: string; commentId: string; emoji: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const issueId = parseUuidParam(params.issueId, "issueId", "Niepoprawny identyfikator zadania");
    const commentId = parseUuidParam(params.commentId, "commentId", "Niepoprawny identyfikator komentarza");
    await removeCommentReaction(caller, issueId, commentId, params.emoji);
  },
  { status: 204 },
);
