/**
 * The MCP server and its authorization server as one site, for tests: the
 * real handlers behind one `fetch`, with the two things they reach replaced.
 * Grants live in a map instead of `git_access_tokens`, and the JSON API the
 * tools call is a function the test supplies. Tokens are checked with the
 * real `verifyAccessToken`, so expiry and revocation behave as they do in
 * the Worker.
 */
import type { Authenticated } from "../../auth/authenticate";
import { presentedCredential } from "../../auth/credentials";
import { ANONYMOUS, type Principal } from "../../auth/principal";
import { isSameOrigin } from "../../auth/sign-in";
import { type StoredAccessToken, verifyAccessToken } from "../../auth/tokens";
import { routeOf } from "../../http/router";
import type { ApiHandle } from "../api";
import { handleMcp } from "../http";
import { handleAuthorize } from "../oauth/authorize";
import { type DocumentFetch, resolveClient } from "../oauth/clients";
import { handleRegister, handleRevoke, handleToken, handleWellKnown } from "../oauth/endpoints";
import type { GrantStore, StoredGrant } from "../oauth/grants";

export const ORIGIN = "https://git.example.test";
export const PASSWORD = "a-cookie-password-of-at-least-thirty-two-characters";

export interface StoredRow extends StoredGrant {
  name: string;
  prefix: string;
}

