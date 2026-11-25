/**
 * The transport layer (RFC 4253): identification, packets, key exchange and
 * re-exchange. Above it, the rest of the server sees a stream of message
 * payloads in and a way to send payloads out.
 *
 * Reading has one consumer, the connection's loop calling `next()`, and key
 * exchange is driven from inside that loop as its messages arrive. Writing
 * is a chain of tasks so that packets are sealed and written in the order
 * they were handed over, each with the sequence number and keys current at
 * its turn.
 */
import { utf8 } from "../bytes";
import type { PacketCipher } from "../cipher/cipher";
import { cleartext } from "../cipher/none";
import { DisconnectReason, SshError, protocolError } from "../errors";
import type { HostKey } from "../hostkey";
import { deriveKey, exchangeHash, type KexMethod } from "../kex/method";
import { encodeServerKexInit, negotiate, parseKexInit, type Negotiated } from "../kex/negotiate";
import { SIGNATURE_ALGORITHMS } from "../keys/verify";
import { Msg } from "../messages";
import { WireReader, WireWriter } from "../wire";
import { ByteReader } from "./byte-reader";
import { checkPacketLength, framePacket, unframePacket } from "./packet";
import { readClientVersion } from "./version";

export interface DuplexStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface TransportOptions {
  readonly hostKeys: readonly HostKey[];
  /** In the server's order of preference. */
  readonly kexMethods: readonly KexMethod[];
  /** The identification line, without its line ending. */
  readonly serverVersion: string;
  /** Start a new key exchange once this many bytes have crossed under one set of keys. */
  readonly rekeyAfterBytes: number;
  /** How long a key exchange may take once started. */
  readonly kexTimeoutMs: number;
  /** Called for every packet in either direction. */
  onActivity(): void;
  /** Called when the connection cannot continue for a reason the read loop will not see by itself. */
  onFatal(error: SshError): void;
}

export interface Packet {
  readonly payload: Uint8Array;
  /** The packet's sequence number, which `SSH_MSG_UNIMPLEMENTED` has to quote. */
  readonly sequence: number;
}

/** What the layers above may do with the transport. */
export interface PacketSink {
  /**
   * Send a message. Resolves once the bytes have been accepted by the
   * stream, which is the backpressure everything above builds on. During a
   * key exchange it waits for the exchange to finish. `tail` is appended to
   * the payload; it lets bulk data skip a copy.
   */
  send(payload: Uint8Array, tail?: Uint8Array): Promise<void>;
  /**
   * Send a message from inside the read loop. Like `send`, except that
   * during a key exchange it queues the message and resolves at once: the
   * exchange only finishes if the loop keeps reading.
   */
  reply(payload: Uint8Array): Promise<void>;
}

type KexState = "idle" | "sent-init" | "await-ecdh-init" | "await-newkeys";

interface Deferred {
  readonly payload: Uint8Array;
  readonly tail?: Uint8Array | undefined;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * Replies queued while a key exchange is in flight. A well-behaved client
 * sends almost nothing between the two KEXINITs, so anything near this is a
 * peer trying to make the server hold memory.
 */
const MAX_DEFERRED = 256;

/**
 * Rekey long before a sequence number can repeat under one key: for
 * ChaCha20-Poly1305 the sequence number is the nonce.
 */
const REKEY_AFTER_PACKETS = 2 ** 31;

const noop = (): void => {};

export class Transport implements PacketSink {
  clientVersion: string | null = null;
  /** The first exchange hash; set once the first key exchange has produced it. */
  sessionId: Uint8Array | null = null;
  strictKex = false;
  /** Completed key exchanges, the first included. */
  keyExchanges = 0;
  bytesIn = 0;
  bytesOut = 0;
  cipherIn: string | null = null;
  cipherOut: string | null = null;
  /** The key exchange method of the latest completed exchange. */
  kexName: string | null = null;

  private readonly bytes: ByteReader;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  private open: PacketCipher = cleartext;
  private seal: PacketCipher = cleartext;
  private sequenceIn = 0;
  private sequenceOut = 0;

  private chain: Promise<void> = Promise.resolve();
  private writeError: SshError | null = null;
  private closed = false;
  /** While true, messages from the layers above wait: only key exchange packets may go out. */
  private blocked = false;
  private deferred: Deferred[] = [];

