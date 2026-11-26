import { AppBackdrop, Badge, Button, Card } from "@monorise-team/ui";
import { FolderKanban, ListTodo, ShieldCheck, Users } from "lucide-react";

const APP_URL = process.env.KIVOTASKS_APP_URL ?? "https://kivotasks.monorise.studio";

const HIGHLIGHTS = [
  {
    icon: <ListTodo />,
    title: "Zadania i szybka praca klawiaturą",
    body: "Lista i tablica zadań, priorytety, etykiety, podzadania, relacje oraz paleta poleceń i skróty klawiszowe bez ciężkiej konfiguracji.",
  },
  {
    icon: <Users />,
    title: "Zespoły ze struktury firmy",
    body: "Zespoły pochodzą z jednostek w MonoriseCore i dostają krótkie klucze do numeracji zadań.",
  },
  {
    icon: <FolderKanban />,
    title: "Projekty i udostępnianie",
    body: "Projekty przekrojowe ponad zespołami oraz bezpieczne udostępnianie pojedynczego projektu osobom spoza zespołu z rolą Gość.",
  },
  {
    icon: <ShieldCheck />,
    title: "Jedno logowanie Monorise",
    body: "Bez osobnych haseł i kont. Logowanie, dostęp do produktu oraz uprawnienia pochodzą bezpośrednio z MonoriseCore.",
  },
];

export default function ProductPage() {
  return (
    <>
      <AppBackdrop />
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
          <span className="mr-glow flex size-8 items-center justify-center rounded-xl bg-accent text-accent-fg">
            <ListTodo className="size-4" aria-hidden />
          </span>
          KivoTasks
        </a>
        <Button asChild variant="primary" size="md" className="rounded-full">
          <a href={APP_URL}>Otwórz KivoTasks</a>
        </Button>
      </header>

      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-16 px-6 pt-10 pb-20">
        <section className="mr-enter flex max-w-2xl flex-col gap-5">
          <Badge tone="accent" className="w-fit px-2.5">
            W budowie · Etap 0
          </Badge>
          <h1 className="font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
            Zadania i projekty dla zespołów w przeglądarce
          </h1>
          <p className="text-lg leading-relaxed text-text-secondary">
            KivoTasks to szybkie zarządzanie zadaniami i projektami wzorowane na Linear, połączone ze strukturą zespołów
            w MonoriseCore. Jedno konto Monorise, praca wyłącznie w przeglądarce.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="primary" size="lg" className="rounded-full">
              <a href={APP_URL}>Przejdź do aplikacji</a>
            </Button>
          </div>
        </section>

        <section aria-labelledby="mozliwosci-tytul" className="flex flex-col gap-5">
          <h2 id="mozliwosci-tytul" className="font-display text-2xl font-semibold">
            Dla zespołów w Monorise
          </h2>
          <div className="grid gap-card sm:grid-cols-2">
            {HIGHLIGHTS.map((item) => (
              <Card key={item.title} surface="reading" className="flex flex-col gap-3 p-6">
                <span className="flex size-10 items-center justify-center rounded-xl bg-accent-light text-accent [&_svg]:size-5">
                  {item.icon}
                </span>
                <h3 className="text-base font-semibold">{item.title}</h3>
                <p className="text-sm leading-relaxed text-text-secondary">{item.body}</p>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-5xl flex-col gap-2 px-6 pb-10 text-sm text-text-tertiary sm:flex-row sm:justify-between">
        <span>© {new Date().getFullYear()} Monorise. KivoTasks jest produktem Monorise.</span>
        <a href="https://monorise.studio" className="hover:text-text-primary">
          monorise.studio
        </a>
      </footer>
    </>
  );
}
