/**
 * Czyste testy jednostkowe (bez bazy danych) logiki etapu 2a:
 * - parsowanie i filtrowanie wzmianek (@mentions),
 * - reguły generowania wpisów skrzynki powiadomień (bez sprawcy, bez duplikatu COMMENTED dla MENTIONED),
 * - różnicowanie pól zadania na wpisy historii (brak treści opisu, brak wpisów przy no-op),
 * - dekodowanie emoji reakcji, grupowanie reakcji i kursory stronicowania,
 * - bezpieczne parsowanie i renderowanie Markdown (brak surowego HTML, rel="noopener noreferrer"),
 * - autouzupełnianie @ oraz neutralne polskie komunikaty zdarzeń i skrzynki.
 */
import type { IssueEvent, TeamMember } from "@kivotasks/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatInboxKindText, formatIssueEventText } from "@/app/app/activity-ui";
import { MarkdownContent } from "@/app/app/components/MarkdownContent";
import { parseMarkdownBlocks, sanitizeMarkdownUrl } from "@/app/app/markdown";
import { filterMentionCandidates, findActiveMentionQuery, insertMentionToken } from "@/app/app/mention-autocomplete";
import { ApiFailure } from "@/server/api";
import {
  aggregateCommentReactions,
  buildCommentExcerpt,
  buildIssueUpdateEvents,
  computeAssignmentInboxRecipients,
  computeCommentEditMentionRecipients,
  computeCommentInboxFanout,
  decodeActivityCursor,
  decodeTimeIdCursor,
  encodeActivityCursor,
  encodeTimeIdCursor,
  extractMentionAccountIds,
  filterValidMentionAccountIds,
  parseReactionEmojiParam,
  type IssueEventDiffSnapshot,
} from "@/server/collaboration-helpers";

const ANNA_ID = "019a0000-0000-7000-8000-000000000001";
const JAN_ID = "019a0000-0000-7000-8000-000000000002";
const OLA_ID = "019a0000-0000-7000-8000-000000000003";
const OBCY_ID = "019a0000-0000-7000-8000-000000000099";

describe("parsowanie i filtrowanie wzmianek (@mentions)", () => {
  it("wyłuskuje unikalne UUID z tokenów @[Imię Nazwisko](uuid), ignoruje kod i niepoprawne UUID", () => {
    const body = [
      `Cześć @[Anna Nowak](${ANNA_ID}) oraz @[Jan Kowalski](${JAN_ID.toUpperCase()})!`,
      `Powtórka @[Anna Nowak](${ANNA_ID}) i błędny @[X](nie-uuid).`,
      `W kodzie śródliniowym: \`@[Ola](${OLA_ID})\``,
      "```ts",
      `const example = "@[Obcy](${OBCY_ID})";`,
      "```",
    ].join("\n");

    expect(extractMentionAccountIds(body)).toEqual([ANNA_ID, JAN_ID]);
  });

  it("odrzuca konta spoza listy aktywnych członków zespołu", () => {
    const valid = filterValidMentionAccountIds([ANNA_ID, OBCY_ID, JAN_ID, ANNA_ID], new Set([ANNA_ID, JAN_ID]));
    expect(valid).toEqual([ANNA_ID, JAN_ID]);
  });

  it("buduje zajawkę komentarza ze zweryfikowanymi wzmiankami, a niezweryfikowane zostawia jako zwykły tekst", () => {
    const excerpt = buildCommentExcerpt(
      `Sprawdź **proszę** @[Anna Nowak](${ANNA_ID}) oraz @[Obcy](${OBCY_ID}) pod [link](https://example.test)`,
      [ANNA_ID],
    );
    expect(excerpt).toBe(`Sprawdź proszę @Anna Nowak oraz @[Obcy](${OBCY_ID}) pod link`);
    expect(buildCommentExcerpt(null, [])).toBeNull();
  });
});

