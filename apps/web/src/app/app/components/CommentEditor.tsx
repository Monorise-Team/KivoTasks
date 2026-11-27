"use client";

import type { IssueAttachment, TeamMember } from "@kivotasks/client";
import { Avatar, Button, TextArea, cn } from "@monorise-team/ui";
import { Paperclip } from "lucide-react";
import {
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";
import { extractClipboardImageFile, formatAttachmentMarkdown, insertTextAtCursor } from "../attachments-ui";
import { formatMemberName } from "../issue-ui";
import {
  filterMentionCandidates,
  findActiveMentionQuery,
  insertMentionToken,
  type ActiveMentionQuery,
} from "../mention-autocomplete";

export interface CommentEditorProps {
  readonly value: string;
  readonly onChange: (nextValue: string) => void;
  readonly onSubmit: () => void | Promise<void>;
  readonly onCancel?: () => void;
  readonly members: readonly TeamMember[];
  readonly busy?: boolean;
  readonly submitLabel?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly rows?: number;
  readonly autoFocus?: boolean;
  readonly canUploadAttachment?: boolean;
  readonly uploadDisabled?: boolean;
  readonly onUploadAttachment?: (file: File) => Promise<IssueAttachment | null>;
}

/**
 * Edytor komentarza Markdown z klawiaturowym autouzupełnianiem wzmianek `@` na podstawie członków zespołu.
 */
export function CommentEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  members,
  busy = false,
  submitLabel = "Dodaj komentarz",
  placeholder = "Napisz komentarz… Wpisz @, aby wspomnieć członka zespołu.",
  ariaLabel = "Treść komentarza",
  rows = 3,
  autoFocus = false,
  canUploadAttachment = false,
  uploadDisabled = false,
  onUploadAttachment,
}: CommentEditorProps) {
  const listboxId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cursorPos, setCursorPos] = useState(value.length);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  const mentionQuery: ActiveMentionQuery | null = useMemo(() => {
    const detected = findActiveMentionQuery(value, cursorPos);
    if (!detected) return null;
    if (dismissedAt !== null && dismissedAt === detected.start) return null;
    return detected;
  }, [value, cursorPos, dismissedAt]);

  const candidates = useMemo(
    () => (mentionQuery ? filterMentionCandidates(members, mentionQuery.query) : []),
    [mentionQuery, members],
  );

  const menuOpen = mentionQuery !== null && candidates.length > 0;
  const clampedActiveIndex = menuOpen ? Math.min(activeIndex, candidates.length - 1) : 0;

  const syncCursor = (target: HTMLTextAreaElement) => {
    setCursorPos(target.selectionStart ?? target.value.length);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    const nextPos = event.target.selectionStart ?? nextValue.length;
    onChange(nextValue);
    setCursorPos(nextPos);
    setDismissedAt(null);
    setActiveIndex(0);
  };

  const handleSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    syncCursor(event.currentTarget);
  };

  const handlePickCandidate = (member: TeamMember) => {
    if (!mentionQuery) return;
    const { nextText, nextCursorPos } = insertMentionToken(value, mentionQuery, member);
    onChange(nextText);
    setCursorPos(nextCursorPos);
    setDismissedAt(null);
    setActiveIndex(0);
    window.requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node) {
        node.focus();
        node.setSelectionRange(nextCursorPos, nextCursorPos);
      }
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const picked = candidates[clampedActiveIndex];
        if (picked) {
          event.preventDefault();
          handlePickCandidate(picked);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(mentionQuery?.start ?? null);
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (!busy && value.trim().length > 0) {
        void onSubmit();
      }
    }
  };

  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !uploadingAttachment && value.trim().length > 0) {
      void onSubmit();
    }
  };

  const uploadAndInsertFile = async (file: File) => {
    if (!canUploadAttachment || !onUploadAttachment || uploadDisabled || busy || uploadingAttachment) {
      return;
    }
    const node = textareaRef.current;
    const start = node?.selectionStart ?? cursorPos;
    const end = node?.selectionEnd ?? start;
    setUploadingAttachment(true);
    try {
      const uploaded = await onUploadAttachment(file);
      if (!uploaded) return;
      const snippet = formatAttachmentMarkdown(uploaded);
      const currentText = textareaRef.current?.value ?? value;
      const { nextText, nextCursorPos } = insertTextAtCursor(currentText, start, end, snippet);
      onChange(nextText);
      setCursorPos(nextCursorPos);
      window.requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(nextCursorPos, nextCursorPos);
        }
      });
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleAttachFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      void uploadAndInsertFile(file);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canUploadAttachment || !onUploadAttachment || uploadDisabled || busy || uploadingAttachment) {
      return;
    }
    const imageFile = extractClipboardImageFile(event.clipboardData);
    if (!imageFile) return;
    event.preventDefault();
    void uploadAndInsertFile(imageFile);
  };

  const activeOptionId = menuOpen ? `${listboxId}-opt-${clampedActiveIndex}` : undefined;

  return (
    <form onSubmit={handleFormSubmit} className="relative flex flex-col gap-2">
      <div className="relative">
        <TextArea
          ref={textareaRef}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          placeholder={placeholder}
          value={value}
          rows={rows}
          maxLength={10_000}
          disabled={busy}
          autoFocus={autoFocus}
          onChange={handleChange}
          onSelect={handleSelect}
          onPaste={handlePaste}
          onKeyUp={(event) => syncCursor(event.currentTarget)}
          onKeyDown={handleKeyDown}
        />

        {menuOpen ? (
          <div
            id={listboxId}
            role="listbox"
            aria-label="Wspomnij członka zespołu"
            className="absolute bottom-full left-0 z-30 mb-1.5 flex max-h-56 w-full max-w-sm flex-col overflow-y-auto rounded-card border border-border-primary bg-bg-elevated p-1 shadow-lg"
          >
            {candidates.map((member, index) => {
              const name = formatMemberName(member);
              const selected = index === clampedActiveIndex;
              return (
                <button
                  key={member.accountId}
                  id={`${listboxId}-opt-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(event) => {
                    // Zapobiegaj utracie fokusu w textarea przed wstawieniem tokenu
                    event.preventDefault();
                    handlePickCandidate(member);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-row px-2.5 py-1.5 text-left text-sm transition-colors",
                    selected ? "bg-accent/15 text-text-primary" : "text-text-secondary hover:bg-bg-hover",
                  )}
                >
                  <Avatar name={name} seed={member.accountId} size="sm" />
                  <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{name}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {canUploadAttachment && onUploadAttachment ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                aria-label="Załącz plik do komentarza"
                onChange={handleAttachFileChange}
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon={<Paperclip aria-hidden />}
                disabled={busy || uploadingAttachment || uploadDisabled}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadingAttachment ? "Wysyłanie…" : "Załącz plik"}
              </Button>
            </>
          ) : null}
          <span className="text-xs text-text-tertiary">
            Wpisz @, aby wspomnieć członka zespołu. Obsługiwany jest Markdown. ⌘+Enter lub Ctrl+Enter wysyła komentarz.
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || uploadingAttachment}
              onClick={onCancel}
            >
              Anuluj
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={busy || uploadingAttachment || value.trim().length === 0}
          >
            {busy ? "Zapisywanie…" : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
