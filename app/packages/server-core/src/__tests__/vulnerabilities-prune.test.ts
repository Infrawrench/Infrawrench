import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VulnerabilityFinding } from "@infrawrench/plugin-base";
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

let listed: VulnerabilityFinding[] = [];
vi.mock("../sync-resources", () => ({
  loadAccountClient: async () => ({
    account: { pluginId: "fake" },
    plugin: { manifest: { vulnerabilities: { label: "Scanner" } } },
    client: { listVulnerabilityFindings: async () => listed },
  }),
}));

const { collectAccountVulnerabilities } = await import("../vulnerabilities/collect");

function finding(id: string): VulnerabilityFinding {
  return {
    id,
    advisoryId: "CVE-2024-0001",
    severity: "high",
    artifact: { kind: "image", name: "repo/app" },
  };
}

const deletes = () =>
  pg.queries.filter((q) => q.sql.startsWith('delete from "account_vulnerability_findings"'));

describe("the findings prune", () => {
  beforeEach(() => {
    pg.reset();
    listed = [];
  });

  it("binds what is gone, not one parameter per finding it read", async () => {
    listed = [finding("kept-1"), finding("kept-2")];
    pg.queueRows([]); // upsert
    pg.queueRows([]); // upsert
    pg.queueRows([{ findingId: "kept-1" }, { findingId: "kept-2" }, { findingId: "fixed" }]);

    await collectAccountVulnerabilities("acc-1", "org-1");

    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]!.params).toContain("fixed");
    expect(deletes()[0]!.params).not.toContain("kept-1");
  });

  it("deletes nothing when nothing is gone", async () => {
    listed = [finding("kept-1")];
    pg.queueRows([]); // upsert
    pg.queueRows([{ findingId: "kept-1" }]);

    await collectAccountVulnerabilities("acc-1", "org-1");

    expect(deletes()).toHaveLength(0);
  });

  it("deletes every stored finding when the scanner reports none", async () => {
    pg.queueRows([{ findingId: "fixed-1" }, { findingId: "fixed-2" }]);

    await collectAccountVulnerabilities("acc-1", "org-1");

    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]!.params).toEqual(expect.arrayContaining(["fixed-1", "fixed-2"]));
  });
});
