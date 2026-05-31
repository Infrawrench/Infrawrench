import { describe, it, expect } from "vitest";
import { normalizeResourceCreateResult } from "../instance.js";
import type { ResourceInstance } from "../instance.js";
import { evaluatePeerIntegrationUnreachable } from "../resource.js";
import type { PeerPluginIntegration } from "../resource.js";

const resource: ResourceInstance = {
  id: "r-1",
  pluginId: "do",
  resourceTypeId: "droplet",
  accountId: "a-1",
  displayName: "web",
  fields: {},
  resolvedOutputs: {},
  secretStates: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("normalizeResourceCreateResult", () => {
  it("wraps a bare ResourceInstance with empty warnings", () => {
    expect(normalizeResourceCreateResult(resource)).toEqual({ resource, warnings: [] });
  });

  it("passes through an envelope result unchanged", () => {
    const envelope = {
      resource,
      warnings: [{ code: "x", message: "y" }],
      credentialUpdates: { spacesKey: "abc" },
    };
    expect(normalizeResourceCreateResult(envelope)).toBe(envelope);
  });
});

describe("evaluatePeerIntegrationUnreachable", () => {
  const base: PeerPluginIntegration = {
    pluginId: "postgres",
    credentialMappings: [{ outputKey: "connectionString", credentialKey: "connStr" }],
    tabLabel: "SQL",
  };

  it("returns null when no unreachableWhen rule is declared", () => {
    expect(evaluatePeerIntegrationUnreachable(base, { publicIp: "" })).toBeNull();
  });

  it("returns guidance when all listed fields are empty", () => {
    const integration: PeerPluginIntegration = {
      ...base,
      unreachableWhen: {
        fieldsEmpty: ["publicIp"],
        title: "No public endpoint",
        suggestions: ["Enable public IP"],
      },
    };
    expect(evaluatePeerIntegrationUnreachable(integration, { publicIp: "" })).toEqual({
      title: "No public endpoint",
      suggestions: ["Enable public IP"],
    });
  });

  it("treats missing/null fields as empty", () => {
    const integration: PeerPluginIntegration = {
      ...base,
      unreachableWhen: {
        fieldsEmpty: ["publicIp", "endpoint"],
        title: "t",
        suggestions: [],
      },
    };
    expect(evaluatePeerIntegrationUnreachable(integration, { publicIp: null as never })).toEqual({
      title: "t",
      suggestions: [],
    });
    // undefined fields object entirely
    expect(evaluatePeerIntegrationUnreachable(integration, undefined)).toEqual({
      title: "t",
      suggestions: [],
    });
  });

  it("returns null when any listed field is non-empty", () => {
    const integration: PeerPluginIntegration = {
      ...base,
      unreachableWhen: {
        fieldsEmpty: ["publicIp"],
        title: "t",
        suggestions: [],
      },
    };
    expect(evaluatePeerIntegrationUnreachable(integration, { publicIp: "1.2.3.4" })).toBeNull();
  });
});
