/**
 * `RepoDO`: one Durable Object per repository (`idFromName(repoId)`).
 *
 * It is a thin shell around `Repository` (`./repository.ts`), which holds
 * the storage logic. This file is what is Cloudflare about it: the RPC
 * methods other parts of the worker call, the internal `fetch` a git
 * conversation arrives on, and the alarm.
 *
 * Every RPC method takes the repository id first. A Durable Object is not
 * told the name it was looked up by, and the id is the R2 prefix, so the
 * caller says it and the object checks it is always the same one. Use
 * `repoClient` (`./client.ts`) rather than the stub directly.
 */
import { DurableObject } from "cloudflare:workers";
import type {
  Request as CfRequest,
  Response as CfResponse,
  DurableObjectState,
} from "@cloudflare/workers-types/index";
import {
  type GitObject,
  type ObjectId,
  type ObjectType,
  type Ref,
  type RefUpdate,
  concatBytes,
  findTreeEntry,
  parseCommit,
  parseTree,
  peelTags,
} from "@infrawrench/git-core";
import {
  type RefUpdateResult,
  type ServeStats,
  infoRefsPreamble,
  newServeStats,
  serve,
} from "@infrawrench/git-protocol";
import { zipArchive } from "@infrawrench/git-ops";
import type { Env } from "../../env";
import { describeError } from "../../http/log";
import type { MirrorPlan, MirrorPlanOptions } from "../../mirror/plan";
import { tarArchive } from "./archive";
import { bigReads } from "./big-reads";
import { ARCHIVE_URL, type ArchiveCall, CALL_HEADER, type GitCall, SERVE_URL } from "./call";
import { type ReaderReply, ReaderState, callReader, localRepoReader } from "../queries";
import { REPO_LOCATION } from "./client";
import type { Bucket, RepoStorage } from "./platform";
import {
  type ForkManifest,
  type InitOptions,
  type PeerRepository,
  type RepoStats,
  Repository,
  type UpdateRefsOptions,
} from "./repository";

/** Most objects, and most bytes of them, one `readObjects` call returns: an RPC result is capped at 32 MiB. */
const READ_BATCH_OBJECTS = 256;
const READ_BATCH_BYTES = 16 * 1024 * 1024;

export interface PathEntry {
  readonly oid: ObjectId;
  /** The tree entry's mode; `040000` for a directory, and for the root. */
  readonly mode: string;
  readonly object: GitObject;
}

/** The methods one repository's object calls on another's. */
interface PeerStub {
  listRefs(repoId: string): Promise<{ refs: Ref[]; head: string }>;
  forkManifest(repoId: string): Promise<ForkManifest>;
  exportPack(
    repoId: string,
    wants: readonly ObjectId[],
    haves: readonly ObjectId[],
  ): Promise<ReadableStream<Uint8Array> | null>;
}

