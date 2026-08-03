import { describe, expect, it, vi } from "vitest";

/**
 * The tag half of selector resolution, pure. `resolveSelectorResources`'s SQL
 * narrowing is exercised through the db fake below; the tag matching itself
 * is `rowMatchesTag`, tested directly against the `tags`/`labels` conventions
 * `extractRecordTags` reads.
 */

// selector.ts imports db/client, which throws without DATABASE_URL.
let resourceRows: unknown[] = [];
vi.mock("../db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(resourceRows) }) }),
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

const { MAX_SELECTED_RESOURCES, resolveSelectorResources, rowMatchesTag } =
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
});
