"use client";

import {
  ApiError,
  COMMENT_REACTION_EMOJIS,
  type CommentReactionEmoji,
  type IssueActivityItem,
  type IssueAttachment,
  type IssueComment,
  type TeamMember,
} from "@kivotasks/client";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  cn,
  useToast,
} from "@monorise-team/ui";
import { History, MessageSquare, Pencil, SmilePlus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  COMMENT_DELETED_LABEL,
  REACTION_EMOJI_LABELS,
  UNKNOWN_PERSON_LABEL,
  formatIssueEventText,
  mergeActivityItems,
} from "../activity-ui";
import { formatApiError } from "../app-views";
import { formatDateTime } from "../issue-ui";
import { useKivoTasks } from "../KivoTasksContext";
import { CommentEditor } from "./CommentEditor";
import { MarkdownContent } from "./MarkdownContent";

export interface IssueActivitySectionProps {
  readonly issueId: string;
  readonly teamId: string;
  readonly members: readonly TeamMember[];
  readonly memberNameByAccountId: ReadonlyMap<string, string>;
  readonly canManageTeam: boolean;
  readonly canWriteIssues: boolean;
  readonly uploadDisabled?: boolean;
  readonly onUploadAttachment?: (file: File) => Promise<IssueAttachment | null>;
  readonly activityRevision: number;
  readonly onCommentCreated?: () => void;
}

const ACTIVITY_PAGE_LIMIT = 50;

/**
 * Sekcja „Aktywność” w szczegółach zadania: chronologiczny strumień historii zmian i komentarzy,
 * edytor Markdown z autouzupełnianiem `@`, edycja/usuwanie komentarzy oraz reakcje emoji.
 */
