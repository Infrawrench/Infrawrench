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

describe("fetchCostData", () => {
  const today = new Date().toISOString().slice(0, 10);
  const range = { fromDate: today, toDate: today };
  const bill = {
    "/me/bill": () => answer(["B1"]),
    "/me/bill/B1": () =>
      answer({ date: today, priceWithoutTax: { currencyCode: "EUR", value: 10 } }),
  };
  const noDetails = { "/me/bill/B1/details": () => answer([]) };
  const usage = {
    "/me/consumption/usage/current": () =>
      answer([{ beginDate: today, serviceId: 7, price: { currencyCode: "EUR", value: 5 } }]),
  };
  const amounts = (rows: Array<{ service?: string; amount: number }>) =>
    rows.map((r) => [r.service, r.amount]);

  it("reads the bill total and the current period", async () => {
    serve({ ...bill, ...noDetails, ...usage });
    const rows = await makeClient().fetchCostData(ACCOUNT, range);
    expect(amounts(rows)).toEqual([
      ["", 10],
      ["7", 5],
    ]);
  });

  it.each([
    ["a 500", unavailable],
    ["a throttle", throttled],
    ["a dead credential", deadCredential],
    ["a page that is no list", () => answer({ items: [] })],
  ])("fails on %s from the current period, so today's rows stay", async (_name, route) => {
    serve({ ...bill, ...noDetails, "/me/consumption/usage/current": route });
    await expect(makeClient().fetchCostData(ACCOUNT, range)).rejects.toThrow();
  });

  it.each([
    ["no access rule", notGranted],
    ["no such route", missing],
    ["a bad request", badRequest],
  ])("still reads the invoices with %s for the current period", async (_name, route) => {
    serve({ ...bill, ...noDetails, "/me/consumption/usage/current": route });
    const rows = await makeClient().fetchCostData(ACCOUNT, range);
    expect(amounts(rows)).toEqual([["", 10]]);
  });

  it.each([
    ["a 500", unavailable],
    ["a throttle", throttled],
    ["a dead credential", deadCredential],
  ])("fails on %s from a bill's lines rather than lose the breakdown", async (_name, route) => {
    serve({ ...bill, "/me/bill/B1/details": route, ...usage });
    await expect(makeClient().fetchCostData(ACCOUNT, range)).rejects.toThrow();
  });

  it.each([
    ["no access rule", notGranted],
    ["no such route", missing],
  ])("falls back to the bill total with %s for its lines", async (_name, route) => {
    serve({ ...bill, "/me/bill/B1/details": route, ...usage });
    const rows = await makeClient().fetchCostData(ACCOUNT, range);
    expect(amounts(rows)).toEqual([
      ["", 10],
      ["7", 5],
    ]);
  });

  it.each([
    ["the invoices", "/me/bill", bill],
    ["the current period", "/me/consumption/usage/current", { ...bill, ...noDetails }],
  ])("refuses an empty answer for %s rather than read it as none", async (_name, path, routes) => {
    serve({ ...routes, [path]: () => new Response(null, { status: 204 }) });
    await expect(makeClient().fetchCostData(ACCOUNT, range)).rejects.toThrow(/is not a list/);
  });
});
