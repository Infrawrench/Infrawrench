import { encodeText } from "../bytes";
import { toHex } from "../hex";
import { Sha1 } from "../sha1";
import type { ObjectId, ObjectType } from "../types";

const TYPES: ReadonlySet<string> = new Set(["commit", "tree", "blob", "tag"]);

export function isObjectType(value: string): value is ObjectType {
  return TYPES.has(value);
}

/** The `<type> <size>\0` prefix an object is hashed (and stored loose) with. */
export function objectHeader(type: ObjectType, size: number): Uint8Array {
  return encodeText(`${type} ${size}\0`);
}

/** An object's id as its 20 raw bytes, through WebCrypto. */
export async function hashObjectBytes(type: ObjectType, data: Uint8Array): Promise<Uint8Array> {
  const header = objectHeader(type, data.length);
  // One copy: `digest` takes a single buffer, and copying is far cheaper than hashing.
  const whole = new Uint8Array(header.length + data.length);
  whole.set(header, 0);
  whole.set(data, header.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-1", whole));
}

/** An object's id: the SHA-1 of its header and content, through WebCrypto. */
export async function hashObject(type: ObjectType, data: Uint8Array): Promise<ObjectId> {
  return toHex(await hashObjectBytes(type, data));
}

/**
 * The same id without a copy or an await. This is the one to use in a loop
 * over many small objects, where a WebCrypto round trip per object costs
 * more than the hashing does.
 */
export function hashObjectSync(type: ObjectType, data: Uint8Array): ObjectId {
  return new Sha1().update(objectHeader(type, data.length)).update(data).digestHex();
}
