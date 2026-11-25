import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_PLAN_ATTRIBUTES,
  MAX_PLAN_RESOURCES,
  PlanFormatError,
  describeReason,
  foldActions,
  planLine,
  summarizePlan,
} from "../src/index.js";

/** `fixtures/` is written by `fixtures/generate.sh` with the real binary. */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

describe("summarizePlan, on a real plan", () => {
  const summary = summarizePlan(fixture("plan.json"));
  const byAddress = new Map(summary.resources.map((change) => [change.address, change]));

  it("counts what Terraform counted", () => {
    const text = readFileSync(
      fileURLToPath(new URL("./fixtures/plan.txt", import.meta.url)),
      "utf8",
    );
    expect(text).toContain("Plan: 2 to add, 1 to change, 2 to destroy.");
    expect(planLine(summary)).toBe("Plan: 2 to add, 1 to change, 2 to destroy.");
    expect(summary.counts).toEqual({
      create: 1,
      update: 1,
      delete: 1,
      replace: 1,
      forget: 0,
      move: 1,
      import: 0,
    });
    expect(summary).toMatchObject({ hasChanges: true, applyable: true, errored: false });
    expect(summary.formatVersion).toMatch(/^1\./);
  });

  it("lists every change and leaves out what stays as it is", () => {
    expect([...byAddress.keys()]).toEqual([
      "terraform_data.added",
      "terraform_data.bump",
      "terraform_data.gone[0]",
      "terraform_data.renamed_new",
      "terraform_data.replaced",
    ]);
    expect(byAddress.get("terraform_data.added")).toMatchObject({
      action: "create",
      type: "terraform_data",
      name: "added",
      provider: "terraform.io/builtin/terraform",
      attributes: [],
    });
  });

  it("names the attributes an update changes, and which are only known after apply", () => {
    expect(byAddress.get("terraform_data.bump")).toMatchObject({
      action: "update",
      attributes: [
        { name: "input", unknown: false, sensitive: false },
        { name: "output", unknown: true, sensitive: false },
      ],
    });
  });

  it("says why something is replaced or deleted", () => {
    const replaced = byAddress.get("terraform_data.replaced");
    expect(replaced).toMatchObject({
      action: "replace",
      createBeforeDestroy: false,
      reason: "replace_because_cannot_update",
      replacePaths: ["triggers_replace"],
    });
    expect(replaced?.attributes.map((attribute) => attribute.name)).toEqual([
      "id",
      "output",
      "triggers_replace",
    ]);
    const gone = byAddress.get("terraform_data.gone[0]");
    expect(gone).toMatchObject({ action: "delete", reason: "delete_because_count_index" });
    expect(describeReason(gone!.reason)).toBe("its index is out of range for count");
    expect(describeReason("something_new")).toBeNull();
  });

  it("reports a move that changes nothing else", () => {
    expect(byAddress.get("terraform_data.renamed_new")).toMatchObject({
      action: "no-op",
      movedFrom: "terraform_data.renamed_old",
    });
  });

  it("lists output changes without their values", () => {
    expect(summary.outputs).toEqual([
      { name: "added_id", action: "create", sensitive: false },
      { name: "release", action: "update", sensitive: false },
      { name: "secret", action: "update", sensitive: true },
    ]);
  });

  it("carries no value from the plan, sensitive or not", () => {
    // The plan document has the sensitive output in the clear.
    expect(JSON.stringify(fixture("plan.json"))).toContain("hunter2-v2");
    const text = JSON.stringify(summary);
    for (const value of ["hunter2", "removed in v2", "payload", "stays the same"]) {
      expect(text).not.toContain(value);
    }
  });
});

describe("summarizePlan, on a real plan with nothing to do", () => {
  it("has no changes", () => {
    const summary = summarizePlan(fixture("plan-noop.json"));
    expect(summary).toMatchObject({ add: 0, change: 0, destroy: 0, hasChanges: false });
    expect(summary.resources).toEqual([]);
    expect(summary.outputs).toEqual([]);
    expect(planLine(summary)).toBe("No changes.");
  });
});

