/**
 * Hosted Docker builds on Google Cloud Build.
 *
 * This is the default for a web deploy, so a paying customer does not have to
 * own a build host, which also makes the non-container targets (a Worker, a
 * static site) deployable from the web app at all, since those projects
 * frequently have no VM anywhere.
 *
 * **Why not build in our own cluster.** A Dockerfile's `RUN` is arbitrary code
 * with network access, so an in-cluster build would put the GKE metadata server
 * (`169.254.169.254` → node service-account credentials) and every other pod one
 * `curl` away from a customer's build. That is precisely the exposure
 * `@infrawrench/egress-proxy` exists to keep workflow `fetch` away from, and a
 * build is strictly more capable than a fetch. Cloud Build runs on
 * Google-managed workers with no path back here, so the isolation is structural
 * rather than something we have to keep getting right in a NetworkPolicy.
 *
 * **What a build can reach.** Every step can mint an access token for the
 * build's service account from the worker's metadata server, and the customer
 * controls what the steps run, so that account is treated as belonging to
 * whoever wrote the Dockerfile. It is a dedicated account (`serviceAccount` on
 * every submission, never the project default) holding no data access at all:
 * the source comes in and the staged image goes out through V4 signed URLs
 * minted per object by this module, so a build can read its own tarball and
 * write its own image and nothing else in the bucket; run() reads its output
 * back the same way rather than from a shared log bucket; and each per-build
 * secret is bound to the account individually rather than by a name prefix.
 * The one project-level role it holds is `logging.logWriter`, which writes log
 * entries and reads none. infra/terraform/builds.tf is the other half of this.
 *
 * **Where the image goes.** To the registry the Infrafile's `plan()` returned,
 * not ours. Pushing to an Infrawrench-owned registry would mean the customer's
 * cluster could not pull without us minting and rotating a pull credential for
 * it; sending it to their own registry keeps that boundary where it already is.
 *
 * Cost is bounded by a hard per-build timeout, and every build's duration is
 * recorded so it can be metered.
 */
import { createHash, randomUUID } from "node:crypto";

import { infrafileImageRef } from "@infrawrench/workflow-runtime";

import type {
  BuildRequest,
  BuildResult,
  RunInImageRequest,
  RunInImageResult,
} from "@infrawrench/workflow-runtime";

/** Wall-clock ceiling for one hosted build. Enforced by Cloud Build itself. */
export const HOSTED_BUILD_TIMEOUT_SECONDS = 1200;

/** Machine type for hosted builds. Deliberately not configurable by the caller. */
const HOSTED_BUILD_MACHINE = "E2_HIGHCPU_8";

/**
 * Polling backoff for a running build. Starts tight so a short `run()` is not
 * charged a fixed delay it did not need, then relaxes for a long image build.
 */
const POLL_MIN_MS = 800;
const POLL_MAX_MS = 5000;

export interface CloudBuildConfig {
  /** GCP project that owns the builds, the staging bucket and the build secrets. */
  projectId: string;
  /**
   * GCS bucket holding uploaded build sources, staged images and run() output.
   * Builds never get IAM access to it; they reach their own objects through
   * signed URLs.
   */
  stagingBucket: string;
  /**
   * Email of the dedicated service account builds run as. Required: without it
   * Cloud Build falls back to the project's default account, which is shared
   * with everything else in the project and on many projects still holds
   * Editor.
   */
  serviceAccount: string;
  /** Region for the build worker pool, e.g. "us-east4". */
  region?: string;
}

/**
 * Reads the hosted-build configuration from the environment. Returns null when
 * it is absent, which is how a deployment without Cloud Build set up reports
 * "hosted builds are unavailable here" rather than failing obscurely later.
 */
export function cloudBuildConfig(): CloudBuildConfig | null {
  const projectId = process.env["GCP_BUILD_PROJECT_ID"];
  const stagingBucket = process.env["GCP_BUILD_STAGING_BUCKET"];
  const serviceAccount = process.env["GCP_BUILD_SERVICE_ACCOUNT"];
  // Fails closed: a deployment that has not named the build account reports
  // hosted builds as unavailable rather than running customer code as the
  // project default.
  if (!projectId || !stagingBucket || !serviceAccount) return null;
  const region = process.env["GCP_BUILD_REGION"];
  return { projectId, stagingBucket, serviceAccount, ...(region ? { region } : {}) };
}

