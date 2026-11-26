import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { updateTeam } from "@/server/teams-service";

export const dynamic = "force-dynamic";

export const PATCH = route<{ teamId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const teamId = parseUuidParam(params.teamId, "teamId", "Niepoprawny identyfikator zespołu");
  return updateTeam(caller, teamId, await readJson(request));
});
