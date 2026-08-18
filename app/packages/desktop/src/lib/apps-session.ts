/**
 * Linux application sessions, renderer side.
 *
 * One session per host, shared by every tab looking at that host: the launcher
 * and each open window are views onto the same connection, so opening a second
 * window does not upload the binary again or start a second compositor.
 */

import {
  AppSession,
  probeClientCaps,
  type AppEntry,
  type AppSessionTransport,
  type ClientCaps,
} from "@infrawrench/appstream-core";
import type {
  HostRequirementsCheck,
  InstallOutcome,
  RequirementId,
} from "@infrawrench/appstream-core";

import { invoke } from "./invoke";

/**
 * Subscribe to a main-process event channel, returning an unsubscribe.
 *
 * The preload bridge only offers `on` and `offAll`, so a session removes every
 * listener for its own channel — which is correct here because each channel
 * name carries the session id and has exactly one subscriber.
 */
function onEvent(channel: string, handler: (payload: unknown) => void): () => void {
  window.electronAPI.on(channel, (payload) => handler(payload));
  return () => window.electronAPI.offAll(channel);
}

export interface AppsConnectConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /**
   * Set when `privateKey` is `CLOUD_KEY_SENTINEL`: the org key the main
   * process authenticates with through the cloud signing agent. The private
   * half never reaches this machine; the app stream still runs directly
   * between this machine and the host.
   */
  cloudKey?: { orgId: string; sshKeyId: string };
  agentForward?: boolean;
  jumpHops?: Array<{ host: string; port: number; username: string; privateKey: string }>;
}

/** Everything a tab needs to talk to one host. */
export interface HostAppsSession {
  session: AppSession;
  /** Progress and diagnostics from the host, newest last. */
  subscribeStatus(listener: (status: HostStatus) => void): () => void;
  status(): HostStatus;
  /** Release one holder; the session closes when the last one lets go. */
  release(): void;
}

export interface HostStatus {
  stage: "connecting" | "uploading" | "starting" | "ready" | "error";
  message?: string;
}

interface Entry {
  key: string;
  holders: number;
  status: HostStatus;
  listeners: Set<(status: HostStatus) => void>;
  session: AppSession;
  sessionId: string;
  dispose: () => void;
}

const entries = new Map<string, Entry>();

/**
 * Caps are probed once per renderer: `VideoDecoder.isConfigSupported` is async
 * and the answer cannot change while the window is open.
 */
let capsPromise: Promise<ClientCaps> | undefined;
function caps(): Promise<ClientCaps> {
  // zstd is always available: the viewer decompresses in JS via fzstd, so the
  // host can always use the lossless tier.
  capsPromise ??= probeClientCaps({ zstd: true });
  return capsPromise;
}

/**
 * Sessions are keyed by resource rather than by address.
 *
 * A window tab knows which resource it belongs to and nothing about keys or
 * jump hosts, so keying by resource is what lets it join the session the
 * launcher opened instead of asking the user to choose a key a second time.
 */
export function hostSessionKey(accountId: string, resourceId: string): string {
  return `${accountId}::${resourceId}`;
}

/**
 * Open (or join) the session for a host.
 *
 * Every caller must `release()` exactly once. The session outlives any single
 * tab so that closing a window does not tear down the launcher, and it closes
 * as soon as nothing is looking at the host any more.
 */
