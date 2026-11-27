/**
 * Bezpieczny parser ograniczonego Markdown dla komentarzy KivoTasks (etap 2a).
 *
 * Moduł generuje wyłącznie drzewa węzłów AST do renderowania w Reakcie — nigdy surowego HTML
 * (`dangerouslySetInnerHTML` nie jest używane). Każdy znacznik HTML w tekście pozostaje zwykłym
 * tekstem, a odnośniki przechodzą przez ścisłą białą listę protokołów (`http:`, `https:`, `mailto:`).
 */

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const MAX_MARKDOWN_LABEL_LENGTH = 500;
const MAX_MARKDOWN_URL_LENGTH = 2048;
// Każdy znak w etykiecie może być sekwencją ucieczki `\[` lub `\]` (2 jednostki kodu UTF-16).
const MAX_RAW_LABEL_CODE_UNITS = MAX_MARKDOWN_LABEL_LENGTH * 2;

const MENTION_REGEX = /@\[([^[\]\r\n]{1,120})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/iy;

/**
 * Ścisły wzorzec ścieżki względnej do zawartości załącznika KivoTasks (wyłącznie małe litery UUID,
 * bez parametrów zapytania, fragmentów, białych znaków, ukośników odwrotnych ani segmentów ścieżki).
 */
const ATTACHMENT_CONTENT_PATH_REGEX =
  /^\/api\/v1\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/;

const IMAGE_REGEX = /!\[((?:\\[[\]]|[^[\]\\\r\n]|\\(?![[\]\r\n])){0,500})\]\(([^)\r\n]{1,2048})\)/y;
const LINK_REGEX = /\[((?:\\[[\]]|[^[\]\\\r\n]|\\(?![[\]\r\n])){1,500})\]\(([^)\r\n]{1,2048})\)/y;

function unescapeMarkdownBrackets(value: string): string {
  return value.replace(/\\([[\]])/g, "$1");
}

/** Zwraca `true` wyłącznie dla dokładnej ścieżki względnej `/api/v1/attachments/<uuid>/content`. */
export function isAttachmentContentUrl(rawUrl: string): boolean {
  return ATTACHMENT_CONTENT_PATH_REGEX.test(rawUrl);
}

export type MarkdownInlineNode =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "strong"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "em"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "del"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "link"; readonly href: string; readonly label: string }
  | { readonly type: "image"; readonly src: string; readonly alt: string }
  | { readonly type: "mention"; readonly accountId: string; readonly label: string }
  | { readonly type: "break" };

export type MarkdownBlockNode =
  | { readonly type: "paragraph"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3 | 4; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "code"; readonly language: string | null; readonly value: string }
  | { readonly type: "blockquote"; readonly children: readonly MarkdownInlineNode[] }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly (readonly MarkdownInlineNode[])[] };

/**
 * Waliduje adres odnośnika z Markdown: dopuszcza wyłącznie `http:`, `https:`, `mailto:`
 * oraz dokładną ścieżkę względną `/api/v1/attachments/<uuid>/content`.
 * Odrzuca m.in. pozostałe ścieżki względne, `javascript:`, `data:`, `vbscript:`, znaki sterujące i `//...`.
 */
