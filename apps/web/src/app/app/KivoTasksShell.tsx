"use client";

import type { Team } from "@kivotasks/client";
import {
  AppShell,
  Banner,
  Button,
  Card,
  CommandPalette,
  Kbd,
  ShortcutsHelp,
  SidebarAccordion,
  SidebarCollapseButton,
  SidebarItem,
  SidebarLink,
  SidebarNav,
  SidebarShell,
  cn,
  useCommandPalette,
  useHotkeys,
  useSidebar,
  useTheme,
  type CommandPaletteGroup,
  type CommandPaletteItem,
} from "@monorise-team/ui";
import {
  Inbox,
  Kanban,
  Keyboard,
  ListTodo,
  LogOut,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Users,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  APP_PATHS,
  canManageTeam,
  canReadIssues,
  canWriteIssues,
  parseAppRoute,
  type AppRouteMatch,
} from "./app-views";
import { StateIcon } from "./components/IssueBadges";
import { formatPriorityLabel, orderPaletteSearchResults } from "./issue-ui";
import { useKivoTasks } from "./KivoTasksContext";
import { buildShortcutHelpCategories } from "./shortcuts";

export interface KivoTasksShellProps {
  actionError: string | null;
  onDismissActionError: () => void;
  onFocusSearch: () => boolean;
  children: ReactNode;
}

/**
 * Szkielet zalogowanej aplikacji KivoTasks: pasek boczny z zespołami, paleta poleceń `⌘K` z wyszukiwaniem
 * zadań `/api/v1/search`, globalne skróty (`c`, `/`, `g i`, `g t`, `g b`, `g w`, `?`) i karta treści.
 */
