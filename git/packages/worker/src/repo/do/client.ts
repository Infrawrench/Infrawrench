/**
 * How the rest of the worker talks to a repository's Durable Object:
 * `repoClient(env, repoId)` is the object for that repository with the id
 * already bound, so no caller can pass a stub the wrong one.
 */
import type { GitObject, ObjectId, ObjectType, Ref, RefUpdate } from "@infrawrench/git-core";
import type { RefUpdateResult } from "@infrawrench/git-protocol";
import type { Env } from "../../env";
import { ARCHIVE_URL, type ArchiveCall, CALL_HEADER, type GitCall, SERVE_URL } from "./call";
import type { ReaderReply } from "../queries";
import type { PathEntry, RepoDO } from "./repo-do";
import type { InitOptions, RepoStats, UpdateRefsOptions } from "./repository";

/** The RPC methods of `RepoDO`, each without its leading repository id. */
export interface RepoClient {
  readonly repoId: string;
  init(options?: InitOptions): Promise<{ head: string; commit: ObjectId | null }>;
  destroy(): Promise<{ deletedFiles: number }>;
  forkFrom(sourceRepoId: string): Promise<RepoStats>;
  stats(): Promise<RepoStats>;
  maintain(options?: { readonly force?: boolean }): Promise<{ deleted: number; repacked: boolean }>;
  listRefs(): Promise<{ refs: Ref[]; head: string }>;
  head(): Promise<{ ref: string; oid: ObjectId | null }>;
  setHead(ref: string): Promise<void>;
  updateRefs(
    updates: readonly RefUpdate[],
    options?: UpdateRefsOptions,
  ): Promise<RefUpdateResult[]>;
  readObject(oid: ObjectId): Promise<GitObject | null>;
  readObjects(oids: readonly ObjectId[]): Promise<Array<GitObject | null | undefined>>;
  hasObjects(oids: readonly ObjectId[]): Promise<boolean[]>;
  resolvePrefix(prefix: string): Promise<ObjectId[]>;
  readPath(commit: ObjectId, path: string): Promise<PathEntry | null>;
  writeObjects(
    objects: ReadonlyArray<{ readonly type: ObjectType; readonly data: Uint8Array }>,
  ): Promise<ObjectId[]>;
  /**
   * One `RepoReader` method, run in the object beside the data. `locator` is
   * the owner and name, for URLs. Go through `durableRepoReader`
   * (`../reader-do.ts`), which gives the interface back.
   */
  reader(
    locator: { readonly owner: string; readonly name: string },
    method: string,
    args: readonly unknown[],
  ): Promise<ReaderReply>;
  /**
   * Runs a git conversation: `input` is what the client sends, the response
   * body what the server answers. Both stream, and for SSH both are open at
   * once.
   */
  serve(
    call: Omit<GitCall, "repoId">,
    input: ReadableStream<Uint8Array> | null,
    signal?: AbortSignal,
  ): Promise<Response>;
  /** The commit as a gzipped tar (or a zip) under one directory. 404 when the commit is not there. */
  archive(commit: ObjectId, prefix: string, format?: "tar.gz" | "zip"): Promise<Response>;
}

type Rpc = {
  [K in keyof RepoDO]: RepoDO[K];
};

export function repoClient(env: Pick<Env, "REPO">, repoId: string): RepoClient {
  const stub = env.REPO.get(env.REPO.idFromName(repoId));
  const rpc = stub as unknown as Rpc;
  const send = (url: string, call: unknown, init: RequestInit = {}): Promise<Response> =>
    (stub.fetch as unknown as (url: string, init: RequestInit) => Promise<Response>)(url, {
      method: "POST",
      ...init,
      headers: { [CALL_HEADER]: JSON.stringify(call) },
    });
  return {
    repoId,
    init: (options) => rpc.init(repoId, options),
    destroy: () => rpc.destroy(repoId),
    forkFrom: (sourceRepoId) => rpc.forkFrom(repoId, sourceRepoId),
    stats: () => rpc.stats(repoId),
    maintain: (options) => rpc.maintain(repoId, options),
    listRefs: () => rpc.listRefs(repoId),
    head: () => rpc.head(repoId),
    setHead: (ref) => rpc.setHead(repoId, ref),
    updateRefs: (updates, options) => rpc.updateRefs(repoId, updates, options),
    readObject: (oid) => rpc.readObject(repoId, oid),
    readObjects: (oids) => rpc.readObjects(repoId, oids),
    hasObjects: (oids) => rpc.hasObjects(repoId, oids),
    resolvePrefix: (prefix) => rpc.resolvePrefix(repoId, prefix),
    readPath: (commit, path) => rpc.readPath(repoId, commit, path),
    writeObjects: (objects) => rpc.writeObjects(repoId, objects),
    reader: (locator, method, args) => rpc.reader(repoId, locator, method, args),
    serve: (call, input, signal) =>
      send(SERVE_URL, { ...call, repoId } satisfies GitCall, {
        ...(input ? { body: input, duplex: "half" } : {}),
        ...(signal ? { signal } : {}),
      } as RequestInit),
    archive: (commit, prefix, format) =>
      send(ARCHIVE_URL, {
        repoId,
        commit,
        prefix,
        ...(format ? { format } : {}),
      } satisfies ArchiveCall),
  };
}
