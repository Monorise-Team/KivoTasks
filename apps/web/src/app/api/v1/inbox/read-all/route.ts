import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { markAllInboxRead } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request }) => {
  const caller = await requireUser(request);
  return markAllInboxRead(caller);
});
