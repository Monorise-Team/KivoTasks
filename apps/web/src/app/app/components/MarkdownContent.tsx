"use client";

import { cn } from "@monorise-team/ui";
import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdownBlocks, type MarkdownBlockNode, type MarkdownInlineNode } from "../markdown";

export interface MarkdownContentProps {
  readonly body: string;
  readonly mentionedAccountIds?: readonly string[];
  readonly className?: string;
}

function renderInlineNodes(nodes: readonly MarkdownInlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return <Fragment key={key}>{node.value}</Fragment>;
      case "break":
        return <br key={key} />;
      case "strong":
        return (
          <strong key={key} className="font-semibold text-text-primary">
            {renderInlineNodes(node.children, key)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInlineNodes(node.children, key)}</em>;
      case "del":
        return (
          <del key={key} className="text-text-tertiary line-through">
            {renderInlineNodes(node.children, key)}
          </del>
        );
      case "code":
        return (
          <code key={key} className="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-[0.85em] text-text-primary">
            {node.value}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-link underline underline-offset-2 hover:opacity-85"
          >
            {node.label}
          </a>
        );
      case "image":
        return (
          <a
            key={key}
            href={node.src}
            target="_blank"
            rel="noopener noreferrer"
            className="my-1 inline-block max-w-full align-bottom"
          >
            <img
              src={node.src}
              alt={node.alt}
              loading="lazy"
              decoding="async"
              className="max-h-96 max-w-full rounded-control border border-border-primary object-contain"
            />
          </a>
        );
      case "mention":
        return (
          <span
            key={key}
            data-mention-account-id={node.accountId}
            className="inline-flex items-center rounded bg-accent/15 px-1.5 py-0.5 text-[0.9em] font-medium text-accent-strong"
          >
            @{node.label}
          </span>
        );
    }
  });
}

function renderBlock(block: MarkdownBlockNode, index: number): ReactNode {
  const key = `block-${index}`;
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} className="leading-relaxed break-words">
          {renderInlineNodes(block.children, key)}
        </p>
      );
    case "heading": {
      const sizeClass =
        block.level === 1
          ? "text-base font-semibold"
          : block.level === 2
            ? "text-sm font-semibold"
            : "text-sm font-medium";
      return (
        <p
          key={key}
          role="heading"
          aria-level={Math.min(6, block.level + 2)}
          className={cn("text-text-primary", sizeClass)}
        >
          {renderInlineNodes(block.children, key)}
        </p>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 border-border-primary pl-3 text-text-secondary italic">
          {renderInlineNodes(block.children, key)}
        </blockquote>
      );
    case "code":
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-control border border-border-secondary bg-bg-tertiary/80 p-3 font-mono text-xs leading-relaxed text-text-primary"
        >
          <code>{block.value}</code>
        </pre>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag key={key} className={cn("flex flex-col gap-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-item-${itemIndex}`} className="leading-relaxed break-words">
              {renderInlineNodes(item, `${key}-item-${itemIndex}`)}
            </li>
          ))}
        </ListTag>
      );
    }
  }
}

/**
 * Bezpieczny renderer Markdown komentarzy: renderuje wyłącznie węzły Reacta bez surowego HTML,
 * wszystkie linki otrzymują `rel="noopener noreferrer"`, a wzmianki wyróżnia tylko dla zweryfikowanych kont.
 */
export function MarkdownContent({ body, mentionedAccountIds, className }: MarkdownContentProps) {
  const blocks = useMemo(() => {
    const mentionSet = mentionedAccountIds && mentionedAccountIds.length > 0 ? new Set(mentionedAccountIds) : undefined;
    return parseMarkdownBlocks(body, mentionSet);
  }, [body, mentionedAccountIds]);

  return (
    <div className={cn("flex flex-col gap-2 text-sm text-text-primary", className)}>{blocks.map(renderBlock)}</div>
  );
}
