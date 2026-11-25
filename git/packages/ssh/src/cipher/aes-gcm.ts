/**
 * `aes128-gcm@openssh.com` and `aes256-gcm@openssh.com` (RFC 5647 as OpenSSH
 * deploys it): the length field is sent in the clear as associated data, the
 * rest of the packet is encrypted, and a 16-byte tag follows.
 */
import { source } from "../bytes";
import { DisconnectReason, SshError } from "../errors";
import { type CipherAlgorithm, type PacketCipher, readUint32 } from "./cipher";

const TAG_LENGTH = 16;

class AesGcmCipher implements PacketCipher {
  readonly blockSize = 16;
  readonly tagLength = TAG_LENGTH;
  readonly lengthIsPadded = false;
  private readonly nonce: Uint8Array<ArrayBuffer>;

  constructor(
    private readonly key: CryptoKey,
    iv: Uint8Array,
  ) {
    this.nonce = new Uint8Array(iv);
  }

  readLength(_sequence: number, header: Uint8Array): number {
    return readUint32(header);
  }

  async open(_sequence: number, header: Uint8Array, body: Uint8Array): Promise<Uint8Array> {
    const params = this.nextParams(header);
    try {
      return new Uint8Array(await crypto.subtle.decrypt(params, this.key, source(body)));
    } catch {
      throw new SshError(DisconnectReason.MAC_ERROR, "packet integrity check failed");
    }
  }

  async seal(_sequence: number, packet: Uint8Array): Promise<Uint8Array> {
    const params = this.nextParams(packet.subarray(0, 4));
    const sealed = await crypto.subtle.encrypt(params, this.key, source(packet.subarray(4)));
    const out = new Uint8Array(4 + sealed.byteLength);
    out.set(packet.subarray(0, 4), 0);
    out.set(new Uint8Array(sealed), 4);
    return out;
  }

  /**
   * The nonce is four fixed bytes and an eight-byte counter that goes up by
   * one per packet, independent of the SSH sequence number. It is copied and
   * advanced before the first await, so two packets can never share one even
   * if their encryptions overlap.
   */
  private nextParams(lengthField: Uint8Array): AesGcmParams {
    const iv = this.nonce.slice();
    for (let i = 11; i >= 4; i--) {
      this.nonce[i] = (this.nonce[i]! + 1) & 0xff;
      if (this.nonce[i] !== 0) break;
    }
    return {
      name: "AES-GCM",
      iv,
      additionalData: source(lengthField),
      tagLength: TAG_LENGTH * 8,
    };
  }
}

function aesGcm(name: string, keyLength: number): CipherAlgorithm {
  return {
    name,
    keyLength,
    ivLength: 12,
    async create(key, iv, direction) {
      const imported = await crypto.subtle.importKey("raw", source(key), "AES-GCM", false, [
        direction === "seal" ? "encrypt" : "decrypt",
      ]);
      return new AesGcmCipher(imported, iv);
    },
  };
}

export const aes128Gcm = aesGcm("aes128-gcm@openssh.com", 16);
export const aes256Gcm = aesGcm("aes256-gcm@openssh.com", 32);
