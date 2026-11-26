import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Moduły tylko dla serwera: w testach nie ma podziału na klienta i serwer
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    env: {
      // Prawdziwy PostgreSQL (pnpm db:up && pnpm db:migrate albo usługa w CI), rola aplikacji z RLS
      DATABASE_URL:
        process.env.KIVOTASKS_TEST_APP_DATABASE_URL ??
        "postgresql://kivo_tasks_app:kivo_tasks_app@localhost:5436/kivo_tasks_test",
      KIVOTASKS_SESSION_SECRET: "sekret-sesji-tylko-do-testow-ma-ponad-32-znaki",
      KIVOTASKS_OAUTH_CLIENT_SECRET: "sekret-klienta-tylko-do-testow",
    },
  },
});