/** The pieces of the format the built-in resource cannot produce, written as the JSON output format documents them. */
describe("summarizePlan, on the rest of the format", () => {
  const change = (address: string, actions: string[], extra: Record<string, unknown> = {}) => ({
    address,
    mode: "managed",
    type: address.split(".").at(-2),
    name: address.split(".").at(-1),
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions, before: null, after: null, ...extra },
  });

  it("reads drift, imports, create-before-destroy and forget", () => {
    const summary = summarizePlan({
      format_version: "1.2",
      terraform_version: "1.9.8",
      resource_changes: [
        change("aws_instance.web", ["create", "delete"], {
          before: { ami: "ami-1", tags: { Name: "web" } },
          after: { ami: "ami-2", tags: { Name: "web" } },
          after_unknown: { id: true },
          replace_paths: [["ami"], ["ebs_block_device", 0, "size"], ["tags", "a b"]],
        }),
        change("aws_s3_bucket.logs", ["no-op"], { importing: { id: "logs-bucket" } }),
        change("aws_iam_user.legacy", ["forget"]),
        change("aws_db_instance.main", ["update"], {
          before: { password: "old", engine: "postgres" },
          after: { password: "new", engine: "postgres" },
          before_sensitive: { password: true },
          after_sensitive: { password: true },
        }),
        { ...change("aws_ami.ubuntu", ["read"]), mode: "data" },
      ],
      resource_drift: [
        change("aws_security_group.web", ["update"], {
          before: { ingress: [{ port: 22 }], name: "web" },
          after: { ingress: [{ port: 22 }, { port: 3389 }], name: "web" },
        }),
        change("aws_instance.gone", ["delete"]),
      ],
      output_changes: { url: { actions: ["no-op"] } },
    });

    expect(summary.counts).toMatchObject({ replace: 1, forget: 1, update: 1, import: 1 });
    expect(summary.resources.map((r) => [r.address, r.action])).toEqual([
      ["aws_instance.web", "replace"],
      ["aws_s3_bucket.logs", "no-op"],
      ["aws_iam_user.legacy", "forget"],
      ["aws_db_instance.main", "update"],
    ]);
    expect(summary.resources[0]).toMatchObject({
      createBeforeDestroy: true,
      replacePaths: ["ami", "ebs_block_device[0].size", 'tags["a b"]'],
      attributes: [
        { name: "ami", unknown: false },
        { name: "id", unknown: true },
      ],
    });
    expect(summary.resources[1]?.imported).toBe(true);
    expect(summary.resources[3]?.attributes).toEqual([
      { name: "password", unknown: false, sensitive: true },
    ]);
    expect(summary.drift.map((r) => [r.address, r.action])).toEqual([
      ["aws_security_group.web", "update"],
      ["aws_instance.gone", "delete"],
    ]);
    expect(summary.drift[0]?.attributes.map((a) => a.name)).toEqual(["ingress"]);
    expect(summary.outputs).toEqual([]);
    expect(JSON.stringify(summary)).not.toMatch(/"(old|new|logs-bucket)"/);
  });

  it("folds action lists, and never reads an unknown one as nothing", () => {
    expect(foldActions(["delete", "create"])).toEqual({
      action: "replace",
      createBeforeDestroy: false,
    });
    expect(foldActions(["create", "delete"])).toEqual({
      action: "replace",
      createBeforeDestroy: true,
    });
    expect(foldActions(["no-op"]).action).toBe("no-op");
    expect(foldActions(["teleport"]).action).toBe("update");
  });

  it("says a plan that errored cannot be applied", () => {
    const summary = summarizePlan({ format_version: "1.2", resource_changes: [], errored: true });
    expect(summary).toMatchObject({ errored: true, applyable: false });
    expect(summarizePlan({ format_version: "1.0", resource_changes: [] }).applyable).toBe(true);
  });

  it("refuses what is not a plan", () => {
    expect(() => summarizePlan([])).toThrow(PlanFormatError);
    expect(() => summarizePlan({ version: 4, serial: 1 })).toThrow(/format_version/);
    expect(() => summarizePlan({ format_version: "2.0", resource_changes: [] })).toThrow(
      /not supported/,
    );
    // `terraform show -json` without a plan file prints the state.
    expect(() => summarizePlan({ format_version: "1.0", values: {} })).toThrow(/state, not a plan/);
  });

  it("caps what an oversized plan can make it keep, and still counts it", () => {
    const many = Array.from({ length: MAX_PLAN_RESOURCES + 25 }, (_, i) =>
      change(`aws_instance.n${i}`, ["create"]),
    );
    const wide = Object.fromEntries(
      Array.from({ length: MAX_PLAN_ATTRIBUTES + 10 }, (_, i) => [
        `a${String(i).padStart(3, "0")}`,
        i,
      ]),
    );
    const nest = () => {
      let value: unknown = "leaf";
      for (let i = 0; i < 5000; i++) value = [value];
      return value;
    };
    const summary = summarizePlan({
      format_version: "1.2",
      resource_changes: [
        change("aws_instance.wide", ["update"], { before: {}, after: wide }),
        change("aws_instance.deep", ["update"], { before: { x: nest() }, after: { x: nest() } }),
        change(`aws_instance.${"x".repeat(5000)}`, ["delete"]),
        ...many,
      ],
    });
    expect(summary.resources).toHaveLength(MAX_PLAN_RESOURCES);
    expect(summary.resourcesOmitted).toBe(28);
    expect(summary.add).toBe(MAX_PLAN_RESOURCES + 25);
    expect(summary.resources[0]).toMatchObject({ attributesOmitted: 10 });
    expect(summary.resources[0]?.attributes).toHaveLength(MAX_PLAN_ATTRIBUTES);
    // Too deep to compare: reported as changed rather than overflowing the stack.
    expect(summary.resources[1]?.attributes).toEqual([
      { name: "x", unknown: false, sensitive: false },
    ]);
    expect(summary.resources[2]!.address.length).toBeLessThanOrEqual(512);
  });
});
