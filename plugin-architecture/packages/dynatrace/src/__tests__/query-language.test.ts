import type { ResourceInstance } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { renderDynatraceDetail } from "../render.js";

const instance = (
  resourceTypeId: string,
  fields: ResourceInstance["fields"],
): ResourceInstance => ({
  id: "r1",
  pluginId: "dynatrace",
  resourceTypeId,
  accountId: "a1",
  displayName: "production",
  fields,
  resolvedOutputs: {},
  secretStates: [],
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
});

describe("query editor", () => {
  it("names its query language, so the tab is not labelled SQL", () => {
    const schema = renderDynatraceDetail(instance("environment", { grail: true }));
    expect(schema.sqlEditor?.queryLanguage).toBe("DQL");
  });

  it("browses a table clicked in the sidebar in its own language, not SQL", () => {
    const schema = renderDynatraceDetail(instance("environment", { grail: true }));
    expect(schema.sqlEditor?.tableQuery?.replaceAll("{table}", "dt.entity.host")).toBe(
      "fetch dt.entity.host\n| limit 100",
    );
  });
});
