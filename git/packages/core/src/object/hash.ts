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

/**
 * An object's id as its 20 raw bytes.
 *
 * Every id is computed by `Sha1`, which refuses content built to collide
 * (`sha1.ts`). WebCrypto's SHA-1 is several times faster and cannot be used
 * here: it has no collision detection, and an id is what the whole store
 * trusts to name one object and no other. The functions stay asynchronous
 * for their callers.
 */
export async function hashObjectBytes(type: ObjectType, data: Uint8Array): Promise<Uint8Array> {
  return new Sha1().update(objectHeader(type, data.length)).update(data).digest();
}

/** An object's id: the SHA-1 of its header and content. */
export async function hashObject(type: ObjectType, data: Uint8Array): Promise<ObjectId> {
  return toHex(await hashObjectBytes(type, data));
}

/** The same id without an await. */
export function hashObjectSync(type: ObjectType, data: Uint8Array): ObjectId {
  return new Sha1().update(objectHeader(type, data.length)).update(data).digestHex();
}
