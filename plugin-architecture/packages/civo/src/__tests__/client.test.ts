import type { HostServices } from "@infrawrench/plugin-base";
import { evaluateOrphanRule, exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { describe, expect, it, vi } from "vitest";
import { executeCommand } from "../actions.js";
import { CivoApiError, createCivoApi, regional, statusOf } from "../api.js";
import { CivoClient, connectionString } from "../client.js";
import { recordBody } from "../create.js";
import { mapInstance, mapVolume, mapVolumeSnapshot, openToWorld } from "../listers.js";
import { plugin } from "../plugin.js";
import { quotasFrom } from "../quotas.js";
import { parseStatusFeed, regionsIn } from "../status-feed.js";
import { applyUpdate } from "../update.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function host(responder: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const services: HostServices = {
    http: {
      request: vi.fn(async (req) => {
        const call: Call = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          ...(typeof req.body === "string" ? { body: req.body } : {}),
        };
        calls.push(call);
        const res = responder(call);
        return {
          status: res.status ?? 200,
          headers: {},
          body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        };
      }),
    },
  };
  return { services, calls };
}

const type = (id: string) => plugin.resourceTypes.find((t) => t.id === id)!;

describe("api", () => {
  it("sends the lowercase bearer key and walks paginated lists", async () => {
    const { services, calls } = host((c) => {
      const page = new URL(c.url).searchParams.get("page");
      return { body: { page: Number(page), pages: 2, items: [{ id: `i${page}` }] } };
    });
    const api = createCivoApi({ apiKey: "K", services });
    const items = await api.list<{ id: string }>("/instances", { region: "LON1" });
    expect(items.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("bearer K");
    expect(calls[0]!.url).toContain("region=LON1");
  });

  it("accepts bare-array lists", async () => {
    const { services } = host(() => ({ body: [{ id: "v1" }] }));
    expect(await createCivoApi({ apiKey: "K", services }).list("/volumes")).toEqual([{ id: "v1" }]);
  });

  it("puts the region in both the query and the body of writes", async () => {
    const { services, calls } = host(() => ({ body: {} }));
    await createCivoApi({ apiKey: "K", services }).send("PUT", "/instances/x/stop", "FRA1");
    expect(calls[0]!.url).toContain("?region=FRA1");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ region: "FRA1" });
  });

  it("keeps the status and Civo's reason on errors", async () => {
    const { services } = host(() => ({
      status: 403,
      body: { code: "authentication_access_denied", reason: "Access denied" },
    }));
    const err = await createCivoApi({ apiKey: "K", services })
      .get("/quota")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CivoApiError);
    expect(statusOf(err)).toBe(403);
    expect((err as Error).message).toContain("Access denied");
  });
});

describe("mappers", () => {
  it("maps instances with region-qualified ids and flags shut-off ones", () => {
    const r = mapInstance(
      {
        id: "u1",
        hostname: "web",
        status: "SHUTOFF",
        size: "g3.small",
        public_ip: "1.2.3.4",
        private_ip: "192.168.1.2",
        firewall_id: "",
      },
      "LON1",
      "acct",
    );
    expect(r.id).toBe("acct:instance:LON1/u1");
    expect(r.fields["region"]).toBe("lon1");
    expect(r.resolvedOutputs["instanceRef"]).toBe("LON1/u1");
    expect(evaluateOrphanRule(type("instance").orphanRule, r.fields)).toMatch(/shut off/);
    expect(regional(r.id)).toEqual({ region: "LON1", id: "u1" });
  });

  it("flags detached volumes and attributes snapshots to their volume", () => {
    const v = mapVolume(
      { id: "v1", name: "data", instance_id: "", cluster_id: "" },
      "LON1",
      "acct",
    );
    expect(evaluateOrphanRule(type("volume").orphanRule, v.fields)).not.toBeNull();
    const snap = mapVolumeSnapshot({ snapshot_id: "s1", volume_id: "v1" }, "LON1", "acct");
    expect(snap.fields["sourceRef"]).toBe(v.externalId);
  });

  it("reports ports open to the world other than web ports", () => {
    expect(
      openToWorld([
        {
          protocol: "tcp",
          start_port: "22",
          end_port: "22",
          cidr: ["0.0.0.0/0"],
          direction: "ingress",
          action: "allow",
        },
        {
          protocol: "tcp",
          start_port: "443",
          end_port: "443",
          cidr: ["0.0.0.0/0"],
          direction: "ingress",
          action: "allow",
        },
        {
          protocol: "tcp",
          start_port: "1",
          end_port: "65535",
          cidr: ["0.0.0.0/0"],
          direction: "egress",
          action: "allow",
        },
        {
          protocol: "tcp",
          start_port: "5432",
          end_port: "5432",
          cidr: ["10.0.0.0/8"],
          direction: "ingress",
          action: "allow",
        },
      ]),
    ).toBe("tcp/22");
  });
});

