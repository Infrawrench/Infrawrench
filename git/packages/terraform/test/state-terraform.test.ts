import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BACKEND_OVERRIDE,
  BACKEND_OVERRIDE_FILE,
  MemoryStateStore,
  backendConfiguration,
  backendEnvironment,
  lockState,
  stateResourceInstances,
  summarizePlan,
  type LockInfo,
} from "../src/index.js";
import { startServer, type TestServer } from "./server.js";

/**
 * The backend against the real `terraform` binary: what the client actually
 * sends is the specification. Everything is `terraform_data`, which is built
 * into Terraform, so `init` installs no provider and nothing leaves the
 * loopback. Skipped where Terraform is not installed.
 */

const TERRAFORM = (() => {
  for (const candidate of [
    process.env["TERRAFORM_BIN"],
    "terraform",
    "/opt/homebrew/bin/terraform",
  ]) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
})();

const CONFIG = `
variable "release" {
  type    = string
  default = "v1"
}

resource "terraform_data" "app" {
  input = var.release
}

resource "terraform_data" "fleet" {
  count = 2
  input = "node-\${count.index}"
}

output "release" {
  value = terraform_data.app.output
}
`;

interface Run {
  readonly code: number;
  /** Standard output and standard error together, for messages. */
  readonly output: string;
  readonly stdout: string;
}

