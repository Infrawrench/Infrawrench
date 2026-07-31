import { describe, it, expect, vi, afterEach } from "vitest";
import { evaluateOrphanRule } from "@infrawrench/plugin-base";
import { DigitalOceanClient } from "../client.js";
import { ReservedIpResourceType } from "../resources/reserved-ip.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

function installFetch(route: (path: string, method: string, body?: string) => unknown | undefined) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace("https://api.digitalocean.com/v2", "");
    const result = route(path, init?.method ?? "GET", init?.body as string | undefined);
    if (result === undefined) return jsonResponse({}, 404);
    return jsonResponse(result);
  }) as typeof fetch);
}

const ACC = "acc1";
const newClient = () => new DigitalOceanClient({ apiToken: "tok" }, [ReservedIpResourceType]);

const assignedIp = {
  ip: "45.55.96.47",
  region: { slug: "nyc3", name: "New York 3" },
  droplet: { id: 758604968, name: "web-01" },
  locked: false,
  project_id: "746c6152-2fa2-11ed-92d3-27aaa54e4988",
};
const idleIp = {
  ip: "45.55.96.48",
  region: { slug: "nyc3", name: "New York 3" },
  droplet: null,
  locked: false,
  project_id: "746c6152-2fa2-11ed-92d3-27aaa54e4988",
};

afterEach(() => vi.restoreAllMocks());

// The rule is the whole point of the type existing — DO gives away assigned
// reserved IPs and bills $5/mo for idle ones.
describe("reserved-ip orphan rule", () => {
  const rule = ReservedIpResourceType.orphanRule;

  it("flags an unassigned, unlocked reserved IP", () => {
    expect(evaluateOrphanRule(rule, { dropletId: "", locked: false })).toBe(
      "Reserved IP is not assigned to any Droplet (DigitalOcean bills idle reserved IPs)",
    );
  });

  it("does not flag an assigned reserved IP", () => {
    expect(evaluateOrphanRule(rule, { dropletId: "758604968", locked: false })).toBeNull();
  });

  it("does not flag a locked address — DO has an action in flight", () => {
    expect(evaluateOrphanRule(rule, { dropletId: "", locked: true })).toBeNull();
  });

  // The GCP trap PR #20 documented: rows synced before this type existed (or
  // by any path that doesn't write these fields) must never be flagged. Both
  // conditions use `equals`, which never matches an absent field.
  it("never flags a row that predates the new fields", () => {
    expect(evaluateOrphanRule(rule, {})).toBeNull();
    expect(evaluateOrphanRule(rule, { locked: false })).toBeNull();
    expect(evaluateOrphanRule(rule, { dropletId: "" })).toBeNull();
  });

  it("matches what the lister actually writes", async () => {
    installFetch((path) =>
      path.startsWith("/reserved_ips") ? { reserved_ips: [assignedIp, idleIp] } : undefined,
    );
    const [assigned, idle] = await newClient().listResources("reserved-ip", ACC);
    expect(evaluateOrphanRule(rule, assigned!.fields)).toBeNull();
    expect(evaluateOrphanRule(rule, idle!.fields)).toContain("not assigned to any Droplet");
  });
});

describe("listResources('reserved-ip')", () => {
  it("maps the DO payload, keying on the address itself", async () => {
    installFetch((path) =>
      path === "/reserved_ips?per_page=200" ? { reserved_ips: [assignedIp, idleIp] } : undefined,
    );
    const resources = await newClient().listResources("reserved-ip", ACC);
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      id: `${ACC}:reserved-ip:45.55.96.47`,
      resourceTypeId: "reserved-ip",
      displayName: "45.55.96.47",
      externalId: "45.55.96.47",
      parentResourceId: `${ACC}:project:746c6152-2fa2-11ed-92d3-27aaa54e4988`,
      fields: {
        ip: "45.55.96.47",
        region: "nyc3",
        dropletId: "758604968",
        dropletName: "web-01",
        locked: false,
      },
    });
    expect(resources[0]!.resolvedOutputs["ip"]).toBe("45.55.96.47");
    // Always written, "" when unassigned — the orphan rule depends on it.
    expect(resources[1]!.fields["dropletId"]).toBe("");
    expect(resources[1]!.fields["dropletName"]).toBe("");
  });

  it("tolerates a missing project_id (token without project:read)", async () => {
    installFetch((path) =>
      path.startsWith("/reserved_ips")
        ? { reserved_ips: [{ ...idleIp, project_id: undefined }] }
        : undefined,
    );
    const [resource] = await newClient().listResources("reserved-ip", ACC);
    expect(resource!.parentResourceId).toBeUndefined();
    expect(resource!.fields["projectId"]).toBe("");
  });

  it("returns [] when the account has none", async () => {
    installFetch((path) => (path.startsWith("/reserved_ips") ? { reserved_ips: null } : undefined));
    expect(await newClient().listResources("reserved-ip", ACC)).toEqual([]);
  });
});

