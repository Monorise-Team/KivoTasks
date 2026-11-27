/**
 * Bezpieczny parser ograniczonego Markdown dla komentarzy KivoTasks (etap 2a).
 *
 * Moduł generuje wyłącznie drzewa węzłów AST do renderowania w Reakcie — nigdy surowego HTML
 * (`dangerouslySetInnerHTML` nie jest używane). Każdy znacznik HTML w tekście pozostaje zwykłym
 * tekstem, a odnośniki przechodzą przez ścisłą białą listę protokołów (`http:`, `https:`, `mailto:`).
 */

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const MENTION_REGEX = /@\[([^\]\r\n]{1,120})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i;

export type MarkdownInlineNode =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "strong"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "em"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "del"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "link"; readonly href: string; readonly label: string }
  | { readonly type: "mention"; readonly accountId: string; readonly label: string }
  | { readonly type: "break" };

export type MarkdownBlockNode =
  | { readonly type: "paragraph"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3 | 4; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "code"; readonly language: string | null; readonly value: string }
  | { readonly type: "blockquote"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly (readonly MarkdownInlineNode[])[] };

/**
 * Waliduje adres odnośnika z Markdown: dopuszcza wyłącznie `http:`, `https:` i `mailto:`.
 * Odrzuca m.in. `javascript:`, `data:`, `vbscript:`, adresy ze znakami sterującymi oraz `//...`.
 */
export function sanitizeMarkdownUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return null;
  // Odrzuć znaki sterujące i białe znaki w środku adresu (klasyczne obejścia schematów)
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || /\s/.test(trimmed[i]!)) {
      return null;
    }
  }
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_LINK_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function appendText(nodes: MarkdownInlineNode[], chunk: string): void {
  if (!chunk) return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === "text") {
    nodes[nodes.length - 1] = { type: "text", value: `${last.value}${chunk}` };
  } else {
    nodes.push({ type: "text", value: chunk });
  }
}

/**
 * Parsuje tekst śródliniowy Markdown (kod, zweryfikowane wzmianki, bezpieczne linki, pogrubienie,
 * kursywa, przekreślenie, złamania linii). Surowy HTML zawsze zostaje zwykłym tekstem.
 */
export function parseMarkdownInline(
  text: string,
  mentionedAccountIds?: ReadonlySet<string>,
  depth = 0,
): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = [];
  const normalizedMentions = mentionedAccountIds
    ? new Set([...mentionedAccountIds].map((id) => id.toLowerCase()))
    : null;

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    // Złamanie linii
    if (rest.startsWith("\n")) {
      nodes.push({ type: "break" });
      index += 1;
      continue;
    }

    // Kod śródliniowy: `...`
    if (rest.startsWith("`")) {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1 && !text.slice(index + 1, end).includes("\n")) {
        nodes.push({ type: "code", value: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    // Wzmianka: @[Imię Nazwisko](uuid) — renderowana jako wzmianka tylko dla zweryfikowanych kont
    if (rest.startsWith("@[")) {
      const mentionMatch = MENTION_REGEX.exec(rest);
      if (mentionMatch && mentionMatch.index === 0) {
        const label = mentionMatch[1]!;
        const accountId = mentionMatch[2]!.toLowerCase();
        if (normalizedMentions?.has(accountId)) {
          nodes.push({ type: "mention", accountId, label });
        } else {
          appendText(nodes, mentionMatch[0]);
        }
        index += mentionMatch[0].length;
        continue;
      }
    }

    // Odnośnik: [tekst](url)
    if (rest.startsWith("[")) {
      const linkMatch = /^\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/.exec(rest);
      if (linkMatch) {
        const label = linkMatch[1]!;
        const safeUrl = sanitizeMarkdownUrl(linkMatch[2]!);
        if (safeUrl) {
          nodes.push({ type: "link", href: safeUrl, label });
        } else {
          appendText(nodes, label);
        }
        index += linkMatch[0].length;
        continue;
      }
    }

    // Pogrubienie: **...**
    if (depth < 4 && rest.startsWith("**")) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        const inner = text.slice(index + 2, end);
        if (!inner.startsWith(" ") && !inner.endsWith(" ")) {
          nodes.push({ type: "strong", children: parseMarkdownInline(inner, mentionedAccountIds, depth + 1) });
          index = end + 2;
          continue;
        }
      }
    }

    // Przekreślenie: ~~...~~
    if (depth < 4 && rest.startsWith("~~")) {
      const end = text.indexOf("~~", index + 2);
      if (end > index + 2) {
        const inner = text.slice(index + 2, end);
        nodes.push({ type: "del", children: parseMarkdownInline(inner, mentionedAccountIds, depth + 1) });
        index = end + 2;
        continue;
      }
    }

    // Kursywa: *...*
    if (depth < 4 && rest.startsWith("*") && !rest.startsWith("**")) {
      const end = text.indexOf("*", index + 1);
      if (end > index + 1) {
        const inner = text.slice(index + 1, end);
        if (!inner.startsWith(" ") && !inner.endsWith(" ") && !inner.includes("\n")) {
          nodes.push({ type: "em", children: parseMarkdownInline(inner, mentionedAccountIds, depth + 1) });
          index = end + 1;
          continue;
        }
      }
    }

    appendText(nodes, text[index]!);
    index += 1;
  }

  return nodes;
}

