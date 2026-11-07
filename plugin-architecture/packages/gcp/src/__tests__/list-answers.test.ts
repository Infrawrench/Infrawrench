import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GcpClient } from "../client.js";
import { plugin } from "../plugin.js";

type HostRequest = { url: string; method: string; headers: Record<string, string> };

const TOKEN_HOST = "oauth2.googleapis.com";
const ACCT = "acct";

function answer(status: number, value: unknown) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: "",
    rawBody: new TextEncoder().encode(JSON.stringify(value)),
  };
}

/** A non-2xx answer, for a route to return. */
class Refusal {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

let privateKeyPem: string;
let keySerial = 0;

beforeAll(async () => {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const body = Buffer.from(der).toString("base64");
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
});

/** Every Google answer comes from `route`; nothing else can answer, and `fetch` throws. */
function clientFor(route: (url: URL) => unknown) {
  keySerial += 1;
  const request = vi.fn(async (req: HostRequest) => {
    const url = new URL(req.url);
    if (url.hostname === TOKEN_HOST) {
      return answer(200, { access_token: "tok", expires_in: 3600 });
    }
    const routed = route(url);
    return routed instanceof Refusal ? answer(routed.status, routed.body) : answer(200, routed);
  });
  const credentials = {
    project: "proj",
    serviceAccountJson: JSON.stringify({
      type: "service_account",
      project_id: "proj",
      private_key_id: `list-key-${keySerial}`,
      private_key: privateKeyPem,
      client_email: "sa@proj.iam.gserviceaccount.com",
      client_id: "1",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  };
  const client = hostClient(
    new GcpClient(credentials, plugin.resourceTypes, { http: { request } }),
  );
  const reads = () => request.mock.calls.filter(([r]) => new URL(r.url).hostname !== TOKEN_HOST);
  return { client, reads };
}

const unreadHook = Symbol.for("infrawrench.unreadListPart");
let unread: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const { Socket } = await vi.importActual<{
    Socket: { prototype: { connect: () => void } };
  }>("node:net");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("global fetch must not be used");
    }),
  );
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("a socket must not be opened");
  });
  unread = vi.fn();
  Reflect.set(globalThis, unreadHook, unread);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, unreadHook);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a page that is not a list", () => {
  it("rejects a key holding something else, rather than reading it as empty", async () => {
    const { client } = clientFor(() => ({ topics: "oops" }));
    await expect(client.listResources("pubsub-topic", ACCT)).rejects.toThrow("is not a list");
  });

  it("rejects it on a later page too", async () => {
    const { client } = clientFor((url) =>
      url.searchParams.get("pageToken")
        ? { topics: { error: "oops" } }
        : { topics: [{ name: "projects/proj/topics/a" }], nextPageToken: "2" },
    );
    await expect(client.listResources("pubsub-topic", ACCT)).rejects.toThrow("is not a list");
  });

  it("reads a key left out as empty: proto3 JSON omits an empty repeated field", async () => {
    const { client } = clientFor(() => ({}));
    await expect(client.listResources("pubsub-topic", ACCT)).resolves.toEqual([]);
  });

  it("rejects an aggregated answer whose items are not keyed by scope", async () => {
    const { client } = clientFor(() => ({ items: ["oops"] }));
    await expect(client.listResources("gce-instance", ACCT)).rejects.toThrow("is not a list");
  });
});

