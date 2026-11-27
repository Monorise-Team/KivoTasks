/**
 * Czyste testy jednostkowe (bez bazy danych i bez MinIO) logiki etapu 2b (załączniki):
 * - rozpoznawanie typu MIME po bajtach magicznych,
 * - oczyszczanie nazw plików (NFC, ścieżki, znaki sterujące/bidi, długość UTF-16, surogaty),
 * - budowanie nagłówka Content-Disposition (inline/attachment, ASCII fallback, RFC 5987),
 * - SHA-256, klucz obiektu S3, ETag/If-None-Match, zużycie miejsca i komunikat 413,
 * - obrazy i linki względne w Markdown wyłącznie dla `/api/v1/attachments/<uuid>/content`,
 * - formatowanie rozmiaru pliku (pl-PL), komunikaty limitu miejsca i aktywności,
 * - parsowanie ustawień S3 i limitów w `config.ts` oraz przepuszczanie `Response` w `route()`.
 */
import type { IssueEvent } from "@kivotasks/client";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatIssueEventText } from "@/app/app/activity-ui";
import {
  escapeMarkdownLinkLabel,
  formatAttachmentMarkdown,
  formatFileSize,
  formatStorageBanner,
  insertTextAtCursor,
} from "@/app/app/attachments-ui";
import { MarkdownContent } from "@/app/app/components/MarkdownContent";
import { isAttachmentContentUrl, parseMarkdownBlocks, sanitizeMarkdownUrl } from "@/app/app/markdown";
import { ApiFailure, route } from "@/server/api";
import {
  buildAttachmentStorageKey,
  buildContentDisposition,
  computeSha256Hex,
  computeStorageUsage,
  detectAttachmentContentType,
  formatMaxFileLimitMessage,
  isInlineAttachmentContentType,
  matchesIfNoneMatch,
  sanitizeAttachmentFileName,
} from "@/server/attachment-helpers";
import { redactIssueEvent } from "@/server/collaboration-helpers";
import { config, DEFAULT_ATTACHMENT_MAX_BYTES, DEFAULT_STORAGE_QUOTA_BYTES } from "@/server/config";

const SAMPLE_UUID = "019a0000-0000-7000-8000-000000000001";
const ANNA_ID = "019a0000-0000-7000-8000-000000000010";

describe("rozpoznawanie typu pliku po bajtach magicznych", () => {
  it("rozpoznaje wyłącznie PNG, JPEG, GIF87a/GIF89a i WebP", () => {
    expect(detectAttachmentContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    expect(detectAttachmentContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectAttachmentContentType(new TextEncoder().encode("GIF87a..."))).toBe("image/gif");
    expect(detectAttachmentContentType(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(
      detectAttachmentContentType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
  });

  it("zwraca application/octet-stream dla HTML, SVG, PDF, RIFF bez WEBP i uciętych nagłówków", () => {
    expect(detectAttachmentContentType(new TextEncoder().encode("<!doctype html><script>alert(1)</script>"))).toBe(
      "application/octet-stream",
    );
    expect(
      detectAttachmentContentType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBe("application/octet-stream");
    expect(detectAttachmentContentType(new TextEncoder().encode("%PDF-1.7\n"))).toBe("application/octet-stream");
    // RIFF WAVE to nie WebP
    expect(
      detectAttachmentContentType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBe("application/octet-stream");
    // Ucięte nagłówki
    expect(detectAttachmentContentType(new Uint8Array([]))).toBe("application/octet-stream");
    expect(detectAttachmentContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]))).toBe(
      "application/octet-stream",
    );
    expect(detectAttachmentContentType(new Uint8Array([0xff, 0xd8]))).toBe("application/octet-stream");
    expect(detectAttachmentContentType(new TextEncoder().encode("GIF89"))).toBe("application/octet-stream");
    expect(detectAttachmentContentType(new TextEncoder().encode("GIF88a"))).toBe("application/octet-stream");
    expect(detectAttachmentContentType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42]))).toBe(
      "application/octet-stream",
    );
  });

  it("oznacza inline wyłącznie cztery obsługiwane formaty obrazów", () => {
    expect(isInlineAttachmentContentType("image/png")).toBe(true);
    expect(isInlineAttachmentContentType("image/jpeg")).toBe(true);
    expect(isInlineAttachmentContentType("image/gif")).toBe(true);
    expect(isInlineAttachmentContentType("image/webp")).toBe(true);
    expect(isInlineAttachmentContentType("application/octet-stream")).toBe(false);
    expect(isInlineAttachmentContentType("image/svg+xml")).toBe(false);
    expect(isInlineAttachmentContentType("text/html")).toBe(false);
  });
});

