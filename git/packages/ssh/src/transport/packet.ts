/**
 * The binary packet (RFC 4253, section 6), before and after a cipher:
 *
 *   uint32 packet_length, byte padding_length, payload, random padding
 */
import { EMPTY } from "../bytes";
import { protocolError } from "../errors";
import type { PacketCipher } from "../cipher/cipher";

/**
 * The largest `packet_length` accepted, the same bound OpenSSH uses. It is
 * checked before the packet is read, so it is also the most a peer can make
 * the server hold for one packet.
 */
export const MAX_PACKET_LENGTH = 256 * 1024;

/** A padding length byte, at least one payload byte and the minimum four bytes of padding. */
const MIN_PACKET_LENGTH = 6;

type Framing = Pick<PacketCipher, "blockSize" | "lengthIsPadded">;

/**
 * A cleartext packet around `payload`, padded for `cipher`. `tail` is more
 * payload to follow it: channel data goes straight from the caller's buffer
 * into the packet, without first being joined to its message header.
 */
export function framePacket(
  payload: Uint8Array,
  cipher: Framing,
  tail: Uint8Array = EMPTY,
): Uint8Array {
  const payloadLength = payload.length + tail.length;
  const block = Math.max(8, cipher.blockSize);
  const covered = 1 + payloadLength + (cipher.lengthIsPadded ? 4 : 0);
  let padding = block - (covered % block);
  if (padding < 4) padding += block;
  const packetLength = 1 + payloadLength + padding;
  const packet = new Uint8Array(4 + packetLength);
  packet[0] = packetLength >>> 24;
  packet[1] = packetLength >>> 16;
  packet[2] = packetLength >>> 8;
  packet[3] = packetLength;
  packet[4] = padding;
  packet.set(payload, 5);
  packet.set(tail, 5 + payload.length);
  crypto.getRandomValues(packet.subarray(5 + payloadLength));
  return packet;
}

/** Refuse a `packet_length` no well-formed packet under `cipher` could have. */
export function checkPacketLength(length: number, cipher: Framing): void {
  if (length < MIN_PACKET_LENGTH || length > MAX_PACKET_LENGTH) {
    throw protocolError("invalid packet length");
  }
  const block = Math.max(8, cipher.blockSize);
  if ((length + (cipher.lengthIsPadded ? 4 : 0)) % block !== 0) {
    throw protocolError("invalid packet length");
  }
}

/** The payload inside `padding_length || payload || padding`, as a view. */
export function unframePacket(body: Uint8Array): Uint8Array {
  const padding = body[0]!;
  const payloadLength = body.length - 1 - padding;
  if (padding < 4 || payloadLength < 1) throw protocolError("invalid padding length");
  return body.subarray(1, 1 + payloadLength);
}