describe("reserved-ip detail view", () => {
  const instance = (
    fields: Record<string, unknown>,
    droplets: Array<{ id: string; label: string }> = [],
  ) => ({
    id: `${ACC}:reserved-ip:45.55.96.48`,
    pluginId: "digitalocean",
    resourceTypeId: "reserved-ip",
    accountId: ACC,
    displayName: "45.55.96.48",
    fields,
    resolvedOutputs: { __droplets__: JSON.stringify(droplets) },
    secretStates: [],
    externalId: "45.55.96.48",
  });

  it("offers an Assign picker for an unassigned address", () => {
    const detail = newClient().renderDetail(
      instance({ ip: "45.55.96.48", region: "nyc3", dropletId: "", locked: false }, [
        { id: "1", label: "web-01" },
      ]) as never,
    );
    const assign = detail.headerActions?.find((a) => a.label === "Assign to Droplet…");
    expect(assign).toBeDefined();
    expect(assign!.action).toMatchObject({
      type: "prompt-nosql-command",
      command: "reserved-ip-assign",
    });
    // No Unassign when there's nothing to unassign from.
    expect(detail.headerActions?.some((a) => a.label === "Unassign")).toBe(false);
  });

  it("blocks the Assign prompt when the region has no Droplets", () => {
    const detail = newClient().renderDetail(
      instance({ ip: "45.55.96.48", region: "syd1", dropletId: "", locked: false }) as never,
    );
    const assign = detail.headerActions?.find((a) => a.label === "Assign to Droplet…");
    expect(assign!.action).toMatchObject({ blocked: true, descriptionVariant: "error" });
  });

  it("offers Unassign (only) when assigned", () => {
    const detail = newClient().renderDetail(
      instance({
        ip: "45.55.96.47",
        region: "nyc3",
        dropletId: "758604968",
        dropletName: "web-01",
        locked: false,
      }) as never,
    );
    const unassign = detail.headerActions?.find((a) => a.label === "Unassign");
    expect(unassign!.action).toMatchObject({
      type: "plugin-action",
      actionId: "reserved-ip-unassign",
    });
    expect(unassign!.action).toHaveProperty("confirmMessage");
    expect(detail.headerActions?.some((a) => a.label === "Reassign…")).toBe(true);
  });

  it("hides both actions while DO holds a lock on the address", () => {
    const detail = newClient().renderDetail(
      instance({ ip: "45.55.96.48", region: "nyc3", dropletId: "", locked: true }) as never,
    );
    expect(detail.headerActions?.map((a) => a.label)).toEqual(["Refresh"]);
  });
});

describe("reserved-ip actions", () => {
  it("unassigns via the actions endpoint", async () => {
    let posted: string | undefined;
    installFetch((path, method, body) => {
      if (path === "/reserved_ips?per_page=200") return { reserved_ips: [assignedIp] };
      if (path === "/reserved_ips/45.55.96.47/actions" && method === "POST") {
        posted = body;
        return { action: { id: 1, status: "completed" } };
      }
      return undefined;
    });
    await newClient().invokeAction(
      "reserved-ip",
      `${ACC}:reserved-ip:45.55.96.47`,
      "reserved-ip-unassign",
      ACC,
    );
    expect(JSON.parse(posted!)).toEqual({ type: "unassign" });
  });

  it("refuses to unassign an address that isn't assigned", async () => {
    installFetch((path) =>
      path.startsWith("/reserved_ips") ? { reserved_ips: [idleIp] } : undefined,
    );
    await expect(
      newClient().invokeAction(
        "reserved-ip",
        `${ACC}:reserved-ip:45.55.96.48`,
        "reserved-ip-unassign",
        ACC,
      ),
    ).rejects.toThrow(/not assigned/i);
  });

  it("assigns to the Droplet picked in the prompt", async () => {
    let posted: string | undefined;
    installFetch((path, method, body) => {
      if (path === "/reserved_ips/45.55.96.48/actions" && method === "POST") {
        posted = body;
        return { action: { id: 2, status: "completed" } };
      }
      return undefined;
    });
    await newClient().executeNoSqlCommand(
      "reserved-ip",
      `${ACC}:reserved-ip:45.55.96.48`,
      ACC,
      "reserved-ip-assign",
      [JSON.stringify({ dropletId: "758604968" })],
    );
    expect(JSON.parse(posted!)).toEqual({ type: "assign", droplet_id: 758604968 });
  });

  it("rejects an assign with no Droplet picked", async () => {
    installFetch(() => undefined);
    await expect(
      newClient().executeNoSqlCommand(
        "reserved-ip",
        `${ACC}:reserved-ip:45.55.96.48`,
        ACC,
        "reserved-ip-assign",
        [JSON.stringify({ dropletId: "" })],
      ),
    ).rejects.toThrow(/Pick a Droplet/);
  });

  it("deletes by address", async () => {
    let seen: [string, string] | undefined;
    installFetch((path, method) => {
      seen = [path, method];
      return {};
    });
    await newClient().deleteResource("reserved-ip", `${ACC}:reserved-ip:45.55.96.48`, ACC);
    expect(seen).toEqual(["/reserved_ips/45.55.96.48", "DELETE"]);
  });
});

