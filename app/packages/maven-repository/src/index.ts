/**
 * maven.infrawrench.com: a Maven repository, which is to say static files laid
 * out by coordinate. Maven needs nothing more than GET and HEAD to resolve and
 * PUT to deploy; it computes checksums and merges `maven-metadata.xml` itself.
 *
 * Reads are public, because the SDK is. Writes need HTTP Basic credentials.
 *
 * Everything else here is about what the repository refuses:
 *
 * - Only `com/infrawrench/**` exists. A consumer's `<repository>` is asked for
 *   every dependency in their build before Central is, so nearly all traffic
 *   is for other people's artifacts. It gets a cacheable 404 without touching
 *   R2, and nobody can ever be served a third party's coordinates from here.
 * - Only Maven's own file names can be written, so this domain cannot be made
 *   to serve HTML.
 * - A released version is immutable. `maven-deploy-plugin` uploads the metadata
 *   last, so a version listed there is complete, and from then on its files
 *   cannot be replaced. A deploy that died halfway is not listed yet, so
 *   re-running it just overwrites its own partial upload.
 * - No snapshots: every version here is a release.
 */

export interface Env {
  ARTIFACTS: R2Bucket;
  DEPLOY_USERNAME?: string;
  DEPLOY_PASSWORD?: string;
}

const CHECKSUM = String.raw`(?:\.(?:md5|sha1|sha256|sha512))?`;
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";

const METADATA_PATH = new RegExp(
  String.raw`^com/infrawrench/(${NAME})/maven-metadata\.xml${CHECKSUM}$`,
);
// The backreferences hold a file to its own directory: <artifact>-<version>.
const RELEASE_PATH = new RegExp(
  String.raw`^com/infrawrench/(${NAME})/(${NAME})/\1-\2(?:-[A-Za-z0-9]+)?\.(?:jar|pom|module)(?:\.asc)?${CHECKSUM}$`,
);

const IMMUTABLE = "public, max-age=31536000, immutable";
/** Short, because this is the file that announces a new version. */
const METADATA_CACHE_CONTROL = "public, max-age=60";
const NOT_FOUND_CACHE_CONTROL = "public, max-age=300";

type Location =
  | { kind: "metadata"; key: string }
  | { kind: "release"; key: string; artifact: string; version: string };

/** Where a path lives in this repository, or null if it can't be one of ours. */
export function locate(pathname: string): Location | null {
  const key = pathname.slice(1);
  if (METADATA_PATH.test(key)) return { kind: "metadata", key };

  const release = RELEASE_PATH.exec(key);
  if (!release) return null;
  const [, artifact = "", version = ""] = release;
  if (version.endsWith("-SNAPSHOT")) return null;
  return { kind: "release", key, artifact, version };
}

export default {
  async fetch(request, env): Promise<Response> {
    const location = locate(new URL(request.url).pathname);

    switch (request.method) {
      case "GET":
      case "HEAD":
        return location ? read(env.ARTIFACTS, location, request) : notFound();
      case "PUT":
        if (!(await isDeployer(request, env))) {
          return text(401, "Unauthorized", {
            "www-authenticate": 'Basic realm="maven.infrawrench.com"',
          });
        }
        return location
          ? write(env.ARTIFACTS, location, request)
          : text(400, "Not a path this repository stores");
      default:
        return text(405, "Method not allowed", { allow: "GET, HEAD, PUT" });
    }
  },
} satisfies ExportedHandler<Env>;

async function read(bucket: R2Bucket, location: Location, request: Request): Promise<Response> {
  if (request.method === "HEAD") {
    const object = await bucket.head(location.key);
    return object ? new Response(null, { headers: objectHeaders(object, location) }) : notFound();
  }

  const object = await bucket.get(location.key, { onlyIf: request.headers });
  if (!object) return notFound();

  const headers = objectHeaders(object, location);
  // No body means a precondition failed, which for a conditional GET is 304.
  return "body" in object
    ? new Response(object.body, { headers })
    : new Response(null, { status: 304, headers });
}

async function write(bucket: R2Bucket, location: Location, request: Request): Promise<Response> {
  if (
    location.kind === "release" &&
    (await isReleased(bucket, location.artifact, location.version))
  ) {
    return text(409, `${location.artifact} ${location.version} is released and cannot change`);
  }
  // R2 cannot stream a body of unknown length.
  if (!request.body || !request.headers.has("content-length")) {
    return text(411, "Content-Length required");
  }

  await bucket.put(location.key, request.body, {
    httpMetadata: { contentType: contentType(location.key) },
  });
  return new Response(null, { status: 201 });
}

async function isReleased(bucket: R2Bucket, artifact: string, version: string): Promise<boolean> {
  const metadata = await bucket.get(`com/infrawrench/${artifact}/maven-metadata.xml`);
  return metadata ? (await metadata.text()).includes(`<version>${version}</version>`) : false;
}

async function isDeployer(request: Request, env: Env): Promise<boolean> {
  // Unset secrets must lock the repository, not open it to an empty password.
  if (!env.DEPLOY_USERNAME || !env.DEPLOY_PASSWORD) return false;

  const match = request.headers.get("authorization")?.match(/^Basic\s+(\S+)$/i);
  if (!match?.[1]) return false;

  let presented: string;
  try {
    presented = atob(match[1]);
  } catch {
    return false;
  }
  return digestsEqual(presented, `${env.DEPLOY_USERNAME}:${env.DEPLOY_PASSWORD}`);
}

/** Compares digests in constant time, so timing reveals nothing about the secret. */
async function digestsEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all(
    [a, b].map(async (value) => {
      return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
    }),
  );
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= (left?.[i] ?? 0) ^ (right?.[i] ?? 0);
  return difference === 0;
}

function objectHeaders(object: R2Object, location: Location): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-length", String(object.size));
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", location.kind === "release" ? IMMUTABLE : METADATA_CACHE_CONTROL);
  return headers;
}

function contentType(key: string): string {
  if (key.endsWith(".jar")) return "application/java-archive";
  if (key.endsWith(".pom") || key.endsWith(".xml")) return "text/xml";
  if (key.endsWith(".module")) return "application/json";
  // Signatures and checksums.
  return "text/plain";
}

function notFound(): Response {
  return text(404, "Not found", { "cache-control": NOT_FOUND_CACHE_CONTROL });
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}