export interface CloudBuildContext {
  config: CloudBuildConfig;
  /** The repository source, as a gzipped tarball. */
  sourceTarGz: Uint8Array;
  gitSha: string;
  /** `owner/name`, so the image name matches every other driver's. */
  repo?: string;
  /** Live output sink. */
  log: (line: string) => void;
  signal?: AbortSignal;
  /**
   * The GCS prefix every object this deploy stages lives under, so cleanup can
   * remove them together. Set on first use.
   */
  stagingPrefix?: string;
  /**
   * Set by {@link buildOnCloudBuild}: the GCS objects holding the source and
   * the `docker save` of the built image, and the local tag that image loads
   * as. `run()` reuses all three: the same source so `/workspace` holds the
   * project, and the image tarball because an image built in one build's
   * daemon does not exist on the next build's worker.
   */
  sourceObject?: string;
  imageObject?: string;
  stagedImage?: string;
}

/** A completed hosted build, with what it cost us in worker time. */
export interface HostedBuildResult extends BuildResult {
  /** Seconds of build-worker time, for metering. */
  buildSeconds: number;
}

/**
 * Base URL for the Builds API. A configured region routes to the regional
 * endpoint: without this, `GCP_BUILD_REGION` was read into the config and then
 * ignored, so "regional builds" silently ran in the global pool.
 */
function buildsApiBase(config: CloudBuildConfig): string {
  const project = encodeURIComponent(config.projectId);
  return config.region
    ? `https://cloudbuild.googleapis.com/v1/projects/${project}/locations/${encodeURIComponent(config.region)}`
    : `https://cloudbuild.googleapis.com/v1/projects/${project}`;
}

/* ------------------------------------------------------------------ auth -- */

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cached: CachedToken | null = null;

/**
 * An access token for our own Google APIs.
 *
 * Prefers the GKE metadata server (workload identity: no key material to hold
 * or rotate) and falls back to a service-account key for environments that have
 * no metadata server, such as a self-hosted deployment or local development.
 *
 * Note this is *our* credential being read by *our* code. It is unrelated to
 * the metadata exposure the module header describes, which is about customer
 * build steps being able to reach it.
 */
async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const key = process.env["GCP_BUILD_SA_KEY"];
  const token = key ? await tokenFromServiceAccountKey(key) : await tokenFromMetadataServer();
  cached = token;
  return token.token;
}

async function tokenFromMetadataServer(): Promise<CachedToken> {
  const res = await fetch(
    "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) {
    throw new Error(
      `Could not get a Google access token from the metadata server (${res.status}). ` +
        `Set GCP_BUILD_SA_KEY if this deployment is not running on GCP.`,
    );
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** The PKCS#8 key from a service-account JSON key, ready to sign with. */
async function importSigningKey(key: ServiceAccountKey) {
  const der = Buffer.from(
    key.private_key
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, ""),
    "base64",
  );
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Self-signed JWT → access token. Same shape the GCP plugin uses, no new deps. */
async function tokenFromServiceAccountKey(rawKey: string): Promise<CachedToken> {
  const key = JSON.parse(rawKey) as ServiceAccountKey;
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) =>
    Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const claim = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claim))}`;

  const cryptoKey = await importSigningKey(key);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${Buffer.from(sig).toString("base64url")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

/* --------------------------------------------------------- signed URLs -- */

/**
 * How long a signed URL handed to a build stays valid. The image upload is the
 * last thing a build does, so this has to cover queueing plus the whole
 * {@link HOSTED_BUILD_TIMEOUT_SECONDS}, with room to spare.
 */
const SIGNED_URL_TTL_SECONDS = 3600;

/** Something that can produce an RSA-SHA256 signature as our service account. */
interface UrlSigner {
  email: string;
  sign: (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
}

let cachedSigner: UrlSigner | null = null;

/**
 * Our identity for signing URLs. With a JSON key that is a local signature; on
 * GKE there is no private key in the pod, so the IAM Credentials API signs on
 * our behalf (`iam.serviceAccounts.signBlob` on our own account, granted in
 * builds.tf).
 */
async function urlSigner(): Promise<UrlSigner> {
  if (cachedSigner) return cachedSigner;
  const rawKey = process.env["GCP_BUILD_SA_KEY"];
  if (rawKey) {
    const key = JSON.parse(rawKey) as ServiceAccountKey;
    const cryptoKey = await importSigningKey(key);
    cachedSigner = {
      email: key.client_email,
      sign: async (data) =>
        new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, data)),
    };
    return cachedSigner;
  }
  const res = await fetch(
    "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/email",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) {
    throw new Error(
      `Could not read this pod's service account from the metadata server (${res.status}).`,
    );
  }
  const email = (await res.text()).trim();
  cachedSigner = {
    email,
    sign: async (data) => {
      const token = await accessToken();
      const signed = await fetch(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signBlob`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ payload: Buffer.from(data).toString("base64") }),
        },
      );
      if (!signed.ok) throw new Error(`Could not sign a staging URL (${signed.status}).`);
      const body = (await signed.json()) as { signedBlob: string };
      return new Uint8Array(Buffer.from(body.signedBlob, "base64"));
    },
  };
  return cachedSigner;
}

/** RFC 3986 percent-encoding: everything but the unreserved characters. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

interface SignedUrlInput {
  method: "GET" | "PUT";
  bucket: string;
  object: string;
  email: string;
  now: Date;
  expiresSeconds: number;
  sign: (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
}

/**
 * A V4 signed URL for one object. Path-style, so a bucket name with dots still
 * matches the TLS certificate. Only `host` is signed, so the headers curl sends
 * with an upload have no bearing on the signature.
 */
async function signGcsUrl(input: SignedUrlInput): Promise<string> {
  const host = "storage.googleapis.com";
  const timestamp = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const scope = `${timestamp.slice(0, 8)}/auto/storage/goog4_request`;
  const path = `/${input.bucket}/${input.object.split("/").map(rfc3986).join("/")}`;
  const params: Record<string, string> = {
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${input.email}/${scope}`,
    "X-Goog-Date": timestamp,
    "X-Goog-Expires": String(input.expiresSeconds),
    "X-Goog-SignedHeaders": "host",
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k] ?? "")}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    path,
    query,
    // Canonical headers end with their own newline, then the list is joined
    // with another, which is the blank line the spec calls for.
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "GOOG4-RSA-SHA256",
    timestamp,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signature = Buffer.from(await input.sign(new TextEncoder().encode(stringToSign))).toString(
    "hex",
  );
  return `https://${host}${path}?${query}&X-Goog-Signature=${signature}`;
}

