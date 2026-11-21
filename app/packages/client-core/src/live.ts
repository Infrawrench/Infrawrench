/**
 * Live updates: how a panel learns that what it shows has changed.
 *
 * A panel names a **topic** (the requests in the JIT queue, one account's
 * resources) and keeps its own fetch. It asks the server for a **ticket** for
 * that topic (`POST /api/org/:orgId/live/tickets`), and the ticket says which
 * driver delivers the signal:
 *
 * - `poll`: no push channel is configured (local development, a self-hosted
 *   server), so the panel refetches on its own interval, exactly as before.
 * - `neon`: the server sealed an org-scoped change-signal query for Neon
 *   Realtime. The client subscribes to it and refetches through the ordinary
 *   API whenever its result moves, so permissions, cost visibility and the
 *   response shapes stay where they are; the signal itself carries ids and
 *   statuses at most. The sealed query lives 60 seconds and is renewed through
 *   the same route, which re-checks the caller's permission each time.
 *
 * Every failure lands on polling: an older server without the route, a
 * ticket this client does not understand, the Neon SDK failing to load, or a
 * subscription that stops recovering. A newer server's unknown driver is
 * read as `poll`, never as an error.
 */
import type { CloudFetch } from "./fetch";

/** Every topic a panel can watch. The server's registry has one entry per name. */
export const LIVE_TOPICS = [
  "jit-requests",
  "access-requests",
  "workflow-approvals",
  "change-freezes",
  "account-resources",
  "resource",
  "ci-runs",
] as const;

export type LiveTopic = (typeof LIVE_TOPICS)[number];

/** The ids a topic is scoped by, beside the org. Each topic takes the ones it names. */
export interface LiveTopicParams {
  readonly accountId?: string;
  readonly resourceId?: string;
  readonly workflowId?: string;
}

