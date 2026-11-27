/**
 * The Worker's Terraform routes with the real `terraform` on the other end:
 * the router, `terraformState` and `terraformPlan`, access as
 * `decideStateAuth` decides it, and the workspace's store (SQLite and a
 * bucket) as the Durable Object runs it. Only workerd and Postgres are stood
 * in for (`support/terraform-server.ts`).
 *
 * Everything is `terraform_data`, which is built into Terraform: `init`
 * installs no provider and nothing leaves the loopback. Skipped where
 * Terraform is not installed.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LockInfo,
  type NewStateVersion,
  backendEnvironment,
  stateResourceInstances,
} from "@infrawrench/git-terraform";
import { MAX_PLAN_BYTES, planInputsKey } from "../src/terraform/route";
import { WorkspaceStateStore, workspacePrefix } from "../src/terraform/state-store";
import { MemoryBucket, nodeStorage } from "./support/node-platform";
import {
  LIVE_CI_RUN,
  LIVE_RUN,
  PASSWORDS,
  type TerraformServer,
  WORKSPACE_ID,
  startTerraformServer,
} from "./support/terraform-server";

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

/** Obviously fake, and in no real token format. */
const SECRET = "not-a-real-database-password";

const CONFIG = `
terraform {
  backend "http" {}
}

variable "release" {
  type    = string
  default = "v1"
}

variable "password" {
  type      = string
  sensitive = true
  default   = "${SECRET}"
}

resource "terraform_data" "app" {
  input = var.release
}

resource "terraform_data" "database" {
  input = var.password
}

resource "terraform_data" "fleet" {
  count = 2
  input = "node-\${count.index}"
}
`;

interface Run {
  readonly code: number;
  readonly output: string;
  readonly stdout: string;
}

