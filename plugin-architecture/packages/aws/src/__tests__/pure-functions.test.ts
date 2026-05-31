import { describe, it, expect } from "vitest";
import { parseXml, ensureArray } from "../xml.js";
import { ec2SshUsernameFromImageName, ec2SshUsername } from "../ssh-username.js";
import { getCreateCostEstimate } from "../cost-estimate.js";
import { instanceTypeArch, isImageFamily, FAMILY_SSH_USERNAME } from "../ami-lookup.js";
import { policiesToOptions } from "../iam-policies.js";
import { decodeIndexesField, buildDynamoSchemaTab } from "../dynamodb-detail.js";
import { renderDetail, renderSidebarItem } from "../render-resource.js";
import { fetchDashboardStats } from "../dashboard-metrics.js";
import type { ResourceInstance } from "@infrawrench/plugin-base";

function makeResource(partial: Partial<ResourceInstance>): ResourceInstance {
  return {
    id: "acct:type:ext",
    pluginId: "aws",
    resourceTypeId: "ec2-instance",
    accountId: "acct",
    displayName: "demo",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: "ext",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
    ...partial,
  };
}

describe("xml.parseXml", () => {
  it("unwraps a single root element", () => {
    const out = parseXml("<Root><foo>bar</foo></Root>");
    expect(out).toEqual({ foo: "bar" });
  });

  it("collapses repeated item/member tags into arrays", () => {
    const out = parseXml("<Root><Things><item>a</item><item>b</item></Things></Root>");
    expect(out["Things"]).toEqual({ item: ["a", "b"] });
  });

  it("ignores the xml declaration", () => {
    const out = parseXml('<?xml version="1.0"?><Root><x>1</x></Root>');
    expect(out).toEqual({ x: "1" });
  });

  it("returns parsed object when there is no single root", () => {
    // Two top-level elements => keys.length !== 1 path
    const out = parseXml("<a>1</a><b>2</b>");
    expect(out).toHaveProperty("a");
    expect(out).toHaveProperty("b");
  });

  it("returns parsed object when inner is not an object", () => {
    const out = parseXml("<Root>plain</Root>");
    expect(out).toEqual({ Root: "plain" });
  });
});

describe("xml.ensureArray", () => {
  it("wraps a scalar", () => {
    expect(ensureArray("x")).toEqual(["x"]);
  });
  it("returns arrays as-is", () => {
    expect(ensureArray([1, 2])).toEqual([1, 2]);
  });
  it("returns empty for null/undefined", () => {
    expect(ensureArray(null)).toEqual([]);
    expect(ensureArray(undefined)).toEqual([]);
  });
});

describe("ssh-username", () => {
  it.each([
    ["amzn2-ami-hvm", "ec2-user"],
    ["al2023-ami-2023", "ec2-user"],
    ["amazon-eks-node-1.29", "ec2-user"],
    ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04", "ubuntu"],
    ["debian-12-amd64", "admin"],
    ["RHEL-9.4.0_HVM", "ec2-user"],
    ["suse-sles-15-sp6", "ec2-user"],
    ["Rocky-9-EC2", "rocky"],
    ["AlmaLinux OS 9.4", "ec2-user"],
    ["Fedora-Cloud-Base-40", "fedora"],
    ["CentOS Stream 9", "centos"],
  ])("maps %s -> %s", (name, expected) => {
    expect(ec2SshUsernameFromImageName(name)).toBe(expected);
  });

  it("returns empty for unknown/windows/empty", () => {
    expect(ec2SshUsernameFromImageName("")).toBe("");
    expect(ec2SshUsernameFromImageName("Windows_Server-2022")).toBe("");
    expect(ec2SshUsernameFromImageName("bottlerocket-aws-k8s")).toBe("");
  });

  it("ec2SshUsername always empty (id-only fallback)", () => {
    expect(ec2SshUsername("ami-123")).toBe("");
  });
});