describe("oczyszczanie nazwy pliku i nagłówek Content-Disposition", () => {
  it("normalizuje NFC, odcina ścieżkę, usuwa znaki sterujące i bidi, zbija spacje i usuwa wiodące kropki", () => {
    expect(sanitizeAttachmentFileName("e\u0301.png")).toBe("\u00e9.png");
    expect(sanitizeAttachmentFileName("/etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentFileName("C:\\Users\\Anna\\Desktop\\raport.pdf")).toBe("raport.pdf");
    expect(sanitizeAttachmentFileName("a/b\\c/d.txt")).toBe("d.txt");
    expect(sanitizeAttachmentFileName("bez\u0000ster\u001f\u007f\u0085\u009f\u2028\u2029.txt")).toBe("bezster.txt");
    // Bidi overrides (np. atak RLO U+202E zamieniający rozszerzenie) i izolacje U+2066–2069
    expect(sanitizeAttachmentFileName("faktura\u202egnp.exe")).toBe("fakturagnp.exe");
    expect(sanitizeAttachmentFileName("a\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069b.png")).toBe("ab.png");
    expect(sanitizeAttachmentFileName("  raport    2026  .pdf  ")).toBe("raport 2026 .pdf");
    expect(sanitizeAttachmentFileName("...env")).toBe("env");
    expect(sanitizeAttachmentFileName(". . .tajne.txt")).toBe("tajne.txt");
  });

  it("wraca do nazwy zastępczej plik, gdy po oczyszczeniu nic nie zostało", () => {
    expect(sanitizeAttachmentFileName("")).toBe("plik");
    expect(sanitizeAttachmentFileName("   ")).toBe("plik");
    expect(sanitizeAttachmentFileName("...")).toBe("plik");
    expect(sanitizeAttachmentFileName(". . .")).toBe("plik");
    expect(sanitizeAttachmentFileName("katalog/")).toBe("plik");
    expect(sanitizeAttachmentFileName("\u0000\u001f\u202e")).toBe("plik");
  });

  it("przycina nazwę do 255 jednostek kodu UTF-16 bez rozcinania pary surogatów", () => {
    const exact = `${"a".repeat(253)}😀`;
    expect(exact.length).toBe(255);
    expect(sanitizeAttachmentFileName(exact)).toBe(exact);

    // 254 razy 'a' + emoji (2 jednostki UTF-16) = 256 -> cofa do 254, bez osieroconego surogatu
    const splitBoundary = `${"a".repeat(254)}😀`;
    expect(splitBoundary.length).toBe(256);
    const sanitized = sanitizeAttachmentFileName(splitBoundary);
    expect(sanitized.length).toBe(254);
    expect(sanitized).toBe("a".repeat(254));
    expect(() => encodeURIComponent(sanitized)).not.toThrow();
  });

  it("buduje poprawny Content-Disposition (inline vs attachment, ASCII fallback i RFC 5987)", () => {
    expect(buildContentDisposition("zrzut.png", "image/png")).toBe(
      `inline; filename="zrzut.png"; filename*=UTF-8''zrzut.png`,
    );

    const tricky = `zażółć "raport" (1)'*\\a.pdf`;
    const header = buildContentDisposition(tricky, "application/octet-stream");
    expect(header.startsWith(`attachment; filename="za____ _raport_ (1)'*_a.pdf"; filename*=UTF-8''`)).toBe(true);
    // RFC 5987 koduje także ', (, ), *
    const encodedPart = header.split("filename*=UTF-8''")[1]!;
    expect(encodedPart).not.toMatch(/['()*"]/);
    expect(decodeURIComponent(encodedPart)).toBe(tricky);
  });

  it("oblicza SHA-256, buduje klucz S3 bez nazwy pliku i obsługuje If-None-Match oraz limity", () => {
    expect(computeSha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    const key = buildAttachmentStorageKey({
      organizationId: "org-1",
      issueId: "issue-1",
      attachmentId: SAMPLE_UUID,
    });
    expect(key).toBe(`organizations/org-1/issues/issue-1/attachments/${SAMPLE_UUID}`);

    expect(matchesIfNoneMatch(`"${SAMPLE_UUID}"`, `"${SAMPLE_UUID}"`)).toBe(true);
    expect(matchesIfNoneMatch(`W/"${SAMPLE_UUID}"`, `"${SAMPLE_UUID}"`)).toBe(true);
    expect(matchesIfNoneMatch(`"inny", "${SAMPLE_UUID}"`, `"${SAMPLE_UUID}"`)).toBe(true);
    expect(matchesIfNoneMatch("*", `"${SAMPLE_UUID}"`)).toBe(true);
    expect(matchesIfNoneMatch(`"inny"`, `"${SAMPLE_UUID}"`)).toBe(false);
    expect(matchesIfNoneMatch(null, `"${SAMPLE_UUID}"`)).toBe(false);

    expect(computeStorageUsage(0, 1000, 100)).toEqual({
      usedBytes: 0,
      quotaBytes: 1000,
      maxFileBytes: 100,
      usedRatio: 0,
      state: "OK",
    });
    expect(computeStorageUsage(799, 1000, 100).state).toBe("OK");
    expect(computeStorageUsage(800, 1000, 100).state).toBe("WARNING");
    expect(computeStorageUsage(999, 1000, 100).state).toBe("WARNING");
    expect(computeStorageUsage(1000, 1000, 100).state).toBe("FULL");
    expect(computeStorageUsage(1500, 1000, 100).state).toBe("FULL");

    expect(formatMaxFileLimitMessage(26_214_400)).toBe("Plik jest większy niż 25 MB");
    expect(formatMaxFileLimitMessage(1_572_864)).toBe("Plik jest większy niż 1,5 MB");
  });
});

describe("Markdown: obrazy i linki względne wyłącznie dla /api/v1/attachments/<uuid>/content", () => {
  const validPath = `/api/v1/attachments/${SAMPLE_UUID}/content`;

  it("akceptuje dokładnie wzorzec /api/v1/attachments/<uuid>/content i odrzuca podchwytliwe warianty", () => {
    expect(isAttachmentContentUrl(validPath)).toBe(true);
    expect(sanitizeMarkdownUrl(validPath)).toBe(validPath);

    const trickyRejected = [
      `${validPath}/../x`,
      `${validPath}/extra`,
      `${validPath}?download=1`,
      `${validPath}#hash`,
      ` ${validPath}`,
      `${validPath} `,
      `${validPath}\t`,
      `/api/v1/attachments/${SAMPLE_UUID}/content%2F..%2Fx`,
      `/api/v1/attachments/${SAMPLE_UUID}%2Fcontent`,
      `/api/v1/attachments/%2e%2e/content`,
      `/api/v1/attachments/${SAMPLE_UUID.toUpperCase()}/content`,
      `/API/v1/attachments/${SAMPLE_UUID}/content`,
      `/api/v1/attachments/${SAMPLE_UUID}/CONTENT`,
      `/api/v1/attachments/${SAMPLE_UUID}/content\\x`,
      `\\api\\v1\\attachments\\${SAMPLE_UUID}\\content`,
      `/api/v1/attachments/not-a-uuid/content`,
      `/api/v1/issues/${SAMPLE_UUID}`,
      `//evil.test${validPath}`,
      `javascript:alert(1)`,
      `data:image/png;base64,AAAA`,
    ];

    for (const bad of trickyRejected) {
      expect(isAttachmentContentUrl(bad), `Oczekiwano odrzucenia obrazu: ${bad}`).toBe(false);
      expect(sanitizeMarkdownUrl(bad), `Oczekiwano odrzucenia linku: ${bad}`).toBeNull();
    }

    // Zewnętrzny URL https nie może zostać obrazem, choć może być linkiem
    expect(isAttachmentContentUrl(`https://evil.test${validPath}`)).toBe(false);
    expect(sanitizeMarkdownUrl("https://monorise.studio")).toBe("https://monorise.studio/");
  });

  it("renderuje obraz załącznika jako <img> (lazy) w linku, a wszystkie inne ![...](...) zostawia jako zwykły tekst", () => {
    const markdown = [
      `![zrzut \\[1\\].png](${validPath})`,
      "",
      `[raport \\[2026\\].pdf](${validPath})`,
      "",
      `![zewnętrzny](https://evil.test/tracker.png)`,
      "",
      `![zły](${validPath}?x=1)`,
      "",
      `[zły względny](/api/v1/attachments/${SAMPLE_UUID}/content/../secret)`,
    ].join("\n");

    const blocks = parseMarkdownBlocks(markdown);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "image", src: validPath, alt: "zrzut [1].png" }],
    });
    expect(blocks[1]).toEqual({
      type: "paragraph",
      children: [{ type: "link", href: validPath, label: "raport [2026].pdf" }],
    });
    // Zewnętrzny obraz NIE staje się linkiem ani <img> — zostaje zwykłym tekstem
    expect(blocks[2]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "![zewnętrzny](https://evil.test/tracker.png)" }],
    });
    expect(blocks[3]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: `![zły](${validPath}?x=1)` }],
    });
    expect(blocks[4]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "zły względny" }],
    });

    const html = renderToStaticMarkup(createElement(MarkdownContent, { body: markdown }));
    expect(html).toContain(`<a href="${validPath}"`);
    expect(html).toContain(`<img src="${validPath}" alt="zrzut [1].png" loading="lazy" decoding="async"`);
    expect(html).toContain(">raport [2026].pdf</a>");
    expect(html).not.toContain('src="https://evil.test/tracker.png"');
    expect(html).not.toContain('href="https://evil.test/tracker.png"');
    expect(html).toContain("![zewnętrzny](https://evil.test/tracker.png)");
  });
});

