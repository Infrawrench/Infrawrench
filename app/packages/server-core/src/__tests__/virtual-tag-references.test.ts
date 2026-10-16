/**
 * Tags built on tags, at the service layer: the save-time graph check, the
 * delete guard, the transitive load the readers compile from, re-queueing the
 * tags that depend on an edited one, and the pass's evaluation order. The
 * graph rules themselves are tested purely in client-core
 * (`virtual-tag-graph.test.ts`); these tests are about the wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VIRTUAL_TAG_RULE, type VirtualTagRule } from "@infrawrench/client-core";
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const service = await import("../cost/virtual-tags");
const { orderClaimedVirtualTags } = await import("../cost/virtual-tag-pass");

function rule(query: string, value = "x"): VirtualTagRule {
  return { ...DEFAULT_VIRTUAL_TAG_RULE, query, value };
}

const T0 = new Date("2026-10-01T00:00:00Z");

/** A full `virtual_tags` row, keys in table (projection) order. */
function row(id: string, key: string, rules: VirtualTagRule[]) {
  return {
    id,
    organizationId: "org",
    key,
    name: key,
    description: null,
    defaultValue: null,
    rules,
    processingState: "ready",
    nextProcessAt: T0,
    processedAt: null,
    processingError: null,
    stats: null,
    createdByUserId: null,
    createdAt: T0,
    updatedAt: T0,
  };
}

beforeEach(() => pg.reset());

describe("saving a tag that filters on another", () => {
  it("refuses a cycle, naming it, before writing anything", async () => {
    pg.queueRows([{ key: "team", rules: [rule("virtual_tag['unit'] = 'commerce'")] }]);
    await expect(
      service.createVirtualTag("org", {
        key: "unit",
        name: "Unit",
        rules: [rule("virtual_tag['team'] = 'payments'", "commerce")],
      }),
    ).rejects.toThrow("unit → team → unit");
    expect(pg.queries.some((q) => /insert/i.test(q.sql))).toBe(false);
  });

  it("refuses a reference to a tag that does not exist", async () => {
    pg.queueRows([]);
    await expect(
      service.createVirtualTag("org", {
        key: "unit",
        name: "Unit",
        rules: [rule("virtual_tag['ghost'] = 'x'")],
      }),
    ).rejects.toBeInstanceOf(service.VirtualTagError);
  });

  it("skips the graph read entirely for a tag with no references and no split", async () => {
    pg.queueRows([]); // the per-org count
    pg.queueRows([row("vt-1", "team", [rule("provider = 'aws'")])]);
    await service.createVirtualTag("org", {
      key: "team",
      name: "Team",
      rules: [rule("provider = 'aws'")],
    });
    expect(pg.queries.filter((q) => /"virtual_tags"/.test(q.sql))).toHaveLength(2);
  });
});

describe("editing a tag other tags filter on", () => {
  it("re-queues every dependent, nearest first", async () => {
    const team = row("vt-team", "team", [rule("provider = 'aws'", "payments")]);
    pg.queueRows([team]); // getVirtualTag
    pg.queueRows([team]); // update … returning
    pg.queueRows([
      { id: "vt-team", key: "team", rules: team.rules },
      { id: "vt-unit", key: "unit", rules: [rule("virtual_tag['team'] = 'payments'")] },
      { id: "vt-div", key: "division", rules: [rule("virtual_tag['unit'] = 'x'")] },
      { id: "vt-other", key: "other", rules: [rule("provider = 'gcp'")] },
    ]);
    pg.queueRows([]);
    pg.queueRows([]);
    await service.updateVirtualTag("org", "vt-team", {
      key: "team",
      name: "Team",
      rules: team.rules,
    });
    const requeues = pg.queries.filter((q) => /update "virtual_tags"/i.test(q.sql)).slice(1);
    expect(requeues).toHaveLength(2);
    expect(requeues[0]!.params).toContain("vt-unit");
    expect(requeues[1]!.params).toContain("vt-div");
    expect(requeues.flatMap((q) => q.params)).not.toContain("vt-other");
  });
});

describe("deleting a tag", () => {
  it("is refused while another virtual tag filters on it", async () => {
    pg.queueRows([row("vt-team", "team", [])]);
    pg.queueRows([
      { id: "vt-team", key: "team", rules: [] },
      { id: "vt-unit", key: "unit", rules: [rule("virtual_tag['team'] IS SET")] },
    ]);
    for (let i = 0; i < 8; i += 1) pg.queueRows([]);
    await expect(service.deleteVirtualTag("org", "vt-team")).rejects.toThrow('virtual tag "unit"');
  });
});

describe("loading definitions for a read", () => {
  it("follows references transitively and wires each tag's dependencies", async () => {
    pg.queueRows([row("vt-unit", "unit", [rule("virtual_tag['team'] = 'payments'", "commerce")])]);
    pg.queueRows([row("vt-team", "team", [rule("virtual_tag['owner'] IS SET", "payments")])]);
    pg.queueRows([row("vt-owner", "owner", [rule("provider = 'aws'", "me")])]);
    const defs = await service.loadVirtualTagDefinitions(
      "org",
      ["unit"],
      "2026-08-01",
      "2026-08-31",
    );
    expect([...defs.keys()]).toEqual(["unit"]);
    const team = defs.get("unit")!.dependencies!.get("team")!;
    expect(team.key).toBe("team");
    expect(team.dependencies!.get("owner")!.key).toBe("owner");
    // One read per level: unit, then team, then owner.
    expect(pg.queries).toHaveLength(3);
  });
});

describe("the processing pass", () => {
  it("evaluates a claimed batch per organization, dependencies first", () => {
    const claimed = [
      {
        id: "1",
        organizationId: "a",
        key: "unit",
        defaultValue: null,
        updatedAt: "",
        rules: [rule("virtual_tag['team'] = 'x'")],
      },
      { id: "2", organizationId: "b", key: "solo", defaultValue: null, updatedAt: "", rules: [] },
      { id: "3", organizationId: "a", key: "team", defaultValue: null, updatedAt: "", rules: [] },
    ];
    const groups = orderClaimedVirtualTags(claimed);
    expect(groups.map((g) => g.map((t) => t.key))).toEqual([["team", "unit"], ["solo"]]);
  });
});
