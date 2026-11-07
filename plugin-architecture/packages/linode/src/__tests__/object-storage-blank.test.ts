import { describe, expect, it } from "vitest";
import { deleteObject, splitBucket } from "../object-storage.js";
import { fakeApi } from "./fake-linode.js";

describe("the bucket browser's delete", () => {
  it("refuses a blank key before asking for a signed URL", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await expect(deleteObject(api, "us-east/b", "")).rejects.toThrow("no object");
    expect(calls).toEqual([]);
  });

  it("refuses a bucket reference with no name", () => {
    expect(() => splitBucket("us-east/")).toThrow("is not region/name");
  });
});