export function KivoTasksShell({ actionError, onDismissActionError, onFocusSearch, children }: KivoTasksShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedMode, setAppearance } = useTheme();
  const {
    client,
    me,
    teams,
    currentTeamKey,
    capabilityOverrides,
    inboxUnreadCount,
    busy,
    openCreateIssue,
    refreshSession,
    signOut,
  } = useKivoTasks();

  const route = useMemo(() => parseAppRoute(pathname), [pathname]);
  const palette = useCommandPalette();
  const [helpOpen, setHelpOpen] = useState(false);

  const canRead = canReadIssues(me.capabilities);
  const canWrite = canWriteIssues(me.capabilities);
  const boardTeamKey = currentTeamKey ?? teams[0]?.key ?? null;

  const navigate = useCallback(
    (href: string) => {
      router.push(href);
    },
    [router],
  );

  const handleLinkClick = useCallback(
    (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      navigate(href);
    },
    [navigate],
  );

  const handleNewIssue = useCallback(() => {
    if (!canWrite || teams.length === 0) return;
    const activeTeam = currentTeamKey
      ? teams.find((team) => team.key.toUpperCase() === currentTeamKey.toUpperCase())
      : undefined;
    openCreateIssue({
      teamId: activeTeam?.id,
      defaultAssignToMe: route.kind === "my-issues",
    });
  }, [canWrite, teams, currentTeamKey, openCreateIssue, route.kind]);

  const handleToggleThemeMode = useCallback(() => {
    setAppearance({ mode: resolvedMode === "dark" ? "light" : "dark" });
  }, [resolvedMode, setAppearance]);

  const handleSlashShortcut = useCallback(() => {
    const focused = onFocusSearch();
    if (!focused) {
      palette.setOpen(true);
    }
  }, [onFocusSearch, palette]);

  const hotkeys = useMemo(
    () => [
      {
        shortcut: "c",
        enabled: canWrite && teams.length > 0,
        handler: handleNewIssue,
      },
      {
        shortcut: "/",
        handler: handleSlashShortcut,
      },
      {
        shortcut: "g n",
        handler: () => navigate(APP_PATHS.inbox),
      },
      {
        shortcut: "g i",
        handler: () => navigate(APP_PATHS.myIssues),
      },
      {
        shortcut: "g t",
        handler: () => navigate(APP_PATHS.teams),
      },
      {
        shortcut: "g b",
        enabled: Boolean(boardTeamKey),
        handler: () => {
          if (boardTeamKey) {
            navigate(APP_PATHS.teamBoard(boardTeamKey));
          }
        },
      },
      {
        shortcut: "g w",
        handler: () => navigate(APP_PATHS.appearance),
      },
    ],
    [canWrite, teams.length, handleNewIssue, handleSlashShortcut, navigate, boardTeamKey],
  );

  useHotkeys(hotkeys, { ignoreWhenModalOpen: true });

  const handlePaletteSearch = useCallback(
    async (query: string, signal: AbortSignal): Promise<CommandPaletteGroup[]> => {
      if (!canRead) return [];
      const result = await client.search.issues(query);
      if (signal.aborted) return [];
      const ordered = orderPaletteSearchResults(result.issues, query);
      if (ordered.length === 0) return [];
      const items: CommandPaletteItem[] = ordered.map((issue) => ({
        id: `issue-${issue.id}`,
        label: `${issue.identifier} · ${issue.title}`,
        description: `${issue.state.name} · ${formatPriorityLabel(issue.priority)}`,
        icon: <StateIcon category={issue.state.category} color={issue.state.color} />,
        onSelect: () => navigate(APP_PATHS.issueDetail(issue.identifier)),
      }));
      return [{ id: "issues", label: "Zadania", items }];
    },
    [canRead, client, navigate],
  );

  const paletteGroups = useMemo<CommandPaletteGroup[]>(() => {
    const actionItems: CommandPaletteItem[] = [
      ...(canWrite
        ? [
            {
              id: "action-new-issue",
              label: "Nowe zadanie",
              icon: <Plus size={16} aria-hidden />,
              shortcut: "c",
              keywords: ["nowe", "utworz", "dodaj", "zadanie", "issue"],
              disabled: teams.length === 0,
              onSelect: handleNewIssue,
            },
          ]
        : []),
      {
        id: "action-toggle-theme",
        label: resolvedMode === "dark" ? "Przełącz na tryb jasny" : "Przełącz na tryb ciemny",
        icon: resolvedMode === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />,
        keywords: ["motyw", "tryb", "jasny", "ciemny", "theme", "wyglad"],
        onSelect: handleToggleThemeMode,
      },
      {
        id: "action-shortcuts",
        label: "Skróty klawiszowe",
        icon: <Keyboard size={16} aria-hidden />,
        shortcut: "shift+?",
        keywords: ["skroty", "klawiatura", "pomoc", "klawisze"],
        onSelect: () => setHelpOpen(true),
      },
      {
        id: "action-refresh",
        label: "Odśwież",
        icon: <RefreshCw size={16} aria-hidden />,
        keywords: ["odswiez", "pobierz", "aktualizuj", "reload"],
        disabled: busy,
        onSelect: () => void refreshSession(),
      },
      {
        id: "action-sign-out",
        label: "Wyloguj",
        icon: <LogOut size={16} aria-hidden />,
        keywords: ["wyloguj", "wyjdz", "sesja", "konto"],
        disabled: busy,
        onSelect: () => void signOut(),
      },
    ];

    const goItems: CommandPaletteItem[] = [
      {
        id: "go-inbox",
        label: "Skrzynka",
        icon: <Inbox size={16} aria-hidden />,
        shortcut: "g n",
        keywords: ["skrzynka", "powiadomienia", "inbox", "wzmianki", "nieprzeczytane"],
        onSelect: () => navigate(APP_PATHS.inbox),
      },
      {
        id: "go-my-issues",
        label: "Moje zadania",
        icon: <ListTodo size={16} aria-hidden />,
        shortcut: "g i",
        keywords: ["zadania", "moje", "lista", "issues"],
        onSelect: () => navigate(APP_PATHS.myIssues),
      },
      {
        id: "go-teams",
        label: "Zespoły",
        icon: <Users size={16} aria-hidden />,
        shortcut: "g t",
        keywords: ["zespoly", "jednostki", "klucze", "teams"],
        onSelect: () => navigate(APP_PATHS.teams),
      },
      ...(boardTeamKey
        ? [
            {
              id: "go-current-board",
              label: `Tablica zespołu ${boardTeamKey}`,
              icon: <Kanban size={16} aria-hidden />,
              shortcut: "g b",
              keywords: ["tablica", "board", "kanban", boardTeamKey.toLowerCase()],
              onSelect: () => navigate(APP_PATHS.teamBoard(boardTeamKey)),
            },
          ]
        : []),
      {
        id: "go-appearance",
        label: "Wygląd",
        icon: <Palette size={16} aria-hidden />,
        shortcut: "g w",
        keywords: ["wyglad", "motyw", "tapeta", "ustawienia"],
        onSelect: () => navigate(APP_PATHS.appearance),
      },
    ];

    const teamItems: CommandPaletteItem[] = teams.flatMap((team) => {
      const items: CommandPaletteItem[] = [
        {
          id: `team-${team.id}`,
          label: `${team.key} · ${team.name}`,
          description: "Lista zadań zespołu",
          icon: <ListTodo size={16} aria-hidden />,
          keywords: [team.key, team.name, "zespol", "lista"],
          onSelect: () => navigate(APP_PATHS.teamIssues(team.key)),
        },
        {
          id: `team-board-${team.id}`,
          label: `Tablica: ${team.key} · ${team.name}`,
          description: "Widok kolumn statusów",
          icon: <Kanban size={16} aria-hidden />,
          keywords: [team.key, team.name, "tablica", "board"],
          onSelect: () => navigate(APP_PATHS.teamBoard(team.key)),
        },
      ];
      if (canManageTeam(me.capabilities, team.id, capabilityOverrides)) {
        items.push({
          id: `team-settings-${team.id}`,
          label: `Ustawienia: ${team.key} · ${team.name}`,
          description: "Klucz zespołu, statusy obiegu i etykiety",
          icon: <Settings size={16} aria-hidden />,
          keywords: [team.key, team.name, "ustawienia", "statusy", "etykiety"],
          onSelect: () => navigate(APP_PATHS.teamSettings(team.key)),
        });
      }
      return items;
    });

    const groups: CommandPaletteGroup[] = [
      { id: "actions", label: "Działania", items: actionItems },
      { id: "go", label: "Przejdź do", items: goItems },
    ];
    if (teamItems.length > 0) {
      groups.push({ id: "teams", label: "Zespoły", items: teamItems });
    }
    return groups;
  }, [
    canWrite,
    teams,
    handleNewIssue,
    resolvedMode,
    handleToggleThemeMode,
    busy,
    refreshSession,
    signOut,
    navigate,
    boardTeamKey,
    me.capabilities,
    capabilityOverrides,
  ]);

  const shortcutCategories = useMemo(
    () =>
      buildShortcutHelpCategories({
        canWriteIssues: canWrite && teams.length > 0,
        hasBoardTarget: Boolean(boardTeamKey),
      }),
    [canWrite, teams.length, boardTeamKey],
  );

  const isBoardRoute = route.kind === "team-board";

  return (
    <AppShell>
      <SidebarShell
        aria-label="Nawigacja KivoTasks"
        footer={
          <SidebarFooter
            activeAppearance={route.kind === "appearance"}
            busy={busy}
            onLinkClick={handleLinkClick}
            onSignOut={() => void signOut()}
          />
        }
      >
        <SidebarHeader organizationName={me.organization.name} personName={me.employee.fullName} />
        <SidebarQuickActions
          canWrite={canWrite && teams.length > 0}
          onNewIssue={handleNewIssue}
          onOpenPalette={() => palette.setOpen(true)}
        />
        <SidebarNav>
          <SidebarLink
            href={APP_PATHS.inbox}
            icon={<Inbox aria-hidden />}
            label="Skrzynka"
            count={inboxUnreadCount > 0 ? inboxUnreadCount : undefined}
            active={route.kind === "inbox"}
            onClick={handleLinkClick(APP_PATHS.inbox)}
          />
          <SidebarLink
            href={APP_PATHS.myIssues}
            icon={<ListTodo aria-hidden />}
            label="Moje zadania"
            active={route.kind === "my-issues"}
            onClick={handleLinkClick(APP_PATHS.myIssues)}
          />
          <SidebarLink
            href={APP_PATHS.teams}
            icon={<Users aria-hidden />}
            label="Zespoły"
            active={route.kind === "teams"}
            onClick={handleLinkClick(APP_PATHS.teams)}
          />

          {teams.length > 0 ? (
            <SidebarTeamsList
              teams={teams}
              route={route}
              canManageTeamFor={(teamId) => canManageTeam(me.capabilities, teamId, capabilityOverrides)}
              onLinkClick={handleLinkClick}
            />
          ) : null}
        </SidebarNav>
      </SidebarShell>

      <Card surface="reading" className="min-w-0 flex-1 overflow-y-auto">
        <main
          className={cn("mx-auto flex min-h-full w-full flex-col gap-5 p-6", isBoardRoute ? "max-w-none" : "max-w-6xl")}
        >
          {actionError ? <Banner tone="danger" message={actionError} onDismiss={onDismissActionError} /> : null}
          {children}
        </main>
      </Card>

      <CommandPalette
        open={palette.open}
        onOpenChange={palette.onOpenChange}
        groups={paletteGroups}
        onSearch={handlePaletteSearch}
        searchDebounceMs={200}
        searchResultsLabel="Zadania"
        loadingText="Szukanie zadań…"
        placeholder="Szukaj zadań po identyfikatorze lub tytule albo wybierz polecenie…"
        emptyText="Nic nie pasuje."
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} bindShortcut categories={shortcutCategories} />
    </AppShell>
  );
}