/** Test seam: the canonical request is easy to get subtly wrong. */
export const __signGcsUrlForTests = signGcsUrl;

/**
 * A URL that lets whoever holds it do exactly one thing to exactly one staging
 * object for {@link SIGNED_URL_TTL_SECONDS}. This is the only way a build
 * reaches staging storage: its service account has no access to the bucket, so
 * a build that reads its own metadata token gets nothing it could use on
 * another deploy's source, image or output.
 */
async function stagingUrl(
  config: CloudBuildConfig,
  method: "GET" | "PUT",
  object: string,
): Promise<string> {
  const signer = await urlSigner();
  return signGcsUrl({
    method,
    bucket: config.stagingBucket,
    object,
    email: signer.email,
    now: new Date(),
    expiresSeconds: SIGNED_URL_TTL_SECONDS,
    sign: signer.sign,
  });
}

function stagingObjectUrl(config: CloudBuildConfig, object: string): string {
  return (
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.stagingBucket)}` +
    `/o/${encodeURIComponent(object)}`
  );
}

/** Read one staging object as text, with our own credential. */
async function readStagingObject(config: CloudBuildConfig, object: string): Promise<string> {
  const token = await accessToken();
  const res = await fetch(`${stagingObjectUrl(config, object)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return "";
  return res.text();
}

