/**
 * A person's T3 Code environments (`git_t3_environments`): the rows, their
 * sealed credentials, signing in, and a token that is good now.
 *
 * - **What is sealed**: the client secret (when the server gave one), the
 *   access and refresh tokens, the PKCE verifier of a sign-in in progress,
 *   the resource indicator, the scopes to ask for and where to go back to.
 *   One JSON object, encrypted with server-core's `encrypt` under
 *   `ENCRYPTION_MASTER_KEY` and bound to the row
 *   (`gitT3Environment:<id>:credentials`). Never sent to a client, never
 *   logged; `last_error` holds only sentences written here.
 * - **A sign-in** is `state` (32 random bytes, single use, ten minutes) on
 *   the row of the person who started it. The browser coming back has to be
 *   that person's session (`./callback.ts`), so a `state` cannot be finished
 *   by, or planted on, anybody else.
 * - **A token is refreshed** a minute before it expires, inside a
 *   transaction that holds the row: refresh tokens rotate, and two requests
 *   spending the same one would end the sign-in for both.
 */
import { and, asc, eq, gt } from "drizzle-orm";
import { AUTH_PATHS } from "@infrawrench/git-contract";
import { gitT3Environments } from "@infrawrench/server-core/db/schema";
import { buildAad, decrypt, encrypt } from "@infrawrench/server-core/encryption";
import { db, isUniqueViolation, newId } from "../db/client";
import { type Env, siteOrigin } from "../env";
import { T3Error, type T3Http, makeT3Http } from "./http";
import {
  type OAuthEndpoints,
  type RegisteredClient,
  type TokenSet,
  authorizeUrl,
  discover,
  exchangeCode,
  pkceChallenge,
  randomToken,
  refreshTokens,
  registerClient,
  revokeToken,
} from "./oauth";

export type EnvironmentRow = typeof gitT3Environments.$inferSelect;

/** How long a `state` is accepted. */
export const SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** A token this close to expiring is refreshed first. */
const REFRESH_BEFORE_MS = 60 * 1000;
/** Environments one person may connect. */
export const MAX_ENVIRONMENTS = 20;

interface Credentials {
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  codeVerifier?: string;
  resource?: string;
  /** The scopes the sign-in in progress asked for. */
  scopesAsked?: string[];
  /** A path on this site to go back to after signing in. */
  returnTo?: string;
}

/** What the T3 Code modules need of the world: the guarded fetch, this site, the time. */
export interface T3Deps {
  readonly http: T3Http;
  readonly siteOrigin: string;
  readonly siteHosts: readonly string[];
  readonly now: () => Date;
}

export const t3Deps = (env: Env, request?: Request): T3Deps => {
  const origin = siteOrigin(env);
  const siteHosts = [new URL(origin).hostname, ...(request ? [new URL(request.url).hostname] : [])];
  return {
    // The global `fetch`, looked up at call time.
    http: makeT3Http({ fetch: (input, init) => fetch(input, init), siteHosts }),
    siteOrigin: origin,
    siteHosts,
    now: () => new Date(),
  };
};

export const redirectUri = (deps: Pick<T3Deps, "siteOrigin">): string =>
  `${deps.siteOrigin}${AUTH_PATHS.t3Callback}`;

const aad = (id: string): string => buildAad("gitT3Environment", id, "credentials");

const seal = async (
  id: string,
  credentials: Credentials,
): Promise<{ credentialsCiphertext: string; credentialsIv: string }> => {
  const sealed = await encrypt(JSON.stringify(credentials), aad(id));
  return { credentialsCiphertext: sealed.ciphertext, credentialsIv: sealed.iv };
};

const open = async (row: EnvironmentRow): Promise<Credentials> => {
  if (row.credentialsCiphertext === null || row.credentialsIv === null) return {};
  try {
    return JSON.parse(
      await decrypt(row.credentialsCiphertext, row.credentialsIv, aad(row.id)),
    ) as Credentials;
  } catch {
    // Sealed under another key, or not this row's: as good as signed out.
    return {};
  }
};

const endpointsOf = (row: EnvironmentRow): OAuthEndpoints | null => {
  const metadata = row.oauthMetadata;
  if (!metadata?.issuer || !metadata.authorizationEndpoint || !metadata.tokenEndpoint) return null;
  return {
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorizationEndpoint,
    tokenEndpoint: metadata.tokenEndpoint,
    ...(metadata.registrationEndpoint
      ? { registrationEndpoint: metadata.registrationEndpoint }
      : {}),
    ...(metadata.revocationEndpoint ? { revocationEndpoint: metadata.revocationEndpoint } : {}),
  };
};

