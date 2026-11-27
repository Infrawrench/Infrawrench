/**
 * The connection protocol (RFC 4254) for an authenticated client: opening
 * session channels, the requests made on them, and refusing everything a
 * git server has no business doing (forwarding, agents, subsystems, PTYs).
 */
import { fromUtf8, utf8 } from "./bytes";
import { SessionChannel, type ChannelSettings, type ExecChannel } from "./channel";
import { protocolError } from "./errors";
import { Msg, OpenFailure } from "./messages";
import type { Packet, PacketSink } from "./transport/transport";
import { WireReader, WireWriter } from "./wire";

export interface ConnectionOptions<Principal> {
  readonly principal: Principal;
  readonly channel: ChannelSettings;
  /** Session channels open at once. */
  readonly maxChannels: number;
  exec(
    principal: Principal,
    command: string,
    channel: ExecChannel,
    env: ReadonlyMap<string, string>,
  ): Promise<number>;
  shellGreeting(principal: Principal): string;
  onError(error: unknown): void;
  /** Tell the client a message type is not understood. */
  unimplemented(sequence: number): Promise<void>;
}

/** Git sends one variable (`GIT_PROTOCOL`); these leave room without letting a client fill memory. */
const MAX_ENV_VARIABLES = 32;
const MAX_ENV_NAME = 128;
const MAX_ENV_VALUE = 4096;
/** A git command is a verb and a repository path. */
const MAX_COMMAND_LENGTH = 4096;
/** Below this a client could make the server send its output a few bytes per packet. */
const MIN_REMOTE_MAX_PACKET = 1024;
/** What GitHub and OpenSSH's `ForceCommand` setups answer a shell request with. */
const SHELL_EXIT_STATUS = 1;

export class Connection<Principal> {
  private readonly channels = new Map<number, SessionChannel>();
  private readonly running = new Set<Promise<void>>();
  private noMoreSessions = false;

  constructor(
    private readonly sink: PacketSink,
    private readonly options: ConnectionOptions<Principal>,
  ) {}

  async handle(packet: Packet): Promise<void> {
    const { payload } = packet;
    const reader = new WireReader(payload, 1);
    switch (payload[0]) {
      case Msg.CHANNEL_OPEN:
        return this.onOpen(reader);
      case Msg.CHANNEL_REQUEST:
        return this.onRequest(reader);
      case Msg.CHANNEL_DATA: {
        const channel = this.channel(reader.uint32());
        const data = reader.string();
        reader.end();
        channel.receiveData(data);
        return;
      }
      case Msg.CHANNEL_EXTENDED_DATA: {
        const channel = this.channel(reader.uint32());
        reader.uint32();
        const data = reader.string();
        reader.end();
        channel.receiveExtendedData(data.length);
        return;
      }
      case Msg.CHANNEL_WINDOW_ADJUST: {
        const channel = this.channel(reader.uint32());
        const bytes = reader.uint32();
        reader.end();
        channel.receiveWindowAdjust(bytes);
        return;
      }
      case Msg.CHANNEL_EOF: {
        const channel = this.channel(reader.uint32());
        reader.end();
        channel.receiveEof();
        return;
      }
      case Msg.CHANNEL_CLOSE: {
        const id = reader.uint32();
        reader.end();
        const channel = this.channel(id);
        // Both sides have now closed it, so the number is free again.
        this.channels.delete(id);
        if (channel.receiveClose()) {
          await this.sink.reply(
            new WireWriter().byte(Msg.CHANNEL_CLOSE).uint32(channel.remoteId).finish(),
          );
        }
        return;
      }
      case Msg.GLOBAL_REQUEST:
        return this.onGlobalRequest(reader);
      case Msg.USERAUTH_REQUEST:
        // RFC 4252, section 5.1: after success, further requests are silently ignored.
        return;
      case Msg.REQUEST_SUCCESS:
      case Msg.REQUEST_FAILURE:
      case Msg.CHANNEL_SUCCESS:
      case Msg.CHANNEL_FAILURE:
        // Answers to requests the server never makes; harmless.
        return;
      case Msg.CHANNEL_OPEN_CONFIRMATION:
      case Msg.CHANNEL_OPEN_FAILURE:
        throw protocolError("unexpected channel message");
      default:
        return this.options.unimplemented(packet.sequence);
    }
  }

  /** The connection is over: stop every running command. */
  abort(reason: Error): void {
    for (const channel of this.channels.values()) channel.abort(reason);
    this.channels.clear();
  }

