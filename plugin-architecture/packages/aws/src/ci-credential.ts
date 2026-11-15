/**
 * Lending an AWS connection to a CI job (`manifest.ciCredential`): STS
 * session credentials minted from the connection's access key for as long
 * as the job may run, as the environment variables every AWS SDK and the
 * AWS CLI read first, and as a named profile in the shared files, so a job
 * lent two AWS connections can pick one with `--profile <alias>`.
 *
 * `GetSessionToken` (STS Query API, Version 2011-06-15, verified 2026-11
 * against the API reference): needs no permission, takes `DurationSeconds`
 * from 900 to 129,600 for an IAM user's key (a root key's session is cut to
 * an hour), and returns `Credentials` with `AccessKeyId`,
 * `SecretAccessKey`, `SessionToken` and `Expiration`. What the session can
 * call is the user's own permissions less two things: IAM API operations
 * (without MFA) and every STS operation but `AssumeRole` and
 * `GetCallerIdentity`. Nothing falls back to the stored key: a job that
 * cannot have a session is refused, saying why.
 */
import type { CiCredentialDeclaration, CiLentMaterial } from "@infrawrench/plugin-base";

/** Session credentials as STS returns them. */
export interface AwsSession {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO 8601. */
  expiration?: string;
}

/** The STS call lending makes, bound to the connection. */
export type GetSessionToken = (durationSeconds: number) => Promise<AwsSession>;

/** GetSessionToken's bounds for an IAM user's key. */
const MIN_SECONDS = 900;
const MAX_SECONDS = 129_600;

export const AWS_CI_CREDENTIAL: CiCredentialDeclaration = {
  description:
    "STS session credentials for the connection's IAM user, minted for each run and expiring with it: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN and AWS_REGION, and a profile named after the connection in ~/.aws. A session cannot call IAM, or STS beyond AssumeRole and GetCallerIdentity.",
  shortLived: true,
};

/**
 * STS in a region: `sts.<region>.amazonaws.com`, `.com.cn` in China. A
 * regional endpoint's sessions work in every region the account has,
 * opt-in ones included.
 */
export function stsHost(region: string): string {
  return `sts.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`;
}

/** A GetSessionToken answer, as `parseXml` gives it. */
export function sessionFromResponse(parsed: Record<string, unknown>): AwsSession {
  const result = (parsed["GetSessionTokenResult"] ??
    (parsed["GetSessionTokenResponse"] as Record<string, unknown> | undefined)?.[
      "GetSessionTokenResult"
    ]) as Record<string, unknown> | undefined;
  const creds = result?.["Credentials"] as Record<string, unknown> | undefined;
  const field = (name: string) => {
    const value = creds?.[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const session = {
    accessKeyId: field("AccessKeyId"),
    secretAccessKey: field("SecretAccessKey"),
    sessionToken: field("SessionToken"),
  };
  if (!session.accessKeyId || !session.secretAccessKey || !session.sessionToken) {
    throw new Error("STS answered GetSessionToken without credentials");
  }
  const expiration = field("Expiration");
  return expiration ? { ...session, expiration } : session;
}

/** What one lend of an AWS connection writes: environment variables and a named profile. */
export async function lendAwsSession(
  getSessionToken: GetSessionToken,
  region: string,
  request: { alias: string; ttlSeconds: number },
): Promise<CiLentMaterial> {
  const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.ceil(request.ttlSeconds)));
  let session: AwsSession;
  try {
    session = await getSessionToken(seconds);
  } catch (err) {
    throw new Error(
      `STS would not mint session credentials for this connection's access key (${
        err instanceof Error ? err.message : String(err)
      })`,
      { cause: err },
    );
  }
  const profile = request.alias;
  return {
    env: {
      AWS_ACCESS_KEY_ID: session.accessKeyId,
      AWS_SECRET_ACCESS_KEY: session.secretAccessKey,
      AWS_SESSION_TOKEN: session.sessionToken,
      AWS_REGION: [{ text: region }],
      AWS_DEFAULT_REGION: [{ text: region }],
    },
    files: [
      {
        path: "/root/.aws/credentials",
        mode: "600",
        content: [
          { text: `[${profile}]\naws_access_key_id = ` },
          { secret: session.accessKeyId },
          { text: "\naws_secret_access_key = " },
          { secret: session.secretAccessKey },
          { text: "\naws_session_token = " },
          { secret: session.sessionToken },
          { text: "\n" },
        ],
      },
      {
        path: "/root/.aws/config",
        mode: "600",
        content: [{ text: `[profile ${profile}]\nregion = ${region}\n` }],
      },
    ],
    ...(session.expiration ? { expiresAt: session.expiration } : {}),
    summary: `STS session credentials, ${Math.round(seconds / 60)} minutes`,
  };
}
