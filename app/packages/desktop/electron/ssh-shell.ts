import * as crypto from "node:crypto";
import type { Readable } from "node:stream";
import { Client as SshClient } from "ssh2";
import type { ClientChannel } from "ssh2";
import { type Cause, Context, Effect, Layer, Queue, Stream } from "effect";
import { errorMessage } from "../shared/rpc/errors";
import { SshError, type SshShellConfig } from "../shared/rpc/groups/ssh-common";
import type { SshShellEvent } from "../shared/rpc/groups/ssh-shell";
import { forwardOutHop } from "@infrawrench/ssh-tunnel-core/chain";
import { CLOUD_KEY_SENTINEL, ONEPASSWORD_SENTINEL, PAGEANT_SENTINEL } from "./ssh-agent";
import { get1PasswordAgentPath } from "./onepassword-agent";
import { buildInProcessAgent } from "./ssh-shell-agent";
// Type only: the cloud-key agent pulls in the cloud session (and its IPC
// registrations), so it is loaded on first use, not with the RPC server.
import type { buildCloudKeyAgent } from "./cloud-key-agent";
import {
  ensureHostKeyCacheLoaded,
  verifyOrPinHostKeyInteractive,
  HostKeyMismatchError,
} from "./ssh-host-keys";

export type { SshShellConfig };

/**
 * Open one hop. The hop is dialled either directly (when `sock` is undefined)
 * or through an existing chain via `sock`. Returns the ready client. Each hop
 * gets its own TOFU host-key check.
 */
type ForwardAgent =
  ReturnType<typeof buildInProcessAgent> | ReturnType<typeof buildCloudKeyAgent> | string | null;

function connectOneHop(opts: {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  sock?: Readable;
  agent?: ForwardAgent;
  agentForward?: boolean;
}): Promise<SshClient> {
  const client = new SshClient();
  let hostKeyError: HostKeyMismatchError | null = null;
  const useAgentForAuth =
    opts.privateKey === PAGEANT_SENTINEL ||
    opts.privateKey === ONEPASSWORD_SENTINEL ||
    opts.privateKey === CLOUD_KEY_SENTINEL;
  return new Promise((resolve, reject) => {
    client.once("ready", () => resolve(client));
    client.once("error", (err) => {
      if (hostKeyError) reject(hostKeyError);
      else reject(new Error(`SSH error: ${err.message}`));
    });
    client.connect({
      ...(opts.sock ? { sock: opts.sock } : { host: opts.host, port: opts.port }),
      username: opts.username,
      ...(useAgentForAuth ? {} : { privateKey: opts.privateKey }),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.agentForward ? { agentForward: true } : {}),
      // TUI apps redraw whole screen regions constantly and that text
      // compresses extremely well: the `ssh -C` equivalent. Prefer
      // zlib@openssh.com (compression only after auth) and fall back to
      // uncompressed when the server doesn't offer it.
      algorithms: { compress: ["zlib@openssh.com", "zlib", "none"] },
      hostVerifier: (hostKey: Buffer, verify: (matches: boolean) => void) => {
        verifyOrPinHostKeyInteractive(opts.host, opts.port, hostKey).then(
          (result) => {
            if (!result.ok) {
              console.error(
                `[ssh-shell] host key rejected for ${result.error.host}:${result.error.port} ` +
                  `(stored=${result.error.storedFingerprint}, presented=${result.error.presentedFingerprint})`,
              );
              hostKeyError = result.error;
              verify(false);
              return;
            }
            verify(true);
          },
          (err) => {
            console.error("[ssh-shell] host-key verification error:", err);
            verify(false);
          },
        );
      },
    });
  });
}

/**
 * Dial the whole chain (jump hops in order, then the target) and hand back
 * the connected client plus the intermediates the caller must close with it.
 *
 * Shared with the Linux app server (`iwappd-host.ts`), which needs exactly this
 * connection and then execs on it instead of opening a shell. Agent selection,
 * forwarding and the per-hop TOFU host-key check all live here so the two
 * cannot drift apart.
 */