describe("cost-estimate", () => {
  it("estimates ec2 with disk", () => {
    const v = getCreateCostEstimate("ec2-instance", { instanceType: "t3.micro", diskSizeGb: "20" });
    // base 7.59 + 20*0.08 = 9.19
    expect(v).toBeCloseTo(9.19, 2);
  });
  it("ec2 defaults disk to 20 when missing", () => {
    const v = getCreateCostEstimate("ec2-instance", { instanceType: "t3.nano" });
    expect(v).toBeCloseTo(3.8 + 20 * 0.08, 2);
  });
  it("ec2 unknown type -> null", () => {
    expect(getCreateCostEstimate("ec2-instance", { instanceType: "zz.huge" })).toBeNull();
  });
  it("ec2 non-finite disk treated as 0", () => {
    const v = getCreateCostEstimate("ec2-instance", {
      instanceType: "t3.nano",
      diskSizeGb: "abc",
    });
    expect(v).toBeCloseTo(3.8, 2);
  });
  it("ebs gp3 and unknown-volume-type fallback", () => {
    expect(getCreateCostEstimate("ebs-volume", { sizeGb: "100", volumeType: "gp3" })).toBeCloseTo(
      8,
      2,
    );
    expect(getCreateCostEstimate("ebs-volume", { sizeGb: "100", volumeType: "weird" })).toBeCloseTo(
      8,
      2,
    );
  });
  it("ebs invalid size -> null", () => {
    expect(getCreateCostEstimate("ebs-volume", { sizeGb: "0" })).toBeNull();
    expect(getCreateCostEstimate("ebs-volume", { sizeGb: "-5" })).toBeNull();
  });
  it("rds estimate and unknown class", () => {
    const v = getCreateCostEstimate("rds-instance", {
      instanceClass: "db.t3.micro",
      allocatedStorage: "20",
    });
    expect(v).toBeCloseTo(12.41 + 20 * 0.115, 2);
    expect(getCreateCostEstimate("rds-instance", { instanceClass: "db.unknown" })).toBeNull();
  });
  it("unknown type -> null", () => {
    expect(getCreateCostEstimate("s3-bucket", {})).toBeNull();
  });
});

describe("ami-lookup pure helpers", () => {
  it.each([
    ["a1.large", "arm64"],
    ["t4g.small", "arm64"],
    ["m6gd.large", "arm64"],
    ["c7gn.xlarge", "arm64"],
    ["t3.micro", "x86_64"],
    ["m6i.large", "x86_64"],
    ["", "x86_64"],
  ])("instanceTypeArch %s", (t, arch) => {
    expect(instanceTypeArch(t)).toBe(arch);
  });

  it("isImageFamily", () => {
    expect(isImageFamily("al2023")).toBe(true);
    expect(isImageFamily("not-a-family")).toBe(false);
  });

  it("FAMILY_SSH_USERNAME map", () => {
    expect(FAMILY_SSH_USERNAME["ubuntu-2204"]).toBe("ubuntu");
    expect(FAMILY_SSH_USERNAME["debian-12"]).toBe("admin");
  });
});

describe("iam-policies.policiesToOptions", () => {
  it("maps, filters arn-less, and sorts by label", () => {
    const opts = policiesToOptions(
      [
        { Arn: "arn:b", PolicyName: "Beta", Description: "d2" },
        { Arn: "arn:a", PolicyName: "Alpha" },
        { PolicyName: "NoArn" },
      ],
      "managed",
    );
    expect(opts.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
    expect(opts[0]).toMatchObject({ id: "arn:a", label: "Alpha", category: "managed" });
    expect(opts[1]?.description).toBe("d2");
  });
  it("falls back to arn for missing name", () => {
    const opts = policiesToOptions([{ Arn: "arn:x" }], "c");
    expect(opts[0]?.label).toBe("arn:x");
  });
});

describe("dynamodb-detail.decodeIndexesField", () => {
  it("returns empty payload for non-string", () => {
    const p = decodeIndexesField(undefined);
    expect(p.keySchema).toEqual([]);
    expect(p.globalSecondaryIndexes).toEqual([]);
  });
  it("returns empty for empty string", () => {
    expect(decodeIndexesField("").attributeDefinitions).toEqual([]);
  });
  it("returns empty for invalid json", () => {
    expect(decodeIndexesField("{not json").keySchema).toEqual([]);
  });
  it("parses valid payload and defaults missing fields", () => {
    const p = decodeIndexesField(JSON.stringify({ keySchema: [{ AttributeName: "pk" }] }));
    expect(p.keySchema).toEqual([{ AttributeName: "pk" }]);
    expect(p.attributeDefinitions).toEqual([]);
  });
});

describe("dynamodb-detail.buildDynamoSchemaTab", () => {
  it("renders empty-attribute path and a GSI + LSI", () => {
    const tab = buildDynamoSchemaTab({
      attributeDefinitions: [],
      keySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      globalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [{ AttributeName: "g", KeyType: "HASH" }],
          Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["x"] },
          IndexStatus: "ACTIVE",
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 3 },
          ItemCount: 10,
        },
      ],
      localSecondaryIndexes: [
        {
          IndexName: "LSI1",
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
          ItemCount: 2,
        },
      ],
    });
    expect(tab.id).toBe("schema");
    expect(tab.childGroups).toHaveLength(2);
    const gsi = tab.childGroups![0]!.items[0]!;
    expect(gsi.displayName).toBe("GSI1");
    expect(gsi.status).toMatchObject({ status: "healthy", label: "Active" });
  });

  it("handles attribute table, non-active status and no-throughput GSI", () => {
    const tab = buildDynamoSchemaTab({
      attributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      keySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      globalSecondaryIndexes: [
        {
          IndexName: "GSI2",
          KeySchema: [],
          Projection: { ProjectionType: "KEYS_ONLY" },
          IndexStatus: "CREATING",
        },
      ],
      localSecondaryIndexes: [],
    });
    // only the GSI group when no LSIs
    expect(tab.childGroups).toHaveLength(1);
    const gsi = tab.childGroups![0]!.items[0]!;
    expect(gsi.status).toMatchObject({ status: "provisioning", label: "Creating" });
  });

  it("maps UPDATING / DELETING / unknown GSI statuses", () => {
    const statuses = ["UPDATING", "DELETING", "WEIRD", ""];
    const expected = [
      { status: "provisioning", label: "Updating" },
      { status: "provisioning", label: "Deleting" },
      { status: "info", label: "WEIRD" },
      { status: "info", label: "Unknown" },
    ];
    statuses.forEach((s, i) => {
      const tab = buildDynamoSchemaTab({
        attributeDefinitions: [],
        keySchema: [],
        globalSecondaryIndexes: [
          { IndexName: `g${i}`, KeySchema: [], Projection: undefined as never, IndexStatus: s },
        ],
        localSecondaryIndexes: [],
      });
      expect(tab.childGroups![0]!.items[0]!.status).toMatchObject(expected[i]!);
    });
  });
});

