/**
 * The SSH server's public interface.
 *
 * The server speaks SSH over any duplex byte stream (a Worker's inbound
 * `connect()` socket in production, a Node socket in tests). It knows
 * nothing about git or Infrawrench: who a key belongs to and what a command
 * does are callbacks.
 */
import type { ExecChannel } from "./channel";
import { Connection } from "./connection";
import { DisconnectReason, SshError, protocolError } from "./errors";
import { loadHostKey, type HostKey } from "./hostkey";
import { curve25519Sha256 } from "./kex/curve25519";
import { mlkem768x25519Sha256, mlkemAvailable } from "./kex/mlkem768x25519";
import { DEFAULT_CIPHERS, resolveCiphers, type CipherName } from "./kex/negotiate";
import type { CipherAlgorithm } from "./cipher/cipher";
import type { SshPublicKey } from "./keys/public";
import { Msg } from "./messages";
import { Transport, type DuplexStream } from "./transport/transport";
import { UserAuth, type AuthPhase } from "./userauth";
import { WireReader, WireWriter } from "./wire";

export type { DuplexStream } from "./transport/transport";
export type { ExecChannel } from "./channel";
export type { AuthPhase } from "./userauth";
export type { CipherName } from "./kex/negotiate";

export interface SshServerLimits {
  /**
   * From the first byte to a successful authentication, key exchange
   * included. Also how long any later key exchange may take. Default 30 s.
   */
  readonly authTimeoutMs?: number;
  /** With no packet in either direction for this long, the connection is closed. Default 5 min. */
  readonly idleTimeoutMs?: number;
  /** Failed authentication requests before the connection is closed. Default 10. */
  readonly maxAuthAttempts?: number;
  /** Session channels open at once on one connection. Default 8. */
  readonly maxChannels?: number;
  /**
   * The flow-control window granted to the client per channel, in bytes:
   * the most unread stdin the server will hold for a command. Default 2 MiB,
   * clamped to 64 KiB..16 MiB.
   */
  readonly channelWindow?: number;
  /** New keys are negotiated after this many bytes under one set. Default 1 GiB. */
  readonly rekeyAfterBytes?: number;
}

/** What happened on a connection, for logs and metering. Never contains key material or data. */
export interface SshConnectionSummary {
  /** The client's identification line, e.g. `SSH-2.0-OpenSSH_10.3`; null if it never sent one. */
  readonly clientVersion: string | null;
  readonly authenticated: boolean;
  /** The key exchange method, e.g. `mlkem768x25519-sha256`, once one completed. */
  readonly keyExchange: string | null;
  /** The cipher protecting what the client sent, once keys were in place. */
  readonly cipher: string | null;
  /** Whether strict key exchange (the Terrapin countermeasure) was in effect. */
  readonly strictKex: boolean;
  /** Completed key exchanges, the first included. */
  readonly keyExchanges: number;
  /** Bytes on the wire in each direction, packet overhead included. */
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** Why the server ended the connection, or null when the client closed it. */
  readonly error: SshError | null;
}

export interface SshServerOptions<Principal> {
  /**
   * The server's host keys: unencrypted OpenSSH private keys as text, or
   * keys already loaded with `loadHostKey` (preferred: load once per isolate,
   * not per connection). At least one, and at most one per algorithm; only
   * `ssh-ed25519` is supported.
   */
  readonly hostKeys: readonly (HostKey | string)[];
  /**
   * Resolve a public key to a principal, or null to refuse it.
   *
   * Called with `"query"` when a client asks whether a key would be
   * accepted, having proved nothing, and with `"verified"` once it has
   * proved it holds the key. Only the principal from the `"verified"` call
   * is ever used; anything with a side effect (a last-used time, an audit
   * record) belongs there. Throwing refuses the key.
   */
  authenticate(user: string, key: SshPublicKey, phase: AuthPhase): Promise<Principal | null>;
  /**
   * Run `command` (e.g. `git-upload-pack 'owner/repo.git'`) and resolve with
   * its exit status. Resolve only after everything written to the channel
   * has been accepted (await the writes, or the `pipeTo`); the channel is
   * closed as soon as this settles. Throwing reports exit status 1.
   */
  exec(
    principal: Principal,
    command: string,
    channel: ExecChannel,
    env: ReadonlyMap<string, string>,
  ): Promise<number>;
  /** Text for a session that asks for a shell instead of a command. It is followed by exit status 1. */
  shellGreeting?(principal: Principal): string;
  readonly limits?: SshServerLimits;
  /**
   * The ciphers to offer, in the server's order of preference (the client's
   * own order decides among those both sides have). Default: the two
   * AES-GCM ciphers, which WebCrypto runs natively.
   * `chacha20-poly1305@openssh.com` is implemented in TypeScript and costs
   * several times the CPU per byte; OpenSSH prefers it when it is offered,
   * so it is only offered when listed here.
   */
  readonly ciphers?: readonly CipherName[];
  /**
   * The software name in the identification line (`SSH-2.0-<this>`).
   * Printable ASCII without spaces or `-`. Default `InfrawrenchGit`.
   */
  readonly softwareVersion?: string;
  /** Abort to disconnect the client, for instance when the host is shutting down. */
  readonly signal?: AbortSignal;
  /**
   * Something went wrong on the server's side of a connection: a callback
   * threw, or an internal error. Misbehaving clients are not reported here;
   * they are in `SshConnectionSummary.error`.
   */
  onError?(error: unknown): void;
  /** Called once, when the connection is over. */
  onClose?(summary: SshConnectionSummary): void;
}

