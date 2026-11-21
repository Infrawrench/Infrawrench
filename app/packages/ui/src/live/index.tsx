/**
 * Live updates for panels: the React half of client-core's `live.ts`.
 *
 * A panel keeps its own fetch and says what it shows:
 *
 *     useLiveRefresh("jit-requests", {}, load, { fallbackMs: 15_000 });
 *
 * Under a {@link LiveUpdatesProvider} (web's org shell, the desktop in cloud
 * mode) that asks the server for a ticket and refetches when the topic moves,
 * through Neon Realtime where the server has it and on `fallbackMs` where it
 * does not. With no provider (desktop local mode, tests, Storybook-style
 * renders) it is the plain interval the panel used to run itself, so a panel
 * never needs to know which host it is in.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { LiveTopic, LiveTopicParams, LiveWatcher } from "@infrawrench/client-core";

const LiveUpdatesContext = createContext<LiveWatcher | null>(null);

export function LiveUpdatesProvider({
  watcher,
  children,
}: {
  watcher: LiveWatcher | null;
  children: ReactNode;
}) {
  return <LiveUpdatesContext.Provider value={watcher}>{children}</LiveUpdatesContext.Provider>;
}

/** The host's watcher, or null outside a provider. */
export function useLiveWatcher(): LiveWatcher | null {
  return useContext(LiveUpdatesContext);
}

export interface LiveRefreshOptions {
  /** The interval to refetch on without a push channel: the panel's old poll. */
  readonly fallbackMs: number;
  /** See client-core's `LiveWatchOptions.safetyMs`. */
  readonly safetyMs?: number;
  /** False pauses the watch (no permission yet, nothing selected). Defaults to true. */
  readonly enabled?: boolean;
}

/**
 * Call `refresh` whenever `topic` changes. `params` null pauses the watch, the
 * same as `enabled: false`; its fields are compared by value, so an inline
 * object literal does not restart it on each render.
 */
export function useLiveRefresh(
  topic: LiveTopic,
  params: LiveTopicParams | null,
  refresh: () => unknown,
  options: LiveRefreshOptions,
): void {
  const watcher = useLiveWatcher();
  const latest = useRef(refresh);
  latest.current = refresh;

  const enabled = (options.enabled ?? true) && params !== null;
  const accountId = params?.accountId;
  const resourceId = params?.resourceId;
  const workflowId = params?.workflowId;
  const { fallbackMs, safetyMs } = options;

  useEffect(() => {
    if (!enabled) return;
    const fire = () => {
      void Promise.resolve()
        .then(() => latest.current())
        .catch(() => {
          // The panel's own error state shows a failed refetch.
        });
    };
    if (!watcher) {
      const timer = setInterval(fire, fallbackMs);
      return () => clearInterval(timer);
    }
    const scoped: LiveTopicParams = {
      ...(accountId ? { accountId } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(workflowId ? { workflowId } : {}),
    };
    return watcher.watch(topic, scoped, fire, {
      fallbackMs,
      ...(safetyMs !== undefined ? { safetyMs } : {}),
    });
  }, [watcher, topic, enabled, accountId, resourceId, workflowId, fallbackMs, safetyMs]);
}

/**
 * {@link useLiveRefresh} for a list of scopes at once (one watch per expanded
 * account in a sidebar): `refresh` is called with the scope that moved.
 */
export function useLiveRefreshEach(
  topic: LiveTopic,
  scopes: readonly LiveTopicParams[],
  refresh: (scope: LiveTopicParams) => unknown,
  options: LiveRefreshOptions,
): void {
  const watcher = useLiveWatcher();
  const latest = useRef(refresh);
  latest.current = refresh;

  const enabled = options.enabled ?? true;
  const { fallbackMs, safetyMs } = options;
  // Compared by value: a fresh array of the same scopes keeps the watches.
  const key = JSON.stringify(
    scopes.map((s) => [s.accountId ?? "", s.resourceId ?? "", s.workflowId ?? ""]),
  );

  useEffect(() => {
    const list: LiveTopicParams[] = (JSON.parse(key) as string[][]).map(
      ([accountId, resourceId, workflowId]) => ({
        ...(accountId ? { accountId } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(workflowId ? { workflowId } : {}),
      }),
    );
    if (!enabled || list.length === 0) return;
    const fire = (scope: LiveTopicParams) => () => {
      void Promise.resolve()
        .then(() => latest.current(scope))
        .catch(() => {});
    };
    if (!watcher) {
      const timer = setInterval(() => list.forEach((scope) => fire(scope)()), fallbackMs);
      return () => clearInterval(timer);
    }
    const stops = list.map((scope) =>
      watcher.watch(topic, scope, fire(scope), {
        fallbackMs,
        ...(safetyMs !== undefined ? { safetyMs } : {}),
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [watcher, topic, key, enabled, fallbackMs, safetyMs]);
}

/**
 * Watch a topic from inside an effect that already owns the refresh (pass the
 * watcher from {@link useLiveWatcher}); with no watcher, a plain interval.
 */
export function watchLive(
  watcher: LiveWatcher | null,
  topic: LiveTopic,
  params: LiveTopicParams,
  refresh: () => void,
  options: Pick<LiveRefreshOptions, "fallbackMs" | "safetyMs">,
): () => void {
  if (!watcher) {
    const timer = setInterval(refresh, options.fallbackMs);
    return () => clearInterval(timer);
  }
  return watcher.watch(topic, params, refresh, {
    fallbackMs: options.fallbackMs,
    ...(options.safetyMs !== undefined ? { safetyMs: options.safetyMs } : {}),
  });
}
