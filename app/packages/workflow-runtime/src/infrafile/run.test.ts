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

describe("destroy (preview teardown)", () => {
  const PR_GIT = { ...GIT, pullRequest: { number: 42, branch: "feature/thing" } };

  it("calls destroy() and skips plan, dockerfile and build entirely", async () => {
    let built = false;
    const host = hostFor({
      build: async () => {
        built = true;
        return { image: "never" };
      },
    });

    const result = await runInfrafile({
      source: `
      defineInfra({
        envs: ["preview"],
        async plan() { throw new Error("plan must not run"); },
        dockerfile() { throw new Error("dockerfile must not run"); },
        async deploy() { throw new Error("deploy must not run"); },
        async destroy({ env, git, notes }) {
          await notes("tore down " + env + " for PR " + git.pullRequest.number);
        },
      });
      `,
      host,
      env: "preview",
      git: PR_GIT,
      interactive: false,
      destroy: true,
    });

    expect(result.error).toBeUndefined();
    expect(built).toBe(false);
    expect(result.notes).toEqual(["tore down preview for PR 42"]);
    expect(result.reachedStage).toBe("destroy");
  });

  it("says so clearly when the Infrafile has no destroy stage", async () => {
    // Otherwise a closed pull request leaves its environment running and the
    // only symptom is a bill.
    const result = await runInfrafile({
      source: `defineInfra({ envs: ["preview"], plan: async () => ({}), dockerfile: () => "FROM x", deploy: async () => {} });`,
      host: hostFor(),
      env: "preview",
      git: PR_GIT,
      interactive: false,
      destroy: true,
    });

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("no destroy() stage");
  });

  it("rejects a non-function destroy at registration", async () => {
    const result = await run(
      `defineInfra({ envs: ["staging"], plan: async () => ({}), dockerfile: () => "FROM x", deploy: async () => {}, destroy: 3 });`,
      hostFor(),
    );
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("'destroy', when present, must be a function");
  });

  it("exposes the pull request to a normal preview deploy", async () => {
    const result = await runInfrafile({
      source: `
      defineInfra({
        envs: ["preview"],
        async plan() { return { buildOn: "local" }; },
        dockerfile: () => "FROM node:22",
        async deploy({ git, notes }) {
          await notes("pr-" + git.pullRequest.number + " on " + git.pullRequest.branch);
        },
      });
      `,
      host: hostFor(),
      env: "preview",
      git: PR_GIT,
      interactive: false,
    });

    expect(result.error).toBeUndefined();
    expect(result.notes).toEqual(["pr-42 on feature/thing"]);
  });
});

