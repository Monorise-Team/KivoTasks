import { route } from "@/server/api";
import { getStorageUsage } from "@/server/attachments-service";
import { requireUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  return getStorageUsage(caller);
});
