/**
 * Hosted Docker builds on Google Cloud Build.
 *
 * This is the default for a web deploy, so a paying customer does not have to
 * own a build host — which also makes the non-container targets (a Worker, a
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
 * **Where the image goes.** To the registry the Infrafile's `plan()` returned,
 * not ours. Pushing to an Infrawrench-owned registry would mean the customer's
 * cluster could not pull without us minting and rotating a pull credential for
 * it; sending it to their own registry keeps that boundary where it already is.
 *
 * Cost is bounded by a hard per-build timeout, and every build's duration is
 * recorded so it can be metered.
 */
import { randomUUID } from "node:crypto";

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
  /** GCS bucket holding uploaded build sources and build logs. */
  stagingBucket: string;
  /**
   * Artifact Registry path images are staged to, e.g.
   * `us-east4-docker.pkg.dev/my-project/infrawrench-builds`.
   *
   * Every hosted build pushes here, even when the Infrafile never publishes
   * anywhere. That is what makes `run()` possible at all: a Cloud Build step
   * pulls its image from a registry, and an image built inside one build's
   * daemon does not exist on the next build's worker. This is scratch space —
   * the *deployed* image still goes to the customer's own registry.
   */
  stagingRepo: string;
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
  const stagingRepo = process.env["GCP_BUILD_STAGING_REPO"];
  if (!projectId || !stagingBucket || !stagingRepo) return null;
  const region = process.env["GCP_BUILD_REGION"];
  return { projectId, stagingBucket, stagingRepo, ...(region ? { region } : {}) };
}

export interface CloudBuildContext {
  config: CloudBuildConfig;
  /** The repository source, as a gzipped tarball. */
  sourceTarGz: Uint8Array;
  gitSha: string;
  /** Live output sink. */
  log: (line: string) => void;
  signal?: AbortSignal;
  /**
   * Set by {@link buildOnCloudBuild}: the GCS object the source was staged to,
   * and the staged image tag. `run()` reuses both — the same source so
   * `/workspace` holds the project, and the staged tag so the worker has an
   * image it can actually pull.
   */
  sourceObject?: string;
  stagedImage?: string;
}

