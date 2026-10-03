import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostResolver,
  isCredentialEndpoint,
  registerCredentialEndpoints,
  resetCredentialEndpointsForTest,
  shouldRelaxCors,
} from "../cors-policy";

const context = { tunnelPorts: [41000], cloudOrigin: "https://infrawrench.com" };

beforeEach(() => resetCredentialEndpointsForTest());

describe("shouldRelaxCors", () => {
  it("relaxes public provider APIs", () => {
    expect(shouldRelaxCors({ url: "https://compute.googleapis.com/x" }, context)).toBe(true);
    expect(
      shouldRelaxCors(
        { url: "https://ec2.us-east-1.amazonaws.com/", addresses: ["3.5.1.2"] },
        context,
      ),
    ).toBe(true);
  });

  it("never relaxes non-http schemes", () => {
    expect(shouldRelaxCors({ url: "file:///etc/passwd" }, context)).toBe(false);
  });

  it("refuses loopback, private and metadata targets the user never configured", () => {
    for (const url of [
      "http://127.0.0.1:2375/containers/json",
      "http://localhost:8080/",
      "http://[::1]:9000/",
      "http://192.168.1.1/",
      "http://10.0.0.8:9200/",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      expect(shouldRelaxCors({ url }, context), url).toBe(false);
    }
  });

  it("refuses a public name that resolves to a private address", () => {
    expect(
      shouldRelaxCors({ url: "https://evil.example.com/", addresses: ["127.0.0.1"] }, context),
    ).toBe(false);
    expect(
      shouldRelaxCors(
        { url: "https://evil.example.com/", addresses: ["::ffff:10.0.0.1"] },
        context,
      ),
    ).toBe(false);
  });

  it("relaxes private endpoints named in stored credentials", () => {
    registerCredentialEndpoints({
      endpoint: "http://10.0.0.8:9200",
      connectionString: "postgres://u:p@127.0.0.1:5432/db",
      host: "opensearch.corp",
    });
    expect(shouldRelaxCors({ url: "http://10.0.0.8:9200/_cat" }, context)).toBe(true);
    expect(shouldRelaxCors({ url: "http://10.0.0.8:9201/_cat" }, context)).toBe(false);
    expect(
      shouldRelaxCors({ url: "https://opensearch.corp:9200/", addresses: ["10.1.1.1"] }, context),
    ).toBe(true);
    expect(isCredentialEndpoint("127.0.0.1", "5432")).toBe(true);
  });

  it("does not let a bare loopback host open every local port", () => {
    registerCredentialEndpoints({ host: "localhost", other: "127.0.0.1", any: "0.0.0.0" });
    expect(shouldRelaxCors({ url: "http://localhost:2375/" }, context)).toBe(false);
    expect(shouldRelaxCors({ url: "http://127.0.0.1:2375/" }, context)).toBe(false);
    expect(shouldRelaxCors({ url: "http://0.0.0.0:2375/" }, context)).toBe(false);
  });

  it("relaxes the local end of an open SSH tunnel and the cloud API", () => {
    expect(shouldRelaxCors({ url: "http://127.0.0.1:41000/" }, context)).toBe(true);
    expect(
      shouldRelaxCors(
        { url: "http://localhost:3000/api/x" },
        { ...context, cloudOrigin: "http://localhost:3000" },
      ),
    ).toBe(true);
  });
});

describe("createHostResolver", () => {
  it("caches lookups and skips IP literals", async () => {
    let t = 0;
    const lookup = vi.fn(async () => ["1.2.3.4"]);
    const resolve = createHostResolver(lookup, 1000, () => t);
    expect(await resolve("api.example.com")).toEqual(["1.2.3.4"]);
    expect(await resolve("API.example.com")).toEqual(["1.2.3.4"]);
    expect(lookup).toHaveBeenCalledTimes(1);
    t = 2000;
    await resolve("api.example.com");
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(await resolve("8.8.8.8")).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("yields no addresses when the lookup fails", async () => {
    const resolve = createHostResolver(async () => {
      throw new Error("ENOTFOUND");
    });
    expect(await resolve("nope.example.com")).toEqual([]);
  });
});
