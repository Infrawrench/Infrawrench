import { describe, expect, it } from "vitest";
import { SEARCH_RESULT_KINDS, type SearchResult } from "@infrawrench/client-core";
import { starredItemHref } from "../starred";

const item = (kind: SearchResult["kind"], id = "x"): SearchResult => ({
  id,
  kind,
  pluginId: kind === "resource" ? "aws" : "__objects__",
  pluginDisplayName: "",
  pluginLogoSvg: "",
  resourceTypeId: kind === "resource" ? "ec2" : String(kind),
  resourceTypeLabel: "",
  accountId: "",
  accountName: "",
  displayName: "X",
});

describe("starredItemHref", () => {
  it("opens objects with a screen by id", () => {
    expect(starredItemHref("o", item("cost_report", "r/1"))).toBe("/org/o/cost-reports/r%2F1");
    expect(starredItemHref("o", item("resource", "i-1"))).toBe("/org/o/resources/aws/ec2/i-1");
  });

  it("returns null for kinds the phone has no screen for", () => {
    expect(starredItemHref("o", item("runbook"))).toBeNull();
  });

  it("answers every kind", () => {
    for (const kind of SEARCH_RESULT_KINDS) {
      expect(() => starredItemHref("o", item(kind))).not.toThrow();
    }
  });
});