describe("reguły fan-out dla skrzynki powiadomień (inbox_items)", () => {
  it("nie tworzy wpisu ASSIGNED dla sprawcy ani przy braku zmiany osoby przypisanej", () => {
    expect(
      computeAssignmentInboxRecipients({
        previousAssigneeAccountId: null,
        nextAssigneeAccountId: JAN_ID,
        actorAccountId: ANNA_ID,
      }),
    ).toEqual([JAN_ID]);

    // Samoprzypisanie -> brak wpisu
    expect(
      computeAssignmentInboxRecipients({
        previousAssigneeAccountId: null,
        nextAssigneeAccountId: ANNA_ID,
        actorAccountId: ANNA_ID,
      }),
    ).toEqual([]);

    // Bez zmiany przypisania -> brak wpisu
    expect(
      computeAssignmentInboxRecipients({
        previousAssigneeAccountId: JAN_ID,
        nextAssigneeAccountId: JAN_ID,
        actorAccountId: ANNA_ID,
      }),
    ).toEqual([]);

    // Usunięcie przypisania -> brak wpisu
    expect(
      computeAssignmentInboxRecipients({
        previousAssigneeAccountId: JAN_ID,
        nextAssigneeAccountId: null,
        actorAccountId: ANNA_ID,
      }),
    ).toEqual([]);
  });

  it("wysyła MENTIONED bez duplikatu COMMENTED i nigdy nie powiadamia autora komentarza", () => {
    // Jan jest już obserwatorem I został wspomniany -> dostaje wyłącznie MENTIONED, bez COMMENTED.
    // Ola jest obserwatorem bez wzmianki -> dostaje COMMENTED.
    // Anna jest autorem, obserwatorem i wspomniała sama siebie -> nie dostaje nic.
    const fanout = computeCommentInboxFanout({
      authorAccountId: ANNA_ID,
      mentionedAccountIds: [ANNA_ID, JAN_ID, JAN_ID],
      subscriberAccountIds: [ANNA_ID, JAN_ID, OLA_ID],
    });
    expect(fanout).toEqual({
      mentionedRecipients: [JAN_ID],
      commentedRecipients: [OLA_ID],
    });
  });

  it("przy edycji komentarza powiadamia wyłącznie nowo wspomniane osoby (bez autora i bez powtórek)", () => {
    expect(
      computeCommentEditMentionRecipients({
        authorAccountId: ANNA_ID,
        previousMentionedAccountIds: [JAN_ID],
        nextMentionedAccountIds: [ANNA_ID, JAN_ID, OLA_ID, OLA_ID],
      }),
    ).toEqual([OLA_ID]);
  });
});

describe("budowanie wpisów historii zadania (issue_events)", () => {
  const baseSnapshot: IssueEventDiffSnapshot = {
    title: "Przegląd strefy przyjęć",
    description: "Pełny poufny opis zadania numer 1",
    state: { id: "s-1", name: "Backlog" },
    priority: 3,
    assigneeAccountId: null,
    labels: [{ id: "l-1", name: "Pilne" }],
    dueDate: "2026-12-01",
    estimate: 3,
    parent: null,
  };

  it("nie generuje żadnych zdarzeń przy aktualizacji bez zmian (no-op) ani przy przestawieniu kolejności etykiet", () => {
    expect(buildIssueUpdateEvents(baseSnapshot, { ...baseSnapshot })).toEqual([]);
    expect(
      buildIssueUpdateEvents(
        {
          ...baseSnapshot,
          labels: [
            { id: "l-2", name: "Błąd" },
            { id: "l-1", name: "Pilne" },
          ],
        },
        {
          ...baseSnapshot,
          labels: [
            { id: "l-1", name: "Pilne" },
            { id: "l-2", name: "Błąd" },
          ],
        },
      ),
    ).toEqual([]);
  });

  it("zapisuje zdarzenie dla każdego zmienionego pola i przechowuje wyłącznie flagę dla opisu (nigdy pełnego tekstu)", () => {
    const secretText = "Bardzo długi poufny opis, który nie może trafić do JSONB historii";
    const events = buildIssueUpdateEvents(baseSnapshot, {
      title: "Nowy tytuł",
      description: secretText,
      state: { id: "s-2", name: "W toku" },
      priority: 1,
      assigneeAccountId: JAN_ID,
      labels: [{ id: "l-2", name: "Błąd" }],
      dueDate: "2026-12-10",
      estimate: 5,
      parent: { id: "p-1", identifier: "MAG-1" },
    });

    expect(events.map((e) => e.type)).toEqual([
      "TITLE_CHANGED",
      "DESCRIPTION_CHANGED",
      "STATE_CHANGED",
      "PRIORITY_CHANGED",
      "ASSIGNEE_CHANGED",
      "LABELS_CHANGED",
      "DUE_DATE_CHANGED",
      "ESTIMATE_CHANGED",
      "PARENT_CHANGED",
    ]);

    const descEvent = events.find((e) => e.type === "DESCRIPTION_CHANGED");
    expect(descEvent).toEqual({
      type: "DESCRIPTION_CHANGED",
      before: { hasDescription: true },
      after: { hasDescription: true },
    });
    expect(JSON.stringify(events)).not.toContain(secretText);
  });
});

