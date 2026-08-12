/**
 * Server-side SSH terminal proxy.
 * Connects to user infrastructure via ssh2, streams I/O over WebSocket.
 */
import { randomUUID } from "node:crypto";

import ssh2 from "ssh2";
import type { WebSocket } from "ws";

const { Client } = ssh2;
// Re-establish the class's dual value/type nature lost by destructuring.
type Client = InstanceType<typeof Client>;
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, sshKeys } from "@/db/schema";
import { decrypt, buildAad } from "@/services/encryption";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";
import { buildInProcessAgent, type AgentAuditContext } from "@/services/ssh-agent";
import { logAudit } from "@/services/audit";
import { HostKeyTrustRequiredError, makeHostKeyVerifier } from "@/services/ssh-host-keys";
import { resolveSafeHost } from "@/services/host-validation";
import { makeWsBackpressure, type WsBackpressure } from "@/services/ws-backpressure";
import {
  startSessionRecording,
  type SessionRecorder,
} from "@infrawrench/server-core/ssh-recording/recorder";
import { forwardOutHop, resolveSshChain, type SshHop } from "@infrawrench/plugin-ssh";
import { sharedConsoleHub } from "@/services/shared-console/hub";

interface DirectSshParams {
  sshKeyId: string;
  host: string;
  username: string;
  /** Optional jumpbox SSH account id to route this direct connection through. */
  connectThroughAccountId?: string;
}

/**
 * Load an SSH account's credentials and return them shaped for the chain
 * resolver. Throws if the account is missing or not an SSH plugin account.
 */
async function loadSshAccountForChain(
  accountIdToLoad: string,
  organizationId: string,
): Promise<{
  host: string;
  port: number;
  username: string;
  privateKey: string;
  connectThroughAccountId?: string;
}> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountIdToLoad), eq(accounts.organizationId, organizationId)));

  if (!account) {
    throw new Error(`SSH jumpbox account ${accountIdToLoad} not found`);
  }
  if (account.pluginId !== "ssh") {
    throw new Error(
      `SSH jumpbox chain hop ${accountIdToLoad} is not an SSH account (plugin=${account.pluginId})`,
    );
  }

  const plaintext = await decrypt(
    account.encryptedCredentials,
    account.credentialsIv,
    buildAad("account", account.id, "credentials"),
  );
  const credentials = JSON.parse(plaintext) as Record<string, string>;
  const through = credentials.connectThroughAccountId;
  return {
    host: credentials.host ?? "",
    port: Number(credentials.port ?? 22) || 22,
    username: credentials.username ?? "root",
    privateKey: credentials.privateKey ?? "",
    ...(through ? { connectThroughAccountId: through } : {}),
  };
}

