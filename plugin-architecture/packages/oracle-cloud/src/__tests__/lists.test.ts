import type { UnreadListPart } from "@infrawrench/plugin-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityRoute, makeClient, TENANCY, type Reply } from "./helpers.js";

const PROD = "ocid1.compartment.oc1..prod";
const OTHER = "ocid1.compartment.oc1..other";
const HOOK = Symbol.for("infrawrench.unreadListPart");

const refused: Reply = { status: 404, body: { code: "NotAuthorizedOrNotFound", message: "x" } };

beforeEach(() => {
  // Every request goes through the fake host HTTP service; a fetch would be real traffic.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected fetch");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, HOOK);
});

/** Install the host's unread-list hook, as the server's sync does, and collect what it is told. */
function trackUnread(): UnreadListPart[] {
  const parts: UnreadListPart[] = [];
  Reflect.set(globalThis, HOOK, (part: UnreadListPart) => parts.push(part));
  return parts;
}

const vcn = (compartmentId: string, id = "ocid1.vcn.oc1.iad.v") => ({
  id,
  displayName: "main",
  compartmentId,
  cidrBlocks: ["10.0.0.0/16"],
  lifecycleState: "AVAILABLE",
});

describe("Oracle Cloud lists that cannot be read whole", () => {
  it("throws at the page cap instead of returning part of a list", async () => {
    const { client, calls } = makeClient((url) => {
      if (url.pathname === "/20160918/vcns") {
        if (url.searchParams.get("compartmentId") !== PROD) return { body: [] };
        const page = Number(url.searchParams.get("page") ?? "0");
        return {
          body: [vcn(PROD, `ocid1.vcn.oc1.iad.v${page}`)],
          headers: { "opc-next-page": String(page + 1) },
        };
      }
      return identityRoute(url);
    });
    await expect(client.listResources("vcn", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    const pages = calls.filter(
      (c) =>
        c.url.pathname === "/20160918/vcns" && c.url.searchParams.get("compartmentId") === PROD,
    );
    expect(pages).toHaveLength(100);
  });

  it("refuses a first page that is not a list", async () => {
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/vcns") return { body: { vcns: [vcn(TENANCY)] } };
      return identityRoute(url);
    });
    await expect(client.listResources("vcn", "acct")).rejects.toThrow("is not a list");
  });

  it("refuses a later page that is not a list", async () => {
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/vcns") {
        if (url.searchParams.get("page") === "2") return { body: { message: "busy" } };
        return { body: [vcn(TENANCY)], headers: { "opc-next-page": "2" } };
      }
      return identityRoute(url);
    });
    await expect(client.listResources("vcn", "acct")).rejects.toThrow("is not a list");
  });

  it("refuses an empty answer rather than read it as no rows", async () => {
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/vcns") return { raw: "" };
      return identityRoute(url);
    });
    await expect(client.listResources("vcn", "acct")).rejects.toThrow("is not a list");
  });

  it("falls back to every compartment when Resource Search has more than it reads", async () => {
    const { client, calls } = makeClient((url) => {
      if (url.hostname.startsWith("query.")) {
        const page = Number(url.searchParams.get("page") ?? "0");
        return {
          body: { items: [{ resourceType: "Vcn", compartmentId: PROD }] },
          headers: { "opc-next-page": String(page + 1) },
        };
      }
      if (url.pathname === "/20160918/compartments") {
        return {
          body: [
            { id: PROD, compartmentId: TENANCY, name: "prod", lifecycleState: "ACTIVE" },
            { id: OTHER, compartmentId: TENANCY, name: "other", lifecycleState: "ACTIVE" },
          ],
        };
      }
      if (url.pathname === "/20160918/vcns") return { body: [] };
      return identityRoute(url);
    });
    await client.listResources("vcn", "acct");
    const listed = calls
      .filter((c) => c.url.pathname === "/20160918/vcns")
      .map((c) => c.url.searchParams.get("compartmentId"));
    expect(listed.sort()).toEqual([OTHER, PROD, TENANCY].sort());
  });

  it("does not read a failed attachment list as every volume unattached", async () => {
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/volumes") {
        return {
          body: [
            {
              id: "ocid1.volume.oc1.iad.vol",
              displayName: "data",
              compartmentId: TENANCY,
              availabilityDomain: "Uocm:US-ASHBURN-AD-1",
              lifecycleState: "AVAILABLE",
            },
          ],
        };
      }
      if (url.pathname === "/20160918/volumeAttachments") {
        return { status: 502, body: { code: "BadGateway", message: "upstream" } };
      }
      return identityRoute(url);
    });
    await expect(client.listResources("block-volume", "acct")).rejects.toThrow("502");
  });

  it("passes a truncated attachment list through the lister's catch", async () => {
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/volumes") {
        return {
          body: [
            {
              id: "ocid1.volume.oc1.iad.vol",
              displayName: "data",
              compartmentId: TENANCY,
              availabilityDomain: "Uocm:US-ASHBURN-AD-1",
              lifecycleState: "AVAILABLE",
            },
          ],
        };
      }
      if (url.pathname === "/20160918/volumeAttachments") {
        const page = Number(url.searchParams.get("page") ?? "0");
        return { body: [], headers: { "opc-next-page": String(page + 1) } };
      }
      return identityRoute(url);
    });
    await expect(client.listResources("block-volume", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("keeps a type's rows when every scope refuses the credential", async () => {
    const parts = trackUnread();
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/vcns") return refused;
      return identityRoute(url);
    });
    await expect(client.listResources("vcn", "acct")).resolves.toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it("reads one refused compartment as empty and keeps the type pruning", async () => {
    const parts = trackUnread();
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/vcns") {
        return url.searchParams.get("compartmentId") === PROD ? refused : { body: [vcn(TENANCY)] };
      }
      return identityRoute(url);
    });
    const vcns = await client.listResources("vcn", "acct");
    expect(vcns).toHaveLength(1);
    expect(parts).toEqual([]);
  });

  it("keeps budgets when the credential cannot read them", async () => {
    const parts = trackUnread();
    const { client } = makeClient((url) => identityRoute(url));
    await expect(client.listResources("budget", "acct")).resolves.toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it("shows a budget refusal where the host keeps no track", async () => {
    const { client } = makeClient((url) => identityRoute(url));
    await expect(client.listResources("budget", "acct")).rejects.toThrow("NotAuthorizedOrNotFound");
  });

  it("names the budget whose alert rules were refused, so its rules stay", async () => {
    const parts = trackUnread();
    const { client } = makeClient((url) => {
      if (url.pathname === "/20190111/budgets") {
        return {
          body: [
            { id: "ocid1.budget.oc1.iad.a", displayName: "a", amount: 1, lifecycleState: "ACTIVE" },
            { id: "ocid1.budget.oc1.iad.b", displayName: "b", amount: 1, lifecycleState: "ACTIVE" },
          ],
        };
      }
      if (url.pathname === "/20190111/budgets/ocid1.budget.oc1.iad.a/alertRules") {
        return {
          body: [
            {
              id: "rule1",
              budgetId: "ocid1.budget.oc1.iad.a",
              displayName: "",
              type: "ACTUAL",
              thresholdType: "PERCENTAGE",
              threshold: 80,
              lifecycleState: "ACTIVE",
            },
          ],
        };
      }
      return identityRoute(url);
    });
    const rules = await client.listResources("budget-alert-rule", "acct");
    expect(rules.map((r) => r.externalId)).toEqual(["ocid1.budget.oc1.iad.a/rule1"]);
    expect(parts).toEqual([{ parentResourceIds: ["acct:budget:ocid1.budget.oc1.iad.b"] }]);
  });
});

