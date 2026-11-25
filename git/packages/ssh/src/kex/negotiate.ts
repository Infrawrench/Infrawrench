/**
 * `SSH_MSG_KEXINIT` (RFC 4253, section 7.1): each side's algorithm lists and
 * the rule that picks one from them.
 */
import { aes128Gcm, aes256Gcm } from "../cipher/aes-gcm";
import { chacha20Poly1305 } from "../cipher/chacha20-poly1305";
import type { CipherAlgorithm } from "../cipher/cipher";
import { DisconnectReason, SshError } from "../errors";
import { Msg } from "../messages";
import type { KexMethod } from "./method";
import { WireReader, WireWriter } from "../wire";

/** A client that lists this wants the server's extension message (RFC 8308). */
const EXT_INFO_CLIENT = "ext-info-c";
/** Strict key exchange, OpenSSH's countermeasure to the Terrapin prefix-truncation attack. */
const STRICT_CLIENT = "kex-strict-c-v00@openssh.com";
const STRICT_SERVER = "kex-strict-s-v00@openssh.com";

/** Every cipher the package implements. Which of them a server offers is its host's choice. */
export const CIPHERS = [aes256Gcm, aes128Gcm, chacha20Poly1305] as const;

export type CipherName =
  "aes256-gcm@openssh.com" | "aes128-gcm@openssh.com" | "chacha20-poly1305@openssh.com";

/**
 * What a server offers unless told otherwise: the two WebCrypto runs
 * natively. ChaCha20-Poly1305 is this package's own TypeScript and costs
 * several times the CPU per byte, and OpenSSH lists it first, so offering it
 * by default would put most clients on the slow path.
 */
export const DEFAULT_CIPHERS: readonly CipherName[] = [
  "aes256-gcm@openssh.com",
  "aes128-gcm@openssh.com",
];

/** The algorithms for `names`, in that order. Throws on an unknown name or an empty list. */
export function resolveCiphers(names: readonly string[]): CipherAlgorithm[] {
  const resolved = [...new Set(names)].map((name) => {
    const cipher = CIPHERS.find((candidate) => candidate.name === name);
    if (!cipher) throw new Error(`unknown cipher ${name}`);
    return cipher;
  });
  if (resolved.length === 0) throw new Error("at least one cipher must be offered");
  return resolved;
}

/**
 * Every cipher authenticates itself, so no MAC is ever used. The list
 * still cannot be empty: some clients refuse a server that offers none
 * before they look at which cipher was chosen.
 */
const MACS = ["hmac-sha2-256", "hmac-sha2-512"] as const;

export interface KexInit {
  readonly kex: readonly string[];
  readonly hostKey: readonly string[];
  readonly cipherClientToServer: readonly string[];
  readonly cipherServerToClient: readonly string[];
  readonly compressionClientToServer: readonly string[];
  readonly compressionServerToClient: readonly string[];
  readonly firstKexPacketFollows: boolean;
}

/** The server's KEXINIT payload. The markers only mean something in a connection's first exchange. */
export function encodeServerKexInit(
  kexMethods: readonly KexMethod[],
  offeredCiphers: readonly CipherAlgorithm[],
  hostKeyAlgorithms: readonly string[],
  initial: boolean,
): Uint8Array {
  const kex = kexMethods.flatMap((method) => method.names);
  const ciphers = offeredCiphers.map((cipher) => cipher.name);
  const cookie = crypto.getRandomValues(new Uint8Array(16));
  return new WireWriter()
    .byte(Msg.KEXINIT)
    .raw(cookie)
    .nameList(initial ? [...kex, STRICT_SERVER] : kex)
    .nameList(hostKeyAlgorithms)
    .nameList(ciphers)
    .nameList(ciphers)
    .nameList(MACS)
    .nameList(MACS)
    .nameList(["none"])
    .nameList(["none"])
    .nameList([])
    .nameList([])
    .boolean(false)
    .uint32(0)
    .finish();
}

export function parseKexInit(payload: Uint8Array): KexInit {
  const reader = new WireReader(payload, 1 + 16);
  const kex = reader.nameList();
  const hostKey = reader.nameList();
  const cipherClientToServer = reader.nameList();
  const cipherServerToClient = reader.nameList();
  reader.nameList(); // MACs, unused: see MACS
  reader.nameList();
  const compressionClientToServer = reader.nameList();
  const compressionServerToClient = reader.nameList();
  reader.nameList(); // languages
  reader.nameList();
  const firstKexPacketFollows = reader.boolean();
  reader.uint32();
  reader.end();
  return {
    kex,
    hostKey,
    cipherClientToServer,
    cipherServerToClient,
    compressionClientToServer,
    compressionServerToClient,
    firstKexPacketFollows,
  };
}

export interface Negotiated {
  readonly kex: KexMethod;
  /** The name the method was chosen under. */
  readonly kexName: string;
  readonly hostKey: string;
  /** Protects what the client sends. */
  readonly cipherIn: CipherAlgorithm;
  /** Protects what the server sends. */
  readonly cipherOut: CipherAlgorithm;
  readonly clientWantsStrictKex: boolean;
  readonly clientWantsExtInfo: boolean;
  /** The client sent a guessed first packet for algorithms that were not chosen; it must be dropped. */
  readonly discardGuess: boolean;
}

/** The first of the client's names the server also has: the client's preference decides. */
function choose(what: string, client: readonly string[], server: readonly string[]): string {
  const chosen = client.find((name) => server.includes(name));
  if (chosen === undefined) {
    throw new SshError(DisconnectReason.KEY_EXCHANGE_FAILED, `no matching ${what} found`);
  }
  return chosen;
}

export function negotiate(
  client: KexInit,
  kexMethods: readonly KexMethod[],
  offeredCiphers: readonly CipherAlgorithm[],
  hostKeyAlgorithms: readonly string[],
): Negotiated {
  const cipherNames = offeredCiphers.map((cipher) => cipher.name);
  const cipherByName = (name: string) => offeredCiphers.find((cipher) => cipher.name === name)!;

  const kexName = choose(
    "key exchange method",
    client.kex,
    kexMethods.flatMap((method) => method.names),
  );
  const hostKey = choose("host key type", client.hostKey, hostKeyAlgorithms);
  const cipherIn = choose("cipher", client.cipherClientToServer, cipherNames);
  const cipherOut = choose("cipher", client.cipherServerToClient, cipherNames);
  choose("compression", client.compressionClientToServer, ["none"]);
  choose("compression", client.compressionServerToClient, ["none"]);

  return {
    kex: kexMethods.find((method) => method.names.includes(kexName))!,
    kexName,
    hostKey,
    cipherIn: cipherByName(cipherIn),
    cipherOut: cipherByName(cipherOut),
    clientWantsStrictKex: client.kex.includes(STRICT_CLIENT),
    clientWantsExtInfo: client.kex.includes(EXT_INFO_CLIENT),
    discardGuess:
      client.firstKexPacketFollows && (client.kex[0] !== kexName || client.hostKey[0] !== hostKey),
  };
}