export async function handleSshSession(
  ws: WebSocket,
  organizationId: string,
  accountId: string,
  resourceId?: string,
  directSsh?: DirectSshParams,
  cols?: number,
  rows?: number,
  agentForward?: boolean,
  userId?: string,
  /**
   * Opaque affinity hint the browser minted and put in its own `?sid=`.
   * Recorded on the share so a joiner can ask the ingress for the same
   * backend; see `services/shared-console/hub.ts`. Never used as authority.
   */
  routingKey?: string,
): Promise<void> {
  // Hoisted so the outer catch can tear down anything opened before a throw.
  let cleanup: () => void = () => {};
  try {
    let targetConfig: { host: string; port: number; username: string; privateKey: string };
    let connectThroughAccountId: string | undefined;
    /**
     * The vetted IP the final socket goes to, set only on the one path the
     * server dials on a client's say-so. Undefined everywhere else — a
     * bastion-routed session reaches its target over `sock`, and a
     * plugin-supplied endpoint is not client-chosen — and `dialFinal` then
     * falls back to the configured host as before.
     */
    let targetDialAddress: string | undefined;

    if (directSsh) {
      // Direct SSH via SSH key — used for sshHost resources (EC2, droplets, etc.)
      const [key] = await db
        .select()
        .from(sshKeys)
        .where(and(eq(sshKeys.id, directSsh.sshKeyId), eq(sshKeys.organizationId, organizationId)));

      if (!key || !key.encryptedPrivateKey || !key.privateKeyIv) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "SSH key not found" }));
        return;
      }

      // `host` comes straight off the WebSocket frame, so this is the one
      // place a caller picks the destination outright. Refuse internal address
      // space for the same reason the tunnel routes do — without it the server
      // will happily dial 127.0.0.1 or the cloud metadata endpoint on request.
      // Skipped when jumping through a bastion: the whole point of a jump host
      // is to reach hosts that are private from where we sit.
      //
      // Keep the address that cleared, and dial *that*. Validating the name
      // and then handing the same name to ssh2 leaves it to resolve a second
      // time, which is a rebinding window: a short-TTL record answers the
      // check with a public address and the connect with 169.254.169.254.
      if (!directSsh.connectThroughAccountId) {
        targetDialAddress = await resolveSafeHost(directSsh.host);
      }

      const privateKey = await decrypt(
        key.encryptedPrivateKey,
        key.privateKeyIv,
        buildAad("sshKey", key.id, "privateKey"),
      );
      targetConfig = {
        host: directSsh.host,
        port: 22,
        username: directSsh.username,
        privateKey,
      };
      connectThroughAccountId = directSsh.connectThroughAccountId;
    } else {
      // Plugin-provided SSH config
      const [account] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));

      if (!account) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "Account not found" }));
        return;
      }

      const plaintext = await decrypt(
        account.encryptedCredentials,
        account.credentialsIv,
        buildAad("account", account.id, "credentials"),
      );
      const credentials = JSON.parse(plaintext) as Record<string, string>;

      const loaded = await getPlugin(account.pluginId);
      if (!loaded) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "Plugin not found" }));
        return;
      }

      const hostServices = await buildPluginHostServices(loaded.plugin.manifest, credentials, {
        accountId: account.id,
      });
      const client = loaded.plugin.createClient(credentials, hostServices);
      const pluginSshConfig = client.getSshConfig?.();
      if (!pluginSshConfig) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "Plugin does not support SSH" }));
        return;
      }
      targetConfig = pluginSshConfig;
      // Only SSH plugin accounts can declare a jump chain.
      if (account.pluginId === "ssh") {
        connectThroughAccountId = credentials.connectThroughAccountId || undefined;
      }
    }

    // Resolve the full hop list. When there's no jumpbox the chain is a single hop.
    let hops: SshHop[];
    if (connectThroughAccountId) {
      const upstream = await resolveSshChain(connectThroughAccountId, (id) =>
        loadSshAccountForChain(id, organizationId),
      );
      hops = [...upstream, targetConfig];
    } else {
      hops = [targetConfig];
    }

    const finalConfig = hops[hops.length - 1]!;
    const intermediates: Client[] = [];
    const conn = new Client();
    let shellStream: import("ssh2").ClientChannel | null = null;
    let backpressure: WsBackpressure | null = null;
    let torndown = false;
    /**
     * The session-recording tee, when the org has recording enabled. Null in
     * every other case — opted out, settings unreadable, opening write failed —
     * so there is exactly one branch here and no way for a broken recorder to
     * be mistaken for a working one. Nothing on this object throws, and nothing
     * on the terminal's path awaits it.
     */
    let recorder: SessionRecorder | null = null;
    /**
     * This session's key in the process-local console registry.
     *
     * Minted here, for every session, whether or not it is ever shared:
     * registering unconditionally is what lets somebody share a session that
     * is already twenty minutes old without the pty having to know in advance
     * that it might be.
     */
    const liveConsoleId = randomUUID();
    let registered = false;

    /** Idempotent teardown of everything opened so far (shell, hops, final conn). */
    cleanup = () => {
      if (torndown) return;
      torndown = true;
      if (registered) {
        registered = false;
        // Detaches every guest and settles the share as `ended`. Before the
        // recorder is finished, so the closing marker lands on the tape.
        sharedConsoleHub.unregister(liveConsoleId);
      }
      // Fire-and-forget: `finish` flushes the tail and settles the row, and the
      // terminal's teardown must not wait on a database write. A recording
      // whose closing write is lost is settled by the retention pass instead.
      void recorder?.finish();
      recorder = null;
      backpressure?.dispose();
      const endConnections = () => {
        for (const c of intermediates) {
          try {
            c.end();
          } catch {
            /* ignore */
          }
        }
        try {
          conn.end();
        } catch {
          /* ignore */
        }
      };
      if (!shellStream) {
        endConnections();
        return;
      }
      // With compression negotiated, ending the connection while the channel
      // is still finalizing makes ssh2 compress the channel-close packet
      // through already-destroyed zlib writers — an uncaught "Invalid Zlib
      // instance" throw on a later tick that would take the process down.
      // End the channel first, and close the connections only after its
      // "close" has fired AND its remaining teardown ticks (readable-end →
      // destroy) have drained — hence the extra deferral.
      let ended = false;
      const endOnce = () => {
        if (ended) return;
        ended = true;
        setTimeout(endConnections, 100).unref();
      };
      shellStream.once("close", endOnce);
      try {
        shellStream.end();
      } catch {
        /* ignore */
      }
      // Fallback for wedged connections where "close" never fires.
      setTimeout(endOnce, 3000).unref();
    };

    // Registered BEFORE dialing: if the browser goes away mid-connect (or
    // mid-chain-establishment) we tear down whatever exists at that point —
    // the shell may not be open yet (or ever).
    ws.on("close", cleanup);
    ws.on("error", cleanup);

    const sendJson = (frame: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(frame));
      }
    };

    const sendError = (err: unknown) => {
      if (err instanceof HostKeyTrustRequiredError) {
        // Structured frame so the client can distinguish an untrusted/changed
        // host key from a generic failure (mirrors hostKeyTrustResponse's 409).
        sendJson({
          type: "ssh:error",
          error: err.message,
          code: "ssh_host_key_trust_required",
          kind: err.kind,
          host: err.host,
          port: err.port,
          presentedFingerprint: err.presentedFingerprint,
          storedFingerprint: err.storedFingerprint,
        });
        return;
      }
      sendJson({ type: "ssh:error", error: err instanceof Error ? err.message : String(err) });
    };

    const openShell = () => {
      conn.shell({ term: "xterm-256color", cols: cols ?? 80, rows: rows ?? 24 }, (err, stream) => {
        if (err) {
          sendError(err);
          cleanup();
          return;
        }
        if (torndown || ws.readyState !== ws.OPEN) {
          // ws closed while the shell was opening — discard it.
          try {
            stream.end();
          } catch {
            /* ignore */
          }
          cleanup();
          return;
        }

        shellStream = stream;
        backpressure = makeWsBackpressure(ws, {
          pause: () => {
            stream.pause();
            stream.stderr.pause();
          },
          resume: () => {
            stream.resume();
            stream.stderr.resume();
          },
        });

        // Registered before the first byte, and unconditionally: the console
        // is now shareable, and a session that could only be shared if the
        // sharer had decided so at connect time would be useless — the moment
        // you want a second pair of eyes is never the moment you opened the
        // shell.
        sharedConsoleHub.register(
          liveConsoleId,
          {
            organizationId,
            ownerUserId: userId,
            // Read by the create-share route rather than taken from the
            // request body: what box this session is on is a fact the proxy
            // knows and the browser only believes.
            accountId,
            resourceId,
            host: finalConfig.host,
            port: finalConfig.port ?? 22,
            username: finalConfig.username,
            write: (data) => stream.write(data),
            resize: (c, r) => stream.setWindow(r, c, 0, 0),
            recorder: () => recorder,
            close: cleanup,
            sendToOwner: (frame) => sendJson(frame),
          },
          cols ?? 80,
          rows ?? 24,
        );
        registered = true;

        // `liveConsoleId` is what `POST /shared-consoles` names to bind a share
        // to this pty, and `routingKey` is what a joiner puts in their own
        // `?sid=` so the ingress hashes them onto this replica.
        sendJson({
          type: "ssh:connected",
          liveConsoleId,
          ...(routingKey ? { routingKey } : {}),
        });

        // The tee is second in each handler on purpose: the operator's byte
        // reaches the browser before we spend anything recording it. The
        // fan-out to any guests is third, for the same reason: the person
        // typing is served before the people watching.
        stream.on("data", (data: Buffer) => {
          sendJson({ type: "ssh:data", data: data.toString("base64") });
          recorder?.onOutput(data);
          sharedConsoleHub.broadcastOutput(liveConsoleId, data);
          backpressure?.check();
        });

        stream.stderr.on("data", (data: Buffer) => {
          sendJson({ type: "ssh:data", data: data.toString("base64") });
          recorder?.onOutput(data);
          sharedConsoleHub.broadcastOutput(liveConsoleId, data);
          backpressure?.check();
        });

        stream.on("close", () => {
          sendJson({ type: "ssh:closed" });
          cleanup();
        });

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString()) as {
              type: string;
              data?: string;
              cols?: number;
              rows?: number;
            };

            if (msg.type === "ssh:data" && msg.data) {
              // Unshared: always true, and this is the pre-existing path. Once
              // shared, the owner types only while they are the driver — the
              // same server-side gate their guests go through, because "the
              // person who opened the session" is not a role that exempts
              // anyone from the one-driver rule they agreed to.
              if (!sharedConsoleHub.ownerMayWrite(liveConsoleId)) return;
              const input = Buffer.from(msg.data, "base64");
              stream.write(input);
              // No-op unless the org opted into input capture specifically —
              // see the note on `capture_input` in the schema.
              recorder?.onInput(input);
            } else if (msg.type === "ssh:resize" && msg.cols && msg.rows) {
              // A pty has one size and it is the driver's. An owner who has
              // handed the keyboard over letterboxes like everybody else
              // rather than resizing the window out from under the driver —
              // but their window size is still recorded, so taking the
              // keyboard back resizes to what they can actually read.
              sharedConsoleHub.noteOwnerViewport(liveConsoleId, msg.cols, msg.rows);
              if (!sharedConsoleHub.ownerMayResize(liveConsoleId)) return;
              stream.setWindow(msg.rows, msg.cols, 0, 0);
              recorder?.onResize(msg.cols, msg.rows);
              sharedConsoleHub.notePtySize(liveConsoleId, msg.cols, msg.rows);
            } else if (msg.type === "console:viewport" && msg.cols && msg.rows) {
              // The letterboxed owner reporting the size their window *would*
              // fit, without asking for it.
              sharedConsoleHub.noteOwnerViewport(liveConsoleId, msg.cols, msg.rows);
            }
          } catch {
            /* ignore malformed messages */
          }
        });
      });
    };

    conn.on("ready", () => {
      if (torndown) {
        // ws closed while the handshake was completing — drop the connection.
        try {
          conn.end();
        } catch {
          /* ignore */
        }
        return;
      }
      // The recorder opens *before* the shell rather than alongside it, so the
      // cast starts at the first byte the host emits — a prompt or a MOTD that
      // arrived while an insert was still in flight would otherwise be missing
      // from the top of the tape. It costs one round-trip, and only when the
      // org has recording on (the settings read short-circuits otherwise).
      void (async () => {
        recorder = await startSessionRecording({
          organizationId,
          userId,
          accountId,
          resourceId,
          host: finalConfig.host,
          port: finalConfig.port ?? 22,
          username: finalConfig.username,
          hopCount: hops.length,
          cols,
          rows,
        });
        if (torndown) {
          // ws closed while the recording was opening — settle the empty row.
          const opened = recorder;
          recorder = null;
          await opened?.finish();
          try {
            conn.end();
          } catch {
            /* ignore */
          }
          return;
        }
        openShell();
      })();
    });

    const hostKeyErrorRef = { value: null as HostKeyTrustRequiredError | null };
    conn.on("error", (err) => {
      // A verifier rejection surfaces as a generic ssh2 connect error — report
      // the typed host-key error instead when that's what aborted us.
      sendError(hostKeyErrorRef.value ?? err);
      cleanup();
    });

    const auditContext: AgentAuditContext | undefined = agentForward
      ? {
          organizationId,
          userId,
          accountId,
          resourceId,
          sshKeyId: directSsh?.sshKeyId ?? "",
          sshHost: finalConfig.host,
          sshUsername: finalConfig.username,
        }
      : undefined;
    const forwardAgent = agentForward
      ? buildInProcessAgent(finalConfig.privateKey, auditContext)
      : null;
    if (agentForward && !forwardAgent) {
      ws.send(
        JSON.stringify({
          type: "ssh:error",
          error: "Agent forwarding requested but the SSH key could not be parsed.",
        }),
      );
      return;
    }
    if (forwardAgent && auditContext) {
      void logAudit({
        organizationId: auditContext.organizationId,
        userId: auditContext.userId,
        action: "ssh.agent.session_opened",
        entityType: "ssh-session",
        entityId: auditContext.accountId,
        metadata: {
          sshKeyId: auditContext.sshKeyId,
          sshHost: auditContext.sshHost,
          sshUsername: auditContext.sshUsername,
          ...(auditContext.resourceId ? { resourceId: auditContext.resourceId } : {}),
          ...(hops.length > 1 ? { hopCount: hops.length } : {}),
        },
      });
    }

    // Every session, not just the agent-forwarded and jump-chained ones.
    //
    // Those two events predate this and are about *how* a session was set up;
    // neither fires for the ordinary case of someone opening a terminal with an
    // org SSH key, which left the audit log unable to answer "when was this key
    // last used". That question is the whole basis of the credential-hygiene
    // report, and a report built on partial evidence would confidently call a
    // key unused because nobody had agent-forwarded with it.
    if (directSsh?.sshKeyId) {
      void logAudit({
        organizationId,
        userId,
        action: "ssh.session.opened",
        entityType: "ssh-session",
        entityId: accountId,
        metadata: {
          sshKeyId: directSsh.sshKeyId,
          sshHost: finalConfig.host,
          sshUsername: finalConfig.username,
          ...(resourceId ? { resourceId } : {}),
          ...(hops.length > 1 ? { hopCount: hops.length } : {}),
        },
      });
    }

    if (hops.length > 1) {
      void logAudit({
        organizationId,
        userId,
        action: "ssh.session.chain_opened",
        entityType: "ssh-session",
        entityId: accountId,
        metadata: {
          hopCount: hops.length,
          hops: hops.map((h, i) => ({
            index: i,
            host: h.host,
            port: h.port,
            username: h.username,
          })),
          ...(resourceId ? { resourceId } : {}),
        },
      });
    }

    // Open each intermediate hop, then dial the final target on `conn`.
    // ssh2's ConnectConfig types `sock` as Node's `Readable`, but the
    // `forwardOut` stream is in fact a full duplex — cast accordingly.
    type SshSock = import("stream").Readable;
    const dialFinal = (sock?: SshSock) => {
      if (torndown) return;
      conn.connect({
        // `targetDialAddress` is only ever set on the single-hop path, where
        // `finalConfig` *is* the target that was vetted; a chained session
        // arrives here with a `sock` and no address to pin.
        ...(sock
          ? { sock }
          : { host: targetDialAddress ?? finalConfig.host, port: finalConfig.port ?? 22 }),
        username: finalConfig.username,
        privateKey: finalConfig.privateKey,
        // Identity, not transport: the verifier is passed the hostname the
        // user connected to so `ssh_host_keys` rows stay keyed by name. Pin
        // against the IP instead and every trusted host asks to be trusted
        // again, and would go on doing so each time the address changed.
        hostVerifier: makeHostKeyVerifier(
          organizationId,
          finalConfig.host,
          finalConfig.port ?? 22,
          hostKeyErrorRef,
          "ssh-proxy",
        ),
        ...(forwardAgent ? { agent: forwardAgent, agentForward: true } : {}),
        // TUI apps redraw whole screen regions constantly and that text
        // compresses extremely well — the `ssh -C` equivalent.
        algorithms: { compress: ["zlib@openssh.com", "zlib", "none"] },
      });
    };

    if (hops.length === 1) {
      dialFinal();
    } else {
      // No address pinning anywhere in here, deliberately. Every hop after the
      // first is dialed *through* the previous one over `sock`, so this
      // process never resolves it — and the first hop's endpoint comes from a
      // stored SSH account written by someone with `accounts:write`, not from
      // the WebSocket frame, and is routinely a private address an operator
      // configured on purpose. Guarding it would break the documented reason
      // jump hosts exist without closing a window a member can open.
      try {
        let prev: Client | null = null;
        for (let i = 0; i < hops.length - 1; i++) {
          if (torndown) throw new Error("SSH session closed before the connection completed");
          const hop = hops[i]!;
          const client = new Client();
          intermediates.push(client);
          const sockForThis = prev
            ? ((await forwardOutHop(prev, hop.host, hop.port)) as SshSock)
            : undefined;
          const hopKeyErrorRef = { value: null as HostKeyTrustRequiredError | null };
          await new Promise<void>((resolve, reject) => {
            client.once("ready", () => resolve());
            client.on("error", (err) =>
              reject(hopKeyErrorRef.value ?? (err instanceof Error ? err : new Error(String(err)))),
            );
            // `end()` from a concurrent ws-close teardown emits "close"
            // without "error" — settle the promise so we don't hang.
            client.once("close", () =>
              reject(new Error("SSH connection closed while establishing the jump chain")),
            );
            client.connect({
              ...(sockForThis ? { sock: sockForThis } : { host: hop.host, port: hop.port ?? 22 }),
              username: hop.username,
              privateKey: hop.privateKey,
              hostVerifier: makeHostKeyVerifier(
                organizationId,
                hop.host,
                hop.port ?? 22,
                hopKeyErrorRef,
                "ssh-proxy",
              ),
            });
          });
          prev = client;
        }
        if (torndown) throw new Error("SSH session closed before the connection completed");
        const finalSock = (await forwardOutHop(
          prev!,
          finalConfig.host,
          finalConfig.port ?? 22,
        )) as SshSock;
        dialFinal(finalSock);
      } catch (err) {
        sendError(err);
        cleanup();
        return;
      }
    }
  } catch (e) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "ssh:error",
          error: e instanceof Error ? e.message : "Unknown SSH error",
        }),
      );
    }
    cleanup();
  }
}
