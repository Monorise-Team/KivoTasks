"use client";

import {
  AppShell,
  Banner,
  Card,
  CommandPalette,
  ShortcutsHelp,
  SidebarCollapseButton,
  SidebarItem,
  SidebarLink,
  SidebarNav,
  SidebarShell,
  cn,
  useCommandPalette,
  useHotkeys,
  useSidebar,
  type CommandPaletteGroup,
  type CommandPaletteItem,
  type ShortcutHelpCategory,
} from "@monorise-team/ui";
import { Keyboard, ListTodo, LogOut, Palette, RefreshCw, Users } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { VIEW_HASHES, type AppView } from "./app-views";

export interface KivoTasksShellProps {
  organizationName: string;
  personName: string;
  view: AppView;
  busy: boolean;
  actionError: string | null;
  onDismissActionError: () => void;
  onNavigate: (view: AppView) => void;
  onRefresh: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

/**
 * Szkielet zalogowanej aplikacji KivoTasks: tapeta pod szklanymi kartami, zwijany pasek boczny,
 * aktywny widok na karcie do czytania, paleta poleceń (⌘K / Ctrl+K) oraz skróty `g …` i `?`.
 */
export function KivoTasksShell({
  organizationName,
  personName,
  view,
  busy,
  actionError,
  onDismissActionError,
  onNavigate,
  onRefresh,
  onSignOut,
  children,
}: KivoTasksShellProps) {
  const palette = useCommandPalette();
  const [helpOpen, setHelpOpen] = useState(false);

  const hotkeys = useMemo(
    () => [
      { shortcut: "g m", handler: () => onNavigate("my-issues") },
      { shortcut: "g z", handler: () => onNavigate("teams") },
      { shortcut: "g w", handler: () => onNavigate("appearance") },
    ],
    [onNavigate],
  );

  useHotkeys(hotkeys, { ignoreWhenModalOpen: true });

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const goItems: CommandPaletteItem[] = [
      {
        id: "go-my-issues",
        label: "Moje zadania",
        icon: <ListTodo size={16} aria-hidden />,
        shortcut: "g m",
        keywords: ["zadania", "moje", "lista", "tablica", "issues"],
        onSelect: () => onNavigate("my-issues"),
      },
      {
        id: "go-teams",
        label: "Zespoły",
        icon: <Users size={16} aria-hidden />,
        shortcut: "g z",
        keywords: ["zespoly", "jednostki", "klucze", "teams"],
        onSelect: () => onNavigate("teams"),
      },
      {
        id: "go-appearance",
        label: "Wygląd",
        icon: <Palette size={16} aria-hidden />,
        shortcut: "g w",
        keywords: ["wyglad", "motyw", "ciemny", "jasny", "tapeta", "ustawienia"],
        onSelect: () => onNavigate("appearance"),
      },
      {
        id: "go-shortcuts",
        label: "Skróty klawiszowe",
        icon: <Keyboard size={16} aria-hidden />,
        shortcut: "shift+?",
        keywords: ["skroty", "klawiatura", "pomoc", "klawisze"],
        onSelect: () => setHelpOpen(true),
      },
    ];

    const actionItems: CommandPaletteItem[] = [
      {
        id: "action-refresh",
        label: "Odśwież",
        icon: <RefreshCw size={16} aria-hidden />,
        keywords: ["odswiez", "pobierz", "aktualizuj", "reload"],
        disabled: busy,
        onSelect: onRefresh,
      },
      {
        id: "action-sign-out",
        label: "Wyloguj",
        icon: <LogOut size={16} aria-hidden />,
        keywords: ["wyloguj", "wyjdz", "sesja", "konto"],
        disabled: busy,
        onSelect: onSignOut,
      },
    ];

    return [
      { id: "go", label: "Przejdź do", items: goItems },
      { id: "actions", label: "Działania", items: actionItems },
    ];
  }, [busy, onNavigate, onRefresh, onSignOut]);

  const shortcutCategories = useMemo<ShortcutHelpCategory[]>(
    () => [
      {
        category: "Ogólne",
        items: [
          { label: "Paleta poleceń", shortcut: "mod+k" },
          { label: "Skróty klawiszowe", shortcut: "shift+?" },
        ],
      },
      {
        category: "Przejdź do",
        items: [
          { label: "Moje zadania", shortcut: "g m" },
          { label: "Zespoły", shortcut: "g z" },
          { label: "Wygląd", shortcut: "g w" },
        ],
      },
    ],
    [],
  );

  return (
    <AppShell>
      <SidebarShell
        aria-label="Nawigacja KivoTasks"
        footer={<SidebarFooter view={view} busy={busy} onSignOut={onSignOut} />}
      >
        <SidebarHeader organizationName={organizationName} personName={personName} />
        <SidebarNav>
          <SidebarLink
            href={VIEW_HASHES["my-issues"]}
            icon={<ListTodo aria-hidden />}
            label="Moje zadania"
            active={view === "my-issues"}
          />
          <SidebarLink
            href={VIEW_HASHES.teams}
            icon={<Users aria-hidden />}
            label="Zespoły"
            active={view === "teams"}
          />
        </SidebarNav>
      </SidebarShell>

      <Card surface="reading" className="min-w-0 flex-1 overflow-y-auto">
        <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
          {actionError ? <Banner tone="danger" message={actionError} onDismiss={onDismissActionError} /> : null}
          {children}
        </main>
      </Card>

      <CommandPalette
        open={palette.open}
        onOpenChange={palette.onOpenChange}
        groups={groups}
        placeholder="Szukaj w KivoTasks…"
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

function SidebarFooter({ view, busy, onSignOut }: { view: AppView; busy: boolean; onSignOut: () => void }) {
  const { collapsed } = useSidebar();
  return (
    <div className={cn("flex w-full flex-col gap-1", collapsed && "items-center")}>
      <SidebarLink
        href={VIEW_HASHES.appearance}
        icon={<Palette aria-hidden />}
        label="Wygląd"
        active={view === "appearance"}
      />
      <SidebarItem icon={<LogOut aria-hidden />} label="Wyloguj" onClick={onSignOut} disabled={busy} />
      <SidebarCollapseButton />
    </div>
  );
}
