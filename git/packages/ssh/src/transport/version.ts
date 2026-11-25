/**
 * The identification exchange (RFC 4253, section 4.2): one text line from
 * each side before any packet.
 */
import { DisconnectReason, SshError } from "../errors";
import type { ByteReader } from "./byte-reader";

/** The RFC's limit for the line, CR LF included. */
const MAX_LINE = 255;

/**
 * Read the client's identification line and return it without its line
 * ending. Only a client that says it speaks protocol 2.0 gets further.
 *
 * A server may send other lines before its own identification; a client may
 * not, so the first line has to be the one.
 */
export async function readClientVersion(reader: ByteReader): Promise<string> {
  let line = "";
  for (let count = 0; count < MAX_LINE; count++) {
    const next = await reader.read(1);
    if (!next) {
      throw new SshError(
        DisconnectReason.CONNECTION_LOST,
        "connection closed before identification",
      );
    }
    const byte = next[0]!;
    if (byte === 0x0a) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("SSH-2.0-") || line.length === "SSH-2.0-".length) {
        throw new SshError(
          DisconnectReason.PROTOCOL_VERSION_NOT_SUPPORTED,
          "only SSH protocol 2.0 is supported",
        );
      }
      return line;
    }
    // Printable US-ASCII, plus the CR that precedes the LF.
    if (byte !== 0x0d && (byte < 0x20 || byte > 0x7e)) break;
    line += String.fromCharCode(byte);
  }
  throw new SshError(DisconnectReason.PROTOCOL_ERROR, "invalid identification string");
}
