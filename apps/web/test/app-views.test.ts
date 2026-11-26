import { describe, expect, it } from "vitest";
import {
  DEFAULT_NO_ACCESS_MESSAGE,
  DEFAULT_NO_ROLE_MESSAGE,
  parseViewFromHash,
  resolveAccessDenialMessage,
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
});

describe("stan dostępu do aplikacji na podstawie capabilities", () => {
  it("blokuje dostęp, gdy konto nie ma włączonego produktu KivoTasks", () => {
    expect(
      resolveAccessDenialMessage({
        hasProductAccess: false,
        readIssues: false,
        writeIssues: false,
        manageTeams: false,
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
        manageProjects: false,
      }),
    ).toBeNull();
    expect(
      resolveAccessDenialMessage({
        hasProductAccess: true,
        readIssues: true,
        writeIssues: true,
        manageTeams: true,
        manageProjects: true,
      }),
    ).toBeNull();
  });
});
