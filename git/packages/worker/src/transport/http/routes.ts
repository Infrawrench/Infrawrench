/**
 * Git over HTTPS: the three smart HTTP routes, and the raw-file and archive
 * routes Infrawrench CI uses (NOTES-ci.md).
 *
 *   GET  /<owner>/<repo>[.git]/info/refs?service=git-upload-pack|git-receive-pack
 *   POST /<owner>/<repo>[.git]/git-upload-pack
 *   POST /<owner>/<repo>[.git]/git-receive-pack
 *   GET  /<owner>/<repo>/raw/<sha>/<path>
 *   GET  /<owner>/<repo>/archive/<sha>.tar.gz
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
import { repoClient } from "../../repo/do/client";
import type { GitDirectory, ResolvedRepository } from "../directory";
import { parseRepositoryPath } from "../directory";

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
      readonly sha: string;
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
    if (rest[0] === "archive" && rest.length === 2 && rest[1]!.endsWith(".tar.gz")) {
      const sha = rest[1]!.slice(0, -".tar.gz".length);
      if (SHA.test(sha)) return { kind: "archive", ...repo, sha };
    }
    return null;
  }
  if (method === "POST" && rest.length === 1 && isGitService(rest[0])) {
    return { kind: "service", ...repo, service: rest[0] };
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

/** The request body, inflated when the client compressed it (git does above about 1 KiB). */
function requestBody(request: Request): ReadableStream<Uint8Array> | null {
  if (!request.body) return null;
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") {
    return (request.body as ReadableStream<Uint8Array>).pipeThrough(
      new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  }
  return request.body as ReadableStream<Uint8Array>;
}

/**
 * Serves a git request, or returns null when the request is not one of
 * this module's.
 */
export async function gitHttp(
  request: Request,
  env: Pick<Env, "REPO">,
  directory: GitDirectory,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = matchGitRoute(request.method, url.pathname);
  if (!route) return null;

  if (route.kind === "archive") {
    // The one route that takes its token in the query: the app redirects a machine here.
    const token = url.searchParams.get("token");
    let principal: Principal;
    if (token !== null) {
      const job = await directory.authenticateArchiveToken(token, route.sha);
      if (!job) return unauthorized();
      principal = job;
    } else {
      const auth = await directory.authenticate(request);
      if (auth.refused) return unauthorized();
      principal = auth.principal;
    }
    const allowed = await gate(directory, principal, route.owner, route.name, "read");
    if (!allowed.ok) return allowed.response;
    const { repository } = allowed;
    const archive = await repoClient(env, repository.id).archive(
      route.sha,
      `${repository.name}-${route.sha}`,
    );
    if (!archive.ok) return text(404, "No such commit.\n");
    return new Response(archive.body, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${repository.name}-${route.sha.slice(0, 12)}.tar.gz"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const auth = await directory.authenticate(request);
  if (auth.refused) return unauthorized();
  const principal = auth.principal ?? ANONYMOUS;

  if (route.kind === "raw") {
    const allowed = await gate(directory, principal, route.owner, route.name, "read");
    if (!allowed.ok) return allowed.response;
    const entry = await repoClient(env, allowed.repository.id).readPath(route.sha, route.path);
    if (!entry || entry.object.type !== "blob") return text(404, "No such file.\n");
    return new Response(entry.object.data as Uint8Array<ArrayBuffer>, {
      headers: {
        // Never a type a browser would run: this is somebody's file, served from our origin.
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  }

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
  const serveRequest = httpServeRequest(service, request.headers.get("git-protocol"), advertise);
  const response = await repoClient(env, repository.id).serve(
    {
      request: serveRequest,
      httpPreamble: true,
      actor: principalActor(principal),
      // The rules are only needed once refs are about to move.
      policy: push && !advertise ? await repository.pushPolicy() : null,
    },
    advertise ? null : requestBody(request),
    request.signal,
  );
  if (!response.ok) return text(502, "The repository could not be reached.\n");
  return new Response(response.body, {
    headers: {
      "Content-Type": advertise ? advertisementContentType(service) : resultContentType(service),
      ...NO_CACHE_HEADERS,
    },
  });
}
