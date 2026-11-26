import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { deleteWorkflowState, updateWorkflowState } from "@/server/teams-service";

export const dynamic = "force-dynamic";

export const PATCH = route<{ teamId: string; stateId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const teamId = parseUuidParam(params.teamId, "teamId", "Niepoprawny identyfikator zespołu");
  const stateId = parseUuidParam(params.stateId, "stateId", "Niepoprawny identyfikator statusu");
  return updateWorkflowState(caller, teamId, stateId, await readJson(request));
});

export const DELETE = route<{ teamId: string; stateId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const teamId = parseUuidParam(params.teamId, "teamId", "Niepoprawny identyfikator zespołu");
    const stateId = parseUuidParam(params.stateId, "stateId", "Niepoprawny identyfikator statusu");
    await deleteWorkflowState(caller, teamId, stateId);
  },
  { status: 204 },
);
