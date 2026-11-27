/**
 * Git over HTTPS: the three smart HTTP routes, and the raw-file and archive
 * routes Infrawrench CI uses (NOTES-ci.md).
 *
 *   GET  /<owner>/<repo>[.git]/info/refs?service=git-upload-pack|git-receive-pack
 *   POST /<owner>/<repo>[.git]/git-upload-pack
 *   POST /<owner>/<repo>[.git]/git-receive-pack
 *   GET  /<owner>/<repo>/raw/<sha>/<path>
 *   GET  /<owner>/<repo>/archive/<sha|branch|tag>.tar.gz|.zip   (the UI's download links name a ref)
 *
 * `gitHttp` answers null for any other request, so the router can try it
 * first and fall through.
 *
 * Who may do what:
 *
 * - Reading a public repository needs no credentials.
 * - Anything a caller without credentials may not do is a 401 with a Basic
 *   challenge, so `git` asks for a token and tries again. That includes a
 *   repository that does not exist: answering 404 only for those would tell
 *   anyone which private names are taken.
 * - A caller who did authenticate and still cannot read gets a 404, the same
 *   as for a repository that is not there.
 * - A caller who can read but not push gets a 403 that says why. `git`
 *   prints a `text/plain` error body after `remote:`.
 */
import {
  type GitServiceName,
  NO_CACHE_HEADERS,
  advertisementContentType,
  httpServeRequest,
  isGitService,
  resultContentType,
} from "@infrawrench/git-protocol";
import { hasAccess } from "../../auth/access";
import { BASIC_CHALLENGE } from "../../auth/credentials";
import { ANONYMOUS, type Principal, principalActor } from "../../auth/principal";
import type { Env } from "../../env";
import type { Admit } from "../../http/admission";
import { bigReads } from "../../repo/do/big-reads";
import { repoClient } from "../../repo/do/client";
import type { GitDirectory, RequestLike, ResolvedRepository } from "../directory";
import { parseRepositoryPath } from "../directory";
import { contentDisposition, rawHeaders } from "./raw-headers";

export type GitRoute =
  | { readonly kind: "info-refs"; readonly owner: string; readonly name: string }
  | {
      readonly kind: "service";
      readonly owner: string;
      readonly name: string;
      readonly service: GitServiceName;
    }
  | {
      readonly kind: "raw";
      readonly owner: string;
      readonly name: string;
      readonly sha: string;
      readonly path: string;
    }
  | {
      readonly kind: "archive";
      readonly owner: string;
      readonly name: string;
      /** A full commit id (what CI asks for) or a branch or tag name (the UI's download links). */
      readonly ref: string;
      readonly format: "tar.gz" | "zip";
    };

const SHA = /^[0-9a-f]{40}$/;

/** Which of this module's routes a request is for, if any. */
export function matchGitRoute(method: string, pathname: string): GitRoute | null {
  const segments = pathname.split("/").slice(1);
  if (segments.length < 3) return null;
  const repo = parseRepositoryPath(`${segments[0]}/${segments[1]}`);
  if (!repo) return null;
  const rest = segments.slice(2);
  if (method === "GET" || method === "HEAD") {
    if (rest.length === 2 && rest[0] === "info" && rest[1] === "refs") {
      return { kind: "info-refs", ...repo };
    }
    if (rest[0] === "raw" && rest.length >= 3 && SHA.test(rest[1]!)) {
      let path: string;
      try {
        path = rest.slice(2).map(decodeURIComponent).join("/");
      } catch {
        return null;
      }
      return { kind: "raw", ...repo, sha: rest[1]!, path };
    }
    if (rest[0] === "archive" && rest.length >= 2) {
      // A ref name has slashes of its own (`archive/feature/x.zip`).
      let named: string;
      try {
        named = rest.slice(1).map(decodeURIComponent).join("/");
      } catch {
        return null;
      }
      const format = (["tar.gz", "zip"] as const).find((suffix) => named.endsWith(`.${suffix}`));
      if (!format) return null;
      const ref = named.slice(0, -(format.length + 1));
      if (ref === "") return null;
      return { kind: "archive", ...repo, ref, format };
    }
    return null;
  }
  if (method === "POST" && rest.length === 1 && isGitService(rest[0])) {
    return { kind: "service", ...repo, service: rest[0] };
  }
  return null;
}

/**
 * The commit a download link's branch or tag names: a branch first, as git
 * resolves a short name, and a tag by the commit it points at.
 */
