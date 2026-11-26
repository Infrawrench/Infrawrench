/**
 * Who an OAuth client is: its name and where it may be sent back to.
 *
 * Nothing is stored for a client. Both ways of naming one carry what there
 * is to know:
 *
 * - **A Client ID Metadata Document** (the current MCP specification's
 *   preferred way): the client id is an `https://` URL, and the document
 *   there says the client's name and redirect URIs. It is fetched when the
 *   client is first seen and kept for a while in the isolate.
 * - **Dynamic registration** (RFC 7591, deprecated by the specification and
 *   still what most clients do): `POST /oauth/register` answers a client id
 *   that *is* the registration, sealed (`sealed.ts`). Registering writes
 *   nothing, so the endpoint cannot be used to fill a table, and a client id
 *   cannot be revoked, which loses nothing: a client id is a name and a list
 *   of addresses, and what is granted to it is a token a person revokes.
 *
 * Every client is public (`token_endpoint_auth_method: none`): what proves an
 * exchange is PKCE, not a secret a desktop app could not keep.
 */
import { blockedHost } from "../../images/proxy";
import { OAuthFailure, failure, readBounded } from "./protocol";
import { sealAs, unsealAs } from "./sealed";

export const CLIENT_ID_PREFIX = "iwc_";

export interface OAuthClient {
  /** The `client_id` as the client presents it. */
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  /** `document`: the id is the address of a metadata document. `registered`: it was made by `/oauth/register`. */
  readonly source: "document" | "registered";
}

const MAX_REDIRECT_URIS = 10;
const MAX_NAME = 100;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Schemes that are a browser's or the system's own, never an app's callback. */
const FORBIDDEN_SCHEMES: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "ws:",
  "wss:",
  "ftp:",
  "mailto:",
  "tel:",
  "sms:",
  "chrome:",
  "view-source:",
  "intent:",
]);

const hasControlOrSpace = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });

/**
 * A redirect URI we would send a code to, or null: `https:`, `http:` to this
 * machine only (a desktop client's listener), or an app's own scheme. Never
 * with a fragment or credentials, and never this site.
 */
export const parseRedirectUri = (value: unknown, siteHosts: readonly string[] = []): URL | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (hasControlOrSpace(value) || value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return siteHosts.includes(url.hostname) ? null : url;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname) ? url : null;
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return null;
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? url : null;
};

/** Whether a redirect URI is this machine's: where anything on it could be listening. */
export const isLoopbackRedirect = (uri: string): boolean => {
  const url = parseRedirectUri(uri);
  return url !== null && url.protocol === "http:";
};

/**
 * Whether `presented` is the registered URI: the same string, or the same
 * loopback address on another port, since a desktop client listens on
 * whichever port it was given (RFC 8252 section 7.3).
 */
export const redirectMatches = (registered: string, presented: string): boolean => {
  if (registered === presented) return true;
  const known = parseRedirectUri(registered);
  const given = parseRedirectUri(presented);
  if (!known || !given) return false;
  if (known.protocol !== "http:" || given.protocol !== "http:") return false;
  return (
    known.hostname === given.hostname &&
    known.pathname === given.pathname &&
    known.search === given.search
  );
};

export const redirectAllowed = (client: OAuthClient, presented: string): boolean =>
  client.redirectUris.some((registered) => redirectMatches(registered, presented));

const cleanName = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  // One line of ordinary text: it is shown on the consent page and in the token list.
  const name = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
  return name === "" ? fallback : name;
};

