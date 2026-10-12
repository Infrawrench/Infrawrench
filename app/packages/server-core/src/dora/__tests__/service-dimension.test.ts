import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: {} }));
const { getServicesForResources } = vi.hoisted(() => ({ getServicesForResources: vi.fn() }));
vi.mock("../../service-catalog/lookup", () => ({ getServicesForResources }));

import type { ServiceRef } from "@infrawrench/client-core";
import {
  getDoraScopeDimension,
  listDoraScopeDimensions,
  type DoraScopeSubject,
} from "../dimensions";
import { primaryService } from "../../service-catalog/dora-dimension";

const ref = (id: string, name: string, tier: ServiceRef["tier"]): ServiceRef => ({
  id,
  name,
  slug: name.toLowerCase(),
  tier,
});

const subject = (over: Partial<DoraScopeSubject>): DoraScopeSubject => ({
  id: "c-1",
  type: "deploy",
  environment: "production",
  repository: null,
  accountId: "a-1",
  pluginId: "vercel",
  resourceId: null,
  targetResourceId: null,
  ...over,
});

describe("service DORA dimension", () => {
  beforeEach(() => getServicesForResources.mockReset());

  it("is registered beside the built-ins", () => {
    expect(listDoraScopeDimensions().map((d) => d.id)).toEqual([
      "environment",
      "repository",
      "owner",
      "service",
    ]);
    expect(getDoraScopeDimension("service")?.label).toBe("Service");
  });

  it("places a deploy by its target, then its own row, in one batched lookup", async () => {
    const checkout = ref("svc-checkout", "Checkout", 1);
    const search = ref("svc-search", "Search", 2);
    getServicesForResources.mockResolvedValue(
      new Map([
        ["project-1", [checkout]],
        ["deploy-2", [search]],
        ["deploy-1", [search]],
      ]),
    );
    const out = await getDoraScopeDimension("service")!.resolve("org-1", [
      subject({ id: "c-1", resourceId: "deploy-1", targetResourceId: "project-1" }),
      subject({ id: "c-2", resourceId: "deploy-2", targetResourceId: "project-2" }),
      subject({ id: "c-3", type: "resource_change", resourceId: "db-9" }),
      subject({ id: "c-4" }),
    ]);
    expect(getServicesForResources).toHaveBeenCalledTimes(1);
    expect(getServicesForResources.mock.calls[0]![1]).toEqual([
      "project-1",
      "deploy-1",
      "project-2",
      "deploy-2",
      "db-9",
    ]);
    expect(out.get("c-1")).toEqual({ key: "svc-checkout", label: "Checkout" });
    expect(out.get("c-2")).toEqual({ key: "svc-search", label: "Search" });
    expect(out.get("c-3")).toBeNull();
    expect(out.get("c-4")).toBeNull();
  });

  it("groups a resource in several services under the most critical one", async () => {
    getServicesForResources.mockResolvedValue(
      new Map([
        [
          "db-1",
          [ref("svc-b", "Billing", 2), ref("svc-u", "Untiered", null), ref("svc-a", "Auth", 1)],
        ],
      ]),
    );
    const out = await getDoraScopeDimension("service")!.resolve("org-1", [
      subject({ id: "c-1", type: "resource_change", resourceId: "db-1" }),
    ]);
    expect(out.get("c-1")).toEqual({ key: "svc-a", label: "Auth" });
  });

  it("breaks tier ties by name, then id, and ranks untiered last", () => {
    expect(primaryService([ref("2", "Zeta", 1), ref("1", "Alpha", 1)])?.id).toBe("1");
    expect(primaryService([ref("b", "Same", 3), ref("a", "Same", 3)])?.id).toBe("a");
    expect(primaryService([ref("u", "A", null), ref("t", "Z", 4)])?.id).toBe("t");
    expect(primaryService([])).toBeNull();
  });
});
