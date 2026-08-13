/**
 * Thin fetch wrapper for all API calls.
 * - Sends cookies (session auth)
 * - On 401 → redirects to sign-in
 * - JSON parsing + error handling
 */

import { isHostKeyTrustResponse, type HostKeyTrustPayload } from "./host-key-trust";
import {
  REAUTHENTICATION_REQUIRED,
  isSeatLimitResponse,
  SeatLimitReachedClientError,
  PlanRequiredClientError,
} from "@infrawrench/ui";

const SIGN_IN_URL = "/api/auth/sign-in";

/** True for the structured 403 that `auth/step-up.ts` returns. */
function isReauthenticationRequired(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { code?: unknown }).code === REAUTHENTICATION_REQUIRED
  );
}

/**
 * Error thrown by `apiFetch` when a response carries the structured
 * `ssh_host_key_trust_required` 409. Callers can `catch` and inspect
 * `.payload` to drive the host-key trust dialog, then retry.
 */
export class HostKeyTrustRequiredClientError extends Error {
  readonly payload: HostKeyTrustPayload;
  constructor(payload: HostKeyTrustPayload) {
    super(payload.message || "SSH host key trust required");
    this.name = "HostKeyTrustRequiredClientError";
    this.payload = payload;
  }
}

/** Payload of the structured 423 returned while an org change freeze blocks an action. */
export interface ChangeFreezeBlockedPayload {
  error: string;
  code: "change_freeze_active";
  freeze: {
    id: string;
    name: string;
    reason: string | null;
    startsAt: string;
    endsAt: string | null;
  };
}

function isChangeFreezeBlockedResponse(parsed: unknown): parsed is ChangeFreezeBlockedPayload {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { code?: unknown }).code === "change_freeze_active"
  );
}

/**
 * Error thrown by `apiFetch` for the structured `change_freeze_active` 423.
 * Callers can `catch` it to explain the freeze (name/end time) and, for
 * admins, offer an explicit override retry with the
 * `x-change-freeze-override: true` header.
 */
export class ChangeFreezeBlockedClientError extends Error {
  readonly payload: ChangeFreezeBlockedPayload;
  constructor(payload: ChangeFreezeBlockedPayload) {
    super(payload.error || "Blocked by an active change freeze");
    this.name = "ChangeFreezeBlockedClientError";
    this.payload = payload;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body && typeof init.body === "string"
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    window.location.href = SIGN_IN_URL;
    // Never resolves — page will navigate away
    return new Promise(() => {});
  }

  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (res.status === 409 && isHostKeyTrustResponse(parsed)) {
      throw new HostKeyTrustRequiredClientError(parsed);
    }
    if (res.status === 409 && isSeatLimitResponse(parsed)) {
      throw new SeatLimitReachedClientError(parsed);
    }
    if (res.status === 423 && isChangeFreezeBlockedResponse(parsed)) {
      throw new ChangeFreezeBlockedClientError(parsed);
    }
    // Step-up: the server accepted who we are but wants a fresher sign-in
    // before allowing this change. Treated like the 401 path — bounce through
    // sign-in — but with a return_to so the user lands back where they were.
    if (res.status === 403 && isReauthenticationRequired(parsed)) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.href = `${SIGN_IN_URL}?return_to=${encodeURIComponent(returnTo)}`;
      return new Promise(() => {});
    }
    let message = text;
    if (parsed && typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const errField = (parsed as { error?: unknown }).error;
      if (typeof errField === "string") message = errField;
    }
    if (res.status === 402) {
      throw new PlanRequiredClientError(message);
    }
    throw new Error(message);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

/**
 * GET an endpoint whose body is a document rather than a JSON payload.
 *
 * `apiFetch` parses, which is exactly wrong for an asciicast: the format is
 * newline-delimited JSON and `JSON.parse` fails on the header line alone. The
 * auth handling (401 → sign-in) is duplicated rather than shared because
 * `apiFetch`'s error branch is all about JSON error envelopes, which a text
 * endpoint does not have.
 */
export async function apiGetText(path: string): Promise<string> {
  const res = await fetch(path, { credentials: "include" });
  if (res.status === 401) {
    window.location.href = SIGN_IN_URL;
    return new Promise(() => {});
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      /* not a JSON error envelope */
    }
    throw new Error(message || `Request failed (${res.status})`);
  }
  return text;
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: body !== undefined ? JSON.stringify(body) : null,
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    body: body !== undefined ? JSON.stringify(body) : null,
  });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PUT",
    body: body !== undefined ? JSON.stringify(body) : null,
  });
}
