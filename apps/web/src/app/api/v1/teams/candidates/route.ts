import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { listTeamCandidates } from "@/server/teams-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  return listTeamCandidates(caller);
});
