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

import { Cause, Effect, Exit, Predicate, Stream } from "effect";
import type { AppsConnectConfig } from "../../shared/rpc/groups/linux-apps";
import { DesktopRpcClient, forkRpc, runRpc } from "./rpc/client";

/**
 * Where and how to connect (`AppsConnectConfig` in
 * `shared/rpc/groups/linux-apps.ts`). When `privateKey` is
 * `CLOUD_KEY_SENTINEL`, `cloudKey` names the org key the main process
 * authenticates with through the cloud signing agent: its private half never
 * reaches this machine, and the app stream still runs directly between this
 * machine and the host.
 */
export type { AppsConnectConfig };

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.squash(exit.cause);
  return Predicate.isError(failure) ? failure.message : String(failure);
};

/**
 * Open the session's stream and resolve once the app server is running. The
 * stream carries everything after that; `stop` interrupts it, which closes
 * the app server and the connection in the main process.
 */
function openSession(
  config: AppsConnectConfig,
  handlers: {
    onData: (bytes: Uint8Array) => void;
    onStderr: (line: string) => void;
    onProgress: (stage: string) => void;
    /** The app server exited, or the connection to it failed, after it opened. */
    onClosed: () => void;
  },
): Promise<{ sessionId: string; stop: () => void }> {
  let sessionId: string | null = null;
  let stopped = false;
  return new Promise((resolve, reject) => {
    const stop = forkRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* Stream.runForEach(rpc.AppsSessionOpen(config), (event) =>
          Effect.sync(() => {
            switch (event._tag) {
              case "Opened":
                sessionId = event.sessionId;
                resolve({
                  sessionId: event.sessionId,
                  stop: () => {
                    stopped = true;
                    stop();
                  },
                });
                return;
              case "Data":
                handlers.onData(event.data);
                return;
              case "Stderr":
                if (sessionId !== null) handlers.onStderr(event.line);
                return;
              case "Progress":
                if (sessionId !== null) handlers.onProgress(event.stage);
                return;
            }
          }),
        );
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (stopped) return;
            if (sessionId === null) {
              reject(new Error(failureMessage(exit) ?? "The app server did not start"));
              return;
            }
            handlers.onClosed();
          }),
        ),
      ),
    );
  });
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
  const incoming: Array<(bytes: Uint8Array) => void> = [];
  const closed: Array<() => void> = [];
  // Frames that arrive between `Opened` and the session attaching its
  // handler (the app server speaks first), delivered when it attaches.
  const backlog: Uint8Array[] = [];
  // The status handlers only ever run after `entry` exists: the session's
  // events reach them once the open has resolved.
  let setStatus: (status: HostStatus) => void = () => {};
  const { sessionId, stop } = await openSession(config, {
    onData: (bytes) => {
      if (incoming.length === 0) backlog.push(bytes);
      for (const handler of incoming) handler(bytes);
    },
    onClosed: () => {
      setStatus({ stage: "error", message: "the app server stopped" });
      for (const handler of closed) handler();
    },
    onStderr: (text) => {
      // Only surfaced as status when it is the thing that went wrong; the rest
      // is noise a user cannot act on.
      if (/error|failed|cannot/i.test(text)) setStatus({ stage: "error", message: text });
    },
    onProgress: (value) => {
      if (value === "uploading") setStatus({ stage: "uploading" });
      else if (value === "starting") setStatus({ stage: "starting" });
    },
  });

  const listeners = new Set<(status: HostStatus) => void>();
  // `session` is attached below, once the transport it needs exists; the
  // status closures only ever run after that.
  const entry: Omit<Entry, "session"> = {
    key,
    holders: 1,
    status: { stage: "connecting" },
    listeners,
    sessionId,
    dispose: () => {},
  };

  setStatus = (status: HostStatus) => {
    entry.status = status;
    for (const listener of listeners) listener(status);
  };

  const transport: AppSessionTransport = {
    send: (bytes) =>
      void runRpc(DesktopRpcClient.use((rpc) => rpc.AppsSessionWrite({ sessionId, data: bytes }))),
    onMessage: (handler) => {
      incoming.push(handler);
      for (const bytes of backlog.splice(0)) handler(bytes);
    },
    onClose: (handler) => closed.push(handler),
    close: stop,
  };

  const session = new AppSession(transport, {
    caps: clientCaps,
    devicePixelRatio: window.devicePixelRatio || 1,
    events: {
      onReady: () => setStatus({ stage: "ready" }),
      onError: (message) => setStatus({ stage: "error", message }),
      onClipboard: (blob) => writeToClipboard(blob),
    },
  });

  entry.dispose = stop;

  // Same object, now complete: the closures above keep writing to it.
  const ready: Entry = Object.assign(entry, { session });
  entries.set(key, ready);
  return view(ready);
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
 * there is no session (after a reload, or once the launcher tab is closed)
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
 * can answer on a host where opening one would fail: the missing thing may be
 * the `gunzip` that unpacks the app server.
 */
export async function preflightHostApps(config: AppsConnectConfig): Promise<HostRequirementsCheck> {
  return await runRpc(DesktopRpcClient.use((rpc) => rpc.AppsPreflight({ config })));
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
  const outcome = await runRpc(
    Effect.gen(function* () {
      const rpc = yield* DesktopRpcClient;
      let done: InstallOutcome | undefined;
      yield* Stream.runForEach(
        rpc.AppsInstall({ config, ...(include ? { include } : {}) }),
        (event) =>
          Effect.sync(() => {
            if (event._tag === "Output") onOutput(event.line);
            else done = event.outcome;
          }),
      );
      return done;
    }),
  );
  if (!outcome) throw new Error("The install ended without reporting what changed.");
  return outcome;
}

/** List a host's applications without opening a session. */
export async function listHostApps(config: AppsConnectConfig, iconSize = 48): Promise<AppEntry[]> {
  return await runRpc(DesktopRpcClient.use((rpc) => rpc.AppsList({ config, iconSize })));
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
