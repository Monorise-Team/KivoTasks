import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { searchIssues } from "@/server/issues-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  return searchIssues(caller, request.nextUrl.searchParams);
});
