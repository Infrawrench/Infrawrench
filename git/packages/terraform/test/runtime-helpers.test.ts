import { describe, expect, it } from "vitest";

import {
  MAX_PRICING_CHANGES,
  pinnedRelease,
  pinnedVersions,
  planPricingInputs,
  rootsTouchedBy,
  workspacePipelineYaml,
  type TerraformDirectory,
} from "../src/index.js";

// Obviously fake, and in no real secret format.
const SECRET = "not-a-real-admin-password";

const change = (over: Record<string, unknown>) => ({
  address: "cloud_server.web",
  mode: "managed",
  type: "cloud_server",
  name: "web",
  ...over,
});

describe("planPricingInputs", () => {
  it("keeps plain scalar attributes and nothing the plan marks sensitive", () => {
    const { changes, omitted } = planPricingInputs({
      format_version: "1.2",
      resource_changes: [
        change({
          change: {
            actions: ["create"],
            before: null,
            after: {
              size: "small",
              count: 3,
              backups: true,
              admin_password: SECRET,
              tags: { team: "infra" },
              user_data: "x".repeat(300),
              network: [{ token: SECRET }],
            },
            before_sensitive: false,
            // A flag, and a structure with a flag somewhere inside: both are left out.
            after_sensitive: { admin_password: true, network: [{ token: true }] },
          },
        }),
      ],
    });
    expect(omitted).toBe(0);
    expect(changes).toEqual([
      {
        address: "cloud_server.web",
        type: "cloud_server",
        action: "create",
        before: null,
        after: { size: "small", count: 3, backups: true },
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain(SECRET);
  });

  it("reads both sides of an update and a replace, and one side of a delete", () => {
    const { changes } = planPricingInputs({
      resource_changes: [
        change({
          address: "a",
          change: { actions: ["update"], before: { size: "small" }, after: { size: "large" } },
        }),
        change({
          address: "b",
          change: {
            actions: ["delete", "create"],
            before: { size: "small", secret: SECRET },
            after: { size: "small" },
            before_sensitive: { secret: true },
          },
        }),
        change({
          address: "c",
          change: { actions: ["delete"], before: { size: "large" }, after: null },
        }),
      ],
    });
    expect(changes.map((c) => [c.address, c.action, c.before, c.after])).toEqual([
      ["a", "update", { size: "small" }, { size: "large" }],
      ["b", "replace", { size: "small" }, { size: "small" }],
      ["c", "delete", { size: "large" }, null],
    ]);
  });

  it("leaves out what changes nothing, data sources, and whatever is past the limit", () => {
    const many = Array.from({ length: MAX_PRICING_CHANGES + 5 }, (_, i) =>
      change({ address: `cloud_server.s[${i}]`, change: { actions: ["create"], after: {} } }),
    );
    const { changes, omitted } = planPricingInputs({
      resource_changes: [
        change({ address: "noop", change: { actions: ["no-op"], before: {}, after: {} } }),
        change({ address: "data.x", mode: "data", change: { actions: ["read"], after: {} } }),
        change({ address: "forgotten", change: { actions: ["forget"], before: {} } }),
        ...many,
      ],
    });
    expect(changes).toHaveLength(MAX_PRICING_CHANGES);
    expect(omitted).toBe(5);
    expect(changes.some((c) => ["noop", "data.x", "forgotten"].includes(c.address))).toBe(false);
  });

  it("never throws for a document it cannot read", () => {
    for (const document of [
      null,
      "plan",
      7,
      {},
      { resource_changes: "many" },
      { resource_changes: [null, 1, {}] },
    ]) {
      expect(planPricingInputs(document)).toEqual({ changes: [], omitted: 0 });
    }
  });
});

describe("rootsTouchedBy", () => {
  const directory = (path: string, calls: string[] = []): TerraformDirectory =>
    ({
      path,
      kind: "root",
      moduleCalls: calls.map((localPath) => ({ name: localPath, source: localPath, localPath })),
    }) as unknown as TerraformDirectory;
  const directories = [
    directory("infra/prod", ["modules/network"]),
    directory("infra/staging", ["modules/network", "modules/cache"]),
    directory("modules/network", ["modules/network/subnets"]),
    directory("modules/network/subnets"),
    directory("modules/cache"),
    directory("infra/prod/legacy"),
  ];
  const roots = ["infra/prod", "infra/staging"];
  const touched = (...changed: string[]) => [...rootsTouchedBy(roots, changed, directories)].sort();

  it("plans the workspace whose root changed", () => {
    expect(touched("infra/prod/main.tf")).toEqual(["infra/prod"]);
    expect(touched("infra/prod/templates/user-data.sh")).toEqual(["infra/prod"]);
    expect(touched("README.md", "docs/a.md")).toEqual([]);
  });

  it("follows local modules, however many calls away", () => {
    expect(touched("modules/network/main.tf")).toEqual(["infra/prod", "infra/staging"]);
    expect(touched("modules/network/subnets/main.tf")).toEqual(["infra/prod", "infra/staging"]);
    expect(touched("modules/cache/variables.tf")).toEqual(["infra/staging"]);
  });

  it("does not plan a root for another Terraform directory beneath it that it never calls", () => {
    expect(touched("infra/prod/legacy/main.tf")).toEqual([]);
  });

  it("plans a root it knows nothing about, and the repository's top for any file", () => {
    expect([...rootsTouchedBy(["gone"], ["README.md"], directories)]).toEqual(["gone"]);
    expect([...rootsTouchedBy([""], ["anything.tf"], [directory("")])]).toEqual([""]);
    expect([
      ...rootsTouchedBy([""], ["infra/prod/main.tf"], [directory(""), directory("infra/prod")]),
    ]).toEqual([]);
  });
});

describe("pinned releases", () => {
  it("answers the default for no version, the exact version, and nothing else", () => {
    expect(pinnedRelease("terraform", null)?.version).toBe(pinnedVersions("terraform")[0]);
    expect(pinnedRelease("terraform", " ")?.version).toBe(pinnedVersions("terraform")[0]);
    expect(pinnedRelease("terraform", "1.17.2")?.version).toBe("1.17.2");
    expect(pinnedRelease("terraform", "v1.17.2")?.version).toBe("1.17.2");
    expect(pinnedRelease("terraform", "~> 1.17")).toBeNull();
    expect(pinnedRelease("terraform", "0.11.0")).toBeNull();
    expect(pinnedRelease("opentofu", null)?.product).toBe("opentofu");
  });

  it("pins every release for both architectures, in a form the pipeline accepts", () => {
    for (const product of ["terraform", "opentofu"] as const) {
      for (const version of pinnedVersions(product)) {
        const release = pinnedRelease(product, version)!;
        expect(release.sha256.amd64).toMatch(/^[0-9a-f]{64}$/);
        expect(release.sha256.arm64).toMatch(/^[0-9a-f]{64}$/);
        expect(() =>
          workspacePipelineYaml({
            kind: "plan",
            workspace: { name: "prod", rootPath: "" },
            stateUrl: "https://git.infrawrench.com/acme/infra/terraform/prod/state",
            planUrl: "https://git.infrawrench.com/acme/infra/terraform/prod/runs/1/plan",
            release,
            defaultBranch: "main",
          }),
        ).not.toThrow();
      }
    }
  });
});
