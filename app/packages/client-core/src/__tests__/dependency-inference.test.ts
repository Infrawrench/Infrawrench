import { describe, it, expect } from "vitest";
import {
  collectDependencyRules,
  focusPrefilterTokens,
  inferDependencyEdges,
  type InferenceResource,
} from "../dependency-inference";

function resource(id: string, overrides: Partial<InferenceResource> = {}): InferenceResource {
  return { id, accountId: "acct-a", fields: {}, outputs: {}, ...overrides };
}

/** A resource of a plugin-declared type — the shape a host feeds inference. */
function typed(
  id: string,
  resourceTypeId: string,
  overrides: Partial<InferenceResource> = {},
): InferenceResource {
  return resource(id, { pluginId: "aws", resourceTypeId, ...overrides });
}

describe("inferDependencyEdges", () => {
  it("links a field value to the resource whose external id it names", () => {
    const { edges } = inferDependencyEdges([
      resource("vpc", { externalId: "vpc-0a1b2c3d" }),
      resource("ec2", { externalId: "i-0f00", fields: { vpcId: "vpc-0a1b2c3d" } }),
    ]);
    expect(edges).toEqual([
      {
        consumerResourceId: "ec2",
        consumerFieldKey: "vpcId",
        providerResourceId: "vpc",
        providerOutputKey: "externalId",
        kind: "field-match",
      },
    ]);
  });

  it("matches identity fields and outputs, not just external ids", () => {
    const { edges } = inferDependencyEdges([
      resource("droplet", { externalId: "1234567", outputs: { publicIp: "203.0.113.9" } }),
      resource("dns", {
        accountId: "acct-b",
        fields: { content: "203.0.113.9", type: "A" },
      }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      consumerResourceId: "dns",
      providerResourceId: "droplet",
      providerOutputKey: "publicIp",
    });
  });

  it("splits comma-joined lists into one edge per element", () => {
    const { edges } = inferDependencyEdges([
      resource("sg-a", { externalId: "sg-aaaa1111" }),
      resource("sg-b", { externalId: "sg-bbbb2222" }),
      resource("ec2", { fields: { securityGroups: "sg-aaaa1111,sg-bbbb2222" } }),
    ]);
    expect(edges.map((e) => e.providerResourceId).sort()).toEqual(["sg-a", "sg-b"]);
  });

  it("emits containment edges from the synced parent link", () => {
    const { edges } = inferDependencyEdges([
      resource("cluster"),
      resource("deployment", { parentResourceId: "cluster" }),
    ]);
    expect(edges).toEqual([
      {
        consumerResourceId: "deployment",
        consumerFieldKey: "parent",
        providerResourceId: "cluster",
        providerOutputKey: "id",
        kind: "containment",
      },
    ]);
  });

  it("drops a parent link pointing outside the given resource set", () => {
    const { edges } = inferDependencyEdges([resource("pod", { parentResourceId: "gone" })]);
    expect(edges).toEqual([]);
  });

  it("drops tokens claimed by more than one resource", () => {
    // Two things called "default" — no way to tell which one is meant.
    const { edges } = inferDependencyEdges([
      resource("ns-1", { externalId: "default" }),
      resource("ns-2", { fields: { name: "default" } }),
      resource("pod", { fields: { namespace: "default" } }),
    ]);
    expect(edges).toEqual([]);
  });

  it("keeps weak tokens inside one account and rejects them across accounts", () => {
    const sameAccount = inferDependencyEdges([
      resource("ns", { externalId: "staging" }),
      resource("pod", { fields: { namespace: "staging" } }),
    ]);
    expect(sameAccount.edges).toHaveLength(1);

    const crossAccount = inferDependencyEdges([
      resource("ns", { externalId: "staging" }),
      resource("pod", { accountId: "acct-b", fields: { namespace: "staging" } }),
    ]);
    expect(crossAccount.edges).toEqual([]);
  });

  it("ignores descriptive fields and short values", () => {
    const { edges } = inferDependencyEdges([
      resource("region-ish", { externalId: "nyc3" }),
      resource("port-ish", { externalId: "5432" }),
      resource("droplet", { fields: { region: "nyc3", port: 5432, tags: "nyc3" } }),
    ]);
    expect(edges).toEqual([]);
  });

  it("draws one edge per pair even when several fields point at the same resource", () => {
    const { edges } = inferDependencyEdges([
      resource("vpc", { externalId: "vpc-0a1b2c3d", fields: { name: "core-network" } }),
      resource("ec2", {
        fields: { vpcId: "vpc-0a1b2c3d", network: "core-network" },
      }),
    ]);
    expect(edges).toHaveLength(1);
  });

  it("yields to an existing output reference for the same pair", () => {
    const { edges } = inferDependencyEdges(
      [
        resource("db", { externalId: "db-0a1b2c3d" }),
        resource("api", { fields: { databaseId: "db-0a1b2c3d" } }),
      ],
      {
        existingEdges: [
          {
            consumerResourceId: "api",
            consumerFieldKey: "DATABASE_URL",
            providerResourceId: "db",
            providerOutputKey: "connectionString",
          },
        ],
      },
    );
    expect(edges).toEqual([]);
  });

  it("keeps only edges touching the focused resource", () => {
    const { edges } = inferDependencyEdges(
      [
        resource("vpc", { externalId: "vpc-0a1b2c3d" }),
        resource("ec2", { fields: { vpcId: "vpc-0a1b2c3d" } }),
        resource("other-vpc", { externalId: "vpc-9z8y7x6w" }),
        resource("other-ec2", { fields: { vpcId: "vpc-9z8y7x6w" } }),
      ],
      { focusResourceId: "ec2" },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.consumerResourceId).toBe("ec2");
  });

  it("reports truncation once the edge cap is hit", () => {
    const resources = [resource("vpc", { externalId: "vpc-0a1b2c3d" })];
    for (let i = 0; i < 5; i++) {
      resources.push(resource(`ec2-${i}`, { fields: { vpcId: "vpc-0a1b2c3d" } }));
    }
    const { edges, truncated } = inferDependencyEdges(resources, { maxEdges: 3 });
    expect(edges).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("never links a resource to itself", () => {
    const { edges } = inferDependencyEdges([
      resource("self", {
        externalId: "vpc-0a1b2c3d",
        parentResourceId: "self",
        fields: { vpcId: "vpc-0a1b2c3d" },
      }),
    ]);
    expect(edges).toEqual([]);
  });
});

describe("plugin-declared rules", () => {
  const rules = collectDependencyRules([
    {
      id: "aws",
      resourceTypes: [
        {
          id: "ec2-instance",
          dependsOn: [
            { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
            { fieldKey: "securityGroupIds", targetTypeId: "security-group" },
          ],
        },
        { id: "vpc" },
      ],
    },
  ]);

  it("labels the edge and marks it declared", () => {
    const { edges } = inferDependencyEdges(
      [
        typed("vpc", "vpc", { externalId: "vpc-0a1b2c3d" }),
        typed("ec2", "ec2-instance", { fields: { vpcId: "vpc-0a1b2c3d" } }),
      ],
      { rules },
    );
    expect(edges).toEqual([
      {
        consumerResourceId: "ec2",
        consumerFieldKey: "vpcId",
        providerResourceId: "vpc",
        providerOutputKey: "externalId",
        kind: "declared",
        label: "in VPC",
      },
    ]);
  });

  it("resolves a token the heuristic pass would drop as ambiguous", () => {
    // A load balancer happens to be named after the VPC's id. The rule says
    // "this field names a vpc", so the collision stops mattering.
    const { edges } = inferDependencyEdges(
      [
        typed("vpc", "vpc", { externalId: "shared-name" }),
        typed("alb", "alb", { fields: { name: "shared-name" } }),
        typed("ec2", "ec2-instance", { fields: { vpcId: "shared-name" } }),
      ],
      { rules },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ consumerResourceId: "ec2", providerResourceId: "vpc" });
  });

  it("still refuses to pick when two candidates fit the rule", () => {
    const { edges } = inferDependencyEdges(
      [
        typed("vpc-1", "vpc", { externalId: "dup" }),
        typed("vpc-2", "vpc", { externalId: "dup", accountId: "acct-b" }),
        typed("ec2", "ec2-instance", { accountId: "acct-c", fields: { vpcId: "dup" } }),
      ],
      { rules },
    );
    expect(edges).toEqual([]);
  });

  it("breaks a tie in favour of the consumer's own account", () => {
    const { edges } = inferDependencyEdges(
      [
        typed("vpc-mine", "vpc", { externalId: "dup" }),
        typed("vpc-theirs", "vpc", { externalId: "dup", accountId: "acct-b" }),
        typed("ec2", "ec2-instance", { fields: { vpcId: "dup" } }),
      ],
      { rules },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.providerResourceId).toBe("vpc-mine");
  });

  it("splits a declared list field into one edge per element", () => {
    const { edges } = inferDependencyEdges(
      [
        typed("sg-a", "security-group", { externalId: "sg-a1" }),
        typed("sg-b", "security-group", { externalId: "sg-b2" }),
        typed("ec2", "ec2-instance", { fields: { securityGroupIds: "sg-a1, sg-b2" } }),
      ],
      { rules },
    );
    expect(edges.map((e) => e.providerResourceId).sort()).toEqual(["sg-a", "sg-b"]);
  });

  it("does not fall back to guessing when the declared target is missing", () => {
    const { edges } = inferDependencyEdges(
      [
        typed("sg", "security-group", { externalId: "vpc-lookalike" }),
        typed("ec2", "ec2-instance", { fields: { vpcId: "vpc-lookalike" } }),
      ],
      { rules },
    );
    expect(edges).toEqual([]);
  });

  it("outranks the guessed edge for the same pair", () => {
    const { edges } = inferDependencyEdges(
      [
        typed("vpc", "vpc", { externalId: "vpc-0a1b2c3d", fields: { name: "core-network" } }),
        typed("ec2", "ec2-instance", {
          fields: { vpcId: "vpc-0a1b2c3d", network: "core-network" },
        }),
      ],
      { rules },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.kind).toBe("declared");
  });

  it("matches a rule that targets a non-identity key on the provider", () => {
    const nameRules = collectDependencyRules([
      {
        id: "aws",
        resourceTypes: [
          {
            id: "ecs-service",
            dependsOn: [
              { fieldKey: "cluster", targetTypeId: "eks-cluster", targetKey: "clusterName" },
            ],
          },
        ],
      },
    ]);
    const { edges } = inferDependencyEdges(
      [
        typed("cluster", "eks-cluster", { fields: { clusterName: "prod" } }),
        typed("svc", "ecs-service", { fields: { cluster: "prod" } }),
      ],
      { rules: nameRules },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ providerOutputKey: "clusterName", kind: "declared" });
  });

  it("reads a rule pointed at an output", () => {
    const outputRules = collectDependencyRules([
      {
        id: "cloudflare",
        resourceTypes: [
          {
            id: "dns-record",
            dependsOn: [
              { fieldKey: "target", from: "outputs", targetPluginId: "aws", targetTypeId: "alb" },
            ],
          },
        ],
      },
    ]);
    const { edges } = inferDependencyEdges(
      [
        typed("alb", "alb", { externalId: "prod-lb" }),
        {
          ...resource("dns", { accountId: "acct-b", outputs: { target: "prod-lb" } }),
          pluginId: "cloudflare",
          resourceTypeId: "dns-record",
        },
      ],
      { rules: outputRules },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ consumerResourceId: "dns", providerResourceId: "alb" });
  });
});

describe("matchTemplate", () => {
  // PlanetScale branches have composite external ids ("{db}/{branch}") while
  // consumers hold the bare branch name — the whole reason the template exists.
  const rules = collectDependencyRules([
    {
      id: "planetscale",
      resourceTypes: [
        {
          id: "ps-password",
          dependsOn: [
            {
              fieldKey: "branchName",
              targetTypeId: "ps-branch",
              matchTemplate: "{databaseName}/{branchName}",
              label: "on branch",
            },
          ],
        },
      ],
    },
  ]);

  const branch = (id: string, externalId: string): InferenceResource => ({
    id,
    accountId: "acct-a",
    pluginId: "planetscale",
    resourceTypeId: "ps-branch",
    externalId,
  });

  it("composes the composite key and matches it exactly", () => {
    const { edges } = inferDependencyEdges(
      [
        branch("branch-a", "shop/main"),
        // Same branch name under a different database — the exact composition
        // is what keeps these apart; a bare-name match would be ambiguous.
        branch("branch-b", "blog/main"),
        {
          id: "pw",
          accountId: "acct-a",
          pluginId: "planetscale",
          resourceTypeId: "ps-password",
          fields: { databaseName: "shop", branchName: "main" },
        },
      ],
      { rules },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      providerResourceId: "branch-a",
      consumerFieldKey: "branchName",
      kind: "declared",
      label: "on branch",
    });
  });

  it("expands a comma-joined placeholder per element", () => {
    // "{namespace}/{configMaps}" over "a, b" must qualify BOTH names, not
    // compose "prod/a, b" and leave a bare "b" to match something unrelated.
    const k8sRules = collectDependencyRules([
      {
        id: "k8s",
        resourceTypes: [
          {
            id: "k8s-pod",
            dependsOn: [
              {
                fieldKey: "configMaps",
                targetTypeId: "k8s-configmap",
                targetKey: "qualifiedName",
                matchTemplate: "{namespace}/{configMaps}",
              },
            ],
          },
        ],
      },
    ]);
    const configMap = (id: string, qualifiedName: string): InferenceResource => ({
      id,
      accountId: "acct-a",
      pluginId: "k8s",
      resourceTypeId: "k8s-configmap",
      fields: { qualifiedName },
    });
    const { edges } = inferDependencyEdges(
      [
        configMap("cm-a", "prod/a"),
        configMap("cm-b", "prod/b"),
        // Same names in another namespace — must not be picked up.
        configMap("cm-a-dev", "dev/a"),
        configMap("cm-b-dev", "dev/b"),
        {
          id: "pod",
          accountId: "acct-a",
          pluginId: "k8s",
          resourceTypeId: "k8s-pod",
          fields: { namespace: "prod", configMaps: "a, b" },
        },
      ],
      { rules: k8sRules },
    );
    expect(edges.map((e) => e.providerResourceId).sort()).toEqual(["cm-a", "cm-b"]);
  });

  it("yields nothing when a placeholder is missing", () => {
    const { edges } = inferDependencyEdges(
      [
        branch("branch-a", "shop/main"),
        {
          id: "pw",
          accountId: "acct-a",
          pluginId: "planetscale",
          resourceTypeId: "ps-password",
          fields: { branchName: "main" },
        },
      ],
      { rules },
    );
    expect(edges).toEqual([]);
  });

  it("does not match a half-built key against a real value", () => {
    // "/main" must not find a branch whose id happens to end that way.
    const { edges } = inferDependencyEdges(
      [
        branch("branch-a", "/main"),
        {
          id: "pw",
          accountId: "acct-a",
          pluginId: "planetscale",
          resourceTypeId: "ps-password",
          fields: { databaseName: "", branchName: "main" },
        },
      ],
      { rules },
    );
    expect(edges).toEqual([]);
  });
});