  /** Settles when every command that was started has returned. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }

  private channel(id: number): SessionChannel {
    const channel = this.channels.get(id);
    // A message for a channel that does not exist cannot be attributed to
    // anything, so there is no safe way to carry on.
    if (!channel) throw protocolError("message for a channel that is not open");
    return channel;
  }

  private async onOpen(reader: WireReader): Promise<void> {
    const type = reader.text();
    const remoteId = reader.uint32();
    const remoteWindow = reader.uint32();
    const remoteMaxPacket = reader.uint32();
    // Channel types other than `session` carry more fields; they are refused unread.

    const refuse = (reason: number, description: string) =>
      this.sink.reply(
        new WireWriter()
          .byte(Msg.CHANNEL_OPEN_FAILURE)
          .uint32(remoteId)
          .uint32(reason)
          .string(description)
          .string("")
          .finish(),
      );

    if (type !== "session") {
      // direct-tcpip, forwarded-tcpip, x11, auth-agent@openssh.com, tun@openssh.com, ...
      const known = type === "direct-tcpip" || type === "direct-streamlocal@openssh.com";
      return refuse(
        known ? OpenFailure.ADMINISTRATIVELY_PROHIBITED : OpenFailure.UNKNOWN_CHANNEL_TYPE,
        known ? "port forwarding is not available" : "unknown channel type",
      );
    }
    reader.end();
    if (this.noMoreSessions) {
      return refuse(OpenFailure.ADMINISTRATIVELY_PROHIBITED, "no more sessions");
    }
    if (this.channels.size >= this.options.maxChannels) {
      return refuse(OpenFailure.RESOURCE_SHORTAGE, "too many open sessions");
    }
    if (remoteMaxPacket < MIN_REMOTE_MAX_PACKET) {
      return refuse(OpenFailure.ADMINISTRATIVELY_PROHIBITED, "maximum packet size is too small");
    }

    let id = 0;
    while (this.channels.has(id)) id++;
    const { channel: settings } = this.options;
    this.channels.set(
      id,
      new SessionChannel(this.sink, remoteId, remoteWindow, remoteMaxPacket, settings),
    );
    await this.sink.reply(
      new WireWriter()
        .byte(Msg.CHANNEL_OPEN_CONFIRMATION)
        .uint32(remoteId)
        .uint32(id)
        .uint32(settings.window)
        .uint32(settings.maxPacket)
        .finish(),
    );
  }

  private async onRequest(reader: WireReader): Promise<void> {
    const id = reader.uint32();
    const channel = this.channel(id);
    const type = reader.text();
    const wantReply = reader.boolean();

    let accepted = false;
    let start: (() => void) | null = null;
    switch (type) {
      case "env": {
        const name = reader.text();
        const value = reader.text();
        reader.end();
        accepted = !channel.started && this.setEnv(channel, name, value);
        break;
      }
      case "exec": {
        const command = decodeCommand(reader.string());
        reader.end();
        if (channel.started || command === null) break;
        accepted = true;
        // The handler gets its own copy: later `env` requests are refused,
        // but nothing should depend on that.
        const env = new Map(channel.env);
        start = () => {
          channel.start(
            (io) => this.options.exec(this.options.principal, command, io, env),
            this.options.onError,
          );
          this.track(channel);
        };
        break;
      }
      case "shell": {
        reader.end();
        if (channel.started) break;
        accepted = true;
        start = () => {
          const text = utf8(this.options.shellGreeting(this.options.principal));
          channel.greet(text, SHELL_EXIT_STATUS);
          this.track(channel);
        };
        break;
      }
      default:
        // pty-req, subsystem, x11-req, auth-agent-req@openssh.com,
        // window-change, signal, ...: none of it is available.
        break;
    }

    // Nothing may follow the server's own close on a channel, a reply included.
    if (channel.closeSent) return;
    if (wantReply) {
      await this.sink.reply(
        new WireWriter()
          .byte(accepted ? Msg.CHANNEL_SUCCESS : Msg.CHANNEL_FAILURE)
          .uint32(channel.remoteId)
          .finish(),
      );
    }
    // After the reply, so the client hears "yes" before any output.
    if (!channel.closeSent) start?.();
  }

  private track(channel: SessionChannel): void {
    const finished = channel.finished;
    this.running.add(finished);
    void finished.then(() => this.running.delete(finished));
  }

  private setEnv(channel: SessionChannel, name: string, value: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > MAX_ENV_NAME) return false;
    if (value.length > MAX_ENV_VALUE || value.includes("\0")) return false;
    if (!channel.env.has(name) && channel.env.size >= MAX_ENV_VARIABLES) return false;
    channel.env.set(name, value);
    return true;
  }

  private async onGlobalRequest(reader: WireReader): Promise<void> {
    const type = reader.text();
    const wantReply = reader.boolean();
    if (type === "no-more-sessions@openssh.com") this.noMoreSessions = true;
    // tcpip-forward, streamlocal-forward@openssh.com and the rest are
    // refused. keepalive@openssh.com only needs an answer of any kind, and
    // a refusal is what OpenSSH's own server gives it.
    if (wantReply) await this.sink.reply(Uint8Array.of(Msg.REQUEST_FAILURE));
  }
}

function decodeCommand(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_COMMAND_LENGTH) return null;
  try {
    const command = fromUtf8(bytes);
    return command.includes("\0") ? null : command;
  } catch {
    return null;
  }
}
