/**
 * The two desktop surfaces for remote Linux applications: a host's launcher,
 * and one window of one application.
 *
 * Neither resolves how to reach the host. The resource route already does that
 * for the SSH tab — a chosen key, a resolved address, an optional jumpbox — and
 * hands the same connection here, so there is one answer to "how do we get in"
 * rather than two that can disagree.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import { AppLauncherPanel, AppWindowViewer, linuxAppTabTarget, useUIStore } from "@infrawrench/ui";
import type { AppEntry, LaunchResult } from "@infrawrench/appstream-core";

import {
  acquireHostSession,
  hostSessionKey,
  joinHostSession,
  listHostApps,
  type AppsConnectConfig,
  type HostAppsSession,
  type HostStatus,
} from "@/lib/apps-session";

/** Open (or join) the host's session for as long as this panel is mounted. */
function useHostSession(sessionKey: string, config: AppsConnectConfig | null) {
  const [handle, setHandle] = useState<HostAppsSession | null>(null);
  const [status, setStatus] = useState<HostStatus>({ stage: "connecting" });

  // Identity by value: the route rebuilds the config object on every render,
  // and re-running this effect would tear the session down mid-session.
  const configKey = config
    ? [
        config.username,
        config.host,
        config.port,
        ...(config.jumpHops ?? []).map((hop) => `${hop.username}@${hop.host}:${hop.port}`),
      ].join("|")
    : null;

  useEffect(() => {
    if (!config || !configKey) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      try {
        const acquired = await acquireHostSession(sessionKey, config);
        if (cancelled) {
          acquired.release();
          return;
        }
        const unsubscribe = acquired.subscribeStatus(setStatus);
        cleanup = () => {
          unsubscribe();
          acquired.release();
        };
        setHandle(acquired);
        setStatus(acquired.status());
      } catch (error) {
        if (!cancelled) {
          setStatus({
            stage: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, configKey]);

  return { handle, status };
}

/**
 * Join a session someone else opened. A window tab has no key and no address —
 * only the resource — so it cannot start one of its own.
 */
function useJoinedSession(sessionKey: string) {
  const [handle, setHandle] = useState<HostAppsSession | null>(null);
  const [status, setStatus] = useState<HostStatus>({ stage: "connecting" });

  useEffect(() => {
    const joined = joinHostSession(sessionKey);
    if (!joined) {
      setStatus({ stage: "error", message: "no session" });
      return;
    }
    setHandle(joined);
    setStatus(joined.status());
    const unsubscribe = joined.subscribeStatus(setStatus);
    return () => {
      unsubscribe();
      joined.release();
    };
  }, [sessionKey]);

  return { handle, status };
}

export interface AppLauncherHostPanelProps {
  accountId: string;
  resourceId: string;
  config: AppsConnectConfig | null;
}

export function AppLauncherHostPanel({ accountId, resourceId, config }: AppLauncherHostPanelProps) {
  const gt = useGT();
  const { handle, status } = useHostSession(hostSessionKey(accountId, resourceId), config);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "pending" | "error"; message: string } | null>(null);
  const pinTab = useUIStore((state) => state.pinWorkspaceTab);
  const setTabIcon = useUIStore((state) => state.setWorkspaceTabIcon);
  const activate = useUIStore((state) => state.activateWorkspaceTab);
  const tabs = useUIStore((state) => state.workspaceTabs);

  // The list comes from a one-shot exec rather than the session, so the grid
  // paints while the compositor is still starting.
  const refresh = useCallback(() => {
    if (!config) return;
    setListError(null);
    void listHostApps(config)
      .then(setApps)
      .catch((error: unknown) =>
        setListError(error instanceof Error ? error.message : String(error)),
      );
  }, [config]);

  useEffect(refresh, [refresh]);

  // A launch that fails opens no window, so the failure is the only thing that
  // ever comes back. Dropping it leaves a click looking like it did nothing.
  useEffect(() => {
    if (!handle) return;
    const session = handle.session;
    const onResult = (result: LaunchResult) => {
      if (result.ok) return;
      setNotice({
        kind: "error",
        message: result.message ?? gt("The host could not start that application."),
      });
    };
    session.addLaunchResultListener(onResult);
    return () => session.removeLaunchResultListener(onResult);
  }, [handle, gt]);

  // Any window this host opens becomes a tab — including one an application
  // opens by itself, like a browser restoring its last session.
  useEffect(() => {
    if (!handle) return;
    const session = handle.session;
    const onWindow = (windowId: number) => {
      const window = session.window(windowId);
      // A dialog belongs inside its parent's tab, not beside it.
      if (!window || window.parentWindowId !== undefined) return;
      const sessionId = session.sessionId;
      if (!sessionId) return;

      // The window is the launch's real result; whatever we were saying about
      // it starting is now answered by a tab appearing.
      setNotice(null);
      const target = linuxAppTabTarget({
        accountId,
        resourceId,
        sessionId,
        windowId,
        ...(window.appId ? { appId: window.appId } : {}),
      });
      pinTab(target, window.title || gt("App"));
      if (window.icon) {
        const tab = useUIStore
          .getState()
          .workspaceTabs.find(
            (candidate) =>
              candidate.target.kind === "linux-app" && candidate.target.windowId === windowId,
          );
        if (tab) setTabIcon(tab.id, window.icon);
      }
    };

    session.addWindowListener(onWindow);
    return () => session.removeWindowListener(onWindow);
  }, [handle, accountId, resourceId, pinTab, setTabIcon, gt]);

  const running = useMemo(
    () =>
      (handle?.session.windows ?? [])
        .filter((window) => window.parentWindowId === undefined)
        .map((window) => ({
          windowId: window.windowId,
          title: window.title,
          ...(window.icon ? { icon: window.icon } : {}),
          ...(window.appId ? { appId: window.appId } : {}),
        })),
    [handle],
  );

  const message = listError ?? status.message;
  return (
    <AppLauncherPanel
      apps={apps}
      running={running}
      status={status.stage === "ready" ? "ready" : status.stage === "error" ? "error" : "uploading"}
      {...(message ? { statusMessage: message } : {})}
      notice={notice}
      onLaunch={(app) => {
        if (!handle) return;
        setNotice({ kind: "pending", message: gt("Starting {name}…", { name: app.name }) });
        handle.session.launch({ appId: app.id });
      }}
      onRunCommand={(command) => {
        if (!handle) return;
        setNotice({ kind: "pending", message: gt("Starting {name}…", { name: command }) });
        handle.session.launch({ exec: command });
      }}
      onRefresh={refresh}
      onFocusWindow={(windowId) => {
        const tab = tabs.find(
          (candidate) =>
            candidate.target.kind === "linux-app" && candidate.target.windowId === windowId,
        );
        if (tab) activate(tab.id);
      }}
    />
  );
}

export interface AppWindowPanelProps {
  accountId: string;
  resourceId: string;
  windowId: number;
  tabId?: string;
}

export function AppWindowPanel({ accountId, resourceId, windowId, tabId }: AppWindowPanelProps) {
  const gt = useGT();
  const { handle, status } = useJoinedSession(hostSessionKey(accountId, resourceId));
  const setTabTitle = useUIStore((state) => state.setWorkspaceTabTitle);
  const setTabIcon = useUIStore((state) => state.setWorkspaceTabIcon);
  const removeTabs = useUIStore((state) => state.removeWorkspaceTabs);
  const [closedReason, setClosedReason] = useState<string | null>(null);

  // The window's own title and icon become the tab's: an application renames
  // its window every time it opens a document, and the tab should follow.
  useEffect(() => {
    if (!handle || !tabId) return;
    const session = handle.session;
    const apply = (id: number) => {
      if (id !== windowId) return;
      const window = session.window(windowId);
      if (!window) return;
      if (window.title) setTabTitle(tabId, window.title);
      if (window.icon) setTabIcon(tabId, window.icon);
    };
    apply(windowId);

    const onClose = (id: number, reason: string) => {
      if (id === windowId) setClosedReason(reason);
    };
    session.addWindowListener(apply);
    session.addWindowCloseListener(onClose);
    return () => {
      session.removeWindowListener(apply);
      session.removeWindowCloseListener(onClose);
    };
  }, [handle, tabId, windowId, setTabTitle, setTabIcon]);

  if (closedReason) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-on-surface-muted">
          {closedReason === "crashed" ? (
            <T>This application stopped unexpectedly on the host.</T>
          ) : (
            <T>This window has closed on the host.</T>
          )}
        </p>
        {tabId && (
          <button
            type="button"
            onClick={() => removeTabs([tabId])}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-on-surface-secondary hover:text-on-surface"
          >
            <T>Close tab</T>
          </button>
        )}
      </div>
    );
  }

  if (!handle) {
    // The session lives in this window's memory, so a reload ends it. The
    // application is still running on the host — the launcher will list it —
    // and saying so beats an empty canvas.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-on-surface-muted">
          <T>This window is no longer connected.</T>
        </p>
        <p className="max-w-md text-xs text-on-surface-faint">
          <T>Open the host's Apps tab to reconnect — the application is still running there.</T>
        </p>
      </div>
    );
  }

  return (
    <AppWindowViewer
      session={handle.session}
      windowId={windowId}
      {...(status.stage !== "ready" ? { status: status.message ?? gt("Starting…") } : {})}
      onClose={() => handle.session.closeWindow(windowId)}
    />
  );
}
