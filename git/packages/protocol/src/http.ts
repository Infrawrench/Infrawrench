/**
 * Smart HTTP, the parts that are the same for every host: which service and
 * protocol version a request means, the headers of each answer, and the
 * `# service=` preamble. Routing, authentication and the `Response` itself
 * are the host's.
 */
import { FLUSH_PKT, concatBytes, encodePktLine } from "@infrawrench/git-core";
import type { GitServiceName, ServeRequest } from "./backend";

export const GIT_SERVICES: readonly GitServiceName[] = ["git-upload-pack", "git-receive-pack"];

export function isGitService(value: string | null | undefined): value is GitServiceName {
  return value === "git-upload-pack" || value === "git-receive-pack";
}

/**
 * The version a `Git-Protocol` header asks for (`version=2`, possibly among
 * other colon-separated keys). Anything else is the classic protocol.
 */
export function parseGitProtocol(header: string | null | undefined): 0 | 1 | 2 {
  if (!header) return 0;
  let version: 0 | 1 | 2 = 0;
  for (const part of header.split(":")) {
    const trimmed = part.trim();
    if (trimmed === "version=2") version = 2;
    else if (trimmed === "version=1" && version < 1) version = 1;
  }
  return version;
}

/** What a smart HTTP request is, as the protocol sees it. */
export function httpServeRequest(
  service: GitServiceName,
  gitProtocol: string | null | undefined,
  advertiseOnly: boolean,
): ServeRequest {
  const asked = parseGitProtocol(gitProtocol);
  // There is no push in protocol v2; a client that asked is answered in v0 and carries on.
  const version = service === "git-receive-pack" && asked === 2 ? 0 : asked;
  return { service, version, statelessRpc: true, advertiseOnly };
}

/** The bytes before the advertisement in `GET info/refs`. Empty for protocol v2, which has no preamble. */
export function infoRefsPreamble(request: ServeRequest): Uint8Array {
  if (request.version === 2) return new Uint8Array(0);
  return concatBytes([encodePktLine(`# service=${request.service}\n`), FLUSH_PKT]);
}

/** Dumb caches and proxies must never hold on to any of this. */
export const NO_CACHE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-cache, max-age=0, must-revalidate",
  Expires: "Fri, 01 Jan 1980 00:00:00 GMT",
  Pragma: "no-cache",
};

export const advertisementContentType = (service: GitServiceName): string =>
  `application/x-${service}-advertisement`;

export const requestContentType = (service: GitServiceName): string =>
  `application/x-${service}-request`;

export const resultContentType = (service: GitServiceName): string =>
  `application/x-${service}-result`;
