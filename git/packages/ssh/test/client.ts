/**
 * A minimal SSH client for tests that need to say things a real client never
 * would: a SHA-1 signature, a packet outside the window, an injected message
 * in the middle of the handshake. It reuses the package's own packet and
 * cipher code for the mechanics; the OpenSSH interop tests are what show
 * those are right.
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";
import { connect, type Socket } from "node:net";
import { source } from "../src/bytes";
import type { PacketCipher } from "../src/cipher/cipher";
import { cleartext } from "../src/cipher/none";
import { deriveKey, exchangeHash } from "../src/kex/method";
import { CIPHERS } from "../src/kex/negotiate";
import { Msg } from "../src/messages";
import { framePacket, unframePacket } from "../src/transport/packet";
import { WireReader, WireWriter } from "../src/wire";

export interface ClientOptions {
  /** Offer strict key exchange. Default true. */
  readonly strict?: boolean;
  /** Ask for the server's extension message. Default true. */
  readonly extInfo?: boolean;
  /** Default: AES-256-GCM. */
  readonly cipher?: string;
  /** Default: `curve25519-sha256`. The hybrid `mlkem768x25519-sha256` is the other one it can do. */
  readonly kex?: string;
  /** Payloads sent before the client's KEXINIT. */
  readonly beforeKexInit?: readonly Uint8Array[];
  /** Payloads sent between the client's KEXINIT and its ECDH init. */
  readonly duringKex?: readonly Uint8Array[];
  /** Use this as the ECDH public value instead of a real one. */
  readonly ecdhPublic?: Uint8Array;
  /** Claim a guessed first key exchange packet follows, for an algorithm the server will not pick. */
  readonly wrongGuess?: boolean;
  /** Stop after the identification lines; the test drives the rest. */
  readonly manual?: boolean;
  readonly version?: string;
}

export interface UserKey {
  readonly type: "ed25519" | "rsa";
  readonly privateKey: KeyObject;
  /** The SSH public key blob. */
  readonly blob: Uint8Array;
}