describe("ask() — free-form questions", () => {
  const askPlan = (body: string) => `
    defineInfra({
      envs: ["staging"],
      async plan({ ask }) { ${body} },
      dockerfile: () => "FROM node:22",
      async deploy() {},
    });
  `;

  it("returns each kind already coerced to its type", async () => {
    const host = hostFor({
      answers: { name: "api", replicas: "3", when: "2026-08-01", confirm: "yes" },
    });
    const result = await run(
      askPlan(`return {
        name: await ask("name", "Service"),
        replicas: await ask("replicas", "Replicas", { kind: "number" }),
        when: await ask("when", "Date", { kind: "date" }),
        confirm: await ask("confirm", "Ship?", { kind: "boolean" }),
      };`),
      host,
    );
    expect(result.error).toBeUndefined();
    // Types, not strings — a number is a number and a boolean is a boolean.
    expect(result.plan).toEqual({ name: "api", replicas: 3, when: "2026-08-01", confirm: true });
  });

  it("rejects a --set answer that is not a number", async () => {
    // The unattended path is exactly the one with nobody watching, so it has to
    // fail as loudly as a typed answer would.
    const result = await run(
      askPlan(`return { n: await ask("replicas", "Replicas", { kind: "number" }) };`),
      hostFor({ answers: { replicas: "lots" } }),
    );
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain('"lots" is not a number');
  });

  it("enforces numeric bounds", async () => {
    const result = await run(
      askPlan(
        `return { n: await ask("replicas", "Replicas", { kind: "number", min: 1, max: 5 }) };`,
      ),
      hostFor({ answers: { replicas: "9" } }),
    );
    expect(result.error?.message).toContain("above the maximum of 5");
  });

  it("rejects a date that is not a real calendar day", async () => {
    const result = await run(
      askPlan(`return { d: await ask("when", "When", { kind: "date" }) };`),
      hostFor({ answers: { when: "2026-02-30" } }),
    );
    expect(result.error?.message).toContain("is not a date");
  });

  it("accepts the usual spellings of yes and no", async () => {
    for (const [given, expected] of [
      ["y", true],
      ["off", false],
      ["TRUE", true],
    ] as const) {
      const r = await run(
        askPlan(`return { b: await ask("b", "B", { kind: "boolean" }) };`),
        hostFor({ answers: { b: given } }),
      );
      expect((r.plan as { b: boolean }).b).toBe(expected);
    }
  });

  it("enforces a pattern on text", async () => {
    const result = await run(
      askPlan(`return { v: await ask("tag", "Tag", { pattern: "^v[0-9]+" }) };`),
      hostFor({ answers: { tag: "nope" } }),
    );
    expect(result.error?.message).toContain("does not match");
  });

  it("falls back to the default when the answer is blank", async () => {
    const result = await run(
      askPlan(`return { n: await ask("replicas", "Replicas", { kind: "number", default: 2 }) };`),
      hostFor({ answers: { replicas: "" } }),
    );
    expect(result.plan).toEqual({ n: 2 });
  });

  it("requires an answer unless told otherwise", async () => {
    const required = await run(
      askPlan(`return { v: await ask("v", "V") };`),
      hostFor({ answers: { v: "" } }),
    );
    expect(required.error?.message).toContain("requires an answer");

    const optional = await run(
      askPlan(`return { v: await ask("v", "V", { required: false }) };`),
      hostFor({ answers: { v: "" } }),
    );
    expect(optional.plan).toEqual({ v: "" });
  });

  it("names the key when a non-interactive run has no answer", async () => {
    const result = await run(askPlan(`return { v: await ask("release", "Release") };`), hostFor());
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("--set release=");
  });

  it("prompts with the right input kind when interactive", async () => {
    const seen: { kind?: string }[] = [];
    const host = hostFor({
      prompt: (spec) => {
        seen.push(spec as never);
        return "2026-12-25";
      },
    });
    const result = await run(
      askPlan(`return { d: await ask("when", "Deploy on", { kind: "date" }) };`),
      host,
      { interactive: true },
    );
    expect(result.error).toBeUndefined();
    expect(seen[0]?.kind).toBe("date");
    expect(result.plan).toEqual({ d: "2026-12-25" });
  });
});

describe("created-resource ledger", () => {
  const creatingHost = (): InfrafileHost =>
    ({
      ...hostFor(),
      listPlugins: async () => [
        {
          pluginId: "neon",
          displayName: "Neon",
          accounts: [{ id: "acct-1", pluginId: "neon", displayName: "test" }],
          resourceTypes: [
            {
              id: "neon-project",
              displayName: "Project",
              pluralDisplayName: "Projects",
              outputs: [],
              supportsCreate: true,
              supportsUpdate: false,
              supportsDelete: true,
            },
          ],
        },
      ],
      createResource: async (
        accountId: string,
        typeId: string,
        fields: Record<string, string>,
      ) => ({
        id: `${accountId}:${typeId}:prj_1`,
        pluginId: "neon",
        resourceTypeId: typeId,
        accountId,
        displayName: fields["name"] ?? "created",
        externalId: "prj_1",
        fields,
        resolvedOutputs: {},
      }),
    }) as unknown as InfrafileHost;

  it("records resources created through infra.accounts on the run result", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          const neon = infra.accounts.neon.list()[0];
          await neon.projects.create({ name: "todo-api" });
          return {};
        },
        dockerfile: () => "FROM node:22",
        deploy: async () => {},
      });
      `,
      creatingHost(),
    );

    expect(result.error).toBeUndefined();
    expect(result.createdResources).toEqual([
      {
        pluginId: "neon",
        accountId: "acct-1",
        resourceTypeId: "neon-project",
        resourceId: "acct-1:neon-project:prj_1",
        externalId: "prj_1",
        displayName: "todo-api",
      },
    ]);
    expect(result.logs.map((l) => l.message)).toContain("created neon-project todo-api");
  });

  it("leaves the ledger empty for a run that only lists", async () => {
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          await infra.accounts.neon.list()[0].projects.list();
          return {};
        },
        dockerfile: () => "FROM node:22",
        deploy: async () => {},
      });
      `,
      {
        ...creatingHost(),
        listResources: async () => [],
      } as unknown as InfrafileHost,
    );

    expect(result.error).toBeUndefined();
    expect(result.createdResources).toEqual([]);
  });
});

