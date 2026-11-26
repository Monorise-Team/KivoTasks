import { parseUuidParam, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { listTeamMembers } from "@/server/teams-service";

export const dynamic = "force-dynamic";

export const GET = route<{ teamId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const teamId = parseUuidParam(params.teamId, "teamId", "Niepoprawny identyfikator zespołu");
  return listTeamMembers(caller, teamId);
});
