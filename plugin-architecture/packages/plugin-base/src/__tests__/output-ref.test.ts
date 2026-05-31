import { describe, it, expect } from "vitest";
import {
  encodeOutputRef,
  parseOutputRef,
  isOutputRefValue,
  OUTPUT_REF_PREFIX,
  type OutputRefValue,
} from "../output-ref.js";

const ref: OutputRefValue = {
  pluginId: "aws",
  resourceTypeId: "elastic-ip",
  resourceId: "eip-1",
  accountId: "acct-1",
  outputKey: "publicIp",
  value: "1.2.3.4",
};

describe("output-ref", () => {
  it("encodes with the sentinel prefix", () => {
    const encoded = encodeOutputRef(ref);
    expect(encoded.startsWith(OUTPUT_REF_PREFIX)).toBe(true);
    expect(encoded).toBe(OUTPUT_REF_PREFIX + JSON.stringify(ref));
  });

  it("round-trips through encode/parse", () => {
    expect(parseOutputRef(encodeOutputRef(ref))).toEqual(ref);
  });

  it("isOutputRefValue detects encoded refs", () => {
    expect(isOutputRefValue(encodeOutputRef(ref))).toBe(true);
    expect(isOutputRefValue("1.2.3.4")).toBe(false);
    expect(isOutputRefValue("")).toBe(false);
  });

  it("parseOutputRef returns null for plain literals", () => {
    expect(parseOutputRef("1.2.3.4")).toBeNull();
  });

  it("parseOutputRef returns null on malformed JSON", () => {
    expect(parseOutputRef(OUTPUT_REF_PREFIX + "{not json")).toBeNull();
  });

  it("parseOutputRef returns null when a required field is missing", () => {
    const { value: _value, ...partial } = ref;
    expect(parseOutputRef(OUTPUT_REF_PREFIX + JSON.stringify(partial))).toBeNull();
  });

  it("parseOutputRef returns null when a field has the wrong type", () => {
    const bad = { ...ref, resourceId: 123 };
    expect(parseOutputRef(OUTPUT_REF_PREFIX + JSON.stringify(bad))).toBeNull();
  });
});