const basic = (password: string): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`anyone:${password}`).toString("base64")}`,
});

const lockInfo = (id: string, who = "someone-else@their-laptop"): LockInfo => ({
  ID: id,
  Operation: "OperationTypeApply",
  Info: "",
  Who: who,
  Version: "1.9.0",
  Created: new Date().toISOString(),
  Path: "",
});

describe.skipIf(TERRAFORM === null)("terraform against the Worker's state backend", () => {
  let server: TerraformServer;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    server = await startTerraformServer();
    dir = await mkdtemp(join(tmpdir(), "iw-forge-terraform-"));
    await writeFile(join(dir, "main.tf"), CONFIG);
    env = {
      PATH: process.env["PATH"],
      HOME: dir,
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      CHECKPOINT_DISABLE: "1",
      TF_HTTP_RETRY_MAX: "0",
      TF_HTTP_USERNAME: "infrawrench-ci",
      // A run's job token, as its pipeline has it.
      TF_HTTP_PASSWORD: PASSWORDS.job,
      ...backendEnvironment(server.stateUrl),
    };
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const terraform = (args: readonly string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        TERRAFORM!,
        [...args],
        { cwd: dir, env: { ...env, ...extra }, timeout: 90_000, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, output: `${stdout}\n${stderr}`, stdout });
        },
      );
    });
  const ok = async (args: readonly string[], extra?: NodeJS.ProcessEnv): Promise<string> => {
    const run = await terraform(args, extra);
    if (run.code !== 0) throw new Error(`terraform ${args.join(" ")} failed:\n${run.output}`);
    return run.stdout;
  };
  const call = (
    method: string,
    path: string,
    password: string | null,
    body?: string,
  ): Promise<Response> =>
    fetch(`${server.stateUrl}${path}`, {
      method,
      headers: password === null ? {} : basic(password),
      ...(body !== undefined ? { body } : {}),
    });
  const stateKeys = (): string[] =>
    [...server.bucket.objects.keys()].filter((key) => key.endsWith(".tfstate")).sort();

  it("applies through the routes: versions in the bucket, the head mirrored", async () => {
    await ok(["init", "-no-color"]);
    await ok(["apply", "-auto-approve", "-no-color"]);
    expect((await ok(["state", "list"])).trim().split("\n").sort()).toEqual([
      "terraform_data.app",
      "terraform_data.database",
      "terraform_data.fleet[0]",
      "terraform_data.fleet[1]",
    ]);

    // One object per version, under the workspace's prefix, named by serial and id.
    const keys = stateKeys();
    expect(keys.length).toBeGreaterThanOrEqual(1);
    for (const key of keys) {
      expect(key).toMatch(
        new RegExp(`^${workspacePrefix(WORKSPACE_ID)}\\d+-[0-9a-z]{22}\\.tfstate$`),
      );
    }
    const head = await server.store.head();
    expect(head.lock).toBeNull();
    expect(head.version).toMatchObject({ resourceCount: 3, createdBy: `ci:${LIVE_CI_RUN}` });

    // The route mirrored every change: the last word is the head, unlocked.
    const last = server.heads.at(-1)!;
    expect(last.report.version?.id).toBe(head.version!.id);
    expect(last.report.lock).toBeNull();
    expect(last.principal).toMatchObject({ kind: "job", runId: LIVE_CI_RUN });
    // Each stored version was reported once, with where its bytes are.
    const written = server.heads.flatMap((entry) => entry.report.written ?? []);
    expect(written.map((version) => version.r2Key).sort()).toEqual(keys);
    // A lock was reported while it was held.
    expect(server.heads.some((entry) => entry.report.lock !== null)).toBe(true);
    // The header the mirror travels in never reaches the client.
    const read = await call("GET", "", PASSWORDS.job);
    expect(read.headers.get("x-infrawrench-terraform-head")).toBeNull();
    expect(read.headers.get("x-terraform-state-serial")).toBe(String(head.version!.serial));
    await read.arrayBuffer();

    // A second apply is a second version; the first stays readable.
    await ok(["apply", "-auto-approve", "-no-color"], { TF_VAR_release: "v2" });
    const versions = await server.store.versions({ limit: 10 });
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0]!.serial).toBeGreaterThan(versions[1]!.serial);
    expect(stateKeys().length).toBe(versions.length);
    const page = await server.store.versions({ limit: 1 });
    expect(await server.store.versions({ limit: 10, before: page[0]!.id })).toEqual(
      versions.slice(1),
    );
  });

  it("refuses a second writer while the lock is held, and says who holds it", async () => {
    await ok(["init", "-no-color"]);
    await ok(["apply", "-auto-approve", "-no-color"]);
    const held = lockInfo("11111111-2222-3333-4444-555555555555");
    expect((await call("POST", "/lock", PASSWORDS.token, JSON.stringify(held))).status).toBe(200);
    expect(server.heads.at(-1)!.report.lock?.heldBy).toBe("token:pat-admin");

    const blocked = await terraform(["apply", "-auto-approve", "-no-color", "-lock-timeout=0s"], {
      TF_VAR_release: "v2",
    });
    expect(blocked.code).not.toBe(0);
    expect(blocked.output).toContain("someone-else@their-laptop");
    expect(blocked.output).toContain(held.ID);

    // A write that names no lock, or another one, is refused with the holder's info.
    const current = await (await call("GET", "", PASSWORDS.token)).text();
    expect((await call("POST", "", PASSWORDS.token, current)).status).toBe(423);
    const stolen = await call("POST", "?ID=another-lock", PASSWORDS.token, current);
    expect(stolen.status).toBe(423);
    expect(((await stolen.json()) as LockInfo).ID).toBe(held.ID);

    // Unlocking without the lock's id is a forced unlock: admins only.
    expect((await call("DELETE", "/lock", PASSWORDS.writer)).status).toBe(403);
    expect((await call("DELETE", "/lock", PASSWORDS.job)).status).toBe(403);
    expect((await call("DELETE", "/lock", PASSWORDS.token)).status).toBe(403);
    expect((await call("DELETE", "/lock", PASSWORDS.admin)).status).toBe(200);
    expect(server.heads.at(-1)!.report.lock).toBeNull();
    await ok(["apply", "-auto-approve", "-no-color"], { TF_VAR_release: "v2" });
  });

  it("restores an old version as a new one", async () => {
    await ok(["init", "-no-color"]);
    await ok(["apply", "-auto-approve", "-no-color"]);
    const first = (await server.store.head()).version!;
    await ok(["apply", "-auto-approve", "-no-color"], { TF_VAR_release: "v2" });
    const second = (await server.store.head()).version!;
    expect(second.serial).toBeGreaterThan(first.serial);

    // Refused while a run holds the lock: it would write over the restore.
    await call("POST", "/lock", PASSWORDS.token, JSON.stringify(lockInfo("lock-1")));
    expect(await server.client.restore(first.id, "user:admin")).toMatchObject({ kind: "locked" });
    await call("DELETE", "/lock", PASSWORDS.admin);
    expect(await server.client.restore("no-such-version", "user:admin")).toEqual({
      kind: "not-found",
    });

    const restored = await server.client.restore(first.id, "user:admin");
    if (restored.kind !== "restored") throw new Error(`not restored: ${restored.kind}`);
    const now = restored.head.version!;
    expect(now.serial).toBe(second.serial + 1);
    expect(now.lineage).toBe(first.lineage);
    expect(now.createdBy).toBe("user:admin");
    expect(restored.head.written?.id).toBe(now.id);
    // Nothing was rewritten: all three versions are there.
    expect((await server.store.versions({ limit: 10 })).map((version) => version.id)).toContain(
      first.id,
    );
    // Terraform reads the restored state, and plans to bring it forward again.
    const pulled = JSON.parse(await ok(["state", "pull"])) as { serial: number };
    expect(pulled.serial).toBe(now.serial);
    const plan = await terraform(["plan", "-no-color", "-detailed-exitcode"], {
      TF_VAR_release: "v2",
    });
    expect(plan.code).toBe(2);
    // The old document's bytes, for the forge's download.
    const bytes = await (await server.client.readVersion(first.id))!.arrayBuffer();
    expect(
      stateResourceInstances(JSON.parse(new TextDecoder().decode(bytes))).instances,
    ).toHaveLength(4);
  });

  it("answers 401 and 403, and never 404 or 204, to those who may not", async () => {
    await ok(["init", "-no-color"]);
    await ok(["apply", "-auto-approve", "-no-color"]);

    const nobody = await call("GET", "", null);
    expect(nobody.status).toBe(401);
    expect(nobody.headers.get("www-authenticate")).toContain("Basic");
    expect((await call("GET", "", "a-password-nobody-has")).status).toBe(401);

    // A reader of a public repository; a member, who writes the repository
    // and is not its administrator, signed in or with a token; an
    // administrator's token that may only read; and every job token but the
    // live run's own for this workspace: another run's, another repository's,
    // another workspace's, and one that names no workspace at all.
    for (const password of [
      PASSWORDS.reader,
      PASSWORDS.writer,
      PASSWORDS.writerToken,
      PASSWORDS.readToken,
      PASSWORDS.otherJob,
      PASSWORDS.foreignJob,
      PASSWORDS.otherWorkspaceJob,
      PASSWORDS.unboundJob,
      PASSWORDS.unboundService,
    ]) {
      expect((await call("GET", "", password)).status, password).toBe(403);
      expect((await call("POST", "/lock", password, JSON.stringify(lockInfo("x")))).status).toBe(
        403,
      );
    }
    // No workspace, or no repository, is the same answer: nothing is probed.
    for (const path of [
      "/acme/infra/terraform/staging/state",
      "/acme/other/terraform/prod/state",
    ]) {
      const missing = await fetch(`${server.origin}${path}`, { headers: basic(PASSWORDS.admin) });
      expect(missing.status).toBe(403);
      expect((await fetch(`${server.origin}${path}`)).status).toBe(401);
    }
    // With the reader's credential, terraform fails; it does not plan to create everything.
    const refused = await terraform(["plan", "-no-color"], { TF_HTTP_PASSWORD: PASSWORDS.reader });
    expect(refused.code).not.toBe(0);
    expect(refused.output).not.toContain("to add");

    // The app's own token reads, and changes nothing.
    expect((await call("GET", "", PASSWORDS.service)).status).toBe(200);
    expect(
      (await call("POST", "/lock", PASSWORDS.service, JSON.stringify(lockInfo("x")))).status,
    ).toBe(403);
    // An administrator's personal access token with `repo:write` reads and
    // writes; it never deletes, which is done signed in.
    expect((await call("GET", "", PASSWORDS.token)).status).toBe(200);
    expect((await call("DELETE", "", PASSWORDS.token)).status).toBe(403);
    expect((await call("DELETE", "", PASSWORDS.writer)).status).toBe(403);

    // A plan's token reads and locks, and writes nothing.
    const planLock = JSON.stringify(lockInfo("plan-lock"));
    const stored = await (await call("GET", "", PASSWORDS.planJob)).text();
    expect((await call("POST", "/lock", PASSWORDS.planJob, planLock)).status).toBe(200);
    expect((await call("POST", "?ID=plan-lock", PASSWORDS.planJob, stored)).status).toBe(403);
    expect((await call("DELETE", "", PASSWORDS.planJob)).status).toBe(403);
    expect((await call("DELETE", "/lock", PASSWORDS.planJob, planLock)).status).toBe(200);
    await ok(["plan", "-no-color", "-lock-timeout=5s"], { TF_HTTP_PASSWORD: PASSWORDS.planJob });
    const applied = await terraform(["apply", "-auto-approve", "-no-color"], {
      TF_HTTP_PASSWORD: PASSWORDS.planJob,
      TF_VAR_release: "v7",
    });
    expect(applied.code).not.toBe(0);

    // The session cookie is never read here, whatever it would prove elsewhere.
    const cookie = await fetch(server.stateUrl, { headers: { cookie: "iwg-session=anything" } });
    expect(cookie.status).toBe(401);

    // A run's token stops working when its run is over.
    server.live = false;
    expect((await call("GET", "", PASSWORDS.job)).status).toBe(403);
    server.live = true;

    // An archived repository's state is read, never changed.
    server.archived = true;
    expect((await call("GET", "", PASSWORDS.token)).status).toBe(200);
    expect(
      (await call("POST", "/lock", PASSWORDS.token, JSON.stringify(lockInfo("x")))).status,
    ).toBe(403);
    expect((await call("DELETE", "", PASSWORDS.admin)).status).toBe(403);
    server.archived = false;

    // Deleted by an admin, the workspace is truly empty: only now is it a 404.
    expect((await call("DELETE", "", PASSWORDS.admin)).status).toBe(200);
    expect((await call("GET", "", PASSWORDS.token)).status).toBe(404);
    expect(server.heads.at(-1)!.report.version).toBeNull();
    // The versions are still stored: a delete is undone by restoring one.
    expect(stateKeys().length).toBeGreaterThan(0);
    expect((await call("GET", "/nonsense", PASSWORDS.token)).status).toBe(400);
  });

  it("takes a run's plan, keeps its summary and hands pricing its inputs once", async () => {
    await ok(["init", "-no-color"]);
    await ok(["plan", "-no-color", "-out=tfplan"]);
    const document = await ok(["show", "-json", "tfplan"]);
    // The plan document has the secret in the clear: that is why it is not kept.
    expect(document).toContain(SECRET);

    const post = (password: string | null, body: string, url = server.planUrl) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(password ? basic(password) : {}) },
        body,
      });
    expect((await post(null, document)).status).toBe(401);
    // Only the run's own job posts its plan: not a person, not another job, not for another run.
    for (const password of [
      PASSWORDS.admin,
      PASSWORDS.writer,
      PASSWORDS.otherJob,
      PASSWORDS.otherWorkspaceJob,
      PASSWORDS.unboundJob,
      PASSWORDS.service,
    ]) {
      expect((await post(password, document)).status, password).toBe(403);
    }
    // A plan larger than the route parses is refused before it is read.
    const huge = await fetch(server.planUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...basic(PASSWORDS.planJob) },
      body: new Uint8Array(MAX_PLAN_BYTES + 1),
    });
    expect(huge.status).toBe(413);
    expect(
      (await post(PASSWORDS.job, document, server.planUrl.replace(LIVE_RUN, "tf-run-2"))).status,
    ).toBe(403);
    expect((await post(PASSWORDS.job, "{not json")).status).toBe(400);
    // A parser's own message quotes its input, and a plan is full of secrets: ours says nothing.
    const unparsed = await post(PASSWORDS.job, `{"resource_changes": [{"after": ${SECRET}`);
    expect(unparsed.status).toBe(400);
    expect(await unparsed.text()).toBe('{"error":"The plan is not valid JSON."}');
    const badState = await call("POST", "", PASSWORDS.job, `{"version": 4, "outputs": ${SECRET}`);
    expect(badState.status).toBe(400);
    expect(await badState.text()).not.toContain(SECRET);
    expect((await post(PASSWORDS.job, JSON.stringify({ format_version: "9.0" }))).status).toBe(400);
    expect(server.plans).toEqual([]);

    // A plan's own token is `read`: it posts its plan all the same.
    expect((await post(PASSWORDS.planJob, document)).status).toBe(204);
    expect(server.plans).toHaveLength(1);
    const { summary, runId, ciRunId } = server.plans[0]!;
    expect({ runId, ciRunId }).toEqual({ runId: LIVE_RUN, ciRunId: LIVE_CI_RUN });
    expect(summary).toMatchObject({ add: 4, change: 0, destroy: 0, hasChanges: true });
    // What is stored of a plan names attributes and never carries a value.
    expect(JSON.stringify(summary)).not.toContain(SECRET);

    // Pricing's inputs wait beside the state, without anything marked sensitive.
    const key = planInputsKey(WORKSPACE_ID, LIVE_RUN);
    const waiting = new TextDecoder().decode(server.bucket.objects.get(key));
    expect(waiting).not.toContain(SECRET);
    expect(JSON.parse(waiting).changes).toHaveLength(4);
    expect(JSON.parse(waiting).changes[0]).toMatchObject({
      address: "terraform_data.app",
      action: "create",
      before: null,
      after: { input: "v1" },
    });
    // Read by the app, once: then it is gone.
    const get = (password: string) => fetch(server.planUrl, { headers: basic(password) });
    expect((await get(PASSWORDS.job)).status).toBe(403);
    expect((await get(PASSWORDS.admin)).status).toBe(403);
    expect((await get(PASSWORDS.unboundService)).status).toBe(403);
    const priced = await get(PASSWORDS.service);
    expect(priced.status).toBe(200);
    expect(((await priced.json()) as { changes: unknown[] }).changes).toHaveLength(4);
    expect(server.bucket.objects.has(key)).toBe(false);
    expect((await get(PASSWORDS.service)).status).toBe(404);

    // The apply applies exactly the plan it posted.
    await ok(["apply", "-no-color", "tfplan"]);
    expect((await server.store.head()).version?.resourceCount).toBe(3);
  });
});

describe("the workspace's state store", () => {
  const version = (serial: number): NewStateVersion => ({
    serial,
    lineage: "lineage-1",
    terraformVersion: "1.15.8",
    resourceCount: 0,
    size: 2,
    sha256: "0".repeat(64),
    createdAt: new Date(0).toISOString(),
    createdBy: "user:test",
  });
  const bytes = new TextEncoder().encode("{}");

  it("lets one of two writers that decided on the same head win, and keeps no orphan", async () => {
    const bucket = new MemoryBucket();
    const store = new WorkspaceStateStore({ bucket, storage: nodeStorage() }).open("ws-race");
    const expect0 = { versionId: null, lockId: null };
    // Both uploads are in flight before either commits: the gap a Durable Object leaves open.
    const [a, b] = await Promise.all([
      store.commit(version(1), bytes, expect0),
      store.commit(version(1), bytes, expect0),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const winner = a.ok ? a : b;
    if (!winner.ok) throw new Error("no winner");
    const loser = a.ok ? b : a;
    if (loser.ok) throw new Error("two winners");
    expect(loser.head.version?.id).toBe(winner.version.id);
    // The loser's object was deleted again: one version, one object.
    expect([...bucket.objects.keys()]).toEqual([
      `terraform/ws-race/1-${winner.version.id}.tfstate`,
    ]);
    expect(await store.versions({ limit: 10 })).toHaveLength(1);
  });

  it("gives the lock to one of two takers, and releases only the lock named", async () => {
    const store = new WorkspaceStateStore({
      bucket: new MemoryBucket(),
      storage: nodeStorage(),
    }).open("ws-lock");
    const lock = (id: string) => ({
      info: lockInfo(id),
      heldBy: `user:${id}`,
      lockedAt: new Date(0).toISOString(),
    });
    const [first, second] = await Promise.all([
      store.acquireLock(lock("one")),
      store.acquireLock(lock("two")),
    ]);
    expect(first).toBeNull();
    expect(second?.info.ID).toBe("one");
    expect((await store.releaseLock("two"))?.info.ID).toBe("one");
    // A write that decided on "unlocked" does not get past the lock taken since.
    expect((await store.commit(version(1), bytes, { versionId: null, lockId: null })).ok).toBe(
      false,
    );
    expect(await store.releaseLock("one")).toBeNull();
    expect(await store.releaseLock(null)).toBeNull();
  });

  it("is one workspace's, and forgets everything when destroyed", async () => {
    const bucket = new MemoryBucket();
    const store = new WorkspaceStateStore({ bucket, storage: nodeStorage() }).open("ws-a");
    await store.commit(version(1), bytes, { versionId: null, lockId: null });
    await bucket.put("terraform/ws-b/1-x.tfstate", bytes);
    expect(() => store.open("ws-b")).toThrow(/another workspace/);
    expect(() => store.open("../escape")).toThrow();
    expect(await store.destroy()).toEqual({ deletedFiles: 1 });
    // Another workspace's objects are not this one's to delete.
    expect([...bucket.objects.keys()]).toEqual(["terraform/ws-b/1-x.tfstate"]);
    expect((await store.open("ws-a").head()).version).toBeNull();
  });
});
