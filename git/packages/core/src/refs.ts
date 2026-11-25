/** Ref names (the rules of `git check-ref-format`), symbolic refs, and peeling. */
import { compareBytes, encodeText } from "./bytes";
import { GitError } from "./errors";
import { isObjectId } from "./hex";
import { parseCommit } from "./object/commit";
import { parseTag } from "./object/tag";
import type { ObjectId, ObjectReader, ObjectType, Ref } from "./types";

export interface RefNameOptions {
  /** Accept a name with no slash (`HEAD`, `main`). Git's `--allow-onelevel`. */
  readonly allowOneLevel?: boolean;
  /** Accept one `*` in the whole name, as a refspec pattern has. Git's `--refspec-pattern`. */
  readonly refspecPattern?: boolean;
}

/**
 * True when `git check-ref-format` accepts the name. The rules, from
 * git's refs.c:
 *
 * - no component starts with `.` or ends with `.lock`, and none is empty
 *   (so no leading or trailing `/` and no `//`);
 * - no `..` and no `@{` anywhere, and the name is not just `@`;
 * - no control character, space, `~`, `^`, `:`, `?`, `[`, `\` or `*`;
 * - it does not end with `.`;
 * - it has at least two components unless `allowOneLevel`.
 */
export function isValidRefName(name: string, options: RefNameOptions = {}): boolean {
  if (name === "" || name === "@") return false;
  if (name.endsWith(".")) return false;
  let components = 0;
  let stars = 0;
  let start = 0;
  for (let i = 0; i <= name.length; i++) {
    const code = i < name.length ? name.charCodeAt(i) : 0x2f;
    if (code === 0x2f) {
      if (i === start) return false;
      if (name.charCodeAt(start) === 0x2e) return false;
      if (i - start >= 5 && name.startsWith(".lock", i - 5)) return false;
      components++;
      start = i + 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) return false;
    switch (code) {
      case 0x20: // space
      case 0x7e: // ~
      case 0x5e: // ^
      case 0x3a: // :
      case 0x3f: // ?
      case 0x5b: // [
      case 0x5c: // backslash
        return false;
      case 0x2a: // *
        if (!options.refspecPattern || ++stars > 1) return false;
        break;
      case 0x2e: // .
        if (name.charCodeAt(i + 1) === 0x2e) return false;
        break;
      case 0x40: // @
        if (name.charCodeAt(i + 1) === 0x7b) return false;
        break;
      default:
        break;
    }
  }
  return components >= 2 || options.allowOneLevel === true;
}

/** Throws unless the name is a valid ref name. */
export function assertValidRefName(name: string, options: RefNameOptions = {}): void {
  if (!isValidRefName(name, options)) {
    throw new GitError("bad-ref", `not a valid ref name: ${JSON.stringify(name)}`);
  }
}

/**
 * True for a name `git check-ref-format --branch` accepts: valid under
 * `refs/heads/`, not starting with `-` (it would read as an option) and not
 * `HEAD`.
 */
export function isValidBranchName(name: string): boolean {
  if (name.startsWith("-") || name === "HEAD") return false;
  return isValidRefName(`refs/heads/${name}`);
}

/** Tags follow the same rule; git only objects to the leading `-` and to `HEAD`. */
export function isValidTagName(name: string): boolean {
  if (name.startsWith("-") || name === "HEAD") return false;
  return isValidRefName(`refs/tags/${name}`);
}

export const HEADS_PREFIX = "refs/heads/";
export const TAGS_PREFIX = "refs/tags/";

export function branchRef(branch: string): string {
  return `${HEADS_PREFIX}${branch}`;
}

export function tagRef(tag: string): string {
  return `${TAGS_PREFIX}${tag}`;
}

export type RefKind = "head" | "branch" | "tag" | "remote" | "note" | "other";

export function refKind(name: string): RefKind {
  if (name === "HEAD") return "head";
  if (name.startsWith(HEADS_PREFIX)) return "branch";
  if (name.startsWith(TAGS_PREFIX)) return "tag";
  if (name.startsWith("refs/remotes/")) return "remote";
  if (name.startsWith("refs/notes/")) return "note";
  return "other";
}

