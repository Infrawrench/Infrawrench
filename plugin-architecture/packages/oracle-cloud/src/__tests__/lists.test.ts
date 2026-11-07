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
});