export async function connectSshChain(
  config: SshShellConfig,
): Promise<{ client: SshClient; intermediates: SshClient[] }> {
  await ensureHostKeyCacheLoaded();

  // When the user picked an external agent (Pageant / 1Password) we route both
  // auth and (optionally) forwarding through it. For PEM-key auth, forwarding
  // happens via our in-process agent. Agent forwarding only applies to the
  // final hop: intermediate hops never see the agent.
  let connectAgent: ForwardAgent = null;
  if (config.privateKey === CLOUD_KEY_SENTINEL) {
    if (!config.cloudKey) {
      throw new Error("A cloud SSH key was selected but the config does not say which one.");
    }
    const { buildCloudKeyAgent } = await import("./cloud-key-agent");
    connectAgent = buildCloudKeyAgent(config.cloudKey, {
      host: config.host,
      username: config.username,
    });
    console.log(
      `[ssh-shell] auth via Infrawrench Cloud signing agent (key ${config.cloudKey.sshKeyId})`,
    );
  } else if (config.privateKey === PAGEANT_SENTINEL) {
    connectAgent = "pageant";
  } else if (config.privateKey === ONEPASSWORD_SENTINEL) {
    const sock = get1PasswordAgentPath();
    if (!sock) {
      throw new Error(
        "1Password SSH agent was selected but the agent socket could not be found. Enable the SSH agent in 1Password's Developer settings.",
      );
    }
    connectAgent = sock;
    if (config.agentForward) console.log("[ssh-shell] agent forwarding: 1Password");
  } else if (config.agentForward) {
    connectAgent = buildInProcessAgent(config.privateKey);
    if (!connectAgent) {
      throw new Error(
        "Agent forwarding requested but the selected SSH key could not be loaded into Infrawrench's in-process agent.",
      );
    }
    const inProc = connectAgent;
    if (typeof inProc !== "string") {
      console.log(
        `[ssh-shell] agent forwarding: in-process (${inProc.keyCount} key${
          inProc.keyCount === 1 ? "" : "s"
        })`,
      );
    }
  }

  // Dial intermediate hops first, chaining each through the previous.
  const intermediates: SshClient[] = [];
  let prev: SshClient | null = null;
  try {
    for (const hop of config.jumpHops ?? []) {
      const sock = prev ? ((await forwardOutHop(prev, hop.host, hop.port)) as Readable) : undefined;
      const c = await connectOneHop({
        host: hop.host,
        port: hop.port,
        username: hop.username,
        privateKey: hop.privateKey,
        ...(sock ? { sock } : {}),
      });
      intermediates.push(c);
      prev = c;
    }
  } catch (err) {
    for (const c of intermediates) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  // Dial the final target.
  let client: SshClient;
  try {
    const finalSock = prev
      ? ((await forwardOutHop(prev, config.host, config.port)) as Readable)
      : undefined;
    client = await connectOneHop({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      ...(finalSock ? { sock: finalSock } : {}),
      agent: connectAgent,
      agentForward: !!config.agentForward,
    });
  } catch (err) {
    for (const c of intermediates) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  return { client, intermediates };
}

/** Close a chain, innermost first. Safe to call more than once. */
export function endSshChain(client: SshClient, intermediates: SshClient[]): void {
  try {
    client.end();
  } catch {
    /* already gone */
  }
  for (const c of intermediates) {
    try {
      c.end();
    } catch {
      /* already gone */
    }
  }
}

const toSshError = (cause: unknown) => new SshError({ message: errorMessage(cause) });

/**
 * The whole chain as a scoped resource: dialled on acquire, every hop ended
 * (innermost first) when the scope closes.
 */
export const acquireSshChain = (config: SshShellConfig) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => connectSshChain(config), catch: toSshError }),
    ({ client, intermediates }) => Effect.sync(() => endSshChain(client, intermediates)),
  );

/**
 * How long a closing shell gets to finish its channel teardown before the
 * connection is ended. With compression negotiated, ending the client inside
 * the channel's "close" event destroys the zlib writers before the channel's
 * readable-end tick writes its final packet, which crashes ssh2 with an
 * uncaught "Invalid Zlib instance".
 */
const CHANNEL_TEARDOWN_MS = 100;
/** A wedged connection whose channel never reports "close" is ended after this. */
const CHANNEL_CLOSE_TIMEOUT_MS = 3_000;

