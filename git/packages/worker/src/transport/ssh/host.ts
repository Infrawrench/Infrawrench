/**
 * Git over SSH: the Worker's `connect()` handler. `@infrawrench/git-ssh`
 * speaks SSH on the socket; this file tells it whose key is whose and what
 * a command does, which is to resolve the repository exactly as smart HTTP
 * does and hand the session's two streams to the repository's Durable
 * Object in the stateful form of the protocol.
 */
import type { Socket } from "@cloudflare/workers-types/index";
import { type ExecChannel, type HostKey, loadHostKey, serveConnection } from "@infrawrench/git-ssh";
import { parseGitProtocol } from "@infrawrench/git-protocol";
import { hasAccess } from "../../auth/access";
import type { OfferedSshKey } from "../../auth/authenticate";
import { type Principal, principalActor } from "../../auth/principal";
import type { Env } from "../../env";
import { repoClient } from "../../repo/do/client";
import { describeError } from "../../http/log";
import type { GitDirectory } from "../directory";
import { parseCommand } from "./command";
import { type FailureLimiter, addressKey, rateLimitKey } from "./rate-limit";

/**
 * A push that is being indexed, or a fetch whose objects are being chosen,
 * can say nothing for a while. The SSH server closes a connection idle this
 * long, in either direction.
 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

let hostKey: Promise<HostKey> | undefined;

/** Who an SSH connection is, once its key has been proved. */
export interface Session {
  readonly principal: Principal;
  /** How the greeting addresses them. */
  readonly name: string;
  /** The key that proved it, looked up again before every command. */
  readonly key: OfferedSshKey;
}

/** The most of a client-chosen string a log line carries. */
const LOG_TEXT_LIMIT = 80;

/**
 * A client-chosen string as one log field: quoted, so its spaces cannot
 * pass for other fields, printable ASCII only, and cut short.
 */
export function logField(text: string): string {
  const cut = text.length > LOG_TEXT_LIMIT ? `${text.slice(0, LOG_TEXT_LIMIT)}...` : text;
  return `"${cut.replace(/[\\"]/g, "\\$&").replace(/[^\x20-\x7e]/g, "?")}"`;
}

export interface SshHostDeps {
  readonly directory: GitDirectory;
  readonly limiter: FailureLimiter;
  /** Where a connection's summary goes. Never contains key material. */
  readonly log?: (line: string) => void;
}

const encoder = new TextEncoder();

async function say(stream: WritableStream<Uint8Array>, message: string): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(encoder.encode(message));
  } finally {
    writer.releaseLock();
  }
}

/**
 * What a session's `exec` does: parse the command, look the key and the
 * repository up again, and hand the streams to the repository's Durable
 * Object. Exported for the tests, which drive it without a socket.
 */
export function gitExec(
  env: Pick<Env, "REPO">,
  directory: GitDirectory,
): (
  session: Session,
  command: string,
  channel: ExecChannel,
  variables: ReadonlyMap<string, string>,
) => Promise<number> {
  return async (session, command, channel, variables) => {
    const parsed = parseCommand(command);
    if (parsed.kind === "unsupported") {
      await say(channel.stderr, `ERROR: ${parsed.reason}\n`);
      return 1;
    }
    // A connection can stay open for hours and run many commands. Asking
    // again means a key removed since the connection opened, or a deploy
    // key whose repository is gone, runs nothing more.
    const principal = await directory.authenticateKey(session.key, false);
    if (!principal) {
      await say(channel.stderr, "ERROR: This key is no longer accepted.\n");
      return 1;
    }
    const repository = await directory.resolveRepository(parsed.owner, parsed.name, principal);
    const push = parsed.service === "git-receive-pack";
    if (!repository || !hasAccess(repository.access, "read")) {
      await say(channel.stderr, "ERROR: Repository not found.\n");
      return 1;
    }
    if (push && !hasAccess(repository.access, "write")) {
      const why = repository.archived
        ? `${repository.owner}/${repository.name} is archived and read-only.`
        : `You do not have permission to push to ${repository.owner}/${repository.name}.`;
      await say(channel.stderr, `ERROR: ${why}\n`);
      return 1;
    }
    const asked = parseGitProtocol(variables.get("GIT_PROTOCOL"));
    const response = await repoClient(env, repository.id).serve(
      {
        request: {
          service: parsed.service,
          // No push in protocol v2: a client that asked is answered in v0 and carries on.
          version: push && asked === 2 ? 0 : asked,
          statelessRpc: false,
          advertiseOnly: false,
        },
        httpPreamble: false,
        actor: principalActor(principal),
        policy: push ? await repository.pushPolicy() : null,
      },
      channel.stdin,
      channel.signal,
    );
    if (!response.ok || !response.body) {
      await say(channel.stderr, "ERROR: The repository could not be reached.\n");
      return 1;
    }
    await (response.body as ReadableStream<Uint8Array>).pipeTo(channel.stdout);
    return 0;
  };
}

/**
 * Serves one SSH connection. The promise stays pending for as long as the
 * connection lives: the runtime closes the socket when it settles.
 */
export async function sshConnect(
  socket: Socket,
  env: Pick<Env, "REPO" | "SSH_HOST_KEY">,
  deps: SshHostDeps,
): Promise<void> {
  const { directory, limiter } = deps;
  // Loaded once per isolate: importing the key signs and verifies with it.
  hostKey ??= loadHostKey(env.SSH_HOST_KEY);
  const key = await hostKey.catch((error: unknown) => {
    hostKey = undefined;
    throw error;
  });
  const info = await socket.opened;
  const address = addressKey(info.remoteAddress);
  const limited = address === null ? null : rateLimitKey(address);
  if (limited !== null && (await limiter.blocked(limited))) {
    await socket.close().catch(() => undefined);
    return;
  }

  // Awaited before this handler returns: the runtime drops what is still pending when it does.
  let recorded: Promise<void> | null = null;
  await serveConnection<Session>(socket as unknown as Parameters<typeof serveConnection>[0], {
    hostKeys: [key],
    limits: { idleTimeoutMs: IDLE_TIMEOUT_MS },
    authenticate: async (user, offered, phase) => {
      // Everyone is `git@`. The key says who they are.
      if (user !== "git") return null;
      const verified = phase === "verified";
      const offeredKey = {
        algorithm: offered.algorithm,
        blob: offered.blob,
        fingerprint: offered.fingerprint,
      };
      const principal = await directory.authenticateKey(offeredKey, verified);
      if (!principal) return null;
      // The name is only for the greeting, and only a proven key gets one.
      const name = verified ? await directory.describe(principal) : "";
      return { principal, name, key: offeredKey };
    },

    shellGreeting: ({ name }) =>
      `Hi ${name}! You've authenticated, but git.infrawrench.com does not provide shell access.\n`,

    exec: gitExec(env, directory),

    onClose: (summary) => {
      if (!summary.authenticated && limited !== null && summary.clientVersion !== null) {
        recorded = limiter.failed(limited);
      }
      // The version line is the client's own text: bounded and printable,
      // so it cannot forge or bury the rest of the line.
      deps.log?.(
        `ssh ${address ?? "unknown"} ${logField(summary.clientVersion ?? "-")} ` +
          `auth=${summary.authenticated} kex=${summary.keyExchange ?? "-"} ` +
          `in=${summary.bytesIn} out=${summary.bytesOut}` +
          (summary.error ? ` error=${logField(summary.error.message)}` : ""),
      );
    },
    onError: (error) => {
      console.error(`ssh: ${describeError(error)}`);
    },
  });
  await recorded;
}
