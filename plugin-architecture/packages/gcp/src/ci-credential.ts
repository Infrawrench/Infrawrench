/**
 * Lending a GCP connection to a CI job (`manifest.ciCredential`): an OAuth
 * access token for the connection's service account, never its key.
 *
 * - gcloud reads it from a file (`auth/access_token_file`, set through
 *   `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`), and with it ignores any account it
 *   has; Terraform's Google provider reads `GOOGLE_OAUTH_ACCESS_TOKEN`. The
 *   project goes in `CLOUDSDK_CORE_PROJECT` and `GOOGLE_CLOUD_PROJECT`.
 *   Client libraries have no variable for a bare token: a script passes it
 *   to the library itself.
 * - A token lasts an hour. Where the organization lets the account have
 *   longer ones (the `iam.allowServiceAccountCredentialLifetimeExtension`
 *   policy, up to 12 hours) and the account may mint its own
 *   (`iam.serviceAccounts.getAccessToken` on itself), the IAM Credentials
 *   API's `generateAccessToken` mints one for the run instead. Verified
 *   2026-11 against the gcloud configuration topic and the IAM Credentials
 *   API reference.
 */
import type { CiCredentialDeclaration, CiLentMaterial } from "@infrawrench/plugin-base";

/** A token and when it stops working. */
export interface GcpToken {
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface GcpLendDeps {
  /** A fresh token from the key (the JWT bearer exchange): an hour. */
  exchange(): Promise<GcpToken>;
  /**
   * `generateAccessToken` for the account itself, authorized with `bearer`,
   * for `seconds`. Rejects when the account or the organization does not
   * allow it.
   */
  generate(bearer: string, seconds: number): Promise<GcpToken>;
}

/** What one exchange gives, and the most `generateAccessToken` may. */
const HOUR = 3600;
const MAX_SECONDS = 12 * HOUR;

export const GCP_CI_CREDENTIAL: CiCredentialDeclaration = {
  description:
    "An access token for the connection's service account, never its key: gcloud reads it (CLOUDSDK_AUTH_ACCESS_TOKEN_FILE), as does Terraform (GOOGLE_OAUTH_ACCESS_TOKEN), and CLOUDSDK_CORE_PROJECT and GOOGLE_CLOUD_PROJECT name the project. It lasts an hour from when the run is dispatched, or as long as the run may take where the organization allows longer tokens.",
  shortLived: true,
};

/**
 * The only scope GKE needs to authenticate a Google identity: "the
 * credentials for those accounts must include the `userinfo.email` OAuth
 * scope" (GKE, "Authenticate to the Kubernetes API server", read 2026-11).
 * What the identity may then do in the cluster is IAM and RBAC's to say; a
 * token with only this scope can call no other Google API.
 */
export const GKE_TOKEN_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

export interface GkeTokenDeps {
  /** A fresh `cloud-platform` token from the key, never the cached one: the bearer for `generate`. */
  exchange(): Promise<GcpToken>;
  /** `generateAccessToken` for the account itself, with `scopes`, for `seconds`. */
  generate(bearer: string, seconds: number, scopes: readonly string[]): Promise<GcpToken>;
  /** A fresh token from the key with only `scope`: an hour. */
  exchangeScoped(scope: string): Promise<GcpToken>;
}

/**
 * The token a GKE cluster's CI kubeconfig carries: minted for this lend,
 * scoped to `userinfo.email` so it reaches the cluster and no other Google
 * API, and lasting `seconds` where the organization lets the account have
 * longer tokens (and the account may mint its own), else an hour.
 */
export async function gkeCiToken(deps: GkeTokenDeps, seconds: number): Promise<GcpToken> {
  const wanted = Math.min(MAX_SECONDS, Math.max(HOUR, Math.ceil(seconds)));
  const bearer = await deps.exchange().catch(() => null);
  if (bearer) {
    for (const lifetime of wanted > HOUR ? [wanted, HOUR] : [HOUR]) {
      const minted = await deps
        .generate(bearer.token, lifetime, [GKE_TOKEN_SCOPE])
        .catch(() => null);
      if (minted) return minted;
    }
  }
  return deps.exchangeScoped(GKE_TOKEN_SCOPE);
}

/** The body `generateAccessToken` answers with, read. */
export function tokenFromGenerate(body: unknown): GcpToken {
  const answer = body as { accessToken?: unknown; expireTime?: unknown } | null;
  if (typeof answer?.accessToken !== "string" || typeof answer.expireTime !== "string") {
    throw new Error("generateAccessToken answered without a token");
  }
  return { token: answer.accessToken, expiresAt: answer.expireTime };
}

/** What one lend of a GCP connection writes. */
export async function lendGcpToken(
  deps: GcpLendDeps,
  project: string,
  request: { alias: string; ttlSeconds: number },
): Promise<CiLentMaterial> {
  let minted = await deps.exchange();
  const wanted = Math.min(MAX_SECONDS, Math.ceil(request.ttlSeconds));
  if (wanted > HOUR) {
    // Longer only where both the account and its organization allow it;
    // anything else keeps the hour.
    minted = await deps.generate(minted.token, wanted).catch(() => minted);
  }
  const lasts = Math.max(1, Math.round((Date.parse(minted.expiresAt) - Date.now()) / 60_000));
  const tokenFile = `/root/.config/gcloud/${request.alias}.token`;
  return {
    env: {
      CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: [{ text: tokenFile }],
      GOOGLE_OAUTH_ACCESS_TOKEN: minted.token,
      CLOUDSDK_CORE_PROJECT: [{ text: project }],
      GOOGLE_CLOUD_PROJECT: [{ text: project }],
    },
    files: [{ path: tokenFile, mode: "600", content: minted.token }],
    expiresAt: minted.expiresAt,
    summary: `an access token for the service account, ${lasts} minutes`,
  };
}