export class RepoDO extends DurableObject<Env> {
  private readonly repository: Repository;
  /** What the reader keeps while this object is awake (`queries/state.ts`). */
  private readonly readerState = new ReaderState();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.repository = new Repository({
      bucket: env.OBJECTS as unknown as Bucket,
      storage: ctx.storage as unknown as RepoStorage,
      events: env.EVENTS,
      peer: (repoId) => this.peer(repoId),
    });
  }

  /** Another repository's object, with its id bound the way `repoClient` binds it. */
  private peer(repoId: string): PeerRepository {
    const stub = this.env.REPO.get(
      this.env.REPO.idFromName(repoId),
      REPO_LOCATION,
    ) as unknown as PeerStub;
    return {
      listRefs: () => stub.listRefs(repoId),
      forkManifest: () => stub.forkManifest(repoId),
      exportPack: (wants, haves) => stub.exportPack(repoId, wants, haves),
    };
  }

  private at(repoId: string): Repository {
    this.repository.open(repoId);
    return this.repository;
  }

  // RPC: lifecycle

  /** Sets HEAD and, when asked, makes the first commit. Safe to call again. */
  async init(
    repoId: string,
    options: InitOptions = {},
  ): Promise<{ head: string; commit: ObjectId | null }> {
    return this.at(repoId).init(options);
  }

  /** Deletes every file and every row. The object is empty afterwards and can be reused. */
  async destroy(repoId: string): Promise<{ deletedFiles: number }> {
    this.readerState.clear();
    return this.at(repoId).destroy();
  }

  /** Makes this (empty) repository a copy of `sourceRepoId`: its packs, branches and tags. */
  async forkFrom(repoId: string, sourceRepoId: string): Promise<RepoStats> {
    const repository = this.at(repoId);
    await repository.importFork(await this.peer(sourceRepoId).forkManifest());
    return repository.stats();
  }

  async forkManifest(repoId: string): Promise<ForkManifest> {
    return this.at(repoId).forkManifest();
  }

  async stats(repoId: string): Promise<RepoStats> {
    return this.at(repoId).stats();
  }

  /** Runs what the alarm would: deletes expired packs and repacks when due. `force` repacks regardless. */
  async maintain(
    repoId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<{ deleted: number; repacked: boolean }> {
    const repository = this.at(repoId);
    const done = await repository.maintain();
    if (options.force && !done.repacked) return { ...done, repacked: await repository.repack() };
    return done;
  }

  // RPC: refs

  async listRefs(repoId: string): Promise<{ refs: Ref[]; head: string }> {
    const repository = this.at(repoId);
    return { refs: repository.listRefs(), head: repository.head() };
  }

  async head(repoId: string): Promise<{ ref: string; oid: ObjectId | null }> {
    const repository = this.at(repoId);
    const ref = repository.head();
    return { ref, oid: repository.listRefs().find((each) => each.name === ref)?.oid ?? null };
  }

  /** Points HEAD at a branch (the default branch changed). `ref` is a full name. */
  async setHead(repoId: string, ref: string): Promise<void> {
    this.at(repoId).setHead(ref);
  }

  /**
   * Compare-and-swap ref changes made by the forge: `oldOid` is what the
   * caller believes the ref holds (zeros to create), `newOid` what it should
   * hold (zeros to delete). Announced on the events queue like a push.
   */
  async updateRefs(
    repoId: string,
    updates: readonly RefUpdate[],
    options: UpdateRefsOptions = {},
  ): Promise<RefUpdateResult[]> {
    return this.at(repoId).applyUpdates(updates, options);
  }

  // RPC: objects

  async readObject(repoId: string, oid: ObjectId): Promise<GitObject | null> {
    return this.at(repoId).readObject(oid);
  }

  /**
   * Several objects in one round trip, in the order asked; null for one the
   * repository does not have. Stops early when the answer would be too large
   * for one RPC result: the caller asks again for what is `undefined`.
   */
  async readObjects(
    repoId: string,
    oids: readonly ObjectId[],
  ): Promise<Array<GitObject | null | undefined>> {
    const repository = this.at(repoId);
    const out: Array<GitObject | null | undefined> = [];
    let bytes = 0;
    for (const oid of oids) {
      if (out.length >= READ_BATCH_OBJECTS || bytes >= READ_BATCH_BYTES) {
        out.push(undefined);
        continue;
      }
      const object = await repository.readObject(oid);
      const size = object?.data.length ?? 0;
      // One large object past the budget is asked for again on its own, not added to a full answer.
      if (out.length > 0 && bytes + size > READ_BATCH_BYTES) {
        out.push(undefined);
        bytes = READ_BATCH_BYTES;
        continue;
      }
      bytes += size;
      out.push(object);
    }
    return out;
  }

  async hasObjects(repoId: string, oids: readonly ObjectId[]): Promise<boolean[]> {
    const repository = this.at(repoId);
    return Promise.all(oids.map((oid) => repository.hasObject(oid)));
  }

  /** Full ids for an abbreviated one from a URL. More than one means it is ambiguous. */
  async resolvePrefix(repoId: string, prefix: string): Promise<ObjectId[]> {
    return this.at(repoId).resolvePrefix(prefix);
  }

  /**
   * What is at `path` in a commit (or a tag of one): a blob or a tree. Null
   * when the commit has no such path. One round trip however deep the path.
   */
  async readPath(repoId: string, commit: ObjectId, path: string): Promise<PathEntry | null> {
    const repository = this.at(repoId);
    // The raw route names a commit from the URL: only one a ref reaches is anybody's to read.
    if (!(await repository.isReachable(commit))) return null;
    const reader = repository.backend();
    const start = await reader.read(commit);
    if (!start) return null;
    const peeled =
      start.type === "tag" ? await peelTags(reader, commit) : { oid: commit, type: start.type };
    if (peeled.type !== "commit") return null;
    const commitObject = await reader.read(peeled.oid);
    if (!commitObject) return null;
    let oid = parseCommit(commitObject.data).tree;
    let mode = "040000";
    for (const segment of path.split("/").filter((part) => part !== "")) {
      if (mode !== "040000") return null;
      const tree = await reader.read(oid);
      if (!tree || tree.type !== "tree") return null;
      const entry = findTreeEntry(parseTree(tree.data), segment);
      if (!entry) return null;
      oid = entry.oid;
      mode = entry.mode;
    }
    // A submodule's commit lives in another repository.
    if (mode === "160000") return null;
    const object = await reader.read(oid);
    return object ? { oid, mode, object } : null;
  }

  /**
   * Stores objects made on the server (a merge commit, an edit in the
   * browser) and returns their ids in the order given. They are unreachable
   * until `updateRefs` points a ref at them. Each must only name objects
   * that are in the same call or already stored.
   */
  async writeObjects(
    repoId: string,
    objects: ReadonlyArray<{ readonly type: ObjectType; readonly data: Uint8Array }>,
  ): Promise<ObjectId[]> {
    return this.at(repoId).writeObjects(objects);
  }

  /**
   * A pack of what `wants` reach and `haves` do not, for another
   * repository's object to take in (a fork's pull request head). Null when a
   * want is not a commit here.
   */
  async exportPack(
    repoId: string,
    wants: readonly ObjectId[],
    haves: readonly ObjectId[],
  ): Promise<ReadableStream<Uint8Array> | null> {
    return this.at(repoId).exportPack(wants, haves);
  }

  // RPC: push mirrors (`mirror/`)

  /** What a push mirror's run has to do against a target with these refs. */
  async mirrorPlan(repoId: string, options: MirrorPlanOptions): Promise<MirrorPlan> {
    return this.at(repoId).mirrorPlan(options);
  }

  /** The pack of one push of a mirror. Null when a want is no longer reachable here. */
  async mirrorPack(
    repoId: string,
    wants: readonly ObjectId[],
    haves: readonly ObjectId[],
    options: { readonly ofsDelta: boolean },
  ): Promise<ReadableStream<Uint8Array> | null> {
    return this.at(repoId).mirrorPack(wants, haves, options);
  }

  // RPC: the JSON API's reader

  /**
   * One `RepoReader` method, run here beside the data (`queries/`). A
   * refusal comes back as a value, because an error crossing this boundary
   * keeps only its message. `locator` is the repository's owner and name,
   * which only ever go into URLs.
   */
  async reader(
    repoId: string,
    locator: { readonly owner: string; readonly name: string },
    method: string,
    args: readonly unknown[],
  ): Promise<ReaderReply> {
    const repository = this.at(repoId);
    const reader = localRepoReader(repository, this.readerState, { id: repoId, ...locator });
    return callReader(reader, method, args);
  }

  // The internal fetch: a git conversation, or an archive

  /**
   * Cloudflare's `Request` and `Response` types and the DOM's differ in ways
   * that do not matter here; the handler below is written against the DOM's,
   * like the protocol it calls.
   */
  override async fetch(request: CfRequest): Promise<CfResponse> {
    return (await this.handle(request as unknown as Request)) as unknown as CfResponse;
  }

  private async handle(request: Request): Promise<Response> {
    const header = request.headers.get(CALL_HEADER);
    if (!header) return new Response("not found", { status: 404 });
    if (request.url === ARCHIVE_URL) {
      const call = JSON.parse(header) as ArchiveCall;
      const repository = this.at(call.repoId);
      if (!(await repository.isReachable(call.commit))) {
        return new Response("not found", { status: 404 });
      }
      const reader = repository.backend();
      if (call.format === "zip") {
        const peeled = await peelTags(reader, call.commit);
        const commit = peeled.type === "commit" ? await reader.read(peeled.oid) : null;
        if (!commit) return new Response("not found", { status: 404 });
        const parsed = parseCommit(commit.data);
        const zip = zipArchive(reader, parsed.tree, {
          prefix: `${call.prefix}/`,
          time: parsed.committer.timestamp,
          commit: peeled.oid,
        });
        return new Response(zip as never, { headers: { "Content-Type": "application/zip" } });
      }
      const tar = streamOf(tarArchive(reader, call.commit, call.prefix));
      return new Response(tar.pipeThrough(new CompressionStream("gzip") as never), {
        headers: { "Content-Type": "application/gzip" },
      });
    }
    if (request.url !== SERVE_URL) return new Response("not found", { status: 404 });

    const call = JSON.parse(header) as GitCall;
    const repository = this.at(call.repoId);
    const stats: ServeStats = newServeStats();
    const readsBefore = repository.bucketReads();
    const output = serve({
      backend: repository.backend(),
      request: call.request,
      // In pieces a push's indexer can take in one go, not the runtime's 4 096 bytes a read.
      input: request.body ? bigReads(request.body, { bytes: INPUT_PIECE_BYTES }) : [],
      hooks: repository.hooks(call.actor, call.policy),
      stats,
      onError: (error) => {
        console.error(
          `git ${call.request.service} on ${call.repoId} failed: ${describeError(error)}`,
        );
      },
      onEnd: () => {
        // One line a fetch that sent a pack: where its time went, which nothing outside
        // production can say (#1447). The repository's id and numbers, nothing of the request.
        if (stats.packSource === null) return;
        const reads = repository.bucketReads();
        console.log(
          `git fetch on ${call.repoId}: ${stats.objectsSent} objects, ${stats.packBytesSent} bytes ` +
            `(${stats.packSource}), chosen in ${stats.selectMillis} ms, sent in ${stats.packMillis} ms, ` +
            `${reads.gets - readsBefore.gets} bucket reads of ${reads.bytes - readsBefore.bytes} bytes`,
        );
      },
    });
    const preamble =
      call.httpPreamble && call.request.advertiseOnly ? infoRefsPreamble(call.request) : null;
    return new Response(preamble && preamble.length > 0 ? prepend(preamble, output) : output);
  }

  override async alarm(): Promise<void> {
    await this.repository.maintain();
  }
}

/** The largest piece of a client's bytes the protocol is handed at once. */
const INPUT_PIECE_BYTES = 256 * 1024;

function streamOf(source: AsyncGenerator<Uint8Array, void, void>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await source.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await source.return();
    },
  });
}

function prepend(first: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = rest.getReader();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (!sent) controller.enqueue(first);
        controller.close();
        return;
      }
      // Joined with the first chunk, so the advertisement leaves as one write.
      controller.enqueue(sent ? value : concatBytes([first, value]));
      sent = true;
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
