import { appearanceInitScript } from "@monorise-team/ui";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../globals.css";
import { KivoTasksApp } from "./KivoTasksApp";

export const metadata: Metadata = {
  title: "KivoTasks",
  description: "Zadania i projekty KivoTasks w przeglądarce.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { colorScheme: "dark light" };

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" className="dark" data-theme="mono" suppressHydrationWarning>
      <head>
        {/* Zapisany tryb i motyw przed pierwszym malowaniem, bez mignięcia */}
        <script dangerouslySetInnerHTML={{ __html: appearanceInitScript }} />
      </head>
      <body className="min-h-dvh">
        <KivoTasksApp>{children}</KivoTasksApp>
      </body>
    </html>
  );
}