/** Delete one staging object. Best effort; the bucket's lifecycle rule is the backstop. */
async function deleteStagingObject(config: CloudBuildConfig, object: string): Promise<void> {
  const token = await accessToken();
  await fetch(stagingObjectUrl(config, object), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/* ----------------------------------------------------------------- build -- */

/** Single-quote a value for a shell step. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The image every step of ours runs in: Google's Docker builder, which carries
 * `docker`, `curl`, `tar` and bash. Its default entrypoint is `docker`, so a
 * scripted step overrides it.
 */
const WORKER_IMAGE = "gcr.io/cloud-builders/docker";

/**
 * Shared between a run() build's steps so the command's report survives to the
 * step that uploads it. Cloud Build rejects a named volume only one step mounts.
 */
const SCRATCH_VOLUME = { name: "iw-scratch", path: "/iw" };

/**
 * Local-only tag for the image a deploy built. `.invalid` is reserved (RFC
 * 2606), so if the tag is ever missing from the worker's daemon the pull fails
 * rather than fetching an image somebody else published under the same name.
 */
const STAGED_IMAGE_REPO = "infrawrench.invalid/staged";

/** Every object a deploy stages shares one prefix, so cleanup can find them all. */
function stagingPrefix(ctx: CloudBuildContext): string {
  ctx.stagingPrefix ??= `deploys/${randomUUID()}/`;
  return ctx.stagingPrefix;
}

/**
 * What every submission has in common.
 *
 * `serviceAccount` is the point of this whole arrangement: without it Cloud
 * Build runs as the project's default account, which is shared with everything
 * else in the project. Naming an account also obliges an explicit log
 * destination. Cloud Logging is the one that costs no isolation: the
 * alternative, a logs bucket, needs the build account to hold storage access
 * that would let one customer's build read another's log.
 */
function submission(config: CloudBuildConfig, extraOptions: Record<string, unknown> = {}) {
  return {
    timeout: `${HOSTED_BUILD_TIMEOUT_SECONDS}s`,
    serviceAccount: `projects/${config.projectId}/serviceAccounts/${config.serviceAccount}`,
    options: { machineType: HOSTED_BUILD_MACHINE, logging: "CLOUD_LOGGING_ONLY", ...extraOptions },
  };
}

/**
 * Shell that downloads a deploy's source through a signed URL and lays it out
 * in `/workspace`, the step's working directory.
 *
 * GitHub wraps a tarball in one directory, so this flattens ONLY a tarball that
 * is wrapped in exactly one directory: GitHub's signature. An earlier version
 * took the first directory it saw, so an unwrapped archive whose root happened
 * to contain `src/` had *that* flattened instead, silently destroying the
 * layout and failing later at a COPY. Found by running a real build.
 */
function fetchSourceScript(sourceUrl: string): string {
  return `curl -fsSL --retry 3 -o /tmp/iw-source.tar.gz ${shellQuote(sourceUrl)}
tar -xzf /tmp/iw-source.tar.gz -C /workspace
rm -f /tmp/iw-source.tar.gz
cd /workspace
entries=$(ls -A)
count=$(printf '%s\\n' "$entries" | wc -l | tr -d ' ')
if [ "$count" = "1" ] && [ -d "$entries" ]; then
  mv "$entries"/.[!.]* . 2>/dev/null || true
  mv "$entries"/* . 2>/dev/null || true
  rmdir "$entries" 2>/dev/null || true
fi`;
}

interface ImageBuildInput {
  config: CloudBuildConfig;
  request: BuildRequest;
  image: string;
  staged: string;
  sourceUrl: string;
  imageUploadUrl: string;
  secretName?: string;
}

/**
 * The Cloud Build submission for an image build. Pure, so the isolation
 * properties (named account, no bucket source, no logs bucket) can be tested
 * without a network.
 */
function imageBuildConfig(input: ImageBuildInput): Record<string, unknown> {
  const { request, image, staged } = input;
  const buildArgs = Object.entries(request.args ?? {}).flatMap(([k, v]) => [
    "--build-arg",
    `${k}=${v}`,
  ]);

  const steps: unknown[] = [
    {
      // Source in, then the rendered Dockerfile beside it rather than inside
      // the archive, which keeps this module free of a hand-rolled tar writer.
      name: WORKER_IMAGE,
      entrypoint: "bash",
      args: [
        "-c",
        `set -e
${fetchSourceScript(input.sourceUrl)}
printf '%s' ${shellQuote(request.dockerfile)} > Dockerfile.infrawrench`,
      ],
    },
    {
      name: WORKER_IMAGE,
      args: ["build", "-f", "Dockerfile.infrawrench", "-t", image, "-t", staged, ...buildArgs, "."],
    },
    {
      // Staged for run(): a later build loads this tarball, because an image
      // built in one build's daemon does not exist on the next build's worker.
      // It goes to an object only this URL can write, not to a shared
      // registry every build could read and overwrite.
      name: WORKER_IMAGE,
      entrypoint: "bash",
      args: [
        "-c",
        `set -e
docker save -o /tmp/iw-image.tar ${shellQuote(staged)}
curl -fsS --retry 3 -T /tmp/iw-image.tar ${shellQuote(input.imageUploadUrl)}
rm -f /tmp/iw-image.tar`,
      ],
    },
  ];

  // A registry means push; without one the image stays local to the build and
  // is never published anywhere.
  //
  // The password goes through Secret Manager rather than the build config: a
  // step's arguments are recorded in the build history of OUR project, so a
  // `--password` flag would persist a customer's registry credential in our
  // logs.
  if (request.registry && input.secretName) {
    steps.push({
      name: WORKER_IMAGE,
      entrypoint: "sh",
      args: [
        "-c",
        `printf '%s' "$$REGISTRY_PASSWORD" | docker login ${shellQuote(request.registry.host)} ` +
          `-u ${shellQuote(request.registry.username)} --password-stdin && docker push ${shellQuote(image)}`,
      ],
      secretEnv: ["REGISTRY_PASSWORD"],
    });
  }

  return {
    steps,
    ...submission(input.config),
    ...(input.secretName
      ? {
          availableSecrets: {
            secretManager: [
              { versionName: `${input.secretName}/versions/latest`, env: "REGISTRY_PASSWORD" },
            ],
          },
        }
      : {}),
  };
}

/** Test seam for the image build's submission. */
export const __imageBuildConfigForTests = imageBuildConfig;

/**
 * Build the image on Cloud Build and push it to the plan's registry.
 *
 * The source goes up as GitHub's own tarball to a staging object, and the
 * build's first step downloads it through a signed URL; see the module header
 * for why the build cannot simply be pointed at the bucket.
 */
export async function buildOnCloudBuild(
  request: BuildRequest,
  ctx: CloudBuildContext,
): Promise<HostedBuildResult> {
  const { config } = ctx;
  const token = await accessToken();
  const prefix = stagingPrefix(ctx);
  const sourceObject = `${prefix}source-${randomUUID()}.tar.gz`;
  const imageObject = `${prefix}image-${randomUUID()}.tar`;

  const image = infrafileImageRef({
    project: ctx.repo ?? "app",
    env: request.env,
    gitSha: ctx.gitSha,
    ...(request.tag ? { tag: request.tag } : {}),
    ...(request.registry ? { registryHost: request.registry.host } : {}),
  });
  const staged = `${STAGED_IMAGE_REPO}:${randomUUID()}`;

  const startedAt = Date.now();
  let status: string;
  let buildId: string;
  let secretName: string | undefined;
  // The try begins before the secret exists, not at the wait: a failed upload
  // or a rejected submission (bad config, quota, an aborted signal) would
  // otherwise leave the customer's registry credential sitting in Secret
  // Manager with nothing left to use it.
  try {
    // Created first so its IAM binding has the upload's duration to propagate
    // before the worker tries to read it.
    if (request.registry) {
      secretName = await createBuildSecret(config, token, request.registry.password);
    }

    ctx.log(`Uploading source (${(ctx.sourceTarGz.byteLength / 1024 / 1024).toFixed(1)} MB)`);
    const upload = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.stagingBucket)}/o` +
        `?uploadType=media&name=${encodeURIComponent(sourceObject)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/gzip" },
        body: Buffer.from(ctx.sourceTarGz),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    if (!upload.ok) {
      throw new Error(`Could not stage the build source (${upload.status} from Cloud Storage).`);
    }

    const [sourceUrl, imageUploadUrl] = await Promise.all([
      stagingUrl(config, "GET", sourceObject),
      stagingUrl(config, "PUT", imageObject),
    ]);
    const build = imageBuildConfig({
      config,
      request,
      image,
      staged,
      sourceUrl,
      imageUploadUrl,
      ...(secretName ? { secretName } : {}),
    });

    ctx.log(`Building ${image} on Cloud Build`);
    const created = await fetch(`${buildsApiBase(config)}/builds`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(build),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!created.ok) {
      throw new Error(
        `Cloud Build rejected the build (${created.status}): ${await created.text()}`,
      );
    }
    const operation = (await created.json()) as { metadata?: { build?: { id?: string } } };
    const id = operation.metadata?.build?.id;
    if (!id) throw new Error("Cloud Build did not return a build id.");
    buildId = id;
    status = (await waitForBuild(config, buildId, ctx)).status;
  } finally {
    // The credential outlives neither the build nor a failure of it.
    if (secretName) await destroyBuildSecret(token, secretName).catch(() => {});
  }
  const buildSeconds = Math.round((Date.now() - startedAt) / 1000);

  if (status !== "SUCCESS") {
    throw new Error(
      `The hosted build ${status === "TIMEOUT" ? `timed out after ${HOSTED_BUILD_TIMEOUT_SECONDS}s` : `finished as ${status}`}. ` +
        `See the build log in Google Cloud Build (id ${buildId}).`,
    );
  }

  // run() reuses all three: the same source so /workspace holds the project,
  // and the image tarball plus the tag it loads as.
  ctx.sourceObject = sourceObject;
  ctx.imageObject = imageObject;
  ctx.stagedImage = staged;

  ctx.log(`Built ${image} in ${buildSeconds}s`);
  return { image, buildSeconds };
}

/**
 * Lifetime of a per-build secret, as a backstop for the `finally` that deletes
 * it: a pod killed mid-deploy never gets there. Covers queueing plus the
 * build timeout.
 */
const BUILD_SECRET_TTL_SECONDS = 7200;

/**
 * A one-build secret holding a credential. Returns its resource name. Cloud
 * Build reads it by reference, so the value never enters the build config.
 *
 * The build account is granted access to this secret alone, on the secret
 * itself. It holds no project-level Secret Manager access, so another build's
 * token can neither list these secrets nor read one it has not been bound to.
 */
async function createBuildSecret(
  config: CloudBuildConfig,
  token: string,
  value: string,
): Promise<string> {
  const secretId = `infrawrench-deploy-${randomUUID()}`;
  const base = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}`;

  const created = await fetch(`${base}/secrets?secretId=${encodeURIComponent(secretId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      replication: { automatic: {} },
      ttl: `${BUILD_SECRET_TTL_SECONDS}s`,
    }),
  });
  if (!created.ok) {
    throw new Error(`Could not stage the registry credential (${created.status}).`);
  }
  const secret = (await created.json()) as { name: string };

  // From here the secret exists, so every exit path below has to destroy it,
  // including a *thrown* fetch, which the !ok checks alone do not cover.
  try {
    const bound = await fetch(
      `https://secretmanager.googleapis.com/v1/${secret.name}:setIamPolicy`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            bindings: [
              {
                role: "roles/secretmanager.secretAccessor",
                members: [`serviceAccount:${config.serviceAccount}`],
              },
            ],
          },
        }),
      },
    );
    if (!bound.ok) {
      throw new Error(`Could not stage the registry credential (${bound.status}).`);
    }
    const added = await fetch(`${base}/secrets/${encodeURIComponent(secretId)}:addVersion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ payload: { data: Buffer.from(value, "utf8").toString("base64") } }),
    });
    if (!added.ok) {
      throw new Error(`Could not stage the registry credential (${added.status}).`);
    }
  } catch (err) {
    await destroyBuildSecret(token, secret.name).catch(() => {});
    throw err;
  }
  return secret.name;
}

/** Delete a one-build secret. Best effort: a leftover expires on its own TTL. */
async function destroyBuildSecret(token: string, secretName: string): Promise<void> {
  await fetch(`https://secretmanager.googleapis.com/v1/${secretName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** The parts of a finished build this module reads. */
interface FinishedBuild {
  status: string;
  steps?: { status?: string; exitCode?: number }[];
}

/** Poll until the build leaves a working state. */
async function waitForBuild(
  config: CloudBuildConfig,
  buildId: string,
  ctx: CloudBuildContext,
): Promise<FinishedBuild> {
  let wait = POLL_MIN_MS;
  for (;;) {
    if (ctx.signal?.aborted) throw new Error("Deploy stopped.");
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(Math.round(wait * 1.5), POLL_MAX_MS);
    const token = await accessToken();
    const res = await fetch(`${buildsApiBase(config)}/builds/${encodeURIComponent(buildId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Could not read the build's status (${res.status}).`);
    const body = (await res.json()) as Partial<FinishedBuild>;
    const status = body.status ?? "STATUS_UNKNOWN";
    if (status !== "QUEUED" && status !== "WORKING" && status !== "STATUS_UNKNOWN") {
      return { ...body, status };
    }
  }
}

interface RunBuildInput {
  config: CloudBuildConfig;
  request: RunInImageRequest;
  stagedImage: string;
  imageUrl: string;
  /** Absent when the request turns off `mountSource`. */
  sourceUrl?: string;
  /**
   * Where a shell command's report goes. Absent for a non-shell entrypoint,
   * which cannot be wrapped.
   */
  reportUrl?: string;
  nonce: string;
  secretNames: Record<string, string>;
}

/** Index of the customer's command among a run() build's steps. */
const RUN_COMMAND_STEP = 1;

/**
 * The Cloud Build submission for one `run()`. Pure, for the same reason as
 * {@link imageBuildConfig}.
 */
function runBuildConfig(input: RunBuildInput): Record<string, unknown> {
  const { request, nonce } = input;
  const entrypoint = request.entrypoint ?? "sh";
  const wrap = input.reportUrl !== undefined;
  const scratch = wrap ? { volumes: [SCRATCH_VOLUME] } : {};

  // The shell variable must NOT start with an underscore. Cloud Build parses
  // `$_...` in a build config as one of ITS substitution variables, so a
  // `$__iw_code` made every submission fail up front with
  // `key in the template "__" is not matched in the substitution data`.
  //
  // Cloud Build reports pass/fail, not the process's exit status. A shell
  // entrypoint lets us wrap the command so it reports both streams and the
  // real exit code, around markers a nonce makes impossible for the command's
  // own output to forge. The report goes to the scratch volume, and a later
  // step uploads it through a signed URL: the build cannot write a shared log
  // bucket, by design.
  //
  // A SUBSHELL, not a brace group, around the command: `exit 1` inside a brace
  // group terminates the whole shell, so the report would never be written and
  // the command's output and code would both be lost. A very ordinary thing
  // for a script to do.
  const wrapped =
    `( ${request.command}\n) >/tmp/iw-out 2>/tmp/iw-err; iwcode=$?\n` +
    `{ printf '\\n__IW_OUT_${nonce}__\\n'; cat /tmp/iw-out\n` +
    `printf '\\n__IW_ERR_${nonce}__\\n'; cat /tmp/iw-err\n` +
    `printf '\\n__IW_EXIT_${nonce}__%s\\n' "$iwcode"; } >${SCRATCH_VOLUME.path}/report\n` +
    `exit $iwcode`;

  const prepare =
    "set -e\n" +
    // The image may run as a non-root user, which must still be able to
    // write its report into the root-owned volume.
    (wrap ? `chmod 1777 ${SCRATCH_VOLUME.path}\n` : "") +
    `curl -fsSL --retry 3 -o /tmp/iw-image.tar ${shellQuote(input.imageUrl)}\n` +
    "docker load -i /tmp/iw-image.tar >/dev/null\n" +
    "rm -f /tmp/iw-image.tar\n" +
    // Cloud Build's /workspace is also the command step's working directory,
    // so the project is mounted the same way the local driver mounts it.
    (input.sourceUrl ? fetchSourceScript(input.sourceUrl) : "");

  const command: Record<string, unknown> = {
    // The tag the first step just loaded. A step whose image is already in the
    // worker's daemon runs it directly rather than pulling.
    name: input.stagedImage,
    entrypoint,
    args: wrap ? ["-lc", wrapped] : [request.command],
    // The command's own failure is reported through its exit code, not by
    // failing the build, so the report upload after it still runs.
    allowFailure: true,
    ...scratch,
  };
  if (request.workdir) command["dir"] = request.workdir;
  const secretEnv = Object.keys(input.secretNames);
  if (secretEnv.length > 0) command["secretEnv"] = secretEnv;

  const steps: unknown[] = [
    { name: WORKER_IMAGE, entrypoint: "bash", args: ["-c", prepare], ...scratch },
    command,
  ];
  if (wrap) {
    steps.push({
      name: WORKER_IMAGE,
      entrypoint: "bash",
      args: [
        "-c",
        `if [ -f ${SCRATCH_VOLUME.path}/report ]; then ` +
          `curl -fsS --retry 3 -T ${SCRATCH_VOLUME.path}/report ${shellQuote(input.reportUrl ?? "")}; fi`,
      ],
      ...scratch,
    });
  }

  return {
    steps,
    // The command is the customer's. A shell variable like `$_MY_VAR` in it
    // would otherwise be read as one of Cloud Build's substitutions and fail
    // the submission rather than the command.
    ...submission(input.config, { substitutionOption: "ALLOW_LOOSE" }),
    ...(secretEnv.length > 0
      ? {
          availableSecrets: {
            secretManager: Object.entries(input.secretNames).map(([envName, name]) => ({
              versionName: `${name}/versions/latest`,
              env: envName,
            })),
          },
        }
      : {}),
  };
}

/** Test seam for the run() submission. */
export const __runBuildConfigForTests = runBuildConfig;

/**
 * Run a command inside a hosted-built image.
 *
 * Each call is its own build, because `run()` calls are interleaved with
 * arbitrary JavaScript in `deploy()` and cannot be known in advance. That costs
 * a submission per call, which is why the docs steer people towards combining
 * steps with `&&` when they care.
 */
export async function runOnCloudBuild(
  request: RunInImageRequest,
  ctx: CloudBuildContext,
): Promise<RunInImageResult> {
  const { config } = ctx;
  if (!ctx.stagedImage || !ctx.imageObject || !ctx.sourceObject) {
    throw new Error("run() ran before the hosted build produced an image.");
  }
  const { stagedImage, imageObject, sourceObject } = ctx;
  const token = await accessToken();
  const entrypoint = request.entrypoint ?? "sh";
  const shell = entrypoint === "sh" || entrypoint === "bash" || entrypoint === "/bin/sh";
  const nonce = randomUUID().replace(/-/g, "");
  const reportObject = `${stagingPrefix(ctx)}run-${nonce}.txt`;

  // `run()` may carry credentials, and a step's args are recorded in this
  // project's build history, so they go through Secret Manager exactly as the
  // registry password does, one secret per variable.
  const env = request.env ?? {};
  const secretNames: Record<string, string> = {};

  try {
    // Created inside the try: if the third of five secrets fails to stage, the
    // first two are already in `secretNames` and the finally destroys them.
    for (const [key, value] of Object.entries(env)) {
      secretNames[key] = await createBuildSecret(config, token, value);
    }

    const [imageUrl, sourceUrl, reportUrl] = await Promise.all([
      stagingUrl(config, "GET", imageObject),
      request.mountSource !== false ? stagingUrl(config, "GET", sourceObject) : undefined,
      shell ? stagingUrl(config, "PUT", reportObject) : undefined,
    ]);
    const build = runBuildConfig({
      config,
      request,
      stagedImage,
      imageUrl,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(reportUrl ? { reportUrl } : {}),
      nonce,
      secretNames,
    });

    ctx.log(`$ ${request.command}`);
    const res = await fetch(`${buildsApiBase(config)}/builds`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(build),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`Cloud Build rejected the command (${res.status}): ${await res.text()}`);
    }
    const operation = (await res.json()) as { metadata?: { build?: { id?: string } } };
    const buildId = operation.metadata?.build?.id;
    if (!buildId) throw new Error("Cloud Build did not return a build id.");

    const finished = await waitForBuild(config, buildId, ctx);
    if (finished.steps?.[0]?.status && finished.steps[0].status !== "SUCCESS") {
      throw new Error(
        `Could not prepare the image for run() (${finished.steps[0].status}). ` +
          `See the build log in Google Cloud Build (id ${buildId}).`,
      );
    }

    // The command's output is the whole point of run(): `const v = await
    // run(...)` has to return what it printed, or the same Infrafile behaves
    // differently depending on where it was deployed from.
    const parsed = shell
      ? parseWrappedOutput(await readStagingObject(config, reportObject).catch(() => ""), nonce)
      : null;
    if (!shell) {
      ctx.log("(Output of a non-shell entrypoint is not captured on hosted builds.)");
    }

    const result: RunInImageResult = parsed ?? {
      // A non-shell entrypoint cannot be wrapped, and a shell step that died
      // before reporting left nothing to read, so fall back to the step's own
      // exit code.
      exitCode: commandExitCode(finished),
      stdout: "",
      stderr: "",
    };
    for (const line of `${result.stdout}${result.stderr}`.split("\n")) {
      if (line) ctx.log(line);
    }
    return result;
  } finally {
    await Promise.all([
      ...Object.values(secretNames).map((n) => destroyBuildSecret(token, n).catch(() => {})),
      shell ? deleteStagingObject(config, reportObject).catch(() => {}) : Promise.resolve(),
    ]);
  }
}

