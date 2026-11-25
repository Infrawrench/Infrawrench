import { type PacketCipher, readUint32 } from "./cipher";

/** The cleartext framing every connection starts in, until the first key exchange finishes. */
export const cleartext: PacketCipher = {
  blockSize: 8,
  tagLength: 0,
  lengthIsPadded: true,
  readLength: (_sequence, header) => readUint32(header),
  open: (_sequence, _header, body) => Promise.resolve(body),
  seal: (_sequence, packet) => Promise.resolve(packet),
};
