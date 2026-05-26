import { describe, it, expect } from "vitest";
import { parseBootstrapServers } from "../client.js";
import { buildKafkaConfig } from "../driver.js";

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

describe("buildKafkaConfig", () => {
  it("builds a SASL/SCRAM config from a credentialed URL", () => {
    const config = buildKafkaConfig(
      "kafka://alice:secret@broker1:25073?sasl=scram-sha-256&ssl=true",
    );
    expect(config.brokers).toEqual(["broker1:25073"]);
    expect(config.ssl).toBe(true);
    expect(config.sasl).toEqual({
      mechanism: "scram-sha-256",
      username: "alice",
      password: "secret",
    });
  });

  it("enables ssl from the kafkas:// scheme without explicit param", () => {
    const config = buildKafkaConfig("kafkas://alice:secret@broker1:25073?sasl=scram-sha-256");
    expect(config.ssl).toBe(true);
  });

  it("verifies against a base64 ssl_ca while keeping SASL (DO managed Kafka)", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nCABODY\n-----END CERTIFICATE-----";
    const params = new URLSearchParams({ sasl: "scram-sha-256", ssl: "true" });
    params.set("ssl_ca", btoa(ca));
    const config = buildKafkaConfig(`kafka://alice:secret@broker1:25073?${params.toString()}`);
    expect(config.ssl).toEqual({ ca: [ca], rejectUnauthorized: true });
    expect(config.sasl).toEqual({
      mechanism: "scram-sha-256",
      username: "alice",
      password: "secret",
    });
  });
});
