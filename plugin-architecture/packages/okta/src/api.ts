import {
  createApiClient,
  restRequest,
  type ApiAnswer,
  type ApiClient,
  type HostServices,
  type HttpHostServices,
  findNextLink,
} from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";
import { apiError, sendRaw } from "./http.js";
import type { RawResponse } from "./http.js";

/**
 * Okta Management API transport.
 *
 * Two ways in, both verified against developer.okta.com (2026-10):
 *  - **API token**: `Authorization: SSWS <token>`. The token inherits the
 *    permissions of the admin who created it.
 *  - **OAuth service app**: client credentials with `private_key_jwt` (the
 *    only client authentication Okta allows for Okta API scopes) against the
 *    org authorization server, `POST {org}/oauth2/v1/token`. New service apps
 *    require DPoP by default, so the client binds tokens with an ephemeral
 *    P-256 key, answers the `use_dpop_nonce` challenge, and sends a fresh
 *    proof (with `ath`) on every API call. Apps with DPoP turned off get a
 *    plain Bearer token through the same path.
 *
 * Everything is WebCrypto (`crypto.subtle`), so it runs in the renderer, the
 * Node host and Workers without a dependency.
 *
 * Requests are typed from Okta's OpenAPI document (`plugingen.json`). Each one is
 * authenticated, and under DPoP signed, in {@link OktaApi.transport}, which is what
 * the client gets as its `http`.
 */

export type Schemas = components["schemas"];

export interface OktaCredentials {
  orgUrl: string;
  apiToken: string;
  clientId: string;
  privateKey: string;
  keyId: string;
  scopes: string;
  caCert: string;
}

/** Scopes requested when the account does not list its own. */
export const DEFAULT_SCOPES = [
  "okta.users.manage",
  "okta.groups.manage",
  "okta.apps.manage",
  "okta.authorizationServers.manage",
  "okta.policies.manage",
  "okta.networkZones.manage",
  "okta.apiTokens.manage",
  "okta.eventHooks.manage",
  "okta.trustedOrigins.manage",
  "okta.domains.manage",
  "okta.orgs.manage",
  "okta.logs.read",
].join(" ");

export function normalizeOrgUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new Error("Okta plugin: missing orgUrl credential");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
  // The admin console lives on `{org}-admin.okta.com`; the API is on the org host.
  const host = parsed.host.replace(
    /-admin\.(okta|oktapreview|okta-emea|okta-gov|okta\.mil)\./,
    ".$1.",
  );
  return `${parsed.protocol}//${host}`;
}

export function readCredentials(credentials: Record<string, string>): OktaCredentials {
  const creds: OktaCredentials = {
    orgUrl: normalizeOrgUrl(credentials["orgUrl"] ?? ""),
    apiToken: (credentials["apiToken"] ?? "").trim(),
    clientId: (credentials["clientId"] ?? "").trim(),
    privateKey: (credentials["privateKey"] ?? "").trim(),
    keyId: (credentials["keyId"] ?? "").trim(),
    scopes: (credentials["scopes"] ?? "").replace(/[,\s]+/g, " ").trim(),
    caCert: credentials["caCert"] ?? "",
  };
  if (!creds.apiToken && !(creds.clientId && creds.privateKey)) {
    throw new Error(
      "Okta plugin: provide either an API token, or a service app client ID and private key",
    );
  }
  return creds;
}

// ---------------------------------------------------------------------------
// JOSE helpers
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const byte of arr) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: object): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

