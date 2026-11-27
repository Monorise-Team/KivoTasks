import { parseUuidParam, route } from "@/server/api";
import { getAttachmentContent } from "@/server/attachments-service";
import { requireUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export const GET = route<{ attachmentId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const attachmentId = parseUuidParam(params.attachmentId, "attachmentId", "Niepoprawny identyfikator załącznika");
  return getAttachmentContent(caller, attachmentId, request);
});
