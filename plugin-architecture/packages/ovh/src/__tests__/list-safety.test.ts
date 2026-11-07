import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OvhClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct1";
const BASE = "https://eu.api.ovh.com/1.0";
const PROJECT = "/cloud/project/proj123";
const CREDS = {
  applicationKey: "ak",
  applicationSecret: "as",
  consumerKey: "ck",
  projectId: "proj123",
};

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const unread = vi.fn();

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const notGranted = () =>
  answer(
    {
      errorCode: "NOT_GRANTED_CALL",
      httpCode: "403 Forbidden",
      message: "This call has not been granted",
    },
    403,
  );
const iamDenied = () =>
  answer(
    {
      class: "Client::Forbidden",
      message: "Forbidden",
      details: { unauthorizedActionsByIAM: "publicCloudProject:apiovh:get" },
    },
    403,
  );
const deadCredential = () =>
  answer(
    {
      errorCode: "INVALID_CREDENTIAL",
      httpCode: "403 Forbidden",
      message: "This credential is not valid",
    },
    403,
  );
const badSignature = () =>
  answer(
    { errorCode: "INVALID_SIGNATURE", httpCode: "400 Bad Request", message: "Invalid signature" },
    400,
  );
const badRequest = () => answer({ class: "Client::BadRequest", message: "Not here" }, 400);
const missing = () => answer({ class: "Client::NotFound", message: "Not found" }, 404);
const unavailable = () => answer({ class: "Server::InternalServerError", message: "Oops" }, 500);
const throttled = () => answer({ message: "Too many requests" }, 429);

type Routes = Record<string, () => Response>;

/** Answers only what a test names, and throws on anything else, so no request can leave. */
function serve(routes: Routes): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const path = String(input).replace(BASE, "").split("?")[0]!;
    if (path === "/auth/time") return answer(1700000000);
    const route = routes[path];
    if (!route) throw new Error(`Unexpected request to ${path}`);
    return route();
  });
}

function makeClient() {
  return hostClient(new OvhClient(CREDS, plugin.resourceTypes));
}

beforeEach(() => {
  unread.mockClear();
  Reflect.set(globalThis, UNREAD_HOOK, unread);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.unstubAllGlobals();
});

