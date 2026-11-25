/**
 * What the packet layer needs from a cipher. One instance protects one
 * direction with one set of keys; a key exchange replaces it.
 */
export interface PacketCipher {
  /** The padded part of a packet is a multiple of this many bytes. */
  readonly blockSize: number;
  /** Bytes of authentication tag after the packet. */
  readonly tagLength: number;
  /**
   * Whether the four length bytes count towards the padded part. They do
   * without encryption; the AEAD modes authenticate them separately and pad
   * only what follows.
   */
  readonly lengthIsPadded: boolean;
  /** `packet_length` from the first four bytes on the wire. */
  readLength(sequence: number, header: Uint8Array): number;
  /**
   * Authenticate and decrypt. `body` is the `packet_length` bytes after the
   * header plus the tag. Resolves with `padding_length || payload || padding`
   * and rejects with a MAC error when the packet was tampered with.
   */
  open(sequence: number, header: Uint8Array, body: Uint8Array): Promise<Uint8Array>;
  /** `packet` is a whole cleartext packet, length field included; resolves with its bytes for the wire. */
  seal(sequence: number, packet: Uint8Array): Promise<Uint8Array>;
}

export interface CipherAlgorithm {
  readonly name: string;
  readonly keyLength: number;
  readonly ivLength: number;
  create(key: Uint8Array, iv: Uint8Array, direction: "seal" | "open"): Promise<PacketCipher>;
}

export function readUint32(bytes: Uint8Array): number {
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}
