import type { ResourceInstance } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { renderAxiomDetail } from "../render.js";

const instance = (
  resourceTypeId: string,
  fields: ResourceInstance["fields"],
): ResourceInstance => ({
  id: "r1",
  pluginId: "axiom",
  resourceTypeId,
  accountId: "a1",
  displayName: "checkout-logs",
  fields,
  resolvedOutputs: {},
  secretStates: [],
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
});

describe("query editor", () => {
  it("names its query language, so the tab is not labelled SQL", () => {
    const schema = renderAxiomDetail(instance("dataset", { name: "checkout-logs" }));
    expect(schema.sqlEditor?.queryLanguage).toBe("APL");
  });
});
