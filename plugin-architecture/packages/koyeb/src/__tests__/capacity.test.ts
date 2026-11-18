import { describe, expect, it } from "vitest";
import { mapVolume } from "../mappers.js";

describe("volume capacity", () => {
  it("stores the used and maximum size the volume reports, in GB", () => {
    const vol = mapVolume({ id: "v1", name: "data", max_size: 10, cur_size: 3 }, "acct");
    expect(vol.fields["usedGb"]).toBe(3);
    expect(vol.fields["sizeGb"]).toBe(10);
  });

  it("leaves the used size out when the response has none", () => {
    const vol = mapVolume({ id: "v1", name: "data", max_size: 10 }, "acct");
    expect(vol.fields["usedGb"]).toBeUndefined();
  });
});
