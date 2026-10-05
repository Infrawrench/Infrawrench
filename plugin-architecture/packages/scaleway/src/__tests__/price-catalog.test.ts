import { describe, expect, it, vi } from "vitest";
import type { Instancev1 } from "@scaleway/sdk-instance";
import {
  fetchScalewayPriceCatalog,
  scalewayPriceCatalog,
  scalewayServerTypeToProduct,
} from "../price-catalog.js";

const GIB = 1024 ** 3;

function serverType(overrides: Partial<Instancev1.ServerType> = {}): Instancev1.ServerType {
  return {
    ncpus: 2,
    ram: 8 * GIB,
    hourlyPrice: 0.0945,
    arch: "x86_64",
    gpu: 0,
    ...overrides,
  } as Instancev1.ServerType;
}

describe("scaleway price catalog", () => {
  it("declares a credentialed, zone-scoped catalog", () => {
    expect(scalewayPriceCatalog.requiresCredentials).toBe(true);
    expect(scalewayPriceCatalog.regions.length).toBeGreaterThan(0);
  });

  it("maps a server type to a product with an hourly EUR price and estimate link", () => {
    const product = scalewayServerTypeToProduct("PRO2-XS", serverType(), "fr-par-1")!;
    expect(product.specs).toMatchObject({ vcpus: 2, memoryGb: 8, architecture: "x86_64" });
    expect(product.family).toBe("compute");
    expect(product.prices).toEqual([
      { region: "fr-par-1", rateType: "on-demand", unit: "hour", amount: 0.0945, currency: "EUR" },
    ]);
    expect(product.estimate).toEqual({
      resourceTypeId: "instance",
      fields: { commercialType: "PRO2-XS", zone: "{region}" },
    });
  });

  it("marks GPU types and skips end-of-service ones", () => {
    const gpu = scalewayServerTypeToProduct(
      "L4-1-24G",
      serverType({
        gpu: 1,
        gpuInfo: { gpuManufacturer: "NVIDIA", gpuName: "L4", gpuMemory: 24 * GIB },
      } as Partial<Instancev1.ServerType>),
      "fr-par-2",
    )!;
    expect(gpu.family).toBe("gpu");
    expect(gpu.specs).toMatchObject({ gpuCount: 1, gpuModel: "NVIDIA L4", gpuMemoryGb: 24 });
    expect(
      scalewayServerTypeToProduct("OLD", serverType({ endOfService: true }), "fr-par-1"),
    ).toBeNull();
  });

  it("pages until totalCount and ignores other services", async () => {
    const listServersTypes = vi.fn(async ({ page }: { page: number }) => ({
      totalCount: 1,
      servers: page === 1 ? { "DEV1-S": serverType() } : {},
    }));
    const result = await fetchScalewayPriceCatalog(
      { listServersTypes },
      { serviceId: "instances", region: "nl-ams-1" },
    );
    expect(result.products.map((p) => p.sku)).toEqual(["DEV1-S"]);
    expect(result.products[0]!.prices[0]!.region).toBe("nl-ams-1");
    expect(result.truncated).toBeUndefined();
    expect(listServersTypes).toHaveBeenCalledTimes(1);
    expect(
      (await fetchScalewayPriceCatalog({ listServersTypes }, { serviceId: "other" })).products,
    ).toEqual([]);
  });
});