describe("a list that does not end", () => {
  it.each([
    ["a plain list", "pubsub-topic", { topics: [], nextPageToken: "more" }],
    ["an aggregated list", "gce-instance", { items: {}, nextPageToken: "more" }],
  ])("%s stops at 1,000 requests and says so", async (_, typeId, page) => {
    const { client, reads } = clientFor(() => page);
    await expect(client.listResources(typeId, ACCT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(reads()).toHaveLength(1000);
  });

  it("stops at 100,000 rows, the most one poll can write", async () => {
    const topics = Array.from({ length: 10_000 }, (_, i) => ({
      name: `projects/proj/topics/t${i}`,
    }));
    const { client, reads } = clientFor(() => ({ topics, nextPageToken: "more" }));
    await expect(client.listResources("pubsub-topic", ACCT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(reads()).toHaveLength(10);
  });
});

describe("lists that stopped at their first page", () => {
  const twoPages = (key: string, row: (n: number) => unknown) => (url: URL) =>
    url.searchParams.get("pageToken")
      ? { [key]: [row(2)] }
      : { [key]: [row(1)], nextPageToken: "2" };

  it("reads every log sink", async () => {
    const { client } = clientFor(twoPages("sinks", (n) => ({ name: `s${n}` })));
    const rows = await client.listResources("log-sink", ACCT);
    expect(rows.map((r) => r.fields.name)).toEqual(["s1", "s2"]);
  });

  it("reads every App Engine service", async () => {
    const { client } = clientFor(twoPages("services", (n) => ({ id: `svc${n}` })));
    const rows = await client.listResources("app-engine-service", ACCT);
    expect(rows.map((r) => r.fields.name)).toEqual(["svc1", "svc2"]);
  });

  it.each([
    ["cloud-tasks-queue", "queues", "cloudtasks.googleapis.com"],
    ["cloud-scheduler-job", "jobs", "cloudscheduler.googleapis.com"],
  ])("%s reads queues in every location", async (typeId, key) => {
    const { client } = clientFor((url) => {
      if (url.pathname.endsWith("/locations")) {
        return url.searchParams.get("pageToken")
          ? { locations: [{ name: "projects/proj/locations/two", locationId: "two" }] }
          : {
              locations: [{ name: "projects/proj/locations/one", locationId: "one" }],
              nextPageToken: "2",
            };
      }
      return { [key]: [{ name: `${url.pathname}/x` }] };
    });
    const rows = await client.listResources(typeId, ACCT);
    expect(rows.map((r) => r.fields.region)).toEqual(["one", "two"]);
  });
});

describe("Dataflow jobs", () => {
  it("reads every region's, not just the us-central1 that jobs.list answers for", async () => {
    const { client, reads } = clientFor(() => ({
      jobs: [{ id: "j1", name: "job", location: "europe-west1" }],
    }));
    const [row] = await client.listResources("dataflow-job", ACCT);
    expect(row!.fields.region).toBe("europe-west1");
    const url = new URL(reads()[0]![0].url);
    expect(url.pathname).toBe("/v1b3/projects/proj/jobs:aggregated");
    expect(url.searchParams.get("filter")).toBe("ACTIVE");
  });
});

describe("an answer that says part of the list did not come back", () => {
  const instance = { name: "projects/proj/locations/us-a/instances/a" };

  it.each([
    ["cloud-function", { functions: [{ name: "f/g" }], unreachable: ["us-b"] }],
    ["memorystore-valkey", { instances: [instance], unreachable: ["us-b"] }],
    ["gke-cluster", { clusters: [{ name: "c" }], missingZones: ["us-b-a"] }],
    ["firestore-database", { databases: [{ name: "d/(default)" }], unreachable: ["d/x"] }],
    ["bigtable-instance", { instances: [{ name: "i/a" }], failedLocations: ["l/us-b"] }],
    ["dataflow-job", { jobs: [{ id: "j" }], failedLocation: [{ name: "us-b" }] }],
    [
      "gce-instance",
      {
        items: {
          "zones/us-a": { instances: [{ name: "vm", id: "1", zone: "z/us-a" }] },
          "zones/us-b": { warning: { code: "UNREACHABLE" } },
        },
      },
    ],
  ])("%s keeps what it read and leaves the type out of the prune", async (typeId, page) => {
    const { client } = clientFor(() => page);
    await expect(client.listResources(typeId, ACCT)).resolves.toHaveLength(1);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [`${ACCT}:${typeId}:`] });
  });

  it("fails where nobody keeps the rows it left out", async () => {
    Reflect.set(globalThis, unreadHook, () => false);
    const { client } = clientFor(() => ({ functions: [{ name: "f/g" }], unreachable: ["us-b"] }));
    await expect(client.listResources("cloud-function", ACCT)).rejects.toThrow(/could not reach/);
  });

  it("Redis drops the placeholder it sends for a location it could not reach", async () => {
    const { client } = clientFor(() => ({
      instances: [
        instance,
        {
          name: "projects/proj/locations/us-b/instances/-",
          state: "ERROR",
          statusMessage: "location not available for ListInstances",
        },
      ],
    }));
    const rows = await client.listResources("memorystore-redis", ACCT);
    expect(rows.map((r) => r.displayName)).toEqual(["a"]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [`${ACCT}:memorystore-redis:`] });
  });

  it.each([
    ["cloud-function", { functions: [{ name: "f/g" }], unreachable: [] }],
    ["memorystore-redis", { instances: [instance] }],
    [
      "gce-instance",
      {
        items: {
          "zones/us-a": { instances: [{ name: "vm", id: "1", zone: "z/us-a" }] },
          "zones/us-b": { warning: { code: "NO_RESULTS_ON_PAGE" } },
        },
      },
    ],
  ])("%s reports nothing when all of it came back", async (typeId, page) => {
    const { client } = clientFor(() => page);
    await expect(client.listResources(typeId, ACCT)).resolves.toHaveLength(1);
    expect(unread).not.toHaveBeenCalled();
  });
});

describe("an API switched off in the project", () => {
  // The two shapes Google answers with: the current ErrorInfo, and the older `errors[]`.
  const disabled = new Refusal(403, {
    error: {
      code: 403,
      message: "Cloud Key Management Service (KMS) API has not been used in project 1 before.",
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          metadata: { service: "cloudkms.googleapis.com", consumer: "projects/1" },
        },
      ],
    },
  });
  const disabledOlderShape = new Refusal(403, {
    error: {
      code: 403,
      message:
        "Access Not Configured. API has not been used in project 1 before or it is disabled.",
      errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
    },
  });
  const TYPES = ["kms-key-ring", "kms-key", "vertex-ai-endpoint", "cloud-build-trigger"];

  describe.each(TYPES)("%s", (typeId) => {
    it.each([
      ["SERVICE_DISABLED", disabled],
      ["accessNotConfigured", disabledOlderShape],
    ])("reads %s as none, with no error", async (_, refusal) => {
      const { client } = clientFor(() => refusal);
      await expect(client.listResources(typeId, ACCT)).resolves.toEqual([]);
    });

    it("leaves stored rows out of the prune while it is off", async () => {
      const { client } = clientFor(() => disabled);
      await client.listResources(typeId, ACCT);
      const prefixes = unread.mock.calls.flatMap(([part]) => part.idPrefixes ?? []);
      expect(prefixes.length).toBeGreaterThan(0);
      for (const prefix of prefixes) expect(prefix).toContain(`${ACCT}:${typeId}:`);
    });

    it("fails with Google's message where nobody keeps the rows", async () => {
      Reflect.set(globalThis, unreadHook, () => false);
      const { client } = clientFor(() => disabled);
      await expect(client.listResources(typeId, ACCT)).rejects.toThrow("not enabled");
    });

    it.each([
      ["any other 403", new Refusal(403, { error: { code: 403, status: "PERMISSION_DENIED" } })],
      [
        "a billing 403",
        new Refusal(403, {
          error: {
            code: 403,
            details: [{ reason: "BILLING_DISABLED", metadata: { service: "x" } }],
          },
        }),
      ],
      [
        "a throttle sent as a 403",
        new Refusal(403, { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }),
      ],
      ["a 429", new Refusal(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } })],
      ["a 503", new Refusal(503, { error: { code: 503, status: "UNAVAILABLE" } })],
      ["a 401", new Refusal(401, { error: { code: 401, status: "UNAUTHENTICATED" } })],
      [
        "SERVICE_DISABLED on anything but a 403",
        new Refusal(400, { error: { code: 400, details: [{ reason: "SERVICE_DISABLED" }] } }),
      ],
    ])("still fails on %s", async (_, refusal) => {
      const { client } = clientFor(() => refusal);
      await expect(client.listResources(typeId, ACCT)).rejects.toThrow();
    });
  });

  it.each(["vertex-ai-endpoint", "cloud-build-trigger"])(
    "%s fails when one region refuses for another reason and the rest are off",
    async (typeId) => {
      const { client } = clientFor((url) =>
        url.href.includes("us-east1")
          ? new Refusal(403, { error: { code: 403, status: "PERMISSION_DENIED" } })
          : disabled,
      );
      await expect(client.listResources(typeId, ACCT)).rejects.toThrow("403");
    },
  );

  it("still names the API to turn on for a type that is not one of these", async () => {
    const { client } = clientFor(() => disabled);
    await expect(client.listResources("pubsub-topic", ACCT)).rejects.toThrow("is not enabled");
  });
});
