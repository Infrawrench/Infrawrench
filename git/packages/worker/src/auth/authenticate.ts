/**
 * From a request (or an SSH key) to a `Principal`. The one place a
 * credential is looked at; everything after it reads the principal.
 *
 * An HTTP request is tried in this order:
 *
 * 1. `Authorization` (Basic for Git, Bearer for the API): a personal access
 *    token (`iwg_`), an Infrawrench API key (`iwk_`) or a CI job token
 *    (`iwj_`). A header that is present but names nothing we can accept is a
 *    refusal (401), never the anonymous answer.
 * 2. The session cookie.
 * 3. Nobody: anonymous, which reads public repositories.
 *
 * Call these inside `withDb` (`db/client.ts`). Nothing here logs a
 * credential, and no error it raises carries one.
 */
import { findKeyByFingerprint, touchKey } from "../db/keys";
import { touchApiKey, verifyApiKey } from "../db/organizations";
import { findAccessTokenByHash, touchAccessToken } from "../db/tokens";
import { provisionSignedInUser } from "../db/users";
import { keepAlive } from "../db/client";
import type { Env } from "../env";
import { presentedCredential, presentsCredentials } from "./credentials";
import { verifyJobToken } from "./job-token";
import { remoteKeySet } from "./jwt";
import { ANONYMOUS, type Principal } from "./principal";
import { authenticateSession } from "./session";
import {
  clearSessionCookie,
  isSecureRequest,
  parseCookies,
  sessionCookieName,
  setSessionCookie,
} from "./session-cookie";
import { type IncomingRequest, isSameOrigin } from "./sign-in";
import { verifyAccessToken } from "./tokens";
import { jwksUrl, workosConfig } from "./workos";

export interface Authenticated {
  readonly principal: Principal;
  /**
   * The request presented a credential and it was refused. The principal is
   * anonymous, but the answer is a 401 (with `BASIC_CHALLENGE` for Git), not
   * whatever an anonymous caller would get.
   */
  readonly refused: boolean;
  /** `Set-Cookie` lines for the response: a refreshed session, or a cleared one. */
  readonly setCookies: readonly string[];
  /** The signed-in person's email, for `session.me`. Only set for a session. */
  readonly email: string | null;
}

const anonymous = (refused: boolean, setCookies: readonly string[] = []): Authenticated => ({
  principal: ANONYMOUS,
  refused,
  setCookies,
  email: null,
});

const fromAuthorization = async (header: string, env: Env): Promise<Authenticated> => {
  const credential = presentedCredential(header);
  if (!credential) return anonymous(true);

  switch (credential.kind) {
    case "access-token": {
      const token = await verifyAccessToken(credential.secret, findAccessTokenByHash);
      if (!token) return anonymous(true);
      void keepAlive(touchAccessToken(token.id));
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
    }
    case "api-key": {
      const key = await verifyApiKey(credential.secret);
      if (!key) return anonymous(true);
      void keepAlive(touchApiKey(key.apiKeyId));
      return {
        principal: {
          kind: "api-key",
          apiKeyId: key.apiKeyId,
          organizationId: key.organizationId,
          userId: key.userId,
          permissions: key.permissions,
        },
        refused: false,
        setCookies: [],
        email: null,
      };
    }
    case "job-token": {
      const claims = await verifyJobToken(env.JOB_TOKEN_KEY, credential.secret);
      if (!claims) return anonymous(true);
      return {
        principal: {
          kind: "job",
          repositoryId: claims.repositoryId,
          write: claims.write,
          runId: claims.runId,
        },
        refused: false,
        setCookies: [],
        email: null,
      };
    }
  }
};

const fromCookie = async (
  sealed: string,
  request: IncomingRequest,
  env: Env,
): Promise<Authenticated> => {
  const secure = isSecureRequest(request);
  // A write that rides on the cookie must come from this site.
  if (!isSameOrigin(request, env)) return anonymous(true);

  const config = workosConfig(env);
  const outcome = await authenticateSession(sealed, {
    config,
    password: env.WORKOS_COOKIE_PASSWORD,
    keys: remoteKeySet(jwksUrl(config)),
    provision: provisionSignedInUser,
    context: {
      ipAddress: request.headers.get("cf-connecting-ip"),
      userAgent: request.headers.get("user-agent"),
    },
  });
  if (outcome.kind === "garbage") return anonymous(false, [clearSessionCookie(secure)]);
  if (outcome.kind === "stale") return anonymous(false);
  return {
    principal: {
      kind: "user",
      userId: outcome.session.userId,
      via: "session",
      scopes: null,
      credentialId: null,
    },
    refused: false,
    setCookies: outcome.refreshed === null ? [] : [setSessionCookie(outcome.refreshed, secure)],
    email: outcome.session.email,
  };
};

/** Who an HTTP request is from. */
export const authenticateRequest = async (
  request: IncomingRequest,
  env: Env,
): Promise<Authenticated> => {
  const authorization = request.headers.get("authorization");
  if (presentsCredentials(authorization)) return fromAuthorization(authorization ?? "", env);

  const sealed = parseCookies(request.headers.get("cookie")).get(
    sessionCookieName(isSecureRequest(request)),
  );
  if (sealed) return fromCookie(sealed, request, env);
  return anonymous(false);
};

/** A public key an SSH client offers, as the SSH server hands it over (`@infrawrench/git-ssh`). */
export interface OfferedSshKey {
  readonly algorithm: string;
  /** The key blob as sent on the wire. */
  readonly blob: Uint8Array;
  /** `SHA256:...` */
  readonly fingerprint: string;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const blobOf = (publicKey: string): Uint8Array => {
  const binary = atob(publicKey);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/**
 * Whose key an SSH client offered: a person's, a repository's deploy key, or
 * nobody's (null: refuse it). The SSH username is always `git` and means
 * nothing. The SSH server calls this before it checks the signature and again
 * after, so `markUsed` is false the first time: a key that was merely offered
 * has not been used.
 */
export const authenticateSshKey = async (
  key: OfferedSshKey,
  options: { readonly markUsed?: boolean } = {},
): Promise<Principal | null> => {
  const owner = await findKeyByFingerprint(key.fingerprint);
  if (!owner) return null;
  // The fingerprint found the row; the stored blob must be the offered one.
  if (owner.key.algorithm !== key.algorithm) return null;
  if (!sameBytes(blobOf(owner.key.publicKey), key.blob)) return null;
  if (options.markUsed) void keepAlive(touchKey(owner));
  return owner.kind === "user"
    ? {
        kind: "user",
        userId: owner.key.userId,
        via: "ssh-key",
        scopes: null,
        credentialId: owner.key.id,
      }
    : {
        kind: "deploy-key",
        keyId: owner.key.id,
        repositoryId: owner.key.repositoryId,
        readOnly: owner.key.readOnly,
      };
};
