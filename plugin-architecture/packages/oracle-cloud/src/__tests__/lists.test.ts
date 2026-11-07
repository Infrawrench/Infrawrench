import { evaluateOrphanRule, type UnreadListPart } from "@infrawrench/plugin-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_TYPES } from "../resource-types.js";
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

  it("shows a budget whose alert rules were refused where the host keeps no track", async () => {
    const { client } = makeClient((url) => {
      if (url.pathname === "/20190111/budgets") {
        return {
          body: [
            { id: "ocid1.budget.oc1.iad.a", displayName: "a", amount: 1, lifecycleState: "ACTIVE" },
          ],
        };
      }
      return identityRoute(url);
    });
    await expect(client.listResources("budget-alert-rule", "acct")).rejects.toThrow(
      "NotAuthorizedOrNotFound",
    );
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

describe("Oracle Cloud image lookups", () => {
  it("looks an image up again after a failed lookup", async () => {
    let imageReads = 0;
    const { client } = makeClient((url) => {
      if (url.pathname === "/20160918/instances") {
        if (url.searchParams.get("compartmentId") !== TENANCY) return { body: [] };
        return {
          body: [
            {
              id: "ocid1.instance.oc1.iad.retry",
              displayName: "retry",
              compartmentId: TENANCY,
              availabilityDomain: "Uocm:US-ASHBURN-AD-1",
              region: "us-ashburn-1",
              shape: "VM.Standard.E4.Flex",
              imageId: "ocid1.image.oc1.iad.flaky",
              lifecycleState: "RUNNING",
            },
          ],
        };
      }
      if (url.pathname === "/20160918/vnicAttachments") return { body: [] };
      if (url.pathname === "/20160918/bootVolumeAttachments") return { body: [] };
      if (url.pathname === "/20160918/images/ocid1.image.oc1.iad.flaky") {
        imageReads++;
        if (imageReads === 1) return { status: 502, body: { code: "BadGateway", message: "x" } };
        return {
          body: { displayName: "Canonical-Ubuntu-24.04", operatingSystem: "Canonical Ubuntu" },
        };
      }
      return identityRoute(url);
    });
    const [first] = await client.listResources("instance", "acct");
    expect(first!.fields["sshUsername"]).toBe("opc");
    const [second] = await client.listResources("instance", "acct");
    expect(second!.fields["sshUsername"]).toBe("ubuntu");
  });
});

describe("Oracle Cloud volume attachments across compartments", () => {
  const AD = "Uocm:US-ASHBURN-AD-1";
  const VOLUME = "ocid1.volume.oc1.iad.data";
  const BOOT = "ocid1.bootvolume.oc1.iad.boot";
  const INSTANCE = "ocid1.instance.oc1.iad.app";
  const ruleOf = (typeId: string) => RESOURCE_TYPES.find((t) => t.id === typeId)!.orphanRule;

  /** The volumes live in the root compartment; `prod` answers for its attachments. */
  function route(prod: Reply, compartments?: Array<{ id: string; name: string }>) {
    return (url: URL): Reply | undefined => {
      const compartment = url.searchParams.get("compartmentId");
      if (compartments && url.pathname === "/20160918/compartments") {
        return {
          body: compartments.map((c) => ({
            ...c,
            compartmentId: TENANCY,
            lifecycleState: "ACTIVE",
          })),
        };
      }
      if (url.pathname === "/20160918/volumes" || url.pathname === "/20160918/bootVolumes") {
        if (compartment !== TENANCY) return { body: [] };
        const id = url.pathname === "/20160918/volumes" ? VOLUME : BOOT;
        return {
          body: [
            {
              id,
              displayName: "v",
              compartmentId: TENANCY,
              availabilityDomain: AD,
              lifecycleState: "AVAILABLE",
            },
          ],
        };
      }
      if (
        url.pathname === "/20160918/volumeAttachments" ||
        url.pathname === "/20160918/bootVolumeAttachments"
      ) {
        if (compartment === PROD) return prod;
        return { body: [] };
      }
      return identityRoute(url);
    };
  }

  const attachedFromProd: Reply = {
    body: [
      { instanceId: INSTANCE, volumeId: VOLUME, bootVolumeId: BOOT, lifecycleState: "ATTACHED" },
    ],
  };

  it("finds an attachment made from an instance in another compartment", async () => {
    const { client } = makeClient(route(attachedFromProd));
    const [volume] = await client.listResources("block-volume", "acct");
    expect(volume!.fields["attachedTo"]).toBe(INSTANCE);
    expect(evaluateOrphanRule(ruleOf("block-volume"), volume!.fields)).toBeNull();
    const [boot] = await client.listResources("boot-volume", "acct");
    expect(boot!.fields["attachedInstanceId"]).toBe(INSTANCE);
    expect(evaluateOrphanRule(ruleOf("boot-volume"), boot!.fields)).toBeNull();
  });

  it("reports a volume unattached once every compartment was read", async () => {
    const { client } = makeClient(route({ body: [] }));
    const [volume] = await client.listResources("block-volume", "acct");
    expect(volume!.fields["attachedTo"]).toBe("");
    expect(evaluateOrphanRule(ruleOf("block-volume"), volume!.fields)).not.toBeNull();
    const [boot] = await client.listResources("boot-volume", "acct");
    expect(boot!.fields["attachedInstanceId"]).toBe("");
    expect(evaluateOrphanRule(ruleOf("boot-volume"), boot!.fields)).not.toBeNull();
  });

  it("leaves attachment unknown when a compartment's attachments were refused", async () => {
    const { client } = makeClient(route(refused));
    const [volume] = await client.listResources("block-volume", "acct");
    expect(volume!.fields).not.toHaveProperty("attachedTo");
    expect(evaluateOrphanRule(ruleOf("block-volume"), volume!.fields)).toBeNull();
    const [boot] = await client.listResources("boot-volume", "acct");
    expect(boot!.fields).not.toHaveProperty("attachedInstanceId");
    expect(evaluateOrphanRule(ruleOf("boot-volume"), boot!.fields)).toBeNull();
  });

  it("leaves attachment unknown when the other compartments do not fit the request budget", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      id: `ocid1.compartment.oc1..c${i}`,
      name: `c${i}`,
    }));
    const { client } = makeClient((url) =>
      // Resource Search names only the root compartment, so only it is a scope.
      url.hostname.startsWith("query.") ? { body: { items: [] } } : route({ body: [] }, many)(url),
    );
    const [volume] = await client.listResources("block-volume", "acct");
    expect(volume!.fields).not.toHaveProperty("attachedTo");
    expect(evaluateOrphanRule(ruleOf("block-volume"), volume!.fields)).toBeNull();
  });
});
