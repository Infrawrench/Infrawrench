import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  __imageBuildConfigForTests as buildConfig,
  __parseWrappedOutputForTests as parse,
  __runBuildConfigForTests as runConfig,
  __signGcsUrlForTests as signUrl,
  cloudBuildConfig,
} from "../build-cloud";

import type { BuildRequest, RunInImageRequest } from "@infrawrench/workflow-runtime";

/**
 * Cloud Build gives one interleaved log and a pass/fail verdict, so `run()`'s
 * real streams and exit code are recovered from markers the wrapper prints.
 * The parsing is where that can go quietly wrong, so it is tested directly.
 */
const N = "abc123";

function log(lines: string[]): string {
  // Cloud Build prefixes every line of step output with its step number.
  return lines.map((l) => `Step #0: ${l}`).join("\n");
}

describe("parseWrappedOutput", () => {
  it("separates stdout from stderr and reads the real exit code", () => {
    const raw = log([
      "starting build",
      `__IW_OUT_${N}__`,
      "hello",
      "world",
      `__IW_ERR_${N}__`,
      "a warning",
      `__IW_EXIT_${N}__7`,
    ]);
    expect(parse(raw, N)).toEqual({ exitCode: 7, stdout: "hello\nworld", stderr: "a warning" });
  });

  it("keeps output that looks like Cloud Build's own chatter", () => {
    // The bug this replaced: a regex filter deleted any line starting with
    // DONE / BUILD / PUSH, silently corrupting the command's own output.
    const raw = log([
      `__IW_OUT_${N}__`,
      "BUILD succeeded",
      "DONE deploying",
      "PUSH complete",
      `__IW_ERR_${N}__`,
      `__IW_EXIT_${N}__0`,
    ]);
    expect(parse(raw, N)?.stdout).toBe("BUILD succeeded\nDONE deploying\nPUSH complete");
  });

  it("reports success as zero", () => {
    const raw = log([`__IW_OUT_${N}__`, "ok", `__IW_ERR_${N}__`, `__IW_EXIT_${N}__0`]);
    expect(parse(raw, N)?.exitCode).toBe(0);
  });

  it("handles empty streams", () => {
    const raw = log([`__IW_OUT_${N}__`, `__IW_ERR_${N}__`, `__IW_EXIT_${N}__0`]);
    expect(parse(raw, N)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("returns null when the step died before reporting", () => {
    // No markers: the caller then falls back to the build's own verdict
    // rather than inventing an exit code.
    expect(parse(log(["container failed to start"]), N)).toBeNull();
  });

  it("returns null on a truncated log rather than guessing", () => {
    const raw = log([`__IW_OUT_${N}__`, "partial output"]);
    expect(parse(raw, N)).toBeNull();
  });

  it("is not fooled by the command printing a marker for a different nonce", () => {
    const raw = log([
      `__IW_OUT_${N}__`,
      "__IW_EXIT_deadbeef__0",
      `__IW_ERR_${N}__`,
      `__IW_EXIT_${N}__3`,
    ]);
    const result = parse(raw, N);
    expect(result?.exitCode).toBe(3);
    expect(result?.stdout).toBe("__IW_EXIT_deadbeef__0");
  });

  it("falls back to a failure code when the exit marker is unreadable", () => {
    const raw = log([`__IW_OUT_${N}__`, "x", `__IW_ERR_${N}__`, `__IW_EXIT_${N}__notanumber`]);
    expect(parse(raw, N)?.exitCode).toBe(1);
  });
});

/**
 * Hosted builds run customer code, and every step can mint a token for the
 * build's service account. These pin the properties that keep one deploy's
 * build away from another's source, image, output and secrets.
 */
const CONFIG = {
  projectId: "proj",
  stagingBucket: "proj-builds",
  serviceAccount: "iw-build@proj.iam.gserviceaccount.com",
};

describe("cloudBuildConfig", () => {
  const keys = ["GCP_BUILD_PROJECT_ID", "GCP_BUILD_STAGING_BUCKET", "GCP_BUILD_SERVICE_ACCOUNT"];
  afterEach(() => {
    for (const k of keys) delete process.env[k];
  });

  it("is unavailable without a dedicated build service account", () => {
    process.env["GCP_BUILD_PROJECT_ID"] = "proj";
    process.env["GCP_BUILD_STAGING_BUCKET"] = "proj-builds";
    expect(cloudBuildConfig()).toBeNull();
    process.env["GCP_BUILD_SERVICE_ACCOUNT"] = CONFIG.serviceAccount;
    expect(cloudBuildConfig()).toEqual(CONFIG);
  });
});

describe("imageBuildConfig", () => {
  const base = {
    config: CONFIG,
    request: { dockerfile: "FROM alpine\n", env: "prod" } as BuildRequest,
    image: "app:sha",
    staged: "infrawrench.invalid/staged:1234",
    sourceUrl: "https://storage.googleapis.com/proj-builds/deploys/a/source.tar.gz?sig=1",
    imageUploadUrl: "https://storage.googleapis.com/proj-builds/deploys/a/image.tar?sig=2",
  };

  it("runs as the dedicated account and never points the build at the bucket", () => {
    const build = buildConfig(base);
    expect(build["serviceAccount"]).toBe(
      "projects/proj/serviceAccounts/iw-build@proj.iam.gserviceaccount.com",
    );
    // A storageSource or logsBucket would need the build account to hold
    // access to the shared bucket, which is what let one build read another's.
    expect(build["source"]).toBeUndefined();
    expect(build["logsBucket"]).toBeUndefined();
    expect(build["options"]).toMatchObject({ logging: "CLOUD_LOGGING_ONLY" });
    expect(JSON.stringify(build)).not.toContain("gs://");
  });

  it("moves source and image only through the signed URLs it was given", () => {
    const text = JSON.stringify(buildConfig(base));
    expect(text).toContain(base.sourceUrl);
    expect(text).toContain(base.imageUploadUrl);
    // No shared registry: the staged image is saved to a tarball, not pushed.
    expect(text).not.toContain("pkg.dev");
    expect(text).toContain(`docker save -o /tmp/iw-image.tar '${base.staged}'`);
  });

  it("reads the registry password from the per-build secret only", () => {
    const build = buildConfig({
      ...base,
      request: {
        ...base.request,
        registry: { host: "ghcr.io", username: "me", password: "hunter2" },
      } as BuildRequest,
      secretName: "projects/1/secrets/infrawrench-deploy-x",
    });
    expect(JSON.stringify(build)).not.toContain("hunter2");
    expect(build["availableSecrets"]).toEqual({
      secretManager: [
        {
          versionName: "projects/1/secrets/infrawrench-deploy-x/versions/latest",
          env: "REGISTRY_PASSWORD",
        },
      ],
    });
  });
});

describe("runBuildConfig", () => {
  const base = {
    config: CONFIG,
    request: { image: "x", command: "echo hi" } as RunInImageRequest,
    stagedImage: "infrawrench.invalid/staged:1234",
    imageUrl: "https://storage.googleapis.com/proj-builds/deploys/a/image.tar?sig=1",
    sourceUrl: "https://storage.googleapis.com/proj-builds/deploys/a/source.tar.gz?sig=2",
    reportUrl: "https://storage.googleapis.com/proj-builds/deploys/a/run-n.txt?sig=3",
    nonce: "n",
    secretNames: { TOKEN: "projects/1/secrets/infrawrench-deploy-y" },
  };

  it("loads the staged image, runs it, and uploads the report through a signed URL", () => {
    const build = runConfig(base);
    const steps = build["steps"] as Record<string, unknown>[];
    expect(build["serviceAccount"]).toBe(
      "projects/proj/serviceAccounts/iw-build@proj.iam.gserviceaccount.com",
    );
    expect(build["source"]).toBeUndefined();
    expect(build["logsBucket"]).toBeUndefined();
    expect(steps).toHaveLength(3);
    expect(JSON.stringify(steps[0])).toContain(base.imageUrl);
    expect(JSON.stringify(steps[0])).toContain(base.sourceUrl);
    expect(steps[1]).toMatchObject({
      name: base.stagedImage,
      allowFailure: true,
      secretEnv: ["TOKEN"],
    });
    expect(JSON.stringify(steps[2])).toContain(base.reportUrl);
    expect(JSON.stringify(build)).not.toContain("gs://");
  });

  it("does not fetch the source when mountSource is off", () => {
    const { sourceUrl: _omit, ...rest } = base;
    const build = runConfig({ ...rest, request: { ...base.request, mountSource: false } });
    expect(JSON.stringify(build)).not.toContain("source.tar.gz");
  });

  it("has no report step for a non-shell entrypoint", () => {
    const { reportUrl: _omit, ...rest } = base;
    const build = runConfig({ ...rest, request: { ...base.request, entrypoint: "node" } });
    const steps = build["steps"] as Record<string, unknown>[];
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ entrypoint: "node", args: ["echo hi"] });
    expect(steps[1]?.["volumes"]).toBeUndefined();
  });
});

describe("signGcsUrl", () => {
  it("produces a V4 URL whose signature verifies over the canonical request", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const url = await signUrl({
      method: "PUT",
      bucket: "proj-builds",
      object: "deploys/abc/image-1.tar",
      email: "web@proj.iam.gserviceaccount.com",
      now: new Date("2026-10-03T12:34:56.789Z"),
      expiresSeconds: 3600,
      sign: async (data) => new Uint8Array(sign("sha256", data, privateKey)),
    });

    const parsed = new URL(url);
    expect(parsed.host).toBe("storage.googleapis.com");
    expect(parsed.pathname).toBe("/proj-builds/deploys/abc/image-1.tar");
    expect(parsed.searchParams.get("X-Goog-Credential")).toBe(
      "web@proj.iam.gserviceaccount.com/20261003/auto/storage/goog4_request",
    );
    expect(parsed.searchParams.get("X-Goog-Date")).toBe("20261003T123456Z");
    expect(parsed.searchParams.get("X-Goog-Expires")).toBe("3600");

    const query =
      "X-Goog-Algorithm=GOOG4-RSA-SHA256" +
      "&X-Goog-Credential=web%40proj.iam.gserviceaccount.com%2F20261003%2Fauto%2Fstorage%2Fgoog4_request" +
      "&X-Goog-Date=20261003T123456Z&X-Goog-Expires=3600&X-Goog-SignedHeaders=host";
    expect(url.split("?")[1]?.split("&X-Goog-Signature=")[0]).toBe(query);
    const canonical = [
      "PUT",
      "/proj-builds/deploys/abc/image-1.tar",
      query,
      "host:storage.googleapis.com\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "GOOG4-RSA-SHA256",
      "20261003T123456Z",
      "20261003/auto/storage/goog4_request",
      createHash("sha256").update(canonical).digest("hex"),
    ].join("\n");
    const signature = Buffer.from(parsed.searchParams.get("X-Goog-Signature") ?? "", "hex");
    expect(verify("sha256", Buffer.from(stringToSign), publicKey, signature)).toBe(true);
  });
});