interface SigningKey {
  key: CryptoKey;
  alg: "RS256" | "ES256";
}

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const EC = { name: "ECDSA", namedCurve: "P-256" } as const;

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import the service app's private key: a JWK (as Okta generates it) or a PKCS#8 PEM. */
export async function importSigningKey(material: string): Promise<SigningKey> {
  const text = material.trim();
  if (text.startsWith("{")) {
    const jwk: JsonWebKey & { kid?: string } = JSON.parse(text);
    if (jwk.kty === "RSA") {
      return { key: await crypto.subtle.importKey("jwk", jwk, RSA, false, ["sign"]), alg: "RS256" };
    }
    if (jwk.kty === "EC") {
      return { key: await crypto.subtle.importKey("jwk", jwk, EC, false, ["sign"]), alg: "ES256" };
    }
    throw new Error("Okta plugin: the private key JWK must be RSA or EC P-256");
  }
  if (/BEGIN RSA PRIVATE KEY/.test(text) || /BEGIN EC PRIVATE KEY/.test(text)) {
    throw new Error(
      "Okta plugin: paste the private key as PKCS#8 (-----BEGIN PRIVATE KEY-----) or as the JWK Okta generated. Convert with `openssl pkcs8 -topk8 -nocrypt`.",
    );
  }
  const der = pemBody(text);
  try {
    return { key: await crypto.subtle.importKey("pkcs8", der, RSA, false, ["sign"]), alg: "RS256" };
  } catch {
    try {
      return {
        key: await crypto.subtle.importKey("pkcs8", der, EC, false, ["sign"]),
        alg: "ES256",
      };
    } catch {
      throw new Error("Okta plugin: the private key is not a readable RSA or EC P-256 PKCS#8 key");
    }
  }
}