export function sanitizeMarkdownUrl(rawUrl: string): string | null {
  if (isAttachmentContentUrl(rawUrl)) {
    return rawUrl;
  }
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

function parseInlineInternal(
  text: string,
  normalizedMentions: ReadonlySet<string> | null,
  depth: number,
): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = [];

  let nextNewline = text.indexOf("\n", 0);
  let nextCloseBracket = text.indexOf("]", 0);
  let nextCloseParen = text.indexOf(")", 0);
  let noMoreBacktick = false;
  let noMoreDoubleStar = false;
  let noMoreDoubleTilde = false;
  let noMoreSingleStar = false;

  let index = 0;
  let plainStart = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) {
      appendText(nodes, text.slice(plainStart, end));
    }
  };

  while (index < text.length) {
    const ch = text[index]!;

    // Złamanie linii
    if (ch === "\n") {
      flushPlain(index);
      nodes.push({ type: "break" });
      index += 1;
      plainStart = index;
      continue;
    }

    // Kod śródliniowy: `...`
    if (ch === "`" && !noMoreBacktick) {
      if (nextNewline !== -1 && nextNewline < index + 1) {
        nextNewline = text.indexOf("\n", index + 1);
      }
      const end = text.indexOf("`", index + 1);
      if (end === -1) {
        noMoreBacktick = true;
      } else if (end > index + 1 && (nextNewline === -1 || nextNewline > end)) {
        flushPlain(index);
        nodes.push({ type: "code", value: text.slice(index + 1, end) });
        index = end + 1;
        plainStart = index;
        continue;
      }
    }

    // Wzmianka: @[Imię Nazwisko](uuid) — renderowana jako wzmianka tylko dla zweryfikowanych kont
    if (ch === "@" && text.charCodeAt(index + 1) === 91 /* [ */) {
      if (nextCloseBracket !== -1 && nextCloseBracket < index + 2) {
        nextCloseBracket = text.indexOf("]", index + 2);
      }
      if (nextCloseParen !== -1 && nextCloseParen < index + 4) {
        nextCloseParen = text.indexOf(")", index + 4);
      }
      if (
        nextCloseBracket !== -1 &&
        nextCloseParen !== -1 &&
        nextCloseBracket <= index + 122 &&
        nextCloseParen <= index + 160
      ) {
        MENTION_REGEX.lastIndex = index;
        const mentionMatch = MENTION_REGEX.exec(text);
        if (mentionMatch) {
          flushPlain(index);
          const label = mentionMatch[1]!;
          const accountId = mentionMatch[2]!.toLowerCase();
          if (normalizedMentions?.has(accountId)) {
            nodes.push({ type: "mention", accountId, label });
          } else {
            appendText(nodes, mentionMatch[0]);
          }
          index = MENTION_REGEX.lastIndex;
          plainStart = index;
          continue;
        }
      }
    }

    // Obraz załącznika: ![alt](/api/v1/attachments/<uuid>/content) — każdy inny ![...](...) zostaje zwykłym tekstem
    if (ch === "!" && text.charCodeAt(index + 1) === 91 /* [ */) {
      if (nextCloseBracket !== -1 && nextCloseBracket < index + 2) {
        nextCloseBracket = text.indexOf("]", index + 2);
      }
      if (nextCloseParen !== -1 && nextCloseParen < index + 4) {
        nextCloseParen = text.indexOf(")", index + 4);
      }
      if (
        nextCloseBracket !== -1 &&
        nextCloseParen !== -1 &&
        nextCloseBracket - index <= MAX_RAW_LABEL_CODE_UNITS + 2 &&
        nextCloseParen - index <= MAX_RAW_LABEL_CODE_UNITS + MAX_MARKDOWN_URL_LENGTH + 4
      ) {
        IMAGE_REGEX.lastIndex = index;
        const imageMatch = IMAGE_REGEX.exec(text);
        if (imageMatch) {
          flushPlain(index);
          const rawAlt = imageMatch[1]!;
          const rawSrc = imageMatch[2]!;
          if (isAttachmentContentUrl(rawSrc)) {
            nodes.push({ type: "image", src: rawSrc, alt: unescapeMarkdownBrackets(rawAlt) });
          } else {
            appendText(nodes, imageMatch[0]);
          }
          index = IMAGE_REGEX.lastIndex;
          plainStart = index;
          continue;
        }
      }
    }

    // Odnośnik: [tekst](url)
    if (ch === "[") {
      if (nextCloseBracket !== -1 && nextCloseBracket < index + 1) {
        nextCloseBracket = text.indexOf("]", index + 1);
      }
      if (nextCloseParen !== -1 && nextCloseParen < index + 3) {
        nextCloseParen = text.indexOf(")", index + 3);
      }
      if (
        nextCloseBracket !== -1 &&
        nextCloseParen !== -1 &&
        nextCloseBracket - index <= MAX_RAW_LABEL_CODE_UNITS + 1 &&
        nextCloseParen - index <= MAX_RAW_LABEL_CODE_UNITS + MAX_MARKDOWN_URL_LENGTH + 3
      ) {
        LINK_REGEX.lastIndex = index;
        const linkMatch = LINK_REGEX.exec(text);
        if (linkMatch) {
          flushPlain(index);
          const label = unescapeMarkdownBrackets(linkMatch[1]!);
          const safeUrl = sanitizeMarkdownUrl(linkMatch[2]!);
          if (safeUrl) {
            nodes.push({ type: "link", href: safeUrl, label });
          } else {
            appendText(nodes, label);
          }
          index = LINK_REGEX.lastIndex;
          plainStart = index;
          continue;
        }
      }
    }

    // Pogrubienie: **...**
    if (depth < 4 && ch === "*" && text.charCodeAt(index + 1) === 42 /* * */ && !noMoreDoubleStar) {
      const end = text.indexOf("**", index + 2);
      if (end === -1) {
        noMoreDoubleStar = true;
      } else if (end > index + 2 && text.charCodeAt(index + 2) !== 32 && text.charCodeAt(end - 1) !== 32) {
        flushPlain(index);
        const inner = text.slice(index + 2, end);
        nodes.push({ type: "strong", children: parseInlineInternal(inner, normalizedMentions, depth + 1) });
        index = end + 2;
        plainStart = index;
        continue;
      }
    }

    // Przekreślenie: ~~...~~
    if (depth < 4 && ch === "~" && text.charCodeAt(index + 1) === 126 /* ~ */ && !noMoreDoubleTilde) {
      const end = text.indexOf("~~", index + 2);
      if (end === -1) {
        noMoreDoubleTilde = true;
      } else if (end > index + 2) {
        flushPlain(index);
        const inner = text.slice(index + 2, end);
        nodes.push({ type: "del", children: parseInlineInternal(inner, normalizedMentions, depth + 1) });
        index = end + 2;
        plainStart = index;
        continue;
      }
    }

    // Kursywa: *...*
    if (depth < 4 && ch === "*" && text.charCodeAt(index + 1) !== 42 /* * */ && !noMoreSingleStar) {
      if (nextNewline !== -1 && nextNewline < index + 1) {
        nextNewline = text.indexOf("\n", index + 1);
      }
      const end = text.indexOf("*", index + 1);
      if (end === -1) {
        noMoreSingleStar = true;
      } else if (
        end > index + 1 &&
        text.charCodeAt(index + 1) !== 32 &&
        text.charCodeAt(end - 1) !== 32 &&
        (nextNewline === -1 || nextNewline > end)
      ) {
        flushPlain(index);
        const inner = text.slice(index + 1, end);
        nodes.push({ type: "em", children: parseInlineInternal(inner, normalizedMentions, depth + 1) });
        index = end + 1;
        plainStart = index;
        continue;
      }
    }

    index += 1;
  }

  flushPlain(text.length);
  return nodes;
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
  const normalizedMentions = mentionedAccountIds
    ? new Set([...mentionedAccountIds].map((id) => id.toLowerCase()))
    : null;
  return parseInlineInternal(text, normalizedMentions, depth);
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
