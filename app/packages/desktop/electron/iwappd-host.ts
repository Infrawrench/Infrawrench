/**
 * Linux application sessions, main-process side.
 *
 * The renderer resolves which host to connect to and with which key — exactly
 * as it does for an SSH tab — and this opens the connection, puts `iwappd` into
 * the host's RAM, runs it, and relays protocol frames both ways.
 *
 * The connection itself is `connectSshChain` from `ssh-shell.ts`, so jump
 * hosts, agent forwarding and the TOFU host-key check behave identically to a
 * terminal. Everything above the connection is `@infrawrench/appstream-host`,
 * shared with the web server.
 */

import * as crypto from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import {
  checkHost,
  installRequirements,
  listApps,
  planInstall,
  probeHost,
  startAppServer,
  type AppServerSession,
  type HostRequirementsCheck,
  type InstallOutcome,
  type RequirementId,
} from "@infrawrench/appstream-host";

import { connectSshChain, endSshChain, type SshShellConfig } from "./ssh-shell";
import { getArm64GzBinary, getx86_64GzBinary } from "./iwappd-archive";

type SshClient = Awaited<ReturnType<typeof connectSshChain>>["client"];

interface SessionRecord {
  session: AppServerSession;
  client: SshClient;
  intermediates: SshClient[];
  webContents: WeakRef<WebContents>;
}

const sessions = new Map<string, SessionRecord>();

/** Which gzipped binary to send, decided by the host's own architecture. */
const binaryForArch = (arch: "x86_64" | "aarch64") =>
  arch === "x86_64" ? getx86_64GzBinary() : getArm64GzBinary();

function send(sessionId: string, channel: string, payload?: unknown): void {
  const target = sessions.get(sessionId)?.webContents.deref();
  if (target && !target.isDestroyed()) target.send(channel, payload);
}

/**
 * Open a session: connect, stage the binary in RAM, exec it, and start
 * forwarding frames. Returns the id the renderer addresses it by.
 */
async function openSession(
  webContents: WebContents,
  config: SshShellConfig,
): Promise<{ sessionId: string }> {
  const { client, intermediates } = await connectSshChain(config);
  const sessionId = crypto.randomUUID();

  try {
    const session = await startAppServer(client, {
      sessionId,
      binaryForArch,
      // The host outlives a dropped connection by design, but not for long:
      // nobody should discover a forgotten compositor on their VM next week.
      idleTimeoutSecs: 30 * 60,
      onProgress: (stage) => send(sessionId, `apps_progress_${sessionId}`, stage),
      onStderr: (line) => {
        console.warn(`[iwappd ${sessionId.slice(0, 8)}] ${line}`);
        send(sessionId, `apps_stderr_${sessionId}`, line);
      },
    });

    sessions.set(sessionId, {
      session,
      client,
      intermediates,
      webContents: new WeakRef(webContents),
    });

    session.onData((chunk) => {
      // A copy, because the renderer gets a structured clone and ssh2 reuses
      // its read buffers.
      send(sessionId, `apps_data_${sessionId}`, new Uint8Array(chunk));
    });
    session.onClose((code) => {
      send(sessionId, `apps_exit_${sessionId}`, code);
      closeSession(sessionId);
    });

    return { sessionId };
  } catch (err) {
    endSshChain(client, intermediates);
    throw err;
  }
}

function closeSession(sessionId: string): void {
  const record = sessions.get(sessionId);
  if (!record) return;
  sessions.delete(sessionId);
  try {
    record.session.close();
  } catch {
    /* already gone */
  }
  endSshChain(record.client, record.intermediates);
}

/**
 * The host's applications without opening a session — one exec that uploads,
 * lists and deletes. What the launcher paints first.
 */
async function listHostApps(config: SshShellConfig, iconSize?: number): Promise<unknown[]> {
  const { client, intermediates } = await connectSshChain(config);
  try {
    return await listApps(client, {
      binaryForArch,
      ...(iconSize !== undefined ? { iconSize } : {}),
    });
  } finally {
    endSshChain(client, intermediates);
  }
}

/**
 * What the host is missing, before anything is uploaded.
 *
 * Its own connection rather than the session's, because the whole point is to
 * answer on a host where starting a session would fail — no `gunzip` and the
 * staging step cannot even unpack the binary.
 */
async function preflightHost(config: SshShellConfig): Promise<HostRequirementsCheck> {
  const { client, intermediates } = await connectSshChain(config);
  try {
    return await checkHost(client);
  } finally {
    endSshChain(client, intermediates);
  }
}

/**
 * Install what the host is missing, streaming the package manager's output
 * back so the renderer can show it.
 *
 * The plan is rebuilt here from a fresh probe rather than taken from the
 * renderer: the renderer chooses *which* requirements to install, and the
 * commands that then run are ours. A renderer that could hand over a command
 * line would be an arbitrary-root-command channel wearing a helpful hat.
 */
async function installOnHost(
  webContents: WebContents,
  installId: string,
  config: SshShellConfig,
  include: RequirementId[] | undefined,
): Promise<InstallOutcome> {
  const { client, intermediates } = await connectSshChain(config);
  try {
    const preflight = await probeHost(client);
    const plan = planInstall(preflight, include ? { include } : {});
    if (!plan) return { log: [], failed: [], preflight };

    const emit = (line: string) => {
      if (!webContents.isDestroyed()) webContents.send(`apps_install_${installId}`, line);
    };
    for (const command of plan.commands) emit(`$ ${command}`);
    return await installRequirements(client, plan, { onOutput: emit });
  } finally {
    endSshChain(client, intermediates);
  }
}

export function registerIwappdHandlers(): void {
  ipcMain.handle("apps_session_open", (event, config: SshShellConfig) =>
    openSession(event.sender, config),
  );

  ipcMain.handle(
    "apps_session_write",
    (_event, { sessionId, data }: { sessionId: string; data: Uint8Array }) => {
      const record = sessions.get(sessionId);
      if (!record) return;
      record.session.write(Buffer.from(data));
    },
  );

  ipcMain.handle("apps_session_close", (_event, { sessionId }: { sessionId: string }) => {
    closeSession(sessionId);
  });

  ipcMain.handle(
    "apps_list",
    (_event, { config, iconSize }: { config: SshShellConfig; iconSize?: number }) =>
      listHostApps(config, iconSize),
  );

  ipcMain.handle("apps_preflight", (_event, { config }: { config: SshShellConfig }) =>
    preflightHost(config),
  );

  ipcMain.handle(
    "apps_install",
    (
      event,
      {
        config,
        installId,
        include,
      }: { config: SshShellConfig; installId: string; include?: RequirementId[] },
    ) => installOnHost(event.sender, installId, config, include),
  );
}

/** Close every session — called when the app quits. */
export function shutdownIwappdSessions(): void {
  for (const sessionId of [...sessions.keys()]) closeSession(sessionId);
}
