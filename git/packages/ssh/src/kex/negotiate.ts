/**
 * `SSH_MSG_KEXINIT` (RFC 4253, section 7.1): each side's algorithm lists and
 * the rule that picks one from them.
 */
import { aes128Gcm, aes256Gcm } from "../cipher/aes-gcm";
import { chacha20Poly1305 } from "../cipher/chacha20-poly1305";
import type { CipherAlgorithm } from "../cipher/cipher";
import { DisconnectReason, SshError } from "../errors";
import { Msg } from "../messages";
import { WireReader, WireWriter } from "../wire";

export const KEX_ALGORITHMS = ["curve25519-sha256", "curve25519-sha256@libssh.org"] as const;

/** A client that lists this wants the server's extension message (RFC 8308). */
const EXT_INFO_CLIENT = "ext-info-c";
/** Strict key exchange, OpenSSH's countermeasure to the Terrapin prefix-truncation attack. */
const STRICT_CLIENT = "kex-strict-c-v00@openssh.com";
const STRICT_SERVER = "kex-strict-s-v00@openssh.com";

/**
 * In the server's order of preference. AES-GCM comes first because WebCrypto
 * runs it natively; ChaCha20-Poly1305 is this package's own TypeScript.
 */
export const CIPHERS: readonly CipherAlgorithm[] = [aes256Gcm, aes128Gcm, chacha20Poly1305];

/**
 * Every cipher above authenticates itself, so no MAC is ever used. The list
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
  hostKeyAlgorithms: readonly string[],
  initial: boolean,
): Uint8Array {
  const ciphers = CIPHERS.map((cipher) => cipher.name);
  const cookie = crypto.getRandomValues(new Uint8Array(16));
  return new WireWriter()
    .byte(Msg.KEXINIT)
    .raw(cookie)
    .nameList(initial ? [...KEX_ALGORITHMS, STRICT_SERVER] : KEX_ALGORITHMS)
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
  readonly kex: string;
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

export function negotiate(client: KexInit, hostKeyAlgorithms: readonly string[]): Negotiated {
  const cipherNames = CIPHERS.map((cipher) => cipher.name);
  const cipherByName = (name: string) => CIPHERS.find((cipher) => cipher.name === name)!;

  const kex = choose("key exchange method", client.kex, KEX_ALGORITHMS);
  const hostKey = choose("host key type", client.hostKey, hostKeyAlgorithms);
  const cipherIn = choose("cipher", client.cipherClientToServer, cipherNames);
  const cipherOut = choose("cipher", client.cipherServerToClient, cipherNames);
  choose("compression", client.compressionClientToServer, ["none"]);
  choose("compression", client.compressionServerToClient, ["none"]);

  return {
    kex,
    hostKey,
    cipherIn: cipherByName(cipherIn),
    cipherOut: cipherByName(cipherOut),
    clientWantsStrictKex: client.kex.includes(STRICT_CLIENT),
    clientWantsExtInfo: client.kex.includes(EXT_INFO_CLIENT),
    discardGuess:
      client.firstKexPacketFollows && (client.kex[0] !== kex || client.hostKey[0] !== hostKey),
  };
}
