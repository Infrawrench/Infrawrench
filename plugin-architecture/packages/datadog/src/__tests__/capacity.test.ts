import { capacityDeclarations } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { hostSeries } from "../metrics.js";
import { HostResourceType } from "../resource-types.js";
import { ctxWith, makeHttp } from "./helpers.js";

describe("host disk runway", () => {
  it("names a series the host's metrics emit, against 100%", async () => {
    const { http } = makeHttp((url) => {
      const query = url.searchParams.get("query") ?? "";
      if (!query.startsWith("max:system.disk.in_use")) return { body: { series: [] } };
      return {
        body: { series: [{ scope: "host:web-1", pointlist: [[1_700_000_000_000, 72.5]] }] },
      };
    });
    const series = await hostSeries(ctxWith(http), "web-1", {
      startMs: 1_699_990_000_000,
      endMs: 1_700_000_000_000,
    } as never);
    const [decl] = capacityDeclarations(HostResourceType);
    expect(decl!.source).toBe("metric");
    expect(decl!.declaration.limit).toEqual({ constant: 100 });
    const disk = series.find((s) => s.label === decl!.valueKey);
    expect(disk?.unit).toBe("%");
    expect(disk?.points[0]?.value).toBe(72.5);
  });
});
