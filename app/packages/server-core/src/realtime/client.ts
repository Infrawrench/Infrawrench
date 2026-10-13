/**
 * Node's side of the realtime relay (`realtime/protocol.ts`): where it is and
 * how to authenticate to it. Off unless both `APP_URL` and
 * `INTERNAL_RELAY_SECRET` are set, which keeps local development and a
 * single-process self-host entirely in process.
 */
import { REALTIME_SECRET_HEADER } from "./protocol.js";

function appUrl(): string | undefined {
  return process.env["APP_URL"]?.trim().replace(/\/+$/, "") || undefined;
}

function secret(): string | undefined {
  return process.env["INTERNAL_RELAY_SECRET"]?.trim() || undefined;
}

/**
 * Whether this process should use the relay. Also off when explicitly
 * disabled (`REALTIME_RELAY=off`), for a deployment whose `APP_URL` does not
 * front the edge Worker.
 */
export function realtimeEnabled(): boolean {
  if (process.env["REALTIME_RELAY"]?.trim().toLowerCase() === "off") return false;
  return Boolean(appUrl() && secret());
}

/** `wss://<app>/<path>` for a relay socket. */
export function realtimeWsUrl(path: string): string {
  const base = appUrl();
  if (!base) throw new Error("realtime relay: APP_URL is not set");
  return `${base.replace(/^http/, "ws")}${path}`;
}

/** Headers every relay request and socket carries. */
export function realtimeHeaders(): Record<string, string> {
  const value = secret();
  if (!value) throw new Error("realtime relay: INTERNAL_RELAY_SECRET is not set");
  return { [REALTIME_SECRET_HEADER]: value };
}

/** A plain HTTP call to the relay (`POST …/rpc`, `POST …/allowlist`). */
export async function realtimeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = appUrl();
  if (!base) throw new Error("realtime relay: APP_URL is not set");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...realtimeHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
}
