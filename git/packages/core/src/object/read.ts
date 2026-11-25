/** Typed reads over an `ObjectReader`: the object, parsed, or an error that says what was wrong. */
import { GitError } from "../errors";
import type { Commit, ObjectId, ObjectReader, ObjectType, Tag, TreeEntry } from "../types";
import { parseCommit } from "./commit";
import { parseTag } from "./tag";
import { parseTree } from "./tree";

export async function readObjectOfType(
  reader: ObjectReader,
  oid: ObjectId,
  type: ObjectType,
): Promise<Uint8Array> {
  const object = await reader.read(oid);
  if (!object) throw new GitError("missing-object", `object ${oid} is missing`);
  if (object.type !== type) {
    throw new GitError("bad-object", `object ${oid} is a ${object.type}, not a ${type}`);
  }
  return object.data;
}

export async function readCommit(reader: ObjectReader, oid: ObjectId): Promise<Commit> {
  return parseCommit(await readObjectOfType(reader, oid, "commit"));
}

export async function readTree(reader: ObjectReader, oid: ObjectId): Promise<TreeEntry[]> {
  return parseTree(await readObjectOfType(reader, oid, "tree"));
}

export async function readTag(reader: ObjectReader, oid: ObjectId): Promise<Tag> {
  return parseTag(await readObjectOfType(reader, oid, "tag"));
}

export async function readBlob(reader: ObjectReader, oid: ObjectId): Promise<Uint8Array> {
  return readObjectOfType(reader, oid, "blob");
}
