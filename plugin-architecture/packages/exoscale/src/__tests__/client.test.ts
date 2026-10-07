import type { HostServices } from "@infrawrench/plugin-base";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { describe, expect, it, vi } from "vitest";
import { authorization, createExoscaleApi, statusOf } from "../api.js";
import { ExoscaleClient } from "../client.js";
import { focusRows, monthsBetween, parseFocusBody } from "../cost-data.js";
import { recordBody } from "../create.js";
import { mapInstance, mapRecord, mapSecurityGroup, openToWorld } from "../listers.js";
import { plugin } from "../plugin.js";
import { quotasFrom } from "../quotas.js";
import { parseStatusFeed, zonesIn } from "../status-feed.js";

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

describe("signing", () => {
  it("matches EXO2-HMAC-SHA256 vectors computed with node crypto", async () => {
    const url = "https://api-ch-gva-2.exoscale.com/v2/instance?zone=ch-gva-2&b=1&b=2&a=x";
    const body = '{"name":"web"}';
    const header = await authorization("EXOkey", "secret", "POST", url, body, 1_700_000_000);
    // Only single-valued params are signed, sorted by name; values concatenated.
    // HMAC-SHA256("secret", "POST /v2/instance\n{body}\nxch-gva-2\n\n1700000000"), from node:crypto.
    const expected = "f26V+GhlDn1DTBgT8octqEJVw37DxiKXlrq32x+ASBU=";
    expect(header).toBe(
      `EXO2-HMAC-SHA256 credential=EXOkey,signed-query-args=a;zone,expires=1700000000,signature=${expected}`,
    );
  });

  it("omits signed-query-args without a query", async () => {
    const header = await authorization(
      "EXOkey",
      "s",
      "GET",
      "https://api-de-fra-1.exoscale.com/v2/zone",
      "",
      5,
    );
    const expected = "f74QqNALtwElIaUwaqzpW8cgbfZTvVgqAIvPLgxP1Gk=";
    expect(header).toBe(`EXO2-HMAC-SHA256 credential=EXOkey,expires=5,signature=${expected}`);
  });
});

