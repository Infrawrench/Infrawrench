import { describe, it, expect } from "vitest";
import type { Plugin, PluginClient, PreflightDeclaration } from "@infrawrench/plugin-base";
import {
  buildPreflightChecklist,
  defaultTemplateCapabilityIds,
  runAccountPreflight,
  summarizePreflight,
  type PreflightReport,
} from "../preflight";

const declaration: PreflightDeclaration = {
  capabilities: [
    {
      id: "resources",
      label: "Resource inventory",
      requiredPermissions: [
        { id: "ec2:DescribeInstances", label: "List EC2 instances" },
        { id: "s3:ListAllMyBuckets", label: "List S3 buckets" },
      ],
      essential: true,
    },
    {
      id: "costs",
      label: "Cost reporting",
      requiredPermissions: [{ id: "ce:GetCostAndUsage", label: "Read cost data" }],
    },
  ],
  templateFormat: { label: "AWS IAM policy (JSON)", language: "json" },
};

function report(over: Partial<PreflightReport> = {}): PreflightReport {
  return {
    pluginId: "aws",
    supported: true,
    identity: "arn:aws:iam::1:user/x",
    checks: [],
    ...over,
  };
}

describe("buildPreflightChecklist", () => {
  it("renders every declared capability as unchecked when there is no report", () => {
    const rows = buildPreflightChecklist(declaration, null);
    expect(rows.map((r) => r.status)).toEqual(["unchecked", "unchecked"]);
    expect(rows.map((r) => r.capability.id)).toEqual(["resources", "costs"]);
  });

  it("merges probe results onto declarations in declaration order", () => {
    const rows = buildPreflightChecklist(
      declaration,
      report({
        checks: [
          {
            capabilityId: "costs",
            status: "missing",
            missingPermissions: [{ id: "ce:GetCostAndUsage", label: "Read cost data" }],
            message: null,
            helpLink: { label: "IAM", url: "https://example.com" },
          },
          {
            capabilityId: "resources",
            status: "ok",
            missingPermissions: [],
            message: null,
            helpLink: null,
          },
        ],
      }),
    );
    expect(rows[0]).toMatchObject({ status: "ok", capability: { id: "resources" } });
    expect(rows[1]).toMatchObject({
      status: "missing",
      missingPermissions: [{ id: "ce:GetCostAndUsage" }],
      helpLink: { url: "https://example.com" },
    });
  });

  it("falls back to the declared permission list when the probe couldn't name the missing ones", () => {
    const rows = buildPreflightChecklist(
      declaration,
      report({
        checks: [
          {
            capabilityId: "resources",
            status: "missing",
            missingPermissions: [],
            message: "keys rejected",
            helpLink: null,
          },
        ],
      }),
    );
    expect(rows[0]!.missingPermissions.map((p) => p.id)).toEqual([
      "ec2:DescribeInstances",
      "s3:ListAllMyBuckets",
    ]);
    // Capability absent from the report stays unchecked.
    expect(rows[1]!.status).toBe("unchecked");
  });

  it("drops checks for capabilities the plugin no longer declares", () => {
    const rows = buildPreflightChecklist(
      declaration,
      report({
        checks: [
          {
            capabilityId: "ghost",
            status: "ok",
            missingPermissions: [],
            message: null,
            helpLink: null,
          },
        ],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "unchecked")).toBe(true);
  });
});

describe("summarizePreflight", () => {
  it("counts statuses and flags essential misses", () => {
    const rows = buildPreflightChecklist(
      declaration,
      report({
        checks: [
          {
            capabilityId: "resources",
            status: "missing",
            missingPermissions: [],
            message: null,
            helpLink: null,
          },
          {
            capabilityId: "costs",
            status: "ok",
            missingPermissions: [],
            message: null,
            helpLink: null,
          },
        ],
      }),
    );
    expect(summarizePreflight(rows)).toEqual({
      total: 2,
      ok: 1,
      missing: 1,
      unknown: 0,
      essentialMissing: true,
    });
  });

  it("treats unchecked rows as unknown in the summary", () => {
    const rows = buildPreflightChecklist(declaration, null);
    expect(summarizePreflight(rows)).toMatchObject({ ok: 0, missing: 0, unknown: 2 });
  });
});

describe("defaultTemplateCapabilityIds", () => {
  it("starts with everything declared", () => {
    expect(defaultTemplateCapabilityIds(declaration)).toEqual(["resources", "costs"]);
  });
});

function fakePlugin(preflight: PreflightDeclaration | null = declaration): Plugin {
  return {
    manifest: {
      id: "fake",
      version: "0.1.0",
      displayName: "Fake",
      logoSvg: "<svg/>",
      author: "t",
      minHostVersion: "0.1.0",
      credentialFields: [],
      ...(preflight ? { preflight } : {}),
    },
    resourceTypes: [],
    createClient: () => ({}) as PluginClient,
  };
}

function clientWith(verify: PluginClient["verifyCredentials"]): PluginClient {
  return { verifyCredentials: verify } as unknown as PluginClient;
}

describe("runAccountPreflight", () => {
  it("reports unsupported for plugins without a preflight declaration", async () => {
    const result = await runAccountPreflight(fakePlugin(null), clientWith(undefined));
    expect(result).toEqual({ pluginId: "fake", supported: false, identity: null, checks: [] });
  });

  it("reports every capability unknown when the client has no probe", async () => {
    const result = await runAccountPreflight(fakePlugin(), clientWith(undefined));
    expect(result.supported).toBe(true);
    expect(result.checks.map((c) => c.status)).toEqual(["unknown", "unknown"]);
  });

  it("normalizes a successful probe, filling capabilities the probe skipped", async () => {
    const result = await runAccountPreflight(
      fakePlugin(),
      clientWith(async () => ({
        identity: "someone@example.com",
        checks: [{ capabilityId: "resources", status: "ok" as const }],
      })),
    );
    expect(result.identity).toBe("someone@example.com");
    expect(result.checks[0]).toMatchObject({ capabilityId: "resources", status: "ok" });
    expect(result.checks[1]).toMatchObject({ capabilityId: "costs", status: "unknown" });
  });

  it("turns a thrown probe into unknown checks instead of propagating", async () => {
    const result = await runAccountPreflight(
      fakePlugin(),
      clientWith(async () => {
        throw new Error("network down");
      }),
    );
    expect(result.checks.map((c) => c.status)).toEqual(["unknown", "unknown"]);
    expect(result.checks[0]!.message).toBe("network down");
  });

  it("strips unsafe help links and clamps long messages", async () => {
    const result = await runAccountPreflight(
      fakePlugin(),
      clientWith(async () => ({
        checks: [
          {
            capabilityId: "resources",
            status: "missing" as const,
            missingPermissions: [{ id: "x", label: "X" }],
            message: "m".repeat(1000),
            helpLink: { label: "evil", url: "javascript:alert(1)" },
          },
        ],
      })),
    );
    const check = result.checks[0]!;
    expect(check.helpLink).toBeNull();
    expect(check.message!.length).toBeLessThanOrEqual(600);
  });

  it("ignores duplicate and undeclared capability ids from the probe", async () => {
    const result = await runAccountPreflight(
      fakePlugin(),
      clientWith(async () => ({
        checks: [
          { capabilityId: "resources", status: "ok" as const },
          {
            capabilityId: "resources",
            status: "missing" as const,
            missingPermissions: [],
          },
          { capabilityId: "not-declared", status: "ok" as const },
        ],
      })),
    );
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]).toMatchObject({ capabilityId: "resources", status: "ok" });
  });
});
