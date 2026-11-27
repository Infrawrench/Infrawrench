/**
 * The header block commits and tags share: `key value` lines, a value
 * continued on following lines that start with a space (how `gpgsig` and
 * `mergetag` carry multi-line text), then a blank line and the message.
 */
import { decodeLatin1, decodeTextStrict, encodeLatin1, encodeText } from "../bytes";
import { GitError } from "../errors";

export interface HeaderBlock {
  readonly headers: Array<[string, string]>;
  readonly message: string;
  /** The bytes were not UTF-8, so the strings hold one character per byte. */
  readonly latin1: boolean;
}

export function parseHeaderBlock(data: Uint8Array, kind: string): HeaderBlock {
  const strict = decodeTextStrict(data);
  const text = strict ?? decodeLatin1(data);
  const headers: Array<[string, string]> = [];
  let message = "";
  let position = 0;
  while (position < text.length) {
    if (text.charCodeAt(position) === 10) {
      message = text.slice(position + 1);
      break;
    }
    const newline = text.indexOf("\n", position);
    const line = newline < 0 ? text.slice(position) : text.slice(position, newline);
    position = newline < 0 ? text.length : newline + 1;
    if (line.startsWith(" ")) {
      const last = headers[headers.length - 1];
      if (!last) throw new GitError("bad-object", `${kind} starts with a continuation line`);
      last[1] += `\n${line.slice(1)}`;
      continue;
    }
    const space = line.indexOf(" ");
    if (space < 0) headers.push([line, ""]);
    else headers.push([line.slice(0, space), line.slice(space + 1)]);
  }
  return { headers, message, latin1: strict === null };
}

export function serializeHeaderBlock(block: HeaderBlock): Uint8Array {
  let text = "";
  for (const [key, value] of block.headers) {
    text += `${key} ${value.replaceAll("\n", "\n ")}\n`;
  }
  text += `\n${block.message}`;
  return block.latin1 ? encodeLatin1(text) : encodeText(text);
}
