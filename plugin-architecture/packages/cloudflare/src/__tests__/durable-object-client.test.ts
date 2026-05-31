import { describe, it, expect, vi } from "vitest";
import {
  listDurableObjectNamespaces,
  listDurableObjectInstances,
} from "../clients/durable-object-namespace-client.js";
import { renderDurableObjectNamespaceDetail } from "../detail-renderers/compute.js";
import type { ResourceInstance, SectionNode, TableNode } from "@infrawrench/plugin-base";
import { makeApi, asyncIter } from "./_helpers.js";

function doApi(over: Record<string, unknown> = {}) {
  const namespaces = {
    list: vi.fn(() =>
      asyncIter([
        { id: "ns1", name: "Counter", class: "Counter", script: "app", use_sqlite: true },
      ]),
    ),
    objects: {
      list: vi.fn(() =>
        asyncIter([
          { id: "abc123", hasStoredData: true },
          { id: "def456", hasStoredData: false },
        ]),
      ),
    },
  };
  return makeApi({ cf: { durableObjects: { namespaces } }, ...over });
}

function baseResource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:durable-object-namespace:ns1",
    pluginId: "cloudflare",
    resourceTypeId: "durable-object-namespace",
    accountId: "acct",
    displayName: "Counter",
    fields: { name: "Counter", class: "Counter", script: "app", useSqlite: true },
    resolvedOutputs: { namespaceId: "ns1" },
    secretStates: [],
    externalId: "ns1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** Pull the "Instances" section out of a rendered detail view. */
function instancesSection(resource: ResourceInstance): SectionNode {
  const view = renderDurableObjectNamespaceDetail(resource);
  const section = view.sections.find(
    (s): s is SectionNode => s.kind === "section" && s.title.startsWith("Instances"),
  );
  expect(section).toBeDefined();
  return section!;
}

describe("durable-object-namespace-client", () => {
  it("listDurableObjectNamespaces maps namespaces", async () => {
    const api = doApi();
    const out = await listDurableObjectNamespaces(api, "acct");
    expect(out[0]!.id).toBe("acct:durable-object-namespace:ns1");
    expect(out[0]!.fields.useSqlite).toBe(true);
    expect(out[0]!.resolvedOutputs.namespaceId).toBe("ns1");
  });

  it("listDurableObjectInstances pages instances scoped to the namespace", async () => {
    const api = doApi();
    const out = await listDurableObjectInstances(api, "ns1");
    expect(api.cf.durableObjects.namespaces.objects.list).toHaveBeenCalledWith("ns1", {
      account_id: "acct-cf",
      limit: 1000,
    });
    expect(out.truncated).toBe(false);
    expect(out.instances).toEqual([
      { id: "abc123", hasStoredData: true },
      { id: "def456", hasStoredData: false },
    ]);
  });

  it("listDurableObjectInstances caps the fetch and flags truncation", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `o${i}`, hasStoredData: false }));
    const api = doApi({
      cf: { durableObjects: { namespaces: { objects: { list: vi.fn(() => asyncIter(many)) } } } },
    });
    const out = await listDurableObjectInstances(api, "ns1");
    expect(out.truncated).toBe(true);
    expect(out.instances).toHaveLength(500);
  });
});

describe("renderDurableObjectNamespaceDetail", () => {
  it("renders an instance table from stashed resolvedOutputs", () => {
    const resource = baseResource({
      resolvedOutputs: {
        namespaceId: "ns1",
        __instances__: JSON.stringify([{ id: "abc123", hasStoredData: true }]),
        __instancesTruncated__: "false",
      },
    });
    const section = instancesSection(resource);
    const table = section.children.find((c): c is TableNode => c.kind === "table");
    expect(table).toBeDefined();
    expect(table!.rows[0]!.cells).toEqual({ id: "abc123", stored: "Yes" });
    expect(section.title).toBe("Instances (1)");
  });

  it("marks the count with a + and adds a note when truncated", () => {
    const insts = Array.from({ length: 500 }, (_, i) => ({ id: `o${i}`, hasStoredData: false }));
    const resource = baseResource({
      resolvedOutputs: {
        namespaceId: "ns1",
        __instances__: JSON.stringify(insts),
        __instancesTruncated__: "true",
      },
    });
    const section = instancesSection(resource);
    expect(section.title).toBe("Instances (500+)");
    const notes = section.children.filter((c) => c.kind === "text");
    expect(notes.some((n) => "content" in n && n.content.includes("has more"))).toBe(true);
  });

  it("shows an empty state when there are no instances", () => {
    const section = instancesSection(baseResource());
    expect(section.children.some((c) => c.kind === "table")).toBe(false);
    expect(
      section.children.some(
        (c) => c.kind === "text" && "content" in c && /No live instances/.test(c.content),
      ),
    ).toBe(true);
  });

  it("exposes the Metrics tab", () => {
    expect(renderDurableObjectNamespaceDetail(baseResource()).metricsCapability).toBeDefined();
  });
});