describe.skipIf(TERRAFORM === null)("terraform against the http backend", () => {
  let store: MemoryStateStore;
  let server: TestServer;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    store = new MemoryStateStore();
    server = await startServer(store);
    dir = await mkdtemp(join(tmpdir(), "iw-terraform-"));
    await writeFile(join(dir, "main.tf"), `terraform {\n  backend "http" {}\n}\n${CONFIG}`);
    env = {
      PATH: process.env["PATH"],
      HOME: dir,
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      CHECKPOINT_DISABLE: "1",
      TF_HTTP_RETRY_MAX: "0",
      TF_HTTP_USERNAME: "infrawrench-ci",
      TF_HTTP_PASSWORD: "writer-token",
      ...backendEnvironment(server.stateUrl),
    };
  });

  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  function terraform(args: readonly string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
    return new Promise((resolve) => {
      execFile(
        TERRAFORM!,
        [...args],
        { cwd: dir, env: { ...env, ...extra }, timeout: 60_000 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, output: `${stdout}\n${stderr}`, stdout });
        },
      );
    });
  }

  async function ok(args: readonly string[], extra?: NodeJS.ProcessEnv): Promise<string> {
    const run = await terraform(args, extra);
    if (run.code !== 0) throw new Error(`terraform ${args.join(" ")} failed:\n${run.output}`);
    return run.stdout;
  }

  const heldBy = (id: string): LockInfo => ({
    ID: id,
    Operation: "OperationTypeApply",
    Info: "",
    Who: "someone-else@their-laptop",
    Version: "1.9.0",
    Created: new Date().toISOString(),
    Path: "",
  });

  it("inits, applies and lists state, locking with POST and DELETE", async () => {
    await ok(["init", "-no-color"]);
    await ok(["apply", "-auto-approve", "-no-color"]);
    const listed = await ok(["state", "list"]);
    expect(listed.trim().split("\n").sort()).toEqual([
      "terraform_data.app",
      "terraform_data.fleet[0]",
      "terraform_data.fleet[1]",
    ]);

    const head = await store.head();
    expect(head.lock).toBeNull();
    expect(head.version).toMatchObject({ createdBy: "ci:run-1", resourceCount: 2 });

    // Every lock was released, every write named its lock, and nothing was refused.
    const locks = server.requests.filter((r) => r.method === "POST" && r.path.endsWith("/lock"));
    const unlocks = server.requests.filter(
      (r) => r.method === "DELETE" && r.path.endsWith("/lock"),
    );
    expect(locks.length).toBeGreaterThan(0);
    expect(unlocks).toHaveLength(locks.length);
    const writes = server.requests.filter(
      (r) => r.method === "POST" && r.path.includes("/state?ID="),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(server.requests.filter((r) => r.status >= 400 && r.status !== 404)).toEqual([]);

    // A change is a new version with a higher serial, the old one still readable.
    await ok(["apply", "-auto-approve", "-no-color", "-var", "release=v2"]);
    const versions = await store.versions({ limit: 50 });
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const serials = versions.map((version) => version.serial);
    expect(serials).toEqual([...serials].sort((a, b) => b - a));
    expect(new Set(versions.map((version) => version.lineage)).size).toBe(1);
    const oldest = await store.read(versions.at(-1)!.id);
    expect(new TextDecoder().decode(oldest!)).toContain('"v1"');
    expect(await ok(["output", "-raw", "release"])).toContain("v2");
  });

  it("works with the backend's default LOCK and UNLOCK methods", async () => {
    const defaults = {
      TF_HTTP_LOCK_ADDRESS: server.stateUrl,
      TF_HTTP_UNLOCK_ADDRESS: server.stateUrl,
      TF_HTTP_LOCK_METHOD: "LOCK",
      TF_HTTP_UNLOCK_METHOD: "UNLOCK",
    };
    await ok(["init", "-no-color"], defaults);
    await ok(["apply", "-auto-approve", "-no-color"], defaults);
    expect(server.requests.some((r) => r.method === "LOCK" && r.status === 200)).toBe(true);
    expect(server.requests.some((r) => r.method === "UNLOCK" && r.status === 200)).toBe(true);
    expect((await store.head()).lock).toBeNull();
    expect((await store.head()).version).not.toBeNull();
  });

  it("works from a backend block written out, as on someone's own machine", async () => {
    await writeFile(
      join(dir, "main.tf"),
      `${backendConfiguration(server.stateUrl, "astrid")}${CONFIG}`,
    );
    const own = {
      PATH: env["PATH"],
      HOME: dir,
      TF_HTTP_PASSWORD: "admin-token",
      TF_IN_AUTOMATION: "1",
    };
    const run = (args: string[]) =>
      new Promise<Run>((resolve) => {
        execFile(
          TERRAFORM!,
          args,
          { cwd: dir, env: own, timeout: 60_000 },
          (error, stdout, stderr) =>
            resolve({ code: error ? 1 : 0, output: `${stdout}\n${stderr}`, stdout }),
        );
      });
    expect((await run(["init", "-no-color", "-input=false"])).code).toBe(0);
    const applied = await run(["apply", "-auto-approve", "-no-color", "-input=false"]);
    expect(applied.code, applied.output).toBe(0);
    expect((await store.head()).version?.createdBy).toBe("user:admin");
  });

  it("waits for a held lock with -lock-timeout, and names the holder when it gives up", async () => {
    await ok(["init", "-no-color"]);
    await lockState(store, heldBy("11111111-2222-3333-4444-555555555555"), { actor: "user:other" });

    const refused = await terraform(["apply", "-auto-approve", "-no-color", "-lock-timeout=1s"]);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("Error acquiring the state lock");
    // Terraform prints the lock info from our 423: the holder, not us.
    expect(refused.output).toContain("11111111-2222-3333-4444-555555555555");
    expect(refused.output).toContain("someone-else@their-laptop");
    expect((await store.head()).version).toBeNull();

    // Released while a second run is waiting: it goes through.
    setTimeout(() => void store.releaseLock(null), 1500);
    await ok(["apply", "-auto-approve", "-no-color", "-lock-timeout=30s"]);
    expect(server.requests.filter((r) => r.status === 423).length).toBeGreaterThan(1);
    expect((await store.head()).version).not.toBeNull();
    expect((await store.head()).lock).toBeNull();
  });

  it("force-unlocks for an admin only: the client does not send the lock's id", async () => {
    await ok(["init", "-no-color"]);
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await lockState(store, heldBy(id), { actor: "user:other" });

    const writer = await terraform(["force-unlock", "-force", id]);
    expect(writer.code).not.toBe(0);
    expect((await store.head()).lock?.info.ID).toBe(id);
    // What `terraform force-unlock` sends: an unlock with no lock info at all.
    expect(server.requests.at(-1)).toMatchObject({ method: "DELETE", status: 403, bodyBytes: 0 });

    await ok(["force-unlock", "-force", id], { TF_HTTP_PASSWORD: "admin-token" });
    expect((await store.head()).lock).toBeNull();
  });

  it("refuses a wrong token, and a token that may only read", async () => {
    const denied = await terraform(["init", "-no-color"], { TF_HTTP_PASSWORD: "nope" });
    expect(denied.code).not.toBe(0);
    expect(server.requests.at(-1)?.status).toBe(401);

    await ok(["init", "-no-color"]);
    await ok(["apply", "-auto-approve", "-no-color"]);
    const before = (await store.versions({ limit: 50 })).length;
    const reader = { TF_HTTP_PASSWORD: "reader-token" };
    // Reading works: a plan without the lock.
    await ok(["plan", "-no-color", "-lock=false"], reader);
    const apply = await terraform(
      ["apply", "-auto-approve", "-no-color", "-var", "release=v9"],
      reader,
    );
    expect(apply.code).not.toBe(0);
    expect((await store.versions({ limit: 50 })).length).toBe(before);
  });

  it("plans with a credential that locks and reads, and cannot apply with it", async () => {
    await ok(["init", "-no-color"]);
    await ok(["apply", "-auto-approve", "-no-color"]);
    const before = (await store.versions({ limit: 50 })).length;
    const planner = { TF_HTTP_PASSWORD: "planner-token" };
    // The plan a job runs: with the lock, a saved plan file, and a refresh.
    await ok(
      ["plan", "-no-color", "-lock-timeout=10s", "-out=tfplan", "-var", "release=v9"],
      planner,
    );
    expect((await store.head()).lock).toBeNull();
    expect((await store.versions({ limit: 50 })).length).toBe(before);
    const apply = await terraform(["apply", "-no-color", "-lock-timeout=10s", "tfplan"], planner);
    expect(apply.code).not.toBe(0);
    expect((await store.versions({ limit: 50 })).length).toBe(before);
  });

  it("runs what a CI job runs: an override backend, a plan posted as JSON, that plan applied", async () => {
    // The root declares another backend; the override file wins.
    await writeFile(join(dir, "main.tf"), `terraform {\n  backend "local" {}\n}\n${CONFIG}`);
    await writeFile(join(dir, BACKEND_OVERRIDE_FILE), BACKEND_OVERRIDE);
    await ok(["init", "-no-color"]);
    await ok(["plan", "-no-color", "-lock-timeout=10s", "-out=tfplan"]);
    const planJson = (await terraform(["show", "-json", "tfplan"])).stdout;

    const posted = await fetch(server.planUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("infrawrench-ci:writer-token").toString("base64")}`,
        "content-type": "application/json",
      },
      body: planJson,
    });
    expect(posted.status).toBe(204);
    const summary = summarizePlan(server.plans[0]);
    expect(summary).toMatchObject({ add: 3, change: 0, destroy: 0, applyable: true });
    expect(summary.resources.map((r) => r.address)).toEqual([
      "terraform_data.app",
      "terraform_data.fleet[0]",
      "terraform_data.fleet[1]",
    ]);

    await ok(["apply", "-no-color", "-lock-timeout=10s", "tfplan"]);
    // The state went to the forge, not to the local backend the root names.
    await expect(readFile(join(dir, "terraform.tfstate"))).rejects.toThrow();
    const head = await store.head();
    const stored = JSON.parse(new TextDecoder().decode((await store.read(head.version!.id))!));
    const { instances } = stateResourceInstances(stored);
    expect(instances.map((i) => i.address)).toEqual([
      "terraform_data.app",
      "terraform_data.fleet[0]",
      "terraform_data.fleet[1]",
    ]);
    expect(instances[0]?.provider).toBe("terraform.io/builtin/terraform");
    expect(instances.every((i) => i.identifiers.length === 1)).toBe(true);
  });
});
