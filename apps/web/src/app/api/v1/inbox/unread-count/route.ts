import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { getInboxUnreadCount } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  return getInboxUnreadCount(caller);
});
