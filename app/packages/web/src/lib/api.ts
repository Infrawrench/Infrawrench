/**
 * Thin fetch wrapper for all API calls.
 * - Sends cookies (session auth)
 * - On 401 → redirects to sign-in
 * - JSON parsing + error handling
 */

import { isHostKeyTrustResponse, type HostKeyTrustPayload } from "./host-key-trust";

const SIGN_IN_URL = "/api/auth/sign-in";

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
    const message =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? (((parsed as { error?: unknown }).error as string | undefined) ?? text)
        : text;
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