export function archiveCommit(
  refs: ReadonlyArray<{ readonly name: string; readonly oid: string; readonly peeled?: string }>,
  named: string,
): string | null {
  for (const full of [`refs/heads/${named}`, `refs/tags/${named}`]) {
    const ref = refs.find((candidate) => candidate.name === full);
    if (ref) return ref.peeled ?? ref.oid;
  }
  return null;
}

const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_CACHE_HEADERS, ...headers },
  });

const unauthorized = (): Response =>
  text(401, "Authentication required.\n", { "WWW-Authenticate": BASIC_CHALLENGE });

const notFound = (): Response => text(404, "Repository not found.\n");

type Gate =
  | { readonly ok: true; readonly repository: ResolvedRepository }
  | { readonly ok: false; readonly response: Response };

/** The one place the rules in this file's header are applied. */
async function gate(
  directory: GitDirectory,
  principal: Principal,
  owner: string,
  name: string,
  need: "read" | "write",
): Promise<Gate> {
  const repository = await directory.resolveRepository(owner, name, principal);
  const anonymous = principal.kind === "anonymous";
  if (!repository || !hasAccess(repository.access, "read")) {
    return { ok: false, response: anonymous ? unauthorized() : notFound() };
  }
  if (need === "write" && !hasAccess(repository.access, "write")) {
    if (anonymous) return { ok: false, response: unauthorized() };
    const why = repository.archived
      ? `${repository.owner}/${repository.name} is archived and read-only.`
      : `You do not have permission to push to ${repository.owner}/${repository.name}.`;
    return { ok: false, response: text(403, `${why}\n`) };
  }
  return { ok: true, repository };
}

/**
 * Most bytes of a fetch's request, after inflating: wants, haves and
 * shallow lines at their protocol limits come to a few MiB. A push is
 * bounded by the pack limits instead.
 */
export const MAX_NEGOTIATION_BYTES = 32 * 1024 * 1024;

