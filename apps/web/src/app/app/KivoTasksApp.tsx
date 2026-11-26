"use client";

import { ApiError, createClient, type Me } from "@kivotasks/client";
import { Button, Card, EmptyState, ThemeProvider, ToastProvider } from "@monorise-team/ui";
import { ListTodo, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppearanceView } from "./AppearanceView";
import { KivoTasksShell } from "./KivoTasksShell";
import { LoadErrorView, LoadingView, NoAccessView, SignedOutView } from "./SignedOutView";
import {
  AUTH_ERROR_MESSAGES,
  VIEW_HASHES,
  parseViewFromHash,
  resolveAccessDenialMessage,
  type AppView,
} from "./app-views";

function subscribeHash(onStoreChange: () => void): () => void {
  window.addEventListener("hashchange", onStoreChange);
  window.addEventListener("popstate", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

function getHashSnapshot(): string {
  return window.location.hash;
}

function getServerHashSnapshot(): string {
  return "";
}

/** Aplikacja KivoTasks w przeglądarce: sesja BFF w ciasteczku HttpOnly i wspólne API `/api/v1`. */
export function KivoTasksApp() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <KivoTasksContent />
      </ToastProvider>
    </ThemeProvider>
  );
}

function KivoTasksContent() {
  const client = useMemo(() => createClient(), []);
  const hash = useSyncExternalStore(subscribeHash, getHashSnapshot, getServerHashSnapshot);

  const [me, setMe] = useState<Me | null>(null);
  const [authState, setAuthState] = useState<"loading" | "signed-out" | "signed-in" | "error">("loading");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setAuthState("loading");
    setAuthError(null);
    try {
      const profile = await client.session.me();
      setMe(profile);
      setAuthState("signed-in");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      setAuthError(error instanceof Error ? error.message : "Nie udało się połączyć z serwerem KivoTasks.");
      setAuthState("error");
    }
  }, [client]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setActionError(null);
    try {
      const profile = await client.session.me();
      setMe(profile);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      setActionError(error instanceof Error ? error.message : "Nie udało się odświeżyć danych.");
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    const reason = new URLSearchParams(window.location.search).get("auth_error");
    client.session.me().then(
      (profile) => {
        if (cancelled) return;
        setMe(profile);
        setAuthState("signed-in");
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
        setAuthError(error instanceof Error ? error.message : "Nie udało się połączyć z serwerem KivoTasks.");
        setAuthState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const handleSignOut = useCallback(async () => {
    setBusy(true);
    try {
      await client.session.signOut();
      setMe(null);
      setActionError(null);
      setAuthState("signed-out");
    } finally {
      setBusy(false);
    }
  }, [client]);

  const navigateTo = useCallback((view: AppView) => {
    const nextHash = VIEW_HASHES[view];
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }, []);

  const dismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const handleRefreshClick = useCallback(() => {
    void handleRefresh();
  }, [handleRefresh]);

  const handleSignOutClick = useCallback(() => {
    void handleSignOut();
  }, [handleSignOut]);

  if (authState === "loading") {
    return <LoadingView />;
  }

  if (authState === "signed-out") {
    return <SignedOutView authError={authError} />;
  }

  if (authState === "error" || !me) {
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
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  const activeView = parseViewFromHash(hash);

  return (
    <KivoTasksShell
      organizationName={me.organization.name}
      personName={me.employee.fullName}
      view={activeView}
      busy={busy}
      actionError={actionError}
      onDismissActionError={dismissActionError}
      onNavigate={navigateTo}
      onRefresh={handleRefreshClick}
      onSignOut={handleSignOutClick}
    >
      {activeView === "appearance" ? (
        <AppearanceView />
      ) : activeView === "teams" ? (
        <StageEmptyView
          title="Zespoły"
          icon={<Users aria-hidden />}
          emptyTitle="Zespoły pojawią się w etapie 1"
          emptyDescription="Zespoły korzystają z jednostek firmy w MonoriseCore i otrzymają krótkie klucze do numeracji zadań w etapie 1."
          busy={busy}
          refreshing={refreshing}
          onRefresh={handleRefreshClick}
        />
      ) : (
        <StageEmptyView
          title="Moje zadania"
          icon={<ListTodo aria-hidden />}
          emptyTitle="Zadania pojawią się w etapie 1"
          emptyDescription="W etapie 0 działa logowanie kontem Monorise, sprawdzanie uprawnień oraz nawigacja z paletą poleceń. Zadania i tablica pojawią się w etapie 1."
          busy={busy}
          refreshing={refreshing}
          onRefresh={handleRefreshClick}
        />
      )}
    </KivoTasksShell>
  );
}

function StageEmptyView({
  title,
  icon,
  emptyTitle,
  emptyDescription,
  busy,
  refreshing,
  onRefresh,
}: {
  title: string;
  icon: ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  busy: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw aria-hidden />}
          onClick={onRefresh}
          disabled={busy || refreshing}
        >
          {refreshing ? "Odświeżanie…" : "Odśwież"}
        </Button>
      </div>
      <Card surface="middle" className="p-6">
        <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} />
      </Card>
    </div>
  );
}
