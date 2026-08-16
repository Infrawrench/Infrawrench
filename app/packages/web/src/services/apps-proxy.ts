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

import ssh2 from "ssh2";
import type { RawData, WebSocket } from "ws";
import { and, eq } from "drizzle-orm";
import { startAppServer, type AppServerSession } from "@infrawrench/appstream-host";

import { db } from "@/db/client";
import { sshKeys } from "@/db/schema";
import { buildAad, decrypt } from "@/services/encryption";
import { resolveSafeHost } from "@/services/host-validation";
import { HostKeyTrustRequiredError, makeHostKeyVerifier } from "@/services/ssh-host-keys";
import { logAudit } from "@/services/audit";
import { getArm64GzBinary, getx86_64GzBinary } from "@/services/iwappd-binaries";

const { Client } = ssh2;
type Client = InstanceType<typeof Client>;

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
  let client: Client | undefined;
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

  try {
    const [key] = await db
      .select()
      .from(sshKeys)
      .where(
        and(eq(sshKeys.id, params.sshKeyId), eq(sshKeys.organizationId, params.organizationId)),
      );
    if (!key?.encryptedPrivateKey || !key.privateKeyIv) {
      fail("ssh key not found");
      return;
    }

    // The host comes off the resource the caller named, but it is still a value
    // the provider reported, so it goes through the same check the terminal
    // uses. Dial the address that cleared rather than the name, or a
    // short-TTL record can answer the check and the connect differently.
    const dialAddress = await resolveSafeHost(params.host);
    const privateKey = await decrypt(
      key.encryptedPrivateKey,
      key.privateKeyIv,
      buildAad("sshKey", key.id, "privateKey"),
    );

    const hostKeyError: { value: HostKeyTrustRequiredError | null } = { value: null };
    client = await connect({
      host: dialAddress,
      port: params.port ?? 22,
      username: params.username,
      privateKey,
      organizationId: params.organizationId,
      configuredHost: params.host,
      hostKeyError,
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
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[apps] session setup failed: ${message}`);
    fail(message);
  } finally {
    const teardown = () => {
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
  }
}

function connect(options: {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  organizationId: string;
  /** The name the resource reported, which is what the host key is pinned against. */
  configuredHost: string;
  /** Filled in by the verifier when the host key is new or has changed. */
  hostKeyError: { value: HostKeyTrustRequiredError | null };
}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", (error) =>
      // A changed host key surfaces as a generic handshake failure otherwise,
      // and "the key changed" is the one SSH error a user must actually read.
      reject(options.hostKeyError.value ?? error),
    );
    client.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      privateKey: options.privateKey,
      // Trust-on-first-use against the org's pin store, same as the terminal:
      // a session that skipped this would be the one place a changed host key
      // goes unnoticed.
      hostVerifier: makeHostKeyVerifier(
        options.organizationId,
        options.configuredHost,
        options.port,
        options.hostKeyError,
        "apps",
      ),
      readyTimeout: 30_000,
    });
  });
}
