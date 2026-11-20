/**
 * Live updates on mobile: client-core's watcher (`live.ts`) behind a
 * react-query friendly hook. A screen drops its `refetchInterval` and calls
 *
 *     useLiveRefetch("jit-requests", {}, () => requests.refetch(), { fallbackMs: POLL_MS });
 *
 * which refetches when the topic moves, through Neon Realtime where the
 * server has it and on `fallbackMs` where it does not, exactly as the web and
 * desktop panels do. One watcher per signed-in client and org, shared by
 * every screen, so they share one Realtime socket.
 */
import { useEffect, useRef } from "react";
import {
  createLiveWatcher,
  fetchLiveTicket,
  type CloudFetch,
  type LiveTopic,
  type LiveTopicParams,
  type LiveWatcher,
} from "@infrawrench/client-core";
import { useOrgApi } from "./auth/AuthProvider";

const watchers = new WeakMap<CloudFetch, Map<string, LiveWatcher>>();

function watcherFor(api: CloudFetch, orgId: string): LiveWatcher {
  let byOrg = watchers.get(api);
  if (!byOrg) {
    byOrg = new Map();
    watchers.set(api, byOrg);
  }
  let watcher = byOrg.get(orgId);
  if (!watcher) {
    watcher = createLiveWatcher((topic, params) => fetchLiveTicket(api, orgId, topic, params));
    byOrg.set(orgId, watcher);
  }
  return watcher;
}

export function useLiveRefetch(
  topic: LiveTopic,
  params: LiveTopicParams,
  refetch: () => unknown,
  options: { fallbackMs: number; safetyMs?: number; enabled?: boolean },
): void {
  const { api, orgId } = useOrgApi();
  const latest = useRef(refetch);
  latest.current = refetch;
  const enabled = options.enabled ?? true;
  const { fallbackMs, safetyMs } = options;
  const { accountId, resourceId, workflowId } = params;

  useEffect(() => {
    if (!enabled) return;
    const scoped: LiveTopicParams = {
      ...(accountId ? { accountId } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(workflowId ? { workflowId } : {}),
    };
    return watcherFor(api, orgId).watch(
      topic,
      scoped,
      () => {
        void Promise.resolve()
          .then(() => latest.current())
          .catch(() => {});
      },
      { fallbackMs, ...(safetyMs !== undefined ? { safetyMs } : {}) },
    );
  }, [api, orgId, topic, enabled, accountId, resourceId, workflowId, fallbackMs, safetyMs]);
}