describe("reserved-ip drag-attach", () => {
  it("assigns when dropped on a Droplet in the same region", async () => {
    let posted: string | undefined;
    installFetch((path, method, body) => {
      if (path === "/reserved_ips?per_page=200") return { reserved_ips: [idleIp] };
      if (path === "/droplets/999")
        return { droplet: { id: 999, name: "web-02", region: { slug: "nyc3" } } };
      if (path === "/reserved_ips/45.55.96.48/actions" && method === "POST") {
        posted = body;
        return { action: { id: 3, status: "completed" } };
      }
      return undefined;
    });
    await newClient().attachResource(
      "reserved-ip",
      `${ACC}:reserved-ip:45.55.96.48`,
      "droplet",
      `${ACC}:droplet:999`,
      ACC,
    );
    expect(JSON.parse(posted!)).toEqual({ type: "assign", droplet_id: 999 });
  });

  it("explains a cross-region drop instead of letting DO 422", async () => {
    installFetch((path) => {
      if (path === "/reserved_ips?per_page=200") return { reserved_ips: [idleIp] };
      if (path === "/droplets/999")
        return { droplet: { id: 999, name: "syd-01", region: { slug: "syd1" } } };
      return undefined;
    });
    await expect(
      newClient().attachResource(
        "reserved-ip",
        `${ACC}:reserved-ip:45.55.96.48`,
        "droplet",
        `${ACC}:droplet:999`,
        ACC,
      ),
    ).rejects.toThrow(/nyc3 does not match droplet region syd1/);
  });
});

describe("reserved-ip create", () => {
  it("offers a Droplet picker and a region picker behind a mode toggle", async () => {
    installFetch((path) => {
      if (path === "/regions")
        return { regions: [{ slug: "nyc3", name: "New York 3", available: true }] };
      if (path === "/droplets?per_page=200")
        return { droplets: [{ id: 1, name: "web-01", region: { slug: "nyc3" } }] };
      if (path === "/projects") return { projects: [] };
      return undefined;
    });
    const config = await newClient().getCreateConfig("reserved-ip");
    const keys = config.fields.map((f) => f.key);
    expect(keys).toEqual(["assignmentMode", "dropletId", "region"]);
    expect(config.fields[1]!.options).toEqual([{ id: "1", label: "web-01 (nyc3)" }]);
    expect(config.fields[2]!.kind).toBe("region-picker");
  });

  it("posts droplet_id when assigning on creation", async () => {
    let posted: string | undefined;
    installFetch((path, method, body) => {
      if (path === "/reserved_ips" && method === "POST") {
        posted = body;
        return { reserved_ip: assignedIp };
      }
      return undefined;
    });
    const result = await newClient().createResource("reserved-ip", ACC, {
      assignmentMode: "droplet",
      dropletId: "758604968",
    });
    expect(JSON.parse(posted!)).toEqual({ droplet_id: 758604968 });
    expect(result.resource.fields["dropletId"]).toBe("758604968");
    expect(result.resource.externalId).toBe("45.55.96.47");
  });

  it("posts region (+ project) when reserving unassigned", async () => {
    let posted: string | undefined;
    installFetch((path, method, body) => {
      if (path === "/reserved_ips" && method === "POST") {
        posted = body;
        return { reserved_ip: idleIp };
      }
      return undefined;
    });
    await newClient().createResource(
      "reserved-ip",
      ACC,
      { assignmentMode: "region", region: "nyc3" },
      `${ACC}:project:proj-1`,
    );
    expect(JSON.parse(posted!)).toEqual({ region: "nyc3", project_id: "proj-1" });
  });

  it("refuses a droplet-mode create with no Droplet", async () => {
    installFetch(() => undefined);
    await expect(
      newClient().createResource("reserved-ip", ACC, { assignmentMode: "droplet", dropletId: "" }),
    ).rejects.toThrow(/pick a Droplet/i);
  });
});
