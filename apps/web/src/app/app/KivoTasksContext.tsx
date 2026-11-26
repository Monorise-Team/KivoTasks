"use client";

import type { KivoTasksClient, Me, Team } from "@kivotasks/client";
import { createContext, useContext } from "react";
import type { TeamCapabilityOverrides } from "./app-views";

export interface CreateIssueDefaults {
  readonly teamId?: string;
  readonly stateId?: string;
  readonly parentId?: string;
  readonly defaultAssignToMe?: boolean;
}

export interface KivoTasksContextValue {
  readonly client: KivoTasksClient;
  readonly me: Me;
  readonly teams: readonly Team[];
  readonly teamsLoading: boolean;
  readonly teamsError: string | null;
  readonly currentTeamKey: string | null;
  readonly capabilityOverrides: TeamCapabilityOverrides;
  readonly issuesRevision: number;
  readonly busy: boolean;
  readonly canRead: boolean;
  readonly canWriteTeam: (teamId?: string | null) => boolean;
  readonly canManageTeamById: (teamId?: string | null) => boolean;
  readonly canCreateTeam: boolean;
  readonly markTeamWriteDenied: (teamId: string) => void;
  readonly markTeamManageDenied: (teamId: string) => void;
  readonly reloadTeams: () => Promise<void>;
  readonly upsertTeam: (team: Team) => void;
  readonly openCreateIssue: (defaults?: CreateIssueDefaults) => void;
  readonly setActiveIssueTeamKey: (teamKey: string | null) => void;
  readonly registerSearchFocus: (focusFn: (() => void) | null) => void;
  readonly bumpIssuesRevision: () => void;
  readonly refreshSession: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

export const KivoTasksContext = createContext<KivoTasksContextValue | null>(null);

export function useKivoTasks(): KivoTasksContextValue {
  const value = useContext(KivoTasksContext);
  if (!value) {
    throw new Error("useKivoTasks wymaga kontekstu KivoTasksApp.");
  }
  return value;
}
