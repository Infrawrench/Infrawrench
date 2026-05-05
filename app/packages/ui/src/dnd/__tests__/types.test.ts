import { describe, expect, it } from "vitest";
import type { DraggableResource } from "../types";

describe("DraggableResource type shape", () => {
  it("accepts a valid DraggableResource object", () => {
    const resource: DraggableResource = {
      id: "res-1",
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      accountId: "acc-1",
      displayName: "My Instance",
      fields: { ip: "10.0.0.1", status: "running" },
    };
    expect(resource.id).toBe("res-1");
    expect(resource.pluginId).toBe("aws");
    expect(resource.resourceTypeId).toBe("ec2-instance");
    expect(resource.accountId).toBe("acc-1");
    expect(resource.displayName).toBe("My Instance");
    expect(resource.fields).toEqual({ ip: "10.0.0.1", status: "running" });
  });

  it("accepts optional externalId", () => {
    const resource: DraggableResource = {
      id: "res-2",
      pluginId: "aws",
      resourceTypeId: "s3-bucket",
      accountId: "acc-1",
      displayName: "My Bucket",
      fields: {},
      externalId: "arn:aws:s3:::my-bucket",
    };
    expect(resource.externalId).toBe("arn:aws:s3:::my-bucket");
  });

  it("accepts undefined externalId", () => {
    const resource: DraggableResource = {
      id: "res-3",
      pluginId: "gcp",
      resourceTypeId: "vm",
      accountId: "acc-2",
      displayName: "VM",
      fields: {},
      externalId: undefined,
    };
    expect(resource.externalId).toBeUndefined();
  });

  it("allows unknown field values", () => {
    const resource: DraggableResource = {
      id: "res-4",
      pluginId: "azure",
      resourceTypeId: "disk",
      accountId: "acc-3",
      displayName: "Disk",
      fields: {
        size: 100,
        encrypted: true,
        tags: ["prod"],
        nested: { a: 1 },
      },
    };
    expect(resource.fields).toEqual({
      size: 100,
      encrypted: true,
      tags: ["prod"],
      nested: { a: 1 },
    });
  });
});
