import { describe, expect, it } from "vitest";
import { ApiFailure } from "@/server/api";
import {
  buildIssueCursorPayload,
  buildPrefixTsQuery,
  computeStateTimestamps,
  decodeIssueCursor,
  encodeIssueCursor,
  normalizeRelationForStorage,
  parseIssueIdentifier,
  prioritySortRank,
  toIssueRelationView,
  wouldCreateParentCycle,
} from "@/server/issue-helpers";

const ID_A = "019a0000-0000-7000-8000-000000000001";
const ID_B = "019a0000-0000-7000-8000-000000000002";
const ID_C = "019a0000-0000-7000-8000-000000000003";

describe("pomocniki domeny zadań (issue-helpers)", () => {
  it("parsuje identyfikator zadania bez rozróżniania wielkości liter i odrzuca błędne formaty", () => {
    expect(parseIssueIdentifier("MAG-12")).toEqual({ key: "MAG", number: 12 });
    expect(parseIssueIdentifier("mag-1")).toEqual({ key: "MAG", number: 1 });
    expect(parseIssueIdentifier(" AbCdE-999 ")).toEqual({ key: "ABCDE", number: 999 });
    expect(parseIssueIdentifier("MAG-0")).toBeNull();
    expect(parseIssueIdentifier("M-1")).toBeNull();
    expect(parseIssueIdentifier("ABCDEF-1")).toBeNull();
    expect(parseIssueIdentifier("MAG-abc")).toBeNull();
    expect(parseIssueIdentifier("MAG-999999999999")).toBeNull();
  });

  it("ustawia i czyści startedAt, completedAt oraz canceledAt zgodnie z kategorią statusu", () => {
    const t1 = new Date("2026-11-26T10:00:00.000Z");
    const t2 = new Date("2026-11-26T11:00:00.000Z");
    const t3 = new Date("2026-11-26T12:00:00.000Z");
    const empty = { startedAt: null, completedAt: null, canceledAt: null };

    const started = computeStateTimestamps("STARTED", empty, t1);
    expect(started).toEqual({ startedAt: t1, completedAt: null, canceledAt: null });

    // Przejście między dwoma statusami STARTED zachowuje pierwotne startedAt
    const stillStarted = computeStateTimestamps("STARTED", started, t2);
    expect(stillStarted).toEqual({ startedAt: t1, completedAt: null, canceledAt: null });

    const completed = computeStateTimestamps("COMPLETED", started, t2);
    expect(completed).toEqual({ startedAt: t1, completedAt: t2, canceledAt: null });

    const canceled = computeStateTimestamps("CANCELED", completed, t3);
    expect(canceled).toEqual({ startedAt: t1, completedAt: null, canceledAt: t3 });

    const reopened = computeStateTimestamps("STARTED", canceled, t3);
    expect(reopened).toEqual({ startedAt: t1, completedAt: null, canceledAt: null });

    const backToTodo = computeStateTimestamps("UNSTARTED", completed, t3);
    expect(backToTodo).toEqual({ startedAt: null, completedAt: null, canceledAt: null });
  });

  it("sortuje priorytety jak w Linear (Pilny 1 -> Niski 4 -> Brak 0)", () => {
    expect([0, 4, 2, 1, 3].sort((a, b) => prioritySortRank(a) - prioritySortRank(b))).toEqual([1, 2, 3, 4, 0]);
  });

  it("buduje bezpieczne zapytanie prefiksowe dla PostgreSQL to_tsquery", () => {
    expect(buildPrefixTsQuery("Przegląd strefy przyjęć!")).toBe("przegląd:* & strefy:* & przyjęć:*");
    expect(buildPrefixTsQuery("MAG-12 (pilne) 'drop table'")).toBe("mag:* & 12:* & pilne:* & drop:* & table:*");
    expect(buildPrefixTsQuery("   --- !!!   ")).toBeNull();
  });

  it("wykrywa cykle w hierarchii zadań (bezpośrednie i wielopoziomowe)", async () => {
    const parents = new Map<string, string | null>([
      [ID_A, null],
      [ID_B, ID_A],
      [ID_C, ID_B],
    ]);
    const lookup = async (id: string) => parents.get(id) ?? null;

    expect(await wouldCreateParentCycle(ID_A, ID_A, lookup)).toBe(true);
    expect(await wouldCreateParentCycle(ID_A, ID_B, lookup)).toBe(true);
    expect(await wouldCreateParentCycle(ID_A, ID_C, lookup)).toBe(true);
    expect(await wouldCreateParentCycle(ID_C, ID_A, lookup)).toBe(false);
  });

  it("normalizuje BLOCKED_BY jako odwrotny zapis BLOCKS i mapuje widoki w obie strony", () => {
    expect(normalizeRelationForStorage(ID_A, ID_B, "BLOCKED_BY")).toEqual({
      storedIssueId: ID_B,
      storedRelatedIssueId: ID_A,
      storedType: "BLOCKS",
    });

    const ref = {
      id: ID_B,
      teamId: ID_C,
      identifier: "MAG-2",
      number: 2,
      title: "Bloker",
      priority: 1,
      state: { id: ID_C, name: "W toku", category: "STARTED" as const, color: "yellow" as const, position: 2 },
      assigneeAccountId: null,
    };
    const row = {
      id: "019a0000-0000-7000-8000-000000000099",
      issueId: ID_B,
      relatedIssueId: ID_A,
      type: "BLOCKS" as const,
      createdAt: new Date("2026-11-26T12:00:00.000Z"),
    };

    expect(toIssueRelationView(ID_B, row, ref)).toMatchObject({ type: "BLOCKS", direction: "OUTGOING" });
    expect(toIssueRelationView(ID_A, row, ref)).toMatchObject({ type: "BLOCKED_BY", direction: "INCOMING" });
  });

  it("koduje i dekoduje kursory dla wszystkich 5 trybów sortowania i odrzuca zmanipulowane kursory", () => {
    const sample = {
      id: ID_A,
      priority: 0,
      dueDate: "2026-12-01",
      sortOrder: 1500.5,
      createdAt: "2026-11-26T10:00:00.000Z",
      updatedAt: "2026-11-26T11:00:00.000Z",
    };

    for (const sort of ["updated", "created", "priority", "dueDate", "manual"] as const) {
      const payload = buildIssueCursorPayload(sort, sample);
      const encoded = encodeIssueCursor(payload);
      expect(decodeIssueCursor(encoded, sort)).toEqual(payload);
    }

    const updatedCursor = encodeIssueCursor(buildIssueCursorPayload("updated", sample));
    expect(() => decodeIssueCursor(updatedCursor, "priority")).toThrow(ApiFailure);
    expect(() => decodeIssueCursor("nie-jest-kursorem!!!", "updated")).toThrow(ApiFailure);
  });

  it("odrzuca kursor z niemożliwą datą albo rokiem spoza zakresu bazy (422, a nie błąd PostgreSQL)", () => {
    const id = "019a0000-0000-7000-8000-000000000001";
    const forge = (payload: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

    const badDay = forge({ s: "dueDate", d: "2026-99-99", u: "2026-11-26T10:00:00.000Z", id });
    const farPast = forge({ s: "updated", u: "-010000-01-01T00:00:00.000Z", id });
    const noZone = forge({ s: "created", c: "2026-11-26 10:00", id });

    for (const [cursor, sort] of [
      [badDay, "dueDate"],
      [farPast, "updated"],
      [noZone, "created"],
    ] as const) {
      try {
        decodeIssueCursor(cursor, sort);
        expect.unreachable("kursor powinien zostać odrzucony");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiFailure);
        expect((error as ApiFailure).status).toBe(422);
      }
    }
  });
});
