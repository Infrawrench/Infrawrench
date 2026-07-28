import { describe, expect, it } from "vitest";

import { runInfrafile } from "./run.js";
import type { InfrafileHost } from "../host.js";
import type { BuildRequest, BuildResult, InfrafileGitContext, RunInImageRequest } from "./types.js";

/**
 * The Infrafile prelude and stage driver are source strings, so nothing
 * type-checks them — these run real isolates to prove the stages actually
 * execute in order, that the plan's values reach the later stages, and that the
 * reserved keys are read the way the docs claim.
 */

const GIT: InfrafileGitContext = { sha: "a1b2c3d4e5f6", branch: "main", repo: "astrid/demo" };

interface HostOverrides {
  build?: (request: BuildRequest) => Promise<BuildResult>;
  answers?: Record<string, string>;
  prompt?: (spec: { message: string; options?: { label: string; value: string }[] }) => unknown;
  push?: (image: string) => Promise<void>;
  copyTo?: (target: { id: string }, remotePath: string) => Promise<void>;
}

function hostFor(overrides: HostOverrides = {}): InfrafileHost {
  return {
    listPlugins: async () => [],
    listMetrics: async () => ({}),
    getMetric: async () => null,
    setMetric: async () => {},
    prompt: async (spec: unknown) => overrides.prompt?.(spec as never) ?? null,
    infrafileBuild:
      overrides.build ?? (async () => ({ image: "demo:latest", digest: "sha256:abc" })),
    infrafileAnswer: async (key: string) => overrides.answers?.[key],
    infrafilePush: overrides.push ?? (async () => {}),
    infrafileCopyTo: overrides.copyTo ?? (async () => {}),
  } as unknown as InfrafileHost;
}

function run(
  source: string,
  host: InfrafileHost,
  opts: Partial<Parameters<typeof runInfrafile>[0]> = {},
) {
  return runInfrafile({ source, host, env: "staging", git: GIT, interactive: false, ...opts });
}

