import { readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { createTeam, listTeams } from "@/server/teams-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  return listTeams(caller);
});

export const POST = route(
  async ({ request }) => {
    const caller = await requireUser(request);
    return createTeam(caller, await readJson(request));
  },
  { status: 201 },
);