  private state: KexState = "idle";
  /** Until the client's first NEWKEYS: nothing but key exchange is allowed. */
  private initial = true;
  private serverKexInit: Uint8Array | null = null;
  private clientKexInit: Uint8Array | null = null;
  private negotiated: Negotiated | null = null;
  private discardGuess = false;
  private sendExtInfo = false;
  private pendingOpen: { cipher: PacketCipher; name: string; kex: string } | null = null;
  private bytesSinceKex = 0;
  private packetsSinceKex = 0;
  private kexTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    stream: DuplexStream,
    private readonly options: TransportOptions,
  ) {
    this.reader = stream.readable.getReader();
    this.writer = stream.writable.getWriter();
    this.bytes = new ByteReader(this.reader);
  }

  /** Exchange identification lines and open the first key exchange. */
  async start(): Promise<void> {
    // Both go out without waiting for the client's line: nothing in either
    // depends on it, and it saves a round trip.
    this.enqueue(() => this.writer.write(utf8(`${this.options.serverVersion}\r\n`))).catch(noop);
    this.beginKex();
    this.clientVersion = await readClientVersion(this.bytes);
  }

  /**
   * The next message for the layers above, or null when the peer has
   * disconnected or closed the stream. Key exchange and the transport's own
   * messages are handled here and never returned.
   */
  async next(): Promise<Packet | null> {
    for (;;) {
      const packet = await this.readPacket();
      if (!packet) return null;
      const type = packet.payload[0]!;
      switch (type) {
        case Msg.DISCONNECT:
          return null;
        case Msg.KEXINIT:
          this.onKexInit(packet);
          continue;
        case Msg.KEX_ECDH_INIT:
          await this.onEcdhInit(packet.payload);
          continue;
        case Msg.NEWKEYS:
          this.onNewKeys(packet.payload);
          continue;
        case Msg.IGNORE:
        case Msg.DEBUG:
        case Msg.UNIMPLEMENTED:
          // Strict key exchange: until the first exchange is done, a packet
          // that is not part of it ends the connection. This is what stops
          // an attacker from padding the handshake with packets of its own.
          if (this.initial && this.strictKex) {
            throw new SshError(
              DisconnectReason.KEY_EXCHANGE_FAILED,
              "unexpected message during initial key exchange",
            );
          }
          continue;
      }
      // A peer that has sent its KEXINIT may send nothing else until it has
      // sent NEWKEYS (RFC 4253, section 7.1), and before the first exchange
      // there is nothing else it could mean.
      if (this.initial || this.state === "await-ecdh-init" || this.state === "await-newkeys") {
        throw new SshError(
          DisconnectReason.KEY_EXCHANGE_FAILED,
          "unexpected message during key exchange",
        );
      }
      return packet;
    }
  }

  send(payload: Uint8Array, tail?: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(connectionClosed());
    if (this.blocked) {
      return new Promise((resolve, reject) =>
        this.deferred.push({ payload, tail, resolve, reject }),
      );
    }
    return this.enqueue(() => this.writePacket(payload, tail));
  }

  reply(payload: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(connectionClosed());
    if (this.blocked) {
      if (this.deferred.length >= MAX_DEFERRED) {
        return Promise.reject(protocolError("too many messages during key exchange"));
      }
      this.deferred.push({ payload, resolve: noop, reject: noop });
      return Promise.resolve();
    }
    return this.enqueue(() => this.writePacket(payload));
  }

  /** Tell the peer it sent a message type this server does not know. */
  unimplemented(sequence: number): Promise<void> {
    return this.reply(new WireWriter().byte(Msg.UNIMPLEMENTED).uint32(sequence).finish());
  }

  /**
   * End the connection, telling the peer why when there is a reason. Never
   * rejects, and never waits long for a peer that has stopped reading: what
   * is still queued then is dropped, and every pending `send` rejects. A
   * pending `next()` returns null once this is done.
   */
  async close(reason?: SshError): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.blocked = false;
    if (this.kexTimer) clearTimeout(this.kexTimer);
    for (const waiting of this.deferred.splice(0)) waiting.reject(connectionClosed());