describe("multiple identities for one value", () => {
  // A resource whose `name` equals its `externalId` (azure-resource-group,
  // aws/target-group) must stay findable under BOTH keys — indexing only the
  // first one silently disabled any rule matching on the other.
  it("resolves a rule matching on a key that duplicates the external id", () => {
    const rules = collectDependencyRules([
      {
        id: "aws",
        resourceTypes: [
          {
            id: "alb",
            dependsOn: [
              { fieldKey: "targetGroupName", targetTypeId: "target-group", targetKey: "name" },
            ],
          },
        ],
      },
    ]);
    const { edges } = inferDependencyEdges(
      [
        typed("tg", "target-group", { externalId: "web-tier", fields: { name: "web-tier" } }),
        typed("alb", "alb", { fields: { targetGroupName: "web-tier" } }),
      ],
      { rules },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      providerResourceId: "tg",
      providerOutputKey: "name",
      kind: "declared",
    });
  });

  it("still counts that resource as a single claimant for the guessing pass", () => {
    // Two keys on one resource must not read as two rival claimants.
    const { edges } = inferDependencyEdges([
      resource("tg", { externalId: "web-tier", fields: { name: "web-tier" } }),
      resource("alb", { fields: { someRef: "web-tier" } }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ providerResourceId: "tg", providerOutputKey: "externalId" });
  });
});

