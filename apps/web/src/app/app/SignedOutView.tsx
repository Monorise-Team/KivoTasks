"use client";

import type { Me } from "@kivotasks/client";
import { AppBackdrop, Banner, Button, Card, Skeleton } from "@monorise-team/ui";
import { ListTodo, LogOut, RefreshCw } from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { sanitizeReturnTo } from "./app-views";

function CenteredCardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppBackdrop />
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Card surface="float" className="mr-enter flex w-full max-w-md flex-col gap-4 p-8">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-text-secondary uppercase">
            <ListTodo className="size-4 text-accent" aria-hidden />
            KivoTasks
          </div>
          {children}
        </Card>
      </main>
    </>
  );
}

/** Stan początkowego ładowania sesji i danych aplikacji. */
export function LoadingView() {
  return (
    <CenteredCardLayout>
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Wczytywanie KivoTasks">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="mt-2 h-10 w-full" />
      </div>
    </CenteredCardLayout>
  );
}

/** Ekran wylogowany z opcjonalnym komunikatem o błędzie logowania z `AUTH_ERROR_MESSAGES`. */
export function SignedOutView({ authError }: { authError: string | null }) {
  const pathname = usePathname();
  const returnTo = sanitizeReturnTo(pathname);

  return (
    <CenteredCardLayout>
      <h1 className="font-display text-2xl font-semibold">Zaloguj się do KivoTasks</h1>
      <p className="text-sm leading-relaxed text-text-secondary">
        Zarządzanie zadaniami i projektami korzysta z konta Monorise. Po zalogowaniu przejdziesz do swoich zadań i
        zespołów.
      </p>
      {authError ? <Banner tone="danger" message={authError} /> : null}
      <Button asChild variant="primary" size="lg" className="w-full">
        <a href={`/api/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>Zaloguj się kontem Monorise</a>
      </Button>
    </CenteredCardLayout>
  );
}

/** Błąd połączenia albo wczytania aplikacji przed wyświetleniem widoku głównego. */
export function LoadErrorView({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <CenteredCardLayout>
      <h1 className="font-display text-xl font-semibold">Nie udało się wczytać KivoTasks</h1>
      <Banner tone="danger" message={error ?? "Wystąpił nieoczekiwany błąd."} />
      <Button variant="primary" size="md" icon={<RefreshCw aria-hidden />} onClick={onRetry}>
        Spróbuj ponownie
      </Button>
    </CenteredCardLayout>
  );
}

/** Stan zalogowanej osoby bez dostępu do produktu albo bez przypisanej roli w KivoTasks. */
export function NoAccessView({
  me,
  message,
  busy,
  onRetry,
  onSignOut,
}: {
  me: Me;
  message: string;
  busy: boolean;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <CenteredCardLayout>
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-xl font-semibold">Brak dostępu do KivoTasks</h1>
        <p className="text-xs text-text-secondary">
          {me.employee.fullName} · {me.organization.name}
        </p>
      </div>
      <Banner tone="warning" message={message} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="md" icon={<RefreshCw aria-hidden />} onClick={onRetry} disabled={busy}>
          Odśwież
        </Button>
        <Button variant="secondary" size="md" icon={<LogOut aria-hidden />} onClick={onSignOut} disabled={busy}>
          Wyloguj
        </Button>
      </div>
    </CenteredCardLayout>
  );
}
