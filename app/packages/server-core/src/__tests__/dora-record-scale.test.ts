import { describe, expect, it, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { recordDeployEventsFromSync } = await import("../dora/record");

describe("recordDeployEventsFromSync", () => {
  it("reads missing deploy targets in statements that stay well under the bind limit", async () => {
    const fetched: ResourceInstance[] = Array.from({ length: 12_000 }, (_, i) => ({
      id: `acc-1:deployment:${i}`,
      pluginId: "fake",
      resourceTypeId: "deployment",
      accountId: "acc-1",
      displayName: `Deployment ${i}`,
      externalId: String(i),
      parentResourceId: `acc-1:project:${i}`,
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    }));
    // Only `deployEvents` is read.
    const plugin = { deployEvents: { resourceTypeIds: ["deployment"], toDeployEvent: () => null } };

    await recordDeployEventsFromSync("org-1", "acc-1", plugin as never, fetched);

    const reads = pg.queries.filter((q) => q.sql.startsWith("select"));
    expect(reads.length).toBeGreaterThan(1);
    for (const read of reads) expect(read.params.length).toBeLessThan(10_100);
    const targets = reads.flatMap((read) => read.params);
    expect(targets).toContain("acc-1:project:0");
    expect(targets).toContain("acc-1:project:11999");
  });
});
