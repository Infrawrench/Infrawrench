/**
 * The desktop's live-update watcher (client-core `live.ts`), for cloud mode.
 *
 * Tickets come through the contract's `live` domain over the cloud transport,
 * like every other cloud call; the Neon Realtime socket itself is opened by
 * the renderer, whose CSP already allows any `wss:` origin. In local mode
 * there is no cloud to ask, so no watcher is provided and every panel keeps
 * its own interval (`useLiveRefresh` without a provider).
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { createLiveWatcher } from "@infrawrench/client-core";
import { LiveUpdatesProvider, PaletteHostProvider, type PaletteHostValue } from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

export function DesktopLiveUpdates({
  orgId,
  children,
}: {
  orgId: string | null;
  children: ReactNode;
}) {
  const watcher = useMemo(
    () =>
      orgId
        ? createLiveWatcher((topic, params) =>
            runRpc(
              cloudClient("live").live.ticket({
                params: { orgId },
                payload: { topic, ...params },
              }),
            ),
          )
        : null,
    [orgId],
  );
  useEffect(() => () => watcher?.close(), [watcher]);
  return <LiveUpdatesProvider watcher={watcher}>{children}</LiveUpdatesProvider>;
}

/**
 * The org-scoped contexts the root mounts around the sidebar and the tab
 * viewport: live updates and the command palette's host.
 */
export function DesktopOrgProviders({
  orgId,
  paletteHost,
  children,
}: {
  orgId: string | null;
  paletteHost: PaletteHostValue;
  children: ReactNode;
}) {
  return (
    <DesktopLiveUpdates orgId={orgId}>
      <PaletteHostProvider value={paletteHost}>{children}</PaletteHostProvider>
    </DesktopLiveUpdates>
  );
}
