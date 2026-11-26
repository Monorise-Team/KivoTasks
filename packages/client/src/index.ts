/**
 * Typowany klient API KivoTasks dla przeglądarki (sesja BFF w ciasteczku HttpOnly, ADR-0050)
 * oraz wywołań z tokenem Bearer (`getToken`).
 */
import { API_PREFIX, type ApiErrorBody, type ApiResponse, type ErrorCode, type Me } from "@kivotasks/contracts";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ApiErrorBody["details"];

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

export interface ClientOptions {
  /** Adres serwera, np. `https://kivo.monorise.studio`; pusty w przeglądarce (ten sam adres). */
  baseUrl?: string;
  /** Opcjonalny token Bearer; przeglądarka go nie używa (korzysta z ciasteczka sesji BFF). */
  getToken?: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

export type KivoTasksClient = ReturnType<typeof createClient>;

export function createClient({ baseUrl = "", getToken, fetch: fetchImpl = fetch }: ClientOptions = {}) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = getToken ? await getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: getToken ? "omit" : "same-origin",
      });
    } catch {
      throw new ApiError(0, { code: "INTERNAL_ERROR", message: "Brak połączenia z serwerem KivoTasks", details: [] });
    }
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload || payload.error) {
      throw new ApiError(
        response.status,
        payload?.error ?? { code: "INTERNAL_ERROR", message: `Błąd serwera (${response.status})`, details: [] },
      );
    }
    return payload.data as T;
  }

  return {
    session: {
      me: () => request<Me>("GET", "/me"),
      /**
       * Wylogowanie w przeglądarce (BFF): serwer kończy sesję i unieważnia token w Core. Odpowiedź to
       * przekierowanie, którego nie śledzimy; potem wystarczy ponownie zapytać o `me`.
       */
      signOut: async () => {
        await fetchImpl(`${baseUrl}/api/auth/sign-out`, {
          method: "POST",
          credentials: "same-origin",
          redirect: "manual",
        });
      },
    },
  };
}

export { type Capabilities, type Me } from "@kivotasks/contracts";
