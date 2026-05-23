import { describe, it, expect } from "vitest";
import { parseBootstrapServers } from "../client.js";

describe("parseBootstrapServers", () => {
  it("returns the host for a single-broker URL", () => {
    expect(parseBootstrapServers("kafka://broker1:9092")).toBe("broker1:9092");
  });

  it("reads the brokers query param when present", () => {
    expect(parseBootstrapServers("kafka://placeholder:9092?brokers=b1:9092,b2:9092,b3:9092")).toBe(
      "b1:9092,b2:9092,b3:9092",
    );
  });

  it("falls back to the raw string when URL parsing fails", () => {
    expect(parseBootstrapServers("not a url")).toBe("not a url");
  });
});