const HEADING_REGEX = /^(#{1,4})\s+(.+)$/;
const UNORDERED_ITEM_REGEX = /^\s*[-*]\s+(.+)$/;
const ORDERED_ITEM_REGEX = /^\s*\d+\.\s+(.+)$/;
const BLOCKQUOTE_REGEX = /^>\s?(.*)$/;
const CODE_FENCE_REGEX = /^```([A-Za-z0-9_+-]*)\s*$/;

/**
 * Parsuje treść Markdown komentarza na bezpieczne bloki AST (akapity, nagłówki, listy, cytaty, bloki kodu).
 */
export function parseMarkdownBlocks(markdown: string, mentionedAccountIds?: ReadonlySet<string>): MarkdownBlockNode[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MarkdownBlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Blok kodu ```...```
    const fenceMatch = CODE_FENCE_REGEX.exec(line.trim());
    if (fenceMatch) {
      const language = fenceMatch[1] ? fenceMatch[1] : null;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) {
        i += 1; // pomiń zamykające ```
      }
      blocks.push({ type: "code", language, value: codeLines.join("\n") });
      continue;
    }

    // Nagłówek #..####
    const headingMatch = HEADING_REGEX.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4;
      blocks.push({
        type: "heading",
        level,
        children: parseMarkdownInline(headingMatch[2]!.trim(), mentionedAccountIds),
      });
      i += 1;
      continue;
    }

    // Cytat > ...
    if (BLOCKQUOTE_REGEX.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const match = BLOCKQUOTE_REGEX.exec(lines[i]!);
        if (!match) break;
        quoteLines.push(match[1]!);
        i += 1;
      }
      blocks.push({
        type: "blockquote",
        children: parseMarkdownInline(quoteLines.join("\n"), mentionedAccountIds),
      });
      continue;
    }

    // Lista nieuporządkowana - / *
    if (UNORDERED_ITEM_REGEX.test(line)) {
      const items: MarkdownInlineNode[][] = [];
      while (i < lines.length) {
        const match = UNORDERED_ITEM_REGEX.exec(lines[i]!);
        if (!match) break;
        items.push(parseMarkdownInline(match[1]!, mentionedAccountIds));
        i += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    // Lista numerowana 1. ...
    if (ORDERED_ITEM_REGEX.test(line)) {
      const items: MarkdownInlineNode[][] = [];
      while (i < lines.length) {
        const match = ORDERED_ITEM_REGEX.exec(lines[i]!);
        if (!match) break;
        items.push(parseMarkdownInline(match[1]!, mentionedAccountIds));
        i += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    // Akapit (do pustej linii lub początku kolejnego bloku)
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const current = lines[i]!;
      if (
        current.trim() === "" ||
        CODE_FENCE_REGEX.test(current.trim()) ||
        HEADING_REGEX.test(current) ||
        BLOCKQUOTE_REGEX.test(current) ||
        UNORDERED_ITEM_REGEX.test(current) ||
        ORDERED_ITEM_REGEX.test(current)
      ) {
        break;
      }
      paragraphLines.push(current);
      i += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push({
        type: "paragraph",
        children: parseMarkdownInline(paragraphLines.join("\n"), mentionedAccountIds),
      });
    }
  }

  return blocks;
}
