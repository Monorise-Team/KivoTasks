import { ApiError } from "@kivotasks/client";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NO_ACCESS_MESSAGE,
  DEFAULT_NO_ROLE_MESSAGE,
  canCreateTeams,
  canManageTeam,
  canReadIssues,
  canWriteIssues,
  findTeamByKey,
  formatApiError,
  isValidTeamKey,
  legacyHashToPath,
  normalizeAppPathname,
  normalizeTeamKeyInput,
  parseAppRoute,
  parseViewFromHash,
  resolveAccessDenialMessage,
  sanitizeReturnTo,
  suggestTeamKey,
} from "@/app/app/app-views";

describe("rozpoznawanie widoku z fragmentu adresu (hash)", () => {
  it("domyślnie i dla nieznanych fragmentów wybiera widok Moje zadania", () => {
    expect(parseViewFromHash("")).toBe("my-issues");
    expect(parseViewFromHash("#moje-zadania")).toBe("my-issues");
    expect(parseViewFromHash("#nieznany")).toBe("my-issues");
  });

  it("rozpoznaje widoki Zespoły i Wygląd niezależnie od wielkości liter", () => {
    expect(parseViewFromHash("#zespoly")).toBe("teams");
    expect(parseViewFromHash("#ZESPOLY")).toBe("teams");
    expect(parseViewFromHash("#wyglad")).toBe("appearance");
    expect(parseViewFromHash(" #WYGLAD ")).toBe("appearance");
  });

  it("przekierowuje starsze fragmenty etapu 0 na nowe ścieżki", () => {
    expect(legacyHashToPath("#zespoly")).toBe("/teams");
    expect(legacyHashToPath("#wyglad")).toBe("/appearance");
    expect(legacyHashToPath("#moje-zadania")).toBe("/my-issues");
    expect(legacyHashToPath("")).toBeNull();
  });
});

describe("rozpoznawanie tras aplikacji i kluczy zespołów", () => {
  it("normalizuje prefiks /app oraz rozpoznaje wszystkie widoki etapu 1b", () => {
    expect(normalizeAppPathname("/app")).toBe("/");
    expect(normalizeAppPathname("/app/teams/MAG/board")).toBe("/teams/MAG/board");

    expect(parseAppRoute("/")).toEqual({ kind: "my-issues" });
    expect(parseAppRoute("/my-issues")).toEqual({ kind: "my-issues" });
    expect(parseAppRoute("/teams")).toEqual({ kind: "teams" });
    expect(parseAppRoute("/teams/mag")).toEqual({ kind: "team-issues", teamKey: "MAG" });
    expect(parseAppRoute("/app/teams/mag/board")).toEqual({ kind: "team-board", teamKey: "MAG" });
    expect(parseAppRoute("/teams/MAG/settings")).toEqual({ kind: "team-settings", teamKey: "MAG" });
    expect(parseAppRoute("/issue/MAG-12")).toEqual({ kind: "issue-detail", identifier: "MAG-12" });
    expect(parseAppRoute("/appearance")).toEqual({ kind: "appearance" });
    expect(parseAppRoute("/nieistnieje/cos")).toEqual({ kind: "unknown" });
  });

  it("proponuje i waliduje klucze zespołów (2 do 5 wielkich liter A-Z)", () => {
    expect(suggestTeamKey("Magazyn")).toBe("MAG");
    expect(suggestTeamKey("Dział Obsługi Klienta")).toBe("DOK");
    expect(suggestTeamKey("Łódź Centrum")).toBe("LC");
    expect(normalizeTeamKeyInput("mag-12345")).toBe("MAG");
    expect(isValidTeamKey("MAG")).toBe(true);
    expect(isValidTeamKey("A")).toBe(false);
    expect(isValidTeamKey("ABCDEF")).toBe(false);
  });

  it("wyszukuje zespół po kluczu bez rozróżniania wielkości liter", () => {
    const team = {
      id: "01950000-0000-7000-8000-000000000001",
      organizationId: "01950000-0000-7000-8000-000000000099",
      key: "MAG",
      name: "Magazyn",
      nextIssueNumber: 4,
      createdAt: "2026-11-26T10:00:00.000Z",
      updatedAt: "2026-11-26T10:00:00.000Z",
      archivedAt: null,
    };
    expect(findTeamByKey([team], "mag")?.id).toBe(team.id);
    expect(findTeamByKey([team], "OPS")).toBeNull();
  });

  it("zabezpiecza ścieżkę returnTo przed otwartym przekierowaniem", () => {
    expect(sanitizeReturnTo("/issue/MAG-1")).toBe("/issue/MAG-1");
    expect(sanitizeReturnTo("/app/teams/MAG")).toBe("/teams/MAG");
    expect(sanitizeReturnTo("//evil.test/login")).toBe("/");
  });
});