describe("api", () => {
  it("waits for an operation and fails with a status", async () => {
    let polls = 0;
    const { services, calls } = host((c) => {
      if (c.method === "POST") return { body: { id: "op1", state: "pending" } };
      polls++;
      return {
        body:
          polls < 2
            ? { id: "op1", state: "pending" }
            : { id: "op1", state: "success", reference: { id: "new" } },
      };
    });
    const api = createExoscaleApi({ apiKey: "k", apiSecret: "s", services, pollMs: 0 });
    const op = await api.mutate("de-fra-1", "POST", "/instance", {});
    expect(op.reference?.id).toBe("new");
    expect(calls[0]!.url).toBe("https://api-de-fra-1.exoscale.com/v2/instance");
    expect(calls[1]!.url).toContain("/operation/op1");

    const failing = createExoscaleApi({
      apiKey: "k",
      apiSecret: "s",
      services: host(() => ({
        body: { id: "o", state: "failure", reason: "forbidden", message: "nope" },
      })).services,
      pollMs: 0,
    });
    await expect(failing.mutate("ch-gva-2", "DELETE", "/instance/x")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("keeps the HTTP status on errors", async () => {
    const api = createExoscaleApi({
      apiKey: "k",
      apiSecret: "s",
      services: host(() => ({ status: 404, body: { message: "gone" } })).services,
    });
    const err = await api.get("ch-gva-2", "/instance/x").catch((e: unknown) => e);
    expect(statusOf(err)).toBe(404);
  });
});

describe("mappers", () => {
  it("maps an instance with its zone and type", () => {
    const r = mapInstance(
      {
        id: "i1",
        name: "web",
        state: "running",
        "instance-type": {
          id: "t1",
          family: "standard",
          size: "medium",
          cpus: 2,
          memory: 4294967296,
        },
        "disk-size": 50,
        "public-ip": "1.2.3.4",
        template: { name: "Ubuntu 24.04 LTS", "default-user": "ubuntu" },
        "security-groups": [{ id: "sg1" }],
        labels: { env: "prod" },
      },
      "ch-gva-2",
      "acct",
    );
    expect(r.id).toBe("acct:instance:ch-gva-2/i1");
    expect(r.fields).toMatchObject({
      region: "ch-gva-2",
      instanceType: "standard.medium",
      memoryMb: 4096,
      defaultUser: "ubuntu",
      labels: "env=prod",
    });
    expect(r.resolvedOutputs["ipv4"]).toBe("1.2.3.4");
  });

  it("flags ports open to the world except HTTP(S)", () => {
    const rules = [
      {
        "flow-direction": "ingress",
        protocol: "tcp",
        network: "0.0.0.0/0",
        "start-port": 22,
        "end-port": 22,
      },
      {
        "flow-direction": "ingress",
        protocol: "tcp",
        network: "0.0.0.0/0",
        "start-port": 443,
        "end-port": 443,
      },
      {
        "flow-direction": "ingress",
        protocol: "tcp",
        network: "10.0.0.0/8",
        "start-port": 5432,
        "end-port": 5432,
      },
      { "flow-direction": "egress", protocol: "udp", network: "0.0.0.0/0" },
    ];
    expect(openToWorld(rules)).toBe("tcp/22");
    expect(
      mapSecurityGroup({ id: "sg", name: "default", rules }, "acct").fields["openToWorld"],
    ).toBe("tcp/22");
  });

  it("keys DNS records under their domain", () => {
    const r = mapRecord(
      { id: "r1", name: "", type: "MX", content: "mx.example.net", ttl: 3600, priority: 10 },
      { id: "d1", "unicode-name": "example.net" },
      "acct",
    );
    expect(r.externalId).toBe("d1/r1");
    expect(r.displayName).toBe("@ MX");
    expect(r.parentResourceId).toBe("acct:dns-domain:d1");
  });

  it("builds record bodies", () => {
    expect(recordBody({ type: "MX", name: "@", content: "mx", ttl: "300" })).toEqual({
      type: "MX",
      name: "",
      content: "mx",
      ttl: 300,
      priority: 10,
    });
    expect(recordBody({ type: "A", name: "www", content: "1.2.3.4" }, false)).toEqual({
      name: "www",
      content: "1.2.3.4",
      ttl: 3600,
    });
  });

  it("reads quotas with a positive limit", () => {
    expect(
      quotasFrom([
        { resource: "instance", usage: 3, limit: 20 },
        { resource: "gpu", usage: 0, limit: 0 },
      ]),
    ).toEqual([
      {
        id: "instance",
        service: "Organization",
        name: "instance",
        used: 3,
        limit: 20,
        adjustable: true,
      },
    ]);
  });
});

describe("client", () => {
  it("decodes the base64 SKS kubeconfig", async () => {
    const yaml = "apiVersion: v1\nclusters: []\n";
    const { services, calls } = host((c) => {
      if (c.url.includes("/sks-cluster-kubeconfig/")) return { body: { kubeconfig: btoa(yaml) } };
      return { body: { id: "c1", name: "prod", state: "running", nodepools: [] } };
    });
    const client = new ExoscaleClient(
      { apiKey: "k", apiSecret: "s" },
      plugin.resourceTypes,
      services,
    );
    const out = await client.resolveOutput(
      "sks-cluster",
      "acct:sks-cluster:at-vie-1/c1",
      "kubeconfig",
      "acct",
    );
    expect(out).toBe(yaml);
    const req = calls.find((c) => c.url.includes("kubeconfig"))!;
    expect(req.url).toBe("https://api-at-vie-1.exoscale.com/v2/sks-cluster-kubeconfig/c1");
    expect(JSON.parse(req.body!)).toMatchObject({ groups: ["system:masters"] });
  });
});

describe("costs", () => {
  const range = { fromDate: "2026-09-01", toDate: "2026-09-30" };

  it("parses CSV and JSON Lines FOCUS reports", () => {
    const csv =
      'ChargePeriodStart,ServiceName,RegionId,ResourceId,BilledCost,BillingCurrency,ChargeCategory,Tags\n2026-09-02T00:00:00Z,Compute,ch-gva-2,i1,1.5,CHF,Usage,"{""env"":""prod""}"\n2026-09-02T00:00:00Z,Compute,ch-gva-2,i1,0.5,CHF,Usage,"{""env"":""prod""}"\n';
    const rows = focusRows(parseFocusBody(csv), range);
    expect(rows).toEqual([
      {
        date: "2026-09-02",
        service: "Compute",
        region: "ch-gva-2",
        resourceId: "i1",
        tags: { env: "prod" },
        currency: "CHF",
        amount: 2,
      },
    ]);
    const jsonl =
      '{"ChargePeriodStart":"2026-09-03","ServiceName":"Tax","BilledCost":0.2,"BillingCurrency":"EUR","ChargeCategory":"Tax"}\n{"ChargePeriodStart":"2026-10-01","ServiceName":"Compute","BilledCost":9}';
    expect(focusRows(parseFocusBody(jsonl), range)).toEqual([
      { date: "2026-09-03", service: "Tax", currency: "EUR", amount: 0.2, chargeType: "tax" },
    ]);
  });

  it("refuses Parquet and walks months", () => {
    expect(() => parseFocusBody("PAR1....")).toThrow(/Parquet/);
    expect(monthsBetween("2026-08-15", "2026-10-02")).toEqual(["2026-08", "2026-09", "2026-10"]);
  });
});

describe("status feed", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const item = (title: string, desc: string, extra = "") =>
    `<item><title>${title}</title><description>${desc}</description><pubDate>Mon, 06 Oct 2026 10:00:00 +0000</pubDate><link>https://exoscalestatus.com/incidents/1</link><guid>${title}</guid>${extra}</item>`;

  it("keeps open incidents with zones and products, drops resolved ones", () => {
    const body = `<rss version="2.0"><channel>${item(
      "[DE-FRA-1] SKS API errors",
      "&lt;strong&gt;Partial outage&lt;/strong&gt; - DE-FRA-1 &lt;small&gt;Oct 6, 10:00&lt;/small&gt; &lt;strong&gt;Investigating&lt;/strong&gt; - errors",
    )}${item(
      "[CH-GVA-2] Network",
      "&lt;small&gt;Oct 6, 9:00&lt;/small&gt; &lt;strong&gt;Resolved&lt;/strong&gt; - fixed",
    )}</channel></rss>`;
    const incidents = parseStatusFeed(body, now);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      title: "SKS API errors",
      state: "investigating",
      regions: ["de-fra-1"],
      services: ["SKS"],
    });
    expect(zonesIn("AT-VIE-1 and CH-DK-2")).toEqual(["at-vie-1", "ch-dk-2"]);
    expect(() => parseStatusFeed("<html></html>")).toThrow();
  });
});