interface ShellRecord {
  readonly channel: ClientChannel;
  readonly client: SshClient;
  /** The RPC client (renderer connection) that opened it; only it may write. */
  readonly owner: number;
}

const shells = new Map<string, ShellRecord>();

/**
 * Open the PTY on a connected client as a scoped resource. `Opened` goes
 * into `output` before any data can, and the channel's listeners are
 * attached in ssh2's callback itself, so nothing the shell prints first is
 * lost. Releasing it ends the channel, waits for its "close", then lets the
 * teardown ticks run before the chain's own release ends the connection.
 */
const acquireShell = (
  client: SshClient,
  config: SshShellConfig,
  owner: number,
  output: Queue.Queue<SshShellEvent, SshError | Cause.Done>,
) => {
  let closed = false;
  const shellId = crypto.randomUUID();
  return Effect.acquireRelease(
    Effect.callback<ClientChannel, SshError>((resume) => {
      client.shell(
        { term: "xterm-256color", cols: config.cols, rows: config.rows },
        (err, channel) => {
          if (err) {
            resume(Effect.fail(toSshError(err)));
            return;
          }
          shells.set(shellId, { channel, client, owner });
          Queue.offerUnsafe(output, { _tag: "Opened", shellId });
          const send = (data: Buffer | string) => {
            Queue.offerUnsafe(output, {
              _tag: "Data",
              data: typeof data === "string" ? Buffer.from(data, "utf8") : data,
            });
          };
          channel.on("data", send);
          channel.stderr?.on("data", send);
          channel.once("close", () => {
            closed = true;
            shells.delete(shellId);
            Queue.endUnsafe(output);
          });
          resume(Effect.succeed(channel));
        },
      );
    }),
    (channel) =>
      Effect.gen(function* () {
        shells.delete(shellId);
        if (!closed) {
          yield* Effect.callback<void>((resume) => {
            channel.once("close", () => resume(Effect.void));
            try {
              channel.end();
            } catch {
              resume(Effect.void);
            }
          }).pipe(Effect.timeoutOption(CHANNEL_CLOSE_TIMEOUT_MS));
        }
        yield* Effect.sleep(CHANNEL_TEARDOWN_MS);
      }),
  );
};

/**
 * Interactive shells. A shell is a stream: subscribing dials the chain and
 * opens the PTY, the shell's output flows until it exits, and the stream's
 * scope owns the channel and every hop, so interrupting the stream (the
 * terminal closing, the renderer reloading or going away) is what ends them.
 */
export class SshShells extends Context.Service<
  SshShells,
  {
    readonly open: (
      config: SshShellConfig,
      owner: number,
    ) => Stream.Stream<SshShellEvent, SshError>;
    readonly write: (shellId: string, owner: number, data: string) => Effect.Effect<void>;
    readonly resize: (
      shellId: string,
      owner: number,
      cols: number,
      rows: number,
    ) => Effect.Effect<void>;
  }
>()("infrawrench/desktop/SshShells") {
  static readonly layer = Layer.succeed(SshShells)(
    SshShells.of({
      open: (config, owner) =>
        Stream.callback<SshShellEvent, SshError>((output) =>
          Effect.gen(function* () {
            const { client } = yield* acquireSshChain(config);
            yield* acquireShell(client, config, owner, output);
          }),
        ),
      write: (shellId, owner, data) =>
        Effect.sync(() => {
          const shell = shells.get(shellId);
          if (shell?.owner === owner) shell.channel.write(data);
        }),
      resize: (shellId, owner, cols, rows) =>
        Effect.sync(() => {
          const shell = shells.get(shellId);
          if (shell?.owner === owner) shell.channel.setWindow(rows, cols, 0, 0);
        }),
    }),
  );
}

/**
 * On quit: close every shell's channel. Its "close" ends the stream, whose
 * scope then ends the connection; a connection that never reports "close" is
 * ended outright after {@link CHANNEL_CLOSE_TIMEOUT_MS}.
 */
export function killAllSshShells(): void {
  for (const shell of shells.values()) {
    try {
      shell.channel.end();
    } catch {
      /* already closing */
    }
    setTimeout(() => {
      try {
        shell.client.end();
      } catch {
        /* already gone */
      }
    }, CHANNEL_CLOSE_TIMEOUT_MS).unref?.();
  }
}
