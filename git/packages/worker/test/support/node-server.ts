/**
 * A `Repository` on Node stand-ins behind a small HTTP server, so the real
 * `git` can push to and clone from the storage code without workerd.
 */
import { type Server, createServer } from "node:http";
import { Readable } from "node:stream";
import {
  type ServeStats,
  advertisementContentType,
  httpServeRequest,
  infoRefsPreamble,
  isGitService,
  newServeStats,
  resultContentType,
  serve,
} from "@infrawrench/git-protocol";
import type { GitEvent, GitPushEvent } from "../../src/env";
import type { PushPolicy } from "../../src/repo/do/policy";
import {
  type PeerRepository,
  Repository,
  type RepositoryLimits,
} from "../../src/repo/do/repository";
import { MemoryBucket, type NodeStorage, nodeStorage } from "./node-platform";

export interface NodeRepo {
  readonly repository: Repository;
  readonly bucket: MemoryBucket;
  readonly storage: NodeStorage;
  /** What the object sent: only ever pushes. */
  readonly events: GitPushEvent[];
  readonly url: string;
  /** Stats of each request served, oldest first. */
  readonly requests: ServeStats[];
  readonly errors: unknown[];
  policy: PushPolicy | null;
  close(): Promise<void>;
}

export async function startNodeRepo(
  repoId = "repo-1",
  options: {
    limits?: Partial<RepositoryLimits>;
    bucket?: MemoryBucket;
    now?: () => number;
    peer?: (repoId: string) => PeerRepository;
  } = {},
): Promise<NodeRepo> {
  const bucket = options.bucket ?? new MemoryBucket();
  const storage = nodeStorage();
  const events: GitPushEvent[] = [];
  const requests: ServeStats[] = [];
  const errors: unknown[] = [];
  const repository = new Repository({
    bucket,
    storage,
    events: { send: async (event) => void events.push(event as GitPushEvent) },
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.peer ? { peer: options.peer } : {}),
  });
  repository.open(repoId);
  const state: { policy: PushPolicy | null } = { policy: null };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const gitProtocol = req.headers["git-protocol"] as string | undefined;
    const stats = newServeStats();
    const onError = (error: unknown): void => void errors.push(error);
    const send = (stream: ReadableStream<Uint8Array>): void => {
      Readable.fromWeb(stream as import("node:stream/web").ReadableStream).pipe(res);
    };
    const actor = { kind: "user" as const, userId: "user-1", credentialId: null };
    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const service = url.searchParams.get("service");
      if (!isGitService(service)) return void res.writeHead(400).end();
      const request = httpServeRequest(service, gitProtocol, true);
      res.writeHead(200, { "Content-Type": advertisementContentType(service) });
      res.write(infoRefsPreamble(request));
      return send(serve({ backend: repository.backend(), request, input: [], stats, onError }));
    }
    const service = url.pathname.split("/").pop();
    if (req.method === "POST" && isGitService(service)) {
      requests.push(stats);
      let input = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
      if (req.headers["content-encoding"] === "gzip") {
        input = input.pipeThrough(new DecompressionStream("gzip") as never);
      }
      res.writeHead(200, { "Content-Type": resultContentType(service) });
      return send(
        serve({
          backend: repository.backend(),
          request: httpServeRequest(service, gitProtocol, false),
          input,
          hooks: repository.hooks(actor, state.policy),
          stats,
          onError,
        }),
      );
    }
    res.writeHead(404).end();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    repository,
    bucket,
    storage,
    events,
    requests,
    errors,
    url: `http://127.0.0.1:${port}/repo.git`,
    get policy() {
      return state.policy;
    },
    set policy(value) {
      state.policy = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A repository as another one reaches it: what a Durable Object's stub is in production. */
export const peerOf = (repository: Repository): PeerRepository => ({
  listRefs: async () => ({ refs: repository.listRefs(), head: repository.head() }),
  forkManifest: async () => repository.forkManifest(),
  exportPack: (wants, haves) => repository.exportPack(wants, haves),
});
