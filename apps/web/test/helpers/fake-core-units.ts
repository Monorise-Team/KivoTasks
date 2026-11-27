import { jwtVerify } from "jose";
import type { FakeCore } from "@monorise-team/testing";

export interface CapturedNotificationRequest {
  organizationId: string;
  idempotencyKey: string | null;
  authorization: string | null;
  body: {
    recipientAccountId: string;
    category: string;
    title: string;
    body: string;
    actionUrl?: string | null;
  };
}

export type NotificationFault = { status: number } | { networkError: true };

export interface CoreUnitsAdapterOptions {
  /** Zwraca błąd HTTP dla `GET /core/v1/units` (np. do testu best-effort odświeżania nazw). */
  getUnitsFaultStatus?: () => number | null;
  /** Opcjonalny maksymalny rozmiar strony dla `GET /core/v1/units` (test stronicowania). */
  getUnitsPageSize?: () => number | undefined;
  /** Przechwytuje każde wywołanie `POST /core/v1/organizations/{id}/notifications`. */
  onNotification?: (captured: CapturedNotificationRequest) => void;
  /** Zwraca błąd dla `POST /core/v1/organizations/{id}/notifications` (status HTTP albo błąd sieci). */
  getNotificationFault?: () => NotificationFault | null;
}

const NOTIFICATIONS_PATH_REGEX = /^\/core\/v1\/organizations\/([^/]+)\/notifications$/;

/**
 * Adapter `fetch` nad `createFakeCore` dodający obsługę:
 * - `GET /core/v1/units` (weryfikacja tokenu użytkownika EdDSA, filtr `status`, stronicowanie),
 * - `POST /core/v1/organizations/{organizationId}/notifications` (weryfikacja tokenu maszynowego
 *   z zakresem `core:notifications.send`, przechwytywanie żądań i wstrzykiwanie awarii).
 */
export function createFakeCoreWithUnitsFetch(fakeCore: FakeCore, options: CoreUnitsAdapterOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? (init ? new Request(input, init) : input) : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "GET" && url.pathname === "/core/v1/units") {
      const faultStatus = options.getUnitsFaultStatus?.() ?? null;
      if (faultStatus !== null) {
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_units_fault" },
            error: { code: "INTERNAL_ERROR", message: "Core units fault", details: [] },
          }),
          { status: faultStatus, headers: { "Content-Type": "application/json" } },
        );
      }

      const authHeader = request.headers.get("authorization") ?? "";
      if (!authHeader.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_units_401" },
            error: { code: "UNAUTHENTICATED", message: "Brak tokenu dostępu", details: [] },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      const token = authHeader.slice(7).trim();
      let orgId: string;
      try {
        const { payload } = await jwtVerify(token, fakeCore.issuer.localJWKSet, {
          issuer: fakeCore.issuerUrl,
          audience: fakeCore.coreApiUrl,
          algorithms: ["EdDSA"],
        });
        orgId = String(payload.org_id ?? "");
      } catch {
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_units_401" },
            error: { code: "UNAUTHENTICATED", message: "Token jest nieważny albo wygasł", details: [] },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      const org = fakeCore.getOrganization(orgId);
      if (!org) {
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_units_401" },
            error: { code: "UNAUTHENTICATED", message: "Nieznana firma", details: [] },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      const statusFilter = url.searchParams.get("status");
      const rawLimit = Number(url.searchParams.get("limit") ?? "50");
      const customPageSize = options.getUnitsPageSize?.();
      const limit = customPageSize !== undefined ? Math.min(rawLimit, customPageSize) : rawLimit;
      const cursorRaw = url.searchParams.get("cursor");
      const afterId = cursorRaw ? Buffer.from(cursorRaw, "base64url").toString("utf8") : undefined;

      const matching = [...org.data.units.values()]
        .filter((unit) => (statusFilter ? unit.status === statusFilter : true))
        .filter((unit) => (afterId !== undefined ? unit.id > afterId : true))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      const hasMore = matching.length > limit;
      const items = (hasMore ? matching.slice(0, limit) : matching).map((unit) => ({
        id: unit.id,
        name: unit.name,
        type: unit.type,
        status: unit.status,
        parentId: unit.parentId,
        createdAt: "2026-11-26T10:00:00.000Z",
        updatedAt: "2026-11-26T10:00:00.000Z",
      }));
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? Buffer.from(last.id, "utf8").toString("base64url") : null;

      return new Response(
        JSON.stringify({
          data: items,
          meta: { requestId: "req_units_ok", nextCursor },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

    const notificationsMatch = method === "POST" ? NOTIFICATIONS_PATH_REGEX.exec(url.pathname) : null;
    if (notificationsMatch) {
      const organizationId = decodeURIComponent(notificationsMatch[1]!);
      const rawBody = await request.text();
      const parsedBody = JSON.parse(rawBody) as CapturedNotificationRequest["body"];
      const authorization = request.headers.get("authorization");

      options.onNotification?.({
        organizationId,
        idempotencyKey: request.headers.get("idempotency-key"),
        authorization,
        body: parsedBody,
      });

      const fault = options.getNotificationFault?.() ?? null;
      if (fault) {
        if ("networkError" in fault) {
          throw new TypeError("connect ECONNREFUSED");
        }
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_notif_fault" },
            error: { code: "INTERNAL_ERROR", message: "Core notifications fault", details: [] },
          }),
          { status: fault.status, headers: { "Content-Type": "application/json" } },
        );
      }

      if (!authorization || !authorization.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_notif_401" },
            error: { code: "UNAUTHENTICATED", message: "Brak tokenu dostępu", details: [] },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      const token = authorization.slice(7).trim();
      let grantedScopes: string[];
      try {
        const { payload } = await jwtVerify(token, fakeCore.issuer.localJWKSet, {
          issuer: fakeCore.issuerUrl,
          audience: fakeCore.coreApiUrl,
          algorithms: ["EdDSA"],
        });
        grantedScopes = String(payload.scope ?? "")
          .split(/\s+/)
          .filter(Boolean);
      } catch {
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_notif_401" },
            error: { code: "UNAUTHENTICATED", message: "Token jest nieważny albo wygasł", details: [] },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      if (!grantedScopes.includes("core:notifications.send")) {
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_notif_403" },
            error: { code: "PERMISSION_DENIED", message: "Brak zakresu core:notifications.send", details: [] },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }

      if (!fakeCore.getOrganization(organizationId)) {
        return new Response(
          JSON.stringify({
            data: null,
            meta: { requestId: "req_notif_404" },
            error: { code: "NOT_FOUND", message: "Nie znaleziono firmy", details: [] },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            id: crypto.randomUUID(),
            status: "QUEUED",
            skipReason: null,
          },
          meta: { requestId: "req_notif_ok" },
          error: null,
        }),
        { status: 202, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

    return fakeCore.fetch(input, init);
  }) as typeof fetch;
}
