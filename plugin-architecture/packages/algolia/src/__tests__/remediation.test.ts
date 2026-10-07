import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { algoliaRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "products", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
const lines = (finding: RemediationFinding) =>
  algoliaRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);

describe("algoliaRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(algoliaRemediationCommands);
  });

  it("saves settings, then deletes an empty index", () => {
    expect(lines({ kind: "orphan", reason: "empty", resource: res("index", "products") }))
      .toMatchInlineSnapshot(`
      [
        "- algolia settings get products > products-settings-20261004.json",
        "! algolia indices delete products --confirm",
      ]
    `);
  });

  it("quotes hostile index names", () => {
    expect(lines({ kind: "orphan", reason: "empty", resource: res("index", "a b; rm -rf ~") }))
      .toMatchInlineSnapshot(`
      [
        "- algolia settings get 'a b; rm -rf ~' > a_b__rm_-rf__-settings-20261004.json",
        "! algolia indices delete 'a b; rm -rf ~' --confirm",
      ]
    `);
  });

  it("pauses and resumes a crawler", () => {
    const finding: RemediationFinding = {
      kind: "sleep-schedule",
      resource: res("crawler", "c-123", { crawlerId: "c-123" }),
    };
    expect(lines(finding)).toMatchInlineSnapshot(`
      [
        "- algolia crawler pause c-123",
        "- algolia crawler run c-123",
      ]
    `);
    expect(algoliaRemediationCommands(finding)[0]!.placeholders?.map((p) => p.name)).toEqual([
      "ALGOLIA_CRAWLER_USER_ID",
      "ALGOLIA_CRAWLER_API_KEY",
    ]);
  });

  it("returns nothing it cannot address", () => {
    expect(lines({ kind: "orphan", reason: "x", resource: res("index", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("crawler", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("index", "products") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("api-key", "k") })).toEqual([]);
  });
});
