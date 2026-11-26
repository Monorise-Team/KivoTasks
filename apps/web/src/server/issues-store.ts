import "server-only";
import type {
  ColorToken,
  IssueDetail,
  IssueListItem,
  IssueRelationType,
  IssueRelationView,
  IssueSort,
  Label,
  PaginatedResult,
  Team,
  UpdateLabelInput,
  UpdateWorkflowStateInput,
  WorkflowState,
  WorkflowStateCategory,
} from "@kivotasks/contracts";
import type { Actor } from "@kivotasks/db";
import type { IssueCursorPayload } from "./issue-helpers";
import { prismaIssuesStore } from "./issues-store-prisma";
import type { TeamFilterScope } from "./permissions";

export interface CreateIssueStoreInput {
  teamId: string;
  title: string;
  description: string | null;
  stateId?: string;
  priority: number;
  assigneeAccountId: string | null;
  creatorAccountId: string;
  labelIds: string[];
  dueDate: string | null;
  estimate: number | null;
  parentId: string | null;
}

export interface UpdateIssueStoreInput {
  title?: string;
  description?: string | null;
  stateId?: string;
  priority?: number;
  assigneeAccountId?: string | null;
  labelIds?: string[];
  dueDate?: string | null;
  estimate?: number | null;
  parentId?: string | null;
  sortOrder?: number;
}

export type AssigneeStoreFilter = { type: "none" } | { type: "account"; accountId: string };
export type ParentStoreFilter = { type: "none" } | { type: "issue"; issueId: string };

export interface ListIssuesStoreParams {
  readableTeamIds: TeamFilterScope;
  teamId?: string;
  stateId?: string;
  stateCategory?: WorkflowStateCategory;
  assignee?: AssigneeStoreFilter;
  labelId?: string;
  priority?: number;
  parentId?: ParentStoreFilter;
  q?: string;
  identifier?: { key: string; number: number } | null;
  tsQuery?: string | null;
  includeCompleted: boolean;
  sort: IssueSort;
  limit: number;
  cursor?: IssueCursorPayload;
}

export interface SearchIssuesStoreParams {
  readableTeamIds: TeamFilterScope;
  identifier: { key: string; number: number } | null;
  tsQuery: string | null;
  limit: number;
}

export interface IssueLocation {
  id: string;
  teamId: string;
  assigneeAccountId: string | null;
}

export interface IssueRelationRecordInfo {
  id: string;
  issueId: string;
  relatedIssueId: string;
  issueTeamId: string;
  relatedIssueTeamId: string;
}

export type IssueLookup = { type: "id"; id: string } | { type: "identifier"; key: string; number: number };

export interface IssuesStore {
  // Teams
  listTeams(actor: Actor, scope: TeamFilterScope): Promise<Team[]>;
  findTeamById(actor: Actor, teamId: string): Promise<Team | null>;
  listExistingTeamIds(actor: Actor): Promise<string[]>;
  createTeamWithDefaultStates(actor: Actor, input: { id: string; key: string; name: string }): Promise<Team>;
  updateTeamKey(actor: Actor, teamId: string, key: string): Promise<Team | null>;
  updateTeamNames(actor: Actor, updates: readonly { id: string; name: string }[]): Promise<void>;

  // Workflow states
  listWorkflowStates(actor: Actor, teamId: string): Promise<WorkflowState[]>;
  createWorkflowState(
    actor: Actor,
    input: { teamId: string; name: string; category: WorkflowStateCategory; color: ColorToken; position?: number },
  ): Promise<WorkflowState>;
  updateWorkflowState(
    actor: Actor,
    teamId: string,
    stateId: string,
    input: UpdateWorkflowStateInput,
  ): Promise<WorkflowState | null>;
  deleteWorkflowState(actor: Actor, teamId: string, stateId: string): Promise<boolean>;

  // Labels
  listLabels(actor: Actor, teamId: string): Promise<Label[]>;
  createLabel(actor: Actor, input: { teamId: string; name: string; color: ColorToken }): Promise<Label>;
  updateLabel(actor: Actor, teamId: string, labelId: string, input: UpdateLabelInput): Promise<Label | null>;
  deleteLabel(actor: Actor, teamId: string, labelId: string): Promise<boolean>;

  // Issues
  listIssues(actor: Actor, params: ListIssuesStoreParams): Promise<PaginatedResult<IssueListItem>>;
  createIssue(actor: Actor, input: CreateIssueStoreInput): Promise<IssueDetail>;
  findIssueLocationById(actor: Actor, issueId: string): Promise<IssueLocation | null>;
  findIssueDetail(actor: Actor, lookup: IssueLookup, readableTeamIds: TeamFilterScope): Promise<IssueDetail | null>;
  updateIssue(
    actor: Actor,
    issueId: string,
    input: UpdateIssueStoreInput,
    readableTeamIds: TeamFilterScope,
  ): Promise<IssueDetail | null>;
  softDeleteIssue(actor: Actor, issueId: string): Promise<boolean>;

  // Relations
  createIssueRelation(
    actor: Actor,
    input: {
      viewerIssueId: string;
      storedIssueId: string;
      storedRelatedIssueId: string;
      storedType: IssueRelationType;
    },
  ): Promise<IssueRelationView>;
  findIssueRelation(actor: Actor, issueId: string, relationId: string): Promise<IssueRelationRecordInfo | null>;
  deleteIssueRelation(actor: Actor, relationId: string): Promise<boolean>;

  // Search
  searchIssues(actor: Actor, params: SearchIssuesStoreParams): Promise<IssueListItem[]>;
}

export function getIssuesStore(): IssuesStore {
  return prismaIssuesStore;
}
