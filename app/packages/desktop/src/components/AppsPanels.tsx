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
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  AppLauncherPanel,
  AppWindowViewer,
  HostSetupPanel,
  linuxAppTabTarget,
  useHostSetup,
  useUIStore,
} from "@infrawrench/ui";
import type { AppEntry, LaunchResult } from "@infrawrench/appstream-core";

import { getWorkspaceNavigateArgs, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";
import {
  acquireHostSession,
  hostSessionKey,
  joinHostSession,
  installHostRequirements,
  listHostApps,
  preflightHostApps,
  type AppsConnectConfig,
  type HostAppsSession,
  type HostStatus,
} from "@/lib/apps-session";

/** Open (or join) the host's session for as long as this panel is mounted. */
/**
 * Which host, by value.
 *
 * The route rebuilds the config object on every render, so anything that keys
 * an effect on "the host" has to spell it out — the session would otherwise
 * tear itself down mid-session, and the setup check would re-probe the host on
 * every paint.
 *
 * The login is in it and the key is not: what is installed is a property of the
 * host, `privilege` is a property of the user, and which key proved that user —
 * local or cloud-held — cannot change either answer. The jump chain is in it
 * because a different chain can reach a different machine.
 */
function hostIdentity(config: AppsConnectConfig | null): string | null {
  return config
    ? [
        config.username,
        config.host,
        config.port,
        ...(config.jumpHops ?? []).map((hop) => `${hop.username}@${hop.host}:${hop.port}`),
      ].join("|")
    : null;
}

function useHostSession(sessionKey: string, config: AppsConnectConfig | null) {
  const [handle, setHandle] = useState<HostAppsSession | null>(null);
  const [status, setStatus] = useState<HostStatus>({ stage: "connecting" });

  const configKey = hostIdentity(config);

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
  /** The host's plugin and type — each window tab is addressed at its URL. */
  pluginId?: string;
  resourceTypeId?: string;
  config: AppsConnectConfig | null;
}

export function AppLauncherHostPanel({
  accountId,
  resourceId,
  pluginId,
  resourceTypeId,
  config,
}: AppLauncherHostPanelProps) {
  const gt = useGT();
  const configKey = hostIdentity(config);
  const setup = useHostSetup(
    config
      ? {
          check: () => preflightHostApps(config),
          install: (requirements, onOutput) =>
            installHostRequirements(config, requirements, onOutput),
        }
      : null,
    configKey,
  );
  // The session waits for the check. It has to: the thing the host is missing
  // may be the `gunzip` that unpacks the app server, in which case starting a
  // session only produces a worse version of the same message. `blocked` is
  // false while the check is still running, so the common case — a host with
  // everything — costs one short exec and then connects.
  const { handle, status } = useHostSession(
    hostSessionKey(accountId, resourceId),
    setup.blocked ? null : config,
  );
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "pending" | "error"; message: string } | null>(null);
  const navigate = useNavigate();
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
      // This listener also fires on every title and icon change, and the
      // window tab keeps those in step itself — re-pinning here would yank
      // focus to the window each time Firefox retitles on a page load.
      const already = useUIStore
        .getState()
        .workspaceTabs.some(
          (candidate) =>
            candidate.target.kind === "linux-app" &&
            candidate.target.sessionId === sessionId &&
            candidate.target.windowId === windowId,
        );
      if (already) return;

      // The window is the launch's real result; whatever we were saying about
      // it starting is now answered by a tab appearing.
      setNotice(null);
      const target = linuxAppTabTarget({
        accountId,
        resourceId,
        sessionId,
        windowId,
        // The window tab is addressed at this host's own URL, which carries
        // the host's plugin and type rather than a guess at them.
        ...(pluginId ? { pluginId } : {}),
        ...(resourceTypeId ? { resourceTypeId } : {}),
        ...(window.appId ? { appId: window.appId } : {}),
      });
      // Navigated to, not just pinned: the launch the user is waiting on
      // should land them in the application, and pinning without routing
      // leaves the URL on the launcher for the route sync to snap back to.
      void navigateToWorkspaceTarget(navigate, target, {
        label: window.title || gt("App"),
        mode: "pin",
      });
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
  }, [handle, accountId, resourceId, pluginId, resourceTypeId, navigate, setTabIcon, gt]);

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

  if (setup.blocked && setup.preflight) {
    return (
      <HostSetupPanel
        preflight={setup.preflight}
        plan={setup.plan}
        installing={setup.installing}
        log={setup.log}
        error={setup.error}
        onInstall={setup.install}
        onRecheck={setup.recheck}
        onContinueAnyway={setup.dismiss}
      />
    );
  }

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
        if (!tab) return;
        activate(tab.id);
        void navigate(getWorkspaceNavigateArgs(tab.target));
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