describe("Oracle Cloud folder delete", () => {
  const objectRoute =
    (list: (url: URL) => Reply) =>
    (url: URL, method: string): Reply | undefined => {
      if (!url.hostname.startsWith("objectstorage.")) return identityRoute(url);
      if (url.pathname === "/n") return { body: "acmens" };
      if (url.pathname === "/n/acmens/b/logs/o" && method === "GET") return list(url);
      if (method === "DELETE") return { status: 204 };
      return undefined;
    };

  it("deletes nothing when the folder has more objects than it reads", async () => {
    const { client, calls } = makeClient(
      objectRoute((url) => {
        const page = Number(url.searchParams.get("start") ?? "0");
        return {
          body: { objects: [{ name: `old/${page}.log` }], nextStartWith: String(page + 1) },
        };
      }),
    );
    await expect(client.deleteStorageObject("us-ashburn-1/logs", "old/")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("deletes nothing when a page of the folder is not a list", async () => {
    const { client, calls } = makeClient(objectRoute(() => ({ body: { message: "busy" } })));
    await expect(client.deleteStorageObject("us-ashburn-1/logs", "old/")).rejects.toThrow(
      "is not a list",
    );
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("deletes every object under the folder, then the folder", async () => {
    const { client, calls } = makeClient(
      objectRoute((url) =>
        url.searchParams.get("start") === "old/b.log"
          ? { body: { objects: [{ name: "old/b.log" }] } }
          : {
              body: {
                objects: [{ name: "old/" }, { name: "old/a.log" }],
                nextStartWith: "old/b.log",
              },
            },
      ),
    );
    await client.deleteStorageObject("us-ashburn-1/logs", "old/");
    expect(
      calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.url.pathname)),
    ).toEqual([
      "/n/acmens/b/logs/o/old/a.log",
      "/n/acmens/b/logs/o/old/b.log",
      "/n/acmens/b/logs/o/old/",
    ]);
  });
});
