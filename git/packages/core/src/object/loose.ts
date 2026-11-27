/** Loose objects: `<type> <size>\0<content>`, zlib-compressed, one file per object. */
import { decodeLatin1 } from "../bytes";
import { GitError } from "../errors";
import type { GitObject, ObjectId } from "../types";
import { deflate, inflate } from "../zlib";
import { isObjectType, objectHeader } from "./hash";

export async function encodeLooseObject(object: GitObject): Promise<Uint8Array> {
  const header = objectHeader(object.type, object.data.length);
  const whole = new Uint8Array(header.length + object.data.length);
  whole.set(header, 0);
  whole.set(object.data, header.length);
  return deflate(whole);
}

/** The largest loose object `decodeLooseObject` inflates unless told otherwise. */
export const MAX_LOOSE_OBJECT_BYTES = 64 * 1024 * 1024;

/** Inflates and splits a loose object, refusing one that inflates past `maxSize` bytes. */
export async function decodeLooseObject(
  compressed: Uint8Array,
  maxSize: number = MAX_LOOSE_OBJECT_BYTES,
): Promise<GitObject> {
  // The header is a few bytes more than the content.
  const object = parseLooseObject(await inflate(compressed, { maxSize: maxSize + 64 }));
  if (object.data.length > maxSize) {
    throw new GitError("limit", `loose object of ${object.data.length} bytes is over the limit`);
  }
  return object;
}

/** Splits an already inflated loose object into its type and content. */
export function parseLooseObject(inflated: Uint8Array): GitObject {
  // The header is short; a missing NUL in the first bytes means this is not an object.
  const nul = inflated.subarray(0, 64).indexOf(0);
  if (nul < 0) throw new GitError("bad-object", "loose object has no header");
  const match = /^([a-z]+) (0|[1-9]\d*)$/.exec(decodeLatin1(inflated.subarray(0, nul)));
  if (!match || !isObjectType(match[1]!)) {
    throw new GitError("bad-object", "loose object has a malformed header");
  }
  const data = inflated.subarray(nul + 1);
  if (Number(match[2]) !== data.length) {
    throw new GitError("bad-object", "loose object is not the size its header says");
  }
  return { type: match[1], data };
}

/** Where git keeps a loose object under `objects/`: `ab/cdef…`. */
export function looseObjectPath(oid: ObjectId): string {
  return `${oid.slice(0, 2)}/${oid.slice(2)}`;
}