/** A stream that fails once more than `limit` bytes have passed through it. */
function capped(source: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(new Error("request body is over the size limit"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The request body, inflated when the client compressed it (git does above
 * about 1 KiB), or null for an encoding this server does not take. Inflated
 * as it is read, never whole, and a fetch's capped after inflating, so a
 * small body cannot become gigabytes of work.
 */
function requestBody(
  request: Request,
  service: GitServiceName,
): { readonly body: ReadableStream<Uint8Array> | null } | null {
  const encoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (!request.body) return { body: null };
  let body = request.body as ReadableStream<Uint8Array>;
  if (encoding === "gzip" || encoding === "x-gzip") {
    body = body.pipeThrough(
      new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  } else if (encoding !== "identity") {
    // Anything else, stacked encodings included, is refused rather than read as it is.
    return null;
  }
  return { body: service === "git-upload-pack" ? capped(body, MAX_NEGOTIATION_BYTES) : body };
}

/** A push's pack goes on to the repository's object in pieces of at least this. */
const UPLOAD_PIECE_BYTES = 256 * 1024;

/**
 * `stream`, passed through this Worker's own code rather than handed to the
 * runtime as it is.
 *
 * A request whose answer is another request's body, untouched, ends as soon
 * as it is returned: the runtime moves the bytes from then on, and what is
 * still running for it (the upload going on to the repository's object) gets
 * the 30 seconds Cloudflare allows after a request ends, then is cancelled. A
 * push the object takes longer than that to read was cut off halfway
 * ("client disconnected" in the object, "internal error" in git). Carried
 * through a stream of our own, both the upload and the answer keep the
 * request open until the answer is complete. Local `wrangler dev` does not
 * apply the 30 seconds, so only production showed it.
 *
 * It is read in large pieces (`bigReads`): read the ordinary way, a pack
 * crossed this Worker 4 096 bytes at a turn of the event loop, which in
 * production was about 1.4 MiB/s (#1447). `atLeast` is for the upload of a
 * push, which nothing waits on piece by piece; an answer leaves as it
 * arrives, because it carries keep-alive packets.
 */
export function carried(
  stream: ReadableStream<Uint8Array>,
  atLeast = 0,
): ReadableStream<Uint8Array> {
  return bigReads(stream, { atLeast });
}

/**
 * The request as authentication sees it on the smart HTTP routes: without
 * the session cookie. `git` authenticates with a token; a cookie here could
 * only have been sent by a browser.
 */
const withoutCookie = (request: Request): RequestLike => ({
  url: request.url,
  method: request.method,
  headers: {
    get: (name) => (name.toLowerCase() === "cookie" ? null : request.headers.get(name)),
  },
});

/**
 * Serves a git request, or returns null when the request is not one of
 * this module's. `admit` counts the request against whoever it authenticated
 * as, right after authentication (`http/admission.ts`).
 */
export async function gitHttp(
  request: Request,
  env: Pick<Env, "REPO">,
  directory: GitDirectory,
  admit: Admit = async () => null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = matchGitRoute(request.method, url.pathname);
  if (!route) return null;

  if (route.kind === "archive") {
    // The one route that takes its token in the query: the app redirects a machine here.
    const token = url.searchParams.get("token");
    const named = SHA.test(route.ref) ? null : route.ref;
    let principal: Principal;
    if (token !== null) {
      // A job's token names its commit, so it opens that commit and never a ref.
      const job =
        named === null ? await directory.authenticateArchiveToken(token, route.ref) : null;
      if (!job) return unauthorized();
      principal = job;
    } else {
      const auth = await directory.authenticate(request);
      if (auth.refused) return unauthorized();
      principal = auth.principal;
    }
    const limited = await admit(request, principal);
    if (limited) return limited;
    const allowed = await gate(directory, principal, route.owner, route.name, "read");
    if (!allowed.ok) return allowed.response;
    const { repository } = allowed;
    const client = repoClient(env, repository.id);
    const commit =
      named === null ? route.ref : archiveCommit((await client.listRefs()).refs, named);
    if (commit === null) return text(404, "No such branch or tag.\n");
    // As the contract's `archivePath` says: `<repo>-<ref>`, the ref's slashes as dashes.
    const label = named === null ? route.ref : named.replaceAll("/", "-");
    const archive = await client.archive(commit, `${repository.name}-${label}`, route.format);
    if (!archive.ok) return text(404, "No such commit.\n");
    return new Response(archive.body, {
      headers: {
        "Content-Type": route.format === "zip" ? "application/zip" : "application/gzip",
        "Content-Disposition": contentDisposition(
          "attachment",
          `${repository.name}-${named === null ? route.ref.slice(0, 12) : label}.${route.format}`,
        ),
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (route.kind === "raw") {
    // The browser's routes: the UI's images and download links carry the session cookie.
    const auth = await directory.authenticate(request);
    if (auth.refused) return unauthorized();
    const limited = await admit(request, auth.principal);
    if (limited) return limited;
    const allowed = await gate(directory, auth.principal, route.owner, route.name, "read");
    if (!allowed.ok) return allowed.response;
    const entry = await repoClient(env, allowed.repository.id).readPath(route.sha, route.path);
    if (!entry || entry.object.type !== "blob") return text(404, "No such file.\n");
    const data = entry.object.data as Uint8Array<ArrayBuffer>;
    return new Response(data, {
      headers: rawHeaders(route.path, data, url.searchParams.get("download") === "1"),
    });
  }

  // A job token bound to one branch is taken here and only here among these
  // routes: the push policy confines what it writes to that branch (`onlyRef`).
  const auth = await directory.authenticate(withoutCookie(request), { refTokens: true });
  if (auth.refused) return unauthorized();
  const principal = auth.principal ?? ANONYMOUS;
  const limited = await admit(request, principal);
  if (limited) return limited;

  const service = route.kind === "service" ? route.service : url.searchParams.get("service");
  if (!isGitService(service)) {
    // The "dumb" protocol, which serves files of a repository on disk. There are none.
    return text(403, "This server speaks the smart HTTP protocol only; your git is too old.\n");
  }
  const push = service === "git-receive-pack";
  const allowed = await gate(
    directory,
    principal,
    route.owner,
    route.name,
    push ? "write" : "read",
  );
  if (!allowed.ok) return allowed.response;
  const { repository } = allowed;

  const advertise = route.kind === "info-refs";
  const input = advertise ? { body: null } : requestBody(request, service);
  if (!input) return text(415, "Content-Encoding must be gzip or none.\n");
  const serveRequest = httpServeRequest(service, request.headers.get("git-protocol"), advertise);
  const response = await repoClient(env, repository.id).serve(
    {
      request: serveRequest,
      httpPreamble: true,
      actor: principalActor(principal),
      // The rules are only needed once refs are about to move.
      policy: push && !advertise ? await repository.pushPolicy() : null,
    },
    input.body === null ? null : carried(input.body, push ? UPLOAD_PIECE_BYTES : 0),
    request.signal,
  );
  if (!response.ok) return text(502, "The repository could not be reached.\n");
  return new Response(
    advertise || response.body === null ? response.body : carried(response.body),
    {
      headers: {
        "Content-Type": advertise ? advertisementContentType(service) : resultContentType(service),
        ...NO_CACHE_HEADERS,
      },
    },
  );
}
