/**
 * Every request the forge makes to a T3 Code environment goes through here.
 *
 * The address is one a person typed, and the addresses its OAuth documents
 * name are ones its server chose, so each is somebody else's choice of where
 * this Worker connects. What a request may be, and nothing more:
 *
 * - **`https:` to a public address.** No `http:`, no credentials in the
 *   URL, not this site, and not a host that names a private, loopback,
 *   link-local or reserved address (`images/proxy.ts` `blockedHost`, the
 *   same rule the image proxy keeps). `localhost` is refused with its own
 *   sentence, because it is what a person tries first: a Worker cannot reach
 *   a machine's loopback, so the environment has to be given by an address
 *   the internet reaches.
 * - **No redirects.** A 3xx is a failure. Following one would let a public
 *   address point this Worker somewhere else after the check.
 * - **Bounded.** A timeout for the headers and the body together, and a cap
 *   on the body, read as it arrives.
 * - **Nothing of the reader's.** The request carries what the caller sets
 *   (a bearer token of that environment, a JSON body) and this Worker's
 *   name. Never the forge's session cookie, never the person's address.
 */
import { blockedHost } from "../images/proxy";

export const T3_HTTP_LIMITS = {
  /** For the answer's headers and body together. */
  timeoutMs: 10_000,
  /** Past this the answer is refused. */
  maxBytes: 1024 * 1024,
} as const;

const USER_AGENT = "infrawrench-git (+https://git.infrawrench.com)";

/** Why an environment could not be reached or would not answer. The message is safe to show and to store. */
export class T3Error extends Error {
  constructor(
    readonly code:
      | "address_refused"
      | "unreachable"
      | "bad_answer"
      | "not_signed_in"
      | "forbidden"
      | "tool_failed"
      | "unsupported",
    message: string,
    /** The HTTP status, when there was one. */
    readonly status: number | null = null,
    /** T3 Code's own code for a tool that refused (`capability_denied`, `thread_not_found`, ...). */
    readonly toolCode: string | null = null,
  ) {
    super(message);
    this.name = "T3Error";
  }
}

export const LOCALHOST_REFUSAL =
  "git.infrawrench.com cannot reach an environment on localhost. Link T3 Connect in T3 Code and use the public https address it gives.";

const isLoopbackName = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/**
 * `value` as an address this Worker may call, or a {@link T3Error} saying
 * why not. `siteHosts` are this site's own hosts, never called.
 */
export const publicHttpsUrl = (value: string, siteHosts: readonly string[], base?: string): URL => {
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    throw new T3Error("address_refused", "That is not an address");
  }
  const host = url.hostname.toLowerCase();
  if (isLoopbackName(host)) throw new T3Error("address_refused", LOCALHOST_REFUSAL);
  if (url.protocol !== "https:") {
    throw new T3Error("address_refused", "The address has to start with https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new T3Error("address_refused", "The address cannot carry a user name or a password");
  }
  if (blockedHost(host) || siteHosts.some((site) => site.toLowerCase() === host)) {
    throw new T3Error(
      "address_refused",
      "That address is not on the public internet, so git.infrawrench.com cannot reach it",
    );
  }
  url.hash = "";
  return url;
};

/**
 * An environment's origin from what a person typed: `https://host[:port]`,
 * whatever path they pasted (`/mcp` is where its MCP server is, and is put
 * back by the client).
 */
export const environmentOrigin = (value: string, siteHosts: readonly string[]): string => {
  const typed = value.trim();
  const url = publicHttpsUrl(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`,
    siteHosts,
  );
  return url.origin;
};

export interface T3Answer {
  readonly status: number;
  readonly headers: Headers;
  /** The body, at most `T3_HTTP_LIMITS.maxBytes` of it. */
  readonly text: string;
}

export interface T3HttpOptions {
  /** The Worker's `fetch`, or a fake in tests. */
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly siteHosts: readonly string[];
}

export interface T3Request {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

/** A guarded fetch: what {@link T3Http} is. */
export type T3Http = (url: string, request?: T3Request) => Promise<T3Answer>;

const readCapped = async (response: Response, maxBytes: number): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new T3Error("bad_answer", "The environment's answer was too large", response.status);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new T3Error("bad_answer", "The environment's answer was too large", response.status);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
};

export const makeT3Http =
  (options: T3HttpOptions): T3Http =>
  async (target, request = {}) => {
    const url = publicHttpsUrl(target, options.siteHosts);
    let response: Response;
    try {
      response = await options.fetch(url.href, {
        method: request.method ?? "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(request.timeoutMs ?? T3_HTTP_LIMITS.timeoutMs),
        headers: { "user-agent": USER_AGENT, ...(request.headers ?? {}) },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch {
      throw new T3Error("unreachable", "The environment did not answer");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new T3Error(
        "bad_answer",
        "The environment answered with a redirect, which is not followed",
        response.status,
      );
    }
    let text: string;
    try {
      text = await readCapped(response, T3_HTTP_LIMITS.maxBytes);
    } catch (error) {
      if (error instanceof T3Error) throw error;
      throw new T3Error("unreachable", "The environment stopped answering", response.status);
    }
    return { status: response.status, headers: response.headers, text };
  };

/** A JSON object out of an answer, or a {@link T3Error}. */
export const jsonObject = (answer: T3Answer, what: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(answer.text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new T3Error("bad_answer", `${what} was not a JSON object`, answer.status);
};