export function IssueActivitySection({
  issueId,
  teamId,
  members,
  memberNameByAccountId,
  canManageTeam,
  canWriteIssues,
  uploadDisabled = false,
  onUploadAttachment,
  activityRevision,
  onCommentCreated,
}: IssueActivitySectionProps) {
  const { client, me, canManageTeamById, markTeamManageDenied } = useKivoTasks();
  const { toast } = useToast();

  const [state, setState] = useState<{
    readonly key: string;
    readonly items: IssueActivityItem[];
    readonly nextCursor: string | null;
    readonly error: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Nowy komentarz
  const [newBody, setNewBody] = useState("");
  const [creating, setCreating] = useState(false);

  // Edycja komentarza
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Usuwanie komentarza
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Reakcje w locie
  const [reactionBusyKey, setReactionBusyKey] = useState<string | null>(null);

  const loadKey = `${issueId}:${activityRevision}`;

  useEffect(() => {
    let cancelled = false;
    client.issues
      .listActivity(issueId, { limit: ACTIVITY_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        setState({
          key: loadKey,
          items: mergeActivityItems([], page.items),
          nextCursor: page.nextCursor,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          key: loadKey,
          items: [],
          nextCursor: null,
          error: formatApiError(error, "Nie udało się wczytać historii aktywności."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, issueId, loadKey]);

  const loading = state === null || (state.key !== loadKey && state.items.length === 0);
  const items = state?.items ?? [];
  const nextCursor = state?.key === loadKey ? state.nextCursor : null;
  const loadError = state?.key === loadKey ? state.error : null;

  const replaceCommentInItems = useCallback((updated: IssueComment) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((item) =>
          item.kind === "comment" && item.comment.id === updated.id ? { ...item, comment: updated } : item,
        ),
      };
    });
  }, []);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const page = await client.issues.listActivity(issueId, { limit: ACTIVITY_PAGE_LIMIT, cursor: nextCursor });
      setState((prev) =>
        prev
          ? {
              ...prev,
              items: mergeActivityItems(prev.items, page.items),
              nextCursor: page.nextCursor,
            }
          : prev,
      );
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się wczytać dalszej aktywności."));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleCreateComment = async () => {
    if (creating || newBody.trim().length === 0) return;
    setCreating(true);
    setActionError(null);
    try {
      const created = await client.issues.createComment(issueId, { body: newBody });
      setNewBody("");
      setState((prev) => {
        const entry: IssueActivityItem = {
          kind: "comment",
          id: created.id,
          createdAt: created.createdAt,
          comment: created,
        };
        if (!prev) {
          return { key: loadKey, items: [entry], nextCursor: null, error: null };
        }
        return { ...prev, items: mergeActivityItems(prev.items, [entry]) };
      });
      onCommentCreated?.();
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się dodać komentarza."));
    } finally {
      setCreating(false);
    }
  };

  const handleStartEdit = (comment: IssueComment) => {
    setEditingId(comment.id);
    setEditBody(comment.body ?? "");
    setActionError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingId || savingEdit || editBody.trim().length === 0) return;
    setSavingEdit(true);
    setActionError(null);
    try {
      const updated = await client.issues.updateComment(issueId, editingId, { body: editBody });
      replaceCommentInItems(updated);
      setEditingId(null);
      setEditBody("");
      toast({ title: "Zapisano zmiany w komentarzu", tone: "success" });
    } catch (error) {
      setActionError(formatApiError(error, "Nie udało się zapisać zmian w komentarzu."));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteComment = async () => {
    if (!deleteTargetId || deleting) return;
    const targetId = deleteTargetId;
    const targetItem = items.find((item) => item.kind === "comment" && item.comment.id === targetId);
    const deletingOthersComment =
      targetItem?.kind === "comment" && targetItem.comment.authorAccountId !== me.account.id;
    setDeleting(true);
    setActionError(null);
    try {
      await client.issues.deleteComment(issueId, targetId);
      setState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((item) =>
            item.kind === "comment" && item.comment.id === targetId
              ? {
                  ...item,
                  comment: {
                    ...item.comment,
                    body: null,
                    deleted: true,
                    deletedAt: new Date().toISOString(),
                    mentionedAccountIds: [],
                    reactions: [],
                  },
                }
              : item,
          ),
        };
      });
      setDeleteTargetId(null);
      if (editingId === targetId) {
        setEditingId(null);
        setEditBody("");
      }
      toast({ title: "Usunięto komentarz", tone: "neutral" });
    } catch (error) {
      if (
        deletingOthersComment &&
        error instanceof ApiError &&
        error.status === 403 &&
        error.code === "PERMISSION_DENIED"
      ) {
        markTeamManageDenied(teamId);
        setDeleteTargetId(null);
      }
      setActionError(formatApiError(error, "Nie udało się usunąć komentarza."));
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleReaction = async (comment: IssueComment, emoji: CommentReactionEmoji) => {
    const busyKey = `${comment.id}:${emoji}`;
    if (reactionBusyKey === busyKey) return;
    const alreadyReacted = comment.reactions.some((r) => r.emoji === emoji && r.reactedByMe);
    setReactionBusyKey(busyKey);
    setActionError(null);
    try {
      if (alreadyReacted) {
        await client.issues.removeReaction(issueId, comment.id, emoji);
        const nextReactions = comment.reactions
          .map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, reactedByMe: false } : r))
          .filter((r) => r.count > 0);
        replaceCommentInItems({ ...comment, reactions: nextReactions });
      } else {
        const result = await client.issues.addReaction(issueId, comment.id, emoji);
        replaceCommentInItems({ ...comment, reactions: result.reactions });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setActionError("Nie znaleziono komentarza.");
      } else {
        setActionError(formatApiError(error, "Nie udało się zaktualizować reakcji."));
      }
    } finally {
      setReactionBusyKey(null);
    }
  };

  const commentCount = items.filter((item) => item.kind === "comment").length;

  return (
    <section aria-labelledby="activity-heading" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-text-tertiary" aria-hidden />
          <h2 id="activity-heading" className="text-sm font-semibold text-text-primary">
            Aktywność
          </h2>
          {commentCount > 0 ? <Badge tone="neutral">{commentCount}</Badge> : null}
        </div>
      </div>

      {loadError ? <Banner tone="danger" message={loadError} /> : null}
      {actionError ? <Banner tone="danger" message={actionError} onDismiss={() => setActionError(null)} /> : null}

      {loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Wczytywanie aktywności">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-tertiary">Brak wpisów aktywności.</p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Strumień aktywności zadania">
          {items.map((item) => {
            if (item.kind === "event") {
              const line = formatIssueEventText(item.event, memberNameByAccountId);
              return (
                <li
                  key={`event-${item.id}`}
                  className="flex items-start gap-2.5 px-1 py-0.5 text-xs text-text-secondary"
                >
                  <History className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
                  <span className="min-w-0 flex-1">{line}</span>
                  <time dateTime={item.createdAt} className="shrink-0 text-text-tertiary tabular-nums">
                    {formatDateTime(item.createdAt)}
                  </time>
                </li>
              );
            }

            const comment = item.comment;
            const authorName =
              comment.authorName ?? memberNameByAccountId.get(comment.authorAccountId) ?? UNKNOWN_PERSON_LABEL;
            const isAuthor = comment.authorAccountId === me.account.id;
            const canDelete = isAuthor || (canManageTeam && canManageTeamById(teamId));
            const isEditing = editingId === comment.id;

            if (comment.deleted) {
              return (
                <li
                  key={`comment-${comment.id}`}
                  className="flex items-center justify-between gap-2 rounded-card border border-border-secondary bg-bg-secondary/30 px-4 py-3 text-sm text-text-tertiary italic"
                >
                  <span>{COMMENT_DELETED_LABEL}</span>
                  <time dateTime={comment.createdAt} className="text-xs not-italic tabular-nums">
                    {formatDateTime(comment.createdAt)}
                  </time>
                </li>
              );
            }

            return (
              <li
                key={`comment-${comment.id}`}
                className="flex flex-col gap-3 rounded-card border border-border-primary bg-bg-secondary/45 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar name={authorName} seed={comment.authorAccountId} size="sm" />
                    <span className="truncate text-sm font-medium text-text-primary">{authorName}</span>
                    <time dateTime={comment.createdAt} className="text-xs text-text-tertiary tabular-nums">
                      {formatDateTime(comment.createdAt)}
                    </time>
                    {comment.editedAt ? <Badge tone="neutral">Edytowano</Badge> : null}
                  </div>

                  {!isEditing && (isAuthor || canDelete) ? (
                    <div className="flex items-center gap-1">
                      {isAuthor ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          icon={<Pencil aria-hidden />}
                          onClick={() => handleStartEdit(comment)}
                        >
                          Edytuj
                        </Button>
                      ) : null}
                      {canDelete ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          icon={<Trash2 aria-hidden />}
                          className="text-danger hover:text-danger"
                          onClick={() => setDeleteTargetId(comment.id)}
                        >
                          Usuń
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {isEditing ? (
                  <CommentEditor
                    value={editBody}
                    onChange={setEditBody}
                    onSubmit={handleSaveEdit}
                    onCancel={() => {
                      setEditingId(null);
                      setEditBody("");
                    }}
                    members={members}
                    busy={savingEdit}
                    submitLabel="Zapisz zmiany"
                    ariaLabel="Edycja komentarza"
                    autoFocus
                    canUploadAttachment={canWriteIssues}
                    uploadDisabled={uploadDisabled}
                    onUploadAttachment={onUploadAttachment}
                  />
                ) : (
                  <MarkdownContent body={comment.body ?? ""} mentionedAccountIds={comment.mentionedAccountIds} />
                )}

                {!isEditing ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {comment.reactions.map((reaction) => {
                      const busy = reactionBusyKey === `${comment.id}:${reaction.emoji}`;
                      return (
                        <button
                          key={reaction.emoji}
                          type="button"
                          disabled={busy}
                          aria-pressed={reaction.reactedByMe}
                          aria-label={`${REACTION_EMOJI_LABELS[reaction.emoji]} (${reaction.count})`}
                          onClick={() => void handleToggleReaction(comment, reaction.emoji)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-50",
                            reaction.reactedByMe
                              ? "border-accent bg-accent/15 font-medium text-accent-strong"
                              : "border-border-primary bg-bg-tertiary/70 text-text-secondary hover:bg-bg-hover",
                          )}
                        >
                          <span aria-hidden>{reaction.emoji}</span>
                          <span className="tabular-nums">{reaction.count}</span>
                        </button>
                      );
                    })}

                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="ghost" size="xs" iconOnly aria-label="Dodaj reakcję" title="Dodaj reakcję">
                          <SmilePlus aria-hidden />
                        </Button>
                      </MenuTrigger>
                      <MenuContent align="start">
                        {COMMENT_REACTION_EMOJIS.map((emoji) => {
                          const active = comment.reactions.some((r) => r.emoji === emoji && r.reactedByMe);
                          return (
                            <MenuItem key={emoji} onSelect={() => void handleToggleReaction(comment, emoji)}>
                              <span className="inline-flex items-center gap-2">
                                <span aria-hidden>{emoji}</span>
                                <span>{REACTION_EMOJI_LABELS[emoji]}</span>
                                {active ? <span className="text-xs text-accent-strong">✓</span> : null}
                              </span>
                            </MenuItem>
                          );
                        })}
                      </MenuContent>
                    </Menu>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void handleLoadMore()}>
            {loadingMore ? "Wczytywanie…" : "Wczytaj więcej aktywności"}
          </Button>
        </div>
      ) : null}

      <div className="rounded-card border border-border-primary bg-bg-secondary/45 p-4">
        <CommentEditor
          value={newBody}
          onChange={setNewBody}
          onSubmit={handleCreateComment}
          members={members}
          busy={creating}
          submitLabel="Dodaj komentarz"
          ariaLabel="Nowy komentarz"
          canUploadAttachment={canWriteIssues}
          uploadDisabled={uploadDisabled}
          onUploadAttachment={onUploadAttachment}
        />
      </div>

      <ConfirmDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null);
        }}
        title="Usunąć komentarz?"
        description="Treść komentarza zostanie ukryta, a w strumieniu aktywności pozostanie informacja „Komentarz usunięty”."
        confirmLabel="Usuń komentarz"
        danger
        onConfirm={() => void handleDeleteComment()}
      />
    </section>
  );
}