describe("index caps", () => {
  // GCP auto-mode: the VPC is named "default" and so is one subnet per region.
  // A per-token cap threw the whole token away and took the network with it.
  it("keeps a declared target findable when many same-typed resources share its name", () => {
    const rules = collectDependencyRules([
      {
        id: "gcp",
        resourceTypes: [
          {
            id: "gce-instance",
            dependsOn: [{ fieldKey: "network", targetTypeId: "vpc-network", targetKey: "name" }],
          },
        ],
      },
    ]);
    const resources: InferenceResource[] = [
      {
        id: "vpc",
        accountId: "acct-a",
        pluginId: "gcp",
        resourceTypeId: "vpc-network",
        fields: { name: "default" },
      },
    ];
    for (let i = 0; i < 40; i++) {
      resources.push({
        id: `subnet-${i}`,
        accountId: "acct-a",
        pluginId: "gcp",
        resourceTypeId: "subnet",
        fields: { name: "default" },
      });
    }
    resources.push({
      id: "vm",
      accountId: "acct-a",
      pluginId: "gcp",
      resourceTypeId: "gce-instance",
      fields: { network: "default" },
    });

    const { edges } = inferDependencyEdges(resources, { rules });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ providerResourceId: "vpc", kind: "declared" });
  });

  it("still refuses the guessed edge when a token has several claimants", () => {
    const resources: InferenceResource[] = [];
    for (let i = 0; i < 30; i++) {
      resources.push({
        id: `ns-${i}`,
        accountId: "acct-a",
        pluginId: "k8s",
        resourceTypeId: "k8s-namespace",
        fields: { name: "shared-name" },
      });
    }
    resources.push({
      id: "consumer",
      accountId: "acct-a",
      pluginId: "k8s",
      resourceTypeId: "k8s-pod",
      fields: { someRef: "shared-name" },
    });
    expect(inferDependencyEdges(resources).edges).toEqual([]);
  });
});

