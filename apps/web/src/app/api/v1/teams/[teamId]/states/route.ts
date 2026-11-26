import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { createWorkflowState, listWorkflowStates } from "@/server/teams-service";

export const dynamic = "force-dynamic";

export const GET = route<{ teamId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const teamId = parseUuidParam(params.teamId, "teamId", "Niepoprawny identyfikator zespołu");
  return listWorkflowStates(caller, teamId);
});

export const POST = route<{ teamId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const teamId = parseUuidParam(params.teamId, "teamId", "Niepoprawny identyfikator zespołu");
    return createWorkflowState(caller, teamId, await readJson(request));
  },
  { status: 201 },
);