const DEFAULT_GREETING = "Shell access is not available.\n";
/** How long to wait, after the connection is gone, for commands to notice. */
const EXEC_GRACE_MS = 5000;
const KIB = 1024;
const MIB = 1024 * KIB;
/** The largest data payload a client may send in one message; OpenSSH's own figure. */
const CHANNEL_MAX_PACKET = 32 * KIB;

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const chosen = value === undefined || !Number.isFinite(value) ? fallback : Math.floor(value);
  return Math.min(max, Math.max(min, chosen));
}

function resolveLimits(limits: SshServerLimits = {}): Required<SshServerLimits> {
  return {
    authTimeoutMs: clamp(limits.authTimeoutMs, 30_000, 1, 10 * 60_000),
    idleTimeoutMs: clamp(limits.idleTimeoutMs, 5 * 60_000, 1, 24 * 60 * 60_000),
    maxAuthAttempts: clamp(limits.maxAuthAttempts, 10, 1, 100),
    maxChannels: clamp(limits.maxChannels, 8, 1, 64),
    channelWindow: clamp(limits.channelWindow, 2 * MIB, 64 * KIB, 16 * MIB),
    // The upper bound keeps AES-GCM and ChaCha20-Poly1305 far inside their limits for one key.
    rekeyAfterBytes: clamp(limits.rekeyAfterBytes, 1024 * MIB, 64 * KIB, 16 * 1024 * MIB),
  };
}

async function resolveHostKeys(keys: readonly (HostKey | string)[]): Promise<HostKey[]> {
  const loaded = await Promise.all(
    keys.map((key) => (typeof key === "string" ? loadHostKey(key) : key)),
  );
  if (loaded.length === 0) throw new Error("serveConnection needs at least one host key");
  if (new Set(loaded.map((key) => key.algorithm)).size !== loaded.length) {
    throw new Error("serveConnection takes at most one host key per algorithm");
  }
  return loaded;
}

function serverVersion(software: string | undefined): string {
  const name = software ?? "InfrawrenchGit";
  if (!/^[\x21-\x2c\x2e-\x7e]{1,64}$/.test(name)) {
    throw new Error("softwareVersion must be printable ASCII without spaces or '-'");
  }
  return `SSH-2.0-${name}`;
}

/**
 * Serve one SSH connection over `stream` until it ends.
 *
 * Resolves when the connection is over, however it ended; a client that
 * misbehaves is disconnected and the reason is in the `onClose` summary.
 * Rejects only for a configuration error (an unusable host key, cipher list
 * or software version), before anything is sent.
 */
