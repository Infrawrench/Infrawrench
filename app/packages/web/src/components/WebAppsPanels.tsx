/**
 * The web app's two surfaces for remote Linux applications: a host's launcher,
 * and one window of one application.
 *
 * The mirror of the desktop's `AppsPanels.tsx` — same components from
 * `@infrawrench/ui`, same session-per-host model — over the WebSocket transport
 * instead of IPC.
 */

import { useEffect, useMemo, useState } from "react";
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
  checkHostRequirements,
  hostSessionKey,
  installHostRequirements,
  joinHostSession,
  type AppsConnectTarget,
  type HostAppsSession,
  type HostStatus,
} from "@/lib/apps-session";

function useHostSession(target: AppsConnectTarget | null) {
  const [handle, setHandle] = useState<HostAppsSession | null>(null);
  const [status, setStatus] = useState<HostStatus>({ stage: "connecting" });
  const key = target ? hostSessionKey(target.accountId, target.resourceId) : null;

  useEffect(() => {
    if (!target || !key) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      try {
        const acquired = await acquireHostSession(key, target);
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
  }, [key, target?.sshKeyId, target?.host, target?.username]);

  return { handle, status };
}

export function WebAppLauncherPanel({ target }: { target: AppsConnectTarget | null }) {
  const gt = useGT();
  // What the check follows, spelled out rather than left to object identity —
  // the login and the address, since what is installed is a property of the
  // host and `privilege` of the user, and neither turns on which key proved it.
  const targetKey = target ? `${target.username}@${target.host}` : null;
  const setup = useHostSetup(
    target
      ? {
          check: () => checkHostRequirements(target),
          install: (requirements, onOutput) =>
            installHostRequirements(target, requirements, onOutput),
        }
      : null,
    targetKey,
  );
  // The session waits for the check, for the same reason as on desktop: the
  // missing piece may be the `gunzip` that unpacks the app server, and starting
  // a session then only produces a worse version of the same message.
  const { handle, status } = useHostSession(setup.blocked ? null : target);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [notice, setNotice] = useState<{ kind: "pending" | "error"; message: string } | null>(null);
  const navigate = useNavigate();
  const setTabIcon = useUIStore((state) => state.setWorkspaceTabIcon);
  const activate = useUIStore((state) => state.activateWorkspaceTab);
  const tabs = useUIStore((state) => state.workspaceTabs);

  // On web the list comes over the session rather than from a second exec:
  // there is no local process to run one from.
  useEffect(() => {
    if (!handle) return;
    const session = handle.session;
    session.listApps();
    const onApps = (next: AppEntry[]) => setApps(next);
    session.addAppsListener(onApps);
    return () => session.removeAppsListener(onApps);
  }, [handle]);

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

  useEffect(() => {
    if (!handle || !target) return;
    const session = handle.session;
    const onWindow = (windowId: number) => {
      const window = session.window(windowId);
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
      // it starting is now answered by a tab appearing — and navigated to,
      // not just pinned: pinning without routing leaves the URL on the
      // launcher for the route sync to snap the active tab back to.
      setNotice(null);
      void navigateToWorkspaceTarget(
        navigate,
        linuxAppTabTarget({
          accountId: target.accountId,
          resourceId: target.resourceId,
          sessionId,
          windowId,
          // The window tab is addressed at this host's own URL, which needs
          // the host's plugin and type — not a guess at them.
          pluginId: target.pluginId,
          resourceTypeId: target.resourceTypeId,
          ...(window.appId ? { appId: window.appId } : {}),
        }),
        { label: window.title || gt("App"), mode: "pin" },
      );
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
  }, [handle, target, navigate, setTabIcon, gt]);

  const running = useMemo(
    () =>
      (handle?.session.windows ?? [])
        .filter((window) => window.parentWindowId === undefined)
        .map((window) => ({
          windowId: window.windowId,
          title: window.title,
          ...(window.icon ? { icon: window.icon } : {}),
        })),
    [handle],
  );

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="max-w-md text-sm text-on-surface-muted">
          <T>
            Applications need an SSH key this host trusts. Add one under Settings → SSH keys, then
            reopen this tab.
          </T>
        </p>
      </div>
    );
  }

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

  return (
    <AppLauncherPanel
      apps={apps}
      running={running}
      status={
        status.stage === "ready" ? "ready" : status.stage === "error" ? "error" : "connecting"
      }
      {...(status.message ? { statusMessage: status.message } : {})}
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
      onRefresh={() => handle?.session.listApps(true)}
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

export function WebAppWindowPanel({
  accountId,
  resourceId,
  windowId,
  tabId,
}: {
  accountId: string;
  resourceId: string;
  windowId: number;
  tabId?: string;
}) {
  const [handle, setHandle] = useState<HostAppsSession | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const setTabTitle = useUIStore((state) => state.setWorkspaceTabTitle);
  const setTabIcon = useUIStore((state) => state.setWorkspaceTabIcon);
  const removeTabs = useUIStore((state) => state.removeWorkspaceTabs);

  useEffect(() => {
    const joined = joinHostSession(hostSessionKey(accountId, resourceId));
    if (!joined) return;
    setHandle(joined);
    return () => joined.release();
  }, [accountId, resourceId]);

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
    // The session lives in this page's memory, so a reload ends it. The
    // application is still running on the host and the launcher will list it.
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
      onClose={() => handle.session.closeWindow(windowId)}
    />
  );
}
