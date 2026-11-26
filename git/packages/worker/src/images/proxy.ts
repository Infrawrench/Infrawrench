/**
 * `/-/image?url=`: an image from another site, fetched by the Worker for the
 * page that shows it (contract `imageProxyPath`).
 *
 * A README, an issue or a comment can show an image from anywhere. Loaded by
 * the reader's browser, that image tells its host the reader's address, the
 * time and their browser, and whoever wrote the Markdown chooses the host.
 * Through here the host sees Cloudflare instead, and the page's policy
 * (`img-src 'self'`) refuses an image from anywhere else, so one the UI
 * forgot to route through here does not load rather than leak.
 *
 * What it will do, and nothing more:
 *
 * - **Only for this site's pages.** The browser says who is asking
 *   (`Sec-Fetch-Site`, `Sec-Fetch-Dest`), and only an image on one of this
 *   site's pages is served. Another site cannot embed it, and opening it in
 *   a tab is refused, so it never renders as a document on this origin. A
 *   program can send those headers, which buys it a slow, rate-limited
 *   fetcher of small images and nothing else.
 * - **Only an image from a public address.** `http:` or `https:`, no
 *   credentials in the URL, not this site, and not a host that names a
 *   private, loopback, link-local or reserved address (Cloudflare's network
 *   cannot reach one anyway; local development can). Redirects are followed,
 *   a few, each checked the same way.
 * - **Only an image.** The answer must say it is one of `IMAGE_TYPES`, and
 *   is cut off past `IMAGE_PROXY_LIMITS.maxBytes`. It goes back with a
 *   sandboxing policy and `nosniff`, so even an SVG opened some other way
 *   runs nothing.
 * - **Nothing of the reader's.** No cookie, no referrer, no address, no
 *   browser string: the request upstream carries an `Accept` and this
 *   Worker's name.
 *
 * Counted by the caller's address against the anonymous read budget, whoever
 * is signed in (`http/admission.ts`): it never authenticates anyone.
 */

export const IMAGE_PROXY_LIMITS = {
  /** Past this the answer is cut off. */
  maxBytes: 10 * 1024 * 1024,
  /** For the upstream's headers and its body together. */
  timeoutMs: 10_000,
  maxRedirects: 4,
  /** How long a browser and Cloudflare keep an image. */
  cacheSeconds: 3600,
} as const;

/** What the answer may say it is. Anything else, HTML and `application/octet-stream` included, is refused. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

/** The policy an image goes back with: a document opened from it can do nothing. */
export const IMAGE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

const USER_AGENT = "infrawrench-git-images (+https://git.infrawrench.com)";

export interface ImageProxyOptions {
  /** Fetches upstream: the Worker's `fetch`, or a fake in tests. */
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** This site's hosts (`git.infrawrench.com`, the request's own): never fetched. */
  readonly siteHosts: readonly string[];
}

const answer = (status: number, body: string, extra: Record<string, string> = {}): Response =>
  new Response(`${body}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });

// Addresses

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for an IPv4 address that is not public unicast. */
const privateIpv4 = (a: number, b: number, c: number): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 0 && (c === 0 || c === 2)) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) ||
  (a === 198 && b === 51 && c === 100) ||
  (a === 203 && b === 0 && c === 113) ||
  a >= 224;

/**
 * True when `hostname` (as `URL` normalises it: lower case, an IPv4 address
 * in dotted decimal, an IPv6 one in brackets) must not be fetched: a private,
 * loopback, link-local or reserved address, a name only a local network
 * resolves, or a single label.
 */
export const blockedHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    // IPv6: only global unicast (2000::/3). That leaves out loopback, the
    // unspecified address, unique-local, link-local, multicast and every
    // address that embeds an IPv4 one (`::ffff:`, `64:ff9b::`).
    return !/^\[[23][0-9a-f]{3}:/.test(host) || host.startsWith("[2002:");
  }
  const v4 = IPV4.exec(host);
  if (v4) return privateIpv4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
  if (!host.includes(".")) return true;
  return (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  );
};

/**
 * `value` as a URL this proxy may fetch, or null: `http:` or `https:`, no
 * user or password, not one of `siteHosts`, not a {@link blockedHost}.
 */
export const imageSource = (
  value: string | null,
  siteHosts: readonly string[],
  base?: string,
): URL | null => {
  if (value === null || value === "") return null;
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (blockedHost(url.hostname)) return null;
  const host = url.hostname.toLowerCase();
  if (siteHosts.some((site) => site.toLowerCase() === host)) return null;
  url.hash = "";
  return url;
};

/** The answer's media type, lower case and without parameters. */
const mediaType = (response: Response): string =>
  (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

/** `body`, erroring once more than `maxBytes` have gone through. */
const capped = (body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> => {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) controller.error(new Error("image too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
};

/** True when the browser says this is an image on one of this site's pages. */
export const askedByThisSite = (headers: Headers): boolean =>
  headers.get("sec-fetch-site") === "same-origin" && headers.get("sec-fetch-dest") === "image";

export async function proxyImage(request: Request, options: ImageProxyOptions): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return answer(405, "Method Not Allowed", { allow: "GET, HEAD" });
  }
  if (!askedByThisSite(request.headers)) {
    return answer(403, "Images are only loaded for this site's pages");
  }
  let source = imageSource(new URL(request.url).searchParams.get("url"), options.siteHosts);
  if (source === null) return answer(400, "Not an address this site loads images from");

  const signal = AbortSignal.timeout(IMAGE_PROXY_LIMITS.timeoutMs);
  let upstream: Response | null = null;
  for (let hop = 0; hop <= IMAGE_PROXY_LIMITS.maxRedirects; hop++) {
    let response: Response;
    try {
      response = await options.fetch(source.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
          "user-agent": USER_AGENT,
        },
        // Cloudflare keeps what it fetched, so a popular README is fetched
        // once per location rather than once per reader.
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: { "200-299": IMAGE_PROXY_LIMITS.cacheSeconds, "300-599": 0 },
        },
      } as RequestInit);
    } catch {
      return answer(502, "The image could not be fetched");
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel().catch(() => undefined);
      const next = imageSource(location, options.siteHosts, source.href);
      if (next === null)
        return answer(502, "The image redirects somewhere this site does not load from");
      source = next;
      continue;
    }
    upstream = response;
    break;
  }
  if (upstream === null) return answer(502, "The image redirects too many times");

  const discard = () => upstream.body?.cancel().catch(() => undefined);
  if (!upstream.ok) {
    await discard();
    return answer(upstream.status >= 500 ? 502 : 404, "The image is not there");
  }
  const type = mediaType(upstream);
  if (!IMAGE_TYPES.has(type)) {
    await discard();
    return answer(415, "Not an image");
  }
  const declared = Number(upstream.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > IMAGE_PROXY_LIMITS.maxBytes) {
    await discard();
    return answer(413, "The image is too large");
  }

  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": `public, max-age=${IMAGE_PROXY_LIMITS.cacheSeconds}`,
    "content-security-policy": IMAGE_CONTENT_SECURITY_POLICY,
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
  if (Number.isFinite(declared)) headers["content-length"] = String(declared);
  if (request.method === "HEAD" || upstream.body === null) {
    await discard();
    return new Response(null, { status: 200, headers });
  }
  return new Response(capped(upstream.body, IMAGE_PROXY_LIMITS.maxBytes), {
    status: 200,
    headers,
  });
}
