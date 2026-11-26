import { describe, expect, it } from "vitest";
import { appHosts, hostname, routeFor } from "@/lib/hosts";

const HOSTS = appHosts(undefined);

describe("dwa adresy z jednej aplikacji", () => {
  it("kivotasks. pokazuje aplikację: ścieżki przepisuje na /app", () => {
    expect(routeFor("kivotasks.monorise.studio", "/", HOSTS)).toEqual({ kind: "rewrite", pathname: "/app" });
    expect(routeFor("kivotasks.localhost", "/issues", HOSTS)).toEqual({ kind: "rewrite", pathname: "/app/issues" });
  });

  it("kivo. pokazuje stronę produktu, a ścieżki /app dają tam 404", () => {
    expect(routeFor("kivo.monorise.studio", "/", HOSTS)).toEqual({ kind: "next" });
    expect(routeFor("kivo.monorise.studio", "/app", HOSTS)).toEqual({ kind: "not-found" });
    expect(routeFor("localhost", "/app/issues", HOSTS)).toEqual({ kind: "not-found" });
  });

  it("czyta nazwę hosta bez portu", () => {
    expect(hostname("KivoTasks.localhost:3500")).toBe("kivotasks.localhost");
    expect(hostname(null)).toBe("");
  });

  it("lista adresów aplikacji z KIVOTASKS_APP_HOSTS", () => {
    expect(appHosts("zadania.example.test, App.Example.test")).toEqual(["zadania.example.test", "app.example.test"]);
  });
});
