import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { deleteLabel, updateLabel } from "@/server/teams-service";

export const dynamic = "force-dynamic";

export const PATCH = route<{ teamId: string; labelId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const teamId = parseUuidParam(params.teamId, "teamId", "Niepoprawny identyfikator zespołu");
  const labelId = parseUuidParam(params.labelId, "labelId", "Niepoprawny identyfikator etykiety");
  return updateLabel(caller, teamId, labelId, await readJson(request));
});

export const DELETE = route<{ teamId: string; labelId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const teamId = parseUuidParam(params.teamId, "teamId", "Niepoprawny identyfikator zespołu");
    const labelId = parseUuidParam(params.labelId, "labelId", "Niepoprawny identyfikator etykiety");
    await deleteLabel(caller, teamId, labelId);
  },
  { status: 204 },
);
