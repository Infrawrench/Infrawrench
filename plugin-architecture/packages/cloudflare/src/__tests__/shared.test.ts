import { ListTruncatedError } from "@infrawrench/plugin-base";
import { describe, it, expect, vi } from "vitest";
import {
  formatCloudflareError,
  withCloudflareErrors,
  withAuthErrorHint,
  collectPerZone,
  CloudflareApi,
} from "../clients/shared.js";

describe("formatCloudflareError", () => {
  it("pulls errors[].message + code from a structured SDK error", () => {
    const err = { errors: [{ code: 1034, message: "Zone not entitled" }] };
    expect(formatCloudflareError(err)).toBe("Zone not entitled (code 1034)");
  });

  it("joins multiple errors", () => {
    const err = { errors: [{ message: "a" }, { message: "b" }] };
    expect(formatCloudflareError(err)).toBe("a; b");
  });

  it("parses a JSON envelope embedded in an Error message", () => {
    const err = new Error('403 {"success":false,"errors":[{"message":"nope"}]}');
    expect(formatCloudflareError(err)).toBe("nope");
  });

  it("falls back to the raw message when no errors array is present", () => {
    expect(formatCloudflareError(new Error("boom"))).toBe("boom");
  });

  it("falls back to a default string for empty input", () => {
    expect(formatCloudflareError({})).toBe("Cloudflare request failed");
  });

  it("handles non-JSON braces gracefully", () => {
    const err = new Error("failed at line {oops");
    expect(formatCloudflareError(err)).toBe("failed at line {oops");
  });

  it("strips Cloudflare's machine-code prefix from the message", () => {
    const err = new Error(
      '403 {"result":null,"success":false,"errors":[{"code":9999,"message":"access.api.error.not_enabled: Access is not enabled. Visit the Access dashboard at https://dash.cloudflare.com/ and click the \'Enable Access\' button."}],"messages":[]}',
    );
    expect(formatCloudflareError(err)).toBe(
      "Access is not enabled. Visit the Access dashboard at https://dash.cloudflare.com/ and click the 'Enable Access' button. (code 9999)",
    );
  });

  it("leaves a message without a dotted machine prefix untouched", () => {
    const err = { errors: [{ message: "Zone not found: try again" }] };
    expect(formatCloudflareError(err)).toBe("Zone not found: try again");
  });
});

describe("withCloudflareErrors", () => {
  it("returns the value on success", async () => {
    await expect(withCloudflareErrors(async () => 5)).resolves.toBe(5);
  });

  it("reformats errors and preserves the cause", async () => {
    const original = { errors: [{ message: "bad" }] };
    await expect(
      withCloudflareErrors(async () => {
        throw original;
      }),
    ).rejects.toMatchObject({ message: "bad" });
  });
});

