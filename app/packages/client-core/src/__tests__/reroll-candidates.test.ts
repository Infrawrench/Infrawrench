import { describe, expect, it } from "vitest";
import type { PeerPluginIntegration } from "@infrawrench/plugin-base";
import {
  rerollCandidates,
  rerollRequest,
  rerollSources,
  type RerollCandidateRow,
  type RerollSourcePlugin,
} from "../reroll-candidates";

const pgTab: PeerPluginIntegration = {
  pluginId: "postgres",
  tabLabel: "PostgreSQL",
  credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
  showWhen: { fieldKey: "engine", equals: "pg" },
};
const mysqlTab: PeerPluginIntegration = {
  pluginId: "mysql",
  tabLabel: "MySQL",
  credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
  showWhen: { fieldKey: "engine", equals: "mysql" },
};
const neonTab: PeerPluginIntegration = {
  pluginId: "postgres",
  tabLabel: "PostgreSQL",
  credentialMappings: [
    { outputKey: "connectionString", credentialKey: "connectionString" },
    { outputKey: "caCert", credentialKey: "caCert" },
  ],
};

const plugins: RerollSourcePlugin[] = [
  {
    pluginId: "digitalocean",
    resourceTypes: [
      { id: "managed-database", peerIntegrations: [pgTab, mysqlTab] },
      { id: "droplet" },
    ],
  },
  { pluginId: "neon", resourceTypes: [{ id: "branch", peerIntegrations: [neonTab] }] },
  { pluginId: "supabase", resourceTypes: [{ id: "project" }] },
  {
    pluginId: "postgres",
    resourceTypes: [
      {
        id: "database",
        fields: [
          {
            key: "connectionString",
            // The field names its own sources: one a peer integration already
            // covers, one it alone knows, and one no loaded plugin has.
            resolvableFrom: [
              {
                pluginId: "digitalocean",
                resourceTypeId: "managed-database",
                outputKey: "connectionString",
              },
              { pluginId: "supabase", resourceTypeId: "project", outputKey: "connectionString" },
              { pluginId: "neon", resourceTypeId: "neon-database", outputKey: "connectionString" },
            ],
          },
        ],
      },
    ],
  },
  { pluginId: "mysql", resourceTypes: [{ id: "database" }] },
];

const PG_DB = { pluginId: "postgres", resourceTypeId: "database" };
const MYSQL_DB = { pluginId: "mysql", resourceTypeId: "database" };

function row(partial: Partial<RerollCandidateRow> & { id: string }): RerollCandidateRow {
  return {
    pluginId: "digitalocean",
    resourceTypeId: "managed-database",
    accountId: "acct-do",
    displayName: partial.id,
    fields: { engine: "pg" },
    ...partial,
  };
}

describe("rerollSources", () => {
  it("finds every type output mapped onto the consumer plugin's field", () => {
    const sources = rerollSources(plugins, PG_DB, "connectionString");
    expect(sources.map((s) => `${s.pluginId}/${s.resourceTypeId}/${s.outputKey}`)).toEqual([
      "digitalocean/managed-database/connectionString",
      "neon/branch/connectionString",
      "supabase/project/connectionString",
    ]);
  });

  it("adds the field's own sources, unless an integration speaks for the type", () => {
    const sources = rerollSources(plugins, PG_DB, "connectionString");
    // Declared by the field and gated by nothing.
    expect(sources.find((s) => s.pluginId === "supabase")?.integration).toBeUndefined();
    // Declared by the field too, but the integration (and its gate) wins.
    expect(sources.filter((s) => s.resourceTypeId === "managed-database")).toHaveLength(1);
    // A type no plugin has is no source.
    expect(sources.some((s) => s.resourceTypeId === "neon-database")).toBe(false);
  });

  it("matches on the credential key, not the output key", () => {
    expect(rerollSources(plugins, PG_DB, "caCert")).toHaveLength(1);
    expect(rerollSources(plugins, PG_DB, "rootPassword")).toEqual([]);
  });

  it("ignores integrations that target another plugin", () => {
    const sources = rerollSources(plugins, MYSQL_DB, "connectionString");
    expect(sources).toHaveLength(1);
    expect(sources[0]!.integration).toBe(mysqlTab);
  });
});

describe("rerollCandidates", () => {
  const sources = rerollSources(plugins, PG_DB, "connectionString");

  it("lists rows of a source type that pass its visibility gate, sorted by name", () => {
    const candidates = rerollCandidates(
      sources,
      [
        row({ id: "do-pg", displayName: "orders-db" }),
        row({ id: "do-mysql", displayName: "legacy", fields: { engine: "mysql" } }),
        row({
          id: "neon-main",
          pluginId: "neon",
          resourceTypeId: "branch",
          accountId: "acct-neon",
          displayName: "main",
          fields: {},
        }),
        row({ id: "droplet-1", resourceTypeId: "droplet" }),
        row({
          id: "sb-1",
          pluginId: "supabase",
          resourceTypeId: "project",
          accountId: "acct-sb",
          displayName: "storefront",
          fields: {},
        }),
      ],
      "pg-consumer",
    );
    expect(candidates).toEqual([
      {
        resourceId: "neon-main",
        pluginId: "neon",
        resourceTypeId: "branch",
        accountId: "acct-neon",
        displayName: "main",
        outputKey: "connectionString",
      },
      {
        resourceId: "do-pg",
        pluginId: "digitalocean",
        resourceTypeId: "managed-database",
        accountId: "acct-do",
        displayName: "orders-db",
        outputKey: "connectionString",
      },
      {
        resourceId: "sb-1",
        pluginId: "supabase",
        resourceTypeId: "project",
        accountId: "acct-sb",
        displayName: "storefront",
        outputKey: "connectionString",
      },
    ]);
  });

  it("never offers the consumer itself, and lists a row once", () => {
    const candidates = rerollCandidates(
      sources,
      [row({ id: "self" }), row({ id: "do-pg" }), row({ id: "do-pg" })],
      "self",
    );
    expect(candidates.map((c) => c.resourceId)).toEqual(["do-pg"]);
  });

  it("offers nothing when no plugin feeds the field", () => {
    expect(rerollCandidates([], [row({ id: "do-pg" })], "x")).toEqual([]);
  });
});

describe("rerollRequest", () => {
  it("stores a pasted value through the literal endpoint", () => {
    expect(rerollRequest("r1", "rootPassword", { kind: "literal", value: "s3cret" })).toEqual({
      endpoint: "literal",
      payload: { resourceId: "r1", fieldKey: "rootPassword", plaintextValue: "s3cret" },
    });
  });

  it("points the field at a picked resource's output through the create endpoint", () => {
    expect(
      rerollRequest("r1", "connectionString", {
        kind: "output-ref",
        providerResourceId: "do-pg",
        providerPluginId: "digitalocean",
        providerResourceTypeId: "managed-database",
        providerAccountId: "acct-do",
        providerOutputKey: "connectionString",
      }),
    ).toEqual({
      endpoint: "create",
      payload: {
        consumerResourceId: "r1",
        consumerFieldKey: "connectionString",
        providerResourceId: "do-pg",
        providerOutputKey: "connectionString",
        providerPluginId: "digitalocean",
        providerResourceTypeId: "managed-database",
        providerAccountId: "acct-do",
      },
    });
  });
});