const clientOf = (row: EnvironmentRow, credentials: Credentials): RegisteredClient | null =>
  row.oauthClientId === null
    ? null
    : {
        clientId: row.oauthClientId,
        ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
      };

/** A sentence for `last_error`: ours when the failure is one of ours, never an upstream body. */
export const errorSentence = (error: unknown): string =>
  error instanceof T3Error ? error.message : "Something went wrong talking to the environment";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const listEnvironments = (userId: string): Promise<EnvironmentRow[]> =>
  db
    .select()
    .from(gitT3Environments)
    .where(eq(gitT3Environments.userId, userId))
    .orderBy(asc(gitT3Environments.createdAt), asc(gitT3Environments.id));

/** One of the person's own environments. Somebody else's is not found. */
export const getEnvironment = async (
  userId: string,
  environmentId: string,
): Promise<EnvironmentRow | null> => {
  const [row] = await db
    .select()
    .from(gitT3Environments)
    .where(and(eq(gitT3Environments.id, environmentId), eq(gitT3Environments.userId, userId)))
    .limit(1);
  return row ?? null;
};

/** Null when the person already has an environment at that address. */
export const createEnvironment = async (
  userId: string,
  label: string,
  baseUrl: string,
): Promise<EnvironmentRow | null> => {
  try {
    const [row] = await db
      .insert(gitT3Environments)
      .values({ id: newId(), userId, label, baseUrl })
      .returning();
    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
};

export const renameEnvironment = async (
  row: EnvironmentRow,
  label: string,
): Promise<EnvironmentRow> => {
  const [updated] = await db
    .update(gitT3Environments)
    .set({ label, updatedAt: new Date() })
    .where(eq(gitT3Environments.id, row.id))
    .returning();
  return updated ?? row;
};

/** Note that a call failed (or, with null, that one worked). */
export const noteOutcome = async (
  row: Pick<EnvironmentRow, "id">,
  error: unknown | null,
  at: Date = new Date(),
): Promise<void> => {
  // Only a sign-in that no longer holds changes the status: an environment
  // that is asleep is still connected.
  const signedOut = error instanceof T3Error && error.code === "not_signed_in";
  await db
    .update(gitT3Environments)
    .set(
      error === null
        ? { lastError: null, lastUsedAt: at, status: "connected", updatedAt: at }
        : {
            lastError: errorSentence(error),
            updatedAt: at,
            ...(signedOut ? { status: "error" as const } : {}),
          },
    )
    .where(eq(gitT3Environments.id, row.id));
};

/** Remove an environment, revoking what it holds first. Revocation is best effort; the row goes either way. */
export const removeEnvironment = async (deps: T3Deps, row: EnvironmentRow): Promise<void> => {
  const credentials = await open(row);
  const endpoints = endpointsOf(row);
  const client = clientOf(row, credentials);
  if (endpoints && client) {
    // The refresh token first: revoking it ends the grant, access token included, where the server does that.
    if (credentials.refreshToken) {
      await revokeToken(deps.http, endpoints, client, credentials.refreshToken, "refresh_token");
    }
    if (credentials.accessToken) {
      await revokeToken(deps.http, endpoints, client, credentials.accessToken, "access_token");
    }
  }
  await db.delete(gitT3Environments).where(eq(gitT3Environments.id, row.id));
};

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/** A path on this site, or the fallback: never another site, never a scheme. */
export const safeReturnTo = (value: string | undefined, fallback: string): string =>
  value !== undefined && /^\/(?![/\\])[^\s\\]*$/.test(value) && value.length <= 2048
    ? value
    : fallback;

/**
 * Start signing in: discover the environment's authorization server,
 * register this site with it when it has not been (or the server changed),
 * and answer where to send the browser.
 */
export const beginSignIn = async (
  deps: T3Deps,
  row: EnvironmentRow,
  returnTo: string,
): Promise<string> => {
  const now = deps.now();
  try {
    const found = await discover(deps.http, row.baseUrl, deps.siteHosts);
    const before = await open(row);
    const known = endpointsOf(row);
    let client = clientOf(row, before);
    // A client is the registration of one redirect address at one server.
    if (client === null || known?.issuer !== found.endpoints.issuer) {
      client = await registerClient(deps.http, found.endpoints, {
        redirectUri: redirectUri(deps),
      });
    }
    const state = randomToken();
    const verifier = randomToken();
    const credentials: Credentials = {
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      // A sign-in that is not finished leaves the one that stands in place.
      ...(before.accessToken ? { accessToken: before.accessToken } : {}),
      ...(before.refreshToken ? { refreshToken: before.refreshToken } : {}),
      codeVerifier: verifier,
      resource: found.resource,
      scopesAsked: [...found.scopes],
      returnTo,
    };
    await db
      .update(gitT3Environments)
      .set({
        oauthClientId: client.clientId,
        oauthMetadata: { ...found.endpoints },
        ...(await seal(row.id, credentials)),
        oauthState: state,
        oauthStateExpiresAt: new Date(now.getTime() + SIGN_IN_TTL_MS),
        updatedAt: now,
      })
      .where(eq(gitT3Environments.id, row.id));
    return authorizeUrl(found.endpoints, {
      clientId: client.clientId,
      redirectUri: redirectUri(deps),
      state,
      challenge: await pkceChallenge(verifier),
      resource: found.resource,
      scopes: found.scopes,
    });
  } catch (error) {
    await noteOutcome(row, error, now);
    throw error;
  }
};

/** The row a `state` belongs to, while it is accepted. */
export const environmentForState = async (
  state: string,
  now: Date,
): Promise<EnvironmentRow | null> => {
  if (state === "") return null;
  const [row] = await db
    .select()
    .from(gitT3Environments)
    .where(
      and(eq(gitT3Environments.oauthState, state), gt(gitT3Environments.oauthStateExpiresAt, now)),
    )
    .limit(1);
  return row ?? null;
};

const stored = (tokens: TokenSet, before: Credentials, now: Date) => ({
  credentials: {
    ...(before.clientSecret ? { clientSecret: before.clientSecret } : {}),
    ...(before.resource ? { resource: before.resource } : {}),
    accessToken: tokens.accessToken,
    // A server that does not rotate leaves the refresh token in hand.
    ...((tokens.refreshToken ?? before.refreshToken)
      ? { refreshToken: tokens.refreshToken ?? before.refreshToken }
      : {}),
  } satisfies Credentials,
  columns: {
    status: "connected" as const,
    tokenExpiresAt: tokens.expiresAt,
    lastError: null,
    updatedAt: now,
  },
});

/**
 * Finish a sign-in: spend the `state` (it is cleared before the code is
 * exchanged, so it works once), exchange the code, seal the tokens. Answers
 * where to send the browser. The caller has checked whose session this is.
 */
export const completeSignIn = async (
  deps: T3Deps,
  row: EnvironmentRow,
  outcome: { readonly code: string; readonly issuer?: string | null } | { readonly error: string },
): Promise<{ returnTo: string; connected: boolean }> => {
  const now = deps.now();
  const before = await open(row);
  const returnTo = safeReturnTo(before.returnTo, "/settings/t3");
  const [spent] = await db
    .update(gitT3Environments)
    .set({ oauthState: null, oauthStateExpiresAt: null, updatedAt: now })
    .where(
      and(eq(gitT3Environments.id, row.id), eq(gitT3Environments.oauthState, row.oauthState ?? "")),
    )
    .returning({ id: gitT3Environments.id });
  if (!spent) return { returnTo, connected: false };

  const endpoints = endpointsOf(row);
  const client = clientOf(row, before);
  try {
    if ("error" in outcome) {
      throw new T3Error(
        "not_signed_in",
        outcome.error === "access_denied"
          ? "The sign-in was declined in T3 Code"
          : "The environment did not complete the sign-in",
      );
    }
    if (!endpoints || !client || !before.codeVerifier || !before.resource) {
      throw new T3Error("not_signed_in", "That sign-in was not started here. Start it again.");
    }
    // RFC 9207: an answer that names its issuer has to name the one that was asked.
    if (outcome.issuer != null && outcome.issuer !== endpoints.issuer) {
      throw new T3Error("not_signed_in", "The sign-in came back from a different server");
    }
    const tokens = await exchangeCode(
      deps.http,
      endpoints,
      client,
      {
        code: outcome.code,
        verifier: before.codeVerifier,
        redirectUri: redirectUri(deps),
        resource: before.resource,
      },
      now,
    );
    const next = stored(tokens, before, now);
    await db
      .update(gitT3Environments)
      .set({
        ...next.columns,
        ...(await seal(row.id, next.credentials)),
        scopes: [...(tokens.scopes ?? before.scopesAsked ?? [])],
      })
      .where(eq(gitT3Environments.id, row.id));
    return { returnTo, connected: true };
  } catch (error) {
    // The verifier is spent with the state; what stood before the attempt stays.
    const kept: Credentials = { ...before };
    delete kept.codeVerifier;
    delete kept.returnTo;
    delete kept.scopesAsked;
    await db
      .update(gitT3Environments)
      .set({
        ...(await seal(row.id, kept)),
        lastError: errorSentence(error),
        status: kept.accessToken ? row.status : "error",
        updatedAt: now,
      })
      .where(eq(gitT3Environments.id, row.id));
    return { returnTo, connected: false };
  }
};

// ---------------------------------------------------------------------------
// A token that is good now
// ---------------------------------------------------------------------------

const SIGN_IN_AGAIN = "Sign in to this environment again";

/**
 * The environment's access token, refreshed first when it is about to
 * expire. Rejects with `not_signed_in` when there is none to be had.
 */
export const accessToken = async (deps: T3Deps, environmentId: string): Promise<string> => {
  const now = deps.now();
  const fresh = (row: EnvironmentRow): boolean =>
    row.tokenExpiresAt === null || row.tokenExpiresAt.getTime() - now.getTime() > REFRESH_BEFORE_MS;

  const [row] = await db
    .select()
    .from(gitT3Environments)
    .where(eq(gitT3Environments.id, environmentId))
    .limit(1);
  if (!row) throw new T3Error("not_signed_in", "That environment was removed");
  const credentials = await open(row);
  if (credentials.accessToken && fresh(row)) return credentials.accessToken;

  return db
    .transaction(async (tx) => {
      // Held until the new tokens are stored: the refresh token is spent once.
      const [locked] = await tx
        .select()
        .from(gitT3Environments)
        .where(eq(gitT3Environments.id, environmentId))
        .for("update")
        .limit(1);
      if (!locked) throw new T3Error("not_signed_in", "That environment was removed");
      const current = await open(locked);
      // Somebody else refreshed while this waited for the row.
      if (current.accessToken && fresh(locked)) return current.accessToken;
      const endpoints = endpointsOf(locked);
      const client = clientOf(locked, current);
      if (!endpoints || !client || !current.refreshToken || !current.resource) {
        await tx
          .update(gitT3Environments)
          .set({
            status: locked.status === "pending" ? "pending" : "error",
            lastError: SIGN_IN_AGAIN,
          })
          .where(eq(gitT3Environments.id, environmentId));
        throw new T3Error("not_signed_in", SIGN_IN_AGAIN);
      }
      let tokens: TokenSet;
      try {
        tokens = await refreshTokens(
          deps.http,
          endpoints,
          client,
          { refreshToken: current.refreshToken, resource: current.resource },
          now,
        );
      } catch (error) {
        if (error instanceof T3Error && error.code === "not_signed_in") {
          // The refresh token is spent or revoked: nothing sealed is of use any more.
          await tx
            .update(gitT3Environments)
            .set({
              ...(await seal(environmentId, {
                ...(current.clientSecret ? { clientSecret: current.clientSecret } : {}),
                ...(current.resource ? { resource: current.resource } : {}),
              })),
              status: "error",
              tokenExpiresAt: null,
              lastError: SIGN_IN_AGAIN,
              updatedAt: now,
            })
            .where(eq(gitT3Environments.id, environmentId));
          // Returned, not thrown, so the transaction commits what was just written.
          return null;
        }
        throw error;
      }
      const next = stored(tokens, current, now);
      await tx
        .update(gitT3Environments)
        .set({
          ...next.columns,
          ...(await seal(environmentId, next.credentials)),
          ...(tokens.scopes ? { scopes: [...tokens.scopes] } : {}),
        })
        .where(eq(gitT3Environments.id, environmentId));
      return tokens.accessToken;
    })
    .then((token) => {
      if (token === null) throw new T3Error("not_signed_in", SIGN_IN_AGAIN);
      return token;
    });
};
