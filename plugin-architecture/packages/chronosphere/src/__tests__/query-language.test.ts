import type { ResourceInstance } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { renderChronoDetail } from "../render.js";

const instance = (
  resourceTypeId: string,
  fields: ResourceInstance["fields"],
): ResourceInstance => ({
  id: "r1",
  pluginId: "chronosphere",
  resourceTypeId,
  accountId: "a1",
  displayName: "northwind",
  fields,
  resolvedOutputs: {},
  secretStates: [],
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
});

describe("query editor", () => {
  it("names its query language, so the tab is not labelled SQL", () => {
    const schema = renderChronoDetail(instance("tenant", {}));
    expect(schema.sqlEditor?.queryLanguage).toBe("PromQL");
  });

  it("browses a table clicked in the sidebar in its own language, not SQL", () => {
    const schema = renderChronoDetail(instance("tenant", {}));
    expect(schema.sqlEditor?.tableQuery).toBe("{table}");
  });
});