const redirectUrisOf = (value: unknown, siteHosts: readonly string[]): string[] | OAuthFailure => {
  if (!Array.isArray(value) || value.length === 0) {
    return failure("invalid_redirect_uri", "redirect_uris must list at least one URI");
  }
  if (value.length > MAX_REDIRECT_URIS) {
    return failure("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect URIs`);
  }
  const uris: string[] = [];
  for (const candidate of value) {
    if (parseRedirectUri(candidate, siteHosts) === null) {
      return failure(
        "invalid_redirect_uri",
        "A redirect URI is https, http on localhost, or an app's own scheme, with no fragment",
      );
    }
    uris.push(candidate as string);
  }
  return uris;
};

/** A client asked to authenticate at the token endpoint in a way we do not offer. */
const authMethodRefusal = (metadata: Record<string, unknown>): OAuthFailure | null => {
  const method = metadata["token_endpoint_auth_method"];
  return method === undefined || method === "none"
    ? null
    : failure(
        "invalid_client_metadata",
        "Clients here are public: token_endpoint_auth_method must be none",
      );
};

interface SealedClient {
  /** Name. */
  readonly n: string;
  /** Redirect URIs. */
  readonly r: readonly string[];
  /** Registered at, in seconds since the epoch. */
  readonly t: number;
}

const isSealedClient = (value: unknown): value is SealedClient => {
  if (typeof value !== "object" || value === null) return false;
  const client = value as Partial<SealedClient>;
  return (
    typeof client.n === "string" &&
    typeof client.t === "number" &&
    Array.isArray(client.r) &&
    client.r.every((uri) => typeof uri === "string")
  );
};

export interface RegistrationOptions {
  readonly password: string;
  /** This site's hosts: never a redirect target. */
  readonly siteHosts: readonly string[];
  readonly now?: number;
}

/**
 * Register a client (RFC 7591): validate what it sent and answer a client id
 * that carries it. The answer is the registration response's body.
 */
export const registerClient = async (
  metadata: Record<string, unknown>,
  options: RegistrationOptions,
): Promise<Record<string, unknown> | OAuthFailure> => {
  const uris = redirectUrisOf(metadata["redirect_uris"], options.siteHosts);
  if (uris instanceof OAuthFailure) return uris;
  const grants = metadata["grant_types"];
  if (grants !== undefined && !(Array.isArray(grants) && grants.includes("authorization_code"))) {
    return failure("invalid_client_metadata", "grant_types must include authorization_code");
  }
  const responses = metadata["response_types"];
  if (responses !== undefined && !(Array.isArray(responses) && responses.includes("code"))) {
    return failure("invalid_client_metadata", "response_types must include code");
  }
  const name = cleanName(metadata["client_name"], "MCP client");
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1000);
  const sealed = await sealAs(
    "client",
    { n: name, r: uris, t: issuedAt } satisfies SealedClient,
    options.password,
  );
  return {
    client_id: `${CLIENT_ID_PREFIX}${sealed}`,
    client_id_issued_at: issuedAt,
    client_name: name,
    redirect_uris: uris,
    // Whatever was asked for: every client here is public, and says so by this.
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
};

/** The most of a metadata document that is read. The draft suggests 5 kB; documents with logos run longer. */
const MAX_DOCUMENT_BYTES = 64 * 1024;
const DOCUMENT_TIMEOUT_MS = 5000;
const DOCUMENT_TTL_MS = 15 * 60 * 1000;
const MAX_CACHED_DOCUMENTS = 200;

/** Fetched documents, per isolate: a cache, so being per isolate costs a fetch and nothing else. */
const documents = new Map<string, { readonly client: OAuthClient; readonly until: number }>();

export const forgetClientDocuments = (): void => documents.clear();

/**
 * A client id that is a metadata document's address, or null. `https:`, a
 * path, no fragment, no credentials, and a host on the public internet that
 * is not this site (draft-ietf-oauth-client-id-metadata-document section 3).
 */
export const documentUrl = (clientId: string, siteHosts: readonly string[]): URL | null => {
  if (clientId.length > 2048 || hasControlOrSpace(clientId) || clientId.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  if (url.pathname.split("/").some((part) => part === "." || part === "..")) return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (blockedHost(url.hostname) || siteHosts.includes(url.hostname)) return null;
  // The id is compared as a string everywhere: only one spelling of it is a client.
  return url.href === clientId ? url : null;
};

export type DocumentFetch = (url: string, init: RequestInit) => Promise<Response>;

const fetchDocument = async (
  url: URL,
  fetchDocumentAt: DocumentFetch,
  siteHosts: readonly string[],
): Promise<OAuthClient | null> => {
  let response: Response;
  try {
    response = await fetchDocumentAt(url.href, {
      method: "GET",
      // A redirect would let the document's host choose what is fetched.
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "infrawrench-git-oauth" },
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readBounded(response, MAX_DOCUMENT_BYTES).catch(() => null);
  if (body === null) return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const document = metadata as Record<string, unknown>;
  // The document must say it is this client: otherwise any JSON anywhere would be one.
  if (document["client_id"] !== url.href) return null;
  if (typeof document["client_name"] !== "string") return null;
  if (authMethodRefusal(document) !== null) return null;
  const uris = redirectUrisOf(document["redirect_uris"], siteHosts);
  if (uris instanceof OAuthFailure) return null;
  return {
    id: url.href,
    name: cleanName(document["client_name"], url.hostname),
    redirectUris: uris,
    source: "document",
  };
};

export interface ResolveClientOptions {
  readonly password: string;
  readonly siteHosts: readonly string[];
  readonly fetch: DocumentFetch;
  readonly now?: number;
}

/** The client a `client_id` names, or null for one we do not know. */
export const resolveClient = async (
  clientId: string,
  options: ResolveClientOptions,
): Promise<OAuthClient | null> => {
  if (clientId.startsWith(CLIENT_ID_PREFIX)) {
    const opened = await unsealAs(
      "client",
      clientId.slice(CLIENT_ID_PREFIX.length),
      options.password,
    );
    if (!isSealedClient(opened)) return null;
    return { id: clientId, name: opened.n, redirectUris: opened.r, source: "registered" };
  }
  const url = documentUrl(clientId, options.siteHosts);
  if (url === null) return null;
  const now = options.now ?? Date.now();
  const cached = documents.get(url.href);
  if (cached && cached.until > now) return cached.client;
  const client = await fetchDocument(url, options.fetch, options.siteHosts);
  if (client === null) return null;
  if (documents.size >= MAX_CACHED_DOCUMENTS) documents.clear();
  documents.set(url.href, { client, until: now + DOCUMENT_TTL_MS });
  return client;
};