describe.each([
  ["object-storage-bucket", "/storage", { name: "b1" }, "A/b1"],
  ["floating-ip", "/floatingip", { id: "f1", ip: "192.0.2.1" }, "A/f1"],
  ["gateway", "/gateway", { id: "g1", name: "gw" }, "A/g1"],
  ["octavia-load-balancer", "/loadbalancing/loadbalancer", { id: "l1", name: "lb" }, "A/l1"],
])("%s across regions", (typeId, suffix, row, externalId) => {
  const path = (region: string) => `${PROJECT}/region/${region}${suffix}`;

  /** Region A has a row; region B answers as the test says. */
  function regionB(answerB: () => Response): Routes {
    return {
      [`${PROJECT}/region`]: () => answer(["A", "B"]),
      [path("A")]: () => answer([row]),
      [path("B")]: answerB,
      [`${PROJECT}/region/A/loadbalancing/flavor`]: () => answer([]),
      [`${PROJECT}/region/B/loadbalancing/flavor`]: () => answer([]),
    };
  }

  it.each([
    ["a 500", unavailable, /OVH API error 500/],
    ["a throttle", throttled, /OVH API error 429/],
    ["a dead credential", deadCredential, /OVH API error 403/],
    ["a bad signature", badSignature, /OVH API error 400/],
    ["a page that is no list", () => answer({ items: [] }), /is not a list/],
    ["an empty answer", () => new Response(null, { status: 204 }), /is not a list/],
  ])("fails the type on %s, so stored rows stay", async (_name, answerB, message) => {
    serve(regionB(answerB));
    await expect(makeClient().listResources(typeId, ACCOUNT)).rejects.toThrow(message);
    expect(unread).not.toHaveBeenCalled();
  });

  it("reads a region with no such route as none", async () => {
    serve(regionB(missing));
    const rows = await makeClient().listResources(typeId, ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual([externalId]);
    expect(unread).not.toHaveBeenCalled();
  });

  it.each([
    ["an access rule", notGranted],
    ["IAM", iamDenied],
    ["a bad request", badRequest],
  ])("keeps only the region refused by %s", async (_name, answerB) => {
    serve(regionB(answerB));
    const rows = await makeClient().listResources(typeId, ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual([externalId]);
    expect(unread).toHaveBeenCalledExactlyOnceWith({
      idPrefixes: [`${ACCOUNT}:${typeId}:B/`],
    });
  });

  it("keeps the whole type quietly when every region refuses the credential", async () => {
    serve({
      ...regionB(notGranted),
      [path("A")]: iamDenied,
    });
    await expect(makeClient().listResources(typeId, ACCOUNT)).resolves.toEqual([]);
    expect(unread).toHaveBeenCalledExactlyOnceWith({ idPrefixes: [""] });
  });

  it("fails the type when every region calls the request bad", async () => {
    serve({
      ...regionB(badRequest),
      [path("A")]: badRequest,
    });
    await expect(makeClient().listResources(typeId, ACCOUNT)).rejects.toThrow(/OVH API error 400/);
    expect(unread).not.toHaveBeenCalled();
  });

  it("keeps the whole type when the region list itself is refused", async () => {
    serve({ [`${PROJECT}/region`]: notGranted });
    await expect(makeClient().listResources(typeId, ACCOUNT)).resolves.toEqual([]);
    expect(unread).toHaveBeenCalledExactlyOnceWith({ idPrefixes: [""] });
  });

  it("fails the type when the region list fails", async () => {
    serve({ [`${PROJECT}/region`]: unavailable });
    await expect(makeClient().listResources(typeId, ACCOUNT)).rejects.toThrow(/OVH API error 500/);
    expect(unread).not.toHaveBeenCalled();
  });

  it("tells a refusal apart through the host's transport too", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("The host transport was bypassed");
    });
    const respond = (status: number, body: unknown) => ({
      status,
      headers: {},
      body: JSON.stringify(body),
    });
    const request = vi.fn(async ({ url }: { url: string }) => {
      const at = url.replace(BASE, "").split("?")[0]!;
      if (at === "/auth/time") return respond(200, 1700000000);
      if (at === `${PROJECT}/region`) return respond(200, ["A", "B"]);
      if (at === path("A")) return respond(200, [row]);
      if (at === path("B")) return respond(403, { errorCode: "NOT_GRANTED_CALL", message: "No" });
      if (at.endsWith("/loadbalancing/flavor")) return respond(200, []);
      throw new Error(`Unexpected request to ${at}`);
    });
    const client = hostClient(new OvhClient(CREDS, plugin.resourceTypes, { http: { request } }));
    const rows = await client.listResources(typeId, ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual([externalId]);
    expect(unread).toHaveBeenCalledExactlyOnceWith({
      idPrefixes: [`${ACCOUNT}:${typeId}:B/`],
    });
    expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
  });
});

describe("a type that is not read per region", () => {
  it("keeps its rows quietly when the credential is refused", async () => {
    serve({ [`${PROJECT}/instance`]: notGranted });
    await expect(makeClient().listResources("instance", ACCOUNT)).resolves.toEqual([]);
    expect(unread).toHaveBeenCalledExactlyOnceWith({ idPrefixes: [""] });
  });

  it.each([
    ["a dead credential", deadCredential, /OVH API error 403/],
    ["a 500", unavailable, /OVH API error 500/],
    ["a throttle", throttled, /OVH API error 429/],
  ])("fails on %s", async (_name, route, message) => {
    serve({ [`${PROJECT}/instance`]: route });
    await expect(makeClient().listResources("instance", ACCOUNT)).rejects.toThrow(message);
    expect(unread).not.toHaveBeenCalled();
  });

  it("does not turn a refusal into a resource that is gone", async () => {
    serve({ [`${PROJECT}/instance`]: notGranted });
    await expect(
      makeClient().getResource("instance", `${ACCOUNT}:instance:i1`, ACCOUNT),
    ).rejects.toThrow(/OVH API error 403/);
    expect(unread).not.toHaveBeenCalled();
  });
});
