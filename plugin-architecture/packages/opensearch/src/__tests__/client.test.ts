import { describe, expect, it, vi } from "vitest";
import type { DetailViewSchema, HostServices, ResourceInstance } from "@infrawrench/plugin-base";
import { OpenSearchClient } from "../client.js";

function hostHttp() {
  const request = vi.fn(async () => ({ status: 200, body: "{}" }));
  const services = { http: { request } } as unknown as HostServices;
  return { services, request };
}

function client(services?: HostServices) {
  return new OpenSearchClient(
    {
      endpoint: "https://search.example.com:9200",
      username: "admin",
      password: "secret",
    },
    services,
  );
}

function resource(fields: Record<string, unknown>): ResourceInstance {
  return {
    id: "acct:opensearch-cluster:search.example.com:9200",
    pluginId: "opensearch",
    resourceTypeId: "opensearch-cluster",
    accountId: "acct",
    displayName: "cluster-a",
    fields: {
      endpoint: "https://search.example.com:9200",
      ...fields,
    },
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("OpenSearchClient", () => {
  it("routes open and close index actions through documented endpoints", async () => {
    const { services, request } = hostHttp();
    const c = client(services);

    await c.invokeAction("opensearch-cluster", "cluster", "open-index:logs-2026", "acct");
    await c.invokeAction("opensearch-cluster", "cluster", "close-index:logs-2026", "acct");

    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "https://search.example.com:9200/logs-2026/_open",
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        url: "https://search.example.com:9200/logs-2026/_close",
      }),
    );
  });

  it("renders close for open indices and open for closed indices", () => {
    const c = client();
    const detail = c.renderDetail(
      resource({
        __indices: JSON.stringify([
          {
            index: "open-index",
            health: "green",
            status: "open",
            uuid: "u1",
            pri: "1",
            rep: "1",
            "docs.count": "10",
            "docs.deleted": "0",
            "store.size": "1024",
            "pri.store.size": "512",
          },
          {
            index: "closed-index",
            health: "green",
            status: "close",
            uuid: "u2",
            pri: "1",
            rep: "1",
            "docs.count": "0",
            "docs.deleted": "0",
            "store.size": "0",
            "pri.store.size": "0",
          },
        ]),
      }),
    ) as DetailViewSchema;

    const indexTable = detail.sections
      .flatMap((section) => section.children)
      .find((child) => child.kind === "table" && child.columns.some((col) => col.key === "index"));

    expect(indexTable?.kind).toBe("table");
    if (indexTable?.kind !== "table") throw new Error("expected indices table");

    expect(indexTable.rows[0]?.cells["openClose"]).toMatchObject({
      label: "Close",
      action: { actionId: "close-index:open-index" },
    });
    expect(indexTable.rows[1]?.cells["openClose"]).toMatchObject({
      label: "Open",
      action: { actionId: "open-index:closed-index" },
    });
  });
});