function base64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export function generateUserKey(type: "ed25519" | "rsa", bits = 2048): UserKey {
  if (type === "ed25519") {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" });
    const blob = new WireWriter().string("ssh-ed25519").string(base64Url(jwk.x!)).finish();
    return { type, privateKey, blob };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = publicKey.export({ format: "jwk" });
  const blob = new WireWriter()
    .string("ssh-rsa")
    .mpint(base64Url(jwk.e!))
    .mpint(base64Url(jwk.n!))
    .finish();
  return { type, privateKey, blob };
}

/** The server ended the connection; `reason` and `message` are from its disconnect packet when it sent one. */
export class Disconnected extends Error {
  constructor(
    readonly reason: number | null,
    message: string,
  ) {
    super(message);
  }
}

export class TestClient {
  serverVersion = "";
  sessionId: Uint8Array = new Uint8Array(0);
  /** The `server-sig-algs` extension, when the server sent one. */
  serverSigAlgs: string[] | null = null;
  keyExchanges = 0;
  /** Sequence number of the last packet sent. */
  lastSentSequence = -1;

  private buffered = Buffer.alloc(0);
  private ended = false;
  private waiting: (() => void) | null = null;
  private seal: PacketCipher = cleartext;
  private open: PacketCipher = cleartext;
  private sequenceOut = 0;
  private sequenceIn = 0;
  private strict = false;
  private clientKexInit: Uint8Array | null = null;
  private readonly version: string;

  private constructor(
    private readonly socket: Socket,
    private readonly options: ClientOptions,
  ) {
    this.version = options.version ?? "SSH-2.0-TestClient_1.0";
    socket.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.wake();
    });
    const end = () => {
      this.ended = true;
      this.wake();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  static async connect(port: number, options: ClientOptions = {}): Promise<TestClient> {
    const socket = connect({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new TestClient(socket, options);
    socket.write(`${client.version}\r\n`);
    client.serverVersion = await client.readLine();
    if (!options.manual) await client.keyExchange();
    return client;
  }

  close(): void {
    this.socket.destroy();
  }

  /** Stop taking bytes off the socket, as a client that has hung does. */
  pause(): void {
    this.socket.pause();
  }

  /** Resolves once the server has closed the connection. */
  async closed(): Promise<void> {
    while (!this.ended) await this.wait();
  }

  writeRaw(bytes: Uint8Array | string): void {
    this.socket.write(bytes);
  }

  // Packets.

  async send(payload: Uint8Array): Promise<void> {
    this.socket.write(await this.sealPacket(payload));
  }

  /** The bytes a packet would have on the wire, without sending them; the sequence number is used up. */
  async sealPacket(payload: Uint8Array): Promise<Uint8Array> {
    const sequence = this.sequenceOut;
    this.sequenceOut = (sequence + 1) >>> 0;
    this.lastSentSequence = sequence;
    return this.seal.seal(sequence, framePacket(payload, this.seal));
  }

  /** The next payload as it comes off the wire, or null at end of stream. */
  async readRaw(): Promise<Uint8Array | null> {
    const header = await this.readBytes(4);
    if (!header) return null;
    const sequence = this.sequenceIn;
    this.sequenceIn = (sequence + 1) >>> 0;
    const length = this.open.readLength(sequence, header);
    const body = await this.readBytes(length + this.open.tagLength);
    if (!body) throw new Error("server closed the connection mid-packet");
    return unframePacket(await this.open.open(sequence, header, body)).slice();
  }

  /**
   * The next payload that is not transport housekeeping. A key exchange the
   * server starts is carried out along the way. Throws `Disconnected` when
   * the server ends the connection.
   */
  async read(): Promise<Uint8Array> {
    for (;;) {
      const payload = await this.readRaw();
      if (!payload) throw new Disconnected(null, "connection closed");
      switch (payload[0]) {
        case Msg.DISCONNECT: {
          const reader = new WireReader(payload, 1);
          const reason = reader.uint32();
          throw new Disconnected(reason, reader.text());
        }
        case Msg.IGNORE:
        case Msg.DEBUG:
          continue;
        case Msg.EXT_INFO: {
          const reader = new WireReader(payload, 1);
          for (let count = reader.uint32(); count > 0; count--) {
            const name = reader.text();
            const value = reader.text();
            if (name === "server-sig-algs") this.serverSigAlgs = value.split(",");
          }
          continue;
        }
        case Msg.KEXINIT:
          await this.keyExchange(payload);
          continue;
        default:
          return payload;
      }
    }
  }

  /** The next payload, which must be of `type`. */
  async expect(type: number): Promise<WireReader> {
    const payload = await this.read();
    if (payload[0] !== type) throw new Error(`expected message ${type}, got ${payload[0]}`);
    return new WireReader(payload, 1);
  }

  /** How the server ended the connection; fails the test if it sends anything else first. */
  async expectDisconnect(): Promise<Disconnected> {
    try {
      const payload = await this.read();
      throw new Error(`expected a disconnect, got message ${payload[0]}`);
    } catch (error) {
      if (error instanceof Disconnected) return error;
      throw error;
    }
  }

  // Key exchange.

  /**
   * One key exchange from the client's side. `serverKexInit` is given when
   * the server started it; `beforeReply` runs after the server's KEXINIT
   * has been seen and before the client's own goes out.
   */
  async keyExchange(serverKexInit?: Uint8Array, beforeReply?: () => Promise<void>): Promise<void> {
    const first = this.keyExchanges === 0;
    const options = first ? this.options : {};
    const wantStrict = this.options.strict ?? true;

    for (const payload of options.beforeKexInit ?? []) await this.send(payload);
    await beforeReply?.();

    const method = this.options.kex ?? "curve25519-sha256";
    const hybrid = method === "mlkem768x25519-sha256";
    const kex = [method];
    if (options.wrongGuess) kex.unshift("diffie-hellman-group14-sha256");
    if (first && (this.options.extInfo ?? true)) kex.push("ext-info-c");
    if (first && wantStrict) kex.push("kex-strict-c-v00@openssh.com");
    const cipher = [this.options.cipher ?? "aes256-gcm@openssh.com"];
    const clientKexInit = new WireWriter()
      .byte(Msg.KEXINIT)
      .raw(crypto.getRandomValues(new Uint8Array(16)))
      .nameList(kex)
      .nameList(["ssh-ed25519"])
      .nameList(cipher)
      .nameList(cipher)
      .nameList(["hmac-sha2-256"])
      .nameList(["hmac-sha2-256"])
      .nameList(["none"])
      .nameList(["none"])
      .nameList([])
      .nameList([])
      .boolean(options.wrongGuess ?? false)
      .uint32(0)
      .finish();
    this.clientKexInit = clientKexInit;
    await this.send(clientKexInit);
    if (options.wrongGuess) {
      // The guessed packet, for the method the server will not choose.
      await this.send(new WireWriter().byte(30).mpint(Uint8Array.of(2)).finish());
    }

    serverKexInit ??= await this.readKex(Msg.KEXINIT);
    const serverLists = new WireReader(serverKexInit, 17);
    const serverStrict = serverLists.nameList().includes("kex-strict-s-v00@openssh.com");
    if (first) this.strict = wantStrict && serverStrict;

    for (const payload of options.duringKex ?? []) await this.send(payload);

    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const x25519Public = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    // The post-quantum half, through the same WebCrypto API the server uses.
    const subtle = crypto.subtle as unknown as {
      generateKey(a: object, e: boolean, u: string[]): Promise<CryptoKeyPair>;
      exportKey(f: string, k: CryptoKey): Promise<ArrayBuffer>;
      decapsulateBits(a: object, k: CryptoKey, c: Uint8Array): Promise<ArrayBuffer>;
    };
    const kemPair = hybrid
      ? await subtle.generateKey({ name: "ML-KEM-768" }, false, ["decapsulateBits"])
      : null;
    const kemPublic = kemPair
      ? new Uint8Array(await subtle.exportKey("raw-public", kemPair.publicKey))
      : new Uint8Array(0);
    const clientInit = options.ecdhPublic ?? Buffer.concat([kemPublic, x25519Public]);
    await this.send(new WireWriter().byte(Msg.KEX_ECDH_INIT).string(clientInit).finish());

    const reply = new WireReader(await this.readKex(Msg.KEX_ECDH_REPLY), 1);
    const hostKeyBlob = reply.string();
    const serverReply = reply.string();
    const signature = reply.string();
    const serverPublic = serverReply.subarray(serverReply.length - 32);
    const peer = await crypto.subtle.importKey("raw", source(serverPublic), "X25519", false, []);
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: peer }, pair.privateKey, 256),
    );
    let encodedSecret: Uint8Array;
    if (kemPair) {
      const ciphertext = serverReply.subarray(0, serverReply.length - 32);
      const kemShared = new Uint8Array(
        await subtle.decapsulateBits({ name: "ML-KEM-768" }, kemPair.privateKey, ciphertext),
      );
      const combined = createHash("sha256").update(kemShared).update(shared).digest();
      encodedSecret = new WireWriter().string(combined).finish();
    } else {
      encodedSecret = new WireWriter().mpint(shared).finish();
    }
    const hash = await exchangeHash({
      clientVersion: this.version,
      serverVersion: this.serverVersion,
      clientKexInit: this.clientKexInit,
      serverKexInit,
      hostKeyBlob,
      clientInit,
      serverReply,
      encodedSecret,
    });
    await this.checkHostSignature(hostKeyBlob, signature, hash);
    if (first) this.sessionId = hash;

    const algorithm = CIPHERS.find((candidate) => candidate.name === cipher[0])!;
    const derive = (letter: string, length: number) =>
      deriveKey(encodedSecret, hash, this.sessionId, letter, length);
    const seal = await algorithm.create(
      await derive("C", algorithm.keyLength),
      await derive("A", algorithm.ivLength),
      "seal",
    );
    const open = await algorithm.create(
      await derive("D", algorithm.keyLength),
      await derive("B", algorithm.ivLength),
      "open",
    );

    await this.send(Uint8Array.of(Msg.NEWKEYS));
    this.seal = seal;
    if (this.strict) this.sequenceOut = 0;
    await this.readKex(Msg.NEWKEYS);
    this.open = open;
    if (this.strict) this.sequenceIn = 0;
    this.keyExchanges++;
  }

  private async readKex(type: number): Promise<Uint8Array> {
    const payload = await this.readRaw();
    if (!payload) throw new Disconnected(null, "connection closed during key exchange");
    if (payload[0] === Msg.DISCONNECT) {
      const reader = new WireReader(payload, 1);
      const reason = reader.uint32();
      throw new Disconnected(reason, reader.text());
    }
    if (payload[0] !== type) {
      throw new Error(`expected key exchange message ${type}, got ${payload[0]}`);
    }
    return payload;
  }

  private async checkHostSignature(
    hostKeyBlob: Uint8Array,
    signatureBlob: Uint8Array,
    hash: Uint8Array,
  ): Promise<void> {
    const keyReader = new WireReader(hostKeyBlob);
    if (keyReader.text() !== "ssh-ed25519") throw new Error("unexpected host key type");
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(keyReader.string()).toString("base64url") },
      format: "jwk",
    });
    const signatureReader = new WireReader(signatureBlob);
    if (signatureReader.text() !== "ssh-ed25519") throw new Error("unexpected signature type");
    const { verify } = await import("node:crypto");
    if (!verify(null, hash, key, signatureReader.string())) {
      throw new Error("the server's host key signature does not verify");
    }
  }

  // Authentication.

  async requestService(name = "ssh-userauth"): Promise<void> {
    await this.send(new WireWriter().byte(Msg.SERVICE_REQUEST).string(name).finish());
    await this.expect(Msg.SERVICE_ACCEPT);
  }

  /**
   * One `publickey` request. `algorithm` is what the request names; `hash`
   * what the signature is really made with (they differ only in tests of
   * refusal). Resolves with the server's answer: the message type.
   */
  async publicKeyAuth(
    key: UserKey,
    options: {
      algorithm?: string;
      hash?: string | null;
      /** Send the query form, without a signature. */
      query?: boolean;
      user?: string;
      /** Sign as if for this session id. */
      sessionId?: Uint8Array;
      /** Name this algorithm inside the signature blob. */
      signatureName?: string;
      signWith?: UserKey;
    } = {},
  ): Promise<number> {
    const user = options.user ?? "git";
    const algorithm =
      options.algorithm ?? (key.type === "ed25519" ? "ssh-ed25519" : "rsa-sha2-256");
    const request = new WireWriter()
      .byte(Msg.USERAUTH_REQUEST)
      .string(user)
      .string("ssh-connection")
      .string("publickey")
      .boolean(!options.query)
      .string(algorithm)
      .string(key.blob);
    if (!options.query) {
      const signed = new WireWriter()
        .string(options.sessionId ?? this.sessionId)
        .raw(request.finish())
        .finish();
      const hash =
        options.hash !== undefined
          ? options.hash
          : key.type === "ed25519"
            ? null
            : algorithm === "rsa-sha2-512"
              ? "sha512"
              : algorithm === "ssh-rsa"
                ? "sha1"
                : "sha256";
      const signature = nodeSign(hash, signed, (options.signWith ?? key).privateKey);
      request.string(
        new WireWriter()
          .string(options.signatureName ?? algorithm)
          .string(signature)
          .finish(),
      );
    }
    await this.send(request.finish());
    return (await this.read())[0]!;
  }

  async login(key: UserKey): Promise<void> {
    await this.requestService();
    const answer = await this.publicKeyAuth(key);
    if (answer !== Msg.USERAUTH_SUCCESS) throw new Error(`login failed with message ${answer}`);
  }

  // Channels.

  /** Open a session channel; resolves with the server's channel number, window and maximum packet. */
  async openSession(
    window = 1 << 20,
    maxPacket = 32768,
    localId = 0,
  ): Promise<{ id: number; window: number; maxPacket: number }> {
    await this.send(
      new WireWriter()
        .byte(Msg.CHANNEL_OPEN)
        .string("session")
        .uint32(localId)
        .uint32(window)
        .uint32(maxPacket)
        .finish(),
    );
    const reader = await this.expect(Msg.CHANNEL_OPEN_CONFIRMATION);
    reader.uint32();
    return { id: reader.uint32(), window: reader.uint32(), maxPacket: reader.uint32() };
  }

  channelRequest(id: number, type: string, wantReply: boolean, rest?: Uint8Array): Promise<void> {
    const message = new WireWriter()
      .byte(Msg.CHANNEL_REQUEST)
      .uint32(id)
      .string(type)
      .boolean(wantReply);
    if (rest) message.raw(rest);
    return this.send(message.finish());
  }

  async exec(id: number, command: string): Promise<void> {
    await this.channelRequest(id, "exec", true, new WireWriter().string(command).finish());
    await this.expect(Msg.CHANNEL_SUCCESS);
  }

  data(id: number, bytes: Uint8Array): Promise<void> {
    return this.send(new WireWriter().byte(Msg.CHANNEL_DATA).uint32(id).string(bytes).finish());
  }

  windowAdjust(id: number, bytes: number): Promise<void> {
    return this.send(
      new WireWriter().byte(Msg.CHANNEL_WINDOW_ADJUST).uint32(id).uint32(bytes).finish(),
    );
  }

  eof(id: number): Promise<void> {
    return this.send(new WireWriter().byte(Msg.CHANNEL_EOF).uint32(id).finish());
  }

  // Bytes.

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  private async readBytes(length: number): Promise<Uint8Array | null> {
    while (this.buffered.length < length) {
      if (this.ended) return null;
      await this.wait();
    }
    const out = new Uint8Array(this.buffered.subarray(0, length));
    this.buffered = this.buffered.subarray(length);
    return out;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffered.indexOf(0x0a);
      if (end !== -1) {
        const line = this.buffered.subarray(0, end).toString("latin1").replace(/\r$/, "");
        this.buffered = this.buffered.subarray(end + 1);
        return line;
      }
      if (this.ended) throw new Disconnected(null, "connection closed before identification");
      await this.wait();
    }
  }
}
