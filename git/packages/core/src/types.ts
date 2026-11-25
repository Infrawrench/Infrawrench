/**
 * The vocabulary every other git package speaks. Nothing here depends on a
 * platform: Web Streams, `Uint8Array` and WebCrypto only, so the same code
 * runs in a Worker, a Durable Object, Node (tests) and a browser.
 */

/** A SHA-1 object id, 40 lowercase hex characters. */
export type ObjectId = string;

export const ZERO_OID: ObjectId = "0000000000000000000000000000000000000000";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

/** A loose object: its type and its uncompressed content (no `<type> <size>\0` header). */
export interface GitObject {
  readonly type: ObjectType;
  readonly data: Uint8Array;
}

/** Read access to an object database. Implemented by storage, consumed by ops and protocol. */
export interface ObjectReader {
  /** The object, or null when the database does not have it. */
  read(oid: ObjectId): Promise<GitObject | null>;
  has(oid: ObjectId): Promise<boolean>;
}

/** A person line in a commit or tag: `Name <email> 1700000000 +0100`. */
export interface Signature {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly timestamp: number;
  /** Offset from UTC in minutes, as written (`+0100` is 60). `-0000` is negative zero. */
  readonly timezoneOffset: number;
  /**
   * The line exactly as stored, set by the parser only when writing the
   * fields above back out would not reproduce it (a missing email, a
   * timezone that is not four digits). Serialising uses it as long as it
   * still parses to these fields, so changing a field drops it.
   */
  readonly raw?: string;
}

export interface Commit {
  readonly tree: ObjectId;
  readonly parents: readonly ObjectId[];
  readonly author: Signature;
  readonly committer: Signature;
  readonly message: string;
  /** `gpgsig` and any other header kept verbatim so a re-serialised commit hashes the same. */
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
  /**
   * True when the object was not valid UTF-8. Every string in it then holds
   * one character per byte (Latin-1), which is lossless, and serialising
   * writes them back the same way. The `encoding` header, when there is one,
   * names what the bytes really are.
   */
  readonly latin1?: boolean;
}

export type TreeEntryMode =
  | "040000" // tree
  | "100644" // blob
  | "100755" // executable blob
  | "120000" // symlink
  | "160000"; // gitlink (submodule)

export interface TreeEntry {
  readonly mode: TreeEntryMode;
  readonly name: string;
  readonly oid: ObjectId;
  /**
   * The mode as stored, set by the parser only when it is not the spelling
   * git writes today (`100664`, a zero-padded `040000`). Serialising uses it
   * as long as it still means `mode`.
   */
  readonly rawMode?: string;
  /**
   * The name's bytes, set by the parser only when they are not valid UTF-8
   * (`name` then has replacement characters). Serialising uses them as long
   * as they still decode to `name`.
   */
  readonly rawName?: Uint8Array;
}

export interface Tag {
  readonly object: ObjectId;
  readonly type: ObjectType;
  readonly tag: string;
  readonly tagger: Signature | null;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
  /** As on `Commit`: the object was not UTF-8 and its strings hold one character per byte. */
  readonly latin1?: boolean;
}

/** A ref as a repository advertises it. */
export interface Ref {
  /** Full name: `HEAD`, `refs/heads/main`, `refs/tags/v1`. */
  readonly name: string;
  readonly oid: ObjectId;
  /** For an annotated tag, the object it finally points at (`^{}`). */
  readonly peeled?: ObjectId;
  /** For a symbolic ref (HEAD), the ref it points at. */
  readonly symref?: string;
}

/** One requested ref change, as a push or a server-side operation asks for it. */
export interface RefUpdate {
  readonly name: string;
  /** ZERO_OID to create. */
  readonly oldOid: ObjectId;
  /** ZERO_OID to delete. */
  readonly newOid: ObjectId;
}