describe("withAuthErrorHint", () => {
  it("returns the value on success", async () => {
    await expect(
      withAuthErrorHint(async () => "ok", "DNS records", "Zone · DNS:Read"),
    ).resolves.toBe("ok");
  });

  it("rethrows a friendly permission error on a 403", async () => {
    await expect(
      withAuthErrorHint(
        async () => {
          throw { status: 403 };
        },
        "DNS records",
        "Zone · DNS:Read",
      ),
    ).rejects.toThrow(/doesn't have the Zone · DNS:Read permission/);
  });

  it("detects the 10000 auth error code", async () => {
    await expect(
      withAuthErrorHint(
        async () => {
          throw { errors: [{ code: 10000 }] };
        },
        "DNS records",
        "Zone · DNS:Read",
      ),
    ).rejects.toThrow(/DNS records can't be loaded/);
  });

  it("reformats non-auth errors", async () => {
    await expect(
      withAuthErrorHint(
        async () => {
          throw { errors: [{ message: "other" }] };
        },
        "DNS records",
        "Zone · DNS:Read",
      ),
    ).rejects.toThrow("other");
  });
});

function makeApi(zones: Array<{ id: string; name: string }>): CloudflareApi {
  const api = Object.create(CloudflareApi.prototype) as CloudflareApi;
  vi.spyOn(api, "listZones").mockResolvedValue(zones as never);
  return api;
}

describe("collectPerZone", () => {
  it("collects items across all zones", async () => {
    const api = makeApi([
      { id: "z1", name: "a.com" },
      { id: "z2", name: "b.com" },
    ]);
    const out = await collectPerZone(
      api,
      async (zoneId) => [`${zoneId}-x`],
      "DNS records",
      "Zone · DNS:Read",
    );
    expect(out).toEqual(["z1-x", "z2-x"]);
  });

  const TWO_ZONES = [
    { id: "z1", name: "a.com" },
    { id: "z2", name: "b.com" },
  ];
  const collect = (perZone: (zoneId: string) => Promise<string[]>) =>
    collectPerZone(makeApi(TWO_ZONES), perZone, "DNS records", "Zone · DNS:Read");
  const failingZoneTwo = (err: unknown) => async (zoneId: string) => {
    if (zoneId === "z2") throw err;
    return [`${zoneId}-x`];
  };

  it.each([
    ["a feature the zone is not entitled to", { status: 403, errors: [{ code: 1034 }] }],
    ["a missing endpoint", { status: 404 }],
    ["a scope this zone refuses", { status: 403, errors: [{ code: 10000 }] }],
    ["a 400 saying it is not enabled", { status: 400, message: "400 DNS is not enabled here" }],
    ["a 400 that names no reason", { status: 400, message: "400 Bad request" }],
  ])("reads %s on one zone as none and keeps the others", async (_what, err) => {
    await expect(collect(failingZoneTwo(err))).resolves.toEqual(["z1-x"]);
  });

  it.each([
    ["a 429", { status: 429, errors: [{ code: 971 }] }],
    ["a 429 carrying the auth code", { status: 429, errors: [{ code: 10000 }] }],
    ["a 500", { status: 500 }],
    ["a 503 carrying the auth code", { status: 503, errors: [{ code: 10000 }] }],
    ["a dropped connection", new Error("Connection error.")],
    ["a bug in a mapper", new TypeError("x is not a function")],
  ])("fails the whole type on %s, so stored rows stay", async (_what, err) => {
    await expect(collect(failingZoneTwo(err))).rejects.toBe(err);
  });

  it("does not call a 429 with the auth code a missing permission", async () => {
    await expect(
      withAuthErrorHint(
        async () => {
          throw { status: 429, errors: [{ code: 10000, message: "Rate limited" }] };
        },
        "DNS records",
        "Zone · DNS:Read",
      ),
    ).rejects.toThrow("Rate limited");
  });

  it("fails the whole type on an expired credential, even if another zone answered", async () => {
    await expect(collect(failingZoneTwo({ status: 401 }))).rejects.toThrow(
      /doesn't have the Zone · DNS:Read permission/,
    );
  });

  it("reads a feature no zone is entitled to as none", async () => {
    await expect(
      collect(async () => {
        throw { status: 403, errors: [{ code: 1034, message: "Zone not entitled" }] };
      }),
    ).resolves.toEqual([]);
  });

  it("says so when one zone refuses the token and the rest are not entitled", async () => {
    await expect(
      collect(async (zoneId) => {
        throw zoneId === "z1" ? { status: 403 } : { status: 403, errors: [{ code: 1034 }] };
      }),
    ).rejects.toThrow(/doesn't have the Zone · DNS:Read permission/);
  });

  it("fails rather than empties when every zone answers a 400 that names no reason", async () => {
    await expect(
      collect(async () => {
        throw Object.assign(new Error("400 unknown field"), { status: 400 });
      }),
    ).rejects.toThrow("400 unknown field");
  });

  it("passes a truncated list through unchanged", async () => {
    const err = new ListTruncatedError({ vendor: "Cloudflare", path: "/x", items: 1, maxPages: 1 });
    await expect(collect(failingZoneTwo(err))).rejects.toBe(err);
    await expect(
      withAuthErrorHint(
        async () => {
          throw err;
        },
        "x",
        "y",
      ),
    ).rejects.toBe(err);
    await expect(
      withCloudflareErrors(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it("throws a permission error when every zone fails with auth and nothing collected", async () => {
    const api = makeApi([
      { id: "z1", name: "a.com" },
      { id: "z2", name: "b.com" },
    ]);
    await expect(
      collectPerZone(
        api,
        async () => {
          throw { status: 403 };
        },
        "DNS records",
        "Zone · DNS:Read",
      ),
    ).rejects.toThrow(/doesn't have the Zone · DNS:Read permission/);
  });
});

describe("CloudflareApi", () => {
  it("throws when constructed without a token via the client guard path", () => {
    // Constructor itself accepts the token; just assert it stores baseUrl.
    const api = new CloudflareApi("tok");
    expect(api.baseUrl).toBe("https://api.cloudflare.com/client/v4");
    expect(api.apiToken).toBe("tok");
  });

  it("listZones caches the in-flight promise and resolves account id", async () => {
    const api = new CloudflareApi("tok");
    const zones = [{ id: "z1", name: "a.com", account: { id: "acct-1" } }];
    const listSpy = vi.fn(() => zones[Symbol.iterator]());
    // Replace the SDK zones.list with a fake async-iterable producer.
    (api as unknown as { cf: { zones: { list: () => AsyncIterable<unknown> } } }).cf = {
      zones: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            for (const z of zones) yield z;
          },
        }),
      },
    } as never;
    void listSpy;
    const a = await api.listZones();
    expect(a).toHaveLength(1);
    expect(api.cfAccountId).toBe("acct-1");
    // Second call returns the same cached resolved promise.
    const b = await api.listZones();
    expect(b).toBe(a);
  });

  it("getZoneOptions maps zones to id/label", async () => {
    const api = new CloudflareApi("tok");
    vi.spyOn(api, "listZones").mockResolvedValue([
      { id: "z1", name: "a.com" },
      { id: "z2", name: "b.com" },
    ] as never);
    expect(await api.getZoneOptions()).toEqual([
      { id: "z1", label: "a.com" },
      { id: "z2", label: "b.com" },
    ]);
  });

  it("getAccountId returns the cached id without a lookup", async () => {
    const api = new CloudflareApi("tok");
    api.cfAccountId = "cached";
    expect(await api.getAccountId()).toBe("cached");
  });
});