function SidebarHeader({ organizationName, personName }: { organizationName: string; personName: string }) {
  const { collapsed } = useSidebar();
  if (collapsed) {
    return (
      <div className="flex justify-center pt-3 pb-2" title={`KivoTasks · ${organizationName} · ${personName}`}>
        <span className="flex size-8 items-center justify-center rounded-xl bg-accent text-accent-fg">
          <ListTodo className="size-4" aria-hidden />
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5 px-3 pt-3 pb-2">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg">
        <ListTodo className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium tracking-wide text-text-tertiary uppercase">KivoTasks</p>
        <p className="truncate text-sm font-semibold text-text-primary">{organizationName}</p>
        <p className="truncate text-xs text-text-secondary">{personName}</p>
      </div>
    </div>
  );
}

function SidebarQuickActions({
  canWrite,
  onNewIssue,
  onOpenPalette,
}: {
  canWrite: boolean;
  onNewIssue: () => void;
  onOpenPalette: () => void;
}) {
  const { collapsed } = useSidebar();
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 px-2 pb-1">
        {canWrite ? (
          <Button variant="primary" size="xs" iconOnly aria-label="Nowe zadanie" onClick={onNewIssue}>
            <Plus aria-hidden />
          </Button>
        ) : null}
        <Button variant="ghost" size="xs" iconOnly aria-label="Szukaj w KivoTasks" onClick={onOpenPalette}>
          <Search aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 px-2.5 pb-1">
      {canWrite ? (
        <Button
          variant="primary"
          size="sm"
          icon={<Plus aria-hidden />}
          className="w-full justify-between"
          onClick={onNewIssue}
        >
          <span className="flex-1 text-left">Nowe zadanie</span>
          <Kbd className="border-accent-fg/25 bg-accent-fg/15 text-accent-fg">C</Kbd>
        </Button>
      ) : null}
      <button
        type="button"
        onClick={onOpenPalette}
        className="mr-row mr-press flex h-8 w-full items-center gap-2 border border-border-primary bg-bg-tertiary/70 px-2.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        <Search className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
        <span className="flex-1 truncate">Szukaj lub polecenie…</span>
        <Kbd className="px-1">⌘K</Kbd>
      </button>
    </div>
  );
}

