import { describe, it, expect } from "vitest";
import {
  pluginManifestSchema,
  resourceTypeDefinitionSchema,
  fieldDefinitionSchema,
  schemaNodeSchema,
  dashboardCardSchema,
  detailViewSchema,
} from "../validation/index.js";
import { validatePreflightContract } from "../preflight.js";

const validManifest = {
  id: "digitalocean",
  version: "0.1.0",
  displayName: "DigitalOcean",
  description: "Manage DigitalOcean resources",
  logoSvg: "<svg/>",
  author: "Infrawrench",
  minHostVersion: "0.1.0",
};

describe("pluginManifestSchema", () => {
  it("accepts a valid manifest", () => {
    expect(pluginManifestSchema.safeParse(validManifest).success).toBe(true);
  });

  it("accepts manifest with all optional fields", () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      credentialFields: [
        {
          key: "apiToken",
          label: "API Token",
          sensitive: true,
          placeholder: "dop_v1_...",
          multiline: false,
        },
      ],
      sqlDriver: { driver: "postgres", credentialKey: "connStr" },
      kvDriver: { driver: "redis", credentialKey: "connStr" },
      dockerDriver: { driver: "docker", credentialKey: "host" },
      peerPlugins: ["kubernetes"],
      supportsSecretImport: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-kebab-case id", () => {
    expect(pluginManifestSchema.safeParse({ ...validManifest, id: "DigitalOcean" }).success).toBe(
      false,
    );
  });

  it("rejects id starting with number", () => {
    expect(pluginManifestSchema.safeParse({ ...validManifest, id: "1plugin" }).success).toBe(false);
  });

  it("rejects non-semver version", () => {
    expect(
      pluginManifestSchema.safeParse({ ...validManifest, version: "not-a-version" }).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(pluginManifestSchema.safeParse({}).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ id: "test" }).success).toBe(false);
  });

  it("rejects empty logoSvg", () => {
    expect(pluginManifestSchema.safeParse({ ...validManifest, logoSvg: "" }).success).toBe(false);
  });

  it("accepts a preflight declaration", () => {
    const result = pluginManifestSchema.safeParse({
      ...validManifest,
      preflight: {
        capabilities: [
          {
            id: "resources",
            label: "Resource inventory",
            description: "Read-only listing",
            requiredPermissions: [{ id: "ec2:DescribeInstances", label: "List EC2 instances" }],
            essential: true,
          },
        ],
        templateFormat: { label: "AWS IAM policy (JSON)", language: "json" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a preflight declaration with no capabilities or bad language", () => {
    expect(
      pluginManifestSchema.safeParse({ ...validManifest, preflight: { capabilities: [] } }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...validManifest,
        preflight: {
          capabilities: [{ id: "resources", label: "R", requiredPermissions: [] }],
          templateFormat: { label: "X", language: "toml" },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate preflight capability ids", () => {
    const capability = {
      id: "resources",
      label: "Resource inventory",
      requiredPermissions: [{ id: "ec2:DescribeInstances", label: "List EC2 instances" }],
    };
    expect(
      pluginManifestSchema.safeParse({
        ...validManifest,
        preflight: { capabilities: [capability, { ...capability, label: "Duplicate" }] },
      }).success,
    ).toBe(false);
    // Distinct ids stay accepted.
    expect(
      pluginManifestSchema.safeParse({
        ...validManifest,
        preflight: { capabilities: [capability, { ...capability, id: "metrics" }] },
      }).success,
    ).toBe(true);
  });
});

describe("validatePreflightContract", () => {
  const declaration = {
    capabilities: [
      {
        id: "resources",
        label: "Resource inventory",
        requiredPermissions: [{ id: "ec2:DescribeInstances", label: "List EC2 instances" }],
      },
    ],
  };

  it("accepts plugins without a preflight declaration", () => {
    expect(validatePreflightContract({ manifest: {} })).toBeNull();
  });

  it("accepts a declaration without templateFormat and no policyTemplate", () => {
    expect(validatePreflightContract({ manifest: { preflight: declaration } })).toBeNull();
  });

  it("accepts templateFormat when policyTemplate is implemented", () => {
    expect(
      validatePreflightContract({
        manifest: {
          preflight: {
            ...declaration,
            templateFormat: { label: "AWS IAM policy (JSON)", language: "json" },
          },
        },
        policyTemplate: () => ({
          formatLabel: "AWS IAM policy (JSON)",
          language: "json",
          document: "{}",
        }),
      }),
    ).toBeNull();
  });

  it("rejects templateFormat without a policyTemplate implementation", () => {
    expect(
      validatePreflightContract({
        manifest: {
          preflight: {
            ...declaration,
            templateFormat: { label: "AWS IAM policy (JSON)", language: "json" },
          },
        },
      }),
    ).toContain("policyTemplate");
  });
});

const validResourceType = {
  id: "doks-cluster",
  displayName: "DOKS Cluster",
  pluralDisplayName: "DOKS Clusters",
  description: "A managed Kubernetes cluster on DigitalOcean",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "enum", required: true, enumValues: ["nyc1", "sfo3"] },
  ],
  outputs: [{ key: "kubeconfig", label: "Kubeconfig", sensitive: true }],
  dashboardPinnable: true,
};

describe("resourceTypeDefinitionSchema", () => {
  it("accepts a valid resource type", () => {
    expect(resourceTypeDefinitionSchema.safeParse(validResourceType).success).toBe(true);
  });

  it("accepts with optional parentTypeId", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({ ...validResourceType, parentTypeId: "project" })
        .success,
    ).toBe(true);
  });

  it("accepts with peerIntegrations", () => {
    const result = resourceTypeDefinitionSchema.safeParse({
      ...validResourceType,
      peerIntegrations: [
        {
          pluginId: "kubernetes",
          credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
          tabLabel: "K8s",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts with secretExportTemplates", () => {
    const result = resourceTypeDefinitionSchema.safeParse({
      ...validResourceType,
      secretExportTemplates: [
        {
          id: "env",
          displayName: "Env Vars",
          entries: [{ envKey: "DB_URL", outputKey: "connectionString" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(resourceTypeDefinitionSchema.safeParse({}).success).toBe(false);
    expect(resourceTypeDefinitionSchema.safeParse({ id: "test" }).success).toBe(false);
  });

  it("rejects empty id", () => {
    expect(resourceTypeDefinitionSchema.safeParse({ ...validResourceType, id: "" }).success).toBe(
      false,
    );
  });

  it("rejects missing dashboardPinnable", () => {
    const { dashboardPinnable: _, ...noPinnable } = validResourceType;
    expect(resourceTypeDefinitionSchema.safeParse(noPinnable).success).toBe(false);
  });

  it("accepts a full rightsizing declaration", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...validResourceType,
        rightsizing: {
          sizeFieldKey: "serverType",
          createSizeFieldKey: "size",
          regionFieldKey: "location",
          diskFieldKey: "primaryDiskGb",
          cpuMetric: { seriesLabel: "CPU Utilization", scale: "fraction" },
          memoryMetric: { seriesLabel: "Memory Available", interpretation: "available-bytes" },
          priceCurrency: "EUR",
          sizeFamilyPattern: "^([a-z]+)",
          resizeNote: "Power the server off first.",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects a rightsizing declaration without a CPU metric", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...validResourceType,
        rightsizing: { sizeFieldKey: "size" },
      }).success,
    ).toBe(false);
  });

  it("rejects a rightsizing sizeFamilyPattern that doesn't compile", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...validResourceType,
        rightsizing: {
          sizeFieldKey: "size",
          cpuMetric: { seriesLabel: "CPU" },
          sizeFamilyPattern: "([a-z", // unbalanced group — invalid regex
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a rightsizing sizeFamilyPattern without a capture group", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...validResourceType,
        rightsizing: {
          sizeFieldKey: "size",
          cpuMetric: { seriesLabel: "CPU" },
          sizeFamilyPattern: "^(?:[a-z]+)",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a rightsizing sizeFamilyPattern whose only parens are a lookahead", () => {
    // `(?=…)` contains "(" but captures nothing — a source scan for "("
    // would wrongly accept it and the family guard would never constrain.
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...validResourceType,
        rightsizing: {
          sizeFieldKey: "size",
          cpuMetric: { seriesLabel: "CPU" },
          sizeFamilyPattern: "^(?=[a-z])",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a rightsizing sizeFamilyPattern whose only paren is escaped", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...validResourceType,
        rightsizing: {
          sizeFieldKey: "size",
          cpuMetric: { seriesLabel: "CPU" },
          sizeFamilyPattern: "^\\(size",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a rightsizing sizeFamilyPattern with a named capture group", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...validResourceType,
        rightsizing: {
          sizeFieldKey: "size",
          cpuMetric: { seriesLabel: "CPU" },
          sizeFamilyPattern: "^(?<family>[a-z]+)",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects a memory metric without an interpretation", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...validResourceType,
        rightsizing: {
          sizeFieldKey: "size",
          cpuMetric: { seriesLabel: "CPU" },
          memoryMetric: { seriesLabel: "Memory" },
        },
      }).success,
    ).toBe(false);
  });
});

describe("fieldDefinitionSchema", () => {
  it("accepts all valid field kinds", () => {
    for (const kind of ["string", "number", "boolean", "enum", "secret", "association"]) {
      expect(
        fieldDefinitionSchema.safeParse({ key: "f", label: "F", kind, required: true }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown kind", () => {
    expect(
      fieldDefinitionSchema.safeParse({ key: "f", label: "F", kind: "unknown", required: true })
        .success,
    ).toBe(false);
  });

  it("rejects empty key", () => {
    expect(
      fieldDefinitionSchema.safeParse({ key: "", label: "F", kind: "string", required: true })
        .success,
    ).toBe(false);
  });

  it("accepts optional resolvableFrom", () => {
    const result = fieldDefinitionSchema.safeParse({
      key: "db",
      label: "Database",
      kind: "association",
      required: true,
      resolvableFrom: [
        { pluginId: "postgres", resourceTypeId: "db", outputKey: "connectionString" },
      ],
      allowLiteral: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("schemaNodeSchema", () => {
  it("accepts text node", () => {
    expect(schemaNodeSchema.safeParse({ kind: "text", content: "hello" }).success).toBe(true);
  });

  it("accepts text node with variant", () => {
    for (const variant of ["heading", "subheading", "body", "mono", "muted"]) {
      expect(schemaNodeSchema.safeParse({ kind: "text", content: "x", variant }).success).toBe(
        true,
      );
    }
  });

  it("accepts badge node", () => {
    expect(
      schemaNodeSchema.safeParse({ kind: "badge", label: "us-east-1", color: "blue" }).success,
    ).toBe(true);
  });

  it("rejects badge with invalid color", () => {
    expect(schemaNodeSchema.safeParse({ kind: "badge", label: "x", color: "purple" }).success).toBe(
      false,
    );
  });

  it("accepts status-dot node", () => {
    expect(
      schemaNodeSchema.safeParse({ kind: "status-dot", status: "healthy", label: "Running" })
        .success,
    ).toBe(true);
  });

  it("rejects status-dot with invalid status", () => {
    expect(schemaNodeSchema.safeParse({ kind: "status-dot", status: "broken" }).success).toBe(
      false,
    );
  });

  it("accepts key-value-list node", () => {
    const result = schemaNodeSchema.safeParse({
      kind: "key-value-list",
      items: [
        { key: "Region", value: "us-east-1" },
        { key: "Size", value: "s-1vcpu-1gb", copyable: true },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts action node with all host action types", () => {
    const actions = [
      { type: "reroll-secret", fieldKey: "password" },
      { type: "open-url", url: "https://example.com" },
      { type: "copy-to-clipboard", fieldKey: "ip" },
      { type: "navigate-to-resource", pluginId: "aws", resourceTypeId: "ec2", resourceId: "i-123" },
      { type: "refresh-resource" },
    ];
    for (const action of actions) {
      expect(schemaNodeSchema.safeParse({ kind: "action", label: "Act", action }).success).toBe(
        true,
      );
    }
  });

  it("accepts grid node", () => {
    const result = schemaNodeSchema.safeParse({
      kind: "grid",
      columns: 2,
      items: [
        { kind: "text", content: "a" },
        { kind: "text", content: "b" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects grid with invalid column count", () => {
    expect(schemaNodeSchema.safeParse({ kind: "grid", columns: 5, items: [] }).success).toBe(false);
  });

  it("accepts section node with nested children", () => {
    const result = schemaNodeSchema.safeParse({
      kind: "section",
      title: "Info",
      children: [
        { kind: "text", content: "nested" },
        { kind: "section", children: [{ kind: "badge", label: "deep", color: "green" }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts link node", () => {
    expect(
      schemaNodeSchema.safeParse({
        kind: "link",
        label: "Console",
        url: "https://console.aws.amazon.com",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown kind", () => {
    expect(schemaNodeSchema.safeParse({ kind: "unknown-node" }).success).toBe(false);
  });
});

describe("dashboardCardSchema", () => {
  it("accepts a valid card", () => {
    expect(
      dashboardCardSchema.safeParse({
        pluginId: "digitalocean",
        resourceTypeId: "doks-cluster",
        resourceId: "abc-123",
        displayName: "prod-cluster",
        status: { kind: "status-dot", status: "healthy", label: "Running" },
      }).success,
    ).toBe(true);
  });

  it("accepts card without optional status and badges", () => {
    expect(
      dashboardCardSchema.safeParse({
        pluginId: "aws",
        resourceTypeId: "ec2",
        resourceId: "i-123",
        displayName: "web-server",
      }).success,
    ).toBe(true);
  });

  it("accepts card with badges array", () => {
    expect(
      dashboardCardSchema.safeParse({
        pluginId: "aws",
        resourceTypeId: "ec2",
        resourceId: "i-123",
        displayName: "web-server",
        badges: [
          { kind: "badge", label: "t3.micro", color: "gray" },
          { kind: "badge", label: "us-east-1", color: "blue" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects card with invalid status enum", () => {
    expect(
      dashboardCardSchema.safeParse({
        pluginId: "aws",
        resourceTypeId: "ec2",
        resourceId: "i-123",
        displayName: "x",
        status: { kind: "status-dot", status: "invalid-status" },
      }).success,
    ).toBe(false);
  });
});

describe("detailViewSchema", () => {
  it("accepts a detail view with nested sections", () => {
    expect(
      detailViewSchema.safeParse({
        title: "prod-cluster",
        subtitle: "DOKS · nyc1",
        status: { kind: "status-dot", status: "healthy" },
        sections: [
          {
            kind: "section",
            title: "Details",
            children: [
              { kind: "text", content: "Kubernetes 1.30" },
              { kind: "badge", label: "nyc1", color: "blue" },
            ],
          },
        ],
        headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      }).success,
    ).toBe(true);
  });

  it("accepts minimal detail view", () => {
    expect(
      detailViewSchema.safeParse({
        title: "test",
        sections: [],
      }).success,
    ).toBe(true);
  });

  it("accepts detail view with children (dashboard cards)", () => {
    expect(
      detailViewSchema.safeParse({
        title: "Account",
        sections: [{ kind: "section", children: [] }],
        children: [
          { pluginId: "aws", resourceTypeId: "ec2", resourceId: "i-1", displayName: "web" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects missing title", () => {
    expect(detailViewSchema.safeParse({ sections: [] }).success).toBe(false);
  });

  it("accepts detail view with all action variants", () => {
    expect(
      detailViewSchema.safeParse({
        title: "test",
        sections: [],
        headerActions: [
          {
            kind: "action",
            label: "Delete",
            action: { type: "refresh-resource" },
            variant: "danger",
          },
          {
            kind: "action",
            label: "Copy",
            action: { type: "copy-to-clipboard", fieldKey: "ip" },
            variant: "ghost",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts detail view with key-value-list containing secret placeholders", () => {
    expect(
      detailViewSchema.safeParse({
        title: "test",
        sections: [
          {
            kind: "section",
            children: [
              {
                kind: "key-value-list",
                items: [
                  {
                    key: "Password",
                    value: {
                      kind: "secret-placeholder",
                      fieldKey: "password",
                      resolution: { kind: "literal", encryptedValue: "enc", iv: "iv" },
                    },
                    sensitive: true,
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });
});