/** A completed hosted build, with what it cost us in worker time. */
export interface HostedBuildResult extends BuildResult {
  /** Seconds of build-worker time, for metering. */
  buildSeconds: number;
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
 * Prefers the GKE metadata server (workload identity — no key material to hold
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

/** Self-signed JWT → access token. Same shape the GCP plugin uses, no new deps. */
async function tokenFromServiceAccountKey(rawKey: string): Promise<CachedToken> {
  const key = JSON.parse(rawKey) as { client_email: string; private_key: string };
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

  const der = Buffer.from(
    key.private_key
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, ""),
    "base64",
  );
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
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

/* ----------------------------------------------------------------- build -- */

/** Single-quote a value for the shell step that writes the Dockerfile. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the image on Cloud Build and push it to the plan's registry.
 *
 * The source goes up as GitHub's own tarball; Cloud Build extracts it into
 * `/workspace`, where a first step flattens the single `owner-repo-sha/`
 * directory GitHub wraps everything in. The rendered Dockerfile is written by
 * that same step rather than repacked into the archive, which keeps this module
 * free of a hand-rolled tar writer.
 */
export async function buildOnCloudBuild(
  request: BuildRequest,
  ctx: CloudBuildContext,
): Promise<HostedBuildResult> {
  const { config } = ctx;
  const token = await accessToken();
  const objectName = `deploys/${randomUUID()}/source.tar.gz`;

  ctx.log(`Uploading source (${(ctx.sourceTarGz.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  const upload = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.stagingBucket)}/o` +
      `?uploadType=media&name=${encodeURIComponent(objectName)}`,
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

  const image = hostedImageRef(request, ctx.gitSha);
  // Scratch tag in our own registry. Pushed on every hosted build so later
  // run() builds have something to pull; deleted once the deploy finishes.
  const staged = `${config.stagingRepo}/deploy:${randomUUID()}`;
  const buildArgs = Object.entries(request.args ?? {}).flatMap(([k, v]) => [
    "--build-arg",
    `${k}=${v}`,
  ]);

  const steps: unknown[] = [
    {
      // GitHub wraps a tarball in one directory; flatten it, then drop the
      // rendered Dockerfile beside the source rather than inside it.
      name: "alpine:3.20",
      entrypoint: "sh",
      args: [
        "-c",
        `set -e
d=$(ls -d */ 2>/dev/null | head -1)
if [ -n "$d" ]; then mv "$d".[!.]* . 2>/dev/null || true; mv "$d"* . 2>/dev/null || true; rmdir "$d" 2>/dev/null || true; fi
printf '%s' ${shellQuote(request.dockerfile)} > Dockerfile.infrawrench`,
      ],
    },
    {
      name: "gcr.io/cloud-builders/docker",
      args: ["build", "-f", "Dockerfile.infrawrench", "-t", image, "-t", staged, ...buildArgs, "."],
    },
    {
      // Our own registry, so the build's service account authenticates itself.
      name: "gcr.io/cloud-builders/docker",
      args: ["push", staged],
    },
  ];

  // A registry means push; without one the image stays local to the build and
  // is never published anywhere.
  //
  // The password goes through Secret Manager rather than the build config: a
  // step's arguments are recorded in the build history of OUR project, so a
  // `--password` flag would persist a customer's registry credential in our
  // logs. The secret is created for this build and destroyed in the `finally`.
  let secretName: string | undefined;
  if (request.registry) {
    secretName = await createBuildSecret(config, token, request.registry.password);
    steps.push({
      name: "gcr.io/cloud-builders/docker",
      entrypoint: "sh",
      args: [
        "-c",
        `printf '%s' "$$REGISTRY_PASSWORD" | docker login ${shellQuote(request.registry.host)} ` +
          `-u ${shellQuote(request.registry.username)} --password-stdin && docker push ${shellQuote(image)}`,
      ],
      secretEnv: ["REGISTRY_PASSWORD"],
    });
  }

  const build: Record<string, unknown> = {
    source: { storageSource: { bucket: config.stagingBucket, object: objectName } },
    steps,
    timeout: `${HOSTED_BUILD_TIMEOUT_SECONDS}s`,
    logsBucket: `gs://${config.stagingBucket}/buildlogs`,
    options: { machineType: HOSTED_BUILD_MACHINE, logging: "GCS_ONLY" },
    ...(secretName
      ? {
          availableSecrets: {
            secretManager: [
              { versionName: `${secretName}/versions/latest`, env: "REGISTRY_PASSWORD" },
            ],
          },
        }
      : {}),
  };

  ctx.log(`Building ${image} on Cloud Build`);
  const startedAt = Date.now();
  const created = await fetch(
    `https://cloudbuild.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/builds`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(build),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
  );
  if (!created.ok) {
    throw new Error(`Cloud Build rejected the build (${created.status}): ${await created.text()}`);
  }
  const operation = (await created.json()) as { metadata?: { build?: { id?: string } } };
  const buildId = operation.metadata?.build?.id;
  if (!buildId) throw new Error("Cloud Build did not return a build id.");

  let status: string;
  try {
    status = await waitForBuild(config, buildId, ctx);
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

  // run() reuses both: the same source so /workspace holds the project, and the
  // staged tag because a step's image is pulled from a registry.
  ctx.sourceObject = objectName;
  ctx.stagedImage = staged;

  ctx.log(`Built ${image} in ${buildSeconds}s`);
  return { image, buildSeconds };
}

/**
 * A one-build secret holding the registry password. Returns its resource name.
 * Cloud Build reads it by reference, so the value never enters the build config.
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
    body: JSON.stringify({ replication: { automatic: {} } }),
  });
  if (!created.ok) {
    throw new Error(`Could not stage the registry credential (${created.status}).`);
  }
  const secret = (await created.json()) as { name: string };

  const added = await fetch(`${base}/secrets/${encodeURIComponent(secretId)}:addVersion`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ payload: { data: Buffer.from(value, "utf8").toString("base64") } }),
  });
  if (!added.ok) {
    await destroyBuildSecret(token, secret.name).catch(() => {});
    throw new Error(`Could not stage the registry credential (${added.status}).`);
  }
  return secret.name;
}

/** Delete a one-build secret. Best effort — a leftover is cleaned by TTL policy. */
async function destroyBuildSecret(token: string, secretName: string): Promise<void> {
  await fetch(`https://secretmanager.googleapis.com/v1/${secretName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Poll until the build leaves a working state. */
async function waitForBuild(
  config: CloudBuildConfig,
  buildId: string,
  ctx: CloudBuildContext,
): Promise<string> {
  let wait = POLL_MIN_MS;
  for (;;) {
    if (ctx.signal?.aborted) throw new Error("Deploy stopped.");
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(Math.round(wait * 1.5), POLL_MAX_MS);
    const token = await accessToken();
    const res = await fetch(
      `https://cloudbuild.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/builds/${encodeURIComponent(buildId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Could not read the build's status (${res.status}).`);
    const body = (await res.json()) as { status?: string };
    const status = body.status ?? "STATUS_UNKNOWN";
    if (status !== "QUEUED" && status !== "WORKING" && status !== "STATUS_UNKNOWN") return status;
  }
}

/**
 * Run a command inside a hosted-built image.
 *
 * Each call is its own single-step build, because `run()` calls are interleaved
 * with arbitrary JavaScript in `deploy()` and cannot be known in advance. That
 * costs a submission per call, which is why the docs steer people towards
 * combining steps with `&&` when they care.
 */
export async function runOnCloudBuild(
  request: RunInImageRequest,
  ctx: CloudBuildContext,
): Promise<RunInImageResult> {
  const { config } = ctx;
  if (!ctx.stagedImage || !ctx.sourceObject) {
    throw new Error("run() ran before the hosted build produced an image.");
  }
  const token = await accessToken();
  const entrypoint = request.entrypoint ?? "sh";
  const shell = entrypoint === "sh" || entrypoint === "bash" || entrypoint === "/bin/sh";

  // `run()` may carry credentials, and a step's args are recorded in this
  // project's build history — so they go through Secret Manager exactly as the
  // registry password does, one secret per variable.
  const env = request.env ?? {};
  const secretNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    secretNames[key] = await createBuildSecret(config, token, value);
  }

  try {
    // Cloud Build reports pass/fail, not the process's exit status, and writes
    // one interleaved log. A shell entrypoint lets us wrap the command so it
    // reports both precisely: streams captured to separate files, then replayed
    // around markers with the real exit code. The nonce makes the markers
    // impossible for the command's own output to forge.
    const nonce = randomUUID().replace(/-/g, "");
    // A SUBSHELL, not a brace group: `exit 1` inside a brace group terminates
    // the whole shell, so the markers below would never print and the command's
    // output and code would both be lost. A very ordinary thing for a script to do.
    const wrapped =
      `( ${request.command}\n) >/tmp/iw-out 2>/tmp/iw-err; __iw_code=$?\n` +
      `printf '\\n__IW_OUT_${nonce}__\\n'; cat /tmp/iw-out\n` +
      `printf '\\n__IW_ERR_${nonce}__\\n'; cat /tmp/iw-err\n` +
      `printf '\\n__IW_EXIT_${nonce}__%s\\n' "$__iw_code"\n` +
      `exit $__iw_code`;

    const step: Record<string, unknown> = {
      // The staged tag: a step's image is pulled from a registry, and the image
      // this deploy built exists nowhere else.
      name: ctx.stagedImage,
      entrypoint,
      args: shell ? ["-lc", wrapped] : [request.command],
    };
    // Cloud Build extracts the source into /workspace, which is also the step's
    // working directory — so the project is mounted the same way the local
    // driver mounts it.
    if (request.workdir) step["dir"] = request.workdir;
    if (Object.keys(secretNames).length > 0) step["secretEnv"] = Object.keys(secretNames);

    const build: Record<string, unknown> = {
      steps: [step],
      timeout: `${HOSTED_BUILD_TIMEOUT_SECONDS}s`,
      logsBucket: `gs://${config.stagingBucket}/buildlogs`,
      options: { machineType: HOSTED_BUILD_MACHINE, logging: "GCS_ONLY" },
    };
    // Without a source there is no /workspace, so `mountSource: false` is the
    // only case that legitimately omits it.
    if (request.mountSource !== false) {
      build["source"] = {
        storageSource: { bucket: config.stagingBucket, object: ctx.sourceObject },
      };
    }
    if (Object.keys(secretNames).length > 0) {
      build["availableSecrets"] = {
        secretManager: Object.entries(secretNames).map(([envName, name]) => ({
          versionName: `${name}/versions/latest`,
          env: envName,
        })),
      };
    }

    ctx.log(`$ ${request.command}`);
    const res = await fetch(
      `https://cloudbuild.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/builds`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(build),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    if (!res.ok) {
      throw new Error(`Cloud Build rejected the command (${res.status}): ${await res.text()}`);
    }
    const operation = (await res.json()) as { metadata?: { build?: { id?: string } } };
    const buildId = operation.metadata?.build?.id;
    if (!buildId) throw new Error("Cloud Build did not return a build id.");

    const status = await waitForBuild(config, buildId, ctx);
    // The command's output is the whole point of run() — `const v = await
    // run(...)` has to return what it printed, or the same Infrafile behaves
    // differently depending on where it was deployed from.
    const raw = await readBuildLog(config, buildId).catch(() => "");
    const parsed = shell ? parseWrappedOutput(raw, nonce) : null;

    const result: RunInImageResult = parsed ?? {
      // A non-shell entrypoint cannot be wrapped, so fall back to the build's
      // own verdict and the whole log.
      exitCode: status === "SUCCESS" ? 0 : 1,
      stdout: stripStepPrefixes(raw),
      stderr: "",
    };
    for (const line of `${result.stdout}${result.stderr}`.split("\n")) {
      if (line) ctx.log(line);
    }
    return result;
  } finally {
    await Promise.all(
      Object.values(secretNames).map((n) => destroyBuildSecret(token, n).catch(() => {})),
    );
  }
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
 * Split a wrapped command's log into its real streams and exit code.
 *
 * Everything is delimited by nonce markers rather than matched by shape. An
 * earlier version filtered Cloud Build's banners by regex, which silently ate
 * any line of the command's own output that happened to start with `DONE`,
 * `BUILD` or `PUSH`. Returns null when the markers are absent — the step died
 * before it could report, so the caller falls back to the build's verdict.
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
 * A finished build's raw log text.
 *
 * Cloud Build writes it to `logsBucket` as `log-<id>.txt` when logging is
 * GCS_ONLY. Returned verbatim — the caller decides what is output and what is
 * Cloud Build's own chatter, using markers rather than guessing.
 */
async function readBuildLog(config: CloudBuildConfig, buildId: string): Promise<string> {
  const token = await accessToken();
  const object = `buildlogs/log-${buildId}.txt`;
  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.stagingBucket)}` +
      `/o/${encodeURIComponent(object)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return "";
  return res.text();
}

/** Remove a deploy's scratch image. Best effort; a repo TTL policy is the backstop. */
export async function cleanupStagedImage(ctx: CloudBuildContext): Promise<void> {
  if (!ctx.stagedImage) return;
  const token = await accessToken();
  // <region>-docker.pkg.dev/<project>/<repo>/<image>:<tag>
  const [hostAndPath, tag] = ctx.stagedImage.split(":");
  if (!hostAndPath || !tag) return;
  const [host, project, repo, ...rest] = hostAndPath.split("/");
  const pkg = rest.join("/");
  if (!host || !project || !repo || !pkg) return;
  const location = host.replace("-docker.pkg.dev", "");
  const name =
    `projects/${project}/locations/${location}/repositories/${repo}` +
    `/packages/${encodeURIComponent(pkg)}/tags/${encodeURIComponent(tag)}`;
  await fetch(`https://artifactregistry.googleapis.com/v1/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Image reference for a hosted build. A registry from the plan wins; without
 * one the tag is local to the build and never published.
 */
function hostedImageRef(request: BuildRequest, gitSha: string): string {
  const tag = request.tag || `${request.env}-${gitSha.slice(0, 7)}`;
  return request.registry ? `${request.registry.host}/app:${tag}` : `app:${tag}`;
}