async function signJwt(signer: SigningKey, header: object, claims: object): Promise<string> {
  const input = `${b64urlJson({ ...header, alg: signer.alg })}.${b64urlJson(claims)}`;
  const params = signer.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : RSA;
  const sig = await crypto.subtle.sign(params, signer.key, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

/** `kid` from a pasted JWK, when the user did not enter one. */
function kidFromJwk(material: string): string {
  if (!material.trim().startsWith("{")) return "";
  try {
    const parsed: { kid?: string | number | boolean | null } = JSON.parse(material);
    return typeof parsed.kid === "string" ? parsed.kid : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Latest X-Rate-Limit-* reading per API path family, captured from responses. */
export interface RateLimitReading {
  bucket: string;
  limit: number;
  remaining: number;
  resetAt: number;
}

/** What a DPoP proof carries in its header. Absent members are dropped by `JSON.stringify`. */
interface PublicJwk {
  kty: string | undefined;
  crv: string | undefined;
  x: string | undefined;
  y: string | undefined;
}

interface DpopClaims {
  htm: string;
  htu: string | undefined;
  iat: number;
  jti: string;
  nonce?: string;
  ath?: string;
}

/** What `POST /oauth2/v1/token` answers, success or failure. */
interface TokenReply {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function parseTokenReply(text: string): TokenReply {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const JSON_ACCEPT = { Accept: "application/json" };

export class OktaApi {
  private signer: Promise<SigningKey> | null = null;
  private dpop: Promise<{ key: CryptoKeyPair; jwk: PublicJwk }> | null = null;
  private token: { value: string; type: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<{ value: string; type: string; expiresAt: number }> | null = null;
  private dpopNonce = "";
  private useDpop = false;
  readonly rateLimits = new Map<string, RateLimitReading>();
  /** Every operation in `plugingen.json`. */
  readonly rest: ApiClient<paths>;
  /** Always there, since {@link transport} falls back to `fetch` where there is no host. */
  private readonly http: HttpHostServices = { request: (req) => this.transport(req) };

  constructor(
    readonly creds: OktaCredentials,
    private readonly services: HostServices | undefined,
  ) {
    this.rest = createApiClient<paths>({
      vendor: "Okta",
      baseUrl: creds.orgUrl,
      headers: JSON_ACCEPT,
      http: this.http,
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      httpError: ({ status, url, body }) => apiError(status, new URL(url).pathname, body),
    });
  }

  get orgUrl(): string {
    return this.creds.orgUrl;
  }

  get authMode(): "api-token" | "oauth" {
    return this.creds.apiToken ? "api-token" : "oauth";
  }

  private async dpopKey() {
    this.dpop ??= (async () => {
      const key = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
      const full = await crypto.subtle.exportKey("jwk", key.publicKey);
      const jwk: PublicJwk = { kty: full.kty, crv: full.crv, x: full.x, y: full.y };
      return { key, jwk };
    })();
    return this.dpop;
  }

  private async dpopProof(method: string, url: string, accessToken?: string): Promise<string> {
    const { key, jwk } = await this.dpopKey();
    const htu = url.split(/[?#]/)[0];
    const claims: DpopClaims = {
      htm: method,
      htu,
      iat: Math.floor(Date.now() / 1000),
      jti: randomId(),
    };
    if (this.dpopNonce) claims.nonce = this.dpopNonce;
    if (accessToken) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
      claims.ath = b64url(hash);
    }
    return signJwt({ key: key.privateKey, alg: "ES256" }, { typ: "dpop+jwt", jwk }, claims);
  }

  private async clientAssertion(tokenUrl: string): Promise<string> {
    this.signer ??= importSigningKey(this.creds.privateKey);
    const signer = await this.signer;
    const kid = this.creds.keyId || kidFromJwk(this.creds.privateKey);
    const now = Math.floor(Date.now() / 1000);
    return signJwt(
      signer,
      { typ: "JWT", ...(kid ? { kid } : {}) },
      {
        iss: this.creds.clientId,
        sub: this.creds.clientId,
        aud: tokenUrl,
        iat: now,
        exp: now + 300,
        jti: randomId(),
      },
    );
  }

  private async fetchToken(): Promise<{ value: string; type: string; expiresAt: number }> {
    const tokenUrl = `${this.creds.orgUrl}/oauth2/v1/token`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        scope: this.creds.scopes || DEFAULT_SCOPES,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await this.clientAssertion(tokenUrl),
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      };
      if (this.useDpop) headers["DPoP"] = await this.dpopProof("POST", tokenUrl);
      const res = await sendRaw(
        { url: tokenUrl, method: "POST", headers, body: form.toString() },
        this.services,
        this.creds.caCert,
      );
      const body = parseTokenReply(res.body);
      if (res.status === 200 && body.access_token) {
        return {
          value: body.access_token,
          type: body.token_type ?? "Bearer",
          expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        };
      }
      const nonce = res.headers["dpop-nonce"];
      if (body.error === "use_dpop_nonce" && nonce) {
        this.useDpop = true;
        this.dpopNonce = nonce;
        continue;
      }
      if (body.error === "invalid_dpop_proof" && !this.useDpop) {
        this.useDpop = true;
        continue;
      }
      throw apiError(res.status, "/oauth2/v1/token", res.body);
    }
    throw apiError(400, "/oauth2/v1/token", "DPoP negotiation did not converge");
  }

  private async accessToken(force = false) {
    if (!force && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token;
    this.tokenPromise ??= this.fetchToken().finally(() => {
      this.tokenPromise = null;
    });
    this.token = await this.tokenPromise;
    return this.token;
  }

  private async authHeaders(
    method: string,
    url: string,
    force: boolean,
  ): Promise<Record<string, string>> {
    if (this.creds.apiToken) return { Authorization: `SSWS ${this.creds.apiToken}` };
    const token = await this.accessToken(force);
    if (token.type.toLowerCase() === "dpop") {
      return {
        Authorization: `DPoP ${token.value}`,
        DPoP: await this.dpopProof(method, url, token.value),
      };
    }
    return { Authorization: `Bearer ${token.value}` };
  }

  private recordRateLimit(path: string, headers: Record<string, string>): void {
    const limit = Number(headers["x-rate-limit-limit"]);
    const remaining = Number(headers["x-rate-limit-remaining"]);
    const reset = Number(headers["x-rate-limit-reset"]);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return;
    const bucket = rateLimitBucket(path);
    this.rateLimits.set(bucket, {
      bucket,
      limit,
      remaining,
      resetAt: Number.isFinite(reset) ? reset * 1000 : Date.now() + 60_000,
    });
  }

  /**
   * The whole of `HttpHostServices` as the client sees it: auth on every attempt, a
   * fresh DPoP proof over the URL, a retry on 401 under OAuth (a new nonce, or a new
   * token), and the rate limit each answer reports.
   */
  private async transport(req: Parameters<HttpHostServices["request"]>[0]): Promise<RawResponse> {
    const { url, method } = req;
    // The client only ever sends JSON text.
    const body = typeof req.body === "string" ? { body: req.body } : {};
    let res: RawResponse | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const auth = await this.authHeaders(
        method,
        url,
        attempt > 0 && res?.status === 401 && !res.headers["dpop-nonce"],
      );
      res = await sendRaw(
        { url, method, headers: { ...auth, ...req.headers }, ...body },
        this.services,
        this.creds.caCert,
      );
      this.recordRateLimit(new URL(url).pathname, res.headers);
      if (res.status === 401 && !this.creds.apiToken) {
        const nonce = res.headers["dpop-nonce"];
        if (nonce) this.dpopNonce = nonce;
        else this.token = null;
        continue;
      }
      break;
    }
    if (!res) throw apiError(500, new URL(url).pathname, "no response");
    return res;
  }

  /**
   * Read a list by following `Link: <…>; rel="next"` from its first page, which is what
   * types the rest. This is by hand rather than `withLinkPagination` because `getAll`
   * reads a body that is not an array as an empty page, and the host prunes whatever a
   * sync stops seeing; spreading it throws. Links go wherever they say, token included
   * (#386).
   */
  private async walk<Item>(
    first: Promise<ApiAnswer<readonly Item[]>>,
    maxPages: number,
    atCap: (path: string, items: number) => void,
  ): Promise<Item[]> {
    const out: Item[] = [];
    const firstPage = await first;
    let page: Pick<ApiAnswer<readonly Item[]>, "body" | "headers"> = firstPage;
    for (let pages = 1; ; pages++) {
      out.push(...(page.body ?? []));
      const next = nextLink(page.headers["link"]);
      if (!next) return out;
      if (pages >= maxPages) {
        // The path as the call wrote it: the base URL has no path of its own.
        atCap(firstPage.url.slice(this.creds.orgUrl.length).split("?")[0] ?? "", out.length);
        return out;
      }
      const url = next.startsWith("http") ? next : `${this.creds.orgUrl}${next}`;
      page = await restRequest<readonly Item[]>({
        vendor: "Okta",
        url,
        headers: JSON_ACCEPT,
        http: this.http,
        contentType: "with-body",
        emptyBodyIsUndefined: true,
        httpError: ({ status, body }) => apiError(status, new URL(url).pathname, body),
      });
    }
  }

  /** Follow the list until exhausted or `maxPages`. A list cut short says so in the log. */
  paginate<Item>(first: Promise<ApiAnswer<readonly Item[]>>, maxPages = 25): Promise<Item[]> {
    return this.walk(first, maxPages, (path, items) => {
      console.warn(`Okta plugin: ${path} truncated at ${maxPages} pages (${items} items)`);
    });
  }

  /**
   * Like {@link paginate}, but every page or nothing: a failed page throws, and
   * so does running past `maxPages`, because a reader that stores the result
   * as the complete set (the seat inventory) must never see a truncated list.
   */
  paginateAll<Item>(first: Promise<ApiAnswer<readonly Item[]>>, maxPages = 1000): Promise<Item[]> {
    return this.walk(first, maxPages, (path) => {
      throw new Error(
        `Okta plugin: ${path} has more than ${maxPages} pages; refusing to return a partial list`,
      );
    });
  }
}

export function nextLink(header: string | undefined): string | null {
  return findNextLink(header) ?? null;
}

/** Okta rate limits are per endpoint family; collapse ids so readings group sensibly. */
export function rateLimitBucket(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  // /api/v1/users/{id}/... → /api/v1/users/{id}
  const base = parts.slice(0, 3);
  const rest = parts.slice(3);
  const shaped = [...base, ...(rest.length > 0 ? ["{id}"] : [])];
  if (rest.length > 1) shaped.push("*");
  return `/${shaped.join("/")}`;
}
