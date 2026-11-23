import { hostClient } from "@infrawrench/plugin-base/effect";
import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HetznerClient } from "../client.js";
import { plugin } from "../plugin.js";
import { mapStorageBox } from "../storage-boxes.js";

const TIB = 1024 ** 4;

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function client() {
  return hostClient(new HetznerClient({ apiToken: "tok" }, plugin.resourceTypes));
}

function type(id: string) {
  const t = plugin.resourceTypes.find((r) => r.id === id);
  if (!t) throw new Error(id);
  return t;
}

afterEach(() => vi.restoreAllMocks());

describe("capacity fields", () => {
  it("stores a server's outbound traffic against its included traffic", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      okJson({
        servers: [
          {
            id: 42,
            name: "web",
            status: "running",
            created: "2026-01-01T00:00:00Z",
            outgoing_traffic: 3 * TIB,
            ingoing_traffic: TIB,
            included_traffic: 20 * TIB,
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const [server] = await client().listResources("server", "acct");
    expect(server!.fields["outgoingTrafficBytes"]).toBe(3 * TIB);
    expect(server!.fields["includedTrafficBytes"]).toBe(20 * TIB);
  });

  it("leaves a server's traffic out when Hetzner has no reading", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      okJson({
        servers: [
          {
            id: 42,
            name: "web",
            status: "initializing",
            outgoing_traffic: null,
            included_traffic: null,
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const [server] = await client().listResources("server", "acct");
    expect(server!.fields["outgoingTrafficBytes"]).toBeUndefined();
    expect(server!.fields["includedTrafficBytes"]).toBeUndefined();
  });

  it("stores a load balancer's targets, services and traffic against its type", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      okJson({
        load_balancers: [
          {
            id: 7,
            name: "lb",
            created: "2026-01-01T00:00:00Z",
            load_balancer_type: {
              name: "lb11",
              max_targets: 25,
              max_services: 5,
              max_connections: 10000,
              max_assigned_certificates: 10,
            },
            targets: [{ type: "server", server: { id: 1 } }],
            services: [{ protocol: "http", listen_port: 80 }],
            outgoing_traffic: TIB,
            included_traffic: 20 * TIB,
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const [lb] = await client().listResources("load-balancer", "acct");
    expect(lb!.fields["maxTargets"]).toBe(25);
    expect(lb!.fields["maxServices"]).toBe(5);
    expect(lb!.fields["outgoingTrafficBytes"]).toBe(TIB);
    expect(lb!.fields["includedTrafficBytes"]).toBe(20 * TIB);
    const values = lb!.fields;
    const keys = capacityDeclarations(type("load-balancer")).map((d) => d.key);
    expect(keys).toEqual(["serviceCount", "outgoingTrafficBytes"]);
    for (const d of capacityDeclarations(type("load-balancer"))) {
      expect(resolveCapacityLimit(d.declaration.limit, values)).not.toBeNull();
    }
  });

  it("stores a storage box's used space against its size", () => {
    const box = mapStorageBox(
      {
        id: 3,
        name: "box",
        stats: {
          size: 250 * 1000 ** 3,
          size_data: 200 * 1000 ** 3,
          size_snapshots: 50 * 1000 ** 3,
        },
        storage_box_type: { name: "bx11", size: 1000 * 1000 ** 3 },
      } as Parameters<typeof mapStorageBox>[0],
      "acct",
    );
    const [decl] = capacityDeclarations(type("storage-box"));
    expect(decl!.valueKey).toBe("usedGb");
    const used = Number(box.fields["usedGb"]);
    const limit = resolveCapacityLimit(decl!.declaration.limit, box.fields)!.limit;
    expect(used / limit).toBeCloseTo(0.25);
  });

  it("declares the server's traffic as a monthly allowance", () => {
    const [decl] = capacityDeclarations(type("server"));
    expect(decl!.key).toBe("outgoingTrafficBytes");
    expect(decl!.declaration.cycle?.period).toBe("monthly");
  });
});