describe("targetKey scoping", () => {
  // Docker matches images on `tags`. That must not turn every `tags` field in
  // every other plugin into an identity the guessing pass can match on.
  const rules = collectDependencyRules([
    {
      id: "docker",
      resourceTypes: [
        {
          id: "docker-container",
          dependsOn: [{ fieldKey: "image", targetTypeId: "docker-image", targetKey: "tags" }],
        },
      ],
    },
  ]);

  it("indexes the extra key for the targeted type", () => {
    const { edges } = inferDependencyEdges(
      [
        typed("image", "docker-image", { pluginId: "docker", fields: { tags: "nginx:latest" } }),
        typed("container", "docker-container", {
          pluginId: "docker",
          fields: { image: "nginx:latest" },
        }),
      ],
      { rules },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ providerOutputKey: "tags", kind: "declared" });
  });

  it("does not make `tags` an identity for unrelated plugins", () => {
    const { edges } = inferDependencyEdges(
      [
        typed("droplet", "droplet", { pluginId: "digitalocean", fields: { tags: "web-tier" } }),
        typed("lb", "load-balancer", {
          pluginId: "digitalocean",
          fields: { someField: "web-tier" },
        }),
      ],
      { rules },
    );
    expect(edges).toEqual([]);
  });
});

describe("focusPrefilterTokens", () => {
  const rules = collectDependencyRules([
    {
      id: "aws",
      resourceTypes: [
        {
          id: "lambda-function",
          dependsOn: [{ fieldKey: "roleArn", targetTypeId: "iam-role", targetKey: "roleArn" }],
        },
        {
          id: "azure-vm",
          dependsOn: [
            {
              fieldKey: "subnetName",
              targetTypeId: "subnet",
              matchTemplate: "{networkResourceGroup}/{vnetName}/{subnetName}",
            },
          ],
        },
      ],
    },
  ]);

  it("includes identity keys a rule names, not just the built-in ones", () => {
    // The role's dependents store `roleArn`; without this the focused query
    // never loads them and "Depended on by" is empty on the detail page.
    const role = typed("role", "iam-role", {
      externalId: "my-role",
      outputs: { roleArn: "arn:aws:iam::1:role/my-role" },
    });
    expect(focusPrefilterTokens(role, rules)).toContain("arn:aws:iam::1:role/my-role");
    // Without the rules it is invisible — `roleArn` is not a built-in identity.
    expect(focusPrefilterTokens(role)).not.toContain("arn:aws:iam::1:role/my-role");
  });

  it("emits list elements and never the joined whole", () => {
    const ec2 = typed("ec2", "ec2-instance", {
      fields: { securityGroupIds: "sg-aaaa1111, sg-bbbb2222" },
    });
    const tokens = focusPrefilterTokens(ec2);
    expect(tokens).toContain("sg-aaaa1111");
    expect(tokens).toContain("sg-bbbb2222");
    // The joined value is the longest string present and can match no identity,
    // so it would otherwise eat the caller's length-ordered budget.
    expect(tokens.some((t) => t.includes(","))).toBe(false);
  });

  it("includes the value a matchTemplate rule composes", () => {
    const vm = typed("vm", "azure-vm", {
      fields: { networkResourceGroup: "rg", vnetName: "core", subnetName: "web" },
    });
    expect(focusPrefilterTokens(vm, rules)).toContain("rg/core/web");
  });

  it("returns tokens longest first", () => {
    const tokens = focusPrefilterTokens(
      typed("x", "thing", { externalId: "aaaa", fields: { name: "bbbbbbbb" } }),
    );
    expect(tokens).toEqual([...tokens].sort((a, b) => b.length - a.length));
  });
});
