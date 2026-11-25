/** Making commit objects: who, when, and a message in the shape git stores. */
import {
  type Commit,
  GitError,
  type ObjectId,
  type Signature,
  hashObjectSync,
  serializeCommit,
} from "@infrawrench/git-core";
import type { NewObject } from "./sink";

export interface Identity {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. Default: now. */
  readonly timestamp?: number;
  /** Minutes east of UTC. Default 0. */
  readonly timezoneOffset?: number;
}

/** Characters git strips from the ends of a name or email, and the ones it removes anywhere. */
function clean(text: string): string {
  return text
    .replace(/[<>\n\0]/g, "")
    .replace(/^[\s.,:;"\\']+/, "")
    .replace(/[\s.,:;"\\']+$/, "");
}

/** A person line for a new commit. Throws when there is no name or email left after cleaning. */
export function signature(identity: Identity, now: () => number = Date.now): Signature {
  const name = clean(identity.name);
  const email = clean(identity.email);
  if (name === "") throw new GitError("bad-object", "a commit needs an author name");
  return {
    name,
    email,
    timestamp: identity.timestamp ?? Math.floor(now() / 1000),
    timezoneOffset: identity.timezoneOffset ?? 0,
  };
}

/**
 * A message the way `git commit` stores it: no trailing whitespace on any
 * line, no blank lines at the start or end, runs of blank lines collapsed
 * to one, and a single newline at the end.
 */
export function normalizeMessage(message: string): string {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let blank = false;
  for (const raw of lines) {
    const line = raw.replace(/[ \t\v\f]+$/, "");
    if (line === "") {
      blank = out.length > 0;
      continue;
    }
    if (blank) out.push("");
    blank = false;
    out.push(line);
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

export interface CommitFields {
  readonly tree: ObjectId;
  readonly parents: readonly ObjectId[];
  readonly author: Signature;
  readonly committer: Signature;
  /** Stored as given: pass it through `normalizeMessage` when it came from a person. */
  readonly message: string;
  readonly extraHeaders?: Commit["extraHeaders"];
  readonly latin1?: boolean;
}

/** Serialises a commit and names it. Nothing is stored: the caller writes the object. */
export function createCommit(fields: CommitFields): NewObject {
  const data = serializeCommit({
    tree: fields.tree,
    parents: fields.parents,
    author: fields.author,
    committer: fields.committer,
    message: fields.message,
    extraHeaders: fields.extraHeaders ?? [],
    ...(fields.latin1 ? { latin1: true } : {}),
  });
  return { oid: hashObjectSync("commit", data), type: "commit", data };
}
