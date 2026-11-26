"use client";

import {
  COLOR_TOKENS,
  type ColorToken,
  type IssueLabelSummary,
  type Team,
  type WorkflowStateCategory,
} from "@kivotasks/client";
import { Badge, Button, cn } from "@monorise-team/ui";
import {
  AlertOctagon,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  Kanban,
  ListTodo,
  Minus,
  Plus,
  Settings,
  SignalHigh,
  SignalLow,
  SignalMedium,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { APP_PATHS } from "../app-views";
import { COLOR_TOKEN_LABELS, formatPriorityLabel, getColorTokenStyle } from "../issue-ui";

export function PriorityIcon({
  priority,
  showLabel = false,
  className,
}: {
  priority: number;
  showLabel?: boolean;
  className?: string;
}) {
  const label = formatPriorityLabel(priority);
  let icon;
  switch (priority) {
    case 1:
      icon = <AlertOctagon className="size-4 shrink-0 text-danger" aria-hidden />;
      break;
    case 2:
      icon = <SignalHigh className="size-4 shrink-0 text-warning" aria-hidden />;
      break;
    case 3:
      icon = <SignalMedium className="size-4 shrink-0 text-text-secondary" aria-hidden />;
      break;
    case 4:
      icon = <SignalLow className="size-4 shrink-0 text-text-tertiary" aria-hidden />;
      break;
    default:
      icon = <Minus className="size-4 shrink-0 text-text-tertiary" aria-hidden />;
      break;
  }

  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={`Priorytet: ${label}`}
      aria-label={showLabel ? undefined : `Priorytet: ${label}`}
    >
      {icon}
      {showLabel ? <span className="text-xs text-text-secondary">{label}</span> : null}
    </span>
  );
}

export function StateIcon({
  category,
  color,
  className,
}: {
  category: WorkflowStateCategory;
  color: ColorToken;
  className?: string;
}) {
  const style = getColorTokenStyle(color);
  const iconClass = cn("size-4 shrink-0", style.text, className);
  switch (category) {
    case "BACKLOG":
      return <CircleDashed className={iconClass} aria-hidden />;
    case "UNSTARTED":
      return <Circle className={iconClass} aria-hidden />;
    case "STARTED":
      return <CircleDot className={iconClass} aria-hidden />;
    case "COMPLETED":
      return <CheckCircle2 className={iconClass} aria-hidden />;
    case "CANCELED":
      return <XCircle className={iconClass} aria-hidden />;
  }
}

export function ColorDot({ color, className }: { color: ColorToken; className?: string }) {
  const style = getColorTokenStyle(color);
  return <span className={cn("inline-block size-2.5 shrink-0 rounded-full", style.dot, className)} aria-hidden />;
}

export function LabelPill({
  label,
  className,
}: {
  label: Pick<IssueLabelSummary, "name" | "color">;
  className?: string;
}) {
  const style = getColorTokenStyle(label.color);
  return (
    <span
      className={cn(
        "mr-no-text-shadow inline-flex max-w-40 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-tight font-medium",
        style.badge,
        className,
      )}
    >
      <ColorDot color={label.color} className="size-1.5" />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

export function ColorPicker({
  value,
  onChange,
  disabled = false,
  ariaLabel = "Wybierz kolor",
}: {
  value: ColorToken;
  onChange: (color: ColorToken) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap items-center gap-1.5">
      {COLOR_TOKENS.map((token) => {
        const selected = token === value;
        const style = getColorTokenStyle(token);
        const label = COLOR_TOKEN_LABELS[token];
        return (
          <button
            key={token}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => onChange(token)}
            className={cn(
              "mr-press flex size-7 items-center justify-center rounded-full border transition-colors disabled:opacity-50",
              selected
                ? "border-accent bg-bg-selected ring-2 ring-accent/40"
                : "border-border-primary bg-bg-tertiary hover:bg-bg-hover",
            )}
          >
            <span className={cn("size-3.5 rounded-full", style.dot)} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export function TeamHeader({
  team,
  activeTab,
  canWrite,
  canManage,
  onNewIssue,
}: {
  team: Team;
  activeTab: "list" | "board" | "settings";
  canWrite: boolean;
  canManage: boolean;
  onNewIssue: () => void;
}) {
  const tabClass = (active: boolean) =>
    cn(
      "mr-press mr-no-text-shadow inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-sm font-medium transition-colors [&_svg]:size-4",
      active ? "bg-bg-selected text-accent-strong" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
    );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-primary pb-4">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="accent" className="px-2 font-mono text-xs">
            {team.key}
          </Badge>
          <h1 className="truncate text-xl font-semibold text-text-primary">{team.name}</h1>
        </div>

        <nav aria-label={`Widoki zespołu ${team.name}`} className="flex items-center gap-1">
          <Link
            href={APP_PATHS.teamIssues(team.key)}
            aria-current={activeTab === "list" ? "page" : undefined}
            className={tabClass(activeTab === "list")}
          >
            <ListTodo aria-hidden />
            Lista
          </Link>
          <Link
            href={APP_PATHS.teamBoard(team.key)}
            aria-current={activeTab === "board" ? "page" : undefined}
            className={tabClass(activeTab === "board")}
          >
            <Kanban aria-hidden />
            Tablica
          </Link>
          {canManage ? (
            <Link
              href={APP_PATHS.teamSettings(team.key)}
              aria-current={activeTab === "settings" ? "page" : undefined}
              className={tabClass(activeTab === "settings")}
            >
              <Settings aria-hidden />
              Ustawienia
            </Link>
          ) : null}
        </nav>
      </div>

      {canWrite ? (
        <Button variant="primary" size="sm" icon={<Plus aria-hidden />} onClick={onNewIssue}>
          Nowe zadanie
        </Button>
      ) : null}
    </div>
  );
}
