import { GitError } from "./errors";
import type { ObjectId } from "./types";

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));

export function toHex(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = "";
  for (let i = start; i < end; i++) out += HEX[bytes[i]!];
  return out;
}

function nibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new GitError("bad-object", "hex string has an odd length");
  const out = new Uint8Array(hex.length / 2);
  writeHex(hex, out, 0);
  return out;
}

/** Decodes `hex` into `target` at `offset`, for filling a table of ids without allocating. */
export function writeHex(hex: string, target: Uint8Array, offset: number): void {
  for (let i = 0; i < hex.length; i += 2) {
    const hi = nibble(hex.charCodeAt(i));
    const lo = nibble(hex.charCodeAt(i + 1));
    if (hi < 0 || lo < 0) throw new GitError("bad-object", "not a hex string");
    target[offset + (i >> 1)] = (hi << 4) | lo;
  }
}

const OID_PATTERN = /^[0-9a-f]{40}$/;

/** True for a full SHA-1 id as git writes it: 40 lowercase hex characters. */
export function isObjectId(value: string): value is ObjectId {
  return OID_PATTERN.test(value);
}

export function oidToBytes(oid: ObjectId): Uint8Array {
  if (!isObjectId(oid)) throw new GitError("bad-object", `not an object id: ${oid}`);
  return fromHex(oid);
}

export function oidFromBytes(bytes: Uint8Array, offset = 0): ObjectId {
  if (offset + 20 > bytes.length) throw new GitError("bad-object", "object id runs past the end");
  return toHex(bytes, offset, offset + 20);
}
