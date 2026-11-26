/**
 * What the front Worker says to a repository's Durable Object when it hands
 * it a git conversation. It travels as one JSON header on an internal
 * `fetch`, whose body is the client's bytes and whose response body is the
 * server's: the two streams the protocol needs, with backpressure both ways.
 */
import type { ServeRequest } from "@infrawrench/git-protocol";
import type { GitEventActor } from "../../env";
import type { PushPolicy } from "./policy";

export const CALL_HEADER = "x-iwg-call";

export interface GitCall {
  readonly repoId: string;
  readonly request: ServeRequest;
  /** Prefix the advertisement with smart HTTP's `# service=` lines. */
  readonly httpPreamble: boolean;
  /** Who is on the other end, for the push event. */
  readonly actor: GitEventActor | null;
  /** Rules for a push. Null for a fetch. */
  readonly policy: PushPolicy | null;
}

export interface ArchiveCall {
  readonly repoId: string;
  readonly commit: string;
  /** The archive's one top-level directory. */
  readonly prefix: string;
  /** Absent means a gzipped tar, which is what CI's machines unpack. */
  readonly format?: "tar.gz" | "zip";
}

/** Paths of the internal `fetch`. The host is never resolved. */
export const SERVE_URL = "https://repo.internal/serve";
export const ARCHIVE_URL = "https://repo.internal/archive";