describe("render-resource.renderDetail", () => {
  it("renders dynamodb-table with schema tab and noSqlBrowser", () => {
    const r = makeResource({
      resourceTypeId: "dynamodb-table",
      fields: {
        tableName: "T",
        status: "ACTIVE",
        _indexesJson: JSON.stringify({
          attributeDefinitions: [],
          keySchema: [],
          globalSecondaryIndexes: [],
          localSecondaryIndexes: [],
        }),
      },
    });
    const view = renderDetail(r, [], "us-east-1");
    expect(view.noSqlBrowser?.driver).toBe("dynamodb");
    expect(view.customTabs).toHaveLength(1);
    // underscore-prefixed fields stripped from details
    const detailItems = (view.sections[0] as any).children[0].items;
    expect(detailItems.find((i: any) => i.key === "_indexesJson")).toBeUndefined();
  });

  it("renders route53-record-set via shared helper", () => {
    const r = makeResource({
      resourceTypeId: "route53-record-set",
      fields: { name: "x.example.com", type: "A", values: "1.2.3.4", ttl: "300" },
    });
    const view = renderDetail(r, [], "us-east-1");
    expect(view).toBeTruthy();
  });

  it("renders s3-bucket with storageBrowser + bucketPolicyEditor", () => {
    const r = makeResource({ resourceTypeId: "s3-bucket", externalId: "mybucket", fields: {} });
    const view = renderDetail(r, [], "us-west-2");
    expect(view.storageBrowser?.bucketName).toBe("mybucket");
    expect(view.bucketPolicyEditor?.bucketArn).toBe("arn:aws:s3:::mybucket");
  });

  it("renders ecr artifactRegistry", () => {
    const r = makeResource({ resourceTypeId: "ecr-repository" });
    expect(renderDetail(r, [], "r").artifactRegistry?.format).toBe("docker");
  });

  it("renders bedrock chat panel", () => {
    const r = makeResource({ resourceTypeId: "bedrock-model", fields: { modelName: "claude" } });
    expect(renderDetail(r, [], "r").chatPanel?.tabLabel).toBe("Playground");
  });

  it("renders publish panels for sqs/sns/kinesis/eventbridge", () => {
    for (const t of ["sqs-queue", "sns-topic", "kinesis-stream", "eventbridge-rule"]) {
      const view = renderDetail(makeResource({ resourceTypeId: t }), [], "r");
      expect(view.publishPanel).toBeTruthy();
    }
  });

  it("treats sns/sqs as healthy without explicit state", () => {
    const view = renderDetail(makeResource({ resourceTypeId: "sns-topic" }), [], "r");
    expect((view.status as any).status).toBe("healthy");
  });

  it("maps a known state to a status dot and includes outputs section", () => {
    const r = makeResource({
      resourceTypeId: "ec2-instance",
      fields: { state: "running" },
      resolvedOutputs: { publicIp: "1.2.3.4" },
    });
    const view = renderDetail(r, [], "r");
    expect((view.status as any).status).toBe("healthy");
    const titles = view.sections.map((s: any) => s.title);
    expect(titles).toContain("Outputs");
  });

  it("uses info status for unknown state and no outputs section", () => {
    const r = makeResource({ resourceTypeId: "ec2-instance", fields: { state: "weird-state" } });
    const view = renderDetail(r, [], "r");
    expect((view.status as any).status).toBe("info");
    expect(view.sections.map((s: any) => s.title)).not.toContain("Outputs");
  });
});

