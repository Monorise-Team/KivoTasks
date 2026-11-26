"use client";

import { ApiError, createClient, type Me, type Team } from "@kivotasks/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "@monorise-team/ui";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AUTH_ERROR_MESSAGES,
  canCreateTeams,
  canManageTeam,
  canReadIssues,
  canWriteIssues,
  formatApiError,
  parseAppRoute,
  resolveAccessDenialMessage,
} from "./app-views";
import { CreateIssueDialog } from "./components/CreateIssueDialog";
import { KivoTasksContext, type CreateIssueDefaults, type KivoTasksContextValue } from "./KivoTasksContext";
import { KivoTasksShell } from "./KivoTasksShell";
import { LoadErrorView, LoadingView, NoAccessView, SignedOutView } from "./SignedOutView";

/** Aplikacja KivoTasks w przeglądarce: sesja BFF w ciasteczku HttpOnly i wspólne API `/api/v1`. */
export function KivoTasksApp({ children }: { children?: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <TooltipProvider>
          <KivoTasksContent>{children}</KivoTasksContent>
        </TooltipProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

function KivoTasksContent({ children }: { children?: ReactNode }) {
  const client = useMemo(() => createClient(), []);
  const pathname = usePathname();
  const route = useMemo(() => parseAppRoute(pathname), [pathname]);

  const [me, setMe] = useState<Me | null>(null);
  const [authState, setAuthState] = useState<"loading" | "signed-out" | "signed-in" | "error">("loading");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsError, setTeamsError] = useState<string | null>(null);

  const [deniedWriteTeamIds, setDeniedWriteTeamIds] = useState<Set<string>>(() => new Set());
  const [deniedManageTeamIds, setDeniedManageTeamIds] = useState<Set<string>>(() => new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [createDefaults, setCreateDefaults] = useState<CreateIssueDefaults>({});
  const [activeIssueTeamKey, setActiveIssueTeamKey] = useState<string | null>(null);
  const [issuesRevision, setIssuesRevision] = useState(0);
  const [searchFocusHolder, setSearchFocusHolder] = useState<{ fn: (() => void) | null }>({ fn: null });

  const routeTeamKey =
    route.kind === "team-issues" || route.kind === "team-board" || route.kind === "team-settings"
      ? route.teamKey
      : null;

  const loadTeams = useCallback(async () => {
    setTeamsLoading(true);
    setTeamsError(null);
    try {
      const result = await client.teams.list();
      setTeams(result.teams);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      if (error instanceof ApiError && error.status === 403) {
        setTeams([]);
        return;
      }
      setTeamsError(formatApiError(error, "Nie udało się pobrać listy zespołów."));
    } finally {
      setTeamsLoading(false);
    }
  }, [client]);

  const reload = useCallback(async () => {
    setAuthState("loading");
    setAuthError(null);
    try {
      const profile = await client.session.me();
      setMe(profile);
      setDeniedWriteTeamIds(new Set());
      setDeniedManageTeamIds(new Set());
      setAuthState("signed-in");
      if (!resolveAccessDenialMessage(profile.capabilities)) {
        void loadTeams();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      setAuthError(formatApiError(error, "Nie udało się połączyć z serwerem KivoTasks."));
      setAuthState("error");
    }
  }, [client, loadTeams]);

  const refreshSession = useCallback(async () => {
    setActionError(null);
    try {
      const profile = await client.session.me();
      setMe(profile);
      setDeniedWriteTeamIds(new Set());
      setDeniedManageTeamIds(new Set());
      if (!resolveAccessDenialMessage(profile.capabilities)) {
        await loadTeams();
      }
      setIssuesRevision((prev) => prev + 1);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      setActionError(formatApiError(error, "Nie udało się odświeżyć danych."));
    }
  }, [client, loadTeams]);

  useEffect(() => {
    let cancelled = false;
    const reason = new URLSearchParams(window.location.search).get("auth_error");
    client.session.me().then(
      (profile) => {
        if (cancelled) return;
        setMe(profile);
        setAuthState("signed-in");
        if (!resolveAccessDenialMessage(profile.capabilities)) {
          void loadTeams();
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setMe(null);
          if (reason) {
            setAuthError(AUTH_ERROR_MESSAGES[reason] ?? AUTH_ERROR_MESSAGES.failed ?? "Nie udało się zalogować.");
          }
          setAuthState("signed-out");
          return;
        }
        setAuthError(formatApiError(error, "Nie udało się połączyć z serwerem KivoTasks."));
        setAuthState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, loadTeams]);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await client.session.signOut();
      setMe(null);
      setTeams([]);
      setActionError(null);
      setAuthState("signed-out");
    } finally {
      setBusy(false);
    }
  }, [client]);

  const upsertTeam = useCallback((updated: Team) => {
    setTeams((prev) => {
      const exists = prev.some((item) => item.id === updated.id);
      const next = exists ? prev.map((item) => (item.id === updated.id ? updated : item)) : [...prev, updated];
      return next.sort((a, b) => a.name.localeCompare(b.name, "pl") || a.key.localeCompare(b.key));
    });
  }, []);

  const markTeamWriteDenied = useCallback((teamId: string) => {
    setDeniedWriteTeamIds((prev) => {
      if (prev.has(teamId)) return prev;
      const next = new Set(prev);
      next.add(teamId);
      return next;
    });
  }, []);

  const markTeamManageDenied = useCallback((teamId: string) => {
    setDeniedManageTeamIds((prev) => {
      if (prev.has(teamId)) return prev;
      const next = new Set(prev);
      next.add(teamId);
      return next;
    });
  }, []);

  const openCreateIssue = useCallback((defaults: CreateIssueDefaults = {}) => {
    setCreateDefaults(defaults);
    setCreateOpen(true);
  }, []);

  const registerSearchFocus = useCallback((focusFn: (() => void) | null) => {
    setSearchFocusHolder({ fn: focusFn });
  }, []);

  const focusRegisteredSearch = useCallback(() => {
    if (searchFocusHolder.fn) {
      searchFocusHolder.fn();
      return true;
    }
    return false;
  }, [searchFocusHolder]);

  const bumpIssuesRevision = useCallback(() => {
    setIssuesRevision((prev) => prev + 1);
  }, []);

  const dismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const capabilityOverrides = useMemo(
    () => ({ deniedWriteTeamIds, deniedManageTeamIds }),
    [deniedWriteTeamIds, deniedManageTeamIds],
  );

  const currentTeamKey = routeTeamKey ?? (route.kind === "issue-detail" ? activeIssueTeamKey : null);

  const contextValue = useMemo<KivoTasksContextValue | null>(() => {
    if (!me) return null;
    return {
      client,
      me,
      teams,
      teamsLoading,
      teamsError,
      currentTeamKey,
      capabilityOverrides,
      issuesRevision,
      busy,
      canRead: canReadIssues(me.capabilities),
      canWriteTeam: (teamId) => canWriteIssues(me.capabilities, teamId, capabilityOverrides),
      canManageTeamById: (teamId) => canManageTeam(me.capabilities, teamId, capabilityOverrides),
      canCreateTeam: canCreateTeams(me.capabilities),
      markTeamWriteDenied,
      markTeamManageDenied,
      reloadTeams: loadTeams,
      upsertTeam,
      openCreateIssue,
      setActiveIssueTeamKey,
      registerSearchFocus,
      bumpIssuesRevision,
      refreshSession,
      signOut,
    };
  }, [
    client,
    me,
    teams,
    teamsLoading,
    teamsError,
    currentTeamKey,
    capabilityOverrides,
    issuesRevision,
    busy,
    markTeamWriteDenied,
    markTeamManageDenied,
    loadTeams,
    upsertTeam,
    openCreateIssue,
    registerSearchFocus,
    bumpIssuesRevision,
    refreshSession,
    signOut,
  ]);

  if (authState === "loading") {
    return <LoadingView />;
  }

  if (authState === "signed-out") {
    return <SignedOutView authError={authError} />;
  }

  if (authState === "error" || !me || !contextValue) {
    return <LoadErrorView error={authError} onRetry={() => void reload()} />;
  }

  const accessDenialMessage = resolveAccessDenialMessage(me.capabilities);
  if (accessDenialMessage) {
    return (
      <NoAccessView
        me={me}
        message={accessDenialMessage}
        busy={busy}
        onRetry={() => void reload()}
        onSignOut={() => void signOut()}
      />
    );
  }

  return (
    <KivoTasksContext.Provider value={contextValue}>
      <KivoTasksShell
        actionError={actionError}
        onDismissActionError={dismissActionError}
        onFocusSearch={focusRegisteredSearch}
      >
        {children}
      </KivoTasksShell>
      <CreateIssueDialog open={createOpen} onOpenChange={setCreateOpen} defaults={createDefaults} />
    </KivoTasksContext.Provider>
  );
}
