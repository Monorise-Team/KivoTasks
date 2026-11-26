import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.KIVOTASKS_API_URL ?? "https://kivo.monorise.studio"),
  title: "KivoTasks: zadania i projekty dla zespołów w przeglądarce",
  description:
    "KivoTasks to zadania i projekty Monorise w przeglądarce, wzorowane na Linear, z zespołami ze struktury firmy i logowaniem kontem Monorise.",
  alternates: { canonical: "/" },
};

export const viewport: Viewport = { themeColor: "#071826", colorScheme: "dark" };

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" className="dark" data-theme="moonlight">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
