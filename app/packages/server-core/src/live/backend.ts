/**
 * Live-update backends: what turns a topic's change signal (`./topics.ts`)
 * into the ticket a client watches with (client-core `live.ts`).
 *
 * - **Neon Realtime** when `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` are
 *   set: the signal is sealed into a short-lived capability the client
 *   subscribes to directly. Sealing is local Web Crypto with no network call,
 *   so it runs on the edge as well as in Node. The SDK is imported on first
 *   use, which keeps it out of every Worker's startup.
 * - **Polling** otherwise (local development, a self-hosted server on plain
 *   Postgres): the ticket tells the client to keep its own interval.
 *
 * `LIVE_UPDATES=poll` forces polling while the Neon settings stay in place,
 * which is the rollback. A new backend is one more {@link LiveBackend} and a
 * line in {@link liveBackendFromEnv}; nothing else knows which one is running.
 */
import type { LiveTicket } from "@infrawrench/client-core";
import type { LiveSignal } from "./topics";

export interface LiveBackend {
  readonly kind: LiveTicket["driver"];
  ticket(signal: LiveSignal): Promise<LiveTicket>;
}

export const pollBackend: LiveBackend = {
  kind: "poll",
  ticket: async () => ({ driver: "poll" }),
};

export interface NeonRealtimeConfig {
  /** The branch's Live SQL WebSocket URL, handed to clients as is. */
  readonly url: string;
  /** Seals capabilities; never leaves the server. */
  readonly secret: string;
  /** The database the signals read, bound into every capability. */
  readonly db: string;
}

type Sealer = (signal: LiveSignal) => Promise<{
  readonly capability: string;
  readonly queryFingerprint: string;
  readonly expiresAt: number;
}>;

/** The default sealer: `@neon/realtime/server`, loaded once. */
async function neonSealer(config: NeonRealtimeConfig): Promise<Sealer> {
  const { createRealtime, rawSql } = await import("@neon/realtime/server");
  const realtime = createRealtime({ secret: config.secret, db: config.db });
  return async (signal) => {
    const sealed = await realtime.seal({ query: rawSql(signal.sql, signal.params) });
    return {
      capability: sealed.capability,
      queryFingerprint: sealed.queryFingerprint,
      expiresAt: sealed.expiresAt,
    };
  };
}

export function neonBackend(
  config: NeonRealtimeConfig,
  makeSealer: (config: NeonRealtimeConfig) => Promise<Sealer> = neonSealer,
): LiveBackend {
  let sealer: Promise<Sealer> | null = null;
  return {
    kind: "neon",
    async ticket(signal) {
      if (!sealer) {
        sealer = makeSealer(config);
        // A failed load is retried on the next request rather than cached.
        sealer.catch(() => {
          sealer = null;
        });
      }
      const query = await (await sealer)(signal);
      return { driver: "neon", url: config.url, query };
    },
  };
}

/** The database name in a Postgres connection string (`postgres://…/core?…` is `core`). */
export function databaseNameFromUrl(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  try {
    const name = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
    return name || undefined;
  } catch {
    return undefined;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** The Neon settings, or null when any is missing or `LIVE_UPDATES=poll`. */
export function neonRealtimeConfig(env: Env): NeonRealtimeConfig | null {
  if (env["LIVE_UPDATES"]?.trim().toLowerCase() === "poll") return null;
  const url = env["NEON_REALTIME_URL"]?.trim();
  const secret = env["NEON_REALTIME_SECRET"]?.trim();
  const db = env["NEON_REALTIME_DB"]?.trim() || databaseNameFromUrl(env["DATABASE_URL"]);
  if (!url || !secret || !db) return null;
  return { url, secret, db };
}

export function liveBackendFromEnv(env: Env): LiveBackend {
  const neon = neonRealtimeConfig(env);
  return neon ? neonBackend(neon) : pollBackend;
}

let current: { key: string; backend: LiveBackend } | null = null;

/**
 * The backend for this process, rebuilt only when the settings change (the
 * edge fills `process.env` per invocation, from one secret, so it is stable).
 */
export function liveBackend(env: Env = process.env): LiveBackend {
  const neon = neonRealtimeConfig(env);
  const key = neon ? `${neon.url}\n${neon.db}\n${neon.secret}` : "poll";
  if (current?.key !== key) {
    current = { key, backend: neon ? neonBackend(neon) : pollBackend };
  }
  return current.backend;
}