describe("client", () => {
  it("uploads the SSH key and creates the instance from the picked image", async () => {
    const { services, calls } = host((c) => {
      if (c.url.includes("/sshkeys") && c.method === "GET") return { body: [] };
      if (c.url.includes("/sshkeys")) return { body: { id: "key-1", result: "success" } };
      if (c.url.includes("/instances") && c.method === "POST")
        return { body: { id: "i1", hostname: "web", status: "BUILDING" } };
      return { body: [] };
    });
    const client = new CivoClient({ apiKey: "K" }, plugin.resourceTypes, services);
    const created = await client.createResource("instance", "acct", {
      hostname: "web",
      region: "LON1",
      size: "g3.small",
      diskImage: "img-1",
      sshPublicKey: "ssh-ed25519 AAAA me@host",
      tags: "a, b",
    });
    expect(created.id).toBe("acct:instance:LON1/i1");
    const body = JSON.parse(
      calls.find((c) => c.method === "POST" && c.url.includes("/instances"))!.body!,
    );
    expect(body).toMatchObject({
      template_id: "img-1",
      ssh_key_id: "key-1",
      region: "LON1",
      tags: "a b",
      public_ip: "create",
    });
  });

  it("merges a DNS record edit onto the current record", async () => {
    const { services, calls } = host((c) =>
      c.method === "GET"
        ? {
            body: [
              {
                id: "r1",
                type: "MX",
                name: "@",
                value: "mail.example.com",
                ttl: 600,
                priority: 10,
              },
            ],
          }
        : { body: {} },
    );
    const api = createCivoApi({ apiKey: "K", services });
    await applyUpdate(api, "dns-record", "acct:dns-record:d1/r1", { priority: "20" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toContain("/dns/d1/records/r1");
    expect(JSON.parse(put.body!)).toEqual({
      type: "MX",
      name: "@",
      value: "mail.example.com",
      ttl: 600,
      priority: 20,
    });
  });

  it("recycles a cluster node by hostname", async () => {
    const { services, calls } = host(() => ({ body: {} }));
    const api = createCivoApi({ apiKey: "K", services });
    await executeCommand(
      api,
      "kubernetes-cluster",
      "a:kubernetes-cluster:LON1/c1",
      "recycle-node",
      [JSON.stringify({ hostname: "node-1" })],
    );
    expect(calls[0]!.url).toContain("/kubernetes/clusters/c1/recycle?region=LON1");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ hostname: "node-1", region: "LON1" });
  });
});

describe("helpers", () => {
  it("builds connection strings and DNS bodies", () => {
    expect(
      connectionString({
        id: "d",
        software: "PostgreSQL",
        username: "root",
        password: "p w",
        dns_entry: "db.civo",
        port: 5432,
      }),
    ).toBe("postgresql://root:p%20w@db.civo:5432/postgres?sslmode=require");
    expect(recordBody({ type: "a", name: "", value: "1.2.3.4" })).toEqual({
      type: "A",
      name: "@",
      value: "1.2.3.4",
      ttl: 600,
      priority: 0,
    });
  });

  it("reads quota pairs and skips missing limits", () => {
    const q = quotasFrom({
      instance_count_usage: 3,
      instance_count_limit: 16,
      cpu_core_usage: 4,
      cpu_core_limit: 0,
    });
    expect(q).toEqual([expect.objectContaining({ id: "instance_count", used: 3, limit: 16 })]);
  });
});

describe("status feed", () => {
  const rss = (title: string, date: string) =>
    `<rss version="2.0"><channel><item><title>${title}</title><link>https://status.civo.com/issues/x/</link><pubDate>${date}</pubDate><guid>${title}</guid><description>details</description></item></channel></rss>`;
  it("keeps active issues with their region and drops resolved ones", () => {
    const now = Date.parse("2026-07-29T00:00:00Z");
    const active = parseStatusFeed(
      rss("Degraded storage performance in LON1", "Tue, 28 Jul 2026 10:55:00 +0000"),
      now,
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ regions: ["lon1"], services: ["Storage"] });
    expect(
      parseStatusFeed(
        rss("[Resolved] Degraded storage in LON1", "Tue, 28 Jul 2026 10:55:00 +0000"),
        now,
      ),
    ).toEqual([]);
    expect(regionsIn("Network issue in FRA1 and NYC1")).toEqual(["fra1", "nyc1"]);
  });
});

describe("terraform", () => {
  it("exports instances with the uuid as the import id", () => {
    const inst = mapInstance({ id: "u1", hostname: "web", size: "g3.small" }, "LON1", "a");
    const out = exportResourcesToTerraform([inst], () => plugin.terraformExport);
    expect(out.hcl).toContain('resource "civo_instance"');
    expect(out.hcl).toContain("u1");
  });
});
