import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboard, pinResource } from "../pins";
import type { DbClient } from "../../db/client";
import type { DraggableResource } from "@infrawrench/ui";

function makeDb() {
  const select = vi.fn();
  const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  const db = { select, execute } as unknown as DbClient;
  return { db, select, execute };
}

const resource: DraggableResource = {
  id: "res-1",
  pluginId: "plugin",
  resourceTypeId: "type",
  accountId: "acc",
  displayName: "My Resource",
  externalId: "ext-1",
  fields: { region: "us" },
} as DraggableResource;

beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-0000-0000-000000000000");
});

describe("createDashboard", () => {
  it("inserts a non-default dashboard row and returns the new id", async () => {
    const { db, execute } = makeDb();
    const id = await createDashboard("Staging", db);
    expect(id).toBe("00000000-0000-0000-0000-000000000000");
    expect(execute).toHaveBeenCalledWith(
      "INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 0)",
      [id, "Staging"],
    );
  });
});

describe("pinResource", () => {
  it("upserts the resource and pins to an explicit dashboard at the next grid slot", async () => {
    const { db, select, execute } = makeDb();
    select.mockResolvedValueOnce([{ max_x: 2 }]); // MAX(grid_x)
    await pinResource(resource, db, "dash-explicit");

    // resource upsert
    expect(execute.mock.calls[0]![0]).toContain("INSERT OR REPLACE INTO resources");
    expect(execute.mock.calls[0]![1]).toEqual([
      "res-1",
      "plugin",
      "type",
      "acc",
      "My Resource",
      "ext-1",
      JSON.stringify({ region: "us" }),
    ]);

    // max grid lookup scoped to the explicit dashboard
    expect(select).toHaveBeenCalledWith(
      "SELECT MAX(grid_x) as max_x FROM dashboard_pins WHERE dashboard_id = $1",
      ["dash-explicit"],
    );

    // pin insert with nextX = 3
    const pinCall = execute.mock.calls.find((c) => String(c[0]).includes("dashboard_pins"))!;
    expect(pinCall[1]).toEqual([
      "00000000-0000-0000-0000-000000000000",
      "dash-explicit",
      "res-1",
      3,
    ]);
  });

  it("uses the existing default dashboard when none is specified", async () => {
    const { db, select, execute } = makeDb();
    select
      .mockResolvedValueOnce([{ id: "default-dash" }]) // default dashboard lookup
      .mockResolvedValueOnce([{ max_x: null }]); // no pins yet -> nextX = 0
    await pinResource(resource, db);

    expect(select).toHaveBeenCalledWith("SELECT id FROM dashboards WHERE is_default = 1 LIMIT 1");
    const pinCall = execute.mock.calls.find((c) => String(c[0]).includes("dashboard_pins"))!;
    expect(pinCall[1]![1]).toBe("default-dash");
    expect(pinCall[1]![3]).toBe(0);
  });

  it("creates a Home default dashboard when none exists", async () => {
    const { db, select, execute } = makeDb();
    select
      .mockResolvedValueOnce([]) // no default dashboard
      .mockResolvedValueOnce([]); // no pins
    await pinResource(resource, db);

    const homeCall = execute.mock.calls.find(
      (c) => String(c[0]).includes("INSERT INTO dashboards") && c[1]![1] === "Home",
    );
    expect(homeCall).toBeTruthy();
    expect(homeCall![1]).toEqual(["00000000-0000-0000-0000-000000000000", "Home"]);
  });

  it("falls back to resource.id when externalId is absent", async () => {
    const { db, select, execute } = makeDb();
    select.mockResolvedValueOnce([{ id: "d" }]).mockResolvedValueOnce([{ max_x: 0 }]);
    const noExt = { ...resource, externalId: undefined } as DraggableResource;
    await pinResource(noExt, db, "d");
    expect(execute.mock.calls[0]![1]![5]).toBe("res-1");
  });
});