describe("reakcje emoji i kursory stronicowania", () => {
  it("dekoduje zakodowane w URL emoji i odrzuca spoza stałego zestawu (422)", () => {
    expect(parseReactionEmojiParam(encodeURIComponent("👍"))).toBe("👍");
    expect(parseReactionEmojiParam(encodeURIComponent("❤️"))).toBe("❤️");
    expect(parseReactionEmojiParam("🚀")).toBe("🚀");

    expect(() => parseReactionEmojiParam(encodeURIComponent("🔥"))).toThrow(ApiFailure);
    expect(() => parseReactionEmojiParam("%E0%A4%A")).toThrow(ApiFailure);
  });

  it("grupuje reakcje w ustalonej kolejności zestawu i zaznacza reactedByMe", () => {
    const summary = aggregateCommentReactions(
      [
        { emoji: "🚀", accountId: JAN_ID },
        { emoji: "👍", accountId: ANNA_ID },
        { emoji: "👍", accountId: JAN_ID },
        { emoji: "🔥", accountId: OLA_ID },
      ],
      ANNA_ID,
    );
    expect(summary).toEqual([
      { emoji: "👍", count: 2, reactedByMe: true },
      { emoji: "🚀", count: 1, reactedByMe: false },
    ]);
  });

  it("koduje i waliduje kursory czasu/ID oraz strumienia aktywności", () => {
    const timeCursor = encodeTimeIdCursor({ t: "2026-11-27T04:00:00.000Z", id: ANNA_ID });
    expect(decodeTimeIdCursor(timeCursor)).toEqual({ t: "2026-11-27T04:00:00.000Z", id: ANNA_ID });
    expect(() => decodeTimeIdCursor("zly-kursor!!!")).toThrow(ApiFailure);

    const actCursor = encodeActivityCursor({ t: "2026-11-27T04:00:00.000Z", r: 1, id: JAN_ID });
    expect(decodeActivityCursor(actCursor)).toEqual({ t: "2026-11-27T04:00:00.000Z", r: 1, id: JAN_ID });
    expect(() => decodeActivityCursor(timeCursor)).toThrow(ApiFailure);
  });
});