describe("sidecar importYaml", () => {
  // The kubernetes sidecar carries no resource types here on purpose: the
  // importYaml surface must exist independently of any peer resource groups.
  const clusterHost = (calls: unknown[]): InfrafileHost =>
    ({
      ...hostFor(),
      listPlugins: async () => [
        {
          pluginId: "gcp",
          displayName: "Google Cloud",
          accounts: [{ id: "acct-1", pluginId: "gcp", displayName: "test" }],
          resourceTypes: [
            {
              id: "gke-cluster",
              displayName: "GKE Cluster",
              pluralDisplayName: "GKE Clusters",
              outputs: [],
              supportsCreate: false,
              supportsUpdate: false,
              supportsDelete: false,
              sidecars: [
                {
                  pluginId: "kubernetes",
                  displayName: "Kubernetes",
                  tabLabel: "Kubernetes",
                  resourceTypes: [],
                },
              ],
            },
          ],
        },
      ],
      listResources: async (accountId: string, typeId: string) => [
        {
          id: `${accountId}:${typeId}:cl_1`,
          pluginId: "gcp",
          resourceTypeId: typeId,
          accountId,
          displayName: "prod",
          externalId: "cl_1",
          fields: {},
          resolvedOutputs: {},
        },
      ],
      importYaml: async (accountId: string, yaml: string, sidecar?: unknown) => {
        calls.push({ accountId, yaml, sidecar });
        return { applied: 1 };
      },
    }) as unknown as InfrafileHost;

  it("routes cluster.kubernetes.importYaml through the parent resource's sidecar ref", async () => {
    const calls: unknown[] = [];
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          const gcp = infra.accounts.gcp.list()[0];
          const cluster = (await gcp.gkeClusters.list())[0];
          await cluster.kubernetes.importYaml("kind: Namespace");
          return {};
        },
        dockerfile: () => "FROM node:22",
        deploy: async () => {},
      });
      `,
      clusterHost(calls),
    );

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([
      {
        accountId: "acct-1",
        yaml: "kind: Namespace",
        sidecar: { pluginId: "kubernetes", parentResourceId: "acct-1:gke-cluster:cl_1" },
      },
    ]);
  });
});

describe("read-only plan", () => {
  // Same shape as the ledger's creatingHost, plus a call counter — the point
  // of every dry-run assertion is that this counter stays at zero.
  const countingHost = (): { host: InfrafileHost; calls: { created: number } } => {
    const calls = { created: 0 };
    const host = {
      ...hostFor(),
      listPlugins: async () => [
        {
          pluginId: "neon",
          displayName: "Neon",
          accounts: [{ id: "acct-1", pluginId: "neon", displayName: "test" }],
          resourceTypes: [
            {
              id: "neon-project",
              displayName: "Project",
              pluralDisplayName: "Projects",
              outputs: [],
              supportsCreate: true,
              supportsUpdate: false,
              supportsDelete: true,
            },
          ],
        },
      ],
      createResource: async (accountId: string, typeId: string, fields: Record<string, string>) => {
        calls.created += 1;
        return {
          id: `${accountId}:${typeId}:prj_1`,
          pluginId: "neon",
          resourceTypeId: typeId,
          accountId,
          displayName: fields["name"] ?? "created",
          externalId: "prj_1",
          fields,
          resolvedOutputs: {},
        };
      },
    } as unknown as InfrafileHost;
    return { host, calls };
  };

  it("records a create as a planned change instead of performing it", async () => {
    const { host, calls } = countingHost();
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          const neon = infra.accounts.neon.list()[0];
          const prj = await neon.projects.create({ name: "todo-api" });
          return { createdId: prj.id };
        },
        dockerfile: () => "FROM node:22",
        deploy: async () => { throw new Error("deploy must not run"); },
      });
      `,
      host,
      { planOnly: true },
    );

    expect(result.error).toBeUndefined();
    expect(calls.created).toBe(0);
    expect(result.createdResources).toEqual([]);
    expect(result.plannedChanges).toEqual([
      {
        action: "create",
        accountId: "acct-1",
        resourceTypeId: "neon-project",
        displayName: "todo-api",
        fields: { name: "todo-api" },
      },
    ]);
    expect((result.plan as { createdId: string }).createdId.startsWith("planned:")).toBe(true);
  });

  it("resolves a synthetic resource's outputs to the placeholder", async () => {
    // hostFor() has no resolveOutput, so reaching the host here would fail the
    // run — a passing test proves the placeholder short-circuited it.
    const { host } = countingHost();
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          const neon = infra.accounts.neon.list()[0];
          const prj = await neon.projects.create({ name: "todo-api" });
          const conn = await neon.resolveOutput("neon-project", prj.id, "connectionString");
          return { conn };
        },
        dockerfile: () => "FROM node:22",
        deploy: async () => {},
      });
      `,
      host,
      { planOnly: true },
    );

    expect(result.error).toBeUndefined();
    expect(result.plan).toEqual({ conn: "(known after apply)" });
  });

  it("performs creates for real when planOnly is off", async () => {
    const { host, calls } = countingHost();
    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          const neon = infra.accounts.neon.list()[0];
          await neon.projects.create({ name: "todo-api" });
          return {};
        },
        dockerfile: () => "FROM node:22",
        deploy: async () => {},
      });
      `,
      host,
    );

    expect(result.error).toBeUndefined();
    expect(calls.created).toBe(1);
    expect(result.plannedChanges).toEqual([]);
    expect(result.createdResources).toHaveLength(1);
  });

  it("exposes ctx.dryRun to plan(): true on planOnly, false otherwise", async () => {
    const source = `
      defineInfra({
        envs: ["staging"],
        async plan(ctx) { return { dry: ctx.dryRun }; },
        dockerfile: () => "FROM node:22",
        deploy: async () => {},
      });
      `;

    const planned = await run(source, hostFor(), { planOnly: true });
    expect(planned.error).toBeUndefined();
    expect(planned.plan).toEqual({ dry: true });

    const real = await run(source, hostFor());
    expect(real.error).toBeUndefined();
    expect(real.plan).toEqual({ dry: false });
  });
});