describe("pomocniki UI załączników, aktywność i redakcja zdarzeń", () => {
  it("formatuje rozmiary plików po polsku (pl-PL) i komunikaty paska miejsca firmy", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1 kB");
    expect(formatFileSize(1536)).toBe("1,5 kB");
    expect(formatFileSize(340 * 1024)).toBe("340 kB");
    expect(formatFileSize(Math.round(1.2 * 1024 * 1024))).toBe("1,2 MB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatFileSize(1024 * 1024 * 1024)).toBe("1 GB");

    expect(
      formatStorageBanner({
        usedBytes: 100,
        quotaBytes: 1000,
        maxFileBytes: 100,
        usedRatio: 0.1,
        state: "OK",
      }),
    ).toBeNull();

    expect(
      formatStorageBanner({
        usedBytes: 850 * 1024 * 1024,
        quotaBytes: 1024 * 1024 * 1024,
        maxFileBytes: 25 * 1024 * 1024,
        usedRatio: 850 / 1024,
        state: "WARNING",
      }),
    ).toEqual({
      tone: "warning",
      message: "Wykorzystano 83% miejsca na pliki firmy (850 MB z 1 GB).",
    });

    expect(
      formatStorageBanner({
        usedBytes: 1024 * 1024 * 1024,
        quotaBytes: 1024 * 1024 * 1024,
        maxFileBytes: 25 * 1024 * 1024,
        usedRatio: 1,
        state: "FULL",
      }),
    ).toEqual({
      tone: "danger",
      message:
        "Miejsce na pliki firmy jest pełne. Usuń niepotrzebne pliki albo poproś administratora o więcej miejsca.",
    });
  });

  it("buduje fragmenty Markdown z escapowaniem nawiasów i wstawia je w miejscu kursora", () => {
    expect(escapeMarkdownLinkLabel("zrzut [1].png")).toBe("zrzut \\[1\\].png");
    expect(
      formatAttachmentMarkdown({
        fileName: "zrzut [1].png",
        contentUrl: `/api/v1/attachments/${SAMPLE_UUID}/content`,
        inline: true,
      }),
    ).toBe(`![zrzut \\[1\\].png](/api/v1/attachments/${SAMPLE_UUID}/content)`);
    expect(
      formatAttachmentMarkdown({
        fileName: "raport [2026].pdf",
        contentUrl: `/api/v1/attachments/${SAMPLE_UUID}/content`,
        inline: false,
      }),
    ).toBe(`[raport \\[2026\\].pdf](/api/v1/attachments/${SAMPLE_UUID}/content)`);

    expect(insertTextAtCursor("Zobacz: !", 8, 8, "[plik](/x)")).toEqual({
      nextText: "Zobacz: [plik](/x)!",
      nextCursorPos: 18,
    });
  });

  it("formatuje zdarzenia ATTACHMENT_ADDED / ATTACHMENT_REMOVED i nie redaguje ich jako zdarzeń tego samego zadania", () => {
    const names = new Map([[ANNA_ID, "Anna Nowak"]]);
    const added: IssueEvent = {
      id: "ev-1",
      organizationId: "org-1",
      teamId: "team-1",
      issueId: "issue-1",
      actorAccountId: ANNA_ID,
      actorName: "Anna Nowak",
      type: "ATTACHMENT_ADDED",
      before: null,
      after: {
        attachmentId: SAMPLE_UUID,
        fileName: "zrzut.png",
        sizeBytes: 2048,
        contentType: "image/png",
      },
      createdAt: "2026-11-27T12:00:00.000Z",
    };
    const removed: IssueEvent = {
      ...added,
      id: "ev-2",
      type: "ATTACHMENT_REMOVED",
      before: added.after,
      after: null,
    };

    expect(formatIssueEventText(added, names)).toBe("Anna Nowak dodaje załącznik zrzut.png");
    expect(formatIssueEventText(removed, names)).toBe("Anna Nowak usuwa załącznik zrzut.png");

    expect(redactIssueEvent(added, ["team-1"])).toEqual(added);
    expect(redactIssueEvent(removed, ["team-1"])).toEqual(removed);
  });
});