/** `git_access_tokens`, as a map. */
export const memoryGrantStore = (): GrantStore & { readonly rows: Map<string, StoredRow> } => {
  const rows = new Map<string, StoredRow>();
  return {
    rows,
    async insert(grant) {
      if (rows.has(grant.id)) return false;
      rows.set(grant.id, {
        id: grant.id,
        userId: grant.userId,
        name: grant.name,
        prefix: grant.prefix,
        hashedToken: grant.hash,
        scopes: [...grant.scopes],
        expiresAt: grant.expiresAt,
        revokedAt: null,
      });
      return true;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async findByHash(hash) {
      return [...rows.values()].find((row) => row.hashedToken === hash) ?? null;
    },
    async rotate(rotation) {
      const row = rows.get(rotation.id);
      if (!row || row.revokedAt !== null || row.hashedToken !== rotation.fromHash) return false;
      rows.set(row.id, {
        ...row,
        hashedToken: rotation.toHash,
        prefix: rotation.prefix,
        expiresAt: rotation.expiresAt,
      });
      return true;
    },
    async revoke(id) {
      const row = rows.get(id);
      if (row && row.revokedAt === null) rows.set(id, { ...row, revokedAt: new Date() });
    },
  };
};

export interface SiteOptions {
  /** The JSON API the tools call. */
  readonly api?: ApiHandle;
  /** What a Client ID Metadata Document's address answers. */
  readonly documents?: DocumentFetch;
  /** Other credentials `/mcp` accepts, by their `Authorization` header. */
  readonly principals?: ReadonlyMap<string, Principal>;
  /** The clock, in milliseconds. */
  readonly now?: () => number;
}

export interface Site {
  readonly store: ReturnType<typeof memoryGrantStore>;
  /** Every request the tools made to the API, in order. */
  readonly apiCalls: Request[];
  /** The site's `fetch`. A `cookie: session=<user id>` header is a signed-in browser. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export const makeSite = (options: SiteOptions = {}): Site => {
  const store = memoryGrantStore();
  const apiCalls: Request[] = [];
  const now = options.now ?? Date.now;
  const env = { SITE_ORIGIN: ORIGIN };

  /** A browser's session: a cookie naming the person, held to the site's own-origin rule for writes. */
  const session = async (request: Request): Promise<Authenticated> => {
    const userId = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (!userId) return { principal: ANONYMOUS, refused: false, setCookies: [], email: null };
    if (!isSameOrigin(request, env)) {
      return { principal: ANONYMOUS, refused: true, setCookies: [], email: null };
    }
    return {
      principal: { kind: "user", userId, via: "session", scopes: null, credentialId: null },
      refused: false,
      setCookies: [],
      email: `${userId}@example.test`,
    };
  };

  /** A bearer credential: one of the test's own, or a token of the store. */
  const bearer = async (request: Request): Promise<Authenticated> => {
    const header = request.headers.get("authorization") ?? "";
    const refused: Authenticated = {
      principal: ANONYMOUS,
      refused: true,
      setCookies: [],
      email: null,
    };
    const given = options.principals?.get(header);
    if (given) return { principal: given, refused: false, setCookies: [], email: null };
    const credential = presentedCredential(header);
    if (credential?.kind !== "access-token") return refused;
    const token = await verifyAccessToken(
      credential.secret,
      async (hash) => {
        const row = [...store.rows.values()].find((candidate) => candidate.hashedToken === hash);
        return (row as StoredAccessToken | undefined) ?? null;
      },
      new Date(now()),
    );
    if (!token) return refused;
    return {
      principal: {
        kind: "user",
        userId: token.userId,
        via: "token",
        scopes: token.scopes,
        credentialId: token.id,
      },
      refused: false,
      setCookies: [],
      email: null,
    };
  };

  const api: ApiHandle = async (request) => {
    apiCalls.push(request.clone());
    return options.api
      ? options.api(request)
      : Response.json({ error: "Not found" }, { status: 404 });
  };

  return {
    store,
    apiCalls,
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const route = routeOf(url.pathname);
      const grants = { password: PASSWORD, store, now: now() };
      const siteHosts = [new URL(ORIGIN).hostname];
      switch (route.kind) {
        case "well-known":
          return handleWellKnown(request, ORIGIN);
        case "mcp":
          return handleMcp(request, {
            origin: ORIGIN,
            authenticate: bearer,
            admit: async () => null,
            api,
          });
        case "oauth":
          switch (route.action) {
            case "register":
              return handleRegister(request, { password: PASSWORD, siteHosts, now: now() });
            case "token":
              return handleToken(request, { ...grants, origin: ORIGIN });
            case "revoke":
              return handleRevoke(request, grants);
            case "authorize":
              return handleAuthorize(request, {
                origin: ORIGIN,
                password: PASSWORD,
                now: now(),
                authenticate: session,
                resolveClient: (clientId) =>
                  resolveClient(clientId, {
                    password: PASSWORD,
                    siteHosts,
                    now: now(),
                    fetch:
                      options.documents ?? (async () => new Response("nothing", { status: 404 })),
                  }),
                usernameOf: async (userId) => userId,
              });
          }
        // eslint-disable-next-line no-fallthrough
        default:
          return new Response(`not routed: ${route.kind}`, { status: 599 });
      }
    },
  };
};

/** The sealed request in a consent page's form. */
export const consentRequestOf = (html: string): string => {
  const sealed = /name="request" value="([^"]+)"/.exec(html)?.[1];
  if (!sealed) throw new Error(`no consent form in:\n${html.slice(0, 500)}`);
  return sealed;
};

/**
 * What a person's browser does with an authorization URL: open it signed in
 * as `userId`, and press Allow or Deny. Answers where the browser was sent.
 */
export const browse = async (
  site: Site,
  authorizationUrl: string | URL,
  userId: string,
  decision: "allow" | "deny" = "allow",
): Promise<URL> => {
  const cookie = `session=${userId}`;
  const shown = await site.fetch(authorizationUrl, { headers: { cookie }, redirect: "manual" });
  if (shown.status !== 200) {
    throw new Error(`consent page answered ${shown.status}: ${shown.headers.get("location")}`);
  }
  const decided = await site.fetch(authorizationUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ request: consentRequestOf(await shown.text()), decision }),
  });
  if (decided.status !== 303) throw new Error(`deciding answered ${decided.status}`);
  return new URL(decided.headers.get("location")!);
};