export async function serveConnection<Principal>(
  stream: DuplexStream,
  options: SshServerOptions<Principal>,
): Promise<void> {
  let hostKeys: HostKey[];
  let version: string;
  let ciphers: CipherAlgorithm[];
  try {
    ciphers = resolveCiphers(options.ciphers ?? DEFAULT_CIPHERS);
    hostKeys = await resolveHostKeys(options.hostKeys);
    version = serverVersion(options.softwareVersion);
  } catch (error) {
    // The socket would otherwise be left open with nobody serving it.
    stream.readable.cancel().catch(() => {});
    stream.writable.abort().catch(() => {});
    throw error;
  }
  const limits = resolveLimits(options.limits);
  // The post-quantum hybrid first, where this runtime has ML-KEM; the
  // client's own order decides between the two.
  const kexMethods = (await mlkemAvailable())
    ? [mlkem768x25519Sha256, curve25519Sha256]
    : [curve25519Sha256];

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A logging hook that throws must not take the connection with it.
    }
  };

  // Shared with the callbacks below, which the compiler cannot see assigning to plain locals.
  const state: { failure: SshError | null; connection: Connection<Principal> | null } = {
    failure: null,
    connection: null,
  };
  let lastActivity = Date.now();
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  /** End the connection from outside the read loop: a timer, the host, a failed write. */
  const fail = (error: SshError): void => {
    state.failure ??= error;
    stop();
  };

  const transport = new Transport(stream, {
    hostKeys,
    kexMethods,
    ciphers,
    serverVersion: version,
    rekeyAfterBytes: limits.rekeyAfterBytes,
    kexTimeoutMs: limits.authTimeoutMs,
    onActivity: () => {
      lastActivity = Date.now();
    },
    onFatal: fail,
  });

  let authTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => fail(new SshError(DisconnectReason.BY_APPLICATION, "authentication timed out")),
    limits.authTimeoutMs,
  );
  // Checked a few times per period rather than re-armed on every packet.
  const idleTimer = setInterval(
    () => {
      if (Date.now() - lastActivity >= limits.idleTimeoutMs) {
        fail(new SshError(DisconnectReason.BY_APPLICATION, "idle timeout"));
      }
    },
    Math.max(10, Math.ceil(limits.idleTimeoutMs / 4)),
  );
  const onAbort = (): void =>
    fail(new SshError(DisconnectReason.BY_APPLICATION, "the server is closing connections"));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const readLoop = async (): Promise<void> => {
    let auth: UserAuth<Principal> | null = null;
    await transport.start();
    for (;;) {
      const packet = await transport.next();
      // A failure set while this was waiting means the packet arrived too late to count.
      if (!packet || state.failure) return;
      if (state.connection) {
        await state.connection.handle(packet);
        continue;
      }
      switch (packet.payload[0]) {
        case Msg.SERVICE_REQUEST: {
          const reader = new WireReader(packet.payload, 1);
          const service = reader.text();
          reader.end();
          if (service !== "ssh-userauth") {
            throw new SshError(DisconnectReason.SERVICE_NOT_AVAILABLE, "unknown service");
          }
          auth ??= new UserAuth(transport, {
            // Set by the key exchange `next()` completed before returning this packet.
            sessionId: transport.sessionId!,
            maxAttempts: limits.maxAuthAttempts,
            authenticate: (user, key, phase) => options.authenticate(user, key, phase),
            onError: report,
          });
          await transport.reply(new WireWriter().byte(Msg.SERVICE_ACCEPT).string(service).finish());
          break;
        }
        case Msg.USERAUTH_REQUEST: {
          if (!auth) throw protocolError("authentication request before service request");
          const result = await auth.handle(packet.payload);
          // The lookup may have taken long enough for the time limit to pass.
          if (!result || state.failure) break;
          clearTimeout(authTimer);
          authTimer = undefined;
          state.connection = new Connection(transport, {
            principal: result.principal,
            channel: { window: limits.channelWindow, maxPacket: CHANNEL_MAX_PACKET },
            maxChannels: limits.maxChannels,
            exec: (who, command, channel, env) => options.exec(who, command, channel, env),
            shellGreeting: (who) => options.shellGreeting?.(who) ?? DEFAULT_GREETING,
            onError: report,
            unimplemented: (sequence) => transport.unimplemented(sequence),
          });
          break;
        }
        case Msg.EXT_INFO:
          // A client's extension list; nothing in it changes what this server does.
          break;
        default:
          // Channels and global requests exist only after authentication.
          if (packet.payload[0]! >= Msg.GLOBAL_REQUEST) {
            throw protocolError("connection message before authentication");
          }
          await transport.unimplemented(packet.sequence);
      }
    }
  };

  const loop = readLoop().catch((error: unknown) => {
    if (state.failure) return;
    if (error instanceof SshError) {
      state.failure = error;
    } else {
      // A bug or a broken callback. The client is told nothing about it.
      report(error);
      state.failure = new SshError(DisconnectReason.BY_APPLICATION, "internal error");
    }
  });

  // The loop ends by itself when the client goes away or misbehaves. A timer
  // or the host ends the connection around it instead: the loop may be
  // stuck waiting to write to a client that has stopped reading, and only
  // closing the transport frees it.
  await Promise.race([loop, stopped]);

  clearTimeout(authTimer);
  clearInterval(idleTimer);
  options.signal?.removeEventListener("abort", onAbort);
  state.connection?.abort(new Error("the SSH connection is closed"));
  await transport.close(state.failure ?? undefined);
  // The loop and the commands have been told; give them a moment to return,
  // but a callback that never does must not keep the connection's slot.
  await settledWithin(Promise.all([loop, state.connection?.settled()]), EXEC_GRACE_MS);

  try {
    options.onClose?.({
      clientVersion: transport.clientVersion,
      authenticated: state.connection !== null,
      keyExchange: transport.kexName,
      cipher: transport.cipherIn,
      strictKex: transport.strictKex,
      keyExchanges: transport.keyExchanges,
      bytesIn: transport.bytesIn,
      bytesOut: transport.bytesOut,
      error: state.failure,
    });
  } catch (error) {
    report(error);
  }
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
