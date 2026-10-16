import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

vi.mock("@/db/schema", () => ({
  starredItems: {
    organizationId: "org",
    userId: "user",
    kind: "kind",
    objectId: "obj",
    createdAt: "created",
  },
}));

let selectQueue: unknown[][] = [];
const inserted: unknown[] = [];
const deleted = vi.fn();

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {
    from: () => c,
    where: () => c,
    orderBy: () => c,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return c;
}

vi.mock("@/db/client", () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v);
        return { onConflictDoNothing: async () => undefined };
      },
    }),
    delete: () => ({ where: async (...a: unknown[]) => deleted(...a) }),
  },
}));

const resolvePaletteRefs = vi.fn();
vi.mock("@/services/palette-search", () => ({
  resolvePaletteRefs: (...a: unknown[]) => resolvePaletteRefs(...a),
}));

const { starredRoutes } = await import("@/api/routes/starred");
const app = () => buildTestApp(starredRoutes);

const hit = (kind: string, id: string, name: string) => ({
  id,
  kind,
  pluginId: "__objects__",
  pluginDisplayName: "",
  pluginLogoSvg: "",
  resourceTypeId: kind,
  resourceTypeLabel: "",
  accountId: "",
  accountName: "",
  displayName: name,
});

describe("starred routes", () => {
  beforeEach(() => {
    selectQueue = [];
    inserted.length = 0;
    vi.clearAllMocks();
  });

  it("lists resolved stars newest first and leaves out what the caller cannot open", async () => {
    const t1 = new Date("2026-10-01T00:00:00Z");
    const t2 = new Date("2026-09-01T00:00:00Z");
    selectQueue.push([
      { kind: "cost_report", objectId: "r1", createdAt: t1 },
      { kind: "dashboard", objectId: "gone", createdAt: t2 },
    ]);
    resolvePaletteRefs.mockResolvedValue(
      new Map([["cost_report:r1", hit("cost_report", "r1", "Team spend")]]),
    );
    const res = await app().request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; starredAt: string }[] };
    expect(body.items).toEqual([
      expect.objectContaining({ id: "r1", displayName: "Team spend", starredAt: t1.toISOString() }),
    ]);
    expect(resolvePaletteRefs).toHaveBeenCalledWith(
      "org-1",
      ["*"],
      [
        { kind: "cost_report", id: "r1" },
        { kind: "dashboard", id: "gone" },
      ],
    );
  });

  it("refuses an unknown kind", async () => {
    const res = await app().request("/nope/x", { method: "PUT" });
    expect(res.status).toBe(400);
  });

  it("404s a star on something the caller cannot open", async () => {
    resolvePaletteRefs.mockResolvedValue(new Map());
    const res = await app().request("/dashboard/secret", { method: "PUT" });
    expect(res.status).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it("stars a visible object once", async () => {
    resolvePaletteRefs.mockResolvedValue(new Map([["slo:s1", hit("slo", "s1", "Checkout")]]));
    selectQueue.push([], [{ n: 3 }]);
    const res = await app().request("/slo/s1", { method: "PUT" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { kind: string; displayName: string } };
    expect(body.item).toMatchObject({ kind: "slo", displayName: "Checkout" });
    expect(inserted).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        userId: "user-1",
        kind: "slo",
        objectId: "s1",
      }),
    ]);
  });

  it("is idempotent for an existing star", async () => {
    resolvePaletteRefs.mockResolvedValue(new Map([["slo:s1", hit("slo", "s1", "Checkout")]]));
    selectQueue.push([{ createdAt: new Date("2026-01-01T00:00:00Z") }]);
    const res = await app().request("/slo/s1", { method: "PUT" });
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(0);
  });

  it("caps stars per member", async () => {
    resolvePaletteRefs.mockResolvedValue(new Map([["slo:s1", hit("slo", "s1", "Checkout")]]));
    selectQueue.push([], [{ n: 200 }]);
    const res = await app().request("/slo/s1", { method: "PUT" });
    expect(res.status).toBe(409);
    expect(inserted).toHaveLength(0);
  });

  it("unstars without checking visibility", async () => {
    const res = await app().request("/resource/a%2Fb", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deleted).toHaveBeenCalledOnce();
    expect(resolvePaletteRefs).not.toHaveBeenCalled();
  });
});