describe("terraform", () => {
  it("exports zonal resources with uuid@zone import ids", () => {
    const base = {
      pluginId: "exoscale",
      accountId: "acct",
      secretStates: [],
      resolvedOutputs: {},
      createdAt: "",
      updatedAt: "",
    };
    const { hcl } = exportResourcesToTerraform(
      [
        {
          ...base,
          id: "acct:instance:ch-gva-2/i1",
          resourceTypeId: "instance",
          displayName: "web",
          externalId: "ch-gva-2/i1",
          fields: {
            name: "web",
            instanceType: "standard.medium",
            diskGb: 50,
            template: "Ubuntu",
            labels: "env=prod",
          },
        },
        {
          ...base,
          id: "acct:dns-record:d1/r1",
          resourceTypeId: "dns-record",
          displayName: "www A",
          externalId: "d1/r1",
          fields: { name: "www", type: "A", content: "1.2.3.4", ttl: 300 },
        },
      ],
      () => plugin.terraformExport,
    );
    expect(hcl).toContain('resource "exoscale_compute_instance"');
    expect(hcl).toContain('"standard.medium"');
    expect(hcl).toContain("i1@ch-gva-2");
    expect(hcl).toContain("r1@d1");
    expect(hcl).toContain("var.exoscale_api_secret");
  });
});
