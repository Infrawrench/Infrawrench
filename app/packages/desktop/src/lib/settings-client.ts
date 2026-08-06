import {
  isSeatLimitResponse,
  PlanRequiredClientError,
  SeatLimitReachedClientError,
} from "@infrawrench/client-core";
import type { SettingsApi } from "@infrawrench/ui";
import { invoke } from "./invoke";

interface SettingsRequestResult {
  status: number;
  bodyText: string;
}

/**
 * Desktop implementation of the shared settings sections' transport: every
 * call rides the single `cloud_settings_request` IPC channel, whose
 * main-process handler allowlists the settings API surface and attaches the
 * cloud tokens. Errors are rebuilt here as the same typed classes the web
 * fetch throws, so the shared sections cannot tell the transports apart.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, bodyText } = await invoke<SettingsRequestResult>("cloud_settings_request", {
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });

  if (status >= 200 && status < 300) {
    if (!bodyText) return undefined as T;
    return JSON.parse(bodyText) as T;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* not JSON */
  }
  if (status === 409 && isSeatLimitResponse(parsed)) {
    throw new SeatLimitReachedClientError(parsed);
  }
  let message = bodyText;
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const errField = (parsed as { error?: unknown }).error;
    if (typeof errField === "string") message = errField;
  }
  if (status === 402) {
    throw new PlanRequiredClientError(message);
  }
  throw new Error(message || `Cloud request failed: ${status} ${path}`);
}

export function createDesktopSettingsApi(): SettingsApi {
  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    delete: <T>(path: string) => request<T>("DELETE", path),
  };
}
