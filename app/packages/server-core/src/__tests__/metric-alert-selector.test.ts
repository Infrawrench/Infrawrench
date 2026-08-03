import { describe, expect, it, vi } from "vitest";

/**
 * The tag half of selector resolution, pure. `resolveSelectorResources`'s SQL
 * narrowing is exercised through the db fake below; the tag matching itself
 * is `rowMatchesTag`, tested directly against the `tags`/`labels` conventions
 * `extractRecordTags` reads.
 */

// selector.ts imports db/client, which throws without DATABASE_URL.
let resourceRows: unknown[] = [];
/** Projection and SQL limit of the last select, for the bounded-read tests. */
let lastProjection: Record<string, unknown> = {};
let lastLimit: number | undefined;
vi.mock("../db/client", () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      lastProjection = projection;
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (n: number) => {
                lastLimit = n;
                return Promise.resolve(resourceRows.slice(0, n));
              },
            }),
          }),
        }),
      };
    },
  },
}));
vi.mock("../db/schema", () => ({
  resources: {
    id: "id",
    organizationId: "organizationId",
    pluginId: "pluginId",
    resourceTypeId: "resourceTypeId",
    displayName: "displayName",
    fieldsJson: "fieldsJson",
    outputsJson: "outputsJson",
    deletedAt: "deletedAt",
  },
}));

const { MAX_SELECTED_RESOURCES, MAX_TAG_SCAN_ROWS, resolveSelectorResources, rowMatchesTag } =
  await import("../metric-alerts/selector");

function row(
  id: string,
  fields: Record<string, unknown> = {},
  outputs: Record<string, unknown> = {},
) {
  return { id, displayName: id, fieldsJson: fields, outputsJson: outputs };
}

describe("rowMatchesTag", () => {
  it("matches everything when no tag key is set", () => {
    expect(rowMatchesTag(row("r", {}), null, null)).toBe(true);
  });

  it("matches a tags map in fieldsJson on key and value", () => {
    const r = row("r", { tags: { env: "prod", team: "core" } });
    expect(rowMatchesTag(r, "env", "prod")).toBe(true);
    expect(rowMatchesTag(r, "env", "staging")).toBe(false);
    expect(rowMatchesTag(r, "missing", null)).toBe(false);
  });

  it("matches any value when tagValue is null", () => {
    const r = row("r", { tags: { env: "prod" } });
    expect(rowMatchesTag(r, "env", null)).toBe(true);
  });

  it("matches tag keys case-insensitively but values exactly", () => {
    const r = row("r", { tags: { Env: "prod" } });
    expect(rowMatchesTag(r, "env", "prod")).toBe(true);
    expect(rowMatchesTag(r, "env", "PROD")).toBe(false);
  });

  it("reads the labels convention too", () => {
    const r = row("r", { labels: { app: "web" } });
    expect(rowMatchesTag(r, "app", "web")).toBe(true);
  });

  it("reads tags from outputsJson as well as fieldsJson", () => {
    const r = row("r", {}, { tags: { env: "prod" } });
    expect(rowMatchesTag(r, "env", "prod")).toBe(true);
  });

  it("does not match a resource whose record carries no tag field at all", () => {
    expect(rowMatchesTag(row("r", { name: "vm-1" }), "env", null)).toBe(false);
  });
});

describe("resolveSelectorResources", () => {
  const selector = {
    organizationId: "org1",
    pluginId: null,
    resourceTypeId: null,
    tagKey: "env",
    tagValue: "prod",
  };

  it("keeps only rows whose tags satisfy the selector", async () => {
    resourceRows = [
      row("a", { tags: { env: "prod" } }),
      row("b", { tags: { env: "staging" } }),
      row("c", {}),
    ];
    const matched = await resolveSelectorResources(selector);
    expect(matched).toEqual([{ id: "a", displayName: "a" }]);
  });

  it("caps the result at MAX_SELECTED_RESOURCES", async () => {
    resourceRows = Array.from({ length: MAX_SELECTED_RESOURCES + 50 }, (_, i) =>
      row(`r${i}`, { tags: { env: "prod" } }),
    );
    const matched = await resolveSelectorResources(selector);
    expect(matched).toHaveLength(MAX_SELECTED_RESOURCES);
  });

  it("bounds the tag scan at MAX_TAG_SCAN_ROWS in SQL", async () => {
    resourceRows = [row("a", { tags: { env: "prod" } })];
    await resolveSelectorResources(selector);
    expect(lastLimit).toBe(MAX_TAG_SCAN_ROWS);
    expect(Object.keys(lastProjection)).toContain("fieldsJson");
  });

  it("pushes the cap into SQL and skips the JSON payloads when there is no tag filter", async () => {
    resourceRows = [{ id: "a", displayName: "a" }];
    const matched = await resolveSelectorResources({ ...selector, tagKey: null, tagValue: null });
    expect(matched).toEqual([{ id: "a", displayName: "a" }]);
    expect(lastLimit).toBe(MAX_SELECTED_RESOURCES);
    expect(Object.keys(lastProjection)).toEqual(["id", "displayName"]);
  });
});
