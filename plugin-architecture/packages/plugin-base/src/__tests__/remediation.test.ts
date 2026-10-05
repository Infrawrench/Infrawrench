import { describe, expect, it, vi } from "vitest";
import {
  remediationDateStamp,
  remediationId,
  resolveRemediationCommands,
  shellQuote,
  terraformRemediationHint,
  type RemediationFinding,
} from "../remediation.js";
import { tf, type TerraformExportCapability } from "../terraform.js";

const resource = {
  resourceTypeId: "ec2-instance",
  displayName: "api-1",
  externalId: "i-0abc12de34f567890",
  fields: { instanceType: "m5.xlarge", region: "eu-west-1" },
};

const oversized: RemediationFinding = {
  kind: "oversized",
  resource,
  sizeFieldKey: "instanceType",
  currentSize: "m5.xlarge",
  targetSize: "m5.large",
  region: "eu-west-1",
};

describe("shellQuote", () => {
  it("leaves safe values bare", () => {
    expect(shellQuote("i-0abc12de34f567890")).toBe("i-0abc12de34f567890");
    expect(shellQuote("projects/p/zones/eu-west1-b")).toBe("projects/p/zones/eu-west1-b");
    expect(shellQuote(42)).toBe("42");
  });

  it("single-quotes anything a shell would interpret", () => {
    expect(shellQuote("prod; rm -rf ~")).toBe("'prod; rm -rf ~'");
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
    expect(shellQuote("")).toBe("''");
  });
});

describe("remediationId / remediationDateStamp", () => {
  it("prefers the named field, then externalId", () => {
    expect(remediationId(resource)).toBe("i-0abc12de34f567890");
    expect(remediationId({ ...resource, fields: { volumeId: "vol-1" } }, "volumeId")).toBe("vol-1");
    expect(remediationId({ ...resource, externalId: null })).toBe("");
  });

  it("stamps the UTC date", () => {
    expect(remediationDateStamp(new Date("2026-10-04T23:30:00Z"))).toBe("20261004");
  });
});

describe("resolveRemediationCommands", () => {
  it("returns an empty remediation when the plugin has no generator", () => {
    expect(resolveRemediationCommands({}, oversized)).toEqual({
      commands: [],
      placeholders: [],
      iac: null,
    });
    expect(resolveRemediationCommands(undefined, oversized).commands).toEqual([]);
  });

  it("swallows a throwing generator rather than failing the finding", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = resolveRemediationCommands(
      {
        remediationCommands: () => {
          throw new Error("boom");
        },
      },
      oversized,
    );
    expect(result.commands).toEqual([]);
    spy.mockRestore();
  });

  it("drops malformed entries, coerces destructive, and dedupes placeholders", () => {
    const profile = { name: "AWS_PROFILE", description: "AWS CLI profile" };
    const result = resolveRemediationCommands(
      {
        remediationCommands: () =>
          [
            {
              tool: "aws-cli",
              command: "aws ec2 stop-instances",
              description: "Stop.",
              destructive: false,
              placeholders: [profile],
            },
            { tool: "", command: "x", description: "no tool", destructive: false },
            { tool: "aws-cli", command: "   ", description: "blank", destructive: false },
            {
              tool: "aws-cli",
              command: "aws ec2 start-instances",
              description: "Start.",
              placeholders: [profile],
            },
          ] as never,
      },
      oversized,
    );
    expect(result.commands.map((c) => c.command)).toEqual([
      "aws ec2 stop-instances",
      "aws ec2 start-instances",
    ]);
    expect(result.commands[1]!.destructive).toBe(false);
    expect(result.placeholders).toEqual([profile]);
  });
});

describe("terraformRemediationHint", () => {
  const capability: TerraformExportCapability = {
    provider: { name: "aws", source: "hashicorp/aws", version: "~> 5.0" },
    providerConfig: {},
    variables: [],
    supportedResourceTypeIds: ["ec2-instance"],
    mapResource: (r) => ({
      resource: {
        type: "aws_instance",
        name: r.displayName,
        attributes: {
          instance_type: tf.str(String(r.fields.instanceType)),
          tags: tf.map({ Name: tf.str(r.displayName) }),
        },
      },
    }),
  };
  const base = {
    capability,
    resource: { ...resource, id: "res-1", pluginId: "aws", accountId: "acct-1" },
    address: "aws_instance.api",
    stateLabel: "prod.tfstate",
  };

  it("derives the attribute edit for a resize from the export mapper", () => {
    const hint = terraformRemediationHint({ ...base, finding: oversized });
    expect(hint?.attributeChanges).toEqual([
      { attribute: "instance_type", from: '"m5.xlarge"', to: '"m5.large"' },
    ]);
    expect(hint?.commands).toEqual([
      {
        tool: "terraform",
        command: "terraform plan -target=aws_instance.api",
        description:
          'After setting instance_type = "m5.large" on aws_instance.api in your configuration, review the planned in-place change before terraform apply.',
        destructive: false,
      },
    ]);
  });

  it("quotes indexed addresses for the shell", () => {
    const hint = terraformRemediationHint({
      ...base,
      address: 'aws_instance.api["blue"]',
      finding: oversized,
    });
    expect(hint?.commands[0]!.command).toBe(`terraform plan -target='aws_instance.api["blue"]'`);
  });

  it("previews a destroy for an orphan, and says nothing for a commitment", () => {
    const orphan = terraformRemediationHint({
      ...base,
      finding: { kind: "orphan", resource, reason: "unused" },
    });
    expect(orphan?.commands[0]!.command).toBe("terraform plan -destroy -target=aws_instance.api");
    expect(orphan?.attributeChanges).toEqual([]);
    expect(
      terraformRemediationHint({
        ...base,
        finding: {
          kind: "idle-commitment",
          commitment: {
            id: "ri-1",
            kind: "reservation",
            description: "",
            scope: null,
            region: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("still names the address when the mapper cannot express the resource", () => {
    const hint = terraformRemediationHint({ ...base, capability: undefined, finding: oversized });
    expect(hint?.attributeChanges).toEqual([]);
    expect(hint?.commands[0]!.description).toContain("the size (m5.large)");
  });
});
