import { describe, it, expect } from "vitest";
import {
  camelToTitle,
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "../render-helpers.js";
import type { ResourceTypeDefinition } from "../resource.js";

const types: ResourceTypeDefinition[] = [
  {
    id: "droplet",
    displayName: "Droplet",
    pluralDisplayName: "Droplets",
    description: "A DO droplet",
    fields: [
      { key: "region", label: "Region", kind: "string", required: true },
      { key: "size", label: "Size", kind: "string", required: true },
    ],
    outputs: [
      { key: "ipv4", label: "Public IPv4", sensitive: false },
      { key: "kubeconfig", label: "Kubeconfig", sensitive: true, hidden: true },
    ],
    dashboardPinnable: true,
  },
];

describe("camelToTitle", () => {
  it("converts camelCase to title case", () => {
    expect(camelToTitle("instanceName")).toBe("Instance Name");
  });

  it("uppercases known acronyms in camelCase", () => {
    expect(camelToTitle("instanceId")).toBe("Instance ID");
    expect(camelToTitle("publicIp")).toBe("Public IP");
  });

  it("handles kebab-case", () => {
    expect(camelToTitle("ec2-instance")).toBe("Ec2 Instance");
    expect(camelToTitle("doks-cluster")).toBe("Doks Cluster");
  });

  it("uppercases the first character of a plain word", () => {
    expect(camelToTitle("region")).toBe("Region");
  });

  it("handles consecutive capitals followed by a word", () => {
    expect(camelToTitle("DNSName")).toBe("DNS Name");
  });

  it("uppercases standalone acronym tokens", () => {
    expect(camelToTitle("url")).toBe("URL");
    expect(camelToTitle("vpc")).toBe("VPC");
  });
});

describe("labeledFieldItems", () => {
  it("uses labels from the type definition", () => {
    const items = labeledFieldItems({ region: "nyc1", size: "s-1vcpu" }, types, "droplet");
    expect(items).toEqual([
      { key: "Region", value: "nyc1" },
      { key: "Size", value: "s-1vcpu" },
    ]);
  });

  it("falls back to camelToTitle for unknown keys", () => {
    const items = labeledFieldItems({ publicIp: "1.2.3.4" }, types, "droplet");
    expect(items).toEqual([{ key: "Public IP", value: "1.2.3.4" }]);
  });

  it("filters out empty-string and undefined values", () => {
    const items = labeledFieldItems(
      { region: "", size: "x", missing: undefined as unknown as string },
      types,
      "droplet",
    );
    expect(items).toEqual([{ key: "Size", value: "x" }]);
  });

  it("stringifies numbers and booleans", () => {
    const items = labeledFieldItems({ count: 3, enabled: true }, types, "droplet");
    expect(items).toEqual([
      { key: "Count", value: "3" },
      { key: "Enabled", value: "true" },
    ]);
  });

  it("falls back to camelToTitle when type id is unknown", () => {
    const items = labeledFieldItems({ fooBar: "x" }, types, "nonexistent");
    expect(items).toEqual([{ key: "Foo Bar", value: "x" }]);
  });
});

describe("labeledOutputItems", () => {
  it("uses output labels and marks copyable", () => {
    const items = labeledOutputItems({ ipv4: "1.2.3.4" }, types, "droplet");
    expect(items).toEqual([{ key: "Public IPv4", value: "1.2.3.4", copyable: true }]);
  });

  it("omits hidden outputs", () => {
    const items = labeledOutputItems({ ipv4: "1.2.3.4", kubeconfig: "yaml" }, types, "droplet");
    expect(items).toEqual([{ key: "Public IPv4", value: "1.2.3.4", copyable: true }]);
  });

  it("falls back to camelToTitle for unknown output keys", () => {
    const items = labeledOutputItems({ extraThing: "v" }, types, "droplet");
    expect(items).toEqual([{ key: "Extra Thing", value: "v", copyable: true }]);
  });

  it("falls back gracefully for unknown type id", () => {
    const items = labeledOutputItems({ ipv4: "x" }, types, "missing");
    expect(items).toEqual([{ key: "Ipv4", value: "x", copyable: true }]);
  });
});

describe("resourceTypeDisplayName", () => {
  it("returns the displayName when found", () => {
    expect(resourceTypeDisplayName(types, "droplet")).toBe("Droplet");
  });

  it("falls back to camelToTitle when not found", () => {
    expect(resourceTypeDisplayName(types, "load-balancer")).toBe("Load Balancer");
  });
});