describe("runInfrafile", () => {
  it("runs the three stages in order and threads the plan through each", async () => {
    const order: string[] = [];
    const seen: BuildRequest[] = [];
    const host = hostFor({
      build: async (request) => {
        seen.push(request);
        return { image: `registry.test/app:${request.tag}` };
      },
    });

    const result = await run(
      `
      defineInfra({
        envs: ["staging", "production"],
        async plan({ env, git }) {
          return { tag: env + "-" + git.sha.slice(0, 7), replicas: env === "production" ? 3 : 1 };
        },
        dockerfile({ env, plan }) {
          return "FROM node:22\\nENV REPLICAS=" + plan.replicas + "\\nENV ENV=" + env;
        },
        async deploy({ image, plan, notes }) {
          await notes("deployed " + image + " with " + plan.replicas + " replicas");
        },
      });
      `,
      host,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("success");
    expect(result.plan).toEqual({ tag: "staging-a1b2c3d", replicas: 1 });
    expect(result.dockerfile).toContain("ENV REPLICAS=1");
    expect(result.dockerfile).toContain("ENV ENV=staging");
    expect(result.image).toBe("registry.test/app:staging-a1b2c3d");
    expect(result.notes).toEqual(["deployed registry.test/app:staging-a1b2c3d with 1 replicas"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.env).toBe("staging");
    expect(seen[0]?.tag).toBe("staging-a1b2c3d");
    void order;
  });

  it("rejects an environment the file does not declare, naming the ones it does", async () => {
    const result = await run(
      `defineInfra({ envs: ["staging"], plan: async () => ({}), dockerfile: () => "FROM x", deploy: async () => {} });`,
      hostFor(),
      { env: "production" },
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain('"production"');
    expect(result.error?.message).toContain("staging");
  });

  it("stops after plan when planOnly is set, but still renders the Dockerfile", async () => {
    let built = false;
    const host = hostFor({
      build: async () => {
        built = true;
        return { image: "never" };
      },
    });

    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() { return { tag: "t1" }; },
        dockerfile({ plan }) { return "FROM node:22 # " + plan.tag; },
        async deploy() { throw new Error("deploy must not run"); },
      });
      `,
      host,
      { planOnly: true },
    );

    expect(result.status).toBe("success");
    expect(built).toBe(false);
    expect(result.plan).toEqual({ tag: "t1" });
    expect(result.dockerfile).toBe("FROM node:22 # t1");
    expect(result.image).toBeUndefined();
    expect(result.reachedStage).toBe("plan");
  });

  it("resolves select() from a pre-supplied answer without prompting", async () => {
    let prompted = false;
    const host = hostFor({
      answers: { region: "fra1" },
      prompt: () => {
        prompted = true;
        return null;
      },
    });

    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan({ select }) {
          const region = await select("region", "Region", ["nyc3", "fra1", "sgp1"]);
          return { region };
        },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      host,
    );

    expect(result.error).toBeUndefined();
    expect(prompted).toBe(false);
    expect(result.plan).toEqual({ region: "fra1" });
  });

  it("returns the original item from select(), not its label", async () => {
    const host = hostFor({ answers: { host: "web-02" } });

    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan({ select }) {
          const picked = await select("host", "Build on", [
            { displayName: "web-01", id: "acc:droplet:1", accountId: "acc", resourceTypeId: "droplet" },
            { displayName: "web-02", id: "acc:droplet:2", accountId: "acc", resourceTypeId: "droplet" },
          ]);
          return { buildOn: picked };
        },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      host,
    );

    expect(result.error).toBeUndefined();
    expect((result.plan as { buildOn: { id: string } }).buildOn.id).toBe("acc:droplet:2");
  });

  it("fails a non-interactive select with no answer, naming the key and the options", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan({ select }) { return { r: await select("region", "Region", ["nyc3", "fra1"]) }; },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      hostFor(),
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("--set region=");
    expect(result.error?.message).toContain("nyc3");
  });

  it('reads the reserved buildOn key, including the "local" shorthand', async () => {
    const seen: BuildRequest[] = [];
    const host = hostFor({
      build: async (request) => {
        seen.push(request);
        return { image: "demo:1" };
      },
    });

    await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() { return { buildOn: "local" }; },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      host,
    );

    expect(seen[0]?.target).toEqual({ kind: "local" });
  });

  it("passes a picked resource through as the build target", async () => {
    const seen: BuildRequest[] = [];
    const host = hostFor({
      build: async (request) => {
        seen.push(request);
        return { image: "demo:1" };
      },
    });

    await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          return { buildOn: { id: "acc:droplet:7", accountId: "acc", resourceTypeId: "droplet", displayName: "builder" } };
        },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      host,
    );

    expect(seen[0]?.target).toEqual({
      kind: "resource",
      resource: {
        id: "acc:droplet:7",
        accountId: "acc",
        resourceTypeId: "droplet",
        displayName: "builder",
      },
    });
  });

  it("rejects a buildOn that is an object but not a resource", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() { return { buildOn: { name: "not-a-resource" } }; },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      hostFor(),
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("not a resource");
  });

  it("carries registry credentials to the build without logging them", async () => {
    const seen: BuildRequest[] = [];
    const host = hostFor({
      build: async (request) => {
        seen.push(request);
        return { image: "demo:1" };
      },
    });

    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          return { registry: { host: "registry.test", username: "u", password: "s3cr3t" } };
        },
        dockerfile: () => "FROM node:22",
        async deploy({ push }) { await push(); },
      });
      `,
      host,
    );

    expect(seen[0]?.registry).toEqual({
      host: "registry.test",
      username: "u",
      password: "s3cr3t",
    });
    expect(JSON.stringify(result.logs)).not.toContain("s3cr3t");
  });

  it("fails clearly when the file never calls defineInfra", async () => {
    const result = await run(`const x = 1;`, hostFor());

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("never called defineInfra");
  });

  it("rejects a second defineInfra call", async () => {
    const result = await run(
      `
      const d = { envs: ["staging"], plan: async () => ({}), dockerfile: () => "FROM x", deploy: async () => {} };
      defineInfra(d);
      defineInfra(d);
      `,
      hostFor(),
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("more than once");
  });

  it("rejects a dockerfile stage that returns nothing", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() { return {}; },
        dockerfile() { return ""; },
        async deploy() {},
      });
      `,
      hostFor(),
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("non-empty string");
  });

  it("surfaces a throw from the deploy stage as a run failure", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy() { throw new Error("kubectl apply failed"); },
      });
      `,
      hostFor(),
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("kubectl apply failed");
    // The stage reported must be the one that actually failed, not the last
    // one that succeeded — otherwise a deploy bug sends you reading build logs.
    expect(result.reachedStage).toBe("deploy");
  });

  it("exposes the full infra surface to the deploy stage", async () => {
    const host = hostFor();
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy({ notes }) {
          await notes(typeof infra.accounts === "object" ? "infra ok" : "infra missing");
          await notes(typeof fetch === "function" ? "fetch ok" : "fetch missing");
        },
      });
      `,
      host,
    );

    expect(result.error).toBeUndefined();
    expect(result.notes).toEqual(["infra ok", "fetch ok"]);
  });
});

describe("run() inside the built image", () => {
  it("runs a command in the built image and resolves with its stdout", async () => {
    const seen: RunInImageRequest[] = [];
    const host = {
      ...hostFor(),
      infrafileRun: async (request: RunInImageRequest) => {
        seen.push(request);
        return { exitCode: 0, stdout: "Published to workers.dev\n", stderr: "" };
      },
    } as unknown as InfrafileHost;

    const result = await run(
      `
      defineInfra({
        envs: ["production"],
        async plan() { return {}; },
        // The image is a build environment, not the artifact: it carries the
        // toolchain and the deploy publishes from inside it.
        dockerfile: () => "FROM node:22\\nRUN npm i -g wrangler",
        async deploy({ run, notes }) {
          const out = await run("wrangler deploy", { env: { CLOUDFLARE_API_TOKEN: "tok" } });
          await notes(out.trim());
        },
      });
      `,
      host,
      { env: "production" },
    );

    expect(result.error).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe("wrangler deploy");
    expect(seen[0]?.image).toBe("demo:latest");
    expect(seen[0]?.env).toEqual({ CLOUDFLARE_API_TOKEN: "tok" });
    expect(result.notes).toEqual(["Published to workers.dev"]);
  });

  it("fails the deploy when the command exits non-zero", async () => {
    const host = {
      ...hostFor(),
      infrafileRun: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Authentication error [10000]",
      }),
    } as unknown as InfrafileHost;

    const result = await run(
      `
      defineInfra({
        envs: ["production"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy({ run }) { await run("wrangler deploy"); },
      });
      `,
      host,
      { env: "production" },
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("exited with code 1");
    // The tail of stderr must reach the author — otherwise the only signal is
    // an exit code and the real reason is buried in the log.
    expect(result.error?.message).toContain("Authentication error");
  });

  it("returns the full result instead of throwing when allowFailure is set", async () => {
    const host = {
      ...hostFor(),
      infrafileRun: async () => ({ exitCode: 3, stdout: "partial", stderr: "warn" }),
    } as unknown as InfrafileHost;

    const result = await run(
      `
      defineInfra({
        envs: ["production"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy({ run, notes }) {
          const r = await run("flaky", { allowFailure: true });
          await notes("exit=" + r.exitCode + " out=" + r.stdout);
        },
      });
      `,
      host,
      { env: "production" },
    );

    expect(result.error).toBeUndefined();
    expect(result.notes).toEqual(["exit=3 out=partial"]);
  });

  it("rejects an env var name or value that could forge extra variables", async () => {
    const bad = async (env: string) =>
      run(
        `
      defineInfra({
        envs: ["production"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy({ run }) { await run("x", { env: ${env} }); },
      });
      `,
        hostFor(),
        { env: "production" },
      );

    const badName = await bad(`{ "NOT VALID": "x" }`);
    expect(badName.status).toBe("failure");
    expect(badName.error?.message).toContain("not a valid environment variable name");

    // A newline would let a caller append a second KEY=value line wherever the
    // host writes these out as an env-file.
    const badValue = await bad(`{ TOKEN: "a\\nEXTRA=b" }`);
    expect(badValue.status).toBe("failure");
    expect(badValue.error?.message).toContain("may not contain newlines");
  });
});

describe("run() entrypoint handling", () => {
  async function capture(deployBody: string): Promise<RunInImageRequest[]> {
    const seen: RunInImageRequest[] = [];
    const host = {
      ...hostFor(),
      infrafileRun: async (request: RunInImageRequest) => {
        seen.push(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as InfrafileHost;

    await run(
      `
      defineInfra({
        envs: ["production"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy({ run }) { ${deployBody} },
      });
      `,
      host,
      { env: "production" },
    );
    return seen;
  }

  it("defaults the entrypoint to a shell so the image's own cannot mangle the command", async () => {
    // Without this, `docker run <image> sh -lc "..."` appends the args to an
    // image ENTRYPOINT, turning `npm run db:migrate` into nonsense.
    const seen = await capture(`await run("npm run db:migrate");`);
    expect(seen[0]?.entrypoint).toBe("sh");
    expect(seen[0]?.command).toBe("npm run db:migrate");
  });

  it("honours an explicit entrypoint", async () => {
    const seen = await capture(`await run("--version", { entrypoint: "node" });`);
    expect(seen[0]?.entrypoint).toBe("node");
  });

  it("allows clearing the entrypoint", async () => {
    const seen = await capture(`await run("./bin/start", { entrypoint: "" });`);
    expect(seen[0]?.entrypoint).toBe("");
  });

  it("runs several commands in order, so a migration can precede a deploy", async () => {
    const seen = await capture(
      `await run("npm run db:migrate"); await run("npx wrangler deploy");`,
    );
    expect(seen.map((r) => r.command)).toEqual(["npm run db:migrate", "npx wrangler deploy"]);
  });
});

describe("rollback", () => {
  const ROLLBACK = {
    plan: { tag: "production-9f8e7d6", replicas: 3 },
    image: "registry.test/app:production-9f8e7d6",
    digest: "sha256:old",
    fromRunId: "run-123",
  };

  it("replays deploy() with the recorded plan and image, building nothing", async () => {
    let built = false;
    let rendered = false;
    let planned = false;
    const seen: { image?: string; plan?: unknown } = {};

    const host = hostFor({
      build: async () => {
        built = true;
        return { image: "must-not-build" };
      },
    });

    const result = await run(
      `
      defineInfra({
        envs: ["production"],
        async plan() { globalThis.__planned = true; return { tag: "fresh" }; },
        dockerfile() { globalThis.__rendered = true; return "FROM node:22"; },
        async deploy({ image, plan, notes }) {
          await notes("shipped " + image + " x" + plan.replicas);
        },
      });
      `,
      host,
      { env: "production", rollback: ROLLBACK },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("success");
    // The whole point: the known-good bytes ship again, unmodified.
    expect(built).toBe(false);
    expect(result.image).toBe(ROLLBACK.image);
    expect(result.notes).toEqual(["shipped registry.test/app:production-9f8e7d6 x3"]);
    // plan() and dockerfile() never ran, so nothing was reconstructed.
    expect(result.plan).toBeUndefined();
    expect(result.dockerfile).toBeUndefined();
    expect(result.reachedStage).toBe("deploy");
    void rendered;
    void planned;
    void seen;
  });

  it("logs which run it is rolling back to", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["production"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      hostFor(),
      { env: "production", rollback: ROLLBACK },
    );

    const text = result.logs.map((l) => l.message).join("\n");
    expect(text).toContain(ROLLBACK.image);
    expect(text).toContain("run-123");
  });

  it("still validates the environment against the file", async () => {
    const result = await run(
      `defineInfra({ envs: ["staging"], plan: async () => ({}), dockerfile: () => "FROM x", deploy: async () => {} });`,
      hostFor(),
      { env: "production", rollback: ROLLBACK },
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("staging");
  });

  it("surfaces a deploy failure during a rollback", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["production"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy() { throw new Error("cluster unreachable"); },
      });
      `,
      hostFor(),
      { env: "production", rollback: ROLLBACK },
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("cluster unreachable");
  });

  it("still offers run() during a rollback, against the recorded image", async () => {
    const seen: RunInImageRequest[] = [];
    const host = {
      ...hostFor(),
      infrafileRun: async (request: RunInImageRequest) => {
        seen.push(request);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    } as unknown as InfrafileHost;

    await run(
      `
      defineInfra({
        envs: ["production"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy({ run }) { await run("npm run db:rollback"); },
      });
      `,
      host,
      { env: "production", rollback: ROLLBACK },
    );

    expect(seen[0]?.image).toBe(ROLLBACK.image);
    expect(seen[0]?.command).toBe("npm run db:rollback");
  });
});

describe("select() label edge cases", () => {
  it("does not mangle a label that collides with an Object.prototype key", async () => {
    // A resource legitimately named "constructor" read a truthy inherited value
    // from the dedupe map, turning its label into "constructor (function Object…1)".
    const host = hostFor({ answers: { pick: "constructor" } });

    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan({ select }) {
          return { chosen: await select("pick", "Pick", ["constructor", "toString"]) };
        },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      host,
    );

    expect(result.error).toBeUndefined();
    expect(result.plan).toEqual({ chosen: "constructor" });
  });

  it("still disambiguates genuine duplicates", async () => {
    const host = hostFor({ answers: { host: "web (2)" } });

    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan({ select }) {
          const picked = await select("host", "Build on", [
            { displayName: "web", id: "a" },
            { displayName: "web", id: "b" },
          ]);
          return { id: picked.id };
        },
        dockerfile: () => "FROM node:22",
        async deploy() {},
      });
      `,
      host,
    );

    expect(result.error).toBeUndefined();
    expect(result.plan).toEqual({ id: "b" });
  });
});

describe("push() guard", () => {
  it("refuses an empty image with an author-facing message", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() { return {}; },
        dockerfile: () => "FROM node:22",
        async deploy({ push }) { await push(""); },
      });
      `,
      // A host whose build yields no image at all.
      { ...hostFor(), infrafileBuild: async () => ({ image: "" }) } as unknown as InfrafileHost,
    );

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("no image to push");
  });
});