/** The name people use for a ref: `main` for `refs/heads/main`, `v1` for `refs/tags/v1`. */
export function shortRefName(name: string): string {
  for (const prefix of [HEADS_PREFIX, TAGS_PREFIX, "refs/remotes/"]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name.startsWith("refs/") ? name.slice(5) : name;
}

/** The order git lists refs in: by the bytes of the name. */
export function compareRefNames(a: string, b: string): number {
  return compareBytes(encodeText(a), encodeText(b));
}

/**
 * The target of a symbolic ref as stored (`ref: refs/heads/main`), or null
 * when the content is not one.
 */
export function parseSymbolicRef(content: string): string | null {
  const match = /^ref:[ \t]*(.+?)\s*$/.exec(content);
  if (!match) return null;
  const target = match[1]!;
  return isValidRefName(target, { allowOneLevel: true }) ? target : null;
}

export function formatSymbolicRef(target: string): string {
  assertValidRefName(target, { allowOneLevel: true });
  return `ref: ${target}\n`;
}

/** What a ref store holds under one name. */
export type StoredRef =
  | { readonly oid: ObjectId; readonly symref?: undefined }
  | { readonly symref: string; readonly oid?: undefined };

export interface ResolvedRef {
  /** The ref that finally holds the id, after following symbolic refs. */
  readonly name: string;
  readonly oid: ObjectId;
}

/**
 * Follows symbolic refs from `name` to an id. Null when the chain ends at a
 * ref that does not exist, which is the state of `HEAD` in an empty
 * repository. Git gives up after five hops; so does this.
 */
export async function resolveRef(
  lookup: (name: string) => Promise<StoredRef | null> | StoredRef | null,
  name: string,
  maxDepth = 5,
): Promise<ResolvedRef | null> {
  let current = name;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const stored = await lookup(current);
    if (!stored) return null;
    if (stored.symref === undefined) {
      if (!isObjectId(stored.oid)) throw new GitError("bad-ref", `ref ${current} holds no id`);
      return { name: current, oid: stored.oid };
    }
    current = stored.symref;
  }
  throw new GitError("bad-ref", `symbolic ref ${name} is nested too deeply`);
}

export interface PeeledObject {
  readonly oid: ObjectId;
  readonly type: ObjectType;
}

/**
 * Follows annotated tags from `oid` to the first object that is not a tag
 * (`<oid>^{}`). Tags can point at tags; a chain past `maxDepth` is refused
 * rather than followed forever.
 */
export async function peelTags(
  reader: ObjectReader,
  oid: ObjectId,
  maxDepth = 32,
): Promise<PeeledObject> {
  let current = oid;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const object = await reader.read(current);
    if (!object) throw new GitError("missing-object", `object ${current} is missing`);
    if (object.type !== "tag") return { oid: current, type: object.type };
    current = parseTag(object.data).object;
  }
  throw new GitError("bad-object", `tag ${oid} is nested too deeply`);
}

/** The commit a ref's id leads to through tags, or null when it leads to a tree or blob. */
export async function peelToCommit(reader: ObjectReader, oid: ObjectId): Promise<ObjectId | null> {
  const peeled = await peelTags(reader, oid);
  return peeled.type === "commit" ? peeled.oid : null;
}

/** The tree an id leads to, through tags and then a commit (`<oid>^{tree}`). */
export async function peelToTree(reader: ObjectReader, oid: ObjectId): Promise<ObjectId | null> {
  const peeled = await peelTags(reader, oid);
  if (peeled.type === "tree") return peeled.oid;
  if (peeled.type !== "commit") return null;
  const commit = await reader.read(peeled.oid);
  return commit ? parseCommit(commit.data).tree : null;
}

/**
 * The ref with `peeled` filled in when it points at an annotated tag, as a
 * ref advertisement lists it (`<name>^{}`).
 */
export async function peelRef(reader: ObjectReader, ref: Ref): Promise<Ref> {
  const object = await reader.read(ref.oid);
  if (!object || object.type !== "tag") return ref;
  const peeled = await peelTags(reader, ref.oid);
  return { ...ref, peeled: peeled.oid };
}