/**
 * The command step's exit code, from the build record. Every run() build
 * reports SUCCESS because the step is allowed to fail, so the build's own
 * verdict says nothing about the command.
 */
function commandExitCode(build: FinishedBuild): number {
  const step = build.steps?.[RUN_COMMAND_STEP];
  if (typeof step?.exitCode === "number") return step.exitCode;
  if (step?.status) return step.status === "SUCCESS" ? 0 : 1;
  return build.status === "SUCCESS" ? 0 : 1;
}

/** Cloud Build prefixes every line of step output with its step number. */
function stripStepPrefixes(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^Step #\d+: ?/, ""))
    .join("\n")
    .trim();
}

/**
 * Split a wrapped command's report into its real streams and exit code.
 *
 * Everything is delimited by nonce markers rather than matched by shape. An
 * earlier version filtered Cloud Build's banners by regex, which silently ate
 * any line of the command's own output that happened to start with `DONE`,
 * `BUILD` or `PUSH`. Returns null when the markers are absent: the step died
 * before it could report, so the caller falls back to the step's exit code.
 */
function parseWrappedOutput(raw: string, nonce: string): RunInImageResult | null {
  const text = stripStepPrefixes(raw);
  const outAt = text.indexOf(`__IW_OUT_${nonce}__`);
  const errAt = text.indexOf(`__IW_ERR_${nonce}__`);
  const exitAt = text.indexOf(`__IW_EXIT_${nonce}__`);
  if (outAt < 0 || errAt < outAt || exitAt < errAt) return null;

  const stdout = text.slice(outAt + `__IW_OUT_${nonce}__`.length, errAt).trim();
  const stderr = text.slice(errAt + `__IW_ERR_${nonce}__`.length, exitAt).trim();
  const code = Number.parseInt(
    text
      .slice(exitAt + `__IW_EXIT_${nonce}__`.length)
      .trim()
      .split("\n")[0] ?? "",
    10,
  );
  return { exitCode: Number.isFinite(code) ? code : 1, stdout, stderr };
}

/** Test seam: the parsing is pure and its failure modes are subtle. */
export const __parseWrappedOutputForTests = parseWrappedOutput;

/**
 * Remove everything a deploy staged: source, image tarball, any run() report a
 * failure left behind. Best effort; the bucket's lifecycle rule is the backstop.
 */
export async function cleanupHostedBuild(ctx: CloudBuildContext): Promise<void> {
  const prefix = ctx.stagingPrefix;
  if (!prefix) return;
  const { config } = ctx;
  const token = await accessToken();
  let pageToken: string | undefined;
  do {
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.stagingBucket)}/o` +
        `?prefix=${encodeURIComponent(prefix)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return;
    const body = (await res.json()) as { items?: { name: string }[]; nextPageToken?: string };
    await Promise.all(
      (body.items ?? []).map((item) => deleteStagingObject(config, item.name).catch(() => {})),
    );
    pageToken = body.nextPageToken;
  } while (pageToken);
}