describe("bezpieczny Markdown (brak surowego HTML, linki z rel=noopener noreferrer, wzmianki)", () => {
  it("przepuszcza wyłącznie protokoły http:, https: i mailto:, a blokuje javascript:, data: i //", () => {
    expect(sanitizeMarkdownUrl("https://monorise.studio/docs")).toBe("https://monorise.studio/docs");
    expect(sanitizeMarkdownUrl("http://kivo.localhost:3500")).toBe("http://kivo.localhost:3500/");
    expect(sanitizeMarkdownUrl("mailto:anna@acme.test")).toBe("mailto:anna@acme.test");

    expect(sanitizeMarkdownUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeMarkdownUrl("JAVASCRIPT:alert(1)")).toBeNull();
    expect(sanitizeMarkdownUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeMarkdownUrl("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeMarkdownUrl("//evil.test/phish")).toBeNull();
    expect(sanitizeMarkdownUrl("java\nscript:alert(1)")).toBeNull();
  });

  it("escapuje surowy HTML i renderuje bezpieczne linki oraz zweryfikowane wzmianki", () => {
    const markdown = [
      `Cześć @[Anna Nowak](${ANNA_ID}) i nieznany @[Obcy](${OBCY_ID}).`,
      "",
      "Zobacz [dokumentację](https://kivo.monorise.studio) oraz [groźny](javascript:alert(1)).",
      "",
      '<script>alert("xss")</script> <img src=x onerror=alert(1)>',
    ].join("\n");

    const blocks = parseMarkdownBlocks(markdown, new Set([ANNA_ID]));
    expect(blocks).toHaveLength(3);

    const html = renderToStaticMarkup(
      createElement(MarkdownContent, { body: markdown, mentionedAccountIds: [ANNA_ID] }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain('href="https://kivo.monorise.studio/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain(`data-mention-account-id="${ANNA_ID}"`);
    expect(html).toContain("@Anna Nowak");
    // Niezweryfikowany token zostaje zwykłym tekstem, bez znacznika wzmianki
    expect(html).not.toContain(`data-mention-account-id="${OBCY_ID}"`);
    expect(html).toContain(`@[Obcy](${OBCY_ID})`);
  });
});

describe("autouzupełnianie @ i neutralne komunikaty aktywności oraz skrzynki", () => {
  const members: TeamMember[] = [
    { accountId: ANNA_ID, employeeId: "e-1", firstName: "Anna", lastName: "Nowak" },
    { accountId: JAN_ID, employeeId: "e-2", firstName: "Jan", lastName: "Łącki" },
  ];

  it("wykrywa frazę po @, ignoruje e-mail, filtruje z polskimi znakami i wstawia token wzmianki", () => {
    expect(findActiveMentionQuery("Hej @An", 7)).toEqual({ start: 4, end: 7, query: "An" });
    expect(findActiveMentionQuery("Napisz na anna@acme.test", 24)).toBeNull();
    expect(findActiveMentionQuery(`Gotowe @[Anna Nowak](${ANNA_ID})`, 60)).toBeNull();

    expect(filterMentionCandidates(members, "lacki").map((m) => m.accountId)).toEqual([JAN_ID]);

    const inserted = insertMentionToken("Hej @An proszę sprawdź", { start: 4, end: 7 }, members[0]!);
    expect(inserted.nextText).toBe(`Hej @[Anna Nowak](${ANNA_ID})  proszę sprawdź`);
    expect(inserted.nextCursorPos).toBe(`Hej @[Anna Nowak](${ANNA_ID}) `.length);
  });

  it("formatuje zdarzenia historii i skrzynki neutralnie płciowo po polsku bez półpauz", () => {
    const names = new Map<string, string>([
      [ANNA_ID, "Anna Nowak"],
      [JAN_ID, "Jan Kowalski"],
    ]);

    const makeEvent = (
      type: IssueEvent["type"],
      before: Record<string, unknown> | null,
      after: Record<string, unknown> | null,
    ): IssueEvent => ({
      id: "ev-1",
      organizationId: "org-1",
      teamId: "team-1",
      issueId: "issue-1",
      actorAccountId: ANNA_ID,
      actorName: "Anna Nowak",
      type,
      before,
      after,
      createdAt: "2026-11-27T04:00:00.000Z",
    });

    expect(
      formatIssueEventText(
        makeEvent("STATE_CHANGED", { stateId: "s1", stateName: "Backlog" }, { stateId: "s2", stateName: "W toku" }),
        names,
      ),
    ).toBe("Anna Nowak zmienia status na W toku");
    expect(formatIssueEventText(makeEvent("CREATED", null, {}), names)).toBe("Anna Nowak tworzy zadanie");
    expect(
      formatIssueEventText(
        makeEvent("DESCRIPTION_CHANGED", { hasDescription: false }, { hasDescription: true }),
        names,
      ),
    ).toBe("Anna Nowak dodaje opis");
    expect(
      formatIssueEventText(
        makeEvent("ASSIGNEE_CHANGED", { assigneeAccountId: null }, { assigneeAccountId: JAN_ID }),
        names,
      ),
    ).toBe("Anna Nowak przypisuje zadanie do Jan Kowalski");
    expect(
      formatIssueEventText(makeEvent("DELETED", { deletedAt: null }, { deletedAt: "2026-11-27T04:00:00.000Z" }), names),
    ).toBe("Anna Nowak usuwa zadanie");

    expect(formatInboxKindText("ASSIGNED", "Anna Nowak")).toBe("Anna Nowak przypisuje Ci zadanie");
    expect(formatInboxKindText("MENTIONED", "Anna Nowak")).toBe("Anna Nowak wspomina o Tobie w komentarzu");
    expect(formatInboxKindText("COMMENTED", "Anna Nowak")).toBe("Anna Nowak dodaje komentarz w obserwowanym zadaniu");
  });
});
