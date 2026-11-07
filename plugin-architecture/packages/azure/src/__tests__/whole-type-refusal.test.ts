/**
 * A principal refused a whole type keeps its stored rows without failing it, as a
 * least-privilege role is normal. Runs the real client over a fake host transport.
 */
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AzureClient } from "../client.js";

const creds = { tenantId: "t", clientId: "c", clientSecret: "s", subscriptionId: "sub" };

type HostRequest = { url: string; method: string; headers: Record<string, string> };

function answer(status: number, value: unknown) {
  const body = JSON.stringify(value);
  return {
    status,
    headers: { "content-type": "application/json" },
    body,
    rawBody: new TextEncoder().encode(body),
  };
}

const armDenied = answer(403, {
  error: {
    code: "AuthorizationFailed",
    message:
      "The client 'c' does not have authorization to perform action 'Microsoft.Compute/virtualMachines/read' over scope '/subscriptions/sub'.",
  },
});
const graphDenied = answer(403, {
  error: { code: "Authorization_RequestDenied", message: "Insufficient privileges." },
});

/** ARM and Graph answer from `route`; the token endpoint always gives a token. */
function clientFor(route: (url: URL) => ReturnType<typeof answer>) {
  const request = vi.fn(async (req: HostRequest) => {
    const url = new URL(req.url);
    if (url.hostname === "login.microsoftonline.com") {
      return answer(200, { access_token: "tok", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.hostname === "management.azure.com" || url.hostname === "graph.microsoft.com") {
      return route(url);
    }
    throw new Error(`unexpected request: ${req.url}`);
  });
  return hostClient(new AzureClient(creds, [], { http: { request } }));
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

describe("a principal refused a whole type", () => {
  it.each(["azure-vm", "azure-sql-database", "azure-ai-services"])(
    "keeps the stored %s rows without an error",
    async (typeId) => {
      const client = clientFor(() => armDenied);
      await expect(client.listResources(typeId, "acct")).resolves.toEqual([]);
      expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
    },
  );

  it("keeps stored app registrations when Graph refuses", async () => {
    const client = clientFor(() => graphDenied);
    await expect(client.listResources("azure-app-registration", "acct")).resolves.toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
  });

  it("fails with the refusal where nobody keeps the rows", async () => {
    Reflect.set(globalThis, unreadHook, () => false);
    const client = clientFor(() => armDenied);
    await expect(client.listResources("azure-vm", "acct")).rejects.toThrow("AuthorizationFailed");
  });

  it.each([
    ["a 429", answer(429, { error: { code: "TooManyRequests" } })],
    ["a 500", answer(500, { error: { code: "InternalServerError" } })],
    ["a 401", answer(401, { error: { code: "InvalidAuthenticationToken" } })],
  ])("still fails on %s", async (_, refusal) => {
    const client = clientFor(() => refusal);
    await expect(client.listResources("azure-vm", "acct")).rejects.toThrow();
    expect(unread).not.toHaveBeenCalled();
  });
});

describe("SQL databases when one server's databases are refused", () => {
  const server = (name: string) => ({
    name,
    id: `/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Sql/servers/${name}`,
    properties: { fullyQualifiedDomainName: `${name}.database.windows.net` },
  });
  const client = () =>
    clientFor((url) => {
      if (url.pathname.endsWith("/providers/Microsoft.Sql/servers")) {
        return answer(200, { value: [server("one"), server("two")] });
      }
      if (url.pathname.includes("/servers/two/")) return armDenied;
      return answer(200, { value: [{ name: "db", properties: {} }] });
    });

  it("keeps that server's stored databases out of the prune", async () => {
    const rows = await client().listResources("azure-sql-database", "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["rg/one/db"]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: ["acct:azure-sql-database:rg/two/"] });
  });

  it("fails where nobody keeps them", async () => {
    Reflect.set(globalThis, unreadHook, () => false);
    await expect(client().listResources("azure-sql-database", "acct")).rejects.toThrow(
      "AuthorizationFailed",
    );
  });
});
