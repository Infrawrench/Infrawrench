import { GitError } from "../errors";
import { isObjectId } from "../hex";
import { formatSignature, parseSignature } from "../signature";
import type { ObjectType, Tag } from "../types";
import { parseHeaderBlock, serializeHeaderBlock } from "./headers";
import { isObjectType } from "./hash";

/**
 * Parses an annotated tag. `tagger` is optional because tags older than git
 * 1.5 have none. A PGP signature is not a header here: it is the tail of the
 * message, and stays there.
 */
export function parseTag(data: Uint8Array): Tag {
  const { headers, message, latin1 } = parseHeaderBlock(data, "tag");
  let index = 0;
  const take = (key: string): string | null =>
    headers[index]?.[0] === key ? headers[index++]![1] : null;

  const object = take("object");
  if (object === null || !isObjectId(object)) {
    throw new GitError("bad-object", "tag has no object id");
  }
  const type = take("type");
  if (type === null || !isObjectType(type)) throw new GitError("bad-object", "tag has no type");
  const name = take("tag");
  if (name === null) throw new GitError("bad-object", "tag has no name");
  const tagger = take("tagger");
  const tag: Tag = {
    object,
    type,
    tag: name,
    tagger: tagger === null ? null : parseSignature(tagger),
    message,
    extraHeaders: headers.slice(index),
  };
  return latin1 ? { ...tag, latin1: true } : tag;
}

export function serializeTag(tag: Tag): Uint8Array {
  const headers: Array<[string, string]> = [
    ["object", tag.object],
    ["type", tag.type satisfies ObjectType],
    ["tag", tag.tag],
  ];
  if (tag.tagger) headers.push(["tagger", formatSignature(tag.tagger)]);
  for (const [key, value] of tag.extraHeaders) headers.push([key, value]);
  return serializeHeaderBlock({ headers, message: tag.message, latin1: tag.latin1 === true });
}
