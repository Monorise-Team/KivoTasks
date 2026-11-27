"use client";

import type { InboxFilter, InboxItem } from "@kivotasks/client";
import { Avatar, Badge, Banner, Button, Card, EmptyState, Skeleton, cn, useToast } from "@monorise-team/ui";
import { Archive, Check, CheckCheck, ExternalLink, Inbox, MailOpen, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatInboxKindText } from "../activity-ui";
import { APP_PATHS, formatApiError } from "../app-views";
import { formatDateTime } from "../issue-ui";
import { useKivoTasks } from "../KivoTasksContext";
import { StateIcon } from "./IssueBadges";

const INBOX_PAGE_LIMIT = 50;

/**
 * Widok `/inbox`: lista powiadomień zalogowanej osoby (przypisania, wzmianki, nowe komentarze)
 * z filtrem nieprzeczytanych i wszystkich, oznaczaniem przeczytania, archiwizacją oraz stronicowaniem kursorowym.
 */
export function InboxView() {
  const router = useRouter();
  const { toast } = useToast();
  const { client, inboxUnreadCount, refreshInboxUnreadCount, setInboxUnreadCount } = useKivoTasks();

  const [filter, setFilter] = useState<InboxFilter>("unread");
  const [refreshTick, setRefreshTick] = useState(0);
  const [listState, setListState] = useState<{
    readonly key: string;
    readonly items: InboxItem[];
    readonly nextCursor: string | null;
    readonly error: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadKey = `${filter}:${refreshTick}`;

  useEffect(() => {
    let cancelled = false;
    client.inbox
      .list({ filter, limit: INBOX_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        setListState({ key: loadKey, items: page.items, nextCursor: page.nextCursor, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setListState({
          key: loadKey,
          items: [],
          nextCursor: null,
          error: formatApiError(error, "Nie udało się wczytać skrzynki powiadomień."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, filter, loadKey]);

  const loading = listState === null || listState.key !== loadKey;
  const items = listState?.key === loadKey ? listState.items : [];
  const nextCursor = listState?.key === loadKey ? listState.nextCursor : null;
  const loadError = listState?.key === loadKey ? listState.error : null;

  const handleRefresh = useCallback(() => {
    setRefreshTick((prev) => prev + 1);
    void refreshInboxUnreadCount();
  }, [refreshInboxUnreadCount]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const page = await client.inbox.list({ filter, limit: INBOX_PAGE_LIMIT, cursor: nextCursor });
      setListState((prev) =>
        prev
          ? {
              ...prev,
              items: [...prev.items, ...page.items],
              nextCursor: page.nextCursor,
            }
          : prev,
      );
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się wczytać kolejnych powiadomień."));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleToggleRead = async (item: InboxItem) => {
    const nextRead = item.readAt === null;
    setBusyItemId(item.id);
    setActionError(null);
    try {
      const updated = await client.inbox.update(item.id, { read: nextRead });
      setListState((prev) => {
        if (!prev) return prev;
        if (filter === "unread" && nextRead) {
          return { ...prev, items: prev.items.filter((entry) => entry.id !== item.id) };
        }
        return {
          ...prev,
          items: prev.items.map((entry) => (entry.id === item.id ? updated : entry)),
        };
      });
      setInboxUnreadCount((prev) => Math.max(0, prev + (nextRead ? -1 : 1)));
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się zaktualizować stanu powiadomienia."));
    } finally {
      setBusyItemId(null);
    }
  };

  const handleArchive = async (item: InboxItem) => {
    const wasUnread = item.readAt === null;
    setBusyItemId(item.id);
    setActionError(null);
    try {
      await client.inbox.update(item.id, { archived: true });
      setListState((prev) => (prev ? { ...prev, items: prev.items.filter((entry) => entry.id !== item.id) } : prev));
      if (wasUnread) {
        setInboxUnreadCount((prev) => Math.max(0, prev - 1));
      }
      toast({ title: "Zarchiwizowano powiadomienie", tone: "neutral" });
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się zarchiwizować powiadomienia."));
    } finally {
      setBusyItemId(null);
    }
  };

  const handleOpenItem = async (item: InboxItem) => {
    if (item.readAt === null) {
      setInboxUnreadCount((prev) => Math.max(0, prev - 1));
      void client.inbox.update(item.id, { read: true }).catch(() => {
        void refreshInboxUnreadCount();
      });
    }
    router.push(APP_PATHS.issueDetail(item.issue.identifier));
  };

  const handleMarkAllRead = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    setActionError(null);
    try {
      const result = await client.inbox.markAllRead();
      const nowIso = new Date().toISOString();
      setListState((prev) => {
        if (!prev) return prev;
        if (filter === "unread") {
          return { ...prev, items: [], nextCursor: null };
        }
        return {
          ...prev,
          items: prev.items.map((entry) => (entry.readAt ? entry : { ...entry, readAt: nowIso })),
        };
      });
      setInboxUnreadCount(0);
      toast({
        title:
          result.updatedCount > 0
            ? "Oznaczono wszystkie powiadomienia jako przeczytane"
            : "Brak nieprzeczytanych powiadomień",
        tone: "success",
      });
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się oznaczyć powiadomień jako przeczytanych."));
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-primary pb-4">
        <div className="flex items-center gap-2.5">
          <Inbox className="size-5 text-accent-strong" aria-hidden />
          <h1 className="text-xl font-semibold text-text-primary">Skrzynka</h1>
          {inboxUnreadCount > 0 ? <Badge tone="accent">{inboxUnreadCount}</Badge> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Filtr skrzynki"
            className="inline-flex rounded-control border border-border-primary bg-bg-secondary p-0.5"
          >
            <Button
              variant={filter === "unread" ? "primary" : "ghost"}
              size="xs"
              aria-pressed={filter === "unread"}
              onClick={() => setFilter("unread")}
            >
              Nieprzeczytane
            </Button>
            <Button
              variant={filter === "all" ? "primary" : "ghost"}
              size="xs"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              Wszystkie
            </Button>
          </div>

          <Button
            variant="secondary"
            size="sm"
            icon={<CheckCheck aria-hidden />}
            disabled={markingAll || inboxUnreadCount === 0}
            onClick={() => void handleMarkAllRead()}
          >
            Oznacz wszystkie jako przeczytane
          </Button>

          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Odśwież skrzynkę"
            title="Odśwież"
            onClick={handleRefresh}
          >
            <RefreshCw aria-hidden />
          </Button>
        </div>
      </header>

      {loadError ? <Banner tone="danger" message={loadError} /> : null}
      {actionError ? <Banner tone="danger" message={actionError} onDismiss={() => setActionError(null)} /> : null}

      {loading ? (
        <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Wczytywanie powiadomień">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Card surface="middle" className="p-8">
          <EmptyState
            icon={<Inbox aria-hidden />}
            title={filter === "unread" ? "Wszystko przeczytane" : "Skrzynka jest pusta"}
            description={
              filter === "unread"
                ? "Nie masz teraz nieprzeczytanych powiadomień. Gdy ktoś przypisze Ci zadanie, wspomni Cię lub skomentuje obserwowane zadanie, pojawi się ono tutaj."
                : "Powiadomienia o przypisaniach, wzmiankach i nowych komentarzach w obserwowanych zadaniach będą widoczne tutaj."
            }
            action={
              filter === "unread" ? (
                <Button variant="secondary" onClick={() => setFilter("all")}>
                  Pokaż wszystkie powiadomienia
                </Button>
              ) : (
                <Button asChild variant="primary">
                  <Link href={APP_PATHS.myIssues}>Przejdź do Moich zadań</Link>
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <ul className="flex flex-col divide-y divide-border-secondary overflow-hidden rounded-card border border-border-primary bg-bg-secondary/45">
          {items.map((item) => {
            const isUnread = item.readAt === null;
            const actorLabel = item.actorName ?? "Członek zespołu";
            const kindText = formatInboxKindText(item.kind, item.actorName);
            const busy = busyItemId === item.id;
            const issueHref = APP_PATHS.issueDetail(item.issue.identifier);

            return (
              <li
                key={item.id}
                className={cn(
                  "flex flex-col gap-2.5 px-4 py-3.5 transition-colors hover:bg-row-hover sm:flex-row sm:items-start sm:justify-between",
                  isUnread && "bg-accent/5",
                )}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="mt-1.5 flex size-2.5 shrink-0 items-center justify-center">
                    {isUnread ? <span className="size-2 rounded-full bg-accent" aria-label="Nieprzeczytane" /> : null}
                  </div>

                  <Avatar name={actorLabel} seed={item.actorAccountId} size="sm" />

                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StateIcon category={item.issue.state.category} color={item.issue.state.color} />
                      <span className="shrink-0 font-mono text-xs text-text-tertiary">{item.issue.identifier}</span>
                      <Link
                        href={issueHref}
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
                            return;
                          }
                          event.preventDefault();
                          void handleOpenItem(item);
                        }}
                        className={cn(
                          "min-w-0 truncate text-sm text-text-primary hover:text-link hover:underline",
                          isUnread ? "font-semibold" : "font-medium",
                        )}
                      >
                        {item.issue.title}
                      </Link>
                    </div>

                    <p className="text-xs text-text-secondary">{kindText}</p>

                    {item.commentExcerpt ? (
                      <p className="line-clamp-2 text-xs text-text-tertiary">„{item.commentExcerpt}”</p>
                    ) : null}

                    <time dateTime={item.createdAt} className="text-xs text-text-tertiary tabular-nums">
                      {formatDateTime(item.createdAt)}
                    </time>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1 self-end sm:self-center">
                  <Button
                    variant="secondary"
                    size="xs"
                    icon={<ExternalLink aria-hidden />}
                    onClick={() => void handleOpenItem(item)}
                  >
                    Otwórz
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={isUnread ? <Check aria-hidden /> : <MailOpen aria-hidden />}
                    disabled={busy}
                    onClick={() => void handleToggleRead(item)}
                  >
                    {isUnread ? "Oznacz przeczytane" : "Nieprzeczytane"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Archive aria-hidden />}
                    disabled={busy}
                    onClick={() => void handleArchive(item)}
                  >
                    Archiwizuj
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void handleLoadMore()}>
            {loadingMore ? "Wczytywanie…" : "Wczytaj więcej"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
