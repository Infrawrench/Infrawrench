import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { APP_USAGE, usageSeries } from "../client.js";
import { ApplicationResourceType } from "../resource-types.js";

describe("application search capacity", () => {
  it("charts the busiest server's used search capacity under the declared label", () => {
    const series = usageSeries(
      {
        used_search_capacity: [
          { t: 1763888400000, v: { "c1-de-1": 41, "c1-de-2": 57, "c1-de-3": 12 } },
          { t: 1763892000000, v: { "c1-de-1": 44, "c1-de-2": 61, "c1-de-3": 15 } },
        ],
      },
      APP_USAGE,
    )[0];
    expect(series?.points.map((p) => p.value)).toEqual([57, 61]);

    const [decl] = capacityDeclarations(ApplicationResourceType);
    expect(decl?.valueKey).toBe(series?.label);
    expect(resolveCapacityLimit(decl!.declaration.limit, {})?.limit).toBe(100);
  });
});