describe("konfiguracja S3 i limitów załączników w config.ts oraz przepuszczanie Response w route()", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.KIVOTASKS_S3_ENDPOINT;
    delete process.env.KIVOTASKS_S3_REGION;
    delete process.env.KIVOTASKS_S3_BUCKET;
    delete process.env.KIVOTASKS_S3_FORCE_PATH_STYLE;
    delete process.env.KIVOTASKS_S3_ACCESS_KEY_ID;
    delete process.env.KIVOTASKS_S3_SECRET_ACCESS_KEY;
    delete process.env.KIVOTASKS_ATTACHMENT_MAX_BYTES;
    delete process.env.KIVOTASKS_STORAGE_QUOTA_BYTES;
    delete process.env.KIVOTASKS_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("zwraca wartości domyślne, parsuje poprawne nadpisania i wraca do domyślnych przy błędnych wartościach", () => {
    expect(config.s3Endpoint).toBe("");
    expect(config.s3Region).toBe("eu-central-1");
    expect(config.s3Bucket).toBe("kivo-tasks-attachments");
    expect(config.s3ForcePathStyle).toBe(false);
    expect(config.s3AccessKeyId).toBe("");
    expect(config.s3SecretAccessKey).toBe("");
    expect(config.attachmentMaxBytes).toBe(DEFAULT_ATTACHMENT_MAX_BYTES);
    expect(config.storageQuotaBytes).toBe(DEFAULT_STORAGE_QUOTA_BYTES);

    process.env.KIVOTASKS_S3_ENDPOINT = " http://127.0.0.1:9036 ";
    process.env.KIVOTASKS_S3_REGION = "eu-west-1";
    process.env.KIVOTASKS_S3_BUCKET = "my-bucket";
    process.env.KIVOTASKS_S3_FORCE_PATH_STYLE = "true";
    process.env.KIVOTASKS_S3_ACCESS_KEY_ID = "key";
    process.env.KIVOTASKS_S3_SECRET_ACCESS_KEY = "secret";
    process.env.KIVOTASKS_ATTACHMENT_MAX_BYTES = "1024";
    process.env.KIVOTASKS_STORAGE_QUOTA_BYTES = "4096";

    expect(config.s3Endpoint).toBe("http://127.0.0.1:9036");
    expect(config.s3Region).toBe("eu-west-1");
    expect(config.s3Bucket).toBe("my-bucket");
    expect(config.s3ForcePathStyle).toBe(true);
    expect(config.s3AccessKeyId).toBe("key");
    expect(config.s3SecretAccessKey).toBe("secret");
    expect(config.attachmentMaxBytes).toBe(1024);
    expect(config.storageQuotaBytes).toBe(4096);

    for (const bad of ["0", "-50", "12.5", "25mb", "abc", "Infinity", "9007199254740993", ""]) {
      process.env.KIVOTASKS_ATTACHMENT_MAX_BYTES = bad;
      process.env.KIVOTASKS_STORAGE_QUOTA_BYTES = bad;
      expect(config.attachmentMaxBytes, `maxBytes dla "${bad}"`).toBe(DEFAULT_ATTACHMENT_MAX_BYTES);
      expect(config.storageQuotaBytes, `quotaBytes dla "${bad}"`).toBe(DEFAULT_STORAGE_QUOTA_BYTES);
    }

    process.env.KIVOTASKS_S3_FORCE_PATH_STYLE = "yes";
    expect(config.s3ForcePathStyle).toBe(false);
  });

  it("route() przepuszcza surową odpowiedź Response z X-Request-Id i CORS, a błędy nadal zwraca jako JSON", async () => {
    process.env.KIVOTASKS_ALLOWED_ORIGINS = "https://panel.acme.test";

    const rawHandler = route(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "private, no-cache",
          ETag: `"${SAMPLE_UUID}"`,
        },
      });
    });

    const req = new NextRequest("http://kivo.localhost:3500/api/v1/raw", {
      headers: { host: "kivo.localhost:3500", origin: "https://panel.acme.test" },
    });
    const res = await rawHandler(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toBe(`"${SAMPLE_UUID}"`);
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://panel.acme.test");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const errorHandler = route(async () => {
      throw new ApiFailure(413, "PAYLOAD_TOO_LARGE", "Plik jest większy niż 25 MB");
    });
    const errRes = await errorHandler(req, { params: Promise.resolve({}) });
    expect(errRes.status).toBe(413);
    const errBody = (await errRes.json()) as { data: null; meta: { requestId: string }; error: { code: string } };
    expect(errBody.data).toBeNull();
    expect(errBody.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(errBody.meta.requestId).toMatch(/^req_/);
  });
});
