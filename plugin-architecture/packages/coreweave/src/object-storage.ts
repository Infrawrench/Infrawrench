import type { S3StorageConfig } from "@infrawrench/plugin-base";
import { signedS3Fetch, virtualHostedUrl } from "@infrawrench/plugin-base";
import type { CoreWeaveContext } from "./api.js";
import { cwFetch } from "./api.js";
import type { CwAccessKey, CwBucket } from "./mappers.js";

/**
 * CoreWeave AI Object Storage.
 *
 * Two APIs (https://docs.coreweave.com/products/storage/object-storage/reference/about):
 * the AI Object Storage API on `api.coreweave.com` (Bearer token: bucket
 * inventory with usage, bucket settings, access keys) and the S3-compatible
 * API on `cwobject.com` (SigV4: create and delete buckets, objects).
 *
 * The S3 side needs S3 credentials, which this plugin mints itself from the
 * account's API token through `GET /v1/cwobject/temporary-credentials/api-token`
 * (the "direct access token exchange", 2026-06-29). That returns AWS
 * container-credentials JSON (`AccessKeyId`, `SecretAccessKey`, `Token`,
 * `Expiration`), so the user never creates or pastes a static access key.
 * It needs the Object Storage Admin role or an organization access policy
 * granting `cwobject:CreateAccessKey`. The S3 region is the bucket's
 * Availability Zone, and CoreWeave requires virtual-hosted addressing.
 */

export const S3_HOST = "cwobject.com";
export const S3_ENDPOINT = `https://${S3_HOST}`;

const PAGE = 1000;
const MAX_PAGES = 50;

export async function listBuckets(ctx: CoreWeaveContext): Promise<CwBucket[]> {
  const out: CwBucket[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await cwFetch<{ info?: CwBucket[] }>(ctx, "/v1/cwobject/bucket-info", {
      query: { offset: page * PAGE, limit: PAGE },
    });
    const batch = res?.info ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

export async function getBucket(ctx: CoreWeaveContext, name: string): Promise<CwBucket> {
  const res = await cwFetch<{ info?: CwBucket }>(
    ctx,
    `/v1/cwobject/bucket-info/${encodeURIComponent(name)}`,
  );
  if (!res?.info) throw new Error(`CoreWeave plugin: bucket "${name}" not found`);
  return res.info;
}

export interface BucketSettingsInput {
  auditLoggingEnabled?: boolean;
  archiveEnabled?: boolean;
  archiveAfterLastAccessDays?: number;
  capacityCapBytes?: string;
}

export async function setBucketSettings(
  ctx: CoreWeaveContext,
  bucketName: string,
  settings: BucketSettingsInput,
): Promise<void> {
  await cwFetch<unknown>(ctx, "/v1/cwobject/bucket/settings", {
    method: "PUT",
    body: JSON.stringify({ bucketName, settings }),
  });
}

export async function listAccessKeys(ctx: CoreWeaveContext): Promise<CwAccessKey[]> {
  const out: CwAccessKey[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await cwFetch<{ info?: CwAccessKey[] }>(ctx, "/v1/cwobject/access-key", {
      query: { offset: page * PAGE, limit: PAGE },
    });
    const batch = res?.info ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

export async function setPrincipalKeyStatus(
  ctx: CoreWeaveContext,
  principalName: string,
  status: "ACTIVE" | "SUSPENDED",
): Promise<void> {
  await cwFetch<unknown>(ctx, "/v1/cwobject/access-key-status", {
    method: "PUT",
    body: JSON.stringify({ principalName, status }),
  });
}

interface TemporaryCredentials {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  Token?: string;
  Expiration?: string;
}

interface CachedCredentials {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  expiresAt: number;
}

/** Refresh this long before the credentials say they expire. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Exchanges the API token for S3 credentials and caches them until near expiry. */
export class TemporaryS3Credentials {
  private cached: CachedCredentials | undefined;
  private inflight: Promise<CachedCredentials> | undefined;

  constructor(private readonly ctx: CoreWeaveContext) {}

  async get(): Promise<CachedCredentials> {
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return this.cached;
    this.inflight ??= this.exchange().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async exchange(): Promise<CachedCredentials> {
    const res = await cwFetch<TemporaryCredentials>(
      this.ctx,
      "/v1/cwobject/temporary-credentials/api-token",
    );
    if (!res?.AccessKeyId || !res.SecretAccessKey) {
      throw new Error(
        "CoreWeave plugin: the token exchange returned no Object Storage credentials. The token needs the Object Storage Admin role or an organization access policy that grants cwobject:CreateAccessKey.",
      );
    }
    const expiry = res.Expiration ? Date.parse(res.Expiration) : NaN;
    this.cached = {
      accessKey: res.AccessKeyId,
      secretKey: res.SecretAccessKey,
      ...(res.Token ? { sessionToken: res.Token } : {}),
      expiresAt: Number.isFinite(expiry) ? expiry : Date.now() + 15 * 60_000,
    };
    return this.cached;
  }
}

/** S3 config for one bucket; the signing region is its Availability Zone. */
export async function s3ConfigFor(
  creds: TemporaryS3Credentials,
  zone: string,
): Promise<S3StorageConfig> {
  const c = await creds.get();
  return {
    accessKey: c.accessKey,
    secretKey: c.secretKey,
    region: zone,
    ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
    buildUrl: virtualHostedUrl(() => S3_HOST)(zone),
  };
}

async function signedBucketRequest(
  creds: TemporaryS3Credentials,
  zone: string,
  method: "PUT" | "DELETE",
  bucket: string,
  body?: string,
): Promise<void> {
  const c = await creds.get();
  const res = await signedS3Fetch({
    accessKey: c.accessKey,
    secretKey: c.secretKey,
    region: zone,
    method,
    url: `https://${bucket}.${S3_HOST}/`,
    headers: {
      ...(c.sessionToken ? { "x-amz-security-token": c.sessionToken } : {}),
      ...(body ? { "content-type": "application/xml" } : {}),
    },
    ...(body ? { body } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
    throw new Error(
      `CoreWeave Object Storage ${method === "PUT" ? "CreateBucket" : "DeleteBucket"} failed (${res.status}${code ? ` ${code}` : ""})${message ? `: ${message}` : ""}`,
    );
  }
}

/** Bucket names: 3 to 63 lowercase letters, digits, dots and hyphens; not `cw-` or `vip-`. */
export function validateBucketName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) {
    return "Bucket names are 3 to 63 characters of lowercase letters, numbers, dots and hyphens, starting and ending with a letter or number.";
  }
  if (name.startsWith("cw-") || name.startsWith("vip-")) {
    return "Bucket names starting with cw- or vip- are reserved by CoreWeave.";
  }
  if (name.includes("..")) return "Bucket names cannot contain two dots in a row.";
  return null;
}

export async function createBucket(
  creds: TemporaryS3Credentials,
  name: string,
  zone: string,
): Promise<void> {
  const body = `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${zone}</LocationConstraint></CreateBucketConfiguration>`;
  await signedBucketRequest(creds, zone, "PUT", name, body);
}

export async function deleteBucket(
  creds: TemporaryS3Credentials,
  name: string,
  zone: string,
): Promise<void> {
  await signedBucketRequest(creds, zone, "DELETE", name);
}
