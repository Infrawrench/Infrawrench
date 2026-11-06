import { describe, it, expect } from "vitest";
import {
  pluginManifestSchema,
  resourceTypeDefinitionSchema,
  fieldDefinitionSchema,
  schemaNodeSchema,
  dashboardCardSchema,
  detailViewSchema,
  createFieldConfigSchema,
  peerPaneSchema,
  metricSeriesSchema,
  metricSeriesPointSchema,
  queryExecuteResultSchema,
  queryResultSchema,
  validate,
} from "../validation/index.js";
import { validatePluginContract } from "../define-plugin.js";

const validManifest = {
  id: "digitalocean",
  displayName: "DigitalOcean",
  description: "Manage DigitalOcean resources",
  logoSvg: "<svg/>",
  egressHosts: ["api.digitalocean.com", "*.digitaloceanspaces.com"],
  credentialFields: [],
};

describe("pluginManifestSchema", () => {
  it("accepts a valid manifest", () => {
    expect(validate(pluginManifestSchema, validManifest).success).toBe(true);
  });

  it("accepts manifest with all optional fields", () => {
    const result = validate(pluginManifestSchema, {
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
    expect(validate(pluginManifestSchema, { ...validManifest, id: "DigitalOcean" }).success).toBe(
      false,
    );
  });

  it("rejects id starting with number", () => {
    expect(validate(pluginManifestSchema, { ...validManifest, id: "1plugin" }).success).toBe(false);
  });

  it("strips the retired version, author and minHostVersion keys", () => {
    const result = validate(pluginManifestSchema, {
      ...validManifest,
      version: "not-a-version",
      author: "Infrawrench",
      minHostVersion: "nope",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("version");
      expect(result.data).not.toHaveProperty("author");
      expect(result.data).not.toHaveProperty("minHostVersion");
    }
  });

  it("rejects missing required fields", () => {
    expect(validate(pluginManifestSchema, {}).success).toBe(false);
    expect(validate(pluginManifestSchema, { id: "test" }).success).toBe(false);
  });

  it("requires egressHosts and credentialFields", () => {
    const { egressHosts: _hosts, ...noHosts } = validManifest;
    const { credentialFields: _fields, ...noFields } = validManifest;
    expect(validate(pluginManifestSchema, noHosts).success).toBe(false);
    expect(validate(pluginManifestSchema, noFields).success).toBe(false);
    expect(validate(pluginManifestSchema, { ...validManifest, egressHosts: [1] }).success).toBe(
      false,
    );
    expect(validate(pluginManifestSchema, { ...validManifest, egressHosts: [] }).success).toBe(
      true,
    );
  });

  it("accepts the SSH tunnel and jump host declarations", () => {
    const sshTunnel = {
      label: "PostgreSQL",
      defaultPort: 5432,
      credentials: { connectionString: "postgres://localhost:{port}/db" },
    };
    expect(validate(pluginManifestSchema, { ...validManifest, sshTunnel }).success).toBe(true);
    expect(validate(pluginManifestSchema, { ...validManifest, jumpHost: true }).success).toBe(true);
    expect(
      validate(pluginManifestSchema, {
        ...validManifest,
        sshTunnel: { ...sshTunnel, credentials: { connectionString: 1 } },
      }).success,
    ).toBe(false);
    expect(
      validate(pluginManifestSchema, {
        ...validManifest,
        sshTunnel: { label: "PostgreSQL", credentials: {} },
      }).success,
    ).toBe(false);
    expect(validate(pluginManifestSchema, { ...validManifest, jumpHost: "yes" }).success).toBe(
      false,
    );
  });

  it("checks kvDriver.browser", () => {
    const kvDriver = { driver: "redis", credentialKey: "connStr" };
    for (const browser of ["keys", "documents"]) {
      expect(
        validate(pluginManifestSchema, { ...validManifest, kvDriver: { ...kvDriver, browser } })
          .success,
      ).toBe(true);
    }
    expect(
      validate(pluginManifestSchema, {
        ...validManifest,
        kvDriver: { ...kvDriver, browser: "tables" },
      }).success,
    ).toBe(false);
  });

  it("checks commitments.discount", () => {
    const commitments = { kinds: ["reservation"] };
    const withDiscount = (discount: unknown) =>
      validate(pluginManifestSchema, {
        ...validManifest,
        commitments: { ...commitments, discount },
      }).success;
    expect(withDiscount({ min: 0.2, max: 0.6, basis: "range" })).toBe(true);
    expect(withDiscount({ max: 0.6, basis: "upper_bound" })).toBe(true);
    expect(withDiscount({ min: 0.2, basis: "range" })).toBe(false);
    expect(withDiscount({ max: 0.6, basis: "guess" })).toBe(false);
  });

  it("keeps declared capabilities instead of stripping them", () => {
    const declared = {
      kubernetesDriver: { driver: "kubernetes", credentialKey: "kubeconfig" },
      oauth: {
        authorizeUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        scopes: ["read"],
        tokenField: "apiToken",
        clients: { server: { auth: "none", pkce: true }, desktop: {} },
        access: "read-only",
        refresh: "rotating",
      },
      networkFlows: {
        rates: { currency: "USD", asOf: "2026-11-01", perGb: { cross_zone: 0.01 } },
        maxPairsPerDay: 100,
        maxHistoryDays: 30,
      },
      transferRates: { currency: "USD", asOf: "2026-11-01", perGb: {} },
      businessMetricSource: {
        label: "SQL",
        kind: "sql",
        fields: [{ key: "query", label: "Query", type: "sql" }],
      },
    };
    const result = validate(pluginManifestSchema, { ...validManifest, ...declared });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject(declared);
    expect(
      validate(pluginManifestSchema, {
        ...validManifest,
        networkFlows: { ...declared.networkFlows, rates: { perGb: { nowhere: 1 } } },
      }).success,
    ).toBe(false);
    expect(
      validate(pluginManifestSchema, {
        ...validManifest,
        oauth: { ...declared.oauth, access: "everything" },
      }).success,
    ).toBe(false);
  });

  it("pins link schemes to https where it did before", () => {
    const quotas = (increaseUrl: string) =>
      validate(pluginManifestSchema, { ...validManifest, quotas: { increaseUrl } }).success;
    expect(quotas("https://example.com/quotas")).toBe(true);
    expect(quotas("http://example.com/quotas")).toBe(false);
    expect(quotas("javascript:alert(1)")).toBe(false);
    expect(quotas("not a url")).toBe(false);
  });

  it("rejects empty logoSvg", () => {
    expect(validate(pluginManifestSchema, { ...validManifest, logoSvg: "" }).success).toBe(false);
  });

  it("accepts a preflight declaration", () => {
    const result = validate(pluginManifestSchema, {
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
      validate(pluginManifestSchema, { ...validManifest, preflight: { capabilities: [] } }).success,
    ).toBe(false);
    expect(
      validate(pluginManifestSchema, {
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
      validate(pluginManifestSchema, {
        ...validManifest,
        preflight: { capabilities: [capability, { ...capability, label: "Duplicate" }] },
      }).success,
    ).toBe(false);
    // Distinct ids stay accepted.
    expect(
      validate(pluginManifestSchema, {
        ...validManifest,
        preflight: { capabilities: [capability, { ...capability, id: "metrics" }] },
      }).success,
    ).toBe(true);
  });
});

describe("validatePluginContract preflight rows", () => {
  const manifest = {
    id: "demo",
    displayName: "Demo",
    logoSvg: "<svg/>",
    egressHosts: [],
    credentialFields: [],
  };
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
    expect(validatePluginContract({ manifest })).toEqual([]);
  });

  it("accepts a declaration without templateFormat and no policyTemplate", () => {
    expect(validatePluginContract({ manifest: { ...manifest, preflight: declaration } })).toEqual(
      [],
    );
  });

  it("accepts templateFormat when policyTemplate is implemented", () => {
    expect(
      validatePluginContract({
        manifest: {
          ...manifest,
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
    ).toEqual([]);
  });

  it("rejects templateFormat without a policyTemplate implementation", () => {
    expect(
      validatePluginContract({
        manifest: {
          ...manifest,
          preflight: {
            ...declaration,
            templateFormat: { label: "AWS IAM policy (JSON)", language: "json" },
          },
        },
      }).join(),
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
    expect(validate(resourceTypeDefinitionSchema, validResourceType).success).toBe(true);
  });

  it("accepts with optional parentTypeId", () => {
    expect(
      validate(resourceTypeDefinitionSchema, { ...validResourceType, parentTypeId: "project" })
        .success,
    ).toBe(true);
  });

  it("accepts with peerIntegrations", () => {
    const result = validate(resourceTypeDefinitionSchema, {
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
    const result = validate(resourceTypeDefinitionSchema, {
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
    expect(validate(resourceTypeDefinitionSchema, {}).success).toBe(false);
    expect(validate(resourceTypeDefinitionSchema, { id: "test" }).success).toBe(false);
  });

  it("rejects empty id", () => {
    expect(validate(resourceTypeDefinitionSchema, { ...validResourceType, id: "" }).success).toBe(
      false,
    );
  });

  it("rejects missing dashboardPinnable", () => {
    const { dashboardPinnable: _, ...noPinnable } = validResourceType;
    expect(validate(resourceTypeDefinitionSchema, noPinnable).success).toBe(false);
  });

  it("accepts a full rightsizing declaration", () => {
    expect(
      validate(resourceTypeDefinitionSchema, {
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
      validate(resourceTypeDefinitionSchema, {
        ...validResourceType,
        rightsizing: { sizeFieldKey: "size" },
      }).success,
    ).toBe(false);
  });

  it("rejects a rightsizing sizeFamilyPattern that doesn't compile", () => {
    expect(
      validate(resourceTypeDefinitionSchema, {
        ...validResourceType,
        rightsizing: {
          sizeFieldKey: "size",
          cpuMetric: { seriesLabel: "CPU" },
          sizeFamilyPattern: "([a-z", // unbalanced group: invalid regex
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a rightsizing sizeFamilyPattern without a capture group", () => {
    expect(
      validate(resourceTypeDefinitionSchema, {
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
    // `(?=…)` contains "(" but captures nothing: a source scan for "("
    // would wrongly accept it and the family guard would never constrain.
    expect(
      validate(resourceTypeDefinitionSchema, {
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
      validate(resourceTypeDefinitionSchema, {
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
      validate(resourceTypeDefinitionSchema, {
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
      validate(resourceTypeDefinitionSchema, {
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

describe("resourceTypeDefinitionSchema new contract fields", () => {
  it("checks ResourceOutput.dnsValue", () => {
    const withOutput = (dnsValue: string) =>
      validate(resourceTypeDefinitionSchema, {
        ...validResourceType,
        outputs: [{ key: "ip", label: "IP", sensitive: false, dnsValue }],
      }).success;
    for (const value of ["ipv4", "ipv6", "hostname"]) expect(withOutput(value)).toBe(true);
    expect(withOutput("cname")).toBe(false);
  });

  it("checks CarbonDeclaration.mayDuplicateInstance", () => {
    const withCarbon = (mayDuplicateInstance: unknown) =>
      validate(resourceTypeDefinitionSchema, {
        ...validResourceType,
        carbon: {
          regionFieldKey: "region",
          vcpus: { from: "field", fieldKey: "cpus" },
          mayDuplicateInstance,
        },
      }).success;
    expect(withCarbon(true)).toBe(true);
    expect(withCarbon("true")).toBe(false);
  });

  it("keeps declared keys instead of stripping them", () => {
    const declared = {
      supportsCreate: true,
      dependsOn: [{ fieldKey: "vpcId", targetTypeId: "vpc" }],
      sshEndpoint: { hostOutputKey: "ip" },
      credentialFormats: [{ id: "json", label: "JSON", mediaType: "json" }],
    };
    const result = validate(resourceTypeDefinitionSchema, { ...validResourceType, ...declared });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject(declared);
  });
});

describe("createFieldConfigSchema", () => {
  const field = { key: "target", label: "Target", kind: "resource-picker", required: true };

  it("checks associationRole", () => {
    for (const associationRole of ["dns-ipv4", "dns-ipv6", "dns-hostname"]) {
      expect(validate(createFieldConfigSchema, { ...field, associationRole }).success).toBe(true);
    }
    expect(validate(createFieldConfigSchema, { ...field, associationRole: "dns-mx" }).success).toBe(
      false,
    );
  });

  it("recurses through field action forms", () => {
    const withAction = (formField: unknown) =>
      validate(createFieldConfigSchema, {
        ...field,
        actions: [{ id: "new", label: "New", formFields: [formField] }],
      }).success;
    expect(withAction(field)).toBe(true);
    expect(withAction({ ...field, kind: "carousel" })).toBe(false);
  });

  it("is what prompt-nosql-command fields are checked against", () => {
    const withFields = (fields: unknown[]) =>
      validate(schemaNodeSchema, {
        kind: "action",
        label: "Run",
        action: { type: "prompt-nosql-command", command: "run", fields },
      }).success;
    expect(withFields([field])).toBe(true);
    expect(withFields([{ ...field, associationRole: "dns-mx" }])).toBe(false);
  });
});

describe("peerPaneSchema", () => {
  const group = { title: "Pods", resourceTypeId: "pod", pluginId: "kubernetes", items: [] };

  it("checks PeerPaneResourceGroup.role", () => {
    for (const role of ["namespace", "service"]) {
      expect(validate(peerPaneSchema, { resourceGroups: [{ ...group, role }] }).success).toBe(true);
    }
    expect(validate(peerPaneSchema, { resourceGroups: [group] }).success).toBe(true);
    expect(validate(peerPaneSchema, { resourceGroups: [{ ...group, role: "pod" }] }).success).toBe(
      false,
    );
  });
});

describe("validate", () => {
  it("reports every failure as a path and a message", () => {
    const result = validate(pluginManifestSchema, {
      ...validManifest,
      id: "Not Kebab",
      credentialFields: [{ key: 1, label: "L", sensitive: false }],
      rateLimit: { capacity: 0, refillPerSecond: 2 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContain("id: id must be lowercase kebab-case");
      expect(result.issues).toContain("credentialFields[0].key: Expected string");
      expect(result.issues.some((issue) => issue.startsWith("rateLimit.capacity: "))).toBe(true);
    }
  });

  it("reports a root failure without a path", () => {
    expect(validate(queryExecuteResultSchema, "nope")).toEqual({
      success: false,
      issues: ["Expected object"],
    });
  });

  it("puts a cross-field failure at the field it names", () => {
    const result = validate(fieldDefinitionSchema, {
      key: "k",
      label: "K",
      kind: "secret",
      required: true,
      showcase: true,
    });
    expect(result).toEqual({
      success: false,
      issues: ["showcase: a secret or password field can't be shown on a tile"],
    });
  });

  it("never repeats the rejected value", () => {
    const result = validate(detailViewSchema, { title: "hunter2-secret", sections: "hunter2" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues.join()).not.toContain("hunter2");
  });

  it("strips unknown keys, at every level", () => {
    const result = validate(metricSeriesSchema, {
      label: "CPU",
      extra: true,
      points: [{ timestamp: 1, value: 2, extra: true }],
    });
    expect(result).toEqual({
      success: true,
      data: { label: "CPU", points: [{ timestamp: 1, value: 2 }] },
    });
  });

  it("accepts frozen arrays and explicitly undefined optional keys", () => {
    expect(
      validate(metricSeriesSchema, {
        label: "CPU",
        unit: undefined,
        points: Object.freeze([Object.freeze({ timestamp: 1, value: 2 })]),
      }).success,
    ).toBe(true);
  });

  it("rejects NaN but allows Infinity, except where a value must be finite", () => {
    expect(validate(metricSeriesPointSchema, { timestamp: 1, value: Number.NaN }).success).toBe(
      false,
    );
    expect(
      validate(metricSeriesPointSchema, { timestamp: 1, value: Number.POSITIVE_INFINITY }).success,
    ).toBe(true);
    const threshold = {
      key: "maxBytes",
      label: "Bytes",
      unit: "bytes",
      default: 1,
      min: 0,
      max: Number.POSITIVE_INFINITY,
    };
    expect(
      validate(pluginManifestSchema, {
        ...validManifest,
        idleFindings: {
          rules: [
            {
              id: "idle",
              label: "Idle",
              description: "d",
              resourceTypeIds: [],
              action: "stop",
              thresholds: [threshold],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects an array or a function where an object is required", () => {
    expect(validate(queryExecuteResultSchema, []).success).toBe(false);
    expect(validate(queryExecuteResultSchema, () => 1).success).toBe(false);
    expect(validate(queryResultSchema, { rows: [[1]], durationMs: 1 }).success).toBe(false);
  });
});

describe("fieldDefinitionSchema", () => {
  it("accepts all valid field kinds", () => {
    for (const kind of ["string", "number", "boolean", "enum", "secret", "association"]) {
      expect(
        validate(fieldDefinitionSchema, { key: "f", label: "F", kind, required: true }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown kind", () => {
    expect(
      validate(fieldDefinitionSchema, { key: "f", label: "F", kind: "unknown", required: true })
        .success,
    ).toBe(false);
  });

  it("rejects empty key", () => {
    expect(
      validate(fieldDefinitionSchema, { key: "", label: "F", kind: "string", required: true })
        .success,
    ).toBe(false);
  });

  it("accepts optional resolvableFrom", () => {
    const result = validate(fieldDefinitionSchema, {
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
    expect(validate(schemaNodeSchema, { kind: "text", content: "hello" }).success).toBe(true);
  });

  it("accepts text node with variant", () => {
    for (const variant of ["heading", "subheading", "body", "mono", "muted"]) {
      expect(validate(schemaNodeSchema, { kind: "text", content: "x", variant }).success).toBe(
        true,
      );
    }
  });

  it("accepts badge node", () => {
    expect(
      validate(schemaNodeSchema, { kind: "badge", label: "us-east-1", color: "blue" }).success,
    ).toBe(true);
  });

  it("rejects badge with invalid color", () => {
    expect(validate(schemaNodeSchema, { kind: "badge", label: "x", color: "purple" }).success).toBe(
      false,
    );
  });

  it("accepts status-dot node", () => {
    expect(
      validate(schemaNodeSchema, { kind: "status-dot", status: "healthy", label: "Running" })
        .success,
    ).toBe(true);
  });

  it("rejects status-dot with invalid status", () => {
    expect(validate(schemaNodeSchema, { kind: "status-dot", status: "broken" }).success).toBe(
      false,
    );
  });

  it("accepts key-value-list node", () => {
    const result = validate(schemaNodeSchema, {
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
      expect(validate(schemaNodeSchema, { kind: "action", label: "Act", action }).success).toBe(
        true,
      );
    }
  });

  it("accepts grid node", () => {
    const result = validate(schemaNodeSchema, {
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
    expect(validate(schemaNodeSchema, { kind: "grid", columns: 5, items: [] }).success).toBe(false);
  });

  it("accepts section node with nested children", () => {
    const result = validate(schemaNodeSchema, {
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
      validate(schemaNodeSchema, {
        kind: "link",
        label: "Console",
        url: "https://console.aws.amazon.com",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown kind", () => {
    expect(validate(schemaNodeSchema, { kind: "unknown-node" }).success).toBe(false);
  });
});

describe("dashboardCardSchema", () => {
  it("accepts a valid card", () => {
    expect(
      validate(dashboardCardSchema, {
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
      validate(dashboardCardSchema, {
        pluginId: "aws",
        resourceTypeId: "ec2",
        resourceId: "i-123",
        displayName: "web-server",
      }).success,
    ).toBe(true);
  });

  it("accepts card with badges array", () => {
    expect(
      validate(dashboardCardSchema, {
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
      validate(dashboardCardSchema, {
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
      validate(detailViewSchema, {
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

  it("checks execConsole", () => {
    expect(
      validate(detailViewSchema, { title: "pod", sections: [], execConsole: true }).success,
    ).toBe(true);
    expect(
      validate(detailViewSchema, { title: "pod", sections: [], execConsole: "yes" }).success,
    ).toBe(false);
  });

  it("keeps declared capabilities instead of stripping them", () => {
    const declared = {
      sqlEditor: { connectionStringOutputKey: "dsn" },
      logs: { defaultTailLines: 100 },
      speechPanel: { modes: ["tts"] },
    };
    const result = validate(detailViewSchema, { title: "x", sections: [], ...declared });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject(declared);
    expect(
      validate(detailViewSchema, { title: "x", sections: [], speechPanel: { modes: ["read"] } })
        .success,
    ).toBe(false);
  });

  it("accepts minimal detail view", () => {
    expect(
      validate(detailViewSchema, {
        title: "test",
        sections: [],
      }).success,
    ).toBe(true);
  });

  it("accepts detail view with children (dashboard cards)", () => {
    expect(
      validate(detailViewSchema, {
        title: "Account",
        sections: [{ kind: "section", children: [] }],
        children: [
          { pluginId: "aws", resourceTypeId: "ec2", resourceId: "i-1", displayName: "web" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects missing title", () => {
    expect(validate(detailViewSchema, { sections: [] }).success).toBe(false);
  });

  it("accepts detail view with all action variants", () => {
    expect(
      validate(detailViewSchema, {
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
      validate(detailViewSchema, {
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
