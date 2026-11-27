import { paginated, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { listInboxItems } from "@/server/collaboration-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  const page = await listInboxItems(caller, request.nextUrl.searchParams);
  return paginated(page.items, page.nextCursor);
});
