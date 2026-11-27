/**
 * Terraform scans against a real Postgres: what the Infrastructure tab reads
 * of a repository's files, who may read it, that a scanned tree is not read
 * again, and a branch page's cost change from configuration, including the
 * rule that a Terraform plan of the page's head wins over it.
 *
 * Estimates are written into the scan rows by hand here, the way the
 * gateway's pass writes them (server-core `git-terraform/config-cost.ts`).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  gitIssues,
  gitPullRequests,
  gitTerraformRuns,
  gitTerraformScans,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "../../db/client";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const PROD = (count: number) => `
terraform {
  backend "s3" {
    bucket     = "acme-state"
    key        = "prod.tfstate"
    region     = "us-east-1"
    access_key = "not-a-real-access-key"
  }
}

provider "aws" {
  region = "us-east-1"
}

module "net" {
  source = "../../modules/net"
}

resource "aws_instance" "web" {
  count         = ${count}
  instance_type = "t3.micro"
}
`;

const FILES: Record<string, string> = {
  "README.md": "# infra\n",
  "envs/prod/main.tf": PROD(2),
  "envs/prod/.terraform.lock.hcl": "# locks\n",
  "modules/net/main.tf": 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n',
  // No backend and no provider block, called by nobody: a root by what it declares.
  "tools/main.tf": 'resource "aws_s3_bucket" "logs" {\n  bucket = "acme-logs"\n}\n',
};

const estimate = (count: number) => ({
  currency: "USD",
  monthlyTotal: count * 7.59,
  complete: true,
  lines: [
    {
      address: "aws_instance.web",
      type: "aws_instance",
      count,
      monthly: count * 7.59,
      detail: `${count} × t3.micro, us-east-1, on demand, $7.59 each`,
    },
  ],
  unpriced: [],
  others: [{ type: "aws_vpc", count: 1, kind: "free" }],
});

describe.skipIf(!configured)("Terraform scans, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;
  let repo: string;
  let repositoryId: string;
  let mainOid: string;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    const organization = await world.organization("acme", {
      paid: true,
      members: [[alice, "owner"]],
    });
    const made = await world.repository(alice, organization.slug, "infra", "private");
    repo = made.path;
    repositoryId = made.id;
    await world.call("PUT", `${repo}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "read" },
    });
    const storage = world.storage.repository(repositoryId);
    for (const [path, text] of Object.entries(FILES)) storage.files.set(path, text);
    mainOid = storage.branches.get("main")!;
  });
  afterAll(() => world?.cleanup());

  it("lists the roots of the default branch with what each declares, estimate pending", async () => {
    const header = await world.call("GET", repo, { as: alice });
    expect(header.body.hasTerraform).toBe(false);

    const answer = await world.call("GET", `${repo}/terraform/scan`, { as: alice });
    expect(answer.status).toBe(200);
    expect(answer.body.commitOid).toBe(mainOid);
    expect(answer.body.roots.map((root: { path: string }) => root.path)).toEqual([
      "envs/prod",
      "tools",
    ]);
    const [prod, tools] = answer.body.roots;
    expect(prod).toMatchObject({
      reasons: ["backend"],
      workspaces: [],
      suggestedWorkspace: "envs-prod",
      backend: {
        type: "s3",
        settings: [
          { name: "bucket", value: "acme-state" },
          { name: "key", value: "prod.tfstate" },
          { name: "region", value: "us-east-1" },
        ],
      },
      localModules: ["modules/net"],
      resourceCount: 2,
      lockFile: true,
      estimate: { status: "pending", monthlyTotal: null, lines: [] },
    });
    expect(tools).toMatchObject({ reasons: ["unreferenced"], backend: null });
    expect(answer.body.moduleCount).toBe(1);
    // Never a credential, and never what pricing reads.
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain("not-a-real-access-key");
    expect(text).not.toContain("t3.micro");
    expect(text).not.toContain("pricingInputs");

    // Roots found: the Infrastructure tab shows, workspaces or not.
    expect((await world.call("GET", repo, { as: alice })).body.hasTerraform).toBe(true);
  });

  it("does not read a scanned tree again", async () => {
    const reads = world.storage.terraformReads.length;
    const again = await world.call("GET", `${repo}/terraform/scan?ref=main`, { as: carol });
    expect(again.status).toBe(200);
    expect(world.storage.terraformReads.length).toBe(reads);
    const rows = await db
      .select({ id: gitTerraformScans.id })
      .from(gitTerraformScans)
      .where(eq(gitTerraformScans.repositoryId, repositoryId));
    expect(rows).toHaveLength(1);
  });

  it("answers a stranger 404, exactly as a repository that is not there", async () => {
    const hidden = await world.call("GET", `${repo}/terraform/scan`, { as: bob });
    const missing = await world.call(
      "GET",
      `${repo.replace(/\/infra$/, "/nothing")}/terraform/scan`,
      { as: bob },
    );
    expect(hidden.status).toBe(404);
    expect(missing).toEqual(hidden);
    expect((await world.call("GET", `${repo}/terraform/scan`)).status).toBe(404);
    const change = await world.call("GET", `${repo}/terraform/configuration-change?page=x`, {
      as: bob,
    });
    expect(change).toEqual(hidden);
  });

  it("prices a branch page's change from configuration, and lets a plan of its head win", async () => {
    const storage = world.storage.repository(repositoryId);
    const headOid = world.storage.nextOid();
    storage.filesAt.set(
      headOid,
      new Map([...storage.files, ["envs/prod/main.tf", PROD(4)]] as [string, string][]),
    );
    storage.branches.set("bigger", headOid);
    const page = (
      await world.call("POST", `${repo}/branch-pages`, {
        as: alice,
        body: { title: "More web servers", base: "main", head: "bigger" },
      })
    ).body;
    const path = `${repo}/terraform/configuration-change?page=${encodeURIComponent(page.key)}`;

    // Both sides scanned, neither priced yet: only the root the change reaches.
    const pending = await world.call("GET", path, { as: carol });
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({
      baseOid: mainOid,
      headOid,
      roots: [{ path: "envs/prod", workspace: null, status: "pending", monthlyDelta: null }],
    });

    // The pass prices both rows.
    const rows = await db
      .select()
      .from(gitTerraformScans)
      .where(eq(gitTerraformScans.repositoryId, repositoryId));
    for (const row of rows) {
      const count = row.commitOid === headOid ? 4 : 2;
      await db
        .update(gitTerraformScans)
        .set({
          estimates: { "envs/prod": estimate(count), tools: estimate(0) },
          pricingStatus: "priced",
          pricedAt: new Date(),
        })
        .where(eq(gitTerraformScans.id, row.id));
    }
    const priced = await world.call("GET", path, { as: carol });
    expect(priced.body.roots).toEqual([
      {
        path: "envs/prod",
        workspace: null,
        status: "priced",
        currency: "USD",
        monthlyBefore: 15.18,
        monthlyAfter: 30.36,
        monthlyDelta: 15.18,
        complete: true,
        lines: [
          {
            address: "aws_instance.web",
            type: "aws_instance",
            monthlyBefore: 15.18,
            monthlyAfter: 30.36,
            monthlyDelta: 15.18,
          },
        ],
        unpriced: [],
      },
    ]);
    const scanned = await world.call("GET", `${repo}/terraform/scan`, { as: alice });
    expect(scanned.body.roots[0].estimate).toMatchObject({
      status: "priced",
      monthlyTotal: 15.18,
      lines: [{ address: "aws_instance.web", count: 2 }],
    });

    // A workspace on the root: named, and still shown while it has no plan of the head.
    const created = await world.call("POST", `${repo}/terraform/workspaces`, {
      as: alice,
      body: { name: "prod", rootPath: "envs/prod" },
    });
    expect(created.status).toBe(200);
    const named = await world.call("GET", path, { as: carol });
    expect(named.body.roots).toMatchObject([{ path: "envs/prod", workspace: "prod" }]);

    // A plan of an older head does not win.
    const [found] = await db
      .select({ number: gitIssues.number })
      .from(gitPullRequests)
      .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
      .where(
        and(eq(gitPullRequests.repositoryId, repositoryId), eq(gitPullRequests.headRef, "bigger")),
      );
    const run = {
      workspaceId: created.body.id as string,
      repositoryId,
      kind: "plan" as const,
      trigger: "pull-request" as const,
      branch: "bigger",
      pullNumber: found!.number,
      status: "planned" as const,
      planSummary: { add: 2, change: 0, destroy: 0, hasChanges: true },
    };
    await db.insert(gitTerraformRuns).values({ ...run, id: newId(), commitSha: mainOid });
    expect((await world.call("GET", path, { as: carol })).body.roots).toHaveLength(1);

    // A plan of the page's head does: one number per root, the plan's.
    await db.insert(gitTerraformRuns).values({ ...run, id: newId(), commitSha: headOid });
    expect((await world.call("GET", path, { as: carol })).body.roots).toEqual([]);
    const left = await db
      .select({ id: gitTerraformRuns.id })
      .from(gitTerraformRuns)
      .where(
        and(eq(gitTerraformRuns.repositoryId, repositoryId), eq(gitTerraformRuns.kind, "plan")),
      );
    expect(left).toHaveLength(2);
  });
});
