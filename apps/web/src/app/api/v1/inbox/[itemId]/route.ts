import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { updateInboxItem } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const PATCH = route<{ itemId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const itemId = parseUuidParam(params.itemId, "itemId", "Niepoprawny identyfikator powiadomienia");
  return updateInboxItem(caller, itemId, await readJson(request));
});