function SidebarTeamsList({
  teams,
  route,
  canManageTeamFor,
  onLinkClick,
}: {
  teams: readonly Team[];
  route: AppRouteMatch;
  canManageTeamFor: (teamId: string) => boolean;
  onLinkClick: (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { collapsed } = useSidebar();
  const activeTeamKey =
    route.kind === "team-issues" || route.kind === "team-board" || route.kind === "team-settings"
      ? route.teamKey.toUpperCase()
      : null;

  return (
    <SidebarAccordion title="Twoje zespoły" visibleCount={6}>
      {teams.map((team) => {
        const isCurrentTeam = activeTeamKey === team.key.toUpperCase();
        const issuesHref = APP_PATHS.teamIssues(team.key);
        const boardHref = APP_PATHS.teamBoard(team.key);
        const settingsHref = APP_PATHS.teamSettings(team.key);

        return (
          <div key={team.id} className="flex flex-col gap-0.5">
            <SidebarLink
              href={issuesHref}
              icon={
                <span className="inline-flex min-w-6 items-center justify-center rounded bg-bg-tertiary px-1 font-mono text-[10px] font-semibold text-text-secondary">
                  {team.key}
                </span>
              }
              label={team.name}
              active={isCurrentTeam && route.kind === "team-issues"}
              onClick={onLinkClick(issuesHref)}
            />
            {!collapsed && isCurrentTeam ? (
              <div className="ml-4 flex flex-col gap-0.5 border-l border-border-secondary pl-2">
                <SidebarLink
                  href={boardHref}
                  icon={<Kanban aria-hidden />}
                  label="Tablica"
                  active={route.kind === "team-board"}
                  onClick={onLinkClick(boardHref)}
                />
                {canManageTeamFor(team.id) ? (
                  <SidebarLink
                    href={settingsHref}
                    icon={<Settings aria-hidden />}
                    label="Ustawienia"
                    active={route.kind === "team-settings"}
                    onClick={onLinkClick(settingsHref)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </SidebarAccordion>
  );
}

function SidebarFooter({
  activeAppearance,
  busy,
  onLinkClick,
  onSignOut,
}: {
  activeAppearance: boolean;
  busy: boolean;
  onLinkClick: (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
  onSignOut: () => void;
}) {
  const { collapsed } = useSidebar();
  return (
    <div className={cn("flex w-full flex-col gap-1", collapsed && "items-center")}>
      <SidebarLink
        href={APP_PATHS.appearance}
        icon={<Palette aria-hidden />}
        label="Wygląd"
        active={activeAppearance}
        onClick={onLinkClick(APP_PATHS.appearance)}
      />
      <SidebarItem icon={<LogOut aria-hidden />} label="Wyloguj" onClick={onSignOut} disabled={busy} />
      <SidebarCollapseButton />
    </div>
  );
}