export async function acquireHostSession(
  key: string,
  config: AppsConnectConfig,
): Promise<HostAppsSession> {
  const existing = entries.get(key);
  if (existing) {
    existing.holders += 1;
    return view(existing);
  }

  const clientCaps = await caps();
  const { sessionId } = await invoke<{ sessionId: string }>(
    "apps_session_open",
    config as unknown as Record<string, unknown>,
  );

  const listeners = new Set<(status: HostStatus) => void>();
  const entry: Entry = {
    key,
    holders: 1,
    status: { stage: "connecting" },
    listeners,
    sessionId,
    session: undefined as unknown as AppSession,
    dispose: () => {},
  };

  const setStatus = (status: HostStatus) => {
    entry.status = status;
    for (const listener of listeners) listener(status);
  };

  const incoming: Array<(bytes: Uint8Array) => void> = [];
  const closed: Array<() => void> = [];

  const offData = onEvent(`apps_data_${sessionId}`, (payload) => {
    const bytes = payload as Uint8Array;
    for (const handler of incoming) handler(bytes);
  });
  const offExit = onEvent(`apps_exit_${sessionId}`, () => {
    setStatus({ stage: "error", message: "the app server stopped" });
    for (const handler of closed) handler();
  });
  const offStderr = onEvent(`apps_stderr_${sessionId}`, (line) => {
    // Only surfaced as status when it is the thing that went wrong; the rest
    // is noise a user cannot act on.
    const text = String(line);
    if (/error|failed|cannot/i.test(text)) setStatus({ stage: "error", message: text });
  });
  const offProgress = onEvent(`apps_progress_${sessionId}`, (stage) => {
    const value = String(stage);
    if (value === "uploading") setStatus({ stage: "uploading" });
    else if (value === "starting") setStatus({ stage: "starting" });
  });

  const transport: AppSessionTransport = {
    send: (bytes) => void invoke<void>("apps_session_write", { sessionId, data: bytes }),
    onMessage: (handler) => incoming.push(handler),
    onClose: (handler) => closed.push(handler),
    close: () => void invoke<void>("apps_session_close", { sessionId }),
  };

  entry.session = new AppSession(transport, {
    caps: clientCaps,
    devicePixelRatio: window.devicePixelRatio || 1,
    events: {
      onReady: () => setStatus({ stage: "ready" }),
      onError: (message) => setStatus({ stage: "error", message }),
      onClipboard: (blob) => writeToClipboard(blob),
    },
  });

  entry.dispose = () => {
    offData();
    offExit();
    offStderr();
    offProgress();
    void invoke<void>("apps_session_close", { sessionId });
  };

  entries.set(key, entry);
  return view(entry);
}

function view(entry: Entry): HostAppsSession {
  let released = false;
  return {
    session: entry.session,
    status: () => entry.status,
    subscribeStatus: (listener) => {
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    release: () => {
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders > 0) return;
      entries.delete(entry.key);
      entry.dispose();
    },
  };
}

/**
 * Join a session that is already open, without being able to start one.
 *
 * A window tab uses this: it has no key and no address, only the resource. When
 * there is no session — after a reload, or once the launcher tab is closed —
 * it returns null and the tab says so rather than silently showing nothing.
 */
export function joinHostSession(key: string): HostAppsSession | null {
  const entry = entries.get(key);
  if (!entry) return null;
  entry.holders += 1;
  return view(entry);
}

/**
 * What this host is missing before it can run applications.
 *
 * One SSH exec that only looks. Deliberately separate from the session so it
 * can answer on a host where opening one would fail — the missing thing may be
 * the `gunzip` that unpacks the app server.
 */
export async function preflightHostApps(config: AppsConnectConfig): Promise<HostRequirementsCheck> {
  return await invoke<HostRequirementsCheck>("apps_preflight", { config });
}

/**
 * Install what is missing, relaying the package manager's output as it comes.
 *
 * The renderer names which requirements to install; the commands are the main
 * process's own, built from a fresh probe there.
 */
export async function installHostRequirements(
  config: AppsConnectConfig,
  include: RequirementId[] | undefined,
  onOutput: (line: string) => void,
): Promise<InstallOutcome> {
  const installId = crypto.randomUUID();
  const off = onEvent(`apps_install_${installId}`, (line) => onOutput(String(line)));
  try {
    return await invoke<InstallOutcome>("apps_install", {
      config,
      installId,
      ...(include ? { include } : {}),
    });
  } finally {
    off();
  }
}

/** List a host's applications without opening a session. */
export async function listHostApps(config: AppsConnectConfig, iconSize = 48): Promise<AppEntry[]> {
  return await invoke<AppEntry[]>("apps_list", { config, iconSize });
}

/**
 * Text copied inside a remote application, put on this machine's clipboard.
 *
 * Best effort on purpose. Writing the clipboard needs a permission the browser
 * grants to a focused tab and withholds from a background one, and this
 * arrives whenever the application decides to copy rather than in response to
 * anything the user did *here*. A refusal means the paste does not work this
 * time, which is worth neither an error nor a prompt.
 */
function writeToClipboard(blob: { mimeType: string; data: Uint8Array }): void {
  if (!blob.mimeType.startsWith("text/plain")) return;
  const text = new TextDecoder().decode(blob.data);
  if (!text) return;
  void navigator.clipboard?.writeText(text).catch(() => {
    /* not focused, or not permitted; the next copy will try again */
  });
}