    if (reason && !this.writeError) {
      const payload = new WireWriter()
        .byte(Msg.DISCONNECT)
        .uint32(reason.reason)
        .string(reason.message)
        .string("")
        .finish();
      // Straight onto the chain rather than through `send`: a disconnect
      // may go out in the middle of a key exchange.
      this.enqueue(() => this.writePacket(payload)).catch(noop);
    }
    const flushed = await settleWithin(
      this.chain.then(() => this.writer.close()),
      CLOSE_GRACE_MS,
    );
    if (!flushed) this.writer.abort().catch(noop);
    // Last: cancelling the readable side of a socket can take the writable
    // side with it, and the disconnect message had to get out first.
    this.reader.cancel().catch(noop);
  }

  // Reading.

  private async readPacket(): Promise<Packet | null> {
    const header = await this.bytes.read(4);
    if (!header) return null;
    const cipher = this.open;
    const sequence = this.sequenceIn;
    const length = cipher.readLength(sequence, header);
    checkPacketLength(length, cipher);
    const body = await this.bytes.read(length + cipher.tagLength);
    if (!body) throw new SshError(DisconnectReason.CONNECTION_LOST, "connection closed mid-packet");
    const clear = await cipher.open(sequence, header, body);
    const payload = unframePacket(clear);

    this.sequenceIn = (sequence + 1) >>> 0;
    // The sequence number is never reset outside strict key exchange, so
    // wrapping before any keys exist can only be an attack on the handshake.
    if (this.sequenceIn === 0 && this.initial) {
      throw new SshError(DisconnectReason.KEY_EXCHANGE_FAILED, "sequence number wrapped");
    }
    this.count(4 + body.length);
    this.bytesIn += 4 + body.length;
    return { payload, sequence };
  }

  // Writing.

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.writeError) throw this.writeError;
      try {
        await task();
      } catch (error) {
        // Whatever the stream threw (a reset, a broken pipe), the layers
        // above only need to know the connection is gone. Once one write
        // has failed every later one fails the same way.
        this.writeError = error instanceof SshError ? error : connectionClosed();
        this.options.onFatal(this.writeError);
        throw this.writeError;
      }
    });
    this.chain = run.catch(noop);
    return run;
  }

  /** Only ever called from inside the chain. */
  private async writePacket(payload: Uint8Array, tail?: Uint8Array): Promise<void> {
    const cipher = this.seal;
    const sequence = this.sequenceOut;
    this.sequenceOut = (sequence + 1) >>> 0;
    const wire = await cipher.seal(sequence, framePacket(payload, cipher, tail));
    this.bytesOut += wire.length;
    this.count(wire.length);
    await this.writer.write(wire);
  }

  private count(bytes: number): void {
    this.options.onActivity();
    this.bytesSinceKex += bytes;
    this.packetsSinceKex++;
    if (
      !this.initial &&
      (this.bytesSinceKex >= this.options.rekeyAfterBytes ||
        this.packetsSinceKex >= REKEY_AFTER_PACKETS)
    ) {
      this.beginKex();
    }
  }

  // Key exchange.

  /** Send the server's KEXINIT, unless an exchange is already under way. */
  private beginKex(): void {
    if (this.state !== "idle" || this.closed) return;
    this.state = "sent-init";
    this.blocked = true;
    const kexInit = encodeServerKexInit(
      this.options.kexMethods,
      this.options.hostKeys.map((key) => key.algorithm),
      this.initial,
    );
    this.serverKexInit = kexInit;
    this.kexTimer = setTimeout(() => {
      this.options.onFatal(
        new SshError(DisconnectReason.KEY_EXCHANGE_FAILED, "key exchange timed out"),
      );
    }, this.options.kexTimeoutMs);
    this.enqueue(() => this.writePacket(kexInit)).catch(noop);
  }

  private onKexInit(packet: Packet): void {
    if (this.state === "idle") this.beginKex();
    else if (this.state !== "sent-init") throw protocolError("unexpected KEXINIT");

    const negotiated = negotiate(
      parseKexInit(packet.payload),
      this.options.kexMethods,
      this.options.hostKeys.map((key) => key.algorithm),
    );
    if (this.initial) {
      // The markers count in the first KEXINIT only; later ones are ignored
      // so that a re-exchange cannot turn strict mode off.
      if (negotiated.clientWantsStrictKex) {
        if (packet.sequence !== 0) {
          throw new SshError(
            DisconnectReason.KEY_EXCHANGE_FAILED,
            "strict key exchange: KEXINIT was not the first packet",
          );
        }
        this.strictKex = true;
      }
      this.sendExtInfo = negotiated.clientWantsExtInfo;
    }
    // The payload is hashed later, after the buffer it points into may have been reused.
    this.clientKexInit = packet.payload.slice();
    this.negotiated = negotiated;
    this.discardGuess = negotiated.discardGuess;
    this.state = "await-ecdh-init";
  }

  private async onEcdhInit(payload: Uint8Array): Promise<void> {
    if (this.state !== "await-ecdh-init") throw protocolError("unexpected key exchange message");
    if (this.discardGuess) {
      this.discardGuess = false;
      return;
    }
    const negotiated = this.negotiated!;
    const reader = new WireReader(payload, 1);
    const clientInit = reader.string();
    reader.end();

    const hostKey = this.options.hostKeys.find((key) => key.algorithm === negotiated.hostKey)!;
    const { reply: serverReply, encodedSecret } = await negotiated.kex.respond(clientInit);
    const hash = await exchangeHash({
      clientVersion: this.clientVersion!,
      serverVersion: this.options.serverVersion,
      clientKexInit: this.clientKexInit!,
      serverKexInit: this.serverKexInit!,
      hostKeyBlob: hostKey.publicKey.blob,
      clientInit,
      serverReply,
      encodedSecret,
    });
    const sessionId = (this.sessionId ??= hash);
    const signature = await hostKey.sign(hash);

    const { cipherIn, cipherOut } = negotiated;
    const derive = (letter: string, length: number) =>
      deriveKey(encodedSecret, hash, sessionId, letter, length);
    const open = await cipherIn.create(
      await derive("C", cipherIn.keyLength),
      await derive("A", cipherIn.ivLength),
      "open",
    );
    const seal = await cipherOut.create(
      await derive("D", cipherOut.keyLength),
      await derive("B", cipherOut.ivLength),
      "seal",
    );
    encodedSecret.fill(0);

    const reply = new WireWriter()
      .byte(Msg.KEX_ECDH_REPLY)
      .string(hostKey.publicKey.blob)
      .string(serverReply)
      .string(signature)
      .finish();
    const first = this.initial;
    const sent = [
      this.enqueue(() => this.writePacket(reply)),
      this.enqueue(async () => {
        await this.writePacket(Uint8Array.of(Msg.NEWKEYS));
        // From the very next packet: new keys, and under strict key
        // exchange a sequence number that starts over.
        this.seal = seal;
        this.cipherOut = cipherOut.name;
        if (this.strictKex) this.sequenceOut = 0;
      }),
    ];
    if (first && this.sendExtInfo) {
      // RFC 8308: the first message after the server's first NEWKEYS. It
      // tells the client which signature algorithms it may offer, without
      // which an RSA key may be tried with SHA-1 first.
      const extInfo = new WireWriter()
        .byte(Msg.EXT_INFO)
        .uint32(1)
        .string("server-sig-algs")
        .nameList(SIGNATURE_ALGORITHMS)
        .finish();
      sent.push(this.enqueue(() => this.writePacket(extInfo)));
    }
    this.pendingOpen = { cipher: open, name: cipherIn.name, kex: negotiated.kexName };
    this.state = "await-newkeys";

    // The server's side of the exchange is done, so what the layers above
    // were holding may follow, under the new keys.
    this.blocked = false;
    for (const waiting of this.deferred.splice(0)) {
      this.enqueue(() => this.writePacket(waiting.payload, waiting.tail)).then(
        waiting.resolve,
        waiting.reject,
      );
    }
    await Promise.all(sent);
  }

  private onNewKeys(payload: Uint8Array): void {
    if (this.state !== "await-newkeys" || payload.length !== 1) {
      throw protocolError("unexpected NEWKEYS");
    }
    const pending = this.pendingOpen!;
    this.open = pending.cipher;
    this.cipherIn = pending.name;
    this.kexName = pending.kex;
    this.pendingOpen = null;
    if (this.strictKex) this.sequenceIn = 0;
    this.state = "idle";
    this.initial = false;
    this.keyExchanges++;
    this.bytesSinceKex = 0;
    this.packetsSinceKex = 0;
    if (this.kexTimer) clearTimeout(this.kexTimer);
    this.kexTimer = null;
  }
}

/** How long closing waits for a last packet to leave before it gives up on the peer. */
const CLOSE_GRACE_MS = 2000;

function connectionClosed(): SshError {
  return new SshError(DisconnectReason.CONNECTION_LOST, "connection closed");
}

/** Whether `promise` settled (either way) within `ms`. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true as const,
    () => true as const,
  );
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return result;
}
