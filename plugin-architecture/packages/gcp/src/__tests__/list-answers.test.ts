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
    return answer(200, route(url));
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

