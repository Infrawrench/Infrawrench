/**
 * Server-side proxy for remote Linux application sessions.
 *
 * The browser cannot open a TCP connection, so it speaks the app protocol to
 * this endpoint over a WebSocket and the server holds the SSH connection. The
 * destination is resolved from the authenticated resource and the org's own SSH
 * key — the browser names an account, a resource and a key id, never a host —
 * and `resolveSafeHost` refuses internal address space before anything is
 * dialled, exactly as the SSH terminal proxy does.
 *
 * Everything above the connection is `@infrawrench/appstream-host`, shared with
 * the desktop app: the binary is staged in the host's RAM, unlinked, and
 * executed through the open descriptor, so nothing is left behind.
 */

import type { RawData, WebSocket } from "ws";
import { startAppServer, type AppServerSession } from "@infrawrench/appstream-host";

import { logAudit } from "@/services/audit";
import { getArm64GzBinary, getx86_64GzBinary } from "@/services/iwappd-binaries";
import { AppsKeyMissingError, connectAppsHost, type AppsClient } from "@/services/apps-host";

export interface AppsSessionParams {
  organizationId: string;
  userId?: string;
  accountId: string;
  resourceId: string;
  /** Org-managed key the host trusts. Its private half never leaves the server. */
  sshKeyId: string;
  host: string;
  username: string;
  port?: number;
}

const binaryForArch = (arch: "x86_64" | "aarch64") =>
  arch === "x86_64" ? getx86_64GzBinary() : getArm64GzBinary();

/**
 * Connect, start the app server, and relay frames until either end goes away.
 */
export async function handleAppsSession(ws: WebSocket, params: AppsSessionParams): Promise<void> {
  let client: AppsClient | undefined;
  let session: AppServerSession | undefined;

  const fail = (message: string) => {
    try {
      ws.close(1011, message.slice(0, 120));
    } catch {
      /* already closing */
    }
  };

  /**
   * Frames that arrive before the app server is up.
   *
   * The browser sends `hello` the instant the socket opens, while getting the
   * server running takes seconds — connect, stage a megabyte, exec. A listener
   * attached after that would miss the handshake entirely: `ws` drops messages
   * with no listener, so the client would wait for a `welcome` that never comes
   * and the host for a `hello` it never got. So listen immediately and hold
   * what arrives until there is somewhere to put it.
   */
  const queued: Buffer[] = [];
  ws.on("message", (data: RawData) => {
    const buffer = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    if (session) session.write(buffer);
    else queued.push(buffer);
  });

  // Registered here rather than after the session exists, which is seconds of
  // connecting, staging a megabyte and starting a process away. A browser that
  // goes away in that window — a reload, a closed tab — makes the socket emit
  // `error`, and a WebSocket with no error listener throws it, which on this
  // server means every other session dies with it. The SSH terminal proxy
  // registers its teardown before dialling for exactly this reason.
  let gone = false;
  const teardown = () => {
    gone = true;
    // Not guarded against running twice: both handles are safe to close
    // repeatedly, and the second call is what closes a session that did not
    // exist yet the first time.
    try {
      session?.close();
    } catch {
      /* already gone */
    }
    try {
      client?.end();
    } catch {
      /* already gone */
    }
  };
  ws.on("close", teardown);
  ws.on("error", teardown);

  try {
    client = await connectAppsHost({
      organizationId: params.organizationId,
      sshKeyId: params.sshKeyId,
      host: params.host,
      username: params.username,
      ...(params.port !== undefined ? { port: params.port } : {}),
    });

    session = await startAppServer(client, {
      sessionId: `${params.organizationId}-${params.resourceId}`.slice(0, 48),
      binaryForArch,
      idleTimeoutSecs: 30 * 60,
      onStderr: (line) => console.warn(`[apps ${params.resourceId}] ${line}`),
    });

    // A graphical session is not captured by SSH session recording, so the
    // audit entry is the only record that it happened.
    await logAudit({
      organizationId: params.organizationId,
      ...(params.userId ? { userId: params.userId } : {}),
      action: "linux_app.session_start",
      entityType: "resource",
      entityId: params.resourceId,
      metadata: { accountId: params.accountId, host: params.host },
    });

    // Anything the client sent while the server was starting — the handshake,
    // and whatever followed it — goes in now, in order.
    for (const buffer of queued.splice(0)) session.write(buffer);

    session.onData((chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    session.onClose(() => {
      try {
        ws.close(1000, "app server exited");
      } catch {
        /* already closing */
      }
    });
  } catch (error) {
    const message =
      error instanceof AppsKeyMissingError
        ? "ssh key not found"
        : error instanceof Error
          ? error.message
          : String(error);
    console.warn(`[apps] session setup failed: ${message}`);
    fail(message);
    teardown();
  }

  // The browser left while the host was still starting: everything above
  // succeeded into a session nobody is watching, so end it rather than leave an
  // app server running on someone's machine until its idle timeout.
  if (gone) teardown();
}
