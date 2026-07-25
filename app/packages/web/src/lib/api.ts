/**
 * Thin fetch wrapper for all API calls.
 * - Sends cookies (session auth)
 * - On 401 → redirects to sign-in
 * - JSON parsing + error handling
 */

import { isHostKeyTrustResponse, type HostKeyTrustPayload } from "./host-key-trust";
import { REAUTHENTICATION_REQUIRED } from "@infrawrench/ui";

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
    throw new Error(message);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
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