describe("destroy plan state", () => {
  it("hands destroy() the recorded plan the caller supplied", async () => {
    const result = await runInfrafile({
      source: `
      defineInfra({
        envs: ["staging"],
        plan: async () => ({}),
        dockerfile: () => "FROM x",
        deploy: async () => {},
        async destroy({ env, plan, notes }) {
          await notes("tearing down " + (plan ? plan.namespace : "without a plan") + " on " + env);
        },
      });
      `,
      host: hostFor(),
      env: "staging",
      git: GIT,
      interactive: false,
      destroy: true,
      destroyPlan: { namespace: "todo-api-staging", neonAccount: "test" },
    });

    expect(result.error).toBeUndefined();
    expect(result.notes).toEqual(["tearing down todo-api-staging on staging"]);
  });

  it("leaves plan undefined when the caller found no history", async () => {
    const result = await runInfrafile({
      source: `
      defineInfra({
        envs: ["staging"],
        plan: async () => ({}),
        dockerfile: () => "FROM x",
        deploy: async () => {},
        async destroy({ plan, notes }) {
          await notes(plan === undefined ? "no plan" : "unexpected plan");
        },
      });
      `,
      host: hostFor(),
      env: "staging",
      git: GIT,
      interactive: false,
      destroy: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.notes).toEqual(["no plan"]);
  });
});

describe("infrafileImageRef", () => {
  it("uses a slash-bearing tag verbatim as the full image reference", async () => {
    const { infrafileImageRef } = await import("./types.js");
    expect(
      infrafileImageRef({
        project: "astrid/demo",
        env: "production",
        tag: "europe-north2-docker.pkg.dev/my-proj/repo/app:production-abc",
        registryHost: "europe-north2-docker.pkg.dev",
      }),
    ).toBe("europe-north2-docker.pkg.dev/my-proj/repo/app:production-abc");
  });

  it("still composes host/name:tag from a bare tag", async () => {
    const { infrafileImageRef } = await import("./types.js");
    expect(
      infrafileImageRef({
        project: "astrid/demo",
        env: "staging",
        tag: "staging-abc1234",
        registryHost: "registry.example.com",
      }),
    ).toBe("registry.example.com/demo:staging-abc1234");
  });
});

describe("push() registry default", () => {
  it("a bare push() carries the plan's registry credentials", async () => {
    const pushes: Array<{ image: string; registry?: { host: string } }> = [];
    const host = {
      ...hostFor(),
      infrafilePush: async (image: string, registry?: { host: string }) => {
        pushes.push({ image, ...(registry ? { registry } : {}) });
      },
    } as unknown as InfrafileHost;

    const result = await run(
      `
      defineInfra({
        envs: ["staging"],
        async plan() {
          return { registry: { host: "eu-docker.pkg.dev", username: "oauth2accesstoken", password: "tok" } };
        },
        dockerfile: () => "FROM node:22",
        async deploy({ push }) { await push(); },
      });
      `,
      host,
    );

    expect(result.error).toBeUndefined();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.registry?.host).toBe("eu-docker.pkg.dev");
  });
});