describe("stan dostępu do aplikacji i ukrywanie akcji na podstawie capabilities", () => {
  it("blokuje dostęp, gdy konto nie ma włączonego produktu KivoTasks", () => {
    expect(
      resolveAccessDenialMessage({
        hasProductAccess: false,
        readIssues: false,
        writeIssues: false,
        manageTeams: false,
        createTeams: false,
        manageProjects: false,
      }),
    ).toBe(DEFAULT_NO_ACCESS_MESSAGE);
  });

  it("blokuje dostęp, gdy produkt jest włączony, ale konto nie ma żadnej roli", () => {
    expect(
      resolveAccessDenialMessage({
        hasProductAccess: true,
        readIssues: false,
        writeIssues: false,
        manageTeams: false,
        createTeams: false,
        manageProjects: false,
      }),
    ).toBe(DEFAULT_NO_ROLE_MESSAGE);
  });

  it("wpuszcza osobę z dostępem do produktu i co najmniej jednym uprawnieniem", () => {
    expect(
      resolveAccessDenialMessage({
        hasProductAccess: true,
        readIssues: true,
        writeIssues: false,
        manageTeams: false,
        createTeams: false,
        manageProjects: false,
      }),
    ).toBeNull();
    expect(
      resolveAccessDenialMessage({
        hasProductAccess: true,
        readIssues: true,
        writeIssues: true,
        manageTeams: true,
        createTeams: true,
        manageProjects: true,
      }),
    ).toBeNull();
  });

  it("ukrywa akcje zapisu dla roli Gość (tylko odczyt) i ustawienia zespołu bez manageTeams", () => {
    const guest = {
      hasProductAccess: true,
      readIssues: true,
      writeIssues: false,
      manageTeams: false,
      createTeams: false,
      manageProjects: false,
    };
    expect(canReadIssues(guest)).toBe(true);
    expect(canWriteIssues(guest, "team-1")).toBe(false);
    expect(canManageTeam(guest, "team-1")).toBe(false);
    expect(canCreateTeams(guest)).toBe(false);

    const member = { ...guest, writeIssues: true };
    expect(canWriteIssues(member, "team-1")).toBe(true);
    expect(canManageTeam(member, "team-1")).toBe(false);
    expect(canCreateTeams(member)).toBe(false);

    // Nadpisanie po odpowiedzi 403 dla konkretnego zespołu spoza zakresu zapisu
    expect(canWriteIssues(member, "team-readonly", { deniedWriteTeamIds: new Set(["team-readonly"]) })).toBe(false);
    expect(canWriteIssues(member, "team-writable", { deniedWriteTeamIds: new Set(["team-readonly"]) })).toBe(true);

    const unitAdmin = { ...member, manageTeams: true, createTeams: false };
    expect(canManageTeam(unitAdmin, "team-1")).toBe(true);
    expect(canManageTeam(unitAdmin, "team-other", { deniedManageTeamIds: new Set(["team-other"]) })).toBe(false);
    expect(canCreateTeams(unitAdmin)).toBe(false);

    const orgAdmin = { ...unitAdmin, createTeams: true };
    expect(canCreateTeams(orgAdmin)).toBe(true);
  });

  it("zachowuje komunikaty 409 CONFLICT z API bez zmian i łączy szczegóły 422", () => {
    const conflict = new ApiError(409, {
      code: "CONFLICT",
      message: "Nie można usunąć statusu używanego przez aktywne zadania",
      details: [],
    });
    expect(formatApiError(conflict)).toBe("Nie można usunąć statusu używanego przez aktywne zadania");

    const validation = new ApiError(422, {
      code: "VALIDATION_FAILED",
      message: "Niepoprawne dane",
      details: [{ field: "key", message: "Klucz zespołu musi składać się z 2 do 5 wielkich liter A-Z" }],
    });
    expect(formatApiError(validation)).toBe("Klucz zespołu musi składać się z 2 do 5 wielkich liter A-Z");
  });
});