/** A sealed Neon Realtime query: an opaque, short-lived bearer capability. */
export interface LiveSealedQuery {
  readonly capability: string;
  readonly queryFingerprint: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

export type LiveTicket =
  | { readonly driver: "poll" }
  | { readonly driver: "neon"; readonly url: string; readonly query: LiveSealedQuery };

/** What a host supplies: the transport that asks its server for a ticket. */
export type LiveTicketSource = (topic: LiveTopic, params: LiveTopicParams) => Promise<unknown>;

export interface LiveWatchOptions {
  /** How often to refetch when there is no push channel: the panel's old poll interval. */
  readonly fallbackMs: number;
  /**
   * How often to refetch anyway while a push channel is live, for state the
   * database does not write when it changes (a freeze that starts on its own
   * schedule, a grant that lapses at read time). Defaults to five minutes.
   */
  readonly safetyMs?: number;
}

export interface LiveWatcher {
  /** Call `onChange` whenever the topic moves; returns the function that stops watching. */
  watch(
    topic: LiveTopic,
    params: LiveTopicParams,
    onChange: () => void,
    options: LiveWatchOptions,
  ): () => void;
  /** Stop every watch and close the push connections. */
  close(): void;
}

/** Ask the cloud for a ticket over a Bearer {@link CloudFetch} (mobile, extensions). */
export function fetchLiveTicket(
  api: CloudFetch,
  orgId: string,
  topic: LiveTopic,
  params: LiveTopicParams,
): Promise<unknown> {
  return api.org<unknown>(orgId, "/live/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, ...params }),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Read a ticket leniently: anything that is not a well-formed `neon` ticket is
 * `poll`, so a newer server's driver never breaks an older client.
 */
export function readLiveTicket(value: unknown): LiveTicket {
  if (!isRecord(value) || value["driver"] !== "neon") return { driver: "poll" };
  const url = value["url"];
  const query = value["query"];
  if (typeof url !== "string" || !isRecord(query)) return { driver: "poll" };
  const { capability, queryFingerprint, expiresAt } = query;
  if (
    typeof capability !== "string" ||
    typeof queryFingerprint !== "string" ||
    typeof expiresAt !== "number"
  ) {
    return { driver: "poll" };
  }
  return { driver: "neon", url, query: { capability, queryFingerprint, expiresAt } };
}

/** The slice of a Neon Realtime subscription the watcher drives. */
export interface LiveNeonSubscription {
  onUpdate(listener: (update: unknown) => void): () => void;
  onStateChange(listener: (state: { readonly status: string }) => void): () => void;
  renew(query: LiveSealedQuery): Promise<void>;
  unsubscribe(): void;
}

/** The slice of a Neon Realtime client the watcher drives, one per URL. */
export interface LiveNeonClient {
  subscribe(query: LiveSealedQuery): LiveNeonSubscription;
  close(): void;
}

/** Opens a Neon Realtime client for a URL; loaded lazily so polling hosts never download it. */
export type LiveNeonConnector = (url: string) => Promise<LiveNeonClient>;

/** The real connector: `@neon/realtime/client`, imported on first use. */
export const connectNeonRealtime: LiveNeonConnector = async (url) => {
  const { createRealtimeClient } = await import("@neon/realtime/client");
  const client = createRealtimeClient({ url, logLevel: "warn" });
  return {
    subscribe: (query) => client.subscribe(query, { materialize: false }),
    close: () => client.close(),
  };
};

export interface LiveWatcherDeps {
  readonly connect?: LiveNeonConnector;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly now?: () => number;
}

/** Renew this long before a sealed query expires, the timing Neon's own bindings use. */
export const LIVE_RENEW_EARLY_MS = 10_000;
/** Retry a failed renewal this soon. */
export const LIVE_RENEW_RETRY_MS = 1_000;
/** Coalesce a burst of committed transactions into one refetch. */
export const LIVE_DEBOUNCE_MS = 250;
/** Timers above this fire at once (a 32-bit delay), so a far expiry is clamped to it. */
const MAX_TIMER_MS = 2_147_483_647;
/** The default safety refetch while a push channel is live. */
export const LIVE_SAFETY_MS = 5 * 60_000;

/**
 * Build a watcher over a ticket source. Hosts make one per org and share it;
 * Neon clients are opened once per URL and every subscription rides that
 * client's one WebSocket.
 */
export function createLiveWatcher(
  source: LiveTicketSource,
  deps: LiveWatcherDeps = {},
): LiveWatcher {
  const connect = deps.connect ?? connectNeonRealtime;
  const setTimer =
    deps.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimeout ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;

  const clients = new Map<string, Promise<LiveNeonClient>>();
  const stops = new Set<() => void>();

  const clientFor = (url: string): Promise<LiveNeonClient> => {
    let client = clients.get(url);
    if (!client) {
      client = connect(url);
      // A failed load is not cached: the next watch may try again.
      client.catch(() => clients.delete(url));
      clients.set(url, client);
    }
    return client;
  };

  const ticketFor = async (topic: LiveTopic, params: LiveTopicParams): Promise<LiveTicket> =>
    readLiveTicket(await source(topic, params));

  function watch(
    topic: LiveTopic,
    params: LiveTopicParams,
    onChange: () => void,
    options: LiveWatchOptions,
  ): () => void {
    let stopped = false;
    let timer: unknown = null;
    let debounce: unknown = null;
    let renewTimer: unknown = null;
    let subscription: LiveNeonSubscription | null = null;
    let fingerprint: string | null = null;

    const fire = () => {
      if (stopped) return;
      try {
        onChange();
      } catch {
        // A panel's refetch failing is the panel's business; the watch goes on.
      }
    };

    const repeat = (ms: number) => {
      const tick = () => {
        timer = setTimer(() => {
          fire();
          tick();
        }, ms);
      };
      tick();
    };

    const clearAll = () => {
      for (const handle of [timer, debounce, renewTimer]) if (handle !== null) clearTimer(handle);
      timer = debounce = renewTimer = null;
      subscription?.unsubscribe();
      subscription = null;
    };

    const fallBackToPolling = () => {
      if (stopped) return;
      clearAll();
      repeat(options.fallbackMs);
    };

    const scheduleRenewal = (expiresAt: number) => {
      if (renewTimer !== null) clearTimer(renewTimer);
      renewTimer = setTimer(
        () => void renew(),
        Math.min(MAX_TIMER_MS, Math.max(0, expiresAt - now() - LIVE_RENEW_EARLY_MS)),
      );
    };

    const renew = async () => {
      renewTimer = null;
      if (stopped || !subscription) return;
      let ticket: LiveTicket;
      try {
        ticket = await ticketFor(topic, params);
      } catch {
        // Lost permission answers 403 and lands here too; the safety refetch
        // then gets the same 403, which is what the panel shows.
        if (!stopped) renewTimer = setTimer(() => void renew(), LIVE_RENEW_RETRY_MS);
        return;
      }
      if (stopped || !subscription) return;
      if (ticket.driver !== "neon" || ticket.query.queryFingerprint !== fingerprint) {
        // The server switched drivers, or the query itself changed: start over.
        clearAll();
        void start();
        return;
      }
      scheduleRenewal(ticket.query.expiresAt);
      subscription.renew(ticket.query).catch(fallBackToPolling);
    };

    const startNeon = async (ticket: Extract<LiveTicket, { driver: "neon" }>) => {
      const client = await clientFor(ticket.url);
      if (stopped) return;
      const sub = client.subscribe(ticket.query);
      subscription = sub;
      fingerprint = ticket.query.queryFingerprint;
      // The first authoritative result is what the panel just loaded; every
      // later one (a commit, or a full replacement after a reconnect) is news.
      let primed = false;
      sub.onUpdate(() => {
        if (!primed) {
          primed = true;
          return;
        }
        if (debounce !== null) clearTimer(debounce);
        debounce = setTimer(() => {
          debounce = null;
          fire();
        }, LIVE_DEBOUNCE_MS);
      });
      sub.onStateChange((state) => {
        if (state.status === "error") fallBackToPolling();
      });
      scheduleRenewal(ticket.query.expiresAt);
      repeat(options.safetyMs ?? LIVE_SAFETY_MS);
    };

    const start = async () => {
      let ticket: LiveTicket;
      try {
        ticket = await ticketFor(topic, params);
      } catch {
        ticket = { driver: "poll" };
      }
      if (stopped) return;
      if (ticket.driver === "poll") {
        repeat(options.fallbackMs);
        return;
      }
      try {
        await startNeon(ticket);
      } catch {
        fallBackToPolling();
      }
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearAll();
      stops.delete(stop);
    };
    stops.add(stop);
    void start();
    return stop;
  }

  return {
    watch,
    close() {
      for (const stop of [...stops]) stop();
      for (const client of clients.values()) void client.then((c) => c.close()).catch(() => {});
      clients.clear();
    },
  };
}