describe("render-resource.renderSidebarItem", () => {
  it("dns record set via helper", () => {
    const r = makeResource({
      resourceTypeId: "route53-record-set",
      fields: { name: "n", type: "A", values: "1.1.1.1" },
    });
    expect(renderSidebarItem(r).id).toBe(r.id);
  });
  it("hosted zone private vs public", () => {
    const priv = renderSidebarItem(
      makeResource({ resourceTypeId: "route53-hosted-zone", fields: { isPrivate: true } }),
    );
    expect((priv.status as any).label).toBe("Private");
    const pub = renderSidebarItem(
      makeResource({ resourceTypeId: "route53-hosted-zone", fields: {} }),
    );
    expect((pub.status as any).label).toBe("Active");
  });
  it("generic state mapping", () => {
    expect(
      (renderSidebarItem(makeResource({ fields: { state: "running" } })).status as any).status,
    ).toBe("healthy");
    expect(
      (renderSidebarItem(makeResource({ fields: { status: "failed" } })).status as any).status,
    ).toBe("error");
    expect((renderSidebarItem(makeResource({ fields: {} })).status as any).status).toBe("info");
  });
});

describe("dashboard-metrics.fetchDashboardStats", () => {
  it("ec2 running with public ip", () => {
    const stats = fetchDashboardStats(
      makeResource({
        fields: { state: "running", instanceType: "t3.micro", availabilityZone: "us-east-1a" },
        resolvedOutputs: { publicIp: "1.2.3.4" },
      }),
      "ec2-instance",
    );
    expect(stats[0]).toMatchObject({ label: "State", variant: "status-healthy" });
    expect(stats.find((s) => s.label === "Public IP")).toBeTruthy();
  });
  it("ec2 stopped/terminated -> error variant", () => {
    expect(
      fetchDashboardStats(makeResource({ fields: { state: "stopped" } }), "ec2-instance")[0]
        ?.variant,
    ).toBe("status-error");
    expect(
      fetchDashboardStats(makeResource({ fields: { state: "pending" } }), "ec2-instance")[0]
        ?.variant,
    ).toBe("status-degraded");
  });
  it("rds variants", () => {
    expect(
      fetchDashboardStats(makeResource({ fields: { status: "available" } }), "rds-instance")[0]
        ?.variant,
    ).toBe("status-healthy");
    expect(
      fetchDashboardStats(makeResource({ fields: { status: "stopped" } }), "rds-instance")[0]
        ?.variant,
    ).toBe("status-error");
    expect(
      fetchDashboardStats(makeResource({ fields: { status: "modifying" } }), "rds-instance")[0]
        ?.variant,
    ).toBe("status-degraded");
  });
  it("lambda, s3, eks", () => {
    expect(
      fetchDashboardStats(makeResource({ fields: { runtime: "nodejs20.x" } }), "lambda-function"),
    ).toHaveLength(3);
    expect(
      fetchDashboardStats(makeResource({ fields: { region: "us-east-1" } }), "s3-bucket"),
    ).toHaveLength(1);
    expect(
      fetchDashboardStats(makeResource({ fields: { status: "ACTIVE" } }), "eks-cluster")[1]
        ?.variant,
    ).toBe("status-healthy");
    expect(
      fetchDashboardStats(makeResource({ fields: { status: "DEGRADED" } }), "eks-cluster")[1]
        ?.variant,
    ).toBe("status-degraded");
  });
  it("generic fallback covers status/type/region detection branches", () => {
    const healthy = fetchDashboardStats(
      makeResource({ fields: { phase: "succeeded", kind: "x", location: "eu" } }),
      "unknown-type",
    );
    expect(healthy[0]).toMatchObject({ label: "Status", variant: "status-healthy" });
    expect(healthy.find((s) => s.label === "Type")).toBeTruthy();
    expect(healthy.find((s) => s.label === "Region")).toBeTruthy();

    expect(
      fetchDashboardStats(makeResource({ fields: { status: "failed" } }), "u")[0]?.variant,
    ).toBe("status-error");
    expect(
      fetchDashboardStats(makeResource({ fields: { status: "creating" } }), "u")[0]?.variant,
    ).toBe("status-degraded");
    expect(
      fetchDashboardStats(makeResource({ fields: { status: "mystery" } }), "u")[0]?.variant,
    ).toBe("default");
    expect(fetchDashboardStats(makeResource({ fields: {} }), "u")).toEqual([]);
  });
});
