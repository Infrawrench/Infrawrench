/**
 * `chacha20-poly1305@openssh.com` (OpenSSH's PROTOCOL.chacha20poly1305).
 *
 * The 64 bytes of key material are two ChaCha20 keys: the first encrypts the
 * packet, the second only the four length bytes, so a receiver can learn how
 * much to read before it can check the tag. The nonce is the packet sequence
 * number. Block zero of the main key's stream is the one-time Poly1305 key;
 * the packet is encrypted from block one. The tag covers the encrypted
 * length and the encrypted packet.
 */
import { constantTimeEqual } from "../bytes";
import { DisconnectReason, SshError } from "../errors";
import { chacha20Xor, chachaKey } from "./chacha20";
import { type CipherAlgorithm, type PacketCipher, readUint32 } from "./cipher";
import { Poly1305 } from "./poly1305";

const TAG_LENGTH = 16;
const ZERO_BLOCK = new Uint8Array(32);

/**
 * The sequence number as the last state word. It goes into the eight nonce
 * bytes big-endian and the cipher reads those as little-endian words, so the
 * low half of the nonce (word 14) is zero and word 15 is the byte-swapped
 * number.
 */
function nonceWord(sequence: number): number {
  return (
    ((sequence & 0xff) << 24) |
    ((sequence & 0xff00) << 8) |
    ((sequence >>> 8) & 0xff00) |
    (sequence >>> 24)
  );
}

class ChaCha20Poly1305Cipher implements PacketCipher {
  readonly blockSize = 8;
  readonly tagLength = TAG_LENGTH;
  readonly lengthIsPadded = false;
  private readonly mainKey: Uint32Array;
  private readonly headerKey: Uint32Array;

  constructor(key: Uint8Array) {
    this.mainKey = chachaKey(key.subarray(0, 32));
    this.headerKey = chachaKey(key.subarray(32, 64));
  }

  readLength(sequence: number, header: Uint8Array): number {
    const clear = new Uint8Array(4);
    chacha20Xor(this.headerKey, 0, 0, 0, nonceWord(sequence), header, clear);
    return readUint32(clear);
  }

  open(sequence: number, header: Uint8Array, body: Uint8Array): Promise<Uint8Array> {
    const nonce = nonceWord(sequence);
    const split = body.length - TAG_LENGTH;
    const ciphertext = body.subarray(0, split);
    const expected = this.mac(nonce).update(header).update(ciphertext).finish();
    // The tag is checked before a single byte is decrypted.
    if (!constantTimeEqual(expected, body.subarray(split))) {
      return Promise.reject(
        new SshError(DisconnectReason.MAC_ERROR, "packet integrity check failed"),
      );
    }
    const clear = new Uint8Array(split);
    chacha20Xor(this.mainKey, 1, 0, 0, nonce, ciphertext, clear);
    return Promise.resolve(clear);
  }

  seal(sequence: number, packet: Uint8Array): Promise<Uint8Array> {
    const nonce = nonceWord(sequence);
    const out = new Uint8Array(packet.length + TAG_LENGTH);
    const sealed = out.subarray(0, packet.length);
    chacha20Xor(this.headerKey, 0, 0, 0, nonce, packet.subarray(0, 4), sealed.subarray(0, 4));
    chacha20Xor(this.mainKey, 1, 0, 0, nonce, packet.subarray(4), sealed.subarray(4));
    out.set(this.mac(nonce).update(sealed).finish(), packet.length);
    return Promise.resolve(out);
  }

  private mac(nonce: number): Poly1305 {
    const key = new Uint8Array(32);
    chacha20Xor(this.mainKey, 0, 0, 0, nonce, ZERO_BLOCK, key);
    return new Poly1305(key);
  }
}

export const chacha20Poly1305: CipherAlgorithm = {
  name: "chacha20-poly1305@openssh.com",
  keyLength: 64,
  // The nonce is the sequence number, so no IV is derived for this cipher.
  ivLength: 0,
  create: (key) => Promise.resolve(new ChaCha20Poly1305Cipher(key)),
};
